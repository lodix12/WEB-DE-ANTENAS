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
- Conexiones persistentes HTTP/1.1 Keep-Alive multihilo con reutilización TLS y
  reintentos con backoff exponencial (2s, 4s, 8s).
- Emisión en tiempo real de deltas (`live-chunk-*.json` + `live-tail.json`) para
  sincronización instantánea con el mapa y la vista de Novedades.
- Deduplicación global por identificador oficial y salida JSON compacta compatible
  al 100% con `AntenasDataset` (`src/types/antena.ts`).
"""

from __future__ import annotations

import argparse
import base64
from collections import deque
import concurrent.futures
from datetime import datetime, timezone
import gzip
from html.parser import HTMLParser
import http.client
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import ssl
import sys
import threading
import time
from typing import Any, Callable
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

_ORIGINAL_URLOPEN = urllib.request.urlopen

ENDPOINT_URL = "https://geoportal.minetur.gob.es/VCTEL/infoantenasGeoJSON.do"
DETAIL_ENDPOINT_URL = "https://geoportal.minetur.gob.es/VCTEL/detalleEstacion.do"
PORTAL_SOURCE_URL = "https://geoportal.minetur.gob.es/VCTEL/vcne.do"
SERVER_FEATURE_CAP = 1000
DEFAULT_ZOOM = 7
DEFAULT_DELAY_SECONDS = 0.02
DEFAULT_BAND_WORKERS = 16
DEFAULT_CENSUS_WORKERS = 8
LIVE_DELTA_CHUNK_CAPACITY = 500
MULTI_WORKER_CHECKPOINT_MIN_INTERVAL_S = 25.0
DEFAULT_BAND_CHECKPOINT_EVERY = 50
QUADRANT_OVERLAP_DEG = 0.0001
MIN_QUADRANT_SPAN_DEG = 0.004
MAX_SUBDIVISION_DEPTH = 9
FREQ_RANGE_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)(?:\s*(?:MHz|GHz))?$",
    re.IGNORECASE,
)
SPAIN_TZ = ZoneInfo("Europe/Madrid")

BBox = tuple[float, float, float, float]  # (min_lon, min_lat, max_lon, max_lat)


def _parse_utc_datetime(value: datetime | str) -> datetime:
    """Convierte un `datetime` o cadena ISO-8601 UTC a `datetime` en `timezone.utc`."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    cleaned = str(value or "").strip()
    if not cleaned:
        raise ValueError("Marca temporal ISO-8601 vacía")
    if cleaned.endswith(("Z", "z")):
        cleaned = cleaned[:-1] + "+00:00"
    parsed = datetime.fromisoformat(cleaned)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _utc_now_iso(now_utc_fn: Callable[[], datetime] | None = None) -> str:
    """Genera una marca temporal ISO-8601 UTC en formato `'YYYY-MM-DDTHH:MM:SSZ'`."""
    dt = now_utc_fn() if now_utc_fn is not None else datetime.now(timezone.utc)
    return _parse_utc_datetime(dt).strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalize_iso_utc(value: str) -> str:
    """Normaliza una marca temporal ISO-8601 a `'YYYY-MM-DDTHH:MM:SSZ'` para comparaciones."""
    cleaned = str(value or "").strip()
    if not cleaned:
        return ""
    try:
        return _parse_utc_datetime(cleaned).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return cleaned


def format_spain_datetime(value: datetime | str) -> str:
    """
    Formatea un `datetime` UTC o cadena ISO-8601 UTC en hora peninsular oficial de España
    (`Europe/Madrid`, CET/CEST) con formato exacto `'DD/MM/YYYY HH:MM:SS'`.
    """
    utc_dt = _parse_utc_datetime(value)
    return utc_dt.astimezone(SPAIN_TZ).strftime("%d/%m/%Y %H:%M:%S")

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


