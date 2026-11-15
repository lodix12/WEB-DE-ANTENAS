#!/usr/bin/env python3
"""
Crawler oficial de estaciones de telefonía móvil en España (MINETUR Infoantenas).

Itera coordenadas geográficas de noroeste (NW) a sureste (SE) cubriendo Península,
Islas Baleares, Ceuta, Melilla e Islas Canarias contra el endpoint GeoJSON oficial:
  https://geoportal.minetur.gob.es/VCTEL/infoantenasGeoJSON.do

Características clave:
- Decodificación estricta ISO-8859-1 -> UTF-8 preservando eñes y tildes españolas.
- Subdivisión adaptativa en quadtree (4 cuadrantes con solape de 0.0001°) cuando
  una celda alcanza el límite del servidor de 1.000 estaciones.
- Espera estricta >= 1.0 s entre peticiones HTTP consecutivas y reintentos con
  backoff exponencial (2s, 4s, 8s).
- Deduplicación global por identificador oficial y salida JSON compacta compatible
  al 100% con `AntenasDataset` (`src/types/antena.ts`).
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
from html.parser import HTMLParser
import http.client
import json
import logging
import math
import os
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT_URL = "https://geoportal.minetur.gob.es/VCTEL/infoantenasGeoJSON.do"
DETAIL_ENDPOINT_URL = "https://geoportal.minetur.gob.es/VCTEL/detalleEstacion.do"
PORTAL_SOURCE_URL = "https://geoportal.minetur.gob.es/VCTEL/vcne.do"
SERVER_FEATURE_CAP = 1000
DEFAULT_ZOOM = 7
DEFAULT_DELAY_SECONDS = 1.0
DEFAULT_BAND_CHECKPOINT_EVERY = 50
QUADRANT_OVERLAP_DEG = 0.0001
MIN_QUADRANT_SPAN_DEG = 0.004
MAX_SUBDIVISION_DEPTH = 9
FREQ_RANGE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$")

BBox = tuple[float, float, float, float]  # (min_lon, min_lat, max_lon, max_lat)

OPERATOR_ORDER: tuple[str, ...] = (
    "movistar",
    "orange",
    "vodafone",
    "masmovil",
    "digi",
    "otros",
)

OPERATOR_NAMES: dict[str, str] = {
    "movistar": "Movistar (Telefónica)",
    "orange": "Orange (MasOrange)",
    "vodafone": "Vodafone España",
    "masmovil": "Yoigo / Grupo MásMóvil",
    "digi": "DIGI Spain",
    "otros": "Otros Operadores",
}

# Mapa oficial completo de las 52 provincias / ciudades autónomas INE (01..52)
INE_PROVINCES: dict[str, str] = {
    "01": "ÁLAVA",
    "02": "ALBACETE",
    "03": "ALICANTE",
    "04": "ALMERÍA",
    "05": "ÁVILA",
    "06": "BADAJOZ",
    "07": "ILLES BALEARS",
    "08": "BARCELONA",
    "09": "BURGOS",
    "10": "CÁCERES",
    "11": "CÁDIZ",
    "12": "CASTELLÓN",
    "13": "CIUDAD REAL",
    "14": "CÓRDOBA",
    "15": "A CORUÑA",
    "16": "CUENCA",
    "17": "GIRONA",
    "18": "GRANADA",
    "19": "GUADALAJARA",
    "20": "GIPUZKOA",
    "21": "HUELVA",
    "22": "HUESCA",
    "23": "JAÉN",
    "24": "LEÓN",
    "25": "LLEIDA",
    "26": "LA RIOJA",
    "27": "LUGO",
    "28": "MADRID",
    "29": "MÁLAGA",
    "30": "MURCIA",
    "31": "NAVARRA",
    "32": "OURENSE",
    "33": "ASTURIAS",
    "34": "PALENCIA",
    "35": "LAS PALMAS",
    "36": "PONTEVEDRA",
    "37": "SALAMANCA",
    "38": "SANTA CRUZ DE TENERIFE",
    "39": "CANTABRIA",
    "40": "SEGOVIA",
    "41": "SEVILLA",
    "42": "SORIA",
    "43": "TARRAGONA",
    "44": "TERUEL",
    "45": "TOLEDO",
    "46": "VALENCIA",
    "47": "VALLADOLID",
    "48": "BIZKAIA",
    "49": "ZAMORA",
    "50": "ZARAGOZA",
    "51": "CEUTA",
    "52": "MELILLA",
}


def _strip_accents(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


def _build_province_lookup() -> dict[str, str]:
    lookup: dict[str, str] = {}
    for canonical in INE_PROVINCES.values():
        lookup[canonical] = canonical
        lookup[_strip_accents(canonical)] = canonical

    aliases: dict[str, str] = {
        "ARABA/ÁLAVA": "ÁLAVA",
        "ARABA/ALAVA": "ÁLAVA",
        "ARABA": "ÁLAVA",
        "ÁLAVA/ARABA": "ÁLAVA",
        "ALICANTE/ALACANT": "ALICANTE",
        "ALACANT": "ALICANTE",
        "ALACANT/ALICANTE": "ALICANTE",
        "ISLAS BALEARES": "ILLES BALEARS",
        "BALEARES": "ILLES BALEARS",
        "BALEARS": "ILLES BALEARS",
        "BALEARS (ILLES)": "ILLES BALEARS",
        "BALEARES (ISLAS)": "ILLES BALEARS",
        "CASTELLÓN/CASTELLÓ": "CASTELLÓN",
        "CASTELLON/CASTELLO": "CASTELLÓN",
        "CASTELLÓ": "CASTELLÓN",
        "CASTELLO": "CASTELLÓN",
        "CASTELLÓ/CASTELLÓN": "CASTELLÓN",
        "CASTELLÓN DE LA PLANA": "CASTELLÓN",
        "CORUÑA (A)": "A CORUÑA",
        "LA CORUÑA": "A CORUÑA",
        "CORUÑA (LA)": "A CORUÑA",
        "CORUÑA": "A CORUÑA",
        "GERONA": "GIRONA",
        "GUIPÚZCOA": "GIPUZKOA",
        "GUIPUZCOA": "GIPUZKOA",
        "GIPUZKOA/GUIPÚZCOA": "GIPUZKOA",
        "GUIPÚZCOA/GIPUZKOA": "GIPUZKOA",
        "LÉRIDA": "LLEIDA",
        "LERIDA": "LLEIDA",
        "RIOJA (LA)": "LA RIOJA",
        "RIOJA": "LA RIOJA",
        "REGIÓN DE MURCIA": "MURCIA",
        "REGION DE MURCIA": "MURCIA",
        "NAFARROA": "NAVARRA",
        "NAVARRA/NAFARROA": "NAVARRA",
        "COMUNIDAD FORAL DE NAVARRA": "NAVARRA",
        "ORENSE": "OURENSE",
        "PRINCIPADO DE ASTURIAS": "ASTURIAS",
        "OVIEDO": "ASTURIAS",
        "PALMAS (LAS)": "LAS PALMAS",
        "GRAN CANARIA": "LAS PALMAS",
        "STA. CRUZ DE TENERIFE": "SANTA CRUZ DE TENERIFE",
        "STA CRUZ DE TENERIFE": "SANTA CRUZ DE TENERIFE",
        "S.C. DE TENERIFE": "SANTA CRUZ DE TENERIFE",
        "S. C. DE TENERIFE": "SANTA CRUZ DE TENERIFE",
        "TENERIFE": "SANTA CRUZ DE TENERIFE",
        "SANTANDER": "CANTABRIA",
        "VALENCIA/VALÈNCIA": "VALENCIA",
        "VALÈNCIA": "VALENCIA",
        "VALÈNCIA/VALENCIA": "VALENCIA",
        "VIZCAYA": "BIZKAIA",
        "BIZKAIA/VIZCAYA": "BIZKAIA",
        "VIZCAYA/BIZKAIA": "BIZKAIA",
    }
    for alias, canonical in aliases.items():
        upper_alias = alias.upper()
        lookup[upper_alias] = canonical
        lookup[_strip_accents(upper_alias)] = canonical
    return lookup


PROVINCE_LOOKUP: dict[str, str] = _build_province_lookup()


def decode_infoantenas_payload(raw_bytes: bytes) -> list[dict[str, Any]]:
    """
    Decodifica la respuesta en ISO-8859-1 del endpoint Infoantenas y devuelve la
    lista de features GeoJSON. Soporta respuestas vacías (`b'{}'` o `b''`) y gzip.
    """
    if not raw_bytes:
        return []
    if raw_bytes[:2] == b"\x1f\x8b":
        raw_bytes = gzip.decompress(raw_bytes)
    text = raw_bytes.decode("iso-8859-1").strip()
    if not text:
        return []
    payload = json.loads(text)
    if not isinstance(payload, dict):
        return []
    features = payload.get("features")
    if not isinstance(features, list):
        return []
    return features


def classify_operator(op_raw: str) -> str:
    """Clasifica la razón social de Infoantenas en un `OperatorKey` normalizado."""
    upper_ascii = _strip_accents((op_raw or "").upper())
    if "TELEFONICA" in upper_ascii or "MOVISTAR" in upper_ascii:
        return "movistar"
    if "ORANGE" in upper_ascii:
        return "orange"
    if "VODAFONE" in upper_ascii:
        return "vodafone"
    if any(
        token in upper_ascii
        for token in (
            "XFERA",
            "MASMOVIL",
            "YOIGO",
            "EUSKALTEL",
            "R CABLE",
            "TELECABLE",
        )
    ):
        return "masmovil"
    if "DS MOBILE" in upper_ascii or re.search(r"\bDIGI\b", upper_ascii):
        return "digi"
    return "otros"


def normalize_province(
    prov_raw: str,
    gid: str = "",
    lat: float | None = None,
    lon: float | None = None,
) -> str:
    """
    Normaliza el nombre de provincia o recurre al código INE (`01`..`52`) de `gid[:2]`
    (y coordenadas insulares/africanas para GIDs alfanuméricos) si está vacío.
    """
    cleaned = " ".join((prov_raw or "").strip().split()).upper()
    if cleaned:
        if cleaned in PROVINCE_LOOKUP:
            return PROVINCE_LOOKUP[cleaned]
        ascii_key = _strip_accents(cleaned)
        if ascii_key in PROVINCE_LOOKUP:
            return PROVINCE_LOOKUP[ascii_key]

    gid_clean = (gid or "").strip().upper()
    if len(gid_clean) >= 2 and gid_clean[:2].isdigit():
        ine_code = gid_clean[:2]
        if ine_code in INE_PROVINCES:
            return INE_PROVINCES[ine_code]

    # Fallback para GIDs alfanuméricos regionales cuando `prov_raw` no está presente
    if not cleaned:
        if gid_clean.startswith("CYM") or (
            lat is not None and lon is not None and 35.0 <= lat <= 36.05 and -5.6 <= lon <= -2.3
        ):
            if lon is not None and lon < -4.0:
                return "CEUTA"
            return "MELILLA"
        if gid_clean.startswith("CAN") or (
            lat is not None and lon is not None and lat < 30.0 and lon < -13.0
        ):
            if lon is not None and lon < -16.0:
                return "SANTA CRUZ DE TENERIFE"
            return "LAS PALMAS"

    return cleaned if cleaned else "SIN PROVINCIA"


def _looks_like_valid_province_token(candidate: str, has_dot_separator: bool) -> bool:
    token = candidate.strip().upper()
    if not token:
        return False
    if token in PROVINCE_LOOKUP or _strip_accents(token) in PROVINCE_LOOKUP:
        return True
    if any(ch.isdigit() for ch in token):
        return False
    if token in {"S/N", "SN", "BAJO", "IZQ", "DER"}:
        return False
    return has_dot_separator or len(token) >= 4


def parse_direccion(
    raw_dir: str,
    gid: str = "",
    lat: float | None = None,
    lon: float | None = None,
) -> tuple[str, str, str]:
    """
    Extrae `(dir, mun, prov)` desde el campo `Dirección` de Infoantenas con formato:
      `"<STREET>. <MUNICIPIO>, <PROVINCIA>"`

    Divide por el ÚLTIMO `", "` para extraer `prov` y, en el prefijo restante,
    por el ÚLTIMO `". "` para separar `dir` y `mun` (soportando puntos/comas en vías
    como `"MPG 20.304, S/N. MADRID, MADRID"`).
    """
    text = " ".join((raw_dir or "").strip().split())
    if not text:
        return "", "", normalize_province("", gid=gid, lat=lat, lon=lon)

    prov_raw = ""
    prefix = text

    if ", " in text:
        cand_prefix, cand_prov = text.rsplit(", ", 1)
        has_dot = ". " in cand_prefix or "." in cand_prefix
        if _looks_like_valid_province_token(cand_prov, has_dot):
            prefix = cand_prefix.strip()
            prov_raw = cand_prov.strip()

    if prov_raw:
        if ". " in prefix:
            street, mun = prefix.rsplit(". ", 1)
        elif "." in prefix:
            street, mun = prefix.rsplit(".", 1)
        else:
            street, mun = prefix, ""
    else:
        street, mun = text, ""

    prov = normalize_province(prov_raw, gid=gid, lat=lat, lon=lon)
    return street.strip(), mun.strip(), prov


def _parse_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        fval = float(value)
    else:
        sval = str(value).strip().replace(",", ".")
        if not sval:
            return None
        try:
            fval = float(sval)
        except ValueError:
            return None
    if not math.isfinite(fval):
        return None
    return fval


def parse_feature(feature: dict[str, Any]) -> dict[str, Any] | None:
    """Convierte un Feature GeoJSON de Infoantenas en un `AntennaRecord`."""
    if not isinstance(feature, dict):
        return None
    props = feature.get("properties")
    if not isinstance(props, dict):
        props = {}
    geom = feature.get("geometry")
    coords = geom.get("coordinates") if isinstance(geom, dict) else None

    lat_val = _parse_float(props.get("Gis_Latitud"))
    lon_val = _parse_float(props.get("Gis_Longitud"))
    if (lat_val is None or lon_val is None) and isinstance(coords, (list, tuple)) and len(coords) >= 2:
        if lon_val is None:
            lon_val = _parse_float(coords[0])
        if lat_val is None:
            lat_val = _parse_float(coords[1])

    if lat_val is None or lon_val is None:
        return None
    if not (-90.0 <= lat_val <= 90.0 and -180.0 <= lon_val <= 180.0):
        return None
    if abs(lat_val) < 1e-6 and abs(lon_val) < 1e-6:
        return None

    lat = round(lat_val, 6)
    lon = round(lon_val, 6)

    gid = str(props.get("Gis_ID") or "").strip()
    code_str = str(
        props.get("Gis_Codigo")
        or props.get("Código")
        or feature.get("id")
        or ""
    ).strip()

    if " - " in code_str:
        op_part, id_suffix = code_str.rsplit(" - ", 1)
        op_raw = op_part.strip() or "DESCONOCIDO"
        if not gid:
            gid = id_suffix.strip()
    else:
        op_raw = code_str or "DESCONOCIDO"

    raw_id = str(feature.get("id") or code_str or "").strip()
    if not raw_id:
        if op_raw and gid:
            raw_id = f"{op_raw} - {gid}"
        else:
            raw_id = f"{gid or 'UNK'}:{lat:.6f}:{lon:.6f}"

    op_key = classify_operator(op_raw)
    raw_dir = str(props.get("Dirección") or "")
    street, mun, prov = parse_direccion(raw_dir, gid=gid, lat=lat, lon=lon)

    return {
        "id": raw_id,
        "gid": gid,
        "op": op_key,
        "opRaw": op_raw,
        "lat": lat,
        "lon": lon,
        "dir": street,
        "mun": mun,
        "prov": prov,
    }


def is_outside_spain_conservative(bbox: BBox) -> bool:
    """
    Descarta ÚNICAMENTE celdas que caen al 100% fuera de soberanía española
    (Atlántico profundo al oeste de Portugal, sur de Francia lejano, Golfo de León
    y Argelia/Mediterráneo suroriental), conservando el 100% de fronteras, costas,
    Galicia, Pirineos, Girona, Baleares, Ceuta, Melilla, Chafarinas, Alborán y Canarias.
    """
    min_lon, min_lat, max_lon, max_lat = bbox

    # Islas Canarias se mantienen íntegras
    if max_lon <= -13.0 and max_lat <= 30.0:
        return False

    # Atlántico e interior oeste de Portugal (sur del Miño < 41.75°N y lon <= -7.65°W)
    if max_lon <= -7.65 and max_lat <= 41.75:
        return True

    # Atlántico profundo suroeste del Golfo de Cádiz (al oeste de -6.60°W y sur de 36.30°N)
    if max_lon <= -6.60 and max_lat <= 36.30:
        return True

    # Interior de Francia oriental al norte de los Pirineos / Andorra (lat >= 42.75°N y lon >= 1.65°E)
    if min_lat >= 42.75 and min_lon >= 1.65:
        return True

    # Golfo de León mar adentro (al este de Cap de Creus 3.32°E y norte de Menorca 40.35°N)
    if min_lon >= 3.45 and min_lat >= 40.35:
        return True

    # Mediterráneo suroriental y Argelia: al este de Cabo de la Nao (0.35°E) y sur de Formentera (38.45°N)
    if min_lon >= 0.35 and max_lat <= 38.45:
        return True

    # Argelia / Orán: al este de Islas Chafarinas (-2.43°W -> margen -1.90°W) y sur de Almería (36.35°N)
    if min_lon >= -1.90 and max_lat <= 36.35:
        return True

    return False


def build_initial_grid(region: str = "all") -> list[BBox]:
    """
    Construye la lista ordenada de celdas iniciales de noroeste (NW) a sureste (SE).
    - `sample`: 2 celdas representativas (Madrid centro y Barcelona centro) para tests rápidos.
    - `all`: Península, Islas Baleares, Ceuta y Melilla + Islas Canarias.
    """
    if region == "sample":
        return [
            (-3.715, 40.405, -3.685, 40.430),  # Madrid centro
            (2.155, 41.375, 2.185, 41.400),    # Barcelona centro
        ]

    if region != "all":
        raise ValueError(f"Región no soportada: {region!r}")

    boxes: list[BBox] = []

    # 1) Península, Islas Baleares, Ceuta, Melilla, Chafarinas y Alborán (NW -> SE)
    pen_lon_min, pen_lon_max, pen_cols = -9.45, 4.45, 10
    pen_lat_min, pen_lat_max, pen_rows = 35.15, 43.88, 8
    dlon = (pen_lon_max - pen_lon_min) / pen_cols
    dlat = (pen_lat_max - pen_lat_min) / pen_rows

    for row in range(pen_rows):
        max_lat = round(pen_lat_max - row * dlat, 6)
        min_lat = round(pen_lat_max - (row + 1) * dlat, 6)
        for col in range(pen_cols):
            min_lon = round(pen_lon_min + col * dlon, 6)
            max_lon = round(pen_lon_min + (col + 1) * dlon, 6)
            candidate: BBox = (min_lon, min_lat, max_lon, max_lat)
            if not is_outside_spain_conservative(candidate):
                boxes.append(candidate)

    # 2) Islas Canarias (NW -> SE): El Hierro/La Palma -> Lanzarote/La Graciosa
    can_lon_min, can_lon_max, can_cols = -18.25, -13.30, 4
    can_lat_min, can_lat_max = 27.60, 29.50
    can_dlon = (can_lon_max - can_lon_min) / can_cols
    for col in range(can_cols):
        min_lon = round(can_lon_min + col * can_dlon, 6)
        max_lon = round(can_lon_min + (col + 1) * can_dlon, 6)
        boxes.append((min_lon, can_lat_min, max_lon, can_lat_max))

    return boxes


def subdivide_bbox(bbox: BBox, overlap: float = QUADRANT_OVERLAP_DEG) -> list[BBox]:
    """
    Subdivide un `bbox` en 4 cuadrantes ordenados NW, NE, SW, SE con un pequeño
    solape (`0.0001°`) para garantizar pérdida cero en estaciones limítrofes.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    mid_lon = (min_lon + max_lon) / 2.0
    mid_lat = (min_lat + max_lat) / 2.0

    nw: BBox = (
        round(min_lon, 6),
        round(max(min_lat, mid_lat - overlap), 6),
        round(min(max_lon, mid_lon + overlap), 6),
        round(max_lat, 6),
    )
    ne: BBox = (
        round(max(min_lon, mid_lon - overlap), 6),
        round(max(min_lat, mid_lat - overlap), 6),
        round(max_lon, 6),
        round(max_lat, 6),
    )
    sw: BBox = (
        round(min_lon, 6),
        round(min_lat, 6),
        round(min(max_lon, mid_lon + overlap), 6),
        round(min(max_lat, mid_lat + overlap), 6),
    )
    se: BBox = (
        round(max(min_lon, mid_lon - overlap), 6),
        round(min_lat, 6),
        round(max_lon, 6),
        round(min(max_lat, mid_lat + overlap), 6),
    )
    return [nw, ne, sw, se]


