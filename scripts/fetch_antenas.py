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
PORTAL_SOURCE_URL = "https://geoportal.minetur.gob.es/VCTEL/vcne.do"
SERVER_FEATURE_CAP = 1000
DEFAULT_ZOOM = 7
DEFAULT_DELAY_SECONDS = 1.0
QUADRANT_OVERLAP_DEG = 0.0001
MIN_QUADRANT_SPAN_DEG = 0.004
MAX_SUBDIVISION_DEPTH = 9

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
VODAFONE_DEDUP_DISTANCE_M = 10.0


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
    max_distance_m: float = VODAFONE_DEDUP_DISTANCE_M,
) -> tuple[list[dict[str, Any]], int]:
    """
    Fusiona declaraciones duplicadas de Vodafone (`op == "vodafone"`) situadas a
    estrictamente `< max_distance_m` metros usando malla espacial (`cell_deg = 0.0002`,
    ~22 m) + Union-Find.

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

    cell_deg = max(0.0002, max_distance_m / 70_000.0)
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

        merged_by_root[root] = merged_rec

    emitted_roots: set[int] = set()
    output_records: list[dict[str, Any]] = []
    for rec_idx, rec in enumerate(records):
        voda_k = voda_pos_by_record_idx.get(rec_idx)
        if voda_k is None:
            output_records.append(dict(rec))
            continue
        root = find(voda_k)
        if root not in emitted_roots:
            emitted_roots.add(root)
            output_records.append(merged_by_root[root])

    return output_records, fused_duplicates


def build_dataset(
    records_by_id: dict[str, dict[str, Any]] | list[dict[str, Any]],
    crawl_stats: dict[str, Any],
    updated_at: str | None = None,
) -> dict[str, Any]:
    """
    Construye el objeto `AntenasDataset` tipado según `src/types/antena.ts`,
    fusionando previamente declaraciones duplicadas de Vodafone a `< 10 m` y
    ordenando las antenas determinísticamente por `(prov, mun, id)`.
    """
    raw_records = (
        list(records_by_id.values())
        if isinstance(records_by_id, dict)
        else list(records_by_id)
    )
    fused_records, fused_count = fuse_vodafone_duplicates(raw_records)

    prior_fused = int(crawl_stats.get("vodafoneFusedDuplicates") or 0)
    crawl_stats_out = dict(crawl_stats)
    crawl_stats_out["vodafoneFusedDuplicates"] = prior_fused + fused_count

    sorted_antenas = sorted(
        fused_records,
        key=lambda r: (r["prov"], r["mun"], r["id"]),
    )

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
        description="Recolector completo de antenas móviles de España (Infoantenas MINETUR)."
    )
    parser.add_argument(
        "--region",
        choices=("all", "sample"),
        default="all",
        help="Alcance geográfico: 'all' (toda España) o 'sample' (2 peticiones de muestra).",
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
        help="Segundos mínimos de espera entre peticiones HTTP consecutivas (por defecto 1.0).",
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
        help="Ruta opcional de archivo de checkpoint para guardar/reanudar progreso.",
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

    auto_checkpoint = False
    if args.checkpoint:
        checkpoint_path: Path | None = Path(args.checkpoint)
    elif args.region == "all":
        checkpoint_path = Path("/tmp/web_de_antenas_full_crawl.checkpoint.json")
        auto_checkpoint = True
    else:
        checkpoint_path = None

    delay = max(1.0, args.delay) if args.delay >= 1.0 else max(0.0, args.delay)

    crawler = InfoantenasCrawler(
        delay_seconds=delay,
        zoom=args.zoom,
        checkpoint_path=checkpoint_path,
    )
    dataset = crawler.crawl(region=args.region)
    size_bytes = write_compact_dataset(dataset, output_path)

    if auto_checkpoint and checkpoint_path and checkpoint_path.exists():
        try:
            checkpoint_path.unlink()
        except OSError:
            pass

    size_mb = size_bytes / (1024 * 1024)
    logging.info(
        "Completado: %d antenas únicas guardadas en %s (%.2f MB) en %d peticiones (%.1fs).",
        dataset["total"],
        output_path,
        size_mb,
        dataset["crawlStats"]["requestsCount"],
        dataset["crawlStats"]["durationSeconds"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