class _ThreadLocalKeepAliveClient:
    """
    Cliente HTTP/1.1 persistente (`Connection: keep-alive` + reutilización TLS por hilo)
    construido exclusivamente con la librería estándar de Python.
    Delega automáticamente en `urllib.request.urlopen` cuando los tests unitarios lo parchean.
    """

    def __init__(self) -> None:
        self._tls = threading.local()
        self._lock = threading.Lock()
        self._all_conns: list[http.client.HTTPConnection] = []
        self._ssl_ctx: ssl.SSLContext | None = None
        self._cooldown_until: float = 0.0

    def _get_ssl_context(self) -> ssl.SSLContext:
        with self._lock:
            if self._ssl_ctx is None:
                self._ssl_ctx = ssl.create_default_context()
            return self._ssl_ctx

    @staticmethod
    def _resolve_proxy(scheme: str, target_host: str) -> str:
        if target_host in ("127.0.0.1", "localhost", "::1"):
            return ""
        try:
            if urllib.request.proxy_bypass(target_host):
                return ""
        except Exception:
            pass
        if scheme == "https":
            return (
                os.environ.get("HTTPS_PROXY")
                or os.environ.get("https_proxy")
                or os.environ.get("HTTP_PROXY")
                or os.environ.get("http_proxy")
                or ""
            ).strip()
        return (
            os.environ.get("HTTP_PROXY")
            or os.environ.get("http_proxy")
            or ""
        ).strip()

    def _create_connection(
        self,
        scheme: str,
        target_host: str,
        target_port: int,
        proxy_raw: str,
        timeout: float,
    ) -> tuple[http.client.HTTPConnection, dict[str, str], bool]:
        if proxy_raw:
            proxy_norm = proxy_raw if "://" in proxy_raw else f"http://{proxy_raw}"
            parsed_proxy = urllib.parse.urlsplit(proxy_norm)
            proxy_host = parsed_proxy.hostname or ""
            proxy_port = parsed_proxy.port or (
                443 if parsed_proxy.scheme == "https" else 8080
            )
            proxy_headers: dict[str, str] = {}
            if parsed_proxy.username is not None:
                creds = (
                    f"{urllib.parse.unquote(parsed_proxy.username)}:"
                    f"{urllib.parse.unquote(parsed_proxy.password or '')}"
                )
                b64 = base64.b64encode(creds.encode("utf-8")).decode("ascii")
                proxy_headers["Proxy-Authorization"] = f"Basic {b64}"

            if scheme == "https":
                conn: http.client.HTTPConnection = http.client.HTTPSConnection(
                    proxy_host,
                    proxy_port,
                    timeout=timeout,
                    context=self._get_ssl_context(),
                )
                conn.set_tunnel(
                    target_host,
                    target_port,
                    headers=proxy_headers or None,
                )
                extra_req_headers: dict[str, str] = {}
                use_full_url = False
            else:
                conn = http.client.HTTPConnection(
                    proxy_host,
                    proxy_port,
                    timeout=timeout,
                )
                extra_req_headers = proxy_headers
                use_full_url = True
        else:
            if scheme == "https":
                conn = http.client.HTTPSConnection(
                    target_host,
                    target_port,
                    timeout=timeout,
                    context=self._get_ssl_context(),
                )
            else:
                conn = http.client.HTTPConnection(
                    target_host,
                    target_port,
                    timeout=timeout,
                )
            extra_req_headers = {}
            use_full_url = False

        with self._lock:
            self._all_conns.append(conn)
        return conn, extra_req_headers, use_full_url

    def _discard_tls_conn(self) -> None:
        conn: http.client.HTTPConnection | None = getattr(self._tls, "conn", None)
        self._tls.conn = None
        self._tls.conn_key = None
        self._tls.extra_headers = {}
        self._tls.use_full_url = False
        if conn is not None:
            with self._lock:
                try:
                    self._all_conns.remove(conn)
                except ValueError:
                    pass
            try:
                conn.close()
            except Exception:
                pass

    def record_throttle_signal(
        self,
        wait_seconds: float,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        clamped = max(0.5, min(15.0, float(wait_seconds)))
        target_ts = clock_fn() + clamped
        with self._lock:
            if target_ts > self._cooldown_until:
                self._cooldown_until = target_ts

    def wait_if_cooled_down(
        self,
        clock_fn: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        while True:
            with self._lock:
                until = self._cooldown_until
            remaining = until - clock_fn()
            if remaining <= 0.0:
                return
            sleep_fn(remaining)

    def fetch_bytes(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        *,
        clock_fn: Callable[[], float] = time.monotonic,
        _redirects_left: int = 3,
    ) -> bytes:
        if urllib.request.urlopen is not _ORIGINAL_URLOPEN:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()

        parsed = urllib.parse.urlsplit(url)
        scheme = (parsed.scheme or "https").lower()
        target_host = parsed.hostname or "geoportal.minetur.gob.es"
        target_port = parsed.port or (443 if scheme == "https" else 80)
        path_and_query = parsed.path or "/"
        if parsed.query:
            path_and_query = f"{path_and_query}?{parsed.query}"

        proxy_raw = self._resolve_proxy(scheme, target_host)
        conn_key = (scheme, target_host, target_port, proxy_raw, float(timeout))
        host_header = (
            target_host
            if (scheme == "https" and target_port == 443)
            or (scheme == "http" and target_port == 80)
            else f"{target_host}:{target_port}"
        )

        for is_fresh_attempt in (False, True):
            conn: http.client.HTTPConnection | None = getattr(self._tls, "conn", None)
            reused = conn is not None and getattr(self._tls, "conn_key", None) == conn_key
            if not reused:
                if conn is not None:
                    self._discard_tls_conn()
                conn, extra_hdrs, use_full_url = self._create_connection(
                    scheme, target_host, target_port, proxy_raw, timeout
                )
                self._tls.conn = conn
                self._tls.conn_key = conn_key
                self._tls.extra_headers = extra_hdrs
                self._tls.use_full_url = use_full_url
                reused = False
            else:
                extra_hdrs = getattr(self._tls, "extra_headers", {})
                use_full_url = bool(getattr(self._tls, "use_full_url", False))

            req_target = url if use_full_url else path_and_query
            req_headers = {
                "Host": host_header,
                "Connection": "keep-alive",
                "Accept-Encoding": "gzip",
                **extra_hdrs,
                **headers,
            }

            try:
                assert conn is not None
                conn.request("GET", req_target, headers=req_headers)
                resp = conn.getresponse()
                raw_bytes = resp.read()
                conn_hdr = (resp.getheader("Connection") or "").lower()
                if resp.will_close or "close" in conn_hdr:
                    self._discard_tls_conn()
            except (
                http.client.HTTPException,
                BrokenPipeError,
                ConnectionResetError,
                ssl.SSLError,
                TimeoutError,
                OSError,
            ):
                self._discard_tls_conn()
                if reused and not is_fresh_attempt:
                    # Socket Keep-Alive cerrado en servidor tras inactividad -> reabrir de inmediato
                    continue
                raise

            if resp.status in (301, 302, 303, 307, 308) and _redirects_left > 0:
                loc = resp.getheader("Location")
                if loc:
                    return self.fetch_bytes(
                        urllib.parse.urljoin(url, loc),
                        headers,
                        timeout,
                        clock_fn=clock_fn,
                        _redirects_left=_redirects_left - 1,
                    )

            if resp.status >= 400:
                if resp.status in (429, 503):
                    retry_after_hdr = (resp.getheader("Retry-After") or "").strip()
                    wait_s = 2.0
                    if retry_after_hdr:
                        try:
                            wait_s = float(retry_after_hdr)
                        except ValueError:
                            wait_s = 2.0
                    self.record_throttle_signal(wait_s, clock_fn=clock_fn)
                raise urllib.error.HTTPError(
                    url,
                    resp.status,
                    resp.reason,
                    resp.headers,
                    io.BytesIO(raw_bytes),
                )

            return raw_bytes

        raise RuntimeError(f"No fue posible establecer conexión HTTP hacia {url}")

    def close_all(self) -> None:
        with self._lock:
            conns = list(self._all_conns)
            self._all_conns.clear()
        self._tls.__dict__.clear()
        for c in conns:
            try:
                c.close()
            except Exception:
                pass


def _build_vodafone_spatial_grid(
    records: list[dict[str, Any]],
    max_distance_m: float = DEFAULT_VODAFONE_FUSION_M,
) -> tuple[dict[tuple[int, int], list[tuple[float, float]]], float]:
    cell_deg = max(0.0006, (max_distance_m / 111320.0) / 0.65)
    grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for rec in records:
        if rec.get("op") != "vodafone":
            continue
        try:
            lat = float(rec["lat"])
            lon = float(rec["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        cx = math.floor(lat / cell_deg)
        cy = math.floor(lon / cell_deg)
        grid.setdefault((cx, cy), []).append((lat, lon))
    return grid, cell_deg


def _is_near_vodafone_grid(
    lat: float,
    lon: float,
    grid: dict[tuple[int, int], list[tuple[float, float]]],
    cell_deg: float,
    max_distance_m: float = DEFAULT_VODAFONE_FUSION_M,
) -> bool:
    cx = math.floor(lat / cell_deg)
    cy = math.floor(lon / cell_deg)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            bucket = grid.get((cx + dx, cy + dy))
            if not bucket:
                continue
            for olat, olon in bucket:
                if haversine_m(lat, lon, olat, olon) < max_distance_m:
                    return True
    return False


class InfoantenasCrawler:
    """Motor de recolección iterativa y subdivisión adaptativa con soporte Keep-Alive paralelo."""

    def __init__(
        self,
        delay_seconds: float = DEFAULT_DELAY_SECONDS,
        zoom: int = DEFAULT_ZOOM,
        min_span_deg: float = MIN_QUADRANT_SPAN_DEG,
        checkpoint_path: Path | None = None,
        checkpoint_every: int = 20,
        timeout_seconds: float = 30.0,
        workers: int = 1,
        prior_index: dict[str, Any] | None = None,
        record_novedades: bool = False,
        live_stream: LiveDeltaStreamWriter | None = None,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
        fetch_fn: Callable[[BBox, int], list[dict[str, Any]]] | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
        clock_fn: Callable[[], float] = time.monotonic,
        now_utc_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self.delay_seconds = max(0.0, float(delay_seconds))
        self.zoom = int(zoom)
        self.min_span_deg = float(min_span_deg)
        self.checkpoint_path = checkpoint_path
        self.checkpoint_every = max(1, int(checkpoint_every))
        self.timeout_seconds = float(timeout_seconds)
        self.workers = max(1, int(workers))
        self._prior_index = prior_index
        self._record_novedades = bool(record_novedades)
        self._live_stream = live_stream
        self._progress_callback = progress_callback
        self._custom_fetch_fn = fetch_fn
        self._sleep = sleep_fn
        self._clock = clock_fn
        self._now_utc = now_utc_fn

        self._http_client = _ThreadLocalKeepAliveClient()
        self._stats_lock = threading.Lock()
        self._worker_tls = threading.local()

        self.records_by_id: dict[str, dict[str, Any]] = {}
        self.completed_leaf_boxes: set[str] = set()
        self.cached_box_counts: dict[str, int] = {}
        self.requests_count: int = 0
        self.grid_boxes_visited: int = 0
        self.subdivided_boxes: int = 0
        self.prior_elapsed_seconds: float = 0.0
        self._last_request_ts: float | None = None
        self._unsaved_requests: int = 0

        prior_voda_records = (
            list((prior_index.get("by_id") or {}).values())
            if isinstance(prior_index, dict)
            else []
        )
        self._provisional_voda_grid, self._provisional_voda_cell_deg = (
            _build_vodafone_spatial_grid(prior_voda_records)
        )

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

    def _wait_worker_rate_limit(self) -> None:
        self._http_client.wait_if_cooled_down(self._clock, self._sleep)
        last_ts: float | None = getattr(self._worker_tls, "last_req_ts", None)
        if last_ts is not None and self.delay_seconds > 0:
            elapsed = self._clock() - last_ts
            remaining = self.delay_seconds - elapsed
            if remaining > 0:
                self._sleep(remaining)

    def _http_fetch_bbox(self, bbox: BBox, *, parallel_mode: bool = False) -> list[dict[str, Any]]:
        url = build_bbox_url(bbox, zoom=self.zoom)
        backoffs = (2.0, 4.0, 8.0)
        last_err: Exception | None = None
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) WebDeAntenasSpainCrawler/1.0"
            ),
            "Accept": "application/json, text/plain, */*",
        }

        for attempt in range(len(backoffs)):
            if parallel_mode:
                self._wait_worker_rate_limit()
                with self._stats_lock:
                    self.requests_count += 1
                    self._unsaved_requests += 1
            else:
                self._wait_rate_limit()
                self.requests_count += 1
                self._unsaved_requests += 1

            if self._custom_fetch_fn is not None:
                try:
                    features = self._custom_fetch_fn(bbox, self.zoom)
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    return features
                except Exception as exc:
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    last_err = exc
            else:
                try:
                    raw_bytes = self._http_client.fetch_bytes(
                        url,
                        headers=headers,
                        timeout=self.timeout_seconds,
                        clock_fn=self._clock,
                    )
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    return decode_infoantenas_payload(raw_bytes)
                except (
                    urllib.error.HTTPError,
                    urllib.error.URLError,
                    TimeoutError,
                    http.client.HTTPException,
                    ssl.SSLError,
                    OSError,
                    UnicodeDecodeError,
                    json.JSONDecodeError,
                ) as exc:
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
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

    def _ingest_features(self, features: list[dict[str, Any]]) -> tuple[int, bool]:
        added = 0
        provisional_antennas: list[dict[str, Any]] = []
        provisional_novedades: list[dict[str, Any]] = []

        for feat in features:
            rec = parse_feature(feat)
            if rec is None:
                continue
            rec_id = rec["id"]
            is_first_seen = rec_id not in self.records_by_id
            if is_first_seen:
                added += 1
            self.records_by_id[rec_id] = rec

            if (
                is_first_seen
                and self._live_stream is not None
                and self._prior_index is not None
                and match_prior_antenna(rec, self._prior_index) is None
            ):
                if rec["op"] == "vodafone":
                    lat_f = float(rec["lat"])
                    lon_f = float(rec["lon"])
                    if _is_near_vodafone_grid(
                        lat_f,
                        lon_f,
                        self._provisional_voda_grid,
                        self._provisional_voda_cell_deg,
                    ):
                        continue
                    cx = math.floor(lat_f / self._provisional_voda_cell_deg)
                    cy = math.floor(lon_f / self._provisional_voda_cell_deg)
                    self._provisional_voda_grid.setdefault((cx, cy), []).append(
                        (lat_f, lon_f)
                    )

                provisional_antennas.append(dict(rec))
                if self._record_novedades:
                    scan_iso = _utc_now_iso(self._now_utc)
                    mun = str(rec.get("mun") or "").strip()
                    prov = str(rec.get("prov") or "").strip()
                    provisional_novedades.append(
                        {
                            "id": f"ant:{rec_id}",
                            "tipo": "antena",
                            "op": rec["op"],
                            "opRaw": rec["opRaw"],
                            "codigo": rec["gid"],
                            "antennaId": rec_id,
                            "codigoBanda": "",
                            "frecuencia": "",
                            "ubicacion": mun or prov,
                            "prov": prov,
                            "scannedAt": scan_iso,
                            "fecha": format_spain_datetime(scan_iso),
                        }
                    )

        flushed_live = False
        if provisional_antennas and self._live_stream is not None:
            flushed_live = self._live_stream.record_provisional_new_antennas(
                provisional_antennas,
                provisional_novedades,
            )
        return added, flushed_live

    def _can_subdivide_bbox(self, bbox: BBox, depth: int) -> bool:
        lon_span = bbox[2] - bbox[0]
        lat_span = bbox[3] - bbox[1]
        return (
            lon_span > self.min_span_deg or lat_span > self.min_span_deg
        ) and depth < MAX_SUBDIVISION_DEPTH

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
            features = self._http_fetch_bbox(bbox, parallel_mode=False)
            count = len(features)
            added, flushed_live = self._ingest_features(features)
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

            if self._progress_callback is not None and (
                flushed_live
                or self.requests_count == 1
                or self.requests_count % 3 == 0
            ):
                elapsed_s = max(0.001, self._clock() - run_start_ts)
                self._progress_callback(
                    {
                        "phase": "censo",
                        "censusBoxesVisited": self.grid_boxes_visited,
                        "discoveredAntennas": len(self.records_by_id),
                        "requestsPerSecond": round(self.requests_count / elapsed_s, 2),
                    }
                )

            if self._unsaved_requests >= self.checkpoint_every:
                self.save_checkpoint(self._clock() - run_start_ts)

        can_subdivide = self._can_subdivide_bbox(bbox, depth)

        if count >= SERVER_FEATURE_CAP and can_subdivide:
            if depth == 0 or key not in self.completed_leaf_boxes:
                self.subdivided_boxes += 1
            for child_bbox in subdivide_bbox(bbox):
                self._crawl_bbox_recursive(child_bbox, depth + 1, run_start_ts)

        self.completed_leaf_boxes.add(key)

    def _crawl_parallel(self, initial_boxes: list[BBox], run_start_ts: float) -> None:
        pending_queue: deque[tuple[BBox, int, str]] = deque()
        enqueued_keys: set[str] = set()
        subdivided_parent_keys: list[str] = []

        def _enqueue_or_expand(bbox: BBox, depth: int) -> None:
            if is_outside_spain_conservative(bbox):
                return
            key = format_bbox_key(bbox)
            if key in self.completed_leaf_boxes or key in enqueued_keys:
                return
            if key in self.cached_box_counts:
                count = self.cached_box_counts[key]
                if count >= SERVER_FEATURE_CAP and self._can_subdivide_bbox(bbox, depth):
                    self.subdivided_boxes += 1
                    subdivided_parent_keys.append(key)
                    for child_bbox in subdivide_bbox(bbox):
                        _enqueue_or_expand(child_bbox, depth + 1)
                else:
                    self.completed_leaf_boxes.add(key)
                return
            enqueued_keys.add(key)
            pending_queue.append((bbox, depth, key))

        for root_bbox in initial_boxes:
            _enqueue_or_expand(root_bbox, 0)

        if not pending_queue:
            self.completed_leaf_boxes.update(subdivided_parent_keys)
            return

        max_in_flight = max(self.workers, self.workers * 2)
        last_progress_ts = run_start_ts
        last_ckpt_ts = run_start_ts

        with concurrent.futures.ThreadPoolExecutor(
            max_workers=self.workers,
            thread_name_prefix="minetur-census",
        ) as executor:
            in_flight: dict[concurrent.futures.Future[list[dict[str, Any]]], tuple[BBox, int, str]] = {}

            while pending_queue and len(in_flight) < max_in_flight:
                item = pending_queue.popleft()
                fut = executor.submit(self._http_fetch_bbox, item[0], parallel_mode=True)
                in_flight[fut] = item

            while in_flight:
                done, _ = concurrent.futures.wait(
                    in_flight.keys(),
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                any_flushed_live = False
                for fut in done:
                    bbox, depth, key = in_flight.pop(fut)
                    try:
                        features = fut.result()
                    except Exception:
                        for other_fut in in_flight:
                            other_fut.cancel()
                        raise

                    self.grid_boxes_visited += 1
                    count = len(features)
                    added, flushed_live = self._ingest_features(features)
                    if flushed_live:
                        any_flushed_live = True
                    self.cached_box_counts[key] = count

                    if self.grid_boxes_visited % 20 == 0 or count >= SERVER_FEATURE_CAP:
                        logging.info(
                            "[censo #%d | depth=%d] bbox=%s -> %d recibidas (+%d nuevas, total=%d)",
                            self.grid_boxes_visited,
                            depth,
                            key,
                            count,
                            added,
                            len(self.records_by_id),
                        )

                    if count >= SERVER_FEATURE_CAP and self._can_subdivide_bbox(bbox, depth):
                        self.subdivided_boxes += 1
                        subdivided_parent_keys.append(key)
                        for child_bbox in subdivide_bbox(bbox):
                            _enqueue_or_expand(child_bbox, depth + 1)
                    else:
                        self.completed_leaf_boxes.add(key)

                while pending_queue and len(in_flight) < max_in_flight:
                    item = pending_queue.popleft()
                    fut = executor.submit(self._http_fetch_bbox, item[0], parallel_mode=True)
                    in_flight[fut] = item

                now = self._clock()
                elapsed_s = max(0.001, now - run_start_ts)
                rps = round(self.requests_count / elapsed_s, 2)
                if self._progress_callback is not None and (
                    any_flushed_live
                    or not in_flight
                    or (now - last_progress_ts) >= 0.8
                ):
                    self._progress_callback(
                        {
                            "phase": "censo",
                            "censusBoxesVisited": self.grid_boxes_visited,
                            "discoveredAntennas": len(self.records_by_id),
                            "requestsPerSecond": rps,
                        }
                    )
                    last_progress_ts = now

                if (
                    self.checkpoint_path is not None
                    and self._unsaved_requests >= self.checkpoint_every
                    and (now - last_ckpt_ts) >= 15.0
                ):
                    self.save_checkpoint(now - run_start_ts)
                    last_ckpt_ts = self._clock()

        self.completed_leaf_boxes.update(subdivided_parent_keys)

    def crawl(self, region: str = "all") -> dict[str, Any]:
        if self.checkpoint_path:
            self.load_checkpoint()

        initial_boxes = build_initial_grid(region=region)
        logging.info(
            "Iniciando crawl región=%r con %d celdas raíz (zoom=%d, workers=%d, delay=%.3fs)...",
            region,
            len(initial_boxes),
            self.zoom,
            self.workers,
            self.delay_seconds,
        )

        run_start_ts = self._clock()
        try:
            if self.workers <= 1:
                for idx, root_bbox in enumerate(initial_boxes, start=1):
                    logging.info(
                        "Celda raíz %d/%d: %s (acumulado=%d antenas)",
                        idx,
                        len(initial_boxes),
                        format_bbox_key(root_bbox),
                        len(self.records_by_id),
                    )
                    self._crawl_bbox_recursive(root_bbox, depth=0, run_start_ts=run_start_ts)
            else:
                self._crawl_parallel(initial_boxes, run_start_ts=run_start_ts)
        finally:
            self._http_client.close_all()

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
            if isinstance(single.get("concesiones"), list):
                single["concesiones"] = [
                    dict(c) for c in single["concesiones"] if isinstance(c, dict)
                ]
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

        if all(isinstance(m.get("concesiones"), list) for m in sorted_members):
            combined_concs: list[dict[str, Any]] = []
            for member in sorted_members:
                for conc_item in member.get("concesiones") or []:
                    if isinstance(conc_item, dict):
                        combined_concs.append(conc_item)
            merged_rec["concesiones"] = summarize_concessions(combined_concs)
            if all(
                isinstance(m.get("bandsScannedAt"), str) and m.get("bandsScannedAt")
                for m in sorted_members
            ):
                merged_rec["bandsScannedAt"] = min(
                    _normalize_iso_utc(str(m["bandsScannedAt"])) for m in sorted_members
                )
            else:
                merged_rec.pop("bandsScannedAt", None)
        else:
            merged_rec.pop("concesiones", None)
            merged_rec.pop("bandsScannedAt", None)

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
            if isinstance(copied.get("concesiones"), list):
                copied["concesiones"] = [
                    dict(c) for c in copied["concesiones"] if isinstance(c, dict)
                ]
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


def format_exact_ministry_frequency(banda_raw: str) -> str:
    """
    Limpia espacios y devuelve exactamente el rango de frecuencias declarado en MINETUR
    sin abreviación ni redondeo (añadiendo `' MHz'` si la unidad no figura ya explícita).
    """
    cleaned = " ".join((banda_raw or "").split()).strip()
    if not cleaned:
        return ""
    upper = cleaned.upper()
    if "MHZ" not in upper and "GHZ" not in upper:
        return f"{cleaned} MHz"
    return cleaned


def _norm_freq_str(value: str) -> str:
    cleaned = " ".join(str(value or "").strip().split())
    if not cleaned:
        return ""
    m = FREQ_RANGE_RE.match(cleaned)
    if m:
        lo, hi = float(m.group(1)), float(m.group(2))
        if lo > hi:
            lo, hi = hi, lo
        return f"{_format_mhz(lo)} - {_format_mhz(hi)}"
    return cleaned.upper()


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


def summarize_concessions(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    """
    Deduplica y ordena concesiones individuales `{"ref": referencia_raw, "freq": banda_raw}`
    numéricamente por `(lo, hi, ref, freq)`.
    """
    deduped: dict[tuple[str, str], tuple[float, float]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        ref = " ".join(
            str(item.get("referencia", item.get("ref", "")) or "").split()
        ).strip()
        raw_freq = item.get(
            "frecuenciaDeclarada", item.get("freq", item.get("frecuencia", ""))
        )
        freq = " ".join(str(raw_freq or "").split()).strip()
        if not freq:
            continue
        if "minMhz" in item and "maxMhz" in item:
            lo = float(item["minMhz"])
            hi = float(item["maxMhz"])
        else:
            m = FREQ_RANGE_RE.match(freq)
            if m:
                lo, hi = float(m.group(1)), float(m.group(2))
            else:
                lo, hi = float("inf"), float("inf")
        if lo > hi:
            lo, hi = hi, lo
        key = (ref, freq)
        if key not in deduped:
            deduped[key] = (lo, hi)

    sorted_keys = sorted(
        deduped.items(),
        key=lambda kv: (kv[1][0], kv[1][1], kv[0][0], kv[0][1]),
    )
    return [{"ref": ref, "freq": freq} for (ref, freq), _ in sorted_keys]


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
                    "frecuenciaDeclarada": banda_raw,
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


def build_prior_antenna_index(
    prior_source: dict[str, Any] | list[dict[str, Any]] | Path | str | None,
) -> dict[str, Any]:
    """
    Construye el índice de antenas existentes del escaneo previo (`by_id` y `by_op_gid`
    incluyendo todos los `mergedGids`) para detección exacta de antenas y frecuencias nuevas.
    """
    if (
        isinstance(prior_source, dict)
        and "by_id" in prior_source
        and "by_op_gid" in prior_source
    ):
        return prior_source

    prior_records = _load_records_from_preserve_source(prior_source)
    by_id: dict[str, dict[str, Any]] = {}
    by_op_gid: dict[tuple[str, str], dict[str, Any]] = {}
    all_by_op_gid: dict[tuple[str, str], list[dict[str, Any]]] = {}

    for old_rec in prior_records:
        old_id = str(old_rec.get("id") or "").strip()
        old_op = str(old_rec.get("op") or "").strip()
        if old_id:
            by_id[old_id] = old_rec
        if old_op:
            for g in get_record_gids(old_rec):
                by_op_gid.setdefault((old_op, g), old_rec)
                all_by_op_gid.setdefault((old_op, g), []).append(old_rec)

    return {
        "by_id": by_id,
        "by_op_gid": by_op_gid,
        "all_by_op_gid": all_by_op_gid,
    }


def match_prior_antenna(
    rec: dict[str, Any],
    prior_index: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """
    Devuelve el registro previo correspondiente a `rec` casando por `rec["id"]` o por el
    primer `g` en `get_record_gids(rec)` con `(rec["op"], g)` en `by_op_gid`.
    """
    if not prior_index:
        return None
    by_id: dict[str, dict[str, Any]] = prior_index.get("by_id") or {}
    by_op_gid: dict[tuple[str, str], dict[str, Any]] = prior_index.get("by_op_gid") or {}

    rec_id = str(rec.get("id") or "").strip()
    if rec_id and rec_id in by_id:
        return by_id[rec_id]

    rec_op = str(rec.get("op") or "").strip()
    if rec_op:
        for g in get_record_gids(rec):
            cand = by_op_gid.get((rec_op, g))
            if cand is not None:
                return cand
    return None


def diff_new_antennas(
    records: list[dict[str, Any]],
    prior_source: dict[str, Any] | list[dict[str, Any]] | Path | str | None,
    scanned_at_iso: str | None = None,
) -> tuple[list[dict[str, Any]], set[str]]:
    """
    Compara `records` contra `prior_source` y devuelve `(novedades_antenas, new_antenna_ids)`.
    Si `prior_source` es `None`, no emite novedades de antenas.
    """
    if prior_source is None:
        return [], set()

    prior_index = build_prior_antenna_index(prior_source)
    scan_iso = _normalize_iso_utc(scanned_at_iso) if scanned_at_iso else _utc_now_iso()
    fecha_es = format_spain_datetime(scan_iso)

    novedades: list[dict[str, Any]] = []
    new_ids: set[str] = set()

    for rec in records:
        if match_prior_antenna(rec, prior_index) is not None:
            continue
        rec_id = str(rec.get("id") or "").strip()
        if not rec_id or rec_id in new_ids:
            continue
        new_ids.add(rec_id)
        mun = str(rec.get("mun") or "").strip()
        prov = str(rec.get("prov") or "").strip()
        novedades.append(
            {
                "id": f"ant:{rec_id}",
                "tipo": "antena",
                "op": rec["op"],
                "opRaw": rec["opRaw"],
                "codigo": rec["gid"],
                "antennaId": rec_id,
                "codigoBanda": "",
                "frecuencia": "",
                "ubicacion": mun or prov,
                "prov": prov,
                "scannedAt": scan_iso,
                "fecha": fecha_es,
            }
        )

    return novedades, new_ids


def preserve_bands_in_records(
    records: list[dict[str, Any]],
    preserve_from: dict[str, Any] | list[dict[str, Any]] | Path | str | None,
) -> int:
    """
    Reutiliza `bandas`, `frecuencias`, `concesiones` y `bandsScannedAt` ya extraídas
    en un dataset previo casando por `id` o `(op, gid)` (verificando que ningún
    `mergedGid` nuevo haya quedado sin cubrir).
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
        cand = by_id.get(rec_id)
        if cand is None and rec_op:
            for g in get_record_gids(rec):
                cand = by_op_gid.get((rec_op, g))
                if cand is not None:
                    break
        if cand is None:
            continue

        new_gids = set(get_record_gids(rec))
        old_gids = set(get_record_gids(cand))
        if new_gids and not new_gids.issubset(old_gids):
            continue

        rec["bandas"] = list(cand["bandas"])
        rec["frecuencias"] = list(cand.get("frecuencias") or [])
        if isinstance(cand.get("concesiones"), list):
            rec["concesiones"] = [
                dict(c) for c in cand["concesiones"] if isinstance(c, dict)
            ]
        if isinstance(cand.get("bandsScannedAt"), str) and cand.get("bandsScannedAt"):
            rec["bandsScannedAt"] = cand["bandsScannedAt"]
        restored += 1

    return restored


def _extract_record_concessions_for_gid(
    rec: dict[str, Any],
    entries: list[dict[str, Any]],
    records_at_gid: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Devuelve las filas de concesión (`referencia`, `frecuenciaDeclarada`, `frecuencia`,
    `minMhz`, `maxMhz`, `operador`) correspondientes al operador de `rec` en `gid`.
    """
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

    return [dict(e) for e in matched]


def _extract_record_ranges_for_gid(
    rec: dict[str, Any],
    entries: list[dict[str, Any]],
    records_at_gid: list[dict[str, Any]],
) -> list[tuple[float, float]]:
    matched = _extract_record_concessions_for_gid(rec, entries, records_at_gid)
    return [(float(e["minMhz"]), float(e["maxMhz"])) for e in matched]


def _diff_record_new_frequencies(
    rec: dict[str, Any],
    matched_entries: list[dict[str, Any]],
    fetched_iso: str,
    new_antenna_ids: set[str] | None = None,
    prior_index: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """
    Detecta concesiones/frecuencias nuevas en una antena existente que YA contaba con
    un escaneo previo de frecuencias (`concesiones` o `frecuencias` no nulos).
    Nunca emite falsos positivos para antenas nuevas ni para antenas antiguas aún sin escanear.
    """
    rec_id = str(rec.get("id") or "").strip()
    if not rec_id or not matched_entries:
        return []
    if new_antenna_ids and rec_id in new_antenna_ids:
        return []

    prior_conc: list[dict[str, Any]] | None = (
        rec["concesiones"] if isinstance(rec.get("concesiones"), list) else None
    )
    prior_freqs: list[str] | None = (
        rec["frecuencias"] if isinstance(rec.get("frecuencias"), list) else None
    )
    extra_prior_freq_norms: set[str] = set()

    if prior_conc is None and prior_freqs is None and prior_index is not None:
        matched_priors: list[dict[str, Any]] = []
        seen_prior_objs: set[int] = set()
        primary_old = match_prior_antenna(rec, prior_index)
        if primary_old is not None:
            seen_prior_objs.add(id(primary_old))
            matched_priors.append(primary_old)
        all_by_op_gid: dict[tuple[str, str], list[dict[str, Any]]] = (
            prior_index.get("all_by_op_gid") or {}
        )
        rec_op = str(rec.get("op") or "").strip()
        if rec_op:
            for g in get_record_gids(rec):
                for cand in all_by_op_gid.get((rec_op, g), ()):
                    if id(cand) not in seen_prior_objs:
                        seen_prior_objs.add(id(cand))
                        matched_priors.append(cand)

        conc_acc: list[dict[str, Any]] = []
        freq_acc: list[str] = []
        any_conc = False
        any_freq = False
        for old_rec in matched_priors:
            if isinstance(old_rec.get("concesiones"), list):
                any_conc = True
                conc_acc.extend(
                    c for c in old_rec["concesiones"] if isinstance(c, dict)
                )
            elif isinstance(old_rec.get("frecuencias"), list):
                any_freq = True
                for f_str in old_rec["frecuencias"]:
                    if isinstance(f_str, str):
                        freq_acc.append(f_str)
                        extra_prior_freq_norms.add(_norm_freq_str(f_str))

        if any_conc:
            prior_conc = conc_acc
        elif any_freq:
            prior_freqs = freq_acc

    # CRÍTICO: solo emitir novedades si la antena existente ya tenía un escaneo previo
    if not isinstance(prior_conc, list) and not isinstance(prior_freqs, list):
        return []

    scan_iso = _normalize_iso_utc(fetched_iso)
    fecha_es = format_spain_datetime(scan_iso)
    mun = str(rec.get("mun") or "").strip()
    prov = str(rec.get("prov") or "").strip()
    ubicacion = mun or prov

    emitted: list[dict[str, Any]] = []
    seen_new_keys: set[tuple[str, str, str]] = set()

    if isinstance(prior_conc, list):
        prior_pairs: set[tuple[str, str]] = set()
        prior_freq_only: set[str] = set(extra_prior_freq_norms)
        for c in prior_conc:
            if not isinstance(c, dict):
                continue
            c_ref = " ".join(str(c.get("ref") or "").split()).strip()
            c_freq_norm = _norm_freq_str(str(c.get("freq") or ""))
            if c_freq_norm:
                prior_pairs.add((c_ref, c_freq_norm))
                prior_freq_only.add(c_freq_norm)

        for entry in matched_entries:
            ref = " ".join(str(entry.get("referencia") or "").split()).strip()
            banda_raw = " ".join(
                str(
                    entry.get("frecuenciaDeclarada")
                    or entry.get("frecuencia")
                    or ""
                ).split()
            ).strip()
            freq_clean = _norm_freq_str(
                str(entry.get("frecuencia") or banda_raw)
            )
            if not banda_raw or not freq_clean:
                continue
            if (ref, freq_clean) in prior_pairs:
                continue
            if ref == "" and freq_clean in prior_freq_only:
                continue
            if freq_clean in extra_prior_freq_norms:
                continue

            dedup_key = (rec_id, ref, banda_raw)
            if dedup_key in seen_new_keys:
                continue
            seen_new_keys.add(dedup_key)

            op_raw_entry = " ".join(str(entry.get("operador") or "").split()).strip()
            emitted.append(
                {
                    "id": f"freq:{rec_id}:{ref}:{banda_raw}",
                    "tipo": "frecuencia",
                    "op": rec["op"],
                    "opRaw": op_raw_entry or rec["opRaw"],
                    "codigo": rec["gid"],
                    "antennaId": rec_id,
                    "codigoBanda": ref,
                    "frecuencia": format_exact_ministry_frequency(banda_raw),
                    "ubicacion": ubicacion,
                    "prov": prov,
                    "scannedAt": scan_iso,
                    "fecha": fecha_es,
                }
            )
    elif isinstance(prior_freqs, list):
        prior_freq_set = {
            _norm_freq_str(f) for f in prior_freqs if isinstance(f, str) and f.strip()
        }
        for entry in matched_entries:
            ref = " ".join(str(entry.get("referencia") or "").split()).strip()
            banda_raw = " ".join(
                str(
                    entry.get("frecuenciaDeclarada")
                    or entry.get("frecuencia")
                    or ""
                ).split()
            ).strip()
            freq_clean = _norm_freq_str(
                str(entry.get("frecuencia") or banda_raw)
            )
            if not banda_raw or not freq_clean:
                continue
            if freq_clean in prior_freq_set:
                continue

            dedup_key = (rec_id, ref, banda_raw)
            if dedup_key in seen_new_keys:
                continue
            seen_new_keys.add(dedup_key)

            op_raw_entry = " ".join(str(entry.get("operador") or "").split()).strip()
            emitted.append(
                {
                    "id": f"freq:{rec_id}:{ref}:{banda_raw}",
                    "tipo": "frecuencia",
                    "op": rec["op"],
                    "opRaw": op_raw_entry or rec["opRaw"],
                    "codigo": rec["gid"],
                    "antennaId": rec_id,
                    "codigoBanda": ref,
                    "frecuencia": format_exact_ministry_frequency(banda_raw),
                    "ubicacion": ubicacion,
                    "prov": prov,
                    "scannedAt": scan_iso,
                    "fecha": fecha_es,
                }
            )

    return emitted


def _novedad_sort_key(item: dict[str, Any]) -> tuple[float, str, str, str]:
    scanned_at = str(item.get("scannedAt") or "")
    try:
        ts = _parse_utc_datetime(scanned_at).timestamp()
    except ValueError:
        ts = 0.0
    return (
        -ts,
        str(item.get("tipo") or ""),
        str(item.get("codigo") or ""),
        str(item.get("id") or ""),
    )


def load_novedades_dataset(path: Path | str | None) -> dict[str, Any] | None:
    """Carga un `NovedadesDataset` existente desde disco si es válido."""
    if path is None:
        return None
    target = Path(path)
    if not target.exists():
        return None
    try:
        loaded = json.loads(target.read_text(encoding="utf-8"))
        if isinstance(loaded, dict) and isinstance(loaded.get("novedades"), list):
            return loaded
    except Exception as exc:
        logging.warning("No se pudo leer novedades previas en %s: %s", target, exc)
    return None


def build_novedades_dataset(
    novedades: list[dict[str, Any]],
    *,
    scan_id: str = "",
    previous_scan_at: str | None = None,
    updated_at: str | None = None,
    is_baseline_scan: bool = False,
) -> dict[str, Any]:
    """
    Construye un `NovedadesDataset` compatible al 100% con `src/types/antena.ts`,
    deduplicado por `id` y ordenado con las novedades más recientes primero.
    """
    ts = _normalize_iso_utc(updated_at) if updated_at else _utc_now_iso()
    effective_scan_id = str(scan_id or "").strip() or f"scan-{ts}"

    if is_baseline_scan:
        return {
            "updatedAt": ts,
            "scanId": effective_scan_id,
            "previousScanAt": previous_scan_at,
            "isBaselineScan": True,
            "total": 0,
            "antenasNuevas": 0,
            "frecuenciasNuevas": 0,
            "novedades": [],
        }

    deduped_by_id: dict[str, dict[str, Any]] = {}
    for item in novedades:
        if not isinstance(item, dict):
            continue
        nov_id = str(item.get("id") or "").strip()
        if not nov_id:
            continue
        deduped_by_id[nov_id] = dict(item)

    sorted_items = sorted(deduped_by_id.values(), key=_novedad_sort_key)
    antenas_nuevas = sum(1 for n in sorted_items if n.get("tipo") == "antena")
    frecuencias_nuevas = sum(1 for n in sorted_items if n.get("tipo") == "frecuencia")

    return {
        "updatedAt": ts,
        "scanId": effective_scan_id,
        "previousScanAt": previous_scan_at,
        "isBaselineScan": False,
        "total": len(sorted_items),
        "antenasNuevas": antenas_nuevas,
        "frecuenciasNuevas": frecuencias_nuevas,
        "novedades": sorted_items,
    }


def write_novedades_dataset(
    novedades_dataset: dict[str, Any], output_path: Path
) -> int:
    """Escribe `novedades_dataset` en JSON UTF-8 de forma atómica."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(output_path.name + ".tmp")
    encoded = json.dumps(
        novedades_dataset, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    tmp_path.write_bytes(encoded)
    os.replace(tmp_path, output_path)
    return len(encoded)


_LIVE_CHUNK_RE = re.compile(r"^live-chunk-(\d+)\.json$")


class LiveDeltaStreamWriter:
    """
    Emisor atómico en tiempo real de lotes incrementales (`live-chunk-{k}.json` + `live-tail.json`)
    para sincronización instantánea con el mapa interactivo y la pestaña Novedades.
    """

    def __init__(
        self,
        live_dir: Path | str,
        *,
        scan_id: str,
        mode: str = "reset",
        record_novedades: bool = True,
        previous_scan_at: str | None = None,
        chunk_capacity: int = LIVE_DELTA_CHUNK_CAPACITY,
        flush_interval_seconds: float = 1.0,
        clock_fn: Callable[[], float] = time.monotonic,
        now_utc_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self.live_dir = Path(live_dir)
        self.live_dir.mkdir(parents=True, exist_ok=True)
        self.scan_id = str(scan_id or "").strip()
        self.mode = mode if mode in ("reset", "append") else "reset"
        self.record_novedades = bool(record_novedades)
        self.previous_scan_at = previous_scan_at
        self.chunk_capacity = max(1, int(chunk_capacity))
        self.flush_interval_seconds = max(0.0, float(flush_interval_seconds))
        self._clock = clock_fn
        self._now_utc = now_utc_fn

        self.chunk_count: int = 0
        self.delta_seq: int = 0
        self._seen_new_antenna_ids: set[str] = set()
        self._seen_updated_antenna_ids: set[str] = set()
        self._seen_novedad_ids: set[str] = set()

        self._tail_new_antennas: dict[str, dict[str, Any]] = {}
        self._tail_band_patches: dict[str, dict[str, Any]] = {}
        self._tail_novedades: dict[str, dict[str, Any]] = {}
        self._tail_replaces_new_antennas: bool = False
        self._had_provisional_items: bool = False
        self._chunk_just_sealed: bool = False
        self._dirty: bool = False
        self._last_flush_ts: float | None = None

        if self.mode == "reset":
            self._clean_existing_files()
        else:
            self._load_existing_append_state()

    @property
    def total_new_antennas(self) -> int:
        return len(self._seen_new_antenna_ids)

    @property
    def total_updated_antennas(self) -> int:
        return len(self._seen_updated_antenna_ids)

    @property
    def total_novedades(self) -> int:
        return len(self._seen_novedad_ids)

    @property
    def seen_new_antenna_ids(self) -> set[str]:
        return set(self._seen_new_antenna_ids)

    def _clean_existing_files(self) -> None:
        for entry in self.live_dir.iterdir():
            if not entry.is_file():
                continue
            name = entry.name
            if (
                name == "live-tail.json"
                or _LIVE_CHUNK_RE.match(name)
                or (name.startswith("live-") and name.endswith(".tmp"))
            ):
                try:
                    entry.unlink()
                except OSError:
                    pass

    def _ingest_saved_doc_stats(self, doc: dict[str, Any]) -> None:
        if doc.get("replacesNewAntennas"):
            self._seen_new_antenna_ids.clear()
            self._seen_novedad_ids = {
                nid for nid in self._seen_novedad_ids if not nid.startswith("ant:")
            }
        for ant in doc.get("newAntennas") or ():
            if isinstance(ant, dict) and ant.get("id"):
                self._seen_new_antenna_ids.add(str(ant["id"]))
        for patch in doc.get("bandPatches") or ():
            if isinstance(patch, dict) and patch.get("id"):
                self._seen_updated_antenna_ids.add(str(patch["id"]))
        if self.record_novedades:
            for nov in doc.get("novedades") or ():
                if isinstance(nov, dict) and nov.get("id"):
                    self._seen_novedad_ids.add(str(nov["id"]))

    def _load_existing_append_state(self) -> None:
        chunk_files: list[tuple[int, Path]] = []
        for entry in self.live_dir.iterdir():
            if not entry.is_file():
                continue
            m = _LIVE_CHUNK_RE.match(entry.name)
            if m:
                chunk_files.append((int(m.group(1)), entry))
        chunk_files.sort(key=lambda item: item[0])

        for idx, cpath in chunk_files:
            try:
                doc = json.loads(cpath.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(doc, dict):
                continue
            if self.scan_id and str(doc.get("scanId") or "") != self.scan_id:
                self._clean_existing_files()
                return
            self.chunk_count = max(self.chunk_count, idx + 1)
            self.delta_seq = max(self.delta_seq, int(doc.get("seq") or 0))
            if self.previous_scan_at is None and isinstance(doc.get("previousScanAt"), str):
                self.previous_scan_at = doc["previousScanAt"]
            self._ingest_saved_doc_stats(doc)

        tail_path = self.live_dir / "live-tail.json"
        if tail_path.exists():
            try:
                tdoc = json.loads(tail_path.read_text(encoding="utf-8"))
            except Exception:
                tdoc = None
            if isinstance(tdoc, dict):
                if self.scan_id and str(tdoc.get("scanId") or "") != self.scan_id:
                    self._clean_existing_files()
                    return
                self.delta_seq = max(self.delta_seq, int(tdoc.get("seq") or 0))
                if self.previous_scan_at is None and isinstance(
                    tdoc.get("previousScanAt"), str
                ):
                    self.previous_scan_at = tdoc["previousScanAt"]
                self._ingest_saved_doc_stats(tdoc)
                self._tail_replaces_new_antennas = bool(tdoc.get("replacesNewAntennas"))
                for ant in tdoc.get("newAntennas") or ():
                    if isinstance(ant, dict) and ant.get("id"):
                        self._tail_new_antennas[str(ant["id"])] = dict(ant)
                for patch in tdoc.get("bandPatches") or ():
                    if isinstance(patch, dict) and patch.get("id"):
                        self._tail_band_patches[str(patch["id"])] = dict(patch)
                if self.record_novedades:
                    for nov in tdoc.get("novedades") or ():
                        if isinstance(nov, dict) and nov.get("id"):
                            self._tail_novedades[str(nov["id"])] = dict(nov)

        status_path = self.live_dir / "scan-status.json"
        if status_path.exists():
            try:
                sdoc = json.loads(status_path.read_text(encoding="utf-8"))
                if isinstance(sdoc, dict) and (
                    not self.scan_id or str(sdoc.get("scanId") or "") == self.scan_id
                ):
                    self.delta_seq = max(self.delta_seq, int(sdoc.get("deltaSeq") or 0))
                    self.chunk_count = max(
                        self.chunk_count, int(sdoc.get("chunkCount") or 0)
                    )
            except Exception:
                pass

    def _tail_item_count(self) -> int:
        return (
            len(self._tail_new_antennas)
            + len(self._tail_band_patches)
            + len(self._tail_novedades)
        )

    def _build_chunk_payload(self, *, chunk_index: int, is_tail: bool) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "scanId": self.scan_id,
            "seq": self.delta_seq,
            "chunkIndex": chunk_index,
            "isTail": is_tail,
            "updatedAt": _utc_now_iso(self._now_utc),
            "recordNovedades": self.record_novedades,
            "previousScanAt": self.previous_scan_at,
            "replacesNewAntennas": self._tail_replaces_new_antennas,
            "newAntennas": list(self._tail_new_antennas.values()),
            "bandPatches": list(self._tail_band_patches.values()),
            "novedades": (
                list(self._tail_novedades.values()) if self.record_novedades else []
            ),
        }

    @staticmethod
    def _write_atomic(payload: dict[str, Any], target_path: Path) -> None:
        target_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = target_path.with_name(target_path.name + ".tmp")
        encoded = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        tmp_path.write_bytes(encoded)
        os.replace(tmp_path, target_path)

    def _seal_current_tail_as_chunk(self) -> None:
        self.delta_seq += 1
        chunk_idx = self.chunk_count
        payload = self._build_chunk_payload(chunk_index=chunk_idx, is_tail=False)
        self._write_atomic(payload, self.live_dir / f"live-chunk-{chunk_idx}.json")
        self.chunk_count += 1
        self._tail_new_antennas.clear()
        self._tail_band_patches.clear()
        self._tail_novedades.clear()
        self._tail_replaces_new_antennas = False
        self._chunk_just_sealed = True
        self._dirty = False

    def _write_tail_file(self, *, bump_seq: bool) -> None:
        if bump_seq:
            self.delta_seq += 1
        payload = self._build_chunk_payload(
            chunk_index=self.chunk_count,
            is_tail=True,
        )
        self._write_atomic(payload, self.live_dir / "live-tail.json")
        self._dirty = False
        self._chunk_just_sealed = False
        self._last_flush_ts = self._clock()

    def _insert_new_antenna(self, ant: dict[str, Any]) -> None:
        ant_id = str(ant.get("id") or "").strip()
        if not ant_id:
            return
        self._seen_new_antenna_ids.add(ant_id)
        self._tail_new_antennas[ant_id] = dict(ant)
        self._dirty = True
        if self._tail_item_count() >= self.chunk_capacity:
            self._seal_current_tail_as_chunk()

    def _insert_band_patch(self, patch: dict[str, Any]) -> None:
        ant_id = str(patch.get("id") or "").strip()
        if not ant_id:
            return
        self._seen_updated_antenna_ids.add(ant_id)
        self._tail_band_patches[ant_id] = dict(patch)
        self._dirty = True
        if self._tail_item_count() >= self.chunk_capacity:
            self._seal_current_tail_as_chunk()

    def _insert_novedad(self, nov: dict[str, Any]) -> None:
        if not self.record_novedades:
            return
        nov_id = str(nov.get("id") or "").strip()
        if not nov_id:
            return
        self._seen_novedad_ids.add(nov_id)
        self._tail_novedades[nov_id] = dict(nov)
        self._dirty = True
        if self._tail_item_count() >= self.chunk_capacity:
            self._seal_current_tail_as_chunk()

    def _maybe_flush_after_insert(
        self,
        *,
        force_flush: bool,
        urgent: bool,
    ) -> bool:
        if self._chunk_just_sealed:
            self._write_tail_file(bump_seq=self._dirty)
            return True
        if not self._dirty:
            return False
        now = self._clock()
        if (
            force_flush
            or urgent
            or self._last_flush_ts is None
            or (now - self._last_flush_ts) >= self.flush_interval_seconds
        ):
            self._write_tail_file(bump_seq=True)
            return True
        return False

    def record_provisional_new_antennas(
        self,
        antennas: list[dict[str, Any]],
        novedades: list[dict[str, Any]],
    ) -> bool:
        if not antennas and (not novedades or not self.record_novedades):
            return False
        self._had_provisional_items = True
        nov_by_ant_id: dict[str, dict[str, Any]] = {}
        if self.record_novedades:
            for nov in novedades:
                if isinstance(nov, dict) and nov.get("antennaId"):
                    nov_by_ant_id[str(nov["antennaId"])] = nov

        emitted_nov_ids: set[str] = set()
        for ant in antennas:
            if not isinstance(ant, dict):
                continue
            self._insert_new_antenna(ant)
            aid = str(ant.get("id") or "")
            if aid in nov_by_ant_id:
                nov_item = nov_by_ant_id[aid]
                emitted_nov_ids.add(str(nov_item.get("id") or ""))
                self._insert_novedad(nov_item)

        if self.record_novedades:
            for nov in novedades:
                if isinstance(nov, dict) and str(nov.get("id") or "") not in emitted_nov_ids:
                    self._insert_novedad(nov)

        return self._maybe_flush_after_insert(force_flush=False, urgent=True)

    def reconcile_post_census_new_antennas(
        self,
        canonical_new_antennas: list[dict[str, Any]],
        canonical_ant_novedades: list[dict[str, Any]],
    ) -> bool:
        eff_novs = canonical_ant_novedades if self.record_novedades else []
        if (
            not self._had_provisional_items
            and not canonical_new_antennas
            and not eff_novs
        ):
            return False

        # Reconciliar contadores acumulados tras la fusión espacial de Vodafone (< 35 m)
        self._seen_new_antenna_ids.clear()
        self._seen_novedad_ids = {
            nid for nid in self._seen_novedad_ids if not nid.startswith("ant:")
        }
        self._tail_new_antennas.clear()
        self._tail_novedades = {
            nid: nov
            for nid, nov in self._tail_novedades.items()
            if not nid.startswith("ant:")
        }
        self._tail_replaces_new_antennas = True
        self._dirty = True

        nov_by_ant_id: dict[str, dict[str, Any]] = {}
        for nov in eff_novs:
            if isinstance(nov, dict) and nov.get("antennaId"):
                nov_by_ant_id[str(nov["antennaId"])] = nov

        emitted_nov_ids: set[str] = set()
        for ant in canonical_new_antennas:
            if not isinstance(ant, dict):
                continue
            self._insert_new_antenna(ant)
            aid = str(ant.get("id") or "")
            if aid in nov_by_ant_id:
                nov_item = nov_by_ant_id[aid]
                emitted_nov_ids.add(str(nov_item.get("id") or ""))
                self._insert_novedad(nov_item)

        for nov in eff_novs:
            if isinstance(nov, dict) and str(nov.get("id") or "") not in emitted_nov_ids:
                self._insert_novedad(nov)

        return self._maybe_flush_after_insert(force_flush=True, urgent=True)

    def record_band_updates(
        self,
        patches: list[dict[str, Any]],
        freq_novedades: list[dict[str, Any]],
        *,
        force_flush: bool = False,
    ) -> bool:
        eff_novs = freq_novedades if self.record_novedades else []
        if not patches and not eff_novs:
            if force_flush and self._dirty:
                self._write_tail_file(bump_seq=True)
                return True
            return False

        for patch in patches:
            if isinstance(patch, dict):
                self._insert_band_patch(patch)
        for nov in eff_novs:
            if isinstance(nov, dict):
                self._insert_novedad(nov)

        return self._maybe_flush_after_insert(
            force_flush=force_flush,
            urgent=bool(eff_novs),
        )

    def flush_final(self) -> bool:
        tail_path = self.live_dir / "live-tail.json"
        if self._chunk_just_sealed or self._dirty:
            self._write_tail_file(bump_seq=self._dirty)
            return True
        if not tail_path.exists():
            self._write_tail_file(bump_seq=False)
            return True
        return False


class BandEnricher:
    """
    Motor incremental y de re-escaneo diario de bandas y concesiones desde `detalleEstacion.do`
    con soporte Keep-Alive paralelo de alto rendimiento y emisión en tiempo real de deltas RF.
    """

    def __init__(
        self,
        delay_seconds: float = DEFAULT_DELAY_SECONDS,
        max_band_seconds: float | None = None,
        max_band_requests: int | None = None,
        checkpoint_path: Path | None = None,
        checkpoint_every: int = DEFAULT_BAND_CHECKPOINT_EVERY,
        timeout_seconds: float = 30.0,
        workers: int = 1,
        fail_fast: bool = False,
        rescan_since: str | None = None,
        new_antenna_ids: set[str] | None = None,
        prior_index: dict[str, Any] | None = None,
        record_novedades: bool = True,
        novedades_checkpoint_fn: Callable[[list[dict[str, Any]]], None] | None = None,
        live_stream: LiveDeltaStreamWriter | None = None,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
        fetch_fn: Callable[[str], str | bytes] | None = None,
        sleep_fn: Callable[[float], None] = time.sleep,
        clock_fn: Callable[[], float] = time.monotonic,
        now_utc_fn: Callable[[], datetime] | None = None,
    ) -> None:
        self.delay_seconds = max(0.0, float(delay_seconds))
        self.max_band_seconds = (
            float(max_band_seconds) if max_band_seconds is not None else None
        )
        self.max_band_requests = (
            int(max_band_requests) if max_band_requests is not None else None
        )
        self.checkpoint_path = checkpoint_path
        self.checkpoint_every = max(1, int(checkpoint_every))
        self.timeout_seconds = float(timeout_seconds)
        self.workers = max(1, int(workers))
        self.fail_fast = bool(fail_fast)
        self.rescan_since = (
            _normalize_iso_utc(rescan_since) if rescan_since else None
        )
        self.new_antenna_ids: set[str] = set(new_antenna_ids or ())
        self.prior_index = prior_index
        self.record_novedades = bool(record_novedades)
        self._novedades_checkpoint_fn = novedades_checkpoint_fn
        self._live_stream = live_stream
        self._progress_callback = progress_callback
        self._custom_fetch_fn = fetch_fn
        self._sleep = sleep_fn
        self._clock = clock_fn
        self._now_utc = now_utc_fn

        self._http_client = _ThreadLocalKeepAliveClient()
        self._stats_lock = threading.Lock()
        self._worker_tls = threading.local()

        self.requests_count: int = 0
        self.failed_gids_count: int = 0
        self.last_requests_per_second: float = 0.0
        self.last_scanned_antennas: int = 0
        self.last_total_antennas: int = 0
        self.discovered_novedades: list[dict[str, Any]] = []
        self._seen_novedad_ids: set[str] = set()
        self._last_request_ts: float | None = None
        self._unsaved_requests: int = 0

    def _needs_band_scan(self, rec: dict[str, Any]) -> bool:
        if not isinstance(rec.get("bandas"), list) or not isinstance(
            rec.get("concesiones"), list
        ):
            return True
        if self.rescan_since:
            scanned_at = _normalize_iso_utc(str(rec.get("bandsScannedAt") or ""))
            if not scanned_at or scanned_at < self.rescan_since:
                return True
        return False

    def _record_priority_tier_and_age(
        self, antenas: list[dict[str, Any]], idxs: list[int]
    ) -> tuple[int, str]:
        if any(
            str(antenas[i].get("id") or "") in self.new_antenna_ids for i in idxs
        ):
            return (0, "")
        if any(
            not isinstance(antenas[i].get("bandas"), list)
            or not isinstance(antenas[i].get("concesiones"), list)
            for i in idxs
        ):
            return (1, "")
        oldest_scanned = min(
            _normalize_iso_utc(str(antenas[i].get("bandsScannedAt") or ""))
            for i in idxs
        )
        return (2, oldest_scanned)

    def _wait_rate_limit(self) -> None:
        if self._last_request_ts is not None and self.delay_seconds > 0:
            elapsed = self._clock() - self._last_request_ts
            remaining = self.delay_seconds - elapsed
            if remaining > 0:
                self._sleep(remaining)

    def _wait_worker_rate_limit(self) -> None:
        self._http_client.wait_if_cooled_down(self._clock, self._sleep)
        last_ts: float | None = getattr(self._worker_tls, "last_req_ts", None)
        if last_ts is not None and self.delay_seconds > 0:
            elapsed = self._clock() - last_ts
            remaining = self.delay_seconds - elapsed
            if remaining > 0:
                self._sleep(remaining)

    def _would_exceed_time_budget(
        self,
        run_start_ts: float,
        *,
        parallel_mode: bool = False,
    ) -> bool:
        if self.max_band_seconds is None:
            return False
        now = self._clock()
        wait_needed = 0.0
        if not parallel_mode and self._last_request_ts is not None and self.delay_seconds > 0:
            wait_needed = max(0.0, self.delay_seconds - (now - self._last_request_ts))
        return (now + wait_needed - run_start_ts) >= self.max_band_seconds

    def _http_fetch_detalle(
        self,
        gid: str,
        *,
        parallel_mode: bool = False,
    ) -> list[dict[str, Any]]:
        url = build_detalle_estacion_url(gid)
        backoffs = (2.0, 4.0, 8.0)
        last_err: Exception | None = None
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) WebDeAntenasSpainCrawler/1.0"
            ),
            "Accept": "text/html,application/xhtml+xml,*/*",
        }

        for attempt in range(len(backoffs)):
            if parallel_mode:
                self._wait_worker_rate_limit()
                with self._stats_lock:
                    self.requests_count += 1
                    self._unsaved_requests += 1
            else:
                self._wait_rate_limit()
                self.requests_count += 1
                self._unsaved_requests += 1

            if self._custom_fetch_fn is not None:
                try:
                    payload = self._custom_fetch_fn(gid)
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    html = (
                        decode_detalle_estacion_payload(payload)
                        if isinstance(payload, (bytes, bytearray))
                        else str(payload)
                    )
                    return parse_detalle_estacion_html(html)
                except Exception as exc:
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    last_err = exc
            else:
                try:
                    raw_bytes = self._http_client.fetch_bytes(
                        url,
                        headers=headers,
                        timeout=self.timeout_seconds,
                        clock_fn=self._clock,
                    )
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    html = decode_detalle_estacion_payload(raw_bytes)
                    if not html.strip():
                        raise ValueError("Respuesta HTML vacía desde detalleEstacion.do")
                    return parse_detalle_estacion_html(html)
                except (
                    urllib.error.HTTPError,
                    urllib.error.URLError,
                    TimeoutError,
                    http.client.HTTPException,
                    ssl.SSLError,
                    OSError,
                    UnicodeDecodeError,
                    ValueError,
                ) as exc:
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
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

    def _save_dataset_checkpoint(
        self,
        dataset: dict[str, Any],
        *,
        populated_count: int | None = None,
    ) -> None:
        antenas = dataset.get("antenas") or []
        crawl_stats = dataset.setdefault("crawlStats", {})
        crawl_stats["bandsPopulatedCount"] = (
            int(populated_count)
            if populated_count is not None
            else count_bands_populated(antenas)
        )
        crawl_stats["bandRequestsCount"] = self.requests_count
        dataset["updatedAt"] = _utc_now_iso(self._now_utc)
        if self.checkpoint_path is not None:
            write_compact_dataset(dataset, self.checkpoint_path)
        if self._novedades_checkpoint_fn is not None:
            self._novedades_checkpoint_fn(self.discovered_novedades)
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

        raw_candidates: list[
            tuple[int, str, float, str, int, str, tuple[str, ...], list[str]]
        ] = []
        for gid, idxs in single_gid_groups.items():
            tier, oldest_scanned = self._record_priority_tier_and_age(antenas, idxs)
            gain = float(len(idxs))
            first_rec = antenas[idxs[0]]
            prov = str(first_rec.get("prov") or "")
            op_sig = tuple(sorted({str(antenas[i].get("op") or "") for i in idxs}))
            raw_candidates.append(
                (
                    tier,
                    oldest_scanned,
                    gain,
                    prov,
                    prov_totals.get(prov, 0),
                    gid,
                    op_sig,
                    [gid],
                )
            )

        for idx, gids in multi_gid_units:
            tier, oldest_scanned = self._record_priority_tier_and_age(antenas, [idx])
            rec = antenas[idx]
            prov = str(rec.get("prov") or "")
            op_sig = (str(rec.get("op") or ""),)
            ratio = 1.0 / float(len(gids))
            raw_candidates.append(
                (
                    tier,
                    oldest_scanned,
                    ratio,
                    prov,
                    prov_totals.get(prov, 0),
                    gids[0],
                    op_sig,
                    gids,
                )
            )

        # Orden base:
        #   1) Antenas nuevas (tier=0) primero,
        #   2) Antenas nunca escaneadas con concesiones (tier=1),
        #   3) Antenas existentes pendientes de re-escaneo (tier=2), más antiguas primero,
        # desempatando por mayor ratio antenas/petición, MADRID y volumen provincial.
        raw_candidates.sort(
            key=lambda item: (
                item[0],
                item[1],
                -item[2],
                0 if item[3] == "MADRID" else 1,
                -item[4],
                item[3],
                item[5],
            )
        )

        # Entre emplazamientos compartidos (ratio >= 2.0) dentro del mismo tier/edad,
        # adelantar el primer ejemplar de cada combinación de operadores.
        seen_shared_op_sigs: set[tuple[int, tuple[str, ...]]] = set()
        final_keyed: list[
            tuple[int, str, float, int, int, int, str, str, list[str]]
        ] = []
        for (
            tier,
            oldest_scanned,
            ratio,
            prov,
            prov_cnt,
            gid,
            op_sig,
            gids,
        ) in raw_candidates:
            first_of_sig = 1
            if ratio >= 2.0 and (tier, op_sig) not in seen_shared_op_sigs:
                seen_shared_op_sigs.add((tier, op_sig))
                first_of_sig = 0
            final_keyed.append(
                (
                    tier,
                    oldest_scanned,
                    -ratio,
                    first_of_sig,
                    0 if prov == "MADRID" else 1,
                    -prov_cnt,
                    prov,
                    gid,
                    gids,
                )
            )

        final_keyed.sort(key=lambda item: item[:8])
        return [item[8] for item in final_keyed]

    def _apply_completed_gid(
        self,
        gid: str,
        fetched_iso: str,
        *,
        antenas: list[dict[str, Any]],
        pending_by_gid: dict[str, list[int]],
        completed_pending_indices: set[int],
        gid_entries_cache: dict[str, list[dict[str, Any]]],
        all_records_per_gid: dict[str, list[dict[str, Any]]],
        batch_patches: list[dict[str, Any]],
        batch_freq_novs: list[dict[str, Any]],
    ) -> tuple[int, int]:
        """
        Actualiza todas las antenas pendientes de `gid` cuyos GIDs asociados ya están en caché.
        Devuelve `(newly_populated_delta, populated_count_delta)` en O(1).
        """
        newly_delta = 0
        populated_delta = 0

        for rec_idx in pending_by_gid.get(gid, ()):
            if rec_idx in completed_pending_indices:
                continue
            rec = antenas[rec_idx]
            rec_gids = get_record_gids(rec)
            if not all(g in gid_entries_cache for g in rec_gids):
                continue

            completed_pending_indices.add(rec_idx)
            matched_entries: list[dict[str, Any]] = []
            for rg in rec_gids:
                matched_entries.extend(
                    _extract_record_concessions_for_gid(
                        rec,
                        gid_entries_cache[rg],
                        all_records_per_gid.get(rg, [rec]),
                    )
                )

            was_bandas_list = isinstance(rec.get("bandas"), list)
            had_prior_bands = was_bandas_list
            old_bandas = rec.get("bandas") if was_bandas_list else None
            old_freqs = (
                rec.get("frecuencias")
                if isinstance(rec.get("frecuencias"), list)
                else None
            )
            old_concs = (
                rec.get("concesiones")
                if isinstance(rec.get("concesiones"), list)
                else None
            )

            if not had_prior_bands and self.prior_index is not None:
                prior_rec = match_prior_antenna(rec, self.prior_index)
                if prior_rec is not None and isinstance(prior_rec.get("bandas"), list):
                    had_prior_bands = True
                    old_bandas = prior_rec.get("bandas")
                    old_freqs = (
                        prior_rec.get("frecuencias")
                        if isinstance(prior_rec.get("frecuencias"), list)
                        else []
                    )
                    old_concs = (
                        prior_rec.get("concesiones")
                        if isinstance(prior_rec.get("concesiones"), list)
                        else None
                    )

            new_freq_novs: list[dict[str, Any]] = []
            if self.record_novedades:
                new_freq_novs = _diff_record_new_frequencies(
                    rec,
                    matched_entries,
                    fetched_iso=fetched_iso,
                    new_antenna_ids=self.new_antenna_ids,
                    prior_index=self.prior_index,
                )
                for nov in new_freq_novs:
                    nov_id = nov["id"]
                    if nov_id not in self._seen_novedad_ids:
                        self._seen_novedad_ids.add(nov_id)
                        self.discovered_novedades.append(nov)

            combined_ranges = [
                (float(e["minMhz"]), float(e["maxMhz"]))
                for e in matched_entries
            ]
            bandas_sorted, freqs_sorted = summarize_frequency_ranges(combined_ranges)
            concs_sorted = summarize_concessions(matched_entries)

            if not was_bandas_list:
                populated_delta += 1
            rec["bandas"] = bandas_sorted
            rec["frecuencias"] = freqs_sorted
            rec["concesiones"] = concs_sorted
            rec["bandsScannedAt"] = fetched_iso
            newly_delta += 1

            if self._live_stream is not None:
                rf_changed = (
                    (not had_prior_bands)
                    or (old_bandas != bandas_sorted)
                    or (old_freqs != freqs_sorted)
                    or (old_concs != concs_sorted)
                    or (rec["id"] in self.new_antenna_ids)
                    or bool(new_freq_novs)
                )
                if rf_changed:
                    patch: dict[str, Any] = {
                        "id": rec["id"],
                        "gid": rec["gid"],
                        "bandas": bandas_sorted,
                        "frecuencias": freqs_sorted,
                        "concesiones": concs_sorted,
                        "bandsScannedAt": fetched_iso,
                    }
                    merged_gids = rec.get("mergedGids")
                    if isinstance(merged_gids, list) and merged_gids:
                        patch["mergedGids"] = list(merged_gids)
                    batch_patches.append(patch)
                if new_freq_novs:
                    batch_freq_novs.extend(new_freq_novs)

        return newly_delta, populated_delta

    def enrich_dataset(self, dataset: dict[str, Any]) -> dict[str, Any]:
        antenas: list[dict[str, Any]] = dataset.get("antenas") or []
        crawl_stats = dataset.setdefault("crawlStats", {})

        all_records_per_gid: dict[str, list[dict[str, Any]]] = {}
        for rec in antenas:
            for g in get_record_gids(rec):
                all_records_per_gid.setdefault(g, []).append(rec)

        populated_count = count_bands_populated(antenas)
        zero_gid_populated = 0
        pending_indices: list[int] = []
        pending_by_gid: dict[str, list[int]] = {}
        for idx, rec in enumerate(antenas):
            if not self._needs_band_scan(rec):
                continue
            gids = get_record_gids(rec)
            if not gids:
                if not isinstance(rec.get("bandas"), list):
                    populated_count += 1
                rec["bandas"] = []
                rec["frecuencias"] = []
                rec["concesiones"] = []
                rec["bandsScannedAt"] = _utc_now_iso(self._now_utc)
                zero_gid_populated += 1
                continue
            pending_indices.append(idx)
            for g in gids:
                pending_by_gid.setdefault(g, []).append(idx)

        total_antenas = len(antenas)
        already_scanned_in_cycle = total_antenas - len(pending_indices) - zero_gid_populated
        self.last_total_antennas = total_antenas
        self.last_scanned_antennas = already_scanned_in_cycle + zero_gid_populated

        if not pending_indices:
            self.last_scanned_antennas = total_antenas
            crawl_stats["bandsPopulatedCount"] = populated_count
            crawl_stats["bandRequestsCount"] = 0
            if zero_gid_populated > 0:
                self._save_dataset_checkpoint(dataset, populated_count=populated_count)
            if self._progress_callback is not None:
                self._progress_callback(
                    {
                        "phase": "frecuencias",
                        "scannedAntennas": total_antenas,
                        "totalAntennas": total_antenas,
                        "requestsPerSecond": 0.0,
                    }
                )
            return dataset

        units = self._build_prioritized_units(antenas, pending_indices)
        gid_entries_cache: dict[str, list[dict[str, Any]]] = {}
        completed_pending_indices: set[int] = set()
        failed_gids: set[str] = set()
        consecutive_failures = 0
        newly_populated = zero_gid_populated
        run_start_ts = self._clock()

        if self._progress_callback is not None:
            self._progress_callback(
                {
                    "phase": "frecuencias",
                    "scannedAntennas": already_scanned_in_cycle + newly_populated,
                    "totalAntennas": total_antenas,
                    "requestsPerSecond": 0.0,
                }
            )

        logging.info(
            "Iniciando enriquecimiento de bandas: %d antenas pendientes (%d unidades GID, workers=%d, delay=%.3fs)...",
            len(pending_indices),
            len(units),
            self.workers,
            self.delay_seconds,
        )

        try:
            if self.workers <= 1:
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
                            entries = self._http_fetch_detalle(gid, parallel_mode=False)
                            fetched_iso = _utc_now_iso(self._now_utc)
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

                        batch_patches: list[dict[str, Any]] = []
                        batch_freq_novs: list[dict[str, Any]] = []
                        n_delta, p_delta = self._apply_completed_gid(
                            gid,
                            fetched_iso,
                            antenas=antenas,
                            pending_by_gid=pending_by_gid,
                            completed_pending_indices=completed_pending_indices,
                            gid_entries_cache=gid_entries_cache,
                            all_records_per_gid=all_records_per_gid,
                            batch_patches=batch_patches,
                            batch_freq_novs=batch_freq_novs,
                        )
                        newly_populated += n_delta
                        populated_count += p_delta

                        now = self._clock()
                        self.last_requests_per_second = round(
                            self.requests_count / max(0.001, now - run_start_ts), 2
                        )

                        flushed_live = False
                        if self._live_stream is not None and (
                            batch_patches or batch_freq_novs
                        ):
                            flushed_live = self._live_stream.record_band_updates(
                                batch_patches, batch_freq_novs
                            )

                        if self._progress_callback is not None and (
                            flushed_live
                            or self.requests_count == 1
                            or self.requests_count % 5 == 0
                        ):
                            self._progress_callback(
                                {
                                    "phase": "frecuencias",
                                    "scannedAntennas": already_scanned_in_cycle
                                    + newly_populated,
                                    "totalAntennas": total_antenas,
                                    "requestsPerSecond": self.last_requests_per_second,
                                }
                            )

                        if self.requests_count % 25 == 0:
                            logging.info(
                                "[bandas req #%d] emplazamiento=%s -> +%d antenas en esta sesión (total con bandas=%d/%d)",
                                self.requests_count,
                                gid,
                                newly_populated,
                                populated_count,
                                total_antenas,
                            )

                        if self._unsaved_requests >= self.checkpoint_every:
                            self._save_dataset_checkpoint(
                                dataset, populated_count=populated_count
                            )
            else:
                seen_ordered_gids: set[str] = set()
                ordered_gids: list[str] = []
                for unit_gids in units:
                    if self.max_band_requests is not None:
                        needed = [g for g in unit_gids if g not in seen_ordered_gids]
                        remaining_slots = self.max_band_requests - len(ordered_gids)
                        if remaining_slots <= 0:
                            break
                        if len(needed) > remaining_slots:
                            continue
                        for g in needed:
                            seen_ordered_gids.add(g)
                            ordered_gids.append(g)
                    else:
                        for g in unit_gids:
                            if g not in seen_ordered_gids:
                                seen_ordered_gids.add(g)
                                ordered_gids.append(g)

                max_in_flight = max(1, self.workers * 2)
                max_consecutive_failures = max(15, self.workers * 2)
                gid_cursor = 0
                total_gids = len(ordered_gids)
                stop_submitting = False
                last_progress_ts = run_start_ts
                last_ckpt_ts = run_start_ts
                last_log_req = 0

                with concurrent.futures.ThreadPoolExecutor(
                    max_workers=self.workers,
                    thread_name_prefix="minetur-bands",
                ) as executor:
                    in_flight: dict[
                        concurrent.futures.Future[list[dict[str, Any]]], str
                    ] = {}

                    def _can_submit_next() -> bool:
                        if stop_submitting or gid_cursor >= total_gids:
                            return False
                        if len(in_flight) >= max_in_flight:
                            return False
                        if (
                            self.max_band_requests is not None
                            and (self.requests_count + len(in_flight))
                            >= self.max_band_requests
                        ):
                            return False
                        if self._would_exceed_time_budget(
                            run_start_ts, parallel_mode=True
                        ):
                            return False
                        return True

                    while _can_submit_next():
                        next_gid = ordered_gids[gid_cursor]
                        gid_cursor += 1
                        fut = executor.submit(
                            self._http_fetch_detalle, next_gid, parallel_mode=True
                        )
                        in_flight[fut] = next_gid

                    while in_flight:
                        done, _ = concurrent.futures.wait(
                            in_flight.keys(),
                            return_when=concurrent.futures.FIRST_COMPLETED,
                        )
                        batch_patches = []
                        batch_freq_novs = []
                        last_done_gid = ""

                        for fut in done:
                            gid = in_flight.pop(fut)
                            last_done_gid = gid
                            try:
                                entries = fut.result()
                                fetched_iso = _utc_now_iso(self._now_utc)
                                gid_entries_cache[gid] = entries
                                consecutive_failures = 0
                            except RuntimeError as exc:
                                self.failed_gids_count += 1
                                failed_gids.add(gid)
                                consecutive_failures += 1
                                logging.error("%s", exc)
                                if self.fail_fast:
                                    for other_fut in in_flight:
                                        other_fut.cancel()
                                    raise
                                if consecutive_failures >= max_consecutive_failures:
                                    logging.error(
                                        "Se alcanzaron %d fallos consecutivos en detalleEstacion.do; deteniendo lote de forma segura.",
                                        consecutive_failures,
                                    )
                                    stop_submitting = True
                                    for other_fut in list(in_flight):
                                        if other_fut.cancel():
                                            in_flight.pop(other_fut, None)
                                    break
                                continue

                            n_delta, p_delta = self._apply_completed_gid(
                                gid,
                                fetched_iso,
                                antenas=antenas,
                                pending_by_gid=pending_by_gid,
                                completed_pending_indices=completed_pending_indices,
                                gid_entries_cache=gid_entries_cache,
                                all_records_per_gid=all_records_per_gid,
                                batch_patches=batch_patches,
                                batch_freq_novs=batch_freq_novs,
                            )
                            newly_populated += n_delta
                            populated_count += p_delta

                        while _can_submit_next():
                            next_gid = ordered_gids[gid_cursor]
                            gid_cursor += 1
                            fut = executor.submit(
                                self._http_fetch_detalle, next_gid, parallel_mode=True
                            )
                            in_flight[fut] = next_gid

                        now = self._clock()
                        self.last_requests_per_second = round(
                            self.requests_count / max(0.001, now - run_start_ts), 2
                        )

                        flushed_live = False
                        if self._live_stream is not None and (
                            batch_patches or batch_freq_novs
                        ):
                            flushed_live = self._live_stream.record_band_updates(
                                batch_patches, batch_freq_novs
                            )

                        if self._progress_callback is not None and (
                            flushed_live
                            or not in_flight
                            or (now - last_progress_ts) >= 1.0
                        ):
                            self._progress_callback(
                                {
                                    "phase": "frecuencias",
                                    "scannedAntennas": already_scanned_in_cycle
                                    + newly_populated,
                                    "totalAntennas": total_antenas,
                                    "requestsPerSecond": self.last_requests_per_second,
                                }
                            )
                            last_progress_ts = now

                        if self.requests_count - last_log_req >= 500:
                            last_log_req = self.requests_count
                            logging.info(
                                "[bandas req #%d | %.1f req/s] emplazamiento=%s -> +%d antenas en esta sesión (total con bandas=%d/%d)",
                                self.requests_count,
                                self.last_requests_per_second,
                                last_done_gid,
                                newly_populated,
                                populated_count,
                                total_antenas,
                            )

                        if (
                            self._unsaved_requests >= self.checkpoint_every
                            and (now - last_ckpt_ts)
                            >= MULTI_WORKER_CHECKPOINT_MIN_INTERVAL_S
                        ):
                            self._save_dataset_checkpoint(
                                dataset, populated_count=populated_count
                            )
                            last_ckpt_ts = self._clock()
        finally:
            self._http_client.close_all()

        if self._live_stream is not None:
            self._live_stream.record_band_updates([], [], force_flush=True)

        self.last_total_antennas = total_antenas
        self.last_scanned_antennas = already_scanned_in_cycle + newly_populated
        crawl_stats["bandsPopulatedCount"] = populated_count
        crawl_stats["bandRequestsCount"] = self.requests_count
        if self.requests_count > 0 or zero_gid_populated > 0:
            self._save_dataset_checkpoint(dataset, populated_count=populated_count)

        if self._progress_callback is not None:
            self._progress_callback(
                {
                    "phase": "frecuencias",
                    "scannedAntennas": already_scanned_in_cycle + newly_populated,
                    "totalAntennas": total_antenas,
                    "requestsPerSecond": self.last_requests_per_second,
                }
            )

        logging.info(
            "Enriquecimiento finalizado: %d peticiones HTTP (%.1f req/s), +%d antenas enriquecidas (%d/%d totales con bandas).",
            self.requests_count,
            self.last_requests_per_second,
            newly_populated,
            crawl_stats["bandsPopulatedCount"],
            total_antenas,
        )
        return dataset


def enrich_dataset_bands(
    dataset: dict[str, Any],
    delay_seconds: float = DEFAULT_DELAY_SECONDS,
    max_band_seconds: float | None = None,
    max_band_requests: int | None = None,
    checkpoint_path: Path | None = None,
    checkpoint_every: int = DEFAULT_BAND_CHECKPOINT_EVERY,
    workers: int = 1,
    fail_fast: bool = False,
    rescan_since: str | None = None,
    new_antenna_ids: set[str] | None = None,
    prior_index: dict[str, Any] | None = None,
    record_novedades: bool = True,
    novedades_checkpoint_fn: Callable[[list[dict[str, Any]]], None] | None = None,
    live_stream: LiveDeltaStreamWriter | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    fetch_fn: Callable[[str], str | bytes] | None = None,
    sleep_fn: Callable[[float], None] = time.sleep,
    clock_fn: Callable[[], float] = time.monotonic,
    now_utc_fn: Callable[[], datetime] | None = None,
) -> dict[str, Any]:
    """Función auxiliar para enriquecer `bandas`, `frecuencias` y `concesiones` sobre un `AntenasDataset`."""
    enricher = BandEnricher(
        delay_seconds=delay_seconds,
        max_band_seconds=max_band_seconds,
        max_band_requests=max_band_requests,
        checkpoint_path=checkpoint_path,
        checkpoint_every=checkpoint_every,
        workers=workers,
        fail_fast=fail_fast,
        rescan_since=rescan_since,
        new_antenna_ids=new_antenna_ids,
        prior_index=prior_index,
        record_novedades=record_novedades,
        novedades_checkpoint_fn=novedades_checkpoint_fn,
        live_stream=live_stream,
        progress_callback=progress_callback,
        fetch_fn=fetch_fn,
        sleep_fn=sleep_fn,
        clock_fn=clock_fn,
        now_utc_fn=now_utc_fn,
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
    (por defecto `< 35 m`), preservando opcionalmente `bandas`/`frecuencias`/`concesiones`
    previas y ordenando las antenas determinísticamente por `(prov, mun, id)`.
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
        help="Segundos mínimos de espera por hilo entre peticiones HTTP consecutivas (por defecto 0.02s).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_BAND_WORKERS,
        help="Hilos concurrentes Keep-Alive para detalleEstacion.do (por defecto 16).",
    )
    parser.add_argument(
        "--census-workers",
        type=int,
        default=DEFAULT_CENSUS_WORKERS,
        help="Hilos concurrentes Keep-Alive para el barrido GeoJSON de censo (por defecto 8).",
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
        help="Tras recolectar el censo, consulta detalleEstacion.do en paralelo Keep-Alive para antenas pendientes o a re-escanear.",
    )
    parser.add_argument(
        "--enrich-bands-only",
        action="store_true",
        help="Carga --input y consulta detalleEstacion.do únicamente para las antenas pendientes o con bandsScannedAt < --rescan-since.",
    )
    parser.add_argument(
        "--max-band-seconds",
        type=float,
        default=None,
        help="Tiempo máximo en segundos dedicado a consultar detalleEstacion.do (ej. 18000).",
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
    parser.add_argument(
        "--rescan-since",
        default=None,
        help="Marca temporal ISO-8601 UTC: re-escanea también antenas con bandsScannedAt ausente o anterior a este instante.",
    )
    parser.add_argument(
        "--novedades-output",
        default=None,
        help="Ruta opcional donde escribir el archivo NovedadesDataset (ej. public/data/novedades.json).",
    )
    parser.add_argument(
        "--novedades-mode",
        choices=("reset", "append"),
        default="reset",
        help="Modo de escritura de novedades: 'reset' inicia lote limpio; 'append' acumula novedades del mismo escaneo.",
    )
    parser.add_argument(
        "--skip-novedades",
        action="store_true",
        help="No contabilizar este escaneo en la sección Novedades (escaneo forzado de línea base).",
    )
    parser.add_argument(
        "--scan-id",
        default="",
        help="Identificador único del lote de escaneo para NovedadesDataset.",
    )
    parser.add_argument(
        "--status-output",
        default=None,
        help="Ruta opcional donde escribir en tiempo real el JSON de estado del escaneo (scan-status.json).",
    )
    parser.add_argument(
        "--live-dir",
        default=None,
        help="Directorio donde emitir en tiempo real live-chunk-*.json y live-tail.json para sincronización instantánea con el mapa y novedades.",
    )
    parser.add_argument(
        "--live-mode",
        choices=("reset", "append"),
        default="reset",
        help="Modo del flujo en vivo: 'reset' limpia chunks previos; 'append' continúa numeración existente.",
    )
    parser.add_argument(
        "--scan-trigger",
        default="",
        help="Origen del escaneo ('schedule' para diario 18:00 o 'workflow_dispatch' para forzado).",
    )
    parser.add_argument(
        "--scan-part",
        default="",
        help="Etiqueta opcional del tramo en ejecución (ej. '1/2', '2/2').",
    )
    return parser.parse_args(argv)


def build_scan_status_payload(
    *,
    state: str,
    scan_id: str,
    trigger: str,
    record_novedades: bool,
    part: str,
    phase: str,
    started_at: str,
    total_antennas: int,
    scanned_antennas: int = 0,
    census_boxes_visited: int = 0,
    discovered_antennas: int = 0,
    delta_seq: int = 0,
    chunk_count: int = 0,
    live_new_antennas_count: int = 0,
    live_updated_antennas_count: int = 0,
    live_novedades_count: int = 0,
    requests_per_second: float = 0.0,
    completed_dataset_updated_at: str = "",
    updated_at: str | None = None,
) -> dict[str, Any]:
    """
    Construye el documento JSON compacto `scan-status.json` consumido en tiempo real
    por el monitor de progreso y sincronizador de deltas en vivo.
    """
    eff_total = max(0, int(total_antennas))
    eff_scanned = max(0, min(int(scanned_antennas), eff_total)) if eff_total > 0 else max(0, int(scanned_antennas))
    eff_boxes = max(0, int(census_boxes_visited))
    est_boxes = max(239, eff_boxes + 5)

    if state == "completed":
        pct = 100.0
        if eff_total > 0:
            eff_scanned = eff_total
    elif phase == "censo":
        if eff_boxes <= 0:
            pct = 0.0
        else:
            pct = round(max(0.01, min(0.39, (eff_boxes / float(est_boxes)) * 0.39)), 2)
    else:
        if eff_total <= 0:
            pct = 0.0
        elif eff_scanned >= eff_total:
            pct = 100.0
        else:
            raw_pct = (eff_scanned / float(eff_total)) * 100.0
            if (not part or part.startswith("1/")) and raw_pct < 0.40:
                pct = 0.40
            else:
                pct = round(min(99.99, raw_pct), 2)

    payload: dict[str, Any] = {
        "schemaVersion": 2,
        "state": state,
        "scanId": str(scan_id or ""),
        "trigger": str(trigger or "workflow_dispatch"),
        "recordNovedades": bool(record_novedades),
        "part": str(part or ""),
        "phase": str(phase or "frecuencias"),
        "startedAt": _normalize_iso_utc(started_at) if started_at else _utc_now_iso(),
        "updatedAt": _normalize_iso_utc(updated_at) if updated_at else _utc_now_iso(),
        "censusBoxesVisited": eff_boxes,
        "estimatedCensusBoxes": est_boxes,
        "discoveredAntennas": max(0, int(discovered_antennas)),
        "scannedAntennas": eff_scanned,
        "totalAntennas": eff_total,
        "percent": pct,
        "deltaSeq": max(0, int(delta_seq)),
        "chunkCount": max(0, int(chunk_count)),
        "liveNewAntennasCount": max(0, int(live_new_antennas_count)),
        "liveUpdatedAntennasCount": max(0, int(live_updated_antennas_count)),
        "liveNovedadesCount": max(0, int(live_novedades_count)),
        "requestsPerSecond": round(max(0.0, float(requests_per_second)), 2),
    }
    if completed_dataset_updated_at:
        payload["completedDatasetUpdatedAt"] = _normalize_iso_utc(completed_dataset_updated_at)
    return payload


def write_scan_status_file(payload: dict[str, Any], status_path: Path) -> None:
    """Escribe de forma atómica el estado en vivo del escaneo (`scan-status.json`)."""
    status_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = status_path.with_name(status_path.name + ".tmp")
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tmp_path.write_bytes(encoded)
    os.replace(tmp_path, status_path)


def _prepare_novedades_writer(
    *,
    novedades_output: str | Path | None,
    novedades_mode: str,
    skip_novedades: bool,
    scan_id: str,
    previous_scan_at: str | None,
    initial_novedades: list[dict[str, Any]] | None = None,
) -> tuple[
    Callable[[list[dict[str, Any]]], None] | None,
    set[str],
]:
    """
    Configura la persistencia atómica de `novedades.json` para modos `'reset'` y `'append'`
    (incluyendo `--skip-novedades`) y devuelve `(checkpoint_writer_fn, existing_new_antenna_ids)`.
    """
    if not novedades_output:
        return None, set()

    nov_path = Path(novedades_output)
    effective_scan_id = str(scan_id or "").strip()

    if skip_novedades:
        if novedades_mode == "reset" or not nov_path.exists():
            baseline_doc = build_novedades_dataset(
                [],
                scan_id=effective_scan_id or "baseline-scan",
                previous_scan_at=previous_scan_at,
                is_baseline_scan=True,
            )
            write_novedades_dataset(baseline_doc, nov_path)
        return None, set()

    base_items: list[dict[str, Any]] = []
    effective_prev_scan_at = previous_scan_at

    if novedades_mode == "append":
        existing_doc = load_novedades_dataset(nov_path)
        if existing_doc is not None:
            same_scan = bool(
                effective_scan_id and existing_doc.get("scanId") == effective_scan_id
            )
            non_baseline = not bool(existing_doc.get("isBaselineScan"))
            if same_scan or non_baseline:
                base_items.extend(
                    item
                    for item in (existing_doc.get("novedades") or [])
                    if isinstance(item, dict)
                )
                if not effective_scan_id and isinstance(existing_doc.get("scanId"), str):
                    effective_scan_id = existing_doc["scanId"]
                if "previousScanAt" in existing_doc:
                    effective_prev_scan_at = existing_doc.get("previousScanAt")

    if initial_novedades:
        base_items.extend(initial_novedades)

    seeded_new_ant_ids = {
        str(item["antennaId"])
        for item in base_items
        if isinstance(item, dict)
        and item.get("tipo") == "antena"
        and item.get("antennaId")
    }

    def _write_current(discovered: list[dict[str, Any]]) -> None:
        nov_doc = build_novedades_dataset(
            [*base_items, *discovered],
            scan_id=effective_scan_id,
            previous_scan_at=effective_prev_scan_at,
            is_baseline_scan=False,
        )
        write_novedades_dataset(nov_doc, nov_path)

    _write_current([])
    return _write_current, seeded_new_ant_ids


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    args = parse_args(argv)
    output_path = Path(args.output)
    status_path = Path(args.status_output) if args.status_output else None
    scan_started_iso = args.rescan_since or _utc_now_iso()
    delay = max(0.0, float(args.delay))
    band_workers = max(1, int(args.workers))
    census_workers = max(1, int(args.census_workers))

    def _make_progress_emitter(
        fallback_total: int,
        live_stream_ref: LiveDeltaStreamWriter | None = None,
    ) -> Callable[[dict[str, Any]], None] | None:
        if status_path is None:
            return None

        def _emit(info: dict[str, Any]) -> None:
            total_ant = int(info.get("totalAntennas") or fallback_total or 0)
            scanned_ant = int(info.get("scannedAntennas") or 0)
            phase_name = str(info.get("phase") or "frecuencias")
            is_done = (
                phase_name == "frecuencias"
                and total_ant > 0
                and scanned_ant >= total_ant
            )
            payload = build_scan_status_payload(
                state="completed" if is_done else "running",
                scan_id=args.scan_id,
                trigger=args.scan_trigger or "workflow_dispatch",
                record_novedades=not args.skip_novedades,
                part=args.scan_part,
                phase=phase_name,
                started_at=scan_started_iso,
                total_antennas=total_ant,
                scanned_antennas=scanned_ant,
                census_boxes_visited=int(info.get("censusBoxesVisited") or 0),
                discovered_antennas=int(info.get("discoveredAntennas") or 0),
                delta_seq=live_stream_ref.delta_seq if live_stream_ref is not None else 0,
                chunk_count=live_stream_ref.chunk_count if live_stream_ref is not None else 0,
                live_new_antennas_count=(
                    live_stream_ref.total_new_antennas if live_stream_ref is not None else 0
                ),
                live_updated_antennas_count=(
                    live_stream_ref.total_updated_antennas if live_stream_ref is not None else 0
                ),
                live_novedades_count=(
                    live_stream_ref.total_novedades if live_stream_ref is not None else 0
                ),
                requests_per_second=float(info.get("requestsPerSecond") or 0.0),
                completed_dataset_updated_at=str(
                    info.get("completedDatasetUpdatedAt") or ""
                ),
            )
            write_scan_status_file(payload, status_path)

        return _emit

    if args.enrich_bands_only:
        input_path = Path(args.input) if args.input else output_path
        if not input_path.exists():
            logging.error("No existe el archivo de entrada: %s", input_path)
            return 1
        dataset = json.loads(input_path.read_text(encoding="utf-8"))
        prev_updated_at = (
            dataset.get("updatedAt")
            if isinstance(dataset.get("updatedAt"), str)
            else None
        )
        nov_writer, seeded_new_ant_ids = _prepare_novedades_writer(
            novedades_output=args.novedades_output,
            novedades_mode=args.novedades_mode,
            skip_novedades=args.skip_novedades,
            scan_id=args.scan_id,
            previous_scan_at=prev_updated_at,
        )
        live_stream: LiveDeltaStreamWriter | None = None
        if args.live_dir:
            live_stream = LiveDeltaStreamWriter(
                args.live_dir,
                scan_id=args.scan_id,
                mode=args.live_mode,
                record_novedades=not args.skip_novedades,
                previous_scan_at=prev_updated_at,
            )
            live_stream.flush_final()
            seeded_new_ant_ids = seeded_new_ant_ids | live_stream.seen_new_antenna_ids

        total_ds_antenas = int(
            dataset.get("total") or len(dataset.get("antenas") or [])
        )
        progress_cb = _make_progress_emitter(total_ds_antenas, live_stream)
        enricher = BandEnricher(
            delay_seconds=delay,
            max_band_seconds=args.max_band_seconds,
            max_band_requests=args.max_band_requests,
            checkpoint_path=output_path,
            checkpoint_every=args.band_checkpoint_every,
            workers=band_workers,
            rescan_since=args.rescan_since,
            new_antenna_ids=seeded_new_ant_ids,
            record_novedades=not args.skip_novedades,
            novedades_checkpoint_fn=nov_writer,
            live_stream=live_stream,
            progress_callback=progress_cb,
        )
        enricher.enrich_dataset(dataset)
        if enricher.requests_count > 0 or output_path.resolve() != input_path.resolve():
            write_compact_dataset(dataset, output_path)
        if nov_writer is not None:
            nov_writer(enricher.discovered_novedades)
        if live_stream is not None:
            live_stream.flush_final()
        if status_path is not None:
            eff_total = enricher.last_total_antennas
            eff_scanned = enricher.last_scanned_antennas
            is_all_done = eff_total == 0 or eff_scanned >= eff_total
            write_scan_status_file(
                build_scan_status_payload(
                    state="completed" if is_all_done else "running",
                    scan_id=args.scan_id,
                    trigger=args.scan_trigger or "workflow_dispatch",
                    record_novedades=not args.skip_novedades,
                    part=args.scan_part,
                    phase="frecuencias",
                    started_at=scan_started_iso,
                    total_antennas=eff_total,
                    scanned_antennas=eff_scanned,
                    delta_seq=live_stream.delta_seq if live_stream is not None else 0,
                    chunk_count=live_stream.chunk_count if live_stream is not None else 0,
                    live_new_antennas_count=(
                        live_stream.total_new_antennas if live_stream is not None else 0
                    ),
                    live_updated_antennas_count=(
                        live_stream.total_updated_antennas if live_stream is not None else 0
                    ),
                    live_novedades_count=(
                        live_stream.total_novedades if live_stream is not None else 0
                    ),
                    requests_per_second=enricher.last_requests_per_second,
                    completed_dataset_updated_at=(
                        str(dataset.get("updatedAt") or "") if is_all_done else ""
                    ),
                ),
                status_path,
            )
        size_mb = output_path.stat().st_size / (1024 * 1024) if output_path.exists() else 0.0
        logging.info(
            "Modo --enrich-bands-only completado: %d/%d antenas con bandas en %s (%.2f MB, %d peticiones HTTP a %.1f req/s, +%d novedades de frecuencia).",
            dataset["crawlStats"].get("bandsPopulatedCount", 0),
            dataset["total"],
            output_path,
            size_mb,
            enricher.requests_count,
            enricher.last_requests_per_second,
            len(enricher.discovered_novedades),
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

    previous_scan_at = (
        prior_dataset.get("updatedAt")
        if isinstance(prior_dataset, dict) and isinstance(prior_dataset.get("updatedAt"), str)
        else None
    )
    prior_total_antennas = (
        int(prior_dataset.get("total") or len(prior_dataset.get("antenas") or []))
        if isinstance(prior_dataset, dict)
        else 62230
    )
    prior_index = (
        build_prior_antenna_index(prior_dataset) if prior_dataset is not None else None
    )

    live_stream = None
    if args.live_dir:
        live_stream = LiveDeltaStreamWriter(
            args.live_dir,
            scan_id=args.scan_id,
            mode=args.live_mode,
            record_novedades=not args.skip_novedades,
            previous_scan_at=previous_scan_at,
        )
        live_stream.flush_final()

    progress_cb = _make_progress_emitter(prior_total_antennas, live_stream)
    if progress_cb is not None:
        progress_cb({"phase": "censo", "censusBoxesVisited": 0, "discoveredAntennas": 0})

    crawler = InfoantenasCrawler(
        delay_seconds=delay,
        zoom=args.zoom,
        checkpoint_path=checkpoint_path,
        workers=census_workers,
        prior_index=prior_index,
        record_novedades=not args.skip_novedades,
        live_stream=live_stream,
        progress_callback=progress_cb,
    )
    dataset = crawler.crawl(region=args.region)

    detected_ant_novedades, new_antenna_ids = (
        diff_new_antennas(
            dataset["antenas"],
            prior_index,
            scanned_at_iso=dataset["updatedAt"],
        )
        if prior_index is not None
        else ([], set())
    )

    if prior_dataset is not None:
        restored = preserve_bands_in_records(dataset["antenas"], prior_dataset)
        dataset["crawlStats"]["bandsPopulatedCount"] = count_bands_populated(
            dataset["antenas"]
        )
        prior_band_reqs = (prior_dataset.get("crawlStats") or {}).get("bandRequestsCount")
        if prior_band_reqs is not None and not args.fetch_bands:
            dataset["crawlStats"]["bandRequestsCount"] = int(prior_band_reqs)
        logging.info(
            "Preservadas bandas previas de %d antenas desde %s (antenas nuevas detectadas=%d).",
            restored,
            preserve_path,
            len(new_antenna_ids),
        )

    if live_stream is not None and prior_index is not None:
        canonical_new_antennas = [
            rec for rec in dataset["antenas"] if rec["id"] in new_antenna_ids
        ]
        reconciled = live_stream.reconcile_post_census_new_antennas(
            canonical_new_antennas,
            [] if args.skip_novedades else detected_ant_novedades,
        )
        if reconciled and progress_cb is not None:
            census_dur = max(0.001, float(dataset["crawlStats"].get("durationSeconds") or 1.0))
            census_rps = round(
                int(dataset["crawlStats"].get("requestsCount") or 0) / census_dur, 2
            )
            progress_cb(
                {
                    "phase": "censo",
                    "censusBoxesVisited": dataset["crawlStats"]["gridBoxesVisited"],
                    "discoveredAntennas": dataset["total"],
                    "totalAntennas": dataset["total"],
                    "requestsPerSecond": census_rps,
                }
            )

    size_bytes = write_compact_dataset(dataset, output_path)

    nov_writer, seeded_new_ant_ids = _prepare_novedades_writer(
        novedades_output=args.novedades_output,
        novedades_mode=args.novedades_mode,
        skip_novedades=args.skip_novedades,
        scan_id=args.scan_id,
        previous_scan_at=previous_scan_at,
        initial_novedades=[] if args.skip_novedades else detected_ant_novedades,
    )
    all_new_ant_ids = new_antenna_ids | seeded_new_ant_ids

    if args.fetch_bands:
        enricher = BandEnricher(
            delay_seconds=delay,
            max_band_seconds=args.max_band_seconds,
            max_band_requests=args.max_band_requests,
            checkpoint_path=output_path,
            checkpoint_every=args.band_checkpoint_every,
            workers=band_workers,
            rescan_since=args.rescan_since,
            new_antenna_ids=all_new_ant_ids,
            prior_index=prior_index,
            record_novedades=not args.skip_novedades,
            novedades_checkpoint_fn=nov_writer,
            live_stream=live_stream,
            progress_callback=progress_cb,
        )
        enricher.enrich_dataset(dataset)
        size_bytes = write_compact_dataset(dataset, output_path)
        if nov_writer is not None:
            nov_writer(enricher.discovered_novedades)
        if live_stream is not None:
            live_stream.flush_final()
        if status_path is not None:
            eff_total = enricher.last_total_antennas
            eff_scanned = enricher.last_scanned_antennas
            is_all_done = eff_total == 0 or eff_scanned >= eff_total
            write_scan_status_file(
                build_scan_status_payload(
                    state="completed" if is_all_done else "running",
                    scan_id=args.scan_id,
                    trigger=args.scan_trigger or "workflow_dispatch",
                    record_novedades=not args.skip_novedades,
                    part=args.scan_part,
                    phase="frecuencias",
                    started_at=scan_started_iso,
                    total_antennas=eff_total,
                    scanned_antennas=eff_scanned,
                    census_boxes_visited=dataset["crawlStats"]["gridBoxesVisited"],
                    discovered_antennas=dataset["total"],
                    delta_seq=live_stream.delta_seq if live_stream is not None else 0,
                    chunk_count=live_stream.chunk_count if live_stream is not None else 0,
                    live_new_antennas_count=(
                        live_stream.total_new_antennas if live_stream is not None else 0
                    ),
                    live_updated_antennas_count=(
                        live_stream.total_updated_antennas if live_stream is not None else 0
                    ),
                    live_novedades_count=(
                        live_stream.total_novedades if live_stream is not None else 0
                    ),
                    requests_per_second=enricher.last_requests_per_second,
                    completed_dataset_updated_at=(
                        str(dataset.get("updatedAt") or "") if is_all_done else ""
                    ),
                ),
                status_path,
            )
    else:
        if live_stream is not None:
            live_stream.flush_final()
        if status_path is not None:
            census_dur = max(
                0.001, float(dataset["crawlStats"].get("durationSeconds") or 1.0)
            )
            census_rps = round(
                int(dataset["crawlStats"].get("requestsCount") or 0) / census_dur, 2
            )
            write_scan_status_file(
                build_scan_status_payload(
                    state="completed",
                    scan_id=args.scan_id,
                    trigger=args.scan_trigger or "workflow_dispatch",
                    record_novedades=not args.skip_novedades,
                    part=args.scan_part,
                    phase="censo",
                    started_at=scan_started_iso,
                    total_antennas=dataset["total"],
                    scanned_antennas=dataset["total"],
                    census_boxes_visited=dataset["crawlStats"]["gridBoxesVisited"],
                    discovered_antennas=dataset["total"],
                    delta_seq=live_stream.delta_seq if live_stream is not None else 0,
                    chunk_count=live_stream.chunk_count if live_stream is not None else 0,
                    live_new_antennas_count=(
                        live_stream.total_new_antennas if live_stream is not None else 0
                    ),
                    live_updated_antennas_count=(
                        live_stream.total_updated_antennas if live_stream is not None else 0
                    ),
                    live_novedades_count=(
                        live_stream.total_novedades if live_stream is not None else 0
                    ),
                    requests_per_second=census_rps,
                    completed_dataset_updated_at=str(dataset.get("updatedAt") or ""),
                ),
                status_path,
            )

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