def format_bbox_key(bbox: BBox) -> str:
    return f"{bbox[0]:.6f},{bbox[1]:.6f},{bbox[2]:.6f},{bbox[3]:.6f}"


def build_bbox_url(bbox: BBox, zoom: int = DEFAULT_ZOOM) -> str:
    bbox_param = f"{bbox[0]:.6f},{bbox[1]:.6f},{bbox[2]:.6f},{bbox[3]:.6f}"
    return f"{ENDPOINT_URL}?idCapa=null&bbox={bbox_param}&zoom={zoom}"


class InfoantenasCrawler:
    """Motor de recolección iterativa y subdivisión adaptativa con soporte de checkpoint."""

    def __init__(
        self,
        delay_seconds: float = DEFAULT_DELAY_SECONDS,
        zoom: int = DEFAULT_ZOOM,
        min_span_deg: float = MIN_QUADRANT_SPAN_DEG,
        checkpoint_path: Path | None = None,
        checkpoint_every: int = 20,
        timeout_seconds: float = 30.0,
        fetch_fn: Callable[[BBox, int], list[dict[str, Any]]] | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self.delay_seconds = max(0.0, float(delay_seconds))
        self.zoom = int(zoom)
        self.min_span_deg = float(min_span_deg)
        self.checkpoint_path = checkpoint_path
        self.checkpoint_every = max(1, int(checkpoint_every))
        self.timeout_seconds = float(timeout_seconds)
        self._custom_fetch_fn = fetch_fn
        self._sleep = sleep_fn
        self._clock = clock_fn

        self.records_by_id: dict[str, dict[str, Any]] = {}
        self.completed_leaf_boxes: set[str] = set()
        self.cached_box_counts: dict[str, int] = {}
        self.requests_count: int = 0
        self.grid_boxes_visited: int = 0
        self.subdivided_boxes: int = 0
        self.prior_elapsed_seconds: float = 0.0
        self._last_request_ts: float | None = None
        self._unsaved_requests: int = 0

    def load_checkpoint(self) -> bool:
        if not self.checkpoint_path or not self.checkpoint_path.exists():
            return False
        try:
            raw = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
            for rec in raw.get("records", []):
                if isinstance(rec, dict) and "id" in rec:
                    self.records_by_id[rec["id"]] = rec
            self.completed_leaf_boxes = set(raw.get("completedLeafBoxes", []))
            self.cached_box_counts = {
                str(k): int(v) for k, v in (raw.get("cachedBoxCounts") or {}).items()
            }
            stats = raw.get("stats") or {}
            self.requests_count = int(stats.get("requestsCount", 0))
            self.grid_boxes_visited = int(stats.get("gridBoxesVisited", 0))
            self.subdivided_boxes = int(stats.get("subdividedBoxes", 0))
            self.prior_elapsed_seconds = float(stats.get("durationSeconds", 0.0))
            logging.info(
                "Checkpoint cargado desde %s: %d estaciones únicas, %d peticiones previas.",
                self.checkpoint_path,
                len(self.records_by_id),
                self.requests_count,
            )
            return True
        except Exception as exc:
            logging.warning("No se pudo cargar el checkpoint %s: %s", self.checkpoint_path, exc)
            return False

    def save_checkpoint(self, current_run_elapsed: float = 0.0) -> None:
        if not self.checkpoint_path:
            return
        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.checkpoint_path.with_suffix(self.checkpoint_path.suffix + ".tmp")
        payload = {
            "savedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "stats": {
                "requestsCount": self.requests_count,
                "gridBoxesVisited": self.grid_boxes_visited,
                "subdividedBoxes": self.subdivided_boxes,
                "durationSeconds": round(self.prior_elapsed_seconds + current_run_elapsed, 2),
            },
            "completedLeafBoxes": sorted(self.completed_leaf_boxes),
            "cachedBoxCounts": self.cached_box_counts,
            "records": list(self.records_by_id.values()),
        }
        tmp_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(tmp_path, self.checkpoint_path)
        self._unsaved_requests = 0

    def _wait_rate_limit(self) -> None:
        if self._last_request_ts is not None and self.delay_seconds > 0:
            elapsed = self._clock() - self._last_request_ts
            remaining = self.delay_seconds - elapsed
            if remaining > 0:
                self._sleep(remaining)

    def _http_fetch_bbox(self, bbox: BBox) -> list[dict[str, Any]]:
        url = build_bbox_url(bbox, zoom=self.zoom)
        backoffs = (2.0, 4.0, 8.0)
        last_err: Exception | None = None

        for attempt in range(len(backoffs)):
            self._wait_rate_limit()
            self.requests_count += 1
            self._unsaved_requests += 1

            if self._custom_fetch_fn is not None:
                try:
                    features = self._custom_fetch_fn(bbox, self.zoom)
                    self._last_request_ts = self._clock()
                    return features
                except Exception as exc:
                    self._last_request_ts = self._clock()
                    last_err = exc
            else:
                req = urllib.request.Request(
                    url,
                    headers={
                        "User-Agent": (
                            "Mozilla/5.0 (X11; Linux x86_64) WebDeAntenasSpainCrawler/1.0"
                        ),
                        "Accept": "application/json, text/plain, */*",
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                        raw_bytes = resp.read()
                    self._last_request_ts = self._clock()
                    return decode_infoantenas_payload(raw_bytes)
                except (
                    urllib.error.HTTPError,
                    urllib.error.URLError,
                    TimeoutError,
                    http.client.HTTPException,
                    OSError,
                    UnicodeDecodeError,
                    json.JSONDecodeError,
                ) as exc:
                    self._last_request_ts = self._clock()
                    last_err = exc

            if attempt < len(backoffs) - 1:
                wait_s = backoffs[attempt]
                logging.warning(
                    "Error en petición bbox=%s (intento %d/3): %s. Reintentando en %.1fs...",
                    format_bbox_key(bbox),
                    attempt + 1,
                    last_err,
                    wait_s,
                )
                self._sleep(wait_s)

        raise RuntimeError(
            f"Fallo tras 3 intentos al consultar bbox={format_bbox_key(bbox)}: {last_err}"
        ) from last_err

    def _ingest_features(self, features: list[dict[str, Any]]) -> int:
        added = 0
        for feat in features:
            rec = parse_feature(feat)
            if rec is None:
                continue
            rec_id = rec["id"]
            if rec_id not in self.records_by_id:
                added += 1
            self.records_by_id[rec_id] = rec
        return added

    def _crawl_bbox_recursive(self, bbox: BBox, depth: int, run_start_ts: float) -> None:
        if is_outside_spain_conservative(bbox):
            return

        key = format_bbox_key(bbox)
        if key in self.completed_leaf_boxes:
            return

        if key in self.cached_box_counts:
            count = self.cached_box_counts[key]
        else:
            self.grid_boxes_visited += 1
            features = self._http_fetch_bbox(bbox)
            count = len(features)
            added = self._ingest_features(features)
            self.cached_box_counts[key] = count

            if self.requests_count % 10 == 0 or count >= SERVER_FEATURE_CAP:
                logging.info(
                    "[req #%d | depth=%d] bbox=%s -> %d recibidas (+%d nuevas, total=%d)",
                    self.requests_count,
                    depth,
                    key,
                    count,
                    added,
                    len(self.records_by_id),
                )

            if self._unsaved_requests >= self.checkpoint_every:
                self.save_checkpoint(self._clock() - run_start_ts)

        lon_span = bbox[2] - bbox[0]
        lat_span = bbox[3] - bbox[1]
        can_subdivide = (
            (lon_span > self.min_span_deg or lat_span > self.min_span_deg)
            and depth < MAX_SUBDIVISION_DEPTH
        )

        if count >= SERVER_FEATURE_CAP and can_subdivide:
            if depth == 0 or key not in self.completed_leaf_boxes:
                self.subdivided_boxes += 1
            for child_bbox in subdivide_bbox(bbox):
                self._crawl_bbox_recursive(child_bbox, depth + 1, run_start_ts)

        self.completed_leaf_boxes.add(key)

    def crawl(self, region: str = "all") -> dict[str, Any]:
        if self.checkpoint_path:
            self.load_checkpoint()

        initial_boxes = build_initial_grid(region=region)
        logging.info(
            "Iniciando crawl región=%r con %d celdas raíz (zoom=%d, delay=%.2fs)...",
            region,
            len(initial_boxes),
            self.zoom,
            self.delay_seconds,
        )

        run_start_ts = self._clock()
        for idx, root_bbox in enumerate(initial_boxes, start=1):
            logging.info(
                "Celda raíz %d/%d: %s (acumulado=%d antenas)",
                idx,
                len(initial_boxes),
                format_bbox_key(root_bbox),
                len(self.records_by_id),
            )
            self._crawl_bbox_recursive(root_bbox, depth=0, run_start_ts=run_start_ts)

        total_duration = round(self.prior_elapsed_seconds + (self._clock() - run_start_ts), 2)
        if self.checkpoint_path:
            self.save_checkpoint(self._clock() - run_start_ts)

        crawl_stats: dict[str, Any] = {
            "requestsCount": self.requests_count,
            "durationSeconds": total_duration,
            "gridBoxesVisited": self.grid_boxes_visited,
            "subdividedBoxes": self.subdivided_boxes,
            "zoomParam": self.zoom,
            "delaySeconds": self.delay_seconds,
            "isPartialSeed": region != "all",
        }
        return build_dataset(self.records_by_id, crawl_stats=crawl_stats)


EARTH_RADIUS_M = 6_371_008.8
DEFAULT_VODAFONE_FUSION_M = 35.0
VODAFONE_DEDUP_DISTANCE_M = DEFAULT_VODAFONE_FUSION_M


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distancia geodésica Haversine en metros entre dos coordenadas WGS84."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlon / 2.0) ** 2
    )
    return 2.0 * EARTH_RADIUS_M * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def _redundant_leading_zeros(gid: str) -> int:
    if len(gid) <= 1:
        return 0
    stripped = gid.lstrip("0")
    if not stripped:
        return len(gid) - 1
    return len(gid) - len(stripped)


def _vodafone_canonical_sort_key(
    rec: dict[str, Any],
) -> tuple[int, int, int, int, int, int, str, str]:
    gid = str(rec.get("gid") or "").strip()
    rec_id = str(rec.get("id") or "").strip()
    has_dir = bool(str(rec.get("dir") or "").strip())
    has_mun = bool(str(rec.get("mun") or "").strip())
    prov_str = str(rec.get("prov") or "").strip()
    has_prov = bool(prov_str and prov_str != "SIN PROVINCIA")
    completeness = int(has_dir) + int(has_mun) + int(has_prov)
    return (
        0 if gid else 1,
        _redundant_leading_zeros(gid),
        -completeness,
        0 if has_dir else 1,
        0 if has_mun else 1,
        0 if has_prov else 1,
        gid,
        rec_id,
    )


def fuse_vodafone_duplicates(
    records: list[dict[str, Any]],
    max_distance_m: float = DEFAULT_VODAFONE_FUSION_M,
) -> tuple[list[dict[str, Any]], int]:
    """
    Fusiona declaraciones duplicadas de Vodafone (`op == "vodafone"`) situadas a
    estrictamente `< max_distance_m` metros (por defecto 35.0 m) usando malla espacial
    (`cell_deg = max(0.0006, (max_distance_m / 111320.0) / 0.65)`) + Union-Find.
    Las estaciones de Telefónica (`op == "movistar"`) y del resto de operadores
    jamás se fusionan entre sí en el dataset.

    Conserva 1 única estación canónica por componente conexa (manteniendo sus
    coordenadas reales WGS84 `lat`, `lon` para garantizar que ningún par de
    representantes distintos quede jamás a `< max_distance_m`), rellena `mergedGids`
    cuando se fusionan `> 1` declaraciones y devuelve `(registros_fusionados, duplicados_eliminados)`.
    """
    if max_distance_m <= 0.0 or len(records) <= 1:
        return [dict(r) for r in records], 0

    voda_records: list[dict[str, Any]] = []
    voda_pos_by_record_idx: dict[int, int] = {}
    for rec_idx, rec in enumerate(records):
        if rec.get("op") == "vodafone":
            voda_pos_by_record_idx[rec_idx] = len(voda_records)
            voda_records.append(rec)

    n_voda = len(voda_records)
    if n_voda <= 1:
        return [dict(r) for r in records], 0

    parent = list(range(n_voda))

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        cur = x
        while cur != root:
            nxt = parent[cur]
            parent[cur] = root
            cur = nxt
        return root

    def union(a: int, b: int) -> None:
        ra = find(a)
        rb = find(b)
        if ra != rb:
            parent[rb] = ra

    cell_deg = max(0.0006, (max_distance_m / 111320.0) / 0.65)
    grid: dict[tuple[int, int], list[int]] = {}

    for k, rec in enumerate(voda_records):
        lat = float(rec["lat"])
        lon = float(rec["lon"])
        cx = math.floor(lat / cell_deg)
        cy = math.floor(lon / cell_deg)

        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                bucket = grid.get((cx + dx, cy + dy))
                if not bucket:
                    continue
                for other_k in bucket:
                    if find(k) == find(other_k):
                        continue
                    other_rec = voda_records[other_k]
                    if (
                        haversine_m(
                            lat,
                            lon,
                            float(other_rec["lat"]),
                            float(other_rec["lon"]),
                        )
                        < max_distance_m
                    ):
                        union(k, other_k)

        grid.setdefault((cx, cy), []).append(k)

    components: dict[int, list[dict[str, Any]]] = {}
    for k, rec in enumerate(voda_records):
        components.setdefault(find(k), []).append(rec)

    merged_by_root: dict[int, dict[str, Any]] = {}
    fused_duplicates = 0

    for root, comp_members in components.items():
        if len(comp_members) == 1:
            single = dict(comp_members[0])
            if isinstance(single.get("mergedGids"), list):
                single["mergedGids"] = list(single["mergedGids"])
            if isinstance(single.get("bandas"), list):
                single["bandas"] = list(single["bandas"])
            if isinstance(single.get("frecuencias"), list):
                single["frecuencias"] = list(single["frecuencias"])
            merged_by_root[root] = single
            continue

        fused_duplicates += len(comp_members) - 1
        sorted_members = sorted(comp_members, key=_vodafone_canonical_sort_key)
        merged_rec = dict(sorted_members[0])

        for member in sorted_members[1:]:
            if not str(merged_rec.get("dir") or "").strip() and str(
                member.get("dir") or ""
            ).strip():
                merged_rec["dir"] = member["dir"]
            if not str(merged_rec.get("mun") or "").strip() and str(
                member.get("mun") or ""
            ).strip():
                merged_rec["mun"] = member["mun"]
            cur_prov = str(merged_rec.get("prov") or "").strip()
            cand_prov = str(member.get("prov") or "").strip()
            if (
                (not cur_prov or cur_prov == "SIN PROVINCIA")
                and cand_prov
                and cand_prov != "SIN PROVINCIA"
            ):
                merged_rec["prov"] = member["prov"]
            elif not cur_prov and cand_prov:
                merged_rec["prov"] = member["prov"]

        seen_gids: set[str] = set()
        merged_gids: list[str] = []
        for member in sorted_members:
            mgid = str(member.get("gid") or "").strip()
            if mgid and mgid not in seen_gids:
                seen_gids.add(mgid)
                merged_gids.append(mgid)
            extra = member.get("mergedGids")
            if isinstance(extra, list):
                for eg in extra:
                    eg_str = str(eg or "").strip()
                    if eg_str and eg_str not in seen_gids:
                        seen_gids.add(eg_str)
                        merged_gids.append(eg_str)

        if merged_gids:
            merged_rec["mergedGids"] = merged_gids

        if all(isinstance(m.get("bandas"), list) for m in sorted_members):
            combined_freqs: list[str] = []
            for member in sorted_members:
                for freq_item in member.get("frecuencias") or []:
                    if isinstance(freq_item, str):
                        combined_freqs.append(freq_item)
            bandas_u, freqs_u = summarize_frequency_ranges(combined_freqs)
            if not bandas_u:
                extra_bands = {
                    str(b).strip()
                    for member in sorted_members
                    for b in (member.get("bandas") or [])
                    if str(b).strip()
                }
                bandas_u = sorted(extra_bands, key=_band_sort_key)
            merged_rec["bandas"] = bandas_u
            merged_rec["frecuencias"] = freqs_u
        else:
            merged_rec.pop("bandas", None)
            merged_rec.pop("frecuencias", None)

        merged_by_root[root] = merged_rec

    emitted_roots: set[int] = set()
    output_records: list[dict[str, Any]] = []
    for rec_idx, rec in enumerate(records):
        voda_k = voda_pos_by_record_idx.get(rec_idx)
        if voda_k is None:
            copied = dict(rec)
            if isinstance(copied.get("bandas"), list):
                copied["bandas"] = list(copied["bandas"])
            if isinstance(copied.get("frecuencias"), list):
                copied["frecuencias"] = list(copied["frecuencias"])
            output_records.append(copied)
            continue
        root = find(voda_k)
        if root not in emitted_roots:
            emitted_roots.add(root)
            output_records.append(merged_by_root[root])

    return output_records, fused_duplicates


def build_detalle_estacion_url(gid: str) -> str:
    """Construye la URL oficial `detalleEstacion.do?emplazamiento=<gid>`."""
    encoded_gid = urllib.parse.quote(str(gid).strip(), safe="")
    return f"{DETAIL_ENDPOINT_URL}?emplazamiento={encoded_gid}"


def decode_detalle_estacion_payload(raw_bytes: bytes) -> str:
    """Decodifica el HTML en ISO-8859-1 devuelto por `detalleEstacion.do`."""
    if not raw_bytes:
        return ""
    if raw_bytes[:2] == b"\x1f\x8b":
        raw_bytes = gzip.decompress(raw_bytes)
    return raw_bytes.decode("iso-8859-1", errors="replace")


def _format_mhz(val: float) -> str:
    rounded_2 = round(val, 2)
    if abs(val - rounded_2) < 1e-6:
        return f"{rounded_2:.2f}"
    return f"{round(val, 4):.4f}".rstrip("0").rstrip(".")


def _band_sort_key(label: str) -> tuple[float, str]:
    text = label.strip()
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(GHz|MHz)$", text, flags=re.IGNORECASE)
    if m:
        value = float(m.group(1))
        unit = m.group(2).upper()
        mhz = value * 1000.0 if unit == "GHZ" else value
        return (mhz, text)
    return (float("inf"), text)


def classify_frequency_band(min_mhz: float, max_mhz: float) -> str:
    """Clasifica un rango de frecuencias (MHz) en su etiqueta comercial española."""
    mid = (float(min_mhz) + float(max_mhz)) / 2.0
    if 700.0 <= mid <= 790.0:
        return "700 MHz"
    if 790.0 < mid <= 870.0:
        return "800 MHz"
    if 875.0 <= mid <= 965.0:
        return "900 MHz"
    if 1420.0 <= mid <= 1520.0:
        return "1500 MHz"
    if 1700.0 <= mid <= 1890.0:
        return "1800 MHz"
    if 1895.0 <= mid <= 2200.0:
        return "2100 MHz"
    if 2490.0 <= mid <= 2700.0:
        return "2600 MHz"
    if 3300.0 <= mid <= 3900.0:
        return "3500 MHz"
    if 24000.0 <= mid <= 28000.0:
        return "26 GHz"
    return f"{round(mid)} MHz"


def summarize_frequency_ranges(
    ranges: list[tuple[float, float]] | list[str],
) -> tuple[list[str], list[str]]:
    """
    Deduplica y ordena numéricamente rangos `(min_mhz, max_mhz)` o cadenas `"min - max"`,
    devolviendo `(bandas_ordenadas, frecuencias_ordenadas)`.
    """
    parsed: dict[str, tuple[float, float]] = {}
    for item in ranges:
        if isinstance(item, str):
            m = FREQ_RANGE_RE.match(item.strip())
            if not m:
                continue
            lo, hi = float(m.group(1)), float(m.group(2))
        else:
            lo, hi = float(item[0]), float(item[1])
        if lo > hi:
            lo, hi = hi, lo
        formatted = f"{_format_mhz(lo)} - {_format_mhz(hi)}"
        if formatted not in parsed:
            parsed[formatted] = (lo, hi)

    sorted_items = sorted(parsed.items(), key=lambda kv: (kv[1][0], kv[1][1], kv[0]))
    frecuencias = [kv[0] for kv in sorted_items]
    band_set = {classify_frequency_band(lo, hi) for _, (lo, hi) in sorted_items}
    bandas = sorted(band_set, key=_band_sort_key)
    return bandas, frecuencias


class _ParsedHTMLTable:
    def __init__(self, heading: str) -> None:
        self.heading = heading
        self.has_child_tables = False
        self.rows: list[list[str]] = []
        self.current_row: list[str] | None = None
        self.current_cell: list[str] | None = None

    def finish_cell(self) -> None:
        if self.current_cell is not None:
            text = " ".join("".join(self.current_cell).split()).strip()
            if self.current_row is None:
                self.current_row = []
            self.current_row.append(text)
            self.current_cell = None

    def finish_row(self) -> None:
        self.finish_cell()
        if self.current_row is not None:
            if self.current_row:
                self.rows.append(self.current_row)
            self.current_row = None


class _DetalleEstacionHTMLParser(HTMLParser):
    """Extrae tablas anidadas preservando la cabecera de sección `<h2>` precedente."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[_ParsedHTMLTable] = []
        self._stack: list[_ParsedHTMLTable] = []
        self._current_heading = ""
        self._in_h2 = False
        self._h2_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_lower = tag.lower()
        if tag_lower == "h2":
            self._in_h2 = True
            self._h2_parts = []
            return
        if tag_lower == "table":
            if self._stack:
                self._stack[-1].has_child_tables = True
            self._stack.append(_ParsedHTMLTable(heading=self._current_heading))
            return
        if not self._stack:
            return
        top = self._stack[-1]
        if tag_lower == "tr":
            top.finish_row()
            top.current_row = []
        elif tag_lower in ("td", "th"):
            if top.current_row is None:
                top.current_row = []
            top.finish_cell()
            top.current_cell = []

    def handle_endtag(self, tag: str) -> None:
        tag_lower = tag.lower()
        if tag_lower == "h2":
            self._in_h2 = False
            heading_txt = " ".join("".join(self._h2_parts).split()).strip()
            if heading_txt:
                self._current_heading = heading_txt
            self._h2_parts = []
            return
        if not self._stack:
            return
        if tag_lower in ("td", "th"):
            self._stack[-1].finish_cell()
        elif tag_lower == "tr":
            self._stack[-1].finish_row()
        elif tag_lower == "table":
            tbl = self._stack.pop()
            tbl.finish_row()
            self.tables.append(tbl)

    def handle_data(self, data: str) -> None:
        if self._in_h2:
            self._h2_parts.append(data)
        if self._stack and self._stack[-1].current_cell is not None:
            self._stack[-1].current_cell.append(data)

    def flush(self) -> None:
        while self._stack:
            tbl = self._stack.pop()
            tbl.finish_row()
            self.tables.append(tbl)


def parse_detalle_estacion_html(html: str) -> list[dict[str, Any]]:
    """
    Analiza el HTML de `detalleEstacion.do` y devuelve únicamente las filas válidas de
    frecuencia de la tabla `CARACTERISTICAS TÉCNICAS`, ignorando por completo la tabla
    `NIVELES MEDIDOS` y la de `LOCALIZACIÓN`.
    """
    if not html or not html.strip():
        return []

    parser = _DetalleEstacionHTMLParser()
    parser.feed(html)
    parser.close()
    parser.flush()

    extracted: list[dict[str, Any]] = []
    for tbl in parser.tables:
        if tbl.has_child_tables or not tbl.rows:
            continue

        heading_norm = _strip_accents(tbl.heading.upper())
        header_cells = [_strip_accents(c.upper()) for c in tbl.rows[0]]
        header_joined = " | ".join(header_cells)

        has_tech_headers = (
            len(header_cells) >= 3
            and "OPERADOR" in header_cells[0]
            and any(tok in header_cells[2] for tok in ("BANDA", "FRECUENCIA", "MHZ"))
        )

        # Descartar siempre NIVELES MEDIDOS y LOCALIZACIÓN
        if not has_tech_headers:
            if "NIVELES MEDIDOS" in heading_norm or "LOCALIZACION" in heading_norm:
                continue
            if any(
                tok in header_joined
                for tok in ("DISTANCIA", "ACIMUT", "VALOR MEDIDO", "DIRECCION")
            ):
                continue

        start_idx = 1 if has_tech_headers else 0
        for row in tbl.rows[start_idx:]:
            if len(row) < 3:
                continue
            operador_raw = " ".join(row[0].split()).strip()
            referencia_raw = " ".join(row[1].split()).strip()
            banda_raw = " ".join(row[2].split()).strip()
            if not operador_raw or not banda_raw:
                continue
            match = FREQ_RANGE_RE.match(banda_raw)
            if not match:
                continue
            lo = float(match.group(1))
            hi = float(match.group(2))
            if not (math.isfinite(lo) and math.isfinite(hi)) or lo <= 0.0 or hi <= 0.0:
                continue
            if lo > hi:
                lo, hi = hi, lo
            frecuencia_clean = f"{_format_mhz(lo)} - {_format_mhz(hi)}"
            extracted.append(
                {
                    "operador": operador_raw,
                    "op": classify_operator(operador_raw),
                    "referencia": referencia_raw,
                    "frecuencia": frecuencia_clean,
                    "minMhz": lo,
                    "maxMhz": hi,
                    "banda": classify_frequency_band(lo, hi),
                }
            )

    return extracted


def get_record_gids(rec: dict[str, Any]) -> list[str]:
    """Devuelve todos los `Gis_ID` asociados a una antena (`gid` + `mergedGids` sin duplicados)."""
    seen: set[str] = set()
    ordered: list[str] = []
    primary = str(rec.get("gid") or "").strip()
    if primary:
        seen.add(primary)
        ordered.append(primary)
    merged = rec.get("mergedGids")
    if isinstance(merged, list):
        for item in merged:
            gid_str = str(item or "").strip()
            if gid_str and gid_str not in seen:
                seen.add(gid_str)
                ordered.append(gid_str)
    return ordered


def count_bands_populated(records: list[dict[str, Any]]) -> int:
    """Cuenta cuántas antenas disponen ya del campo `bandas` sincronizado."""
    return sum(1 for r in records if isinstance(r.get("bandas"), list))


def _load_records_from_preserve_source(
    preserve_from: dict[str, Any] | list[dict[str, Any]] | Path | str | None,
) -> list[dict[str, Any]]:
    if preserve_from is None:
        return []
    if isinstance(preserve_from, (str, Path)):
        path = Path(preserve_from)
        if not path.exists():
            return []
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logging.warning("No se pudo leer preserve_from=%s: %s", path, exc)
            return []
        if isinstance(loaded, dict) and isinstance(loaded.get("antenas"), list):
            return [r for r in loaded["antenas"] if isinstance(r, dict)]
        return []
    if isinstance(preserve_from, dict):
        antenas = preserve_from.get("antenas")
        if isinstance(antenas, list):
            return [r for r in antenas if isinstance(r, dict)]
        return []
    if isinstance(preserve_from, list):
        return [r for r in preserve_from if isinstance(r, dict)]
    return []


def preserve_bands_in_records(
    records: list[dict[str, Any]],
    preserve_from: dict[str, Any] | list[dict[str, Any]] | Path | str | None,
) -> int:
    """
    Reutiliza `bandas` y `frecuencias` ya extraídas en un dataset previo casando por
    `id` o `(op, gid)` (verificando que ningún `mergedGid` nuevo haya quedado sin cubrir).
    Devuelve el número de antenas enriquecidas desde `preserve_from`.
    """
    prior_records = _load_records_from_preserve_source(preserve_from)
    if not prior_records:
        return 0

    by_id: dict[str, dict[str, Any]] = {}
    by_op_gid: dict[tuple[str, str], dict[str, Any]] = {}
    for old_rec in prior_records:
        if not isinstance(old_rec.get("bandas"), list):
            continue
        old_id = str(old_rec.get("id") or "").strip()
        old_op = str(old_rec.get("op") or "").strip()
        old_gid = str(old_rec.get("gid") or "").strip()
        if old_id:
            by_id[old_id] = old_rec
        if old_op:
            for g in get_record_gids(old_rec):
                by_op_gid.setdefault((old_op, g), old_rec)
            if old_gid:
                by_op_gid[(old_op, old_gid)] = old_rec

    restored = 0
    for rec in records:
        if isinstance(rec.get("bandas"), list):
            continue
        rec_id = str(rec.get("id") or "").strip()
        rec_op = str(rec.get("op") or "").strip()
        rec_gid = str(rec.get("gid") or "").strip()
        cand = by_id.get(rec_id)
        if cand is None and rec_op and rec_gid:
            cand = by_op_gid.get((rec_op, rec_gid))
        if cand is None:
            continue

        new_gids = set(get_record_gids(rec))
        old_gids = set(get_record_gids(cand))
        if new_gids and not new_gids.issubset(old_gids):
            continue

        rec["bandas"] = list(cand["bandas"])
        rec["frecuencias"] = list(cand.get("frecuencias") or [])
        restored += 1

    return restored


def _extract_record_ranges_for_gid(
    rec: dict[str, Any],
    entries: list[dict[str, Any]],
    records_at_gid: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    if not entries:
        return []
    rec_op = str(rec.get("op") or "").strip() or classify_operator(str(rec.get("opRaw") or ""))
    if rec_op == "otros":
        rec_op_raw_norm = _strip_accents(
            " ".join(str(rec.get("opRaw") or "").upper().split())
        )
        exact = [
            e
            for e in entries
            if _strip_accents(" ".join(str(e.get("operador") or "").upper().split()))
            == rec_op_raw_norm
        ]
        matched = exact if exact else [e for e in entries if e.get("op") == "otros"]
    else:
        matched = [e for e in entries if e.get("op") == rec_op]

    # Si la estación es el único registro con este `gid` y hay una razón social atípica
    # no reconocida por `classify_operator`, usar como respaldo todas las filas válidas.
    if not matched and len(records_at_gid) <= 1:
        matched = list(entries)

    return [(float(e["minMhz"]), float(e["maxMhz"])) for e in matched]


class BandEnricher:
    """
    Motor incremental de extracción de bandas y frecuencias desde `detalleEstacion.do`
    respetando estrictamente `>= 1.0 s` entre peticiones HTTP consecutivas.
    """

    def __init__(
        self,
        delay_seconds: float = DEFAULT_DELAY_SECONDS,
        max_band_seconds: float | None = None,
        max_band_requests: int | None = None,
        checkpoint_path: Path | None = None,
        checkpoint_every: int = DEFAULT_BAND_CHECKPOINT_EVERY,
        timeout_seconds: float = 30.0,
        fail_fast: bool = False,
        fetch_fn: Callable[[str], str | bytes] | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self.delay_seconds = max(1.0, float(delay_seconds))
        self.max_band_seconds = (
            float(max_band_seconds) if max_band_seconds is not None else None
        )
        self.max_band_requests = (
            int(max_band_requests) if max_band_requests is not None else None
        )
        self.checkpoint_path = checkpoint_path
        self.checkpoint_every = max(1, int(checkpoint_every))
        self.timeout_seconds = float(timeout_seconds)
        self.fail_fast = bool(fail_fast)
        self._custom_fetch_fn = fetch_fn
        self._sleep = sleep_fn
        self._clock = clock_fn

        self.requests_count: int = 0
        self.failed_gids_count: int = 0
        self._last_request_ts: float | None = None
        self._unsaved_requests: int = 0

    def _wait_rate_limit(self) -> None:
        if self._last_request_ts is not None and self.delay_seconds > 0:
            elapsed = self._clock() - self._last_request_ts
            remaining = self.delay_seconds - elapsed
            if remaining > 0:
                self._sleep(remaining)

    def _would_exceed_time_budget(self, run_start_ts: float) -> bool:
        if self.max_band_seconds is None:
            return False
        now = self._clock()
        wait_needed = 0.0
        if self._last_request_ts is not None and self.delay_seconds > 0:
            wait_needed = max(0.0, self.delay_seconds - (now - self._last_request_ts))
        return (now + wait_needed - run_start_ts) >= self.max_band_seconds

    def _http_fetch_detalle(self, gid: str) -> list[dict[str, Any]]:
        url = build_detalle_estacion_url(gid)
        backoffs = (2.0, 4.0, 8.0)
        last_err: Exception | None = None

        for attempt in range(len(backoffs)):
            self._wait_rate_limit()
            self.requests_count += 1
            self._unsaved_requests += 1

            if self._custom_fetch_fn is not None:
                try:
                    payload = self._custom_fetch_fn(gid)
                    self._last_request_ts = self._clock()
                    html = (
                        decode_detalle_estacion_payload(payload)
                        if isinstance(payload, (bytes, bytearray))
                        else str(payload)
                    )
                    return parse_detalle_estacion_html(html)
                except Exception as exc:
                    self._last_request_ts = self._clock()
                    last_err = exc
            else:
                req = urllib.request.Request(
                    url,
                    headers={
                        "User-Agent": (
                            "Mozilla/5.0 (X11; Linux x86_64) WebDeAntenasSpainCrawler/1.0"
                        ),
                        "Accept": "text/html,application/xhtml+xml,*/*",
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                        raw_bytes = resp.read()
                    self._last_request_ts = self._clock()
                    html = decode_detalle_estacion_payload(raw_bytes)
                    if not html.strip():
                        raise ValueError("Respuesta HTML vacía desde detalleEstacion.do")
                    return parse_detalle_estacion_html(html)
                except (
                    urllib.error.HTTPError,
                    urllib.error.URLError,
                    TimeoutError,
                    http.client.HTTPException,
                    OSError,
                    UnicodeDecodeError,
                    ValueError,
                ) as exc:
                    self._last_request_ts = self._clock()
                    last_err = exc

            if attempt < len(backoffs) - 1:
                wait_s = backoffs[attempt]
                logging.warning(
                    "Error en detalleEstacion emplazamiento=%s (intento %d/3): %s. Reintentando en %.1fs...",
                    gid,
                    attempt + 1,
                    last_err,
                    wait_s,
                )
                self._sleep(wait_s)

        raise RuntimeError(
            f"Fallo tras 3 intentos al consultar detalleEstacion emplazamiento={gid!r}: {last_err}"
        ) from last_err

    def _save_dataset_checkpoint(self, dataset: dict[str, Any]) -> None:
        antenas = dataset.get("antenas") or []
        crawl_stats = dataset.setdefault("crawlStats", {})
        crawl_stats["bandsPopulatedCount"] = count_bands_populated(antenas)
        crawl_stats["bandRequestsCount"] = self.requests_count
        dataset["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if self.checkpoint_path is not None:
            write_compact_dataset(dataset, self.checkpoint_path)
        self._unsaved_requests = 0

    def _build_prioritized_units(
        self,
        antenas: list[dict[str, Any]],
        pending_indices: list[int],
    ) -> list[list[str]]:
        prov_totals: dict[str, int] = {}
        for rec in antenas:
            p = str(rec.get("prov") or "")
            prov_totals[p] = prov_totals.get(p, 0) + 1

        single_gid_groups: dict[str, list[int]] = {}
        multi_gid_units: list[tuple[int, list[str]]] = []
        for idx in pending_indices:
            gids = get_record_gids(antenas[idx])
            if len(gids) == 1:
                single_gid_groups.setdefault(gids[0], []).append(idx)
            elif len(gids) > 1:
                multi_gid_units.append((idx, gids))

        raw_candidates: list[tuple[float, str, int, str, tuple[str, ...], list[str]]] = []
        for gid, idxs in single_gid_groups.items():
            gain = float(len(idxs))
            first_rec = antenas[idxs[0]]
            prov = str(first_rec.get("prov") or "")
            op_sig = tuple(sorted({str(antenas[i].get("op") or "") for i in idxs}))
            raw_candidates.append((gain, prov, prov_totals.get(prov, 0), gid, op_sig, [gid]))

        for idx, gids in multi_gid_units:
            rec = antenas[idx]
            prov = str(rec.get("prov") or "")
            op_sig = (str(rec.get("op") or ""),)
            ratio = 1.0 / float(len(gids))
            raw_candidates.append((ratio, prov, prov_totals.get(prov, 0), gids[0], op_sig, gids))

        # Orden base: mayor ratio antenas/petición primero, priorizando MADRID y provincias con más censo
        raw_candidates.sort(
            key=lambda item: (
                -item[0],
                0 if item[1] == "MADRID" else 1,
                -item[2],
                item[1],
                item[3],
            )
        )

        # Entre emplazamientos compartidos (ratio >= 2.0), adelantar el primer ejemplar de
        # cada combinación de operadores para poblar todos los operadores desde las primeras peticiones.
        seen_shared_op_sigs: set[tuple[str, ...]] = set()
        final_keyed: list[tuple[float, int, int, int, str, str, list[str]]] = []
        for ratio, prov, prov_cnt, gid, op_sig, gids in raw_candidates:
            first_of_sig = 1
            if ratio >= 2.0 and op_sig not in seen_shared_op_sigs:
                seen_shared_op_sigs.add(op_sig)
                first_of_sig = 0
            final_keyed.append(
                (
                    -ratio,
                    first_of_sig,
                    0 if prov == "MADRID" else 1,
                    -prov_cnt,
                    prov,
                    gid,
                    gids,
                )
            )

        final_keyed.sort(key=lambda item: item[:6])
        return [item[6] for item in final_keyed]

    def enrich_dataset(self, dataset: dict[str, Any]) -> dict[str, Any]:
        antenas: list[dict[str, Any]] = dataset.get("antenas") or []
        crawl_stats = dataset.setdefault("crawlStats", {})

        all_records_per_gid: dict[str, list[dict[str, Any]]] = {}
        for rec in antenas:
            for g in get_record_gids(rec):
                all_records_per_gid.setdefault(g, []).append(rec)

        zero_gid_populated = 0
        pending_indices: list[int] = []
        pending_by_gid: dict[str, list[int]] = {}
        for idx, rec in enumerate(antenas):
            if isinstance(rec.get("bandas"), list):
                continue
            gids = get_record_gids(rec)
            if not gids:
                rec["bandas"] = []
                rec["frecuencias"] = []
                zero_gid_populated += 1
                continue
            pending_indices.append(idx)
            for g in gids:
                pending_by_gid.setdefault(g, []).append(idx)

        if not pending_indices:
            crawl_stats["bandsPopulatedCount"] = count_bands_populated(antenas)
            crawl_stats["bandRequestsCount"] = 0
            if zero_gid_populated > 0:
                self._save_dataset_checkpoint(dataset)
            return dataset

        units = self._build_prioritized_units(antenas, pending_indices)
        gid_entries_cache: dict[str, list[dict[str, Any]]] = {}
        failed_gids: set[str] = set()
        consecutive_failures = 0
        newly_populated = zero_gid_populated
        run_start_ts = self._clock()

        logging.info(
            "Iniciando enriquecimiento de bandas: %d antenas pendientes (%d unidades GID, delay=%.2fs)...",
            len(pending_indices),
            len(units),
            self.delay_seconds,
        )

        unit_cursor = 0
        total_units = len(units)
        stop_loop = False

        while unit_cursor < total_units and not stop_loop:
            if (
                self.max_band_requests is not None
                and self.requests_count >= self.max_band_requests
            ):
                break
            if self._would_exceed_time_budget(run_start_ts):
                break

            unit_gids = units[unit_cursor]
            unit_cursor += 1
            needed_gids = [
                g
                for g in unit_gids
                if g not in gid_entries_cache and g not in failed_gids
            ]
            if not needed_gids:
                continue

            if self.max_band_requests is not None:
                remaining_reqs = self.max_band_requests - self.requests_count
                if len(needed_gids) > remaining_reqs and any(
                    0
                    < sum(
                        1
                        for g in later
                        if g not in gid_entries_cache and g not in failed_gids
                    )
                    <= remaining_reqs
                    for later in units[unit_cursor:]
                ):
                    continue

            for gid in needed_gids:
                if (
                    self.max_band_requests is not None
                    and self.requests_count >= self.max_band_requests
                ):
                    stop_loop = True
                    break
                if self._would_exceed_time_budget(run_start_ts):
                    stop_loop = True
                    break

                try:
                    entries = self._http_fetch_detalle(gid)
                    gid_entries_cache[gid] = entries
                    consecutive_failures = 0
                except RuntimeError as exc:
                    self.failed_gids_count += 1
                    failed_gids.add(gid)
                    consecutive_failures += 1
                    logging.error("%s", exc)
                    if self.fail_fast:
                        raise
                    if consecutive_failures >= 5:
                        logging.error(
                            "Se alcanzaron %d fallos consecutivos en detalleEstacion.do; deteniendo lote de forma segura.",
                            consecutive_failures,
                        )
                        stop_loop = True
                        break
                    continue

                for rec_idx in pending_by_gid.get(gid, ()):
                    rec = antenas[rec_idx]
                    if isinstance(rec.get("bandas"), list):
                        continue
                    rec_gids = get_record_gids(rec)
                    if not all(g in gid_entries_cache for g in rec_gids):
                        continue
                    combined_ranges: list[tuple[float, float]] = []
                    for rg in rec_gids:
                        combined_ranges.extend(
                            _extract_record_ranges_for_gid(
                                rec,
                                gid_entries_cache[rg],
                                all_records_per_gid.get(rg, [rec]),
                            )
                        )
                    bandas_sorted, freqs_sorted = summarize_frequency_ranges(
                        combined_ranges
                    )
                    rec["bandas"] = bandas_sorted
                    rec["frecuencias"] = freqs_sorted
                    newly_populated += 1

                if self.requests_count % 25 == 0:
                    logging.info(
                        "[bandas req #%d] emplazamiento=%s -> +%d antenas en esta sesión (total con bandas=%d/%d)",
                        self.requests_count,
                        gid,
                        newly_populated,
                        count_bands_populated(antenas),
                        len(antenas),
                    )

                if self._unsaved_requests >= self.checkpoint_every:
                    self._save_dataset_checkpoint(dataset)

        crawl_stats["bandsPopulatedCount"] = count_bands_populated(antenas)
        crawl_stats["bandRequestsCount"] = self.requests_count
        if self.requests_count > 0 or zero_gid_populated > 0:
            self._save_dataset_checkpoint(dataset)

        logging.info(
            "Enriquecimiento finalizado: %d peticiones HTTP, +%d antenas enriquecidas (%d/%d totales con bandas).",
            self.requests_count,
            newly_populated,
            crawl_stats["bandsPopulatedCount"],
            len(antenas),
        )
        return dataset


def enrich_dataset_bands(
    dataset: dict[str, Any],
    delay_seconds: float = DEFAULT_DELAY_SECONDS,
    max_band_seconds: float | None = None,
    max_band_requests: int | None = None,
    checkpoint_path: Path | None = None,
    checkpoint_every: int = DEFAULT_BAND_CHECKPOINT_EVERY,
    fail_fast: bool = False,
    fetch_fn: Callable[[str], str | bytes] | None = None,
    sleep_fn: Callable[[float], None] = time.sleep,
    clock_fn: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Función auxiliar para enriquecer `bandas` y `frecuencias` sobre un `AntenasDataset`."""
    enricher = BandEnricher(
        delay_seconds=delay_seconds,
        max_band_seconds=max_band_seconds,
        max_band_requests=max_band_requests,
        checkpoint_path=checkpoint_path,
        checkpoint_every=checkpoint_every,
        fail_fast=fail_fast,
        fetch_fn=fetch_fn,
        sleep_fn=sleep_fn,
        clock_fn=clock_fn,
    )
    return enricher.enrich_dataset(dataset)


def build_dataset(
    records_by_id: dict[str, dict[str, Any]] | list[dict[str, Any]],
    crawl_stats: dict[str, Any],
    updated_at: str | None = None,
    max_distance_m: float = DEFAULT_VODAFONE_FUSION_M,
    preserve_from: dict[str, Any] | list[dict[str, Any]] | Path | str | None = None,
) -> dict[str, Any]:
    """
    Construye el objeto `AntenasDataset` tipado según `src/types/antena.ts`,
    fusionando previamente declaraciones duplicadas de Vodafone a `< max_distance_m`
    (por defecto `< 35 m`), preservando opcionalmente `bandas`/`frecuencias` previas
    y ordenando las antenas determinísticamente por `(prov, mun, id)`.
    """
    raw_records = (
        list(records_by_id.values())
        if isinstance(records_by_id, dict)
        else list(records_by_id)
    )
    fused_records, fused_count = fuse_vodafone_duplicates(
        raw_records, max_distance_m=max_distance_m
    )

    if preserve_from is not None:
        preserve_bands_in_records(fused_records, preserve_from)

    prior_fused = int(crawl_stats.get("vodafoneFusedDuplicates") or 0)
    crawl_stats_out = dict(crawl_stats)
    crawl_stats_out["vodafoneFusedDuplicates"] = prior_fused + fused_count

    sorted_antenas = sorted(
        fused_records,
        key=lambda r: (r["prov"], r["mun"], r["id"]),
    )

    populated_count = count_bands_populated(sorted_antenas)
    if (
        populated_count > 0
        or preserve_from is not None
        or "bandsPopulatedCount" in crawl_stats_out
    ):
        crawl_stats_out["bandsPopulatedCount"] = populated_count

    op_counts: dict[str, int] = {k: 0 for k in OPERATOR_ORDER}
    op_entities: dict[str, set[str]] = {k: set() for k in OPERATOR_ORDER}
    prov_counts: dict[str, int] = {}
    prov_by_op: dict[str, dict[str, int]] = {}

    for rec in sorted_antenas:
        op_key = rec["op"]
        if op_key not in op_counts:
            op_key = "otros"
        op_counts[op_key] += 1
        if rec.get("opRaw"):
            op_entities[op_key].add(rec["opRaw"])

        prov = rec["prov"]
        prov_counts[prov] = prov_counts.get(prov, 0) + 1
        by_op = prov_by_op.setdefault(prov, {})
        by_op[op_key] = by_op.get(op_key, 0) + 1

    operators_summary: dict[str, dict[str, Any]] = {}
    for key in OPERATOR_ORDER:
        operators_summary[key] = {
            "key": key,
            "name": OPERATOR_NAMES[key],
            "count": op_counts[key],
            "legalEntities": sorted(op_entities[key]),
        }

    provinces_summary: list[dict[str, Any]] = []
    for prov, total_prov in sorted(
        prov_counts.items(),
        key=lambda item: (-item[1], item[0]),
    ):
        raw_by_op = prov_by_op[prov]
        ordered_by_op = {
            k: raw_by_op[k] for k in OPERATOR_ORDER if raw_by_op.get(k, 0) > 0
        }
        provinces_summary.append(
            {
                "provincia": prov,
                "count": total_prov,
                "byOperator": ordered_by_op,
            }
        )

    timestamp = updated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "updatedAt": timestamp,
        "sourceUrl": PORTAL_SOURCE_URL,
        "total": len(sorted_antenas),
        "crawlStats": crawl_stats_out,
        "operators": operators_summary,
        "provinces": provinces_summary,
        "antenas": sorted_antenas,
    }


def write_compact_dataset(dataset: dict[str, Any], output_path: Path) -> int:
    """Escribe `dataset` como JSON UTF-8 compacto de forma atómica y devuelve su tamaño en bytes."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(output_path.name + ".tmp")
    encoded = json.dumps(dataset, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tmp_path.write_bytes(encoded)
    os.replace(tmp_path, output_path)
    return len(encoded)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Recolector completo de antenas móviles y bandas RF de España (Infoantenas MINETUR)."
    )
    parser.add_argument(
        "--region",
        choices=("all", "sample"),
        default="all",
        help="Alcance geográfico: 'all' (toda España) o 'sample' (2 peticiones de muestra).",
    )
    parser.add_argument(
        "--input",
        default=None,
        help="Ruta del archivo antenas.json existente (usado con --enrich-bands-only).",
    )
    parser.add_argument(
        "--output",
        default="public/data/antenas.json",
        help="Ruta del archivo JSON compacto de salida.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY_SECONDS,
        help="Segundos mínimos de espera entre peticiones HTTP consecutivas (mínimo 1.0s en bandas).",
    )
    parser.add_argument(
        "--zoom",
        type=int,
        default=DEFAULT_ZOOM,
        help="Parámetro zoom de Infoantenas (por defecto 7).",
    )
    parser.add_argument(
        "--checkpoint",
        default=None,
        help="Ruta opcional de archivo de checkpoint para guardar/reanudar el barrido GeoJSON.",
    )
    parser.add_argument(
        "--preserve-from",
        default=None,
        help="Ruta a un antenas.json previo del que reutilizar bandas/frecuencias ya extraídas (por defecto --output si existe).",
    )
    parser.add_argument(
        "--fetch-bands",
        action="store_true",
        help="Tras recolectar el censo, consulta detalleEstacion.do (a >= 1.0s/req) para antenas sin bandas.",
    )
    parser.add_argument(
        "--enrich-bands-only",
        action="store_true",
        help="Carga --input y consulta detalleEstacion.do únicamente para las antenas pendientes sin bandas.",
    )
    parser.add_argument(
        "--max-band-seconds",
        type=float,
        default=None,
        help="Tiempo máximo en segundos dedicado a consultar detalleEstacion.do (ej. 14400 o 18000).",
    )
    parser.add_argument(
        "--max-band-requests",
        type=int,
        default=None,
        help="Número máximo opcional de peticiones a detalleEstacion.do en esta ejecución.",
    )
    parser.add_argument(
        "--band-checkpoint-every",
        type=int,
        default=DEFAULT_BAND_CHECKPOINT_EVERY,
        help="Guardar checkpoint atómico en --output cada N peticiones de bandas (por defecto 50).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    args = parse_args(argv)
    output_path = Path(args.output)

    if args.enrich_bands_only:
        input_path = Path(args.input) if args.input else output_path
        if not input_path.exists():
            logging.error("No existe el archivo de entrada: %s", input_path)
            return 1
        dataset = json.loads(input_path.read_text(encoding="utf-8"))
        band_delay = max(1.0, float(args.delay))
        enricher = BandEnricher(
            delay_seconds=band_delay,
            max_band_seconds=args.max_band_seconds,
            max_band_requests=args.max_band_requests,
            checkpoint_path=output_path,
            checkpoint_every=args.band_checkpoint_every,
        )
        enricher.enrich_dataset(dataset)
        if output_path.resolve() != input_path.resolve() and enricher.requests_count == 0:
            write_compact_dataset(dataset, output_path)
        size_mb = output_path.stat().st_size / (1024 * 1024) if output_path.exists() else 0.0
        logging.info(
            "Modo --enrich-bands-only completado: %d/%d antenas con bandas en %s (%.2f MB, %d peticiones HTTP).",
            dataset["crawlStats"].get("bandsPopulatedCount", 0),
            dataset["total"],
            output_path,
            size_mb,
            enricher.requests_count,
        )
        return 0

    auto_checkpoint = False
    if args.checkpoint:
        checkpoint_path: Path | None = Path(args.checkpoint)
    elif args.region == "all":
        checkpoint_path = Path("/tmp/web_de_antenas_full_crawl.checkpoint.json")
        auto_checkpoint = True
    else:
        checkpoint_path = None

    preserve_path: Path | None
    if args.preserve_from:
        preserve_path = Path(args.preserve_from)
    elif output_path.exists():
        preserve_path = output_path
    else:
        preserve_path = None

    prior_dataset: dict[str, Any] | None = None
    if preserve_path is not None and preserve_path.exists():
        try:
            prior_dataset = json.loads(preserve_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logging.warning("No se pudo cargar %s para preservar bandas: %s", preserve_path, exc)

    delay = max(1.0, args.delay) if args.delay >= 1.0 else max(0.0, args.delay)

    crawler = InfoantenasCrawler(
        delay_seconds=delay,
        zoom=args.zoom,
        checkpoint_path=checkpoint_path,
    )
    dataset = crawler.crawl(region=args.region)

    if prior_dataset is not None:
        restored = preserve_bands_in_records(dataset["antenas"], prior_dataset)
        dataset["crawlStats"]["bandsPopulatedCount"] = count_bands_populated(
            dataset["antenas"]
        )
        prior_band_reqs = (prior_dataset.get("crawlStats") or {}).get("bandRequestsCount")
        if prior_band_reqs is not None and not args.fetch_bands:
            dataset["crawlStats"]["bandRequestsCount"] = int(prior_band_reqs)
        logging.info(
            "Preservadas bandas previas de %d antenas desde %s.",
            restored,
            preserve_path,
        )

    size_bytes = write_compact_dataset(dataset, output_path)

    if args.fetch_bands:
        band_delay = max(1.0, float(args.delay))
        enrich_dataset_bands(
            dataset,
            delay_seconds=band_delay,
            max_band_seconds=args.max_band_seconds,
            max_band_requests=args.max_band_requests,
            checkpoint_path=output_path,
            checkpoint_every=args.band_checkpoint_every,
        )
        size_bytes = write_compact_dataset(dataset, output_path)

    if auto_checkpoint and checkpoint_path and checkpoint_path.exists():
        try:
            checkpoint_path.unlink()
        except OSError:
            pass

    size_mb = size_bytes / (1024 * 1024)
    logging.info(
        "Completado: %d antenas únicas guardadas en %s (%.2f MB) en %d peticiones GeoJSON (%.1fs) | con bandas=%d.",
        dataset["total"],
        output_path,
        size_mb,
        dataset["crawlStats"]["requestsCount"],
        dataset["crawlStats"]["durationSeconds"],
        dataset["crawlStats"].get("bandsPopulatedCount", 0),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
