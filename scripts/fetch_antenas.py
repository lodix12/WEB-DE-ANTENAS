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
import functools
import gzip
import html as html_lib
from html.parser import HTMLParser
import http.client
import io
import json
import logging
import math
import os
from pathlib import Path
import random
import re
import socket
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
DEFAULT_MAX_BAND_RPS = 75.0
DEFAULT_CENSUS_WORKERS = 8
LIVE_DELTA_CHUNK_CAPACITY = 2000
MULTI_WORKER_CHECKPOINT_MIN_INTERVAL_S = 180.0
DEFAULT_BAND_CHECKPOINT_EVERY = 50
CONNECT_TIMEOUT_CAP_S = 10.0
CONNECT_STAGGER_SECONDS = 0.05
ADAPTIVE_LATENCY_HIGH_S = 1.2
ADAPTIVE_LATENCY_RECOVER_S = 0.6
ADAPTIVE_MAX_EXTRA_DELAY_S = 0.5
SOFT_ANOMALY_WINDOW_S = 15.0
SOFT_ANOMALY_BURST_THRESHOLD = 3
FAILED_GID_RECOVERY_MAX = 500
EMPTY_VERIFICATION_MAX = 500
EMPTY_VERIFICATION_CONFIRMATIONS = 2
MISSING_ANTENNA_VERIFY_MAX = 500
MISSING_ANTENNA_MICRO_BBOX_PAD_DEG = 0.01
MISSING_ANTENNA_EMPTY_CONFIRMATIONS = 2
MAX_SAFE_CENSUS_DROP_RATIO = 0.25
MIN_PRIOR_ANTENNAS_FOR_DROP_GUARD = 1000
QUADRANT_OVERLAP_DEG = 0.0001
MIN_QUADRANT_SPAN_DEG = 0.004
MAX_SUBDIVISION_DEPTH = 9
FREQ_RANGE_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)(?:\s*(?:MHz|GHz))?$",
    re.IGNORECASE,
)
_DIGI_WORD_RE = re.compile(r"\bDIGI\b")
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
    "digi",
    "otros",
)

OPERATOR_NAMES: dict[str, str] = {
    "movistar": "Movistar (Telefónica)",
    "orange": "Orange (MasOrange)",
    "vodafone": "Vodafone España",
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


@functools.lru_cache(maxsize=4096)
def _strip_accents_cached(value: str) -> str:
    if value.isascii():
        return value
    normalized = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


def _strip_accents(value: str) -> str:
    return _strip_accents_cached(value or "")


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


def decode_infoantenas_payload_strict(raw_bytes: bytes) -> list[dict[str, Any]]:
    """
    Variante estricta de `decode_infoantenas_payload` usada al verificar bajas reales
    de antenas: rechaza respuestas vacías (`b""`), HTML de error o JSON sin estructura
    válida, admitiendo únicamente un GeoJSON con `features: [...]` o el objeto vacío `{}`
    que MINETUR devuelve en cuadrantes sin estaciones.
    """
    if not raw_bytes:
        raise ValueError("Respuesta vacía (0 bytes) desde infoantenasGeoJSON.do")
    if raw_bytes[:2] == b"\x1f\x8b":
        raw_bytes = gzip.decompress(raw_bytes)
    text = raw_bytes.decode("iso-8859-1").strip()
    if not text:
        raise ValueError("Respuesta vacía tras decodificar infoantenasGeoJSON.do")
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("Respuesta JSON no es un objeto en infoantenasGeoJSON.do")
    if not payload:
        return []
    features = payload.get("features")
    if not isinstance(features, list):
        raise ValueError(
            "Respuesta JSON sin lista 'features' válida en infoantenasGeoJSON.do"
        )
    return features


_XFERA_TOKENS: tuple[str, ...] = (
    "XFERA",
    "MASMOVIL",
    "YOIGO",
    "EUSKALTEL",
    "R CABLE",
    "TELECABLE",
)


@functools.lru_cache(maxsize=1024)
def _is_xfera_entity_cached(op_raw: str) -> bool:
    upper_ascii = _strip_accents_cached(op_raw.upper())
    return any(token in upper_ascii for token in _XFERA_TOKENS)


def is_xfera_entity(op_raw: str) -> bool:
    """Indica si la razón social pertenece al antiguo grupo Xfera / MásMóvil / Yoigo (integrado en MasOrange)."""
    return _is_xfera_entity_cached(op_raw or "")


@functools.lru_cache(maxsize=1024)
def _classify_operator_cached(op_raw: str) -> str:
    upper_ascii = _strip_accents_cached(op_raw.upper())
    if "TELEFONICA" in upper_ascii or "MOVISTAR" in upper_ascii:
        return "movistar"
    if (
        "ORANGE" in upper_ascii
        or "MASORANGE" in upper_ascii
        or any(token in upper_ascii for token in _XFERA_TOKENS)
    ):
        return "orange"
    if "VODAFONE" in upper_ascii:
        return "vodafone"
    if "DS MOBILE" in upper_ascii or _DIGI_WORD_RE.search(upper_ascii):
        return "digi"
    return "otros"


def classify_operator(op_raw: str) -> str:
    """Clasifica la razón social de Infoantenas en un `OperatorKey` normalizado."""
    return _classify_operator_cached(op_raw or "")


def _normalize_operator_key(op_val: Any, op_raw_val: Any = "") -> str:
    """Normaliza cualquier clave heredada `'masmovil'` o entidad Xfera a `'orange'`."""
    op_str = str(op_val or "").strip()
    op_raw_str = str(op_raw_val or "")
    if op_str == "masmovil" or is_xfera_entity(op_raw_str):
        return "orange"
    if not op_str and op_raw_str:
        return classify_operator(op_raw_str)
    return op_str


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
DEFAULT_XFERA_ORANGE_FUSION_M = 30.0


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


def _create_ipv4_preferred_socket(
    address: tuple[str, int],
    timeout: float | None = None,
    source_address: tuple[str, int] | None = None,
) -> socket.socket:
    """
    Crea una conexión TCP priorizando IPv4 (`AF_INET`) antes que IPv6 (`AF_INET6`) y
    limitando el tiempo de establecimiento TCP (`CONNECT_TIMEOUT_CAP_S`) antes de restaurar
    el `timeout` completo para la lectura de respuesta. Evita bloqueos de 30 s en entornos
    sin enrutamiento IPv6 (como runners Linux de GitHub Actions).
    """
    host, port = address
    infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    if not infos:
        raise OSError(f"getaddrinfo devolvió lista vacía para {host}:{port}")

    # Orden estable: IPv4 primero, después IPv6 / otras familias
    infos.sort(key=lambda item: 0 if item[0] == socket.AF_INET else 1)

    is_numeric_timeout = isinstance(timeout, (int, float)) and timeout > 0
    connect_timeout = (
        min(float(timeout), CONNECT_TIMEOUT_CAP_S) if is_numeric_timeout else timeout
    )

    first_meaningful_err: OSError | None = None
    last_err: OSError | None = None

    for af, socktype, proto, _, sa in infos:
        sock: socket.socket | None = None
        try:
            sock = socket.socket(af, socktype, proto)
            if connect_timeout is not None and connect_timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(connect_timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sa)
            if timeout is not None and timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            return sock
        except OSError as exc:
            last_err = exc
            # Preferir errores IPv4 / timeout sobre ENETUNREACH (Errno 101) de IPv6 inalcanzable
            if first_meaningful_err is None and getattr(exc, "errno", None) != 101:
                first_meaningful_err = exc
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass

    if first_meaningful_err is not None:
        raise first_meaningful_err
    assert last_err is not None
    raise last_err


def _extract_jsessionid_cookie(headers: Any) -> str:
    """Extrae la cookie `JSESSIONID=...` de las cabeceras `Set-Cookie` de Tomcat (MINETUR)."""
    if headers is None:
        return ""
    raw_cookies: list[str] = []
    if hasattr(headers, "get_all"):
        raw_cookies = list(headers.get_all("Set-Cookie") or ())
    elif hasattr(headers, "get"):
        single = headers.get("Set-Cookie")
        if single:
            raw_cookies = [str(single)]
    for raw in raw_cookies:
        pair = str(raw).split(";", 1)[0].strip()
        if "=" in pair:
            cname = pair.split("=", 1)[0].strip().upper()
            if cname == "JSESSIONID":
                return pair
    return ""


_STALE_KEEPALIVE_ERRORS = (
    http.client.RemoteDisconnected,
    http.client.BadStatusLine,
    http.client.CannotSendRequest,
    http.client.ResponseNotReady,
    BrokenPipeError,
    ConnectionResetError,
    ConnectionAbortedError,
    ssl.SSLEOFError,
)


class _ThreadLocalKeepAliveClient:
    """
    Cliente HTTP/1.1 persistente (`Connection: keep-alive` + reutilización TLS y sesión
    `JSESSIONID` por hilo + ramp-up escalonado y autorregulación adaptativa) construido
    exclusivamente con la librería estándar de Python.
    Delega automáticamente en `urllib.request.urlopen` cuando los tests unitarios lo parchean.
    """

    def __init__(
        self,
        *,
        connect_stagger_seconds: float = CONNECT_STAGGER_SECONDS,
    ) -> None:
        self._tls = threading.local()
        self._lock = threading.Lock()
        self._connect_gate_lock = threading.Lock()
        self._rate_gate_lock = threading.Lock()
        self._all_conns: list[http.client.HTTPConnection] = []
        self._ssl_ctx: ssl.SSLContext | None = None
        self._proxy_cache: dict[tuple[str, ...], str] = {}
        self._cooldown_until: float = 0.0
        self._next_connect_ts: float = 0.0
        self._next_global_req_ts: float = 0.0
        self._connect_stagger_s: float = max(0.0, float(connect_stagger_seconds))
        self._ewma_latency_s: float = 0.0
        self._adaptive_delay_s: float = 0.0
        self._clean_streak: int = 0
        self._soft_anomaly_ts: deque[float] = deque()

    def _get_ssl_context(self) -> ssl.SSLContext:
        with self._lock:
            if self._ssl_ctx is None:
                self._ssl_ctx = ssl.create_default_context()
            return self._ssl_ctx

    def _resolve_proxy(self, scheme: str, target_host: str) -> str:
        if target_host in ("127.0.0.1", "localhost", "::1"):
            return ""
        env_key = (
            scheme,
            target_host,
            os.environ.get("HTTPS_PROXY") or "",
            os.environ.get("https_proxy") or "",
            os.environ.get("HTTP_PROXY") or "",
            os.environ.get("http_proxy") or "",
            os.environ.get("NO_PROXY") or "",
            os.environ.get("no_proxy") or "",
        )
        cached = self._proxy_cache.get(env_key)
        if cached is not None:
            return cached
        resolved = ""
        bypassed = False
        try:
            bypassed = bool(urllib.request.proxy_bypass(target_host))
        except Exception:
            bypassed = False
        if not bypassed:
            if scheme == "https":
                resolved = (
                    env_key[2] or env_key[3] or env_key[4] or env_key[5]
                ).strip()
            else:
                resolved = (env_key[4] or env_key[5]).strip()
        with self._lock:
            if len(self._proxy_cache) > 64:
                self._proxy_cache.clear()
            self._proxy_cache[env_key] = resolved
        return resolved

    def _pace_cold_connect(
        self,
        target_host: str,
        clock_fn: Callable[[], float],
    ) -> None:
        """Escalona aperturas TCP/TLS en frío para evitar ráfagas SYN contra el servidor."""
        if self._connect_stagger_s <= 0.0 or target_host in (
            "127.0.0.1",
            "localhost",
            "::1",
        ):
            return
        with self._connect_gate_lock:
            now = clock_fn()
            wait_s = self._next_connect_ts - now
            if wait_s < 0.0:
                wait_s = 0.0
                self._next_connect_ts = now + self._connect_stagger_s
            else:
                self._next_connect_ts += self._connect_stagger_s
        if wait_s > 0.0:
            time.sleep(wait_s)

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

        conn._create_connection = _create_ipv4_preferred_socket  # type: ignore[assignment]
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

    def discard_tls_session(self) -> None:
        """Cierra la conexión Keep-Alive y descarta la cookie JSESSIONID del hilo actual."""
        self._discard_tls_conn()
        self._tls.cookies = {}

    def get_adaptive_delay(self) -> float:
        return self._adaptive_delay_s

    def pace_global_rate(
        self,
        max_rps: float,
        clock_fn: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        """Limita de forma global el caudal agregado entre hilos para no saturar MINETUR."""
        if max_rps <= 0.0:
            return
        min_interval = 1.0 / float(max_rps)
        with self._rate_gate_lock:
            now = clock_fn()
            wait_s = self._next_global_req_ts - now
            if wait_s <= 0.0:
                wait_s = 0.0
                self._next_global_req_ts = now + min_interval
            else:
                self._next_global_req_ts += min_interval
        if wait_s > 0.0:
            sleep_fn(wait_s)

    def _align_rate_gate_to_cooldown(self, target_ts: float) -> None:
        with self._rate_gate_lock:
            if target_ts > self._next_global_req_ts:
                self._next_global_req_ts = target_ts

    def _record_success_latency(self, duration_s: float) -> None:
        if duration_s < 0.0:
            return
        with self._lock:
            if self._ewma_latency_s <= 0.0:
                self._ewma_latency_s = duration_s
            else:
                self._ewma_latency_s = (0.9 * self._ewma_latency_s) + (0.1 * duration_s)

            if self._ewma_latency_s > ADAPTIVE_LATENCY_HIGH_S:
                self._adaptive_delay_s = min(
                    ADAPTIVE_MAX_EXTRA_DELAY_S,
                    max(0.02, self._adaptive_delay_s + 0.01),
                )
                self._clean_streak = 0
            elif (
                self._adaptive_delay_s > 0.0
                and self._ewma_latency_s < ADAPTIVE_LATENCY_RECOVER_S
            ):
                self._clean_streak += 1
                if self._clean_streak >= 32:
                    self._adaptive_delay_s = max(
                        0.0, (self._adaptive_delay_s * 0.75) - 0.005
                    )
                    self._clean_streak = 0

    def _record_congestion_event(
        self,
        *,
        bump_delay_s: float,
        cooldown_s: float = 0.0,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        cooldown_target = 0.0
        with self._lock:
            self._adaptive_delay_s = min(
                ADAPTIVE_MAX_EXTRA_DELAY_S,
                max(bump_delay_s, (self._adaptive_delay_s * 1.5) + bump_delay_s),
            )
            self._clean_streak = 0
            if cooldown_s > 0.0:
                clamped = max(0.5, min(15.0, float(cooldown_s)))
                target_ts = clock_fn() + clamped
                if target_ts > self._cooldown_until:
                    self._cooldown_until = target_ts
                    cooldown_target = target_ts
        if cooldown_target > 0.0:
            self._align_rate_gate_to_cooldown(cooldown_target)

    def record_throttle_signal(
        self,
        wait_seconds: float,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        clamped = max(0.5, min(15.0, float(wait_seconds)))
        target_ts = clock_fn() + clamped
        cooldown_target = 0.0
        with self._lock:
            if target_ts > self._cooldown_until:
                self._cooldown_until = target_ts
                cooldown_target = target_ts
            self._adaptive_delay_s = min(
                ADAPTIVE_MAX_EXTRA_DELAY_S,
                max(0.05, (self._adaptive_delay_s * 1.5) + 0.03),
            )
            self._clean_streak = 0
        if cooldown_target > 0.0:
            self._align_rate_gate_to_cooldown(cooldown_target)

    def record_soft_anomaly(
        self,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> tuple[int, bool]:
        """
        Registra una respuesta HTTP 200 anómala (HTML de error/truncado o vaciado
        sospechoso de concesiones previas) y dispara enfriamiento global si detecta ráfaga.
        """
        now = clock_fn()
        cutoff = now - SOFT_ANOMALY_WINDOW_S
        cooldown_target = 0.0
        with self._lock:
            while self._soft_anomaly_ts and self._soft_anomaly_ts[0] < cutoff:
                self._soft_anomaly_ts.popleft()
            self._soft_anomaly_ts.append(now)
            recent_count = len(self._soft_anomaly_ts)
            self._adaptive_delay_s = min(
                ADAPTIVE_MAX_EXTRA_DELAY_S,
                max(0.05, (self._adaptive_delay_s * 1.5) + 0.04),
            )
            self._clean_streak = 0
            burst_active = recent_count >= SOFT_ANOMALY_BURST_THRESHOLD
            if burst_active:
                cooldown_s = min(
                    15.0,
                    3.0 + float(recent_count - SOFT_ANOMALY_BURST_THRESHOLD + 1) * 2.0,
                )
                target_ts = now + cooldown_s
                if target_ts > self._cooldown_until:
                    self._cooldown_until = target_ts
                    cooldown_target = target_ts
        if cooldown_target > 0.0:
            self._align_rate_gate_to_cooldown(cooldown_target)
        return recent_count, burst_active

    def has_recent_soft_anomaly_burst(
        self,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> bool:
        now = clock_fn()
        cutoff = now - SOFT_ANOMALY_WINDOW_S
        with self._lock:
            while self._soft_anomaly_ts and self._soft_anomaly_ts[0] < cutoff:
                self._soft_anomaly_ts.popleft()
            return len(self._soft_anomaly_ts) >= SOFT_ANOMALY_BURST_THRESHOLD

    def seconds_until_soft_anomaly_burst_clears(
        self,
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> float:
        now = clock_fn()
        cutoff = now - SOFT_ANOMALY_WINDOW_S
        with self._lock:
            while self._soft_anomaly_ts and self._soft_anomaly_ts[0] < cutoff:
                self._soft_anomaly_ts.popleft()
            if len(self._soft_anomaly_ts) < SOFT_ANOMALY_BURST_THRESHOLD:
                return 0.0
            drop_idx = len(self._soft_anomaly_ts) - SOFT_ANOMALY_BURST_THRESHOLD
            target_ts = self._soft_anomaly_ts[drop_idx] + SOFT_ANOMALY_WINDOW_S
            return max(0.0, target_ts - now)

    def wait_if_cooled_down(
        self,
        clock_fn: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], None] = time.sleep,
        *,
        jitter_max: float = 0.0,
    ) -> None:
        if self._cooldown_until <= 0.0:
            return
        while True:
            until = self._cooldown_until
            remaining = until - clock_fn()
            if remaining <= 0.0:
                return
            extra_jitter = (
                random.uniform(0.0, jitter_max) if jitter_max > 0.0 else 0.0
            )
            sleep_fn(remaining + extra_jitter)

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
        cookie_key = (scheme, target_host, target_port)
        host_header = (
            target_host
            if (scheme == "https" and target_port == 443)
            or (scheme == "http" and target_port == 80)
            else f"{target_host}:{target_port}"
        )
        has_explicit_cookie = any(k.lower() == "cookie" for k in headers)

        for is_fresh_attempt in (False, True):
            conn: http.client.HTTPConnection | None = getattr(self._tls, "conn", None)
            reused = conn is not None and getattr(self._tls, "conn_key", None) == conn_key
            if not reused:
                if conn is not None:
                    self._discard_tls_conn()
                self._pace_cold_connect(target_host, clock_fn)
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
            if not has_explicit_cookie:
                cookies_map: dict[tuple[str, str, int], str] | None = getattr(
                    self._tls, "cookies", None
                )
                if cookies_map:
                    cached_cookie = cookies_map.get(cookie_key)
                    if cached_cookie:
                        req_headers["Cookie"] = cached_cookie

            req_start_ts = clock_fn()
            try:
                assert conn is not None
                conn.request("GET", req_target, headers=req_headers)
                resp = conn.getresponse()
                raw_bytes = resp.read()
                session_cookie = _extract_jsessionid_cookie(resp.headers)
                if session_cookie:
                    cookies_map = getattr(self._tls, "cookies", None)
                    if cookies_map is None:
                        cookies_map = {}
                        self._tls.cookies = cookies_map
                    cookies_map[cookie_key] = session_cookie
                conn_hdr = (resp.getheader("Connection") or "").lower()
                if resp.will_close or "close" in conn_hdr:
                    self._discard_tls_conn()
            except _STALE_KEEPALIVE_ERRORS:
                self._discard_tls_conn()
                if reused and not is_fresh_attempt:
                    # Socket Keep-Alive cerrado en servidor tras inactividad -> reabrir de inmediato
                    continue
                self.discard_tls_session()
                self._record_congestion_event(bump_delay_s=0.02, clock_fn=clock_fn)
                raise
            except (
                http.client.HTTPException,
                ssl.SSLError,
                TimeoutError,
                OSError,
            ) as exc:
                self.discard_tls_session()
                if isinstance(exc, TimeoutError):
                    self._record_congestion_event(
                        bump_delay_s=0.03,
                        cooldown_s=1.0,
                        clock_fn=clock_fn,
                    )
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
                    self.discard_tls_session()
                    retry_after_hdr = (resp.getheader("Retry-After") or "").strip()
                    wait_s = 2.0
                    if retry_after_hdr:
                        try:
                            wait_s = float(retry_after_hdr)
                        except ValueError:
                            wait_s = 2.0
                    self.record_throttle_signal(wait_s, clock_fn=clock_fn)
                elif resp.status in (500, 502, 504):
                    self.discard_tls_session()
                    self._record_congestion_event(
                        bump_delay_s=0.03,
                        cooldown_s=1.0,
                        clock_fn=clock_fn,
                    )
                raise urllib.error.HTTPError(
                    url,
                    resp.status,
                    resp.reason,
                    resp.headers,
                    io.BytesIO(raw_bytes),
                )

            self._record_success_latency(clock_fn() - req_start_ts)
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


def _build_operator_spatial_grid(
    records: list[dict[str, Any]],
    op: str,
    max_distance_m: float,
) -> tuple[dict[tuple[int, int], list[tuple[float, float]]], float]:
    cell_deg = max(0.0006, (max_distance_m / 111320.0) / 0.65)
    grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for rec in records:
        if _normalize_operator_key(rec.get("op"), rec.get("opRaw")) != op:
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


def _build_vodafone_spatial_grid(
    records: list[dict[str, Any]],
    max_distance_m: float = DEFAULT_VODAFONE_FUSION_M,
) -> tuple[dict[tuple[int, int], list[tuple[float, float]]], float]:
    return _build_operator_spatial_grid(records, op="vodafone", max_distance_m=max_distance_m)


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

        prior_records = (
            list((prior_index.get("by_id") or {}).values())
            if isinstance(prior_index, dict)
            else []
        )
        self._provisional_voda_grid, self._provisional_voda_cell_deg = (
            _build_vodafone_spatial_grid(prior_records)
        )
        self._provisional_orange_grid, self._provisional_orange_cell_deg = (
            _build_operator_spatial_grid(
                prior_records,
                op="orange",
                max_distance_m=DEFAULT_XFERA_ORANGE_FUSION_M,
            )
        )
        self._provisional_orange_gids: set[str] = {
            g
            for r in prior_records
            if _normalize_operator_key(r.get("op"), r.get("opRaw")) == "orange"
            for g in get_record_gids(r)
        }
        self._provisional_exact_op_coords: set[tuple[str, str, float, float]] = set()
        for r in prior_records:
            exact_key = _same_operator_exact_coord_key(r)
            if exact_key is not None:
                self._provisional_exact_op_coords.add(exact_key)

    def load_checkpoint(self) -> bool:
        if not self.checkpoint_path or not self.checkpoint_path.exists():
            return False
        try:
            raw = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
            for rec in raw.get("records", []):
                if isinstance(rec, dict) and "id" in rec:
                    norm_rec = dict(rec)
                    norm_rec["op"] = _normalize_operator_key(
                        norm_rec.get("op"), norm_rec.get("opRaw")
                    )
                    self.records_by_id[norm_rec["id"]] = norm_rec
                    exact_key = _same_operator_exact_coord_key(norm_rec)
                    if exact_key is not None:
                        self._provisional_exact_op_coords.add(exact_key)
                    if norm_rec["op"] == "orange":
                        for g in get_record_gids(norm_rec):
                            self._provisional_orange_gids.add(g)
                        try:
                            lat_f = float(norm_rec["lat"])
                            lon_f = float(norm_rec["lon"])
                            cx = math.floor(lat_f / self._provisional_orange_cell_deg)
                            cy = math.floor(lon_f / self._provisional_orange_cell_deg)
                            self._provisional_orange_grid.setdefault((cx, cy), []).append(
                                (lat_f, lon_f)
                            )
                        except (KeyError, TypeError, ValueError):
                            pass
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
            "savedAt": _utc_now_iso(self._now_utc),
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
        self._http_client.wait_if_cooled_down(self._clock, self._sleep)
        if self._last_request_ts is not None and self.delay_seconds > 0:
            elapsed = self._clock() - self._last_request_ts
            remaining = self.delay_seconds - elapsed
            if remaining > 0:
                self._sleep(remaining)

    def _wait_worker_rate_limit(self) -> None:
        jitter_max = 0.35 if self._sleep is time.sleep else 0.0
        self._http_client.wait_if_cooled_down(
            self._clock, self._sleep, jitter_max=jitter_max
        )
        adaptive_delay = self._http_client.get_adaptive_delay()
        if adaptive_delay > 0.0:
            last_done_ts: float | None = getattr(self._worker_tls, "last_done_ts", None)
            if last_done_ts is not None:
                rem_adapt = adaptive_delay - (self._clock() - last_done_ts)
                if rem_adapt > 0.0:
                    self._sleep(rem_adapt)
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

            req_start_ts = self._clock()
            if self._custom_fetch_fn is not None:
                try:
                    features = self._custom_fetch_fn(bbox, self.zoom)
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                        self._worker_tls.last_done_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    return features
                except Exception as exc:
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                        self._worker_tls.last_done_ts = now_ts
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
                        self._worker_tls.last_done_ts = now_ts
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
                        self._worker_tls.last_done_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    last_err = exc

            if isinstance(last_err, urllib.error.HTTPError) and last_err.code in (
                400,
                401,
                403,
                404,
                410,
            ):
                break

            if attempt < len(backoffs) - 1:
                wait_s = backoffs[attempt]
                if self._sleep is time.sleep:
                    wait_s += random.uniform(0.0, 0.4)
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
        records_by_id = self.records_by_id

        for feat in features:
            if isinstance(feat, dict):
                fast_id = feat.get("id")
                if isinstance(fast_id, str):
                    fast_id_clean = fast_id.strip()
                    if fast_id_clean and fast_id_clean in records_by_id:
                        continue
            rec = parse_feature(feat)
            if rec is None:
                continue
            rec_id = rec["id"]
            is_first_seen = rec_id not in records_by_id
            if is_first_seen:
                added += 1
            records_by_id[rec_id] = rec

            if (
                is_first_seen
                and self._live_stream is not None
                and self._prior_index is not None
                and match_prior_antenna(rec, self._prior_index) is None
            ):
                exact_coord_key = _same_operator_exact_coord_key(rec)
                if (
                    exact_coord_key is not None
                    and exact_coord_key in self._provisional_exact_op_coords
                ):
                    continue
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
                elif rec["op"] == "orange":
                    lat_f = float(rec["lat"])
                    lon_f = float(rec["lon"])
                    gid_str = str(rec.get("gid") or "").strip()
                    if is_xfera_entity(rec["opRaw"]):
                        if (
                            gid_str and gid_str in self._provisional_orange_gids
                        ) or _is_near_vodafone_grid(
                            lat_f,
                            lon_f,
                            self._provisional_orange_grid,
                            self._provisional_orange_cell_deg,
                            max_distance_m=DEFAULT_XFERA_ORANGE_FUSION_M,
                        ):
                            continue
                    elif gid_str and gid_str in self._provisional_orange_gids:
                        continue
                    cx = math.floor(lat_f / self._provisional_orange_cell_deg)
                    cy = math.floor(lon_f / self._provisional_orange_cell_deg)
                    self._provisional_orange_grid.setdefault((cx, cy), []).append(
                        (lat_f, lon_f)
                    )
                    if gid_str:
                        self._provisional_orange_gids.add(gid_str)

                if exact_coord_key is not None:
                    self._provisional_exact_op_coords.add(exact_coord_key)
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

        def _enqueue_or_expand(
            bbox: BBox,
            depth: int,
            *,
            prioritize_front: bool = False,
        ) -> None:
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
                    children = subdivide_bbox(bbox)
                    if prioritize_front:
                        for child_bbox in reversed(children):
                            _enqueue_or_expand(
                                child_bbox, depth + 1, prioritize_front=True
                            )
                    else:
                        for child_bbox in children:
                            _enqueue_or_expand(child_bbox, depth + 1)
                else:
                    self.completed_leaf_boxes.add(key)
                return
            enqueued_keys.add(key)
            if prioritize_front:
                pending_queue.appendleft((bbox, depth, key))
            else:
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
                        # Priorizar cuadrantes subdivididos (deepest-first) para evitar cola secuencial en zonas urbanas densas
                        for child_bbox in reversed(subdivide_bbox(bbox)):
                            _enqueue_or_expand(
                                child_bbox, depth + 1, prioritize_front=True
                            )
                    else:
                        self.completed_leaf_boxes.add(key)

                while pending_queue and len(in_flight) < max_in_flight:
                    item = pending_queue.popleft()
                    fut = executor.submit(self._http_fetch_bbox, item[0], parallel_mode=True)
                    in_flight[fut] = item

                now = self._clock()
                elapsed_s = max(0.001, now - run_start_ts)
                with self._stats_lock:
                    cur_reqs = self.requests_count
                    unsaved_reqs = self._unsaved_requests
                rps = round(cur_reqs / elapsed_s, 2)
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
                    and unsaved_reqs >= self.checkpoint_every
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
        return build_dataset(
            self.records_by_id,
            crawl_stats=crawl_stats,
            updated_at=_utc_now_iso(self._now_utc),
            prior_index=self._prior_index,
        )

    def _fetch_bbox_strict_calm(self, bbox: BBox) -> list[dict[str, Any]]:
        """
        Consulta una micro-celda GeoJSON en calma con sesión TLS limpia y decodificación
        estricta para confirmar si una antena desaparecida realmente ya no figura en MINETUR.
        """
        url = build_bbox_url(bbox, zoom=self.zoom)
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) WebDeAntenasSpainCrawler/1.0"
            ),
            "Accept": "application/json, text/plain, */*",
        }
        backoffs = (1.0, 2.0)
        last_err: Exception | None = None

        for attempt in range(len(backoffs)):
            self._http_client.discard_tls_session()
            self._wait_rate_limit()
            with self._stats_lock:
                self.requests_count += 1
            try:
                if self._custom_fetch_fn is not None:
                    features = self._custom_fetch_fn(bbox, self.zoom)
                    self._last_request_ts = self._clock()
                    if not isinstance(features, list):
                        raise ValueError("Respuesta GeoJSON inválida en verificación")
                    return features
                raw_bytes = self._http_client.fetch_bytes(
                    url,
                    headers=headers,
                    timeout=self.timeout_seconds,
                    clock_fn=self._clock,
                )
                self._last_request_ts = self._clock()
                return decode_infoantenas_payload_strict(raw_bytes)
            except Exception as exc:
                self._last_request_ts = self._clock()
                self._http_client.discard_tls_session()
                last_err = exc
                if isinstance(exc, urllib.error.HTTPError) and exc.code in (
                    400,
                    401,
                    403,
                    404,
                    410,
                ):
                    break
                if attempt < len(backoffs) - 1:
                    self._sleep(backoffs[attempt])

        raise RuntimeError(
            f"Error al verificar micro-celda bbox={format_bbox_key(bbox)}: {last_err}"
        ) from last_err

    def verify_missing_antennas(
        self,
        missing_records: list[dict[str, Any]],
        *,
        pad_deg: float = MISSING_ANTENNA_MICRO_BBOX_PAD_DEG,
        empty_confirmations: int = MISSING_ANTENNA_EMPTY_CONFIRMATIONS,
        max_verify: int = MISSING_ANTENNA_VERIFY_MAX,
    ) -> tuple[list[dict[str, Any]], set[str]]:
        """
        Verifica en modo secuencial calmado las estaciones candidatas a baja del censo
        nacional antes de eliminarlas de `antenas.json` (mapa y estadísticas):
        - Si una estación reaparece en su micro-celda GeoJSON -> se restaura (falsa baja).
        - Si ocurre cualquier error HTTP/JSON/red o truncamiento (>= 1000) -> se preserva
          la estación previa para que un error de MINETUR jamás borre antenas reales.
        - Si la micro-celda devuelve un GeoJSON sano y la estación sigue ausente (y con
          doble comprobación limpia si la micro-celda está totalmente vacía) -> baja real
          confirmada; queda eliminada de `antenas.json` y se registra en `eliminaciones.json`.
        Devuelve `(registros_restaurados_o_preservados, ids_baja_confirmada)`.
        """
        if not missing_records:
            return [], set()

        if len(missing_records) > max_verify:
            logging.warning(
                "Se detectaron %d antenas ausentes del censo (> límite verificable %d); "
                "se preservan los registros previos para evitar borrados falsos por fallo parcial de MINETUR.",
                len(missing_records),
                max_verify,
            )
            return [dict(r) for r in missing_records], set()

        restored_records: list[dict[str, Any]] = []
        confirmed_removed_ids: set[str] = set()
        clusters: list[tuple[list[float], list[dict[str, Any]]]] = []
        max_cluster_span = max(pad_deg * 8.0, 0.08)

        for old_rec in missing_records:
            lat = _parse_float(old_rec.get("lat"))
            lon = _parse_float(old_rec.get("lon"))
            if lat is None or lon is None:
                restored_records.append(dict(old_rec))
                continue
            r_min_lon = lon - pad_deg
            r_min_lat = lat - pad_deg
            r_max_lon = lon + pad_deg
            r_max_lat = lat + pad_deg

            placed = False
            for c_box, c_recs in clusters:
                if (
                    r_min_lon <= c_box[2]
                    and r_max_lon >= c_box[0]
                    and r_min_lat <= c_box[3]
                    and r_max_lat >= c_box[1]
                ):
                    new_min_lon = min(c_box[0], r_min_lon)
                    new_min_lat = min(c_box[1], r_min_lat)
                    new_max_lon = max(c_box[2], r_max_lon)
                    new_max_lat = max(c_box[3], r_max_lat)
                    if (new_max_lon - new_min_lon) <= max_cluster_span and (
                        new_max_lat - new_min_lat
                    ) <= max_cluster_span:
                        c_box[0] = new_min_lon
                        c_box[1] = new_min_lat
                        c_box[2] = new_max_lon
                        c_box[3] = new_max_lat
                        c_recs.append(old_rec)
                        placed = True
                        break
            if not placed:
                clusters.append(([r_min_lon, r_min_lat, r_max_lon, r_max_lat], [old_rec]))

        needed_empty_checks = max(1, int(empty_confirmations))
        try:
            if clusters and self._sleep is time.sleep:
                self._sleep(0.5)
            for cluster_idx, (c_box, c_recs) in enumerate(clusters):
                if cluster_idx > 0 and self._sleep is time.sleep:
                    self._sleep(0.3)
                micro_bbox: BBox = (c_box[0], c_box[1], c_box[2], c_box[3])
                try:
                    features = self._fetch_bbox_strict_calm(micro_bbox)
                    if len(features) == 0 and needed_empty_checks > 1:
                        for _ in range(needed_empty_checks - 1):
                            if self._sleep is time.sleep:
                                self._sleep(0.5)
                            features = self._fetch_bbox_strict_calm(micro_bbox)
                            if len(features) > 0:
                                break
                except RuntimeError as exc:
                    logging.warning(
                        "No se pudo verificar ausencia de %d antena(s) en bbox=%s (se preservan registros previos): %s",
                        len(c_recs),
                        format_bbox_key(micro_bbox),
                        exc,
                    )
                    restored_records.extend(dict(r) for r in c_recs)
                    continue

                if len(features) >= SERVER_FEATURE_CAP:
                    logging.warning(
                        "Micro-celda bbox=%s alcanzó el tope de %d features al verificar %d antena(s); se preservan registros previos.",
                        format_bbox_key(micro_bbox),
                        SERVER_FEATURE_CAP,
                        len(c_recs),
                    )
                    restored_records.extend(dict(r) for r in c_recs)
                    continue

                found_by_id: dict[str, dict[str, Any]] = {}
                found_by_op_gid: dict[tuple[str, str], list[dict[str, Any]]] = {}
                for feat in features:
                    parsed = parse_feature(feat)
                    if parsed is None:
                        continue
                    found_by_id[parsed["id"]] = parsed
                    p_op = _normalize_operator_key(parsed.get("op"), parsed.get("opRaw"))
                    if p_op:
                        for g in get_record_gids(parsed):
                            found_by_op_gid.setdefault((p_op, g), []).append(parsed)

                for old_rec in c_recs:
                    old_id = str(old_rec.get("id") or "").strip()
                    old_op = _normalize_operator_key(
                        old_rec.get("op"), old_rec.get("opRaw")
                    )
                    old_gids = get_record_gids(old_rec)
                    matched_fresh: list[dict[str, Any]] = []
                    seen_fresh_ids: set[str] = set()
                    if old_id in found_by_id:
                        fresh = found_by_id[old_id]
                        seen_fresh_ids.add(fresh["id"])
                        matched_fresh.append(fresh)
                    if old_op:
                        for g in old_gids:
                            for fresh in found_by_op_gid.get((old_op, g), ()):
                                if fresh["id"] not in seen_fresh_ids:
                                    seen_fresh_ids.add(fresh["id"])
                                    matched_fresh.append(fresh)

                    if matched_fresh:
                        restored_records.extend(matched_fresh)
                    elif old_id:
                        confirmed_removed_ids.add(old_id)
        finally:
            self._http_client.close_all()

        logging.info(
            "Verificación de antenas ausentes completada: %d bajas reales confirmadas, %d restauradas/preservadas (%d micro-celdas consultadas).",
            len(confirmed_removed_ids),
            len(restored_records),
            len(clusters),
        )
        return restored_records, confirmed_removed_ids


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
    Las estaciones de otros operadores no se modifican en este pase (la fusión de
    duplicados en la misma coordenada exacta para todas las operadoras se aplica en
    `fuse_same_operator_exact_coords`).

    Conserva 1 única estación canónica por componente conexa (manteniendo sus
    coordenadas reales WGS84 `lat`, `lon` para garantizar que ningún par de
    representantes distintos quede jamás a `< max_distance_m`), rellena `mergedGids`
    cuando se fusionan `> 1` declaraciones y devuelve `(registros_fusionados, duplicados_eliminados)`.
    """
    def _copy_with_normalized_bands(item: dict[str, Any]) -> dict[str, Any]:
        copied = dict(item)
        if isinstance(copied.get("mergedGids"), list):
            copied["mergedGids"] = list(copied["mergedGids"])
        if isinstance(copied.get("bandas"), list):
            copied["bandas"] = normalize_band_labels(copied["bandas"])
        if isinstance(copied.get("frecuencias"), list):
            copied["frecuencias"] = list(copied["frecuencias"])
        if isinstance(copied.get("concesiones"), list):
            copied["concesiones"] = [
                dict(c) for c in copied["concesiones"] if isinstance(c, dict)
            ]
        return copied

    if max_distance_m <= 0.0 or len(records) <= 1:
        return [_copy_with_normalized_bands(r) for r in records], 0

    voda_records: list[dict[str, Any]] = []
    voda_pos_by_record_idx: dict[int, int] = {}
    for rec_idx, rec in enumerate(records):
        if rec.get("op") == "vodafone":
            voda_pos_by_record_idx[rec_idx] = len(voda_records)
            voda_records.append(rec)

    n_voda = len(voda_records)
    if n_voda <= 1:
        return [_copy_with_normalized_bands(r) for r in records], 0

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
            merged_by_root[root] = _copy_with_normalized_bands(comp_members[0])
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
                bandas_u = normalize_band_labels(extra_bands)
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
            output_records.append(_copy_with_normalized_bands(rec))
            continue
        root = find(voda_k)
        if root not in emitted_roots:
            emitted_roots.add(root)
            output_records.append(merged_by_root[root])

    return output_records, fused_duplicates


def fuse_xfera_into_orange(
    records: list[dict[str, Any]],
    max_distance_m: float = DEFAULT_XFERA_ORANGE_FUSION_M,
) -> tuple[list[dict[str, Any]], int]:
    """
    Integra todas las declaraciones de Xfera Móviles / Grupo MásMóvil / Yoigo dentro de Orange:
    1) Normaliza cualquier registro con `op == "masmovil"` o `is_xfera_entity(opRaw)` a `op = "orange"`.
    2) Fase A (mismo `gid` exacto): fusiona siempre cualquier par de registros `op == "orange"` que
       compartan el mismo `gid` no vacío (ej. `ANDR9085A`).
    3) Fase B (`< max_distance_m`, por defecto 30.0 m): une por enlace completo (`complete-linkage`)
       registros co-ubicados donde al menos un extremo sea Xfera (`is_xfera_entity(opRaw)`), impidiendo
       estrictamente unir dos componentes que ya contengan estaciones nativas `ORANGE ESPAGNE` con
       `gid` distinto (ni siquiera de forma transitiva a través de un nodo Xfera).
    4) Conserva los emplazamientos independientes de Xfera (`>= 30 m` de cualquier estación Orange)
       como estaciones `op = "orange"` con todas sus bandas, frecuencias y concesiones intactas.
    """
    def _is_xfera_origin(item: dict[str, Any]) -> bool:
        return str(item.get("op") or "").strip() == "masmovil" or is_xfera_entity(
            str(item.get("opRaw") or "")
        )

    def _copy_normalized(item: dict[str, Any]) -> dict[str, Any]:
        copied = dict(item)
        copied["op"] = _normalize_operator_key(copied.get("op"), copied.get("opRaw"))
        if isinstance(copied.get("mergedGids"), list):
            copied["mergedGids"] = list(copied["mergedGids"])
        if isinstance(copied.get("bandas"), list):
            copied["bandas"] = normalize_band_labels(copied["bandas"])
        if isinstance(copied.get("frecuencias"), list):
            copied["frecuencias"] = list(copied["frecuencias"])
        if isinstance(copied.get("concesiones"), list):
            copied["concesiones"] = [
                dict(c) for c in copied["concesiones"] if isinstance(c, dict)
            ]
        return copied

    if len(records) <= 1:
        return [_copy_normalized(r) for r in records], 0

    orange_records: list[dict[str, Any]] = []
    is_native_list: list[bool] = []
    orange_pos_by_record_idx: dict[int, int] = {}
    for rec_idx, rec in enumerate(records):
        eff_op = _normalize_operator_key(rec.get("op"), rec.get("opRaw"))
        if eff_op == "orange":
            orange_pos_by_record_idx[rec_idx] = len(orange_records)
            is_native_list.append(not _is_xfera_origin(rec))
            orange_records.append(rec)

    n_orange = len(orange_records)
    if n_orange <= 1:
        return [_copy_normalized(r) for r in records], 0

    parent = list(range(n_orange))
    comp_members_idx: dict[int, list[int]] = {i: [i] for i in range(n_orange)}
    comp_has_native_orange: dict[int, bool] = {
        i: is_native_list[i] for i in range(n_orange)
    }

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

    def union_roots(a: int, b: int) -> None:
        ra = find(a)
        rb = find(b)
        if ra == rb:
            return
        if ra > rb:
            ra, rb = rb, ra
        parent[rb] = ra
        comp_members_idx[ra].extend(comp_members_idx.pop(rb))
        comp_has_native_orange[ra] = (
            comp_has_native_orange[ra] or comp_has_native_orange.pop(rb)
        )

    # Fase A — Unión exacta por mismo GID no vacío
    first_idx_by_gid: dict[str, int] = {}
    for k, rec in enumerate(orange_records):
        for g in get_record_gids(rec):
            if g in first_idx_by_gid:
                union_roots(first_idx_by_gid[g], k)
            else:
                first_idx_by_gid[g] = k

    # Fase B — Unión espacial < max_distance_m (30.0 m) para co-ubicaciones Xfera
    if max_distance_m > 0.0 and not all(is_native_list):
        lats = [float(r["lat"]) for r in orange_records]
        lons = [float(r["lon"]) for r in orange_records]
        ids = [str(r.get("id") or "").strip() for r in orange_records]
        cell_deg = max(0.0006, (max_distance_m / 111320.0) / 0.65)
        grid: dict[tuple[int, int], list[int]] = {}
        for k in range(n_orange):
            cx = math.floor(lats[k] / cell_deg)
            cy = math.floor(lons[k] / cell_deg)
            grid.setdefault((cx, cy), []).append(k)

        seen_pairs: set[tuple[int, int]] = set()
        candidate_edges: list[tuple[float, str, str, int, int]] = []
        for k in range(n_orange):
            if is_native_list[k]:
                continue
            lat_k = lats[k]
            lon_k = lons[k]
            cx = math.floor(lat_k / cell_deg)
            cy = math.floor(lon_k / cell_deg)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    bucket = grid.get((cx + dx, cy + dy))
                    if not bucket:
                        continue
                    for other_k in bucket:
                        if other_k == k:
                            continue
                        a, b = (k, other_k) if k < other_k else (other_k, k)
                        if (a, b) in seen_pairs:
                            continue
                        seen_pairs.add((a, b))
                        if find(a) == find(b):
                            continue
                        dist = haversine_m(lats[a], lons[a], lats[b], lons[b])
                        if dist < max_distance_m:
                            id_lo, id_hi = (
                                (ids[a], ids[b])
                                if ids[a] <= ids[b]
                                else (ids[b], ids[a])
                            )
                            candidate_edges.append((dist, id_lo, id_hi, a, b))

        candidate_edges.sort()
        for _, _, _, a, b in candidate_edges:
            ra = find(a)
            rb = find(b)
            if ra == rb:
                continue
            if comp_has_native_orange[ra] and comp_has_native_orange[rb]:
                continue
            members_a = comp_members_idx[ra]
            members_b = comp_members_idx[rb]
            if all(
                haversine_m(lats[u], lons[u], lats[v], lons[v]) < max_distance_m
                for u in members_a
                for v in members_b
            ):
                union_roots(ra, rb)

    merged_by_root: dict[int, dict[str, Any]] = {}
    fused_duplicates = 0

    for root, member_indices in comp_members_idx.items():
        if len(member_indices) == 1:
            merged_by_root[root] = _copy_normalized(orange_records[member_indices[0]])
            continue

        fused_duplicates += len(member_indices) - 1
        sorted_indices = sorted(
            member_indices,
            key=lambda idx: (
                0 if is_native_list[idx] else 1,
                _vodafone_canonical_sort_key(orange_records[idx]),
            ),
        )
        sorted_members = [orange_records[idx] for idx in sorted_indices]
        merged_rec = dict(sorted_members[0])
        merged_rec["op"] = "orange"

        for member in sorted_members[1:]:
            if not str(merged_rec.get("gid") or "").strip() and str(
                member.get("gid") or ""
            ).strip():
                merged_rec["gid"] = str(member["gid"]).strip()
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

        if len(merged_gids) > 1:
            merged_rec["mergedGids"] = merged_gids
        else:
            merged_rec.pop("mergedGids", None)

        if all(isinstance(m.get("bandas"), list) for m in sorted_members):
            combined_freqs: list[str] = []
            for member in sorted_members:
                for freq_item in member.get("frecuencias") or []:
                    if isinstance(freq_item, str):
                        combined_freqs.append(freq_item)
            bandas_from_freqs, freqs_u = summarize_frequency_ranges(combined_freqs)
            extra_bands = {
                str(b).strip()
                for member in sorted_members
                for b in (member.get("bandas") or [])
                if str(b).strip()
            }
            merged_rec["bandas"] = normalize_band_labels(
                set(bandas_from_freqs) | extra_bands
            )
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
        else:
            merged_rec.pop("concesiones", None)

        has_all_bands = isinstance(merged_rec.get("bandas"), list)
        has_partial_concs = any(
            isinstance(m.get("concesiones"), list) for m in sorted_members
        ) and not isinstance(merged_rec.get("concesiones"), list)
        if (
            has_all_bands
            and not has_partial_concs
            and all(
                isinstance(m.get("bandsScannedAt"), str) and m.get("bandsScannedAt")
                for m in sorted_members
            )
        ):
            merged_rec["bandsScannedAt"] = min(
                _normalize_iso_utc(str(m["bandsScannedAt"])) for m in sorted_members
            )
        else:
            merged_rec.pop("bandsScannedAt", None)

        merged_by_root[root] = merged_rec

    emitted_roots: set[int] = set()
    output_records: list[dict[str, Any]] = []
    for rec_idx, rec in enumerate(records):
        ora_k = orange_pos_by_record_idx.get(rec_idx)
        if ora_k is None:
            output_records.append(_copy_normalized(rec))
            continue
        root = find(ora_k)
        if root not in emitted_roots:
            emitted_roots.add(root)
            output_records.append(merged_by_root[root])

    return output_records, fused_duplicates


def _normalize_otros_op_raw(op_raw: str) -> str:
    """Normaliza la razón social de un operador en `'otros'` para identificar si es la misma operadora."""
    return " ".join(_strip_accents(str(op_raw or "").upper()).split()).strip()


def _same_operator_exact_coord_key(
    rec: dict[str, Any],
) -> tuple[str, str, float, float] | None:
    """
    Construye la clave determinista `(op, sub_op, lat, lon)` para detectar declaraciones
    de la misma operadora en la misma coordenada exacta WGS84.
    """
    lat = _parse_float(rec.get("lat"))
    lon = _parse_float(rec.get("lon"))
    if lat is None or lon is None:
        return None
    lat_norm = 0.0 if lat == 0.0 else lat
    lon_norm = 0.0 if lon == 0.0 else lon
    eff_op = _normalize_operator_key(rec.get("op"), rec.get("opRaw")) or "otros"
    sub_op = (
        _normalize_otros_op_raw(str(rec.get("opRaw") or ""))
        if eff_op == "otros"
        else ""
    )
    return (eff_op, sub_op, lat_norm, lon_norm)


def _exact_coord_canonical_sort_key(
    rec: dict[str, Any],
) -> tuple[int, int, int, int, int, int, int, str, str]:
    eff_op = _normalize_operator_key(rec.get("op"), rec.get("opRaw")) or "otros"
    is_xfera_rank = (
        1
        if eff_op == "orange"
        and (
            str(rec.get("op") or "").strip() == "masmovil"
            or is_xfera_entity(str(rec.get("opRaw") or ""))
        )
        else 0
    )
    gid = str(rec.get("gid") or "").strip()
    rec_id = str(rec.get("id") or "").strip()
    leading_zeros = _redundant_leading_zeros(gid) if eff_op == "vodafone" else 0
    has_dir = bool(str(rec.get("dir") or "").strip())
    has_mun = bool(str(rec.get("mun") or "").strip())
    prov_str = str(rec.get("prov") or "").strip()
    has_prov = bool(prov_str and prov_str != "SIN PROVINCIA")
    completeness = int(has_dir) + int(has_mun) + int(has_prov)
    return (
        is_xfera_rank,
        0 if gid else 1,
        leading_zeros,
        -completeness,
        0 if has_dir else 1,
        0 if has_mun else 1,
        0 if has_prov else 1,
        gid,
        rec_id,
    )


_N78_FREQ_NUM_TOKEN_RE = re.compile(r"\d+(?:[.,]\d+)?", re.ASCII)
_N78_GHZ_UNIT_RE = re.compile(r"ghz", re.IGNORECASE)
_N78_DIRECT_CODE_RE = re.compile(r"^n78(?:\s*\+)?$", re.IGNORECASE)


def _text_has_n78_band(raw: Any) -> bool:
    """Indica si una etiqueta de banda o rango de frecuencia corresponde a banda N78 (3500 MHz / 3,3–3,9 GHz)."""
    if not isinstance(raw, str):
        return False
    trimmed = raw.strip()
    if not trimmed:
        return False
    if _N78_DIRECT_CODE_RE.match(trimmed):
        return True
    m1 = _N78_FREQ_NUM_TOKEN_RE.search(trimmed)
    if m1 is None:
        return False
    m2 = _N78_FREQ_NUM_TOKEN_RE.search(trimmed, m1.end())
    try:
        a = float(m1.group(0).replace(",", "."))
        b = float(m2.group(0).replace(",", ".")) if m2 is not None else a
    except ValueError:
        return False
    if not (math.isfinite(a) and math.isfinite(b)):
        return False
    lo, hi = (a, b) if a <= b else (b, a)
    if _N78_GHZ_UNIT_RE.search(trimmed) and hi < 1000.0:
        lo *= 1000.0
        hi *= 1000.0
    return 3300.0 <= lo and hi <= 3900.0


def _entries_have_n78(entries: list[dict[str, Any]]) -> bool:
    """Indica si las concesiones extraídas de `detalleEstacion.do` para un GID incluyen banda N78 (3500 MHz)."""
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        banda = entry.get("banda")
        if isinstance(banda, str) and _text_has_n78_band(banda):
            return True
        min_mhz = _parse_float(entry.get("minMhz"))
        max_mhz = _parse_float(entry.get("maxMhz"))
        if min_mhz is not None and max_mhz is not None:
            lo, hi = (min_mhz, max_mhz) if min_mhz <= max_mhz else (max_mhz, min_mhz)
            if 3300.0 <= lo and hi <= 3900.0:
                return True
        freq_str = entry.get("frecuencia") or entry.get("frecuenciaDeclarada")
        if isinstance(freq_str, str) and _text_has_n78_band(freq_str):
            return True
    return False


def _record_own_rf_has_n78(rec: dict[str, Any]) -> bool:
    """Comprueba únicamente los campos RF propios (`bandas`, `frecuencias`, `concesiones`) de un registro."""
    bandas = rec.get("bandas")
    if isinstance(bandas, list):
        for item in bandas:
            if _text_has_n78_band(item):
                return True
    frecuencias = rec.get("frecuencias")
    if isinstance(frecuencias, list):
        for item in frecuencias:
            if _text_has_n78_band(item):
                return True
    concesiones = rec.get("concesiones")
    if isinstance(concesiones, list):
        for item in concesiones:
            if isinstance(item, dict) and _text_has_n78_band(item.get("freq")):
                return True
    return False


def _record_has_n78_band(
    rec: dict[str, Any],
    prior_index: dict[str, Any] | None = None,
) -> bool:
    """
    Indica si una estación tiene banda N78 (3500 MHz).
    Si el registro aún no tiene campos RF poblados (ej. fase de censo) y se proporciona
    `prior_index`, consulta únicamente una coincidencia exacta 1-a-1 (no fusionada con
    otros GIDs) en `prior_index` para preservar la separación de parejas Telefónica N78.
    """
    has_own_rf = (
        isinstance(rec.get("bandas"), list)
        or isinstance(rec.get("frecuencias"), list)
        or isinstance(rec.get("concesiones"), list)
    )
    if has_own_rf:
        return _record_own_rf_has_n78(rec)
    if prior_index is None:
        return False

    rec_gids = set(get_record_gids(rec))
    if not rec_gids:
        return False
    rec_op = _normalize_operator_key(rec.get("op"), rec.get("opRaw"))
    by_id: dict[str, dict[str, Any]] = prior_index.get("by_id") or {}
    rec_id = str(rec.get("id") or "").strip()
    cand = by_id.get(rec_id) if rec_id else None
    if cand is not None:
        if set(get_record_gids(cand)) == rec_gids:
            return _record_own_rf_has_n78(cand)
        return False
    if rec_op:
        all_by_op_gid: dict[tuple[str, str], list[dict[str, Any]]] = (
            prior_index.get("all_by_op_gid") or {}
        )
        by_op_gid: dict[tuple[str, str], dict[str, Any]] = (
            prior_index.get("by_op_gid") or {}
        )
        for g in rec_gids:
            cands = all_by_op_gid.get((rec_op, g))
            if not cands:
                single = by_op_gid.get((rec_op, g))
                cands = [single] if single is not None else []
            for old_rec in cands:
                if set(get_record_gids(old_rec)) == rec_gids:
                    return _record_own_rf_has_n78(old_rec)
    return False


def _should_skip_exact_coord_fusion_group(
    op_key: str,
    group: list[dict[str, Any]],
    prior_index: dict[str, Any] | None = None,
) -> bool:
    """
    Regla de excepción de Telefónica (Movistar): si 2 o más antenas de Telefónica
    en la misma coordenada exacta disponen cada una de banda N78 (3500 MHz), NO se fusionan.
    """
    if op_key != "movistar" or len(group) < 2:
        return False
    n78_count = 0
    for rec in group:
        if _record_has_n78_band(rec, prior_index=prior_index):
            n78_count += 1
            if n78_count >= 2:
                return True
    return False


def _needs_exact_coord_fusion(
    raw_list: list[dict[str, Any]],
    prior_index: dict[str, Any] | None = None,
) -> bool:
    """Comprueba en O(N) si existen declaraciones fusionables de la misma operadora en la misma coordenada exacta."""
    if len(raw_list) <= 1:
        return False
    groups: dict[tuple[str, str, float, float], list[dict[str, Any]]] = {}
    for rec in raw_list:
        if not isinstance(rec, dict):
            continue
        key = _same_operator_exact_coord_key(rec)
        if key is None:
            continue
        bucket = groups.get(key)
        if bucket is None:
            groups[key] = [rec]
        else:
            bucket.append(rec)
    for key, bucket in groups.items():
        if len(bucket) >= 2 and not _should_skip_exact_coord_fusion_group(
            key[0], bucket, prior_index=prior_index
        ):
            return True
    return False


def fuse_same_operator_exact_coords(
    records: list[dict[str, Any]],
    prior_index: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """
    Fusiona declaraciones duplicadas de cualquier misma operadora (incluyendo Orange,
    Telefónica/Movistar, Vodafone, DIGI y operadores regionales con idéntica razón social)
    declaradas en la MISMA coordenada exacta `(lat, lon)`.

    Excepción Telefónica: si 2 o más antenas de Telefónica en la misma coordenada exacta
    tienen banda N78 (3500 MHz) cada una, NO se fusionan y se mantienen como estaciones
    separadas.

    Las antenas de Telefónica, Orange nativo, DIGI u otros con coordenadas distintas
    (aunque disten pocos metros) jamás se fusionan en este pase.
    Devuelve `(registros_fusionados, duplicados_eliminados)` preservando el orden original.
    """
    def _copy_normalized(item: dict[str, Any]) -> dict[str, Any]:
        copied = dict(item)
        copied["op"] = _normalize_operator_key(copied.get("op"), copied.get("opRaw"))
        if isinstance(copied.get("mergedGids"), list):
            copied["mergedGids"] = list(copied["mergedGids"])
        if isinstance(copied.get("bandas"), list):
            copied["bandas"] = normalize_band_labels(copied["bandas"])
        if isinstance(copied.get("frecuencias"), list):
            copied["frecuencias"] = list(copied["frecuencias"])
        if isinstance(copied.get("concesiones"), list):
            copied["concesiones"] = [
                dict(c) for c in copied["concesiones"] if isinstance(c, dict)
            ]
        return copied

    if len(records) <= 1:
        return [_copy_normalized(r) for r in records], 0

    groups_by_key: dict[tuple[str, str, float, float], list[int]] = {}
    key_by_idx: dict[int, tuple[str, str, float, float]] = {}
    has_duplicates = False

    for idx, rec in enumerate(records):
        key = _same_operator_exact_coord_key(rec)
        if key is None:
            continue
        key_by_idx[idx] = key
        bucket = groups_by_key.get(key)
        if bucket is not None:
            bucket.append(idx)
            has_duplicates = True
        else:
            groups_by_key[key] = [idx]

    if not has_duplicates:
        return [_copy_normalized(r) for r in records], 0

    merged_by_key: dict[tuple[str, str, float, float], dict[str, Any]] = {}
    skipped_keys: set[tuple[str, str, float, float]] = set()
    fused_duplicates = 0

    for key, member_indices in groups_by_key.items():
        if len(member_indices) == 1:
            merged_by_key[key] = _copy_normalized(records[member_indices[0]])
            continue

        comp_members = [records[i] for i in member_indices]
        if _should_skip_exact_coord_fusion_group(
            key[0], comp_members, prior_index=prior_index
        ):
            skipped_keys.add(key)
            continue

        fused_duplicates += len(member_indices) - 1
        sorted_members = sorted(comp_members, key=_exact_coord_canonical_sort_key)
        merged_rec = _copy_normalized(sorted_members[0])
        merged_rec["op"] = key[0]

        for member in sorted_members[1:]:
            if not str(merged_rec.get("gid") or "").strip() and str(
                member.get("gid") or ""
            ).strip():
                merged_rec["gid"] = str(member["gid"]).strip()
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
        any_member_had_merged_gids = False
        for member in sorted_members:
            mgid = str(member.get("gid") or "").strip()
            if mgid and mgid not in seen_gids:
                seen_gids.add(mgid)
                merged_gids.append(mgid)
            extra = member.get("mergedGids")
            if isinstance(extra, list):
                any_member_had_merged_gids = True
                for eg in extra:
                    eg_str = str(eg or "").strip()
                    if eg_str and eg_str not in seen_gids:
                        seen_gids.add(eg_str)
                        merged_gids.append(eg_str)

        if len(merged_gids) > 1 or (any_member_had_merged_gids and merged_gids):
            merged_rec["mergedGids"] = merged_gids
        else:
            merged_rec.pop("mergedGids", None)

        if all(isinstance(m.get("bandas"), list) for m in sorted_members):
            combined_freqs: list[str] = []
            for member in sorted_members:
                for freq_item in member.get("frecuencias") or []:
                    if isinstance(freq_item, str):
                        combined_freqs.append(freq_item)
            bandas_from_freqs, freqs_u = summarize_frequency_ranges(combined_freqs)
            extra_bands = {
                str(b).strip()
                for member in sorted_members
                for b in (member.get("bandas") or [])
                if str(b).strip()
            }
            merged_rec["bandas"] = normalize_band_labels(
                set(bandas_from_freqs) | extra_bands
            )
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
        else:
            merged_rec.pop("concesiones", None)

        has_all_bands = isinstance(merged_rec.get("bandas"), list)
        has_partial_concs = any(
            isinstance(m.get("concesiones"), list) for m in sorted_members
        ) and not isinstance(merged_rec.get("concesiones"), list)
        if (
            has_all_bands
            and not has_partial_concs
            and all(
                isinstance(m.get("bandsScannedAt"), str) and m.get("bandsScannedAt")
                for m in sorted_members
            )
        ):
            merged_rec["bandsScannedAt"] = min(
                _normalize_iso_utc(str(m["bandsScannedAt"])) for m in sorted_members
            )
        else:
            merged_rec.pop("bandsScannedAt", None)

        merged_by_key[key] = merged_rec

    emitted_keys: set[tuple[str, str, float, float]] = set()
    output_records: list[dict[str, Any]] = []
    for idx, rec in enumerate(records):
        key = key_by_idx.get(idx)
        if key is None or key in skipped_keys:
            output_records.append(_copy_normalized(rec))
            continue
        if key not in emitted_keys:
            emitted_keys.add(key)
            output_records.append(merged_by_key[key])

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


_MMWAVE_26GHZ_LABEL_RE = re.compile(r"^(?:26|27)\s*(?:MHz|GHz)$", re.IGNORECASE)
_BAND_SORT_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*(GHz|MHz)$", re.IGNORECASE)


@functools.lru_cache(maxsize=512)
def _normalize_band_label_cached(label: str) -> str:
    cleaned = " ".join(label.strip().split())
    if not cleaned:
        return ""
    if _MMWAVE_26GHZ_LABEL_RE.match(cleaned):
        return "26 GHz"
    return cleaned


def normalize_band_label(label: str) -> str:
    """Normaliza variantes históricas/erróneas de la banda milimétrica (`26/27 MHz` o `26/27 GHz`) a `'26 GHz'`."""
    return _normalize_band_label_cached(str(label or ""))


@functools.lru_cache(maxsize=512)
def _band_sort_key_cached(label: str) -> tuple[float, str]:
    text = _normalize_band_label_cached(label)
    m = _BAND_SORT_RE.match(text)
    if m:
        value = float(m.group(1))
        unit = m.group(2).upper()
        mhz = value * 1000.0 if unit == "GHZ" else value
        return (mhz, text)
    return (float("inf"), text)


def _band_sort_key(label: str) -> tuple[float, str]:
    return _band_sort_key_cached(str(label or ""))


def normalize_band_labels(labels: list[str] | set[str]) -> list[str]:
    """Normaliza, deduplica y ordena numéricamente etiquetas de banda (situando `'26 GHz'` tras `'3500 MHz'`)."""
    deduped = {
        norm
        for item in labels
        if item is not None and (norm := _normalize_band_label_cached(str(item)))
    }
    return sorted(deduped, key=_band_sort_key_cached)


def classify_frequency_band(min_mhz: float, max_mhz: float) -> str:
    """Clasifica un rango de frecuencias (MHz) en su etiqueta comercial española."""
    lo = min(float(min_mhz), float(max_mhz))
    hi = max(float(min_mhz), float(max_mhz))
    mid = (lo + hi) / 2.0
    if (24.0 <= lo <= 29.5 and 24.0 <= hi <= 29.5) or 24000.0 <= mid <= 29500.0:
        return "26 GHz"
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
    bandas = normalize_band_labels(band_set)
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


_CARACT_H2_RE = re.compile(r"<h2\b[^>]*>[^<]*CARACTER", re.IGNORECASE)
_LOCALIZACION_H2_RE = re.compile(r"<h2\b[^>]*>[^<]*LOCALIZACI", re.IGNORECASE)
_NIVELES_MEDIDOS_RE = re.compile(r"NIVELES\s+MEDIDOS", re.IGNORECASE)
_TABLE_OPEN_RE = re.compile(r"<table\b[^>]*>", re.IGNORECASE)
_TABLE_CLOSE_RE = re.compile(r"</table\s*>", re.IGNORECASE)
_TR_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr\s*>", re.IGNORECASE | re.DOTALL)
_TD_RE = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]\s*>", re.IGNORECASE | re.DOTALL)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_HTML_OPEN_TAG_RE = re.compile(r"<html\b", re.IGNORECASE)
_HTML_CLOSE_TAG_RE = re.compile(r"</html\s*>", re.IGNORECASE)
_ORACLE_ERR_RE = re.compile(r"\bora-\d{4,5}\b", re.IGNORECASE)
_DETAIL_ERROR_MARKERS = (
    "http status 4",
    "http status 5",
    "apache tomcat",
    "error interno",
    "se ha producido un error",
    "service unavailable",
    "temporarily unavailable",
    "too many requests",
    "bad gateway",
    "gateway timeout",
    "access denied",
    "request blocked",
    "sqlexception",
    "nullpointerexception",
    "java.lang.",
    "sesion caducada",
    "demasiadas peticiones",
)


def _fast_inspect_detalle_estacion_html(
    html: str,
) -> tuple[list[dict[str, Any]], bool] | None:
    """
    Ruta rápida basada en regex compiladas sobre la tabla `CARACTERISTICAS TÉCNICAS`
    sin tokenizar `<head>`, cabecera ni `NIVELES MEDIDOS`.
    Devuelve `(extracted, has_nonempty_data_row)` o `None` si detecta estructura
    anidada o inesperada para delegar de forma segura en `_DetalleEstacionHTMLParser`.
    """
    m_h2 = _CARACT_H2_RE.search(html)
    if m_h2 is None:
        return None
    if _CARACT_H2_RE.search(html, m_h2.end()) is not None:
        return None
    m_open = _TABLE_OPEN_RE.search(html, m_h2.end())
    if m_open is None:
        return None
    m_close = _TABLE_CLOSE_RE.search(html, m_open.end())
    if m_close is None:
        return None

    table_body = html[m_open.end() : m_close.start()]
    if _TABLE_OPEN_RE.search(table_body) is not None:
        return None

    # Si tras esta tabla existe otra tabla y no pertenece a NIVELES MEDIDOS, usar parser completo
    if (
        _TABLE_OPEN_RE.search(html, m_close.end()) is not None
        and _NIVELES_MEDIDOS_RE.search(html, m_close.end()) is None
    ):
        return None

    rows: list[list[str]] = []
    for m_tr in _TR_RE.finditer(table_body):
        cells: list[str] = []
        for m_td in _TD_RE.finditer(m_tr.group(1)):
            cell_txt = _HTML_TAG_RE.sub("", m_td.group(1))
            if "&" in cell_txt:
                cell_txt = html_lib.unescape(cell_txt)
            cells.append(" ".join(cell_txt.split()))
        if cells:
            rows.append(cells)

    if not rows:
        return None

    header_cells = [_strip_accents(c.upper()) for c in rows[0]]
    has_tech_headers = (
        len(header_cells) >= 3
        and "OPERADOR" in header_cells[0]
        and any(tok in header_cells[2] for tok in ("BANDA", "FRECUENCIA", "MHZ"))
    )
    if not has_tech_headers:
        return None

    extracted: list[dict[str, Any]] = []
    has_nonempty_data_row = False
    for row in rows[1:]:
        if len(row) < 3:
            continue
        operador_raw = row[0]
        referencia_raw = row[1]
        banda_raw = row[2]
        if not operador_raw or not banda_raw:
            continue
        has_nonempty_data_row = True
        match = FREQ_RANGE_RE.match(banda_raw)
        if not match:
            continue
        lo = float(match.group(1))
        hi = float(match.group(2))
        if not (math.isfinite(lo) and math.isfinite(hi)) or lo <= 0.0 or hi <= 0.0:
            continue
        if lo > hi:
            lo, hi = hi, lo
        extracted.append(
            {
                "operador": operador_raw,
                "op": classify_operator(operador_raw),
                "referencia": referencia_raw,
                "frecuenciaDeclarada": banda_raw,
                "frecuencia": f"{_format_mhz(lo)} - {_format_mhz(hi)}",
                "minMhz": lo,
                "maxMhz": hi,
                "banda": classify_frequency_band(lo, hi),
            }
        )
    return extracted, has_nonempty_data_row


def _fast_parse_detalle_estacion_html(html: str) -> list[dict[str, Any]] | None:
    """
    Ruta rápida basada en regex compiladas sobre la tabla `CARACTERISTICAS TÉCNICAS`
    sin tokenizar `<head>`, cabecera ni `NIVELES MEDIDOS`. Devuelve `None` si detecta
    estructura anidada o inesperada para delegar de forma segura en `_DetalleEstacionHTMLParser`.
    """
    inspected = _fast_inspect_detalle_estacion_html(html)
    return inspected[0] if inspected is not None else None


def inspect_detalle_estacion_html(html: str) -> tuple[list[dict[str, Any]], str]:
    """
    Analiza e inspecciona estructuralmente el HTML de `detalleEstacion.do`.
    Devuelve `(entries, status)` donde `status` distingue entre respuestas válidas
    (`'ok'`, `'valid_table_no_standard_ranges'`, `'valid_table_empty_rows'`,
    `'valid_localization_only'`) y respuestas anómalas/degradadas del servidor
    (`'empty_html'`, `'truncated_html'`, `'error_page'`, `'invalid_emplazamiento'`,
    `'unexpected_html'`).
    """
    if not html or html.isspace():
        return [], "empty_html"

    open_html_cnt = len(_HTML_OPEN_TAG_RE.findall(html))
    if open_html_cnt > 0:
        close_html_cnt = len(_HTML_CLOSE_TAG_RE.findall(html))
        if close_html_cnt < open_html_cnt:
            return [], "truncated_html"

    fast_inspected = _fast_inspect_detalle_estacion_html(html)
    if fast_inspected is not None:
        fast_entries, has_nonempty_data_row = fast_inspected
        if fast_entries:
            return fast_entries, "ok"
        if has_nonempty_data_row:
            return [], "valid_table_no_standard_ranges"
        plain_text = _HTML_TAG_RE.sub(" ", html)
        if "&" in plain_text:
            plain_text = html_lib.unescape(plain_text)
        plain_norm = _strip_accents(" ".join(plain_text.split()).lower())
        if any(marker in plain_norm for marker in _DETAIL_ERROR_MARKERS) or _ORACLE_ERR_RE.search(
            plain_norm
        ):
            return [], "error_page"
        if "codigo de emplazamiento no valido" in plain_norm:
            return [], "invalid_emplazamiento"
        return [], "valid_table_empty_rows"

    parser = _DetalleEstacionHTMLParser()
    parser.feed(html)
    parser.close()
    parser.flush()

    extracted: list[dict[str, Any]] = []
    saw_tech_table = False
    saw_tech_data_row = False
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
        if has_tech_headers:
            saw_tech_table = True

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
            operador_raw = row[0]
            referencia_raw = row[1]
            banda_raw = row[2]
            if not operador_raw or not banda_raw:
                continue
            if has_tech_headers:
                saw_tech_data_row = True
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

    if extracted:
        return extracted, "ok"

    if saw_tech_table and saw_tech_data_row:
        return [], "valid_table_no_standard_ranges"

    plain_text = _HTML_TAG_RE.sub(" ", html)
    if "&" in plain_text:
        plain_text = html_lib.unescape(plain_text)
    plain_norm = _strip_accents(" ".join(plain_text.split()).lower())

    if any(marker in plain_norm for marker in _DETAIL_ERROR_MARKERS) or _ORACLE_ERR_RE.search(
        plain_norm
    ):
        return [], "error_page"

    if "codigo de emplazamiento no valido" in plain_norm:
        return [], "invalid_emplazamiento"

    if saw_tech_table:
        return [], "valid_table_empty_rows"

    if _LOCALIZACION_H2_RE.search(html) is not None:
        return [], "valid_localization_only"

    return [], "unexpected_html"


def parse_detalle_estacion_html(html: str) -> list[dict[str, Any]]:
    """
    Analiza el HTML de `detalleEstacion.do` y devuelve únicamente las filas válidas de
    frecuencia de la tabla `CARACTERISTICAS TÉCNICAS`, ignorando por completo la tabla
    `NIVELES MEDIDOS` y la de `LOCALIZACIÓN`.
    """
    if not html or html.isspace():
        return []

    fast_result = _fast_parse_detalle_estacion_html(html)
    if fast_result is not None:
        return fast_result

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
            operador_raw = row[0]
            referencia_raw = row[1]
            banda_raw = row[2]
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


def _needs_xfera_fusion(raw_list: list[dict[str, Any]]) -> bool:
    """
    Comprueba en tiempo mínimo si `raw_list` requiere realmente ejecutar `fuse_xfera_into_orange`,
    evitando copias profundas innecesarias sobre datasets ya fusionados con estaciones Xfera independientes.
    """
    xfera_records: list[tuple[int, float, float]] = []
    orange_records: list[tuple[int, float, float]] = []
    seen_orange_gids: set[str] = set()

    for idx, r in enumerate(raw_list):
        op_str = str(r.get("op") or "").strip()
        if op_str == "masmovil":
            return True
        op_raw = str(r.get("opRaw") or "")
        is_xfera = is_xfera_entity(op_raw)
        if is_xfera and op_str != "orange":
            return True
        if op_str == "orange" or is_xfera:
            for g in get_record_gids(r):
                if g in seen_orange_gids:
                    return True
                seen_orange_gids.add(g)
            try:
                lat_f = float(r["lat"])
                lon_f = float(r["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            orange_records.append((idx, lat_f, lon_f))
            if is_xfera:
                xfera_records.append((idx, lat_f, lon_f))

    if not xfera_records or len(orange_records) <= 1:
        return False

    # Si hay muchas estaciones Xfera (dataset crudo sin fusionar), delegar directamente
    if len(xfera_records) > 256:
        return True

    max_dlat = (DEFAULT_XFERA_ORANGE_FUSION_M / 111320.0) + 1e-5
    max_dlon = (DEFAULT_XFERA_ORANGE_FUSION_M / (111320.0 * 0.65)) + 1e-5
    for x_idx, x_lat, x_lon in xfera_records:
        for o_idx, o_lat, o_lon in orange_records:
            if o_idx == x_idx:
                continue
            if abs(x_lat - o_lat) <= max_dlat and abs(x_lon - o_lon) <= max_dlon:
                if haversine_m(x_lat, x_lon, o_lat, o_lon) < DEFAULT_XFERA_ORANGE_FUSION_M:
                    return True
    return False


def _load_records_from_preserve_source(
    preserve_from: dict[str, Any] | list[dict[str, Any]] | Path | str | None,
) -> list[dict[str, Any]]:
    raw_list: list[dict[str, Any]] = []
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
            raw_list = [r for r in loaded["antenas"] if isinstance(r, dict)]
    elif isinstance(preserve_from, dict):
        antenas = preserve_from.get("antenas")
        if isinstance(antenas, list):
            raw_list = [r for r in antenas if isinstance(r, dict)]
    elif isinstance(preserve_from, list):
        raw_list = [r for r in preserve_from if isinstance(r, dict)]

    if not raw_list:
        return []
    if _needs_xfera_fusion(raw_list):
        result, _ = fuse_xfera_into_orange(raw_list)
    else:
        result = []
        for r in raw_list:
            eff_op = _normalize_operator_key(r.get("op"), r.get("opRaw"))
            if eff_op != r.get("op"):
                rcopy = dict(r)
                rcopy["op"] = eff_op
                result.append(rcopy)
            else:
                result.append(r)
    if _needs_exact_coord_fusion(result):
        result, _ = fuse_same_operator_exact_coords(result)
    return result


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
        "records": prior_records,
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


def diff_removed_antennas(
    records: list[dict[str, Any]],
    prior_source: dict[str, Any] | list[dict[str, Any]] | Path | str | None,
    scanned_at_iso: str | None = None,
) -> tuple[list[dict[str, Any]], set[str]]:
    """
    Compara el censo anterior (`prior_source`) contra el censo actual (`records`) y devuelve
    `(eliminaciones_antenas_y_frecuencias, removed_antenna_ids)`.
    Comprueba tanto `id` como cada `(op, gid)` en `get_record_gids` para que las fusiones
    de Vodafone (< 35 m) o Xfera en Orange jamás generen bajas falsas.
    """
    if prior_source is None:
        return [], set()

    prior_index = build_prior_antenna_index(prior_source)
    prior_records: list[dict[str, Any]] = (
        list(prior_index["records"])
        if isinstance(prior_index.get("records"), list)
        else list((prior_index.get("by_id") or {}).values())
    )
    if not prior_records:
        return [], set()

    current_ids: set[str] = set()
    current_op_gids: set[tuple[str, str]] = set()
    for cur in records:
        if not isinstance(cur, dict):
            continue
        cur_id = str(cur.get("id") or "").strip()
        cur_op = _normalize_operator_key(cur.get("op"), cur.get("opRaw"))
        if cur_id:
            current_ids.add(cur_id)
        if cur_op:
            for g in get_record_gids(cur):
                current_op_gids.add((cur_op, g))

    scan_iso = _normalize_iso_utc(scanned_at_iso) if scanned_at_iso else _utc_now_iso()
    fecha_es = format_spain_datetime(scan_iso)

    eliminaciones: list[dict[str, Any]] = []
    removed_ids: set[str] = set()

    for old_rec in prior_records:
        if not isinstance(old_rec, dict):
            continue
        old_id = str(old_rec.get("id") or "").strip()
        if not old_id or old_id in removed_ids or old_id in current_ids:
            continue
        old_op = _normalize_operator_key(old_rec.get("op"), old_rec.get("opRaw"))
        old_gids = get_record_gids(old_rec)
        if old_op and any((old_op, g) in current_op_gids for g in old_gids):
            continue

        removed_ids.add(old_id)
        old_gid = str(old_rec.get("gid") or (old_gids[0] if old_gids else "")).strip()
        old_op_raw = str(old_rec.get("opRaw") or "")
        mun = str(old_rec.get("mun") or "").strip()
        prov = str(old_rec.get("prov") or "").strip()
        ubicacion = mun or prov
        lat_val = _parse_float(old_rec.get("lat"))
        lon_val = _parse_float(old_rec.get("lon"))

        ant_row: dict[str, Any] = {
            "id": f"del-ant:{old_id}",
            "tipo": "antena",
            "op": old_op,
            "opRaw": old_op_raw,
            "codigo": old_gid,
            "antennaId": old_id,
            "codigoBanda": "",
            "frecuencia": "",
            "ubicacion": ubicacion,
            "prov": prov,
            "scannedAt": scan_iso,
            "fecha": fecha_es,
        }
        if lat_val is not None and lon_val is not None:
            ant_row["lat"] = round(lat_val, 6)
            ant_row["lon"] = round(lon_val, 6)
        eliminaciones.append(ant_row)

        prior_conc = old_rec.get("concesiones")
        prior_freqs = old_rec.get("frecuencias")
        assoc_freqs: list[dict[str, Any]] = []
        seen_freq_keys: set[tuple[str, str, str]] = set()

        if isinstance(prior_conc, list) and prior_conc:
            for c in prior_conc:
                if not isinstance(c, dict):
                    continue
                c_ref = " ".join(str(c.get("ref") or "").split()).strip()
                c_freq_raw = " ".join(str(c.get("freq") or "").split()).strip()
                c_freq_norm = _norm_freq_str(c_freq_raw)
                if not c_freq_raw or not c_freq_norm:
                    continue
                dedup_key = (old_id, c_ref, c_freq_raw)
                if dedup_key in seen_freq_keys:
                    continue
                seen_freq_keys.add(dedup_key)
                freq_row: dict[str, Any] = {
                    "id": f"del-freq:{old_id}:{c_ref}:{c_freq_raw}",
                    "tipo": "frecuencia",
                    "op": old_op,
                    "opRaw": old_op_raw,
                    "codigo": old_gid,
                    "antennaId": old_id,
                    "codigoBanda": c_ref,
                    "frecuencia": format_exact_ministry_frequency(c_freq_raw),
                    "ubicacion": ubicacion,
                    "prov": prov,
                    "scannedAt": scan_iso,
                    "fecha": fecha_es,
                }
                if lat_val is not None and lon_val is not None:
                    freq_row["lat"] = round(lat_val, 6)
                    freq_row["lon"] = round(lon_val, 6)
                assoc_freqs.append(freq_row)
        elif isinstance(prior_freqs, list) and prior_freqs:
            for f_str in prior_freqs:
                if not isinstance(f_str, str):
                    continue
                f_raw = " ".join(f_str.split()).strip()
                f_norm = _norm_freq_str(f_raw)
                if not f_raw or not f_norm:
                    continue
                dedup_key = (old_id, "", f_raw)
                if dedup_key in seen_freq_keys:
                    continue
                seen_freq_keys.add(dedup_key)
                freq_row = {
                    "id": f"del-freq:{old_id}::{f_raw}",
                    "tipo": "frecuencia",
                    "op": old_op,
                    "opRaw": old_op_raw,
                    "codigo": old_gid,
                    "antennaId": old_id,
                    "codigoBanda": "",
                    "frecuencia": format_exact_ministry_frequency(f_raw),
                    "ubicacion": ubicacion,
                    "prov": prov,
                    "scannedAt": scan_iso,
                    "fecha": fecha_es,
                }
                if lat_val is not None and lon_val is not None:
                    freq_row["lat"] = round(lat_val, 6)
                    freq_row["lon"] = round(lon_val, 6)
                assoc_freqs.append(freq_row)

        if len(assoc_freqs) > 1:
            assoc_freqs.sort(key=_novedad_freq_sort_key)
        eliminaciones.extend(assoc_freqs)

    return eliminaciones, removed_ids


def preserve_bands_in_records(
    records: list[dict[str, Any]],
    preserve_from: dict[str, Any] | list[dict[str, Any]] | Path | str | None,
) -> int:
    """
    Reutiliza `bandas`, `frecuencias`, `concesiones` y `bandsScannedAt` ya extraídas
    en un dataset previo casando por `id` o `(op, gid)` (verificando que ningún
    `mergedGid` nuevo haya quedado sin cubrir).
    Acepta también un índice precalculado de `build_prior_antenna_index` para evitar
    re-indexaciones y fusiones duplicadas.
    Devuelve el número de antenas enriquecidas desde `preserve_from`.
    """
    is_prebuilt_index = (
        isinstance(preserve_from, dict)
        and "by_id" in preserve_from
        and "by_op_gid" in preserve_from
    )

    by_id: dict[str, dict[str, Any]]
    by_op_gid: dict[tuple[str, str], dict[str, Any]]
    all_by_op_gid: dict[tuple[str, str], list[dict[str, Any]]] | None = None

    if is_prebuilt_index:
        assert isinstance(preserve_from, dict)
        by_id = preserve_from.get("by_id") or {}
        by_op_gid = preserve_from.get("by_op_gid") or {}
        all_by_op_gid = preserve_from.get("all_by_op_gid") or {}
        if not by_id and not by_op_gid:
            return 0
    else:
        prior_records = _load_records_from_preserve_source(preserve_from)
        if not prior_records:
            return 0

        by_id = {}
        by_op_gid = {}
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

    current_gids_by_op: dict[str, set[str]] = {}
    for rec in records:
        rec_op = str(rec.get("op") or "").strip()
        if rec_op:
            op_set = current_gids_by_op.setdefault(rec_op, set())
            for g in get_record_gids(rec):
                op_set.add(g)

    restored = 0
    for rec in records:
        if isinstance(rec.get("bandas"), list):
            rec["bandas"] = normalize_band_labels(rec["bandas"])
            continue
        rec_id = str(rec.get("id") or "").strip()
        rec_op = str(rec.get("op") or "").strip()
        cand = by_id.get(rec_id)
        if cand is not None and not isinstance(cand.get("bandas"), list):
            cand = None
        if cand is None and rec_op:
            for g in get_record_gids(rec):
                c = by_op_gid.get((rec_op, g))
                if c is not None and isinstance(c.get("bandas"), list):
                    cand = c
                    break
                if all_by_op_gid is not None:
                    for alt in all_by_op_gid.get((rec_op, g), ()):
                        if isinstance(alt.get("bandas"), list):
                            cand = alt
                            break
                    if cand is not None:
                        break
        if cand is None:
            continue

        new_gids = set(get_record_gids(rec))
        old_gids = set(get_record_gids(cand))
        if new_gids and not new_gids.issubset(old_gids):
            continue
        # Si un emplazamiento previamente fusionado (`old_gids > new_gids`) se ha separado
        # en estaciones independientes presentes en `records`, omitir la copia de bandas
        # combinadas para forzar un escaneo limpio por GID y evitar bajas falsas.
        if (
            new_gids
            and len(new_gids) < len(old_gids)
            and rec_op
            and bool((old_gids - new_gids) & current_gids_by_op.get(rec_op, set()))
        ):
            continue

        rec["bandas"] = normalize_band_labels(cand["bandas"])
        rec["frecuencias"] = list(cand.get("frecuencias") or [])
        if isinstance(cand.get("concesiones"), list):
            rec["concesiones"] = [
                dict(c) for c in cand["concesiones"] if isinstance(c, dict)
            ]
        # Si desapareció algún GID fusionado (`new_gids < old_gids`), omitir `bandsScannedAt`
        # para forzar re-escaneo y eliminar las concesiones del sub-emplazamiento desaparecido.
        if (
            (not new_gids or new_gids == old_gids)
            and isinstance(cand.get("bandsScannedAt"), str)
            and cand.get("bandsScannedAt")
        ):
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


_NOVEDAD_FREQ_RANGE_RE = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(?:MHz|GHz)?\s*-\s*(\d+(?:\.\d+)?)(?:\s*(?:MHz|GHz))?$",
    re.IGNORECASE,
)
_NOVEDAD_SINGLE_FREQ_RE = re.compile(
    r"^(\d+(?:\.\d+)?)(?:\s*(?:MHz|GHz))?$",
    re.IGNORECASE,
)


def _novedad_antenna_group_key(item: dict[str, Any]) -> str:
    return (
        str(item.get("antennaId") or "").strip()
        or f"{str(item.get('op') or '').strip()}::{str(item.get('codigo') or '').strip()}"
    )


def _novedad_freq_sort_key(item: dict[str, Any]) -> tuple[float, float, str, str]:
    raw_freq = " ".join(str(item.get("frecuencia") or "").split()).strip()
    min_mhz = float("inf")
    max_mhz = float("inf")
    if raw_freq:
        m = _NOVEDAD_FREQ_RANGE_RE.match(raw_freq)
        if m:
            lo = float(m.group(1))
            hi = float(m.group(2))
        else:
            m_single = _NOVEDAD_SINGLE_FREQ_RE.match(raw_freq)
            if m_single:
                lo = hi = float(m_single.group(1))
            else:
                lo = hi = float("inf")

        if math.isfinite(lo) and math.isfinite(hi):
            if lo > hi:
                lo, hi = hi, lo
            has_ghz = "GHZ" in raw_freq.upper()
            if (has_ghz and lo < 100.0 and hi < 100.0) or (
                24.0 <= lo <= 29.5 and 24.0 <= hi <= 29.5
            ):
                lo *= 1000.0
                hi *= 1000.0
            min_mhz, max_mhz = lo, hi

    return (
        min_mhz,
        max_mhz,
        str(item.get("codigoBanda") or ""),
        str(item.get("id") or ""),
    )


def _diff_record_new_frequencies(
    rec: dict[str, Any],
    matched_entries: list[dict[str, Any]],
    fetched_iso: str,
    new_antenna_ids: set[str] | None = None,
    prior_index: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """
    Emite filas de concesión/frecuencia (`tipo == "frecuencia"`):
    - Si `rec` es una antena nueva descubierta en este escaneo (`rec["id"] in new_antenna_ids`),
      emite todas las frecuencias válidas del operador asociadas a esa antena nueva.
    - Si `rec` es una antena existente, detecta únicamente concesiones/frecuencias nuevas cuando
      YA contaba con un escaneo previo (`concesiones` o `frecuencias` no nulos), sin emitir jamás
      falsos positivos para antenas antiguas aún sin escanear ni fusiones Vodafone conocidas.
    """
    rec_id = str(rec.get("id") or "").strip()
    if not rec_id or not matched_entries:
        return []

    if new_antenna_ids and rec_id in new_antenna_ids:
        scan_iso = _normalize_iso_utc(fetched_iso)
        fecha_es = format_spain_datetime(scan_iso)
        mun = str(rec.get("mun") or "").strip()
        prov = str(rec.get("prov") or "").strip()
        ubicacion = mun or prov

        emitted_new: list[dict[str, Any]] = []
        seen_new_ant_keys: set[tuple[str, str, str]] = set()
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

            dedup_key = (rec_id, ref, banda_raw)
            if dedup_key in seen_new_ant_keys:
                continue
            seen_new_ant_keys.add(dedup_key)

            op_raw_entry = " ".join(str(entry.get("operador") or "").split()).strip()
            emitted_new.append(
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
        emitted_new.sort(key=_novedad_freq_sort_key)
        return emitted_new

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

    scan_iso: str | None = None
    fecha_es: str | None = None
    mun = ""
    prov = ""
    ubicacion = ""

    def _ensure_emit_meta() -> tuple[str, str, str, str]:
        nonlocal scan_iso, fecha_es, mun, prov, ubicacion
        if scan_iso is None:
            scan_iso = _normalize_iso_utc(fetched_iso)
            fecha_es = format_spain_datetime(scan_iso)
            mun = str(rec.get("mun") or "").strip()
            prov = str(rec.get("prov") or "").strip()
            ubicacion = mun or prov
        assert fecha_es is not None
        return scan_iso, fecha_es, ubicacion, prov

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

            s_iso, f_es, ubic, pr = _ensure_emit_meta()
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
                    "ubicacion": ubic,
                    "prov": pr,
                    "scannedAt": s_iso,
                    "fecha": f_es,
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

            s_iso, f_es, ubic, pr = _ensure_emit_meta()
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
                    "ubicacion": ubic,
                    "prov": pr,
                    "scannedAt": s_iso,
                    "fecha": f_es,
                }
            )

    if len(emitted) > 1:
        emitted.sort(key=_novedad_freq_sort_key)
    return emitted


def _diff_record_removed_frequencies(
    rec: dict[str, Any],
    matched_entries: list[dict[str, Any]],
    fetched_iso: str,
    new_antenna_ids: set[str] | None = None,
    prior_index: dict[str, Any] | None = None,
    current_op_gids: set[tuple[str, str]] | None = None,
) -> list[dict[str, Any]]:
    """
    Detecta concesiones/frecuencias que existían previamente en `rec` (o en `prior_index`)
    y han desaparecido en el re-escaneo verificado (`matched_entries`).
    Nunca emite bajas para antenas nuevas ni para antenas que aún no tenían un escaneo previo.
    """
    rec_id = str(rec.get("id") or "").strip()
    if not rec_id:
        return []
    if new_antenna_ids and rec_id in new_antenna_ids:
        return []

    prior_conc: list[dict[str, Any]] | None = (
        rec["concesiones"] if isinstance(rec.get("concesiones"), list) else None
    )
    prior_freqs: list[str] | None = (
        rec["frecuencias"] if isinstance(rec.get("frecuencias"), list) else None
    )

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
        new_gids = set(get_record_gids(rec))
        if rec_op:
            for g in new_gids:
                for cand in all_by_op_gid.get((rec_op, g), ()):
                    if id(cand) not in seen_prior_objs:
                        seen_prior_objs.add(id(cand))
                        matched_priors.append(cand)

        conc_acc: list[dict[str, Any]] = []
        freq_acc: list[str] = []
        any_conc = False
        any_freq = False
        for old_rec in matched_priors:
            if current_op_gids is not None and rec_op and new_gids:
                old_gids = set(get_record_gids(old_rec))
                if len(old_gids) > len(new_gids) and any(
                    (rec_op, og) in current_op_gids for og in (old_gids - new_gids)
                ):
                    continue
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

        if any_conc:
            prior_conc = conc_acc
        elif any_freq:
            prior_freqs = freq_acc

    if not isinstance(prior_conc, list) and not isinstance(prior_freqs, list):
        return []

    current_pairs: set[tuple[str, str]] = set()
    current_freq_only: set[str] = set()
    current_blank_ref_freqs: set[str] = set()
    for entry in matched_entries:
        ref = " ".join(str(entry.get("referencia") or "").split()).strip()
        banda_raw = " ".join(
            str(
                entry.get("frecuenciaDeclarada")
                or entry.get("frecuencia")
                or ""
            ).split()
        ).strip()
        freq_clean = _norm_freq_str(str(entry.get("frecuencia") or banda_raw))
        if freq_clean:
            current_pairs.add((ref, freq_clean))
            current_freq_only.add(freq_clean)
            if ref == "":
                current_blank_ref_freqs.add(freq_clean)

    scan_iso: str | None = None
    fecha_es: str | None = None
    mun = ""
    prov = ""
    ubicacion = ""
    lat_val = _parse_float(rec.get("lat"))
    lon_val = _parse_float(rec.get("lon"))

    def _ensure_emit_meta() -> tuple[str, str, str, str]:
        nonlocal scan_iso, fecha_es, mun, prov, ubicacion
        if scan_iso is None:
            scan_iso = _normalize_iso_utc(fetched_iso)
            fecha_es = format_spain_datetime(scan_iso)
            mun = str(rec.get("mun") or "").strip()
            prov = str(rec.get("prov") or "").strip()
            ubicacion = mun or prov
        assert fecha_es is not None
        return scan_iso, fecha_es, ubicacion, prov

    emitted: list[dict[str, Any]] = []
    seen_del_keys: set[tuple[str, str, str]] = set()

    if isinstance(prior_conc, list):
        for c in prior_conc:
            if not isinstance(c, dict):
                continue
            c_ref = " ".join(str(c.get("ref") or "").split()).strip()
            c_freq_raw = " ".join(str(c.get("freq") or "").split()).strip()
            c_freq_norm = _norm_freq_str(c_freq_raw)
            if not c_freq_raw or not c_freq_norm:
                continue
            if (c_ref, c_freq_norm) in current_pairs:
                continue
            if c_ref == "" and c_freq_norm in current_freq_only:
                continue
            if c_freq_norm in current_blank_ref_freqs:
                continue

            dedup_key = (rec_id, c_ref, c_freq_raw)
            if dedup_key in seen_del_keys:
                continue
            seen_del_keys.add(dedup_key)

            s_iso, f_es, ubic, pr = _ensure_emit_meta()
            row: dict[str, Any] = {
                "id": f"del-freq:{rec_id}:{c_ref}:{c_freq_raw}",
                "tipo": "frecuencia",
                "op": rec["op"],
                "opRaw": rec["opRaw"],
                "codigo": rec["gid"],
                "antennaId": rec_id,
                "codigoBanda": c_ref,
                "frecuencia": format_exact_ministry_frequency(c_freq_raw),
                "ubicacion": ubic,
                "prov": pr,
                "scannedAt": s_iso,
                "fecha": f_es,
            }
            if lat_val is not None and lon_val is not None:
                row["lat"] = round(lat_val, 6)
                row["lon"] = round(lon_val, 6)
            emitted.append(row)
    elif isinstance(prior_freqs, list):
        for f_str in prior_freqs:
            if not isinstance(f_str, str):
                continue
            f_raw = " ".join(f_str.split()).strip()
            f_norm = _norm_freq_str(f_raw)
            if not f_raw or not f_norm or f_norm in current_freq_only:
                continue

            dedup_key = (rec_id, "", f_raw)
            if dedup_key in seen_del_keys:
                continue
            seen_del_keys.add(dedup_key)

            s_iso, f_es, ubic, pr = _ensure_emit_meta()
            row = {
                "id": f"del-freq:{rec_id}::{f_raw}",
                "tipo": "frecuencia",
                "op": rec["op"],
                "opRaw": rec["opRaw"],
                "codigo": rec["gid"],
                "antennaId": rec_id,
                "codigoBanda": "",
                "frecuencia": format_exact_ministry_frequency(f_raw),
                "ubicacion": ubic,
                "prov": pr,
                "scannedAt": s_iso,
                "fecha": f_es,
            }
            if lat_val is not None and lon_val is not None:
                row["lat"] = round(lat_val, 6)
                row["lon"] = round(lon_val, 6)
            emitted.append(row)

    if len(emitted) > 1:
        emitted.sort(key=_novedad_freq_sort_key)
    return emitted


def _novedad_timestamp(item: dict[str, Any]) -> float:
    scanned_at = str(item.get("scannedAt") or "")
    try:
        return _parse_utc_datetime(scanned_at).timestamp()
    except ValueError:
        return 0.0


def _novedad_sort_key(item: dict[str, Any]) -> tuple[float, str, str, str]:
    ts = _novedad_timestamp(item)
    return (
        -ts,
        str(item.get("tipo") or ""),
        str(item.get("codigo") or ""),
        str(item.get("id") or ""),
    )


_NOVEDAD_FECHA_DAY_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})\b")
_NOVEDAD_ISO_DAY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _novedad_batch_key(item: dict[str, Any]) -> str:
    scan_id = str(item.get("scanId") or "").strip()
    if scan_id:
        return f"scan:{scan_id}"
    fecha = str(item.get("fecha") or "").strip()
    m_fecha = _NOVEDAD_FECHA_DAY_RE.match(fecha)
    if m_fecha:
        dd, mm, yyyy = m_fecha.group(1), m_fecha.group(2), m_fecha.group(3)
        return f"day:{yyyy}-{mm}-{dd}"
    scanned_at = str(item.get("scannedAt") or "").strip()
    m_iso = _NOVEDAD_ISO_DAY_RE.match(scanned_at)
    if m_iso:
        return f"day:{m_iso.group(1)}"
    return "day:unknown"


def _sort_single_novedades_batch(batch_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    antena_items: list[dict[str, Any]] = []
    freq_items: list[dict[str, Any]] = []
    for item in batch_items:
        if item.get("tipo") == "antena":
            antena_items.append(item)
        else:
            freq_items.append(item)

    antena_items.sort(
        key=lambda item: (
            -_novedad_timestamp(item),
            str(item.get("codigo") or ""),
            str(item.get("op") or ""),
            _novedad_antenna_group_key(item),
            str(item.get("id") or ""),
        )
    )

    unique_antena_items: list[dict[str, Any]] = []
    new_ant_keys: set[str] = set()
    for ant in antena_items:
        key = _novedad_antenna_group_key(ant)
        if key in new_ant_keys:
            continue
        new_ant_keys.add(key)
        unique_antena_items.append(ant)

    freqs_by_new_ant: dict[str, list[dict[str, Any]]] = {}
    existing_ant_freqs: list[dict[str, Any]] = []
    for freq in freq_items:
        key = _novedad_antenna_group_key(freq)
        if key in new_ant_keys:
            freqs_by_new_ant.setdefault(key, []).append(freq)
        else:
            existing_ant_freqs.append(freq)

    ordered: list[dict[str, Any]] = []
    for ant in unique_antena_items:
        key = _novedad_antenna_group_key(ant)
        ordered.append(ant)
        ordered.extend(
            sorted(freqs_by_new_ant.get(key, []), key=_novedad_freq_sort_key)
        )

    existing_groups: dict[str, list[dict[str, Any]]] = {}
    for freq in existing_ant_freqs:
        key = _novedad_antenna_group_key(freq)
        existing_groups.setdefault(key, []).append(freq)

    sorted_existing_groups: list[
        tuple[tuple[float, str, str, str], list[dict[str, Any]]]
    ] = []
    for key, group_items in existing_groups.items():
        group_sorted = sorted(group_items, key=_novedad_freq_sort_key)
        max_ts = max(_novedad_timestamp(f) for f in group_sorted)
        first_codigo = str(group_sorted[0].get("codigo") or "")
        first_op = str(group_sorted[0].get("op") or "")
        sorted_existing_groups.append(
            ((-max_ts, first_codigo, first_op, key), group_sorted)
        )

    sorted_existing_groups.sort(key=lambda entry: entry[0])
    for _, group_sorted in sorted_existing_groups:
        ordered.extend(group_sorted)

    return ordered


def sort_novedades_grouped(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Deduplica novedades por `id` preservando registros históricos originales y las ordena
    por lote de escaneo (lote más reciente primero). Dentro de cada lote:
    1) Cada antena nueva (`tipo == "antena"`), seguida inmediatamente de todas sus
       frecuencias asociadas (`tipo == "frecuencia"`) de ese mismo lote ordenadas por MHz.
    2) A continuación, todas las frecuencias nuevas detectadas en antenas ya existentes
       en ese lote, agrupadas por antena y ordenadas por MHz dentro de cada antena.
    """
    deduped_by_id: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        nov_id = str(item.get("id") or "").strip()
        if not nov_id:
            continue
        candidate = dict(item)
        if "op" in candidate or "opRaw" in candidate:
            candidate["op"] = _normalize_operator_key(
                candidate.get("op"), candidate.get("opRaw")
            )
        existing = deduped_by_id.get(nov_id)
        if existing is None:
            deduped_by_id[nov_id] = candidate
            continue

        existing_batch = _novedad_batch_key(existing)
        candidate_batch = _novedad_batch_key(candidate)
        if existing_batch == candidate_batch:
            deduped_by_id[nov_id] = candidate
        else:
            existing_ts = _novedad_timestamp(existing)
            candidate_ts = _novedad_timestamp(candidate)
            if existing_ts > 0.0 and candidate_ts > 0.0 and candidate_ts < existing_ts:
                deduped_by_id[nov_id] = candidate

    batches: dict[str, list[dict[str, Any]]] = {}
    for item in deduped_by_id.values():
        bkey = _novedad_batch_key(item)
        batches.setdefault(bkey, []).append(item)

    sorted_batches = sorted(
        batches.items(),
        key=lambda entry: (
            max((_novedad_timestamp(x) for x in entry[1]), default=0.0),
            entry[0],
        ),
        reverse=True,
    )

    ordered: list[dict[str, Any]] = []
    for _, batch_items in sorted_batches:
        ordered.extend(_sort_single_novedades_batch(batch_items))

    return ordered


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
            normalized_items: list[dict[str, Any]] = []
            for item in loaded["novedades"]:
                if isinstance(item, dict):
                    item_copy = dict(item)
                    item_copy["op"] = _normalize_operator_key(
                        item_copy.get("op"), item_copy.get("opRaw")
                    )
                    normalized_items.append(item_copy)
            loaded["novedades"] = normalized_items
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
    deduplicado por `id` y ordenado agrupando cada antena nueva seguida de sus
    frecuencias asociadas y, después, las frecuencias nuevas de antenas existentes.
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

    sorted_items = sort_novedades_grouped(novedades)
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


def _extract_stamped_items_from_doc(doc: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(doc, dict):
        return []
    raw_items = [
        dict(item)
        for item in (doc.get("novedades") or [])
        if isinstance(item, dict)
    ]
    if doc.get("isBaselineScan") and not raw_items:
        return []
    doc_scan_id = str(doc.get("scanId") or "").strip()
    can_stamp = bool(doc_scan_id and not doc_scan_id.startswith("baseline"))
    for item in raw_items:
        item["op"] = _normalize_operator_key(item.get("op"), item.get("opRaw"))
        if can_stamp and not str(item.get("scanId") or "").strip():
            item["scanId"] = doc_scan_id
    return raw_items


def _doc_updated_timestamp(doc: dict[str, Any] | None) -> float:
    if not isinstance(doc, dict):
        return 0.0
    raw = str(doc.get("updatedAt") or "").strip()
    if not raw:
        return 0.0
    try:
        return _parse_utc_datetime(raw).timestamp()
    except ValueError:
        return 0.0


def merge_novedades_datasets(
    base_doc: dict[str, Any] | None,
    incoming_doc: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Fusiona sin pérdidas dos documentos `NovedadesDataset` (`base_doc` e `incoming_doc`),
    conservando permanentemente todas las novedades históricas y las nuevas agrupadas por escaneo.
    """
    if base_doc is None and incoming_doc is None:
        return build_novedades_dataset([], is_baseline_scan=False)

    base_items = _extract_stamped_items_from_doc(base_doc)
    incoming_items = _extract_stamped_items_from_doc(incoming_doc)
    combined_items = [*base_items, *incoming_items]

    base_ts = _doc_updated_timestamp(base_doc)
    inc_ts = _doc_updated_timestamp(incoming_doc)
    if incoming_doc is not None and (base_doc is None or inc_ts >= base_ts):
        newest_doc = incoming_doc
        older_doc = base_doc
    else:
        assert base_doc is not None
        newest_doc = base_doc
        older_doc = incoming_doc

    scan_id = (
        str(newest_doc.get("scanId") or "").strip()
        or str((older_doc or {}).get("scanId") or "").strip()
    )
    updated_at_raw = str(newest_doc.get("updatedAt") or "").strip() or str(
        (older_doc or {}).get("updatedAt") or ""
    ).strip()
    updated_at = updated_at_raw or None
    if "previousScanAt" in newest_doc:
        previous_scan_at = newest_doc.get("previousScanAt")
    elif older_doc is not None and "previousScanAt" in older_doc:
        previous_scan_at = older_doc.get("previousScanAt")
    else:
        previous_scan_at = None

    is_baseline = bool(
        not combined_items
        and incoming_doc is not None
        and incoming_doc.get("isBaselineScan")
        and (base_doc is None or base_doc.get("isBaselineScan"))
    )

    return build_novedades_dataset(
        combined_items,
        scan_id=scan_id,
        previous_scan_at=previous_scan_at,
        updated_at=updated_at,
        is_baseline_scan=is_baseline,
    )


def merge_novedades_files(target_path: Path, incoming_path: Path) -> None:
    """Fusiona de forma atómica y sin pérdidas `incoming_path` sobre `target_path`."""
    incoming_doc = load_novedades_dataset(incoming_path)
    if incoming_doc is None:
        return
    if (
        target_path.exists()
        and incoming_path.exists()
        and target_path.read_bytes() == incoming_path.read_bytes()
    ):
        return
    base_doc = load_novedades_dataset(target_path)
    merged_doc = merge_novedades_datasets(base_doc, incoming_doc)
    write_novedades_dataset(merged_doc, target_path)


def sort_eliminaciones_grouped(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Deduplica eliminaciones por `id` preservando registros históricos originales y las ordena
    por lote de escaneo (lote más reciente primero), agrupando cada antena eliminada seguida
    de sus frecuencias retiradas y después las frecuencias retiradas de antenas aún activas.
    """
    return sort_novedades_grouped(items)


def load_eliminaciones_dataset(path: Path | str | None) -> dict[str, Any] | None:
    """Carga un `EliminacionesDataset` existente desde disco si es válido."""
    if path is None:
        return None
    target = Path(path)
    if not target.exists():
        return None
    try:
        loaded = json.loads(target.read_text(encoding="utf-8"))
        if isinstance(loaded, dict) and isinstance(loaded.get("eliminaciones"), list):
            normalized_items: list[dict[str, Any]] = []
            for item in loaded["eliminaciones"]:
                if isinstance(item, dict):
                    item_copy = dict(item)
                    item_copy["op"] = _normalize_operator_key(
                        item_copy.get("op"), item_copy.get("opRaw")
                    )
                    normalized_items.append(item_copy)
            loaded["eliminaciones"] = normalized_items
            return loaded
    except Exception as exc:
        logging.warning("No se pudo leer eliminaciones previas en %s: %s", target, exc)
    return None


def build_eliminaciones_dataset(
    eliminaciones: list[dict[str, Any]],
    *,
    scan_id: str = "",
    previous_scan_at: str | None = None,
    updated_at: str | None = None,
    is_baseline_scan: bool = False,
) -> dict[str, Any]:
    """
    Construye un `EliminacionesDataset` compatible al 100% con `src/types/antena.ts`,
    deduplicado por `id` y ordenado por lote de escaneo y antena.
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
            "antenasEliminadas": 0,
            "frecuenciasEliminadas": 0,
            "eliminaciones": [],
        }

    sorted_items = sort_eliminaciones_grouped(eliminaciones)
    antenas_eliminadas = sum(1 for e in sorted_items if e.get("tipo") == "antena")
    frecuencias_eliminadas = sum(
        1 for e in sorted_items if e.get("tipo") == "frecuencia"
    )

    return {
        "updatedAt": ts,
        "scanId": effective_scan_id,
        "previousScanAt": previous_scan_at,
        "isBaselineScan": False,
        "total": len(sorted_items),
        "antenasEliminadas": antenas_eliminadas,
        "frecuenciasEliminadas": frecuencias_eliminadas,
        "eliminaciones": sorted_items,
    }


def write_eliminaciones_dataset(
    eliminaciones_dataset: dict[str, Any], output_path: Path
) -> int:
    """Escribe `eliminaciones_dataset` en JSON UTF-8 de forma atómica."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(output_path.name + ".tmp")
    encoded = json.dumps(
        eliminaciones_dataset, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    tmp_path.write_bytes(encoded)
    os.replace(tmp_path, output_path)
    return len(encoded)


def _extract_stamped_eliminaciones_from_doc(
    doc: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not isinstance(doc, dict):
        return []
    raw_items = [
        dict(item)
        for item in (doc.get("eliminaciones") or [])
        if isinstance(item, dict)
    ]
    if doc.get("isBaselineScan") and not raw_items:
        return []
    doc_scan_id = str(doc.get("scanId") or "").strip()
    can_stamp = bool(doc_scan_id and not doc_scan_id.startswith("baseline"))
    for item in raw_items:
        item["op"] = _normalize_operator_key(item.get("op"), item.get("opRaw"))
        if can_stamp and not str(item.get("scanId") or "").strip():
            item["scanId"] = doc_scan_id
    return raw_items


def merge_eliminaciones_datasets(
    base_doc: dict[str, Any] | None,
    incoming_doc: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Fusiona sin pérdidas dos documentos `EliminacionesDataset` (`base_doc` e `incoming_doc`),
    conservando permanentemente todas las eliminaciones históricas y las nuevas agrupadas por escaneo.
    """
    if base_doc is None and incoming_doc is None:
        return build_eliminaciones_dataset([], is_baseline_scan=False)

    base_items = _extract_stamped_eliminaciones_from_doc(base_doc)
    incoming_items = _extract_stamped_eliminaciones_from_doc(incoming_doc)
    combined_items = [*base_items, *incoming_items]

    base_ts = _doc_updated_timestamp(base_doc)
    inc_ts = _doc_updated_timestamp(incoming_doc)
    if incoming_doc is not None and (base_doc is None or inc_ts >= base_ts):
        newest_doc = incoming_doc
        older_doc = base_doc
    else:
        assert base_doc is not None
        newest_doc = base_doc
        older_doc = incoming_doc

    scan_id = (
        str(newest_doc.get("scanId") or "").strip()
        or str((older_doc or {}).get("scanId") or "").strip()
    )
    updated_at_raw = str(newest_doc.get("updatedAt") or "").strip() or str(
        (older_doc or {}).get("updatedAt") or ""
    ).strip()
    updated_at = updated_at_raw or None
    if "previousScanAt" in newest_doc:
        previous_scan_at = newest_doc.get("previousScanAt")
    elif older_doc is not None and "previousScanAt" in older_doc:
        previous_scan_at = older_doc.get("previousScanAt")
    else:
        previous_scan_at = None

    is_baseline = bool(
        not combined_items
        and incoming_doc is not None
        and incoming_doc.get("isBaselineScan")
        and (base_doc is None or base_doc.get("isBaselineScan"))
    )

    return build_eliminaciones_dataset(
        combined_items,
        scan_id=scan_id,
        previous_scan_at=previous_scan_at,
        updated_at=updated_at,
        is_baseline_scan=is_baseline,
    )


def merge_eliminaciones_files(target_path: Path, incoming_path: Path) -> None:
    """Fusiona de forma atómica y sin pérdidas `incoming_path` sobre `target_path`."""
    incoming_doc = load_eliminaciones_dataset(incoming_path)
    if incoming_doc is None:
        return
    if (
        target_path.exists()
        and incoming_path.exists()
        and target_path.read_bytes() == incoming_path.read_bytes()
    ):
        return
    base_doc = load_eliminaciones_dataset(target_path)
    merged_doc = merge_eliminaciones_datasets(base_doc, incoming_doc)
    write_eliminaciones_dataset(merged_doc, target_path)


_LIVE_CHUNK_RE = re.compile(r"^live-chunk-(\d+)\.json$")


class LiveDeltaStreamWriter:
    """
    Emisor atómico en tiempo real de lotes incrementales (`live-chunk-{k}.json` + `live-tail.json`)
    para sincronización instantánea con el mapa interactivo, Novedades y Eliminaciones.
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
        self._seen_removed_antenna_ids: set[str] = set()
        self._seen_eliminacion_ids: set[str] = set()

        self._tail_new_antennas: dict[str, dict[str, Any]] = {}
        self._tail_band_patches: dict[str, dict[str, Any]] = {}
        self._tail_novedades: dict[str, dict[str, Any]] = {}
        self._tail_removed_antenna_ids: set[str] = set()
        self._tail_eliminaciones: dict[str, dict[str, Any]] = {}
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
    def total_eliminaciones(self) -> int:
        return len(self._seen_eliminacion_ids)

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
        for rid in doc.get("removedAntennaIds") or ():
            if isinstance(rid, str) and rid.strip():
                self._seen_removed_antenna_ids.add(rid.strip())
        if self.record_novedades:
            for nov in doc.get("novedades") or ():
                if isinstance(nov, dict) and nov.get("id"):
                    self._seen_novedad_ids.add(str(nov["id"]))
            for elim in doc.get("eliminaciones") or ():
                if isinstance(elim, dict) and elim.get("id"):
                    self._seen_eliminacion_ids.add(str(elim["id"]))

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
                        ant_copy = dict(ant)
                        ant_copy["op"] = _normalize_operator_key(
                            ant_copy.get("op"), ant_copy.get("opRaw")
                        )
                        self._tail_new_antennas[str(ant["id"])] = ant_copy
                for patch in tdoc.get("bandPatches") or ():
                    if isinstance(patch, dict) and patch.get("id"):
                        self._tail_band_patches[str(patch["id"])] = dict(patch)
                for rid in tdoc.get("removedAntennaIds") or ():
                    if isinstance(rid, str) and rid.strip():
                        self._tail_removed_antenna_ids.add(rid.strip())
                if self.record_novedades:
                    for nov in tdoc.get("novedades") or ():
                        if isinstance(nov, dict) and nov.get("id"):
                            nov_copy = dict(nov)
                            nov_copy["op"] = _normalize_operator_key(
                                nov_copy.get("op"), nov_copy.get("opRaw")
                            )
                            self._tail_novedades[str(nov["id"])] = nov_copy
                    for elim in tdoc.get("eliminaciones") or ():
                        if isinstance(elim, dict) and elim.get("id"):
                            elim_copy = dict(elim)
                            elim_copy["op"] = _normalize_operator_key(
                                elim_copy.get("op"), elim_copy.get("opRaw")
                            )
                            self._tail_eliminaciones[str(elim["id"])] = elim_copy

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
            + len(self._tail_removed_antenna_ids)
            + len(self._tail_eliminaciones)
        )

    def _build_chunk_payload(self, *, chunk_index: int, is_tail: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
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
                sort_novedades_grouped(list(self._tail_novedades.values()))
                if self.record_novedades
                else []
            ),
        }
        if self._tail_removed_antenna_ids:
            payload["removedAntennaIds"] = sorted(self._tail_removed_antenna_ids)
        if self.record_novedades and self._tail_eliminaciones:
            payload["eliminaciones"] = sort_eliminaciones_grouped(
                list(self._tail_eliminaciones.values())
            )
        return payload

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
        self._tail_removed_antenna_ids.clear()
        self._tail_eliminaciones.clear()
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
        ant_copy = dict(ant)
        if "op" in ant_copy or "opRaw" in ant_copy:
            ant_copy["op"] = _normalize_operator_key(
                ant_copy.get("op"), ant_copy.get("opRaw")
            )
        self._seen_new_antenna_ids.add(ant_id)
        self._tail_new_antennas[ant_id] = ant_copy
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
        nov_copy = dict(nov)
        nov_copy["op"] = _normalize_operator_key(
            nov_copy.get("op"), nov_copy.get("opRaw")
        )
        if self.scan_id and not str(nov_copy.get("scanId") or "").strip():
            nov_copy["scanId"] = self.scan_id
        self._seen_novedad_ids.add(nov_id)
        self._tail_novedades[nov_id] = nov_copy
        self._dirty = True
        if self._tail_item_count() >= self.chunk_capacity:
            self._seal_current_tail_as_chunk()

    def _insert_removed_antenna_id(self, ant_id: str) -> None:
        clean_id = str(ant_id or "").strip()
        if not clean_id:
            return
        self._seen_removed_antenna_ids.add(clean_id)
        self._tail_removed_antenna_ids.add(clean_id)
        self._dirty = True
        if self._tail_item_count() >= self.chunk_capacity:
            self._seal_current_tail_as_chunk()

    def _insert_eliminacion(self, elim: dict[str, Any]) -> None:
        if not self.record_novedades:
            return
        elim_id = str(elim.get("id") or "").strip()
        if not elim_id:
            return
        elim_copy = dict(elim)
        elim_copy["op"] = _normalize_operator_key(
            elim_copy.get("op"), elim_copy.get("opRaw")
        )
        if self.scan_id and not str(elim_copy.get("scanId") or "").strip():
            elim_copy["scanId"] = self.scan_id
        self._seen_eliminacion_ids.add(elim_id)
        self._tail_eliminaciones[elim_id] = elim_copy
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

    def record_removed_antennas(
        self,
        removed_antenna_ids: set[str] | list[str],
        eliminaciones: list[dict[str, Any]],
    ) -> bool:
        eff_elims = eliminaciones if self.record_novedades else []
        if not removed_antenna_ids and not eff_elims:
            return False

        for rid in sorted(removed_antenna_ids):
            self._insert_removed_antenna_id(rid)
        for elim in eff_elims:
            if isinstance(elim, dict):
                self._insert_eliminacion(elim)

        return self._maybe_flush_after_insert(force_flush=True, urgent=True)

    def record_band_updates(
        self,
        patches: list[dict[str, Any]],
        freq_novedades: list[dict[str, Any]],
        freq_eliminaciones: list[dict[str, Any]] | None = None,
        *,
        force_flush: bool = False,
    ) -> bool:
        eff_novs = freq_novedades if self.record_novedades else []
        eff_elims = (freq_eliminaciones or []) if self.record_novedades else []
        if not patches and not eff_novs and not eff_elims:
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
        for elim in eff_elims:
            if isinstance(elim, dict):
                self._insert_eliminacion(elim)

        return self._maybe_flush_after_insert(
            force_flush=force_flush,
            urgent=bool(eff_novs or eff_elims),
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


class _PendingEmptyBandsVerification(Exception):
    """Indica que una estación con bandas previas devolvió una tabla técnica limpia sin filas y requiere confirmación secuencial en calma."""


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
        max_requests_per_second: float | None = None,
        fail_fast: bool = False,
        rescan_since: str | None = None,
        new_antenna_ids: set[str] | None = None,
        prior_index: dict[str, Any] | None = None,
        raw_records_by_op_gid: dict[tuple[str, str], dict[str, Any]] | None = None,
        record_novedades: bool = True,
        novedades_checkpoint_fn: Callable[[list[dict[str, Any]]], None] | None = None,
        eliminaciones_checkpoint_fn: Callable[[list[dict[str, Any]]], None] | None = None,
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
        if max_requests_per_second is None:
            self.max_requests_per_second = (
                DEFAULT_MAX_BAND_RPS
                if (fetch_fn is None and self.delay_seconds > 0.0)
                else 0.0
            )
        else:
            self.max_requests_per_second = max(0.0, float(max_requests_per_second))
        self.fail_fast = bool(fail_fast)
        self.rescan_since = (
            _normalize_iso_utc(rescan_since) if rescan_since else None
        )
        self.new_antenna_ids: set[str] = set(new_antenna_ids or ())
        self.prior_index = prior_index
        self._raw_records_by_op_gid = raw_records_by_op_gid
        self.record_novedades = bool(record_novedades)
        self._novedades_checkpoint_fn = novedades_checkpoint_fn
        self._eliminaciones_checkpoint_fn = eliminaciones_checkpoint_fn
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
        self.anomalous_responses_count: int = 0
        self.verified_empty_removals_count: int = 0
        self.last_requests_per_second: float = 0.0
        self.last_scanned_antennas: int = 0
        self.last_total_antennas: int = 0
        self.saved_final_checkpoint: bool = False
        self.discovered_novedades: list[dict[str, Any]] = []
        self._seen_novedad_ids: set[str] = set()
        self._current_op_gids: set[tuple[str, str]] | None = None
        self._pending_movistar_n78_splits: dict[int, list[dict[str, Any]]] = {}
        self._pending_split_live_siblings: list[dict[str, Any]] = []
        self.discovered_eliminaciones: list[dict[str, Any]] = []
        self._seen_eliminacion_ids: set[str] = set()
        self._last_request_ts: float | None = None
        self._unsaved_requests: int = 0
        self._last_saved_novedades_len: int = -1
        self._last_saved_eliminaciones_len: int = -1

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
        self._http_client.wait_if_cooled_down(self._clock, self._sleep)
        if self.max_requests_per_second > 0.0:
            self._http_client.pace_global_rate(
                self.max_requests_per_second, self._clock, self._sleep
            )
        if self._last_request_ts is not None and self.delay_seconds > 0:
            elapsed = self._clock() - self._last_request_ts
            remaining = self.delay_seconds - elapsed
            if remaining > 0:
                self._sleep(remaining)

    def _wait_worker_rate_limit(self) -> None:
        jitter_max = 0.35 if self._sleep is time.sleep else 0.0
        self._http_client.wait_if_cooled_down(
            self._clock, self._sleep, jitter_max=jitter_max
        )
        adaptive_delay = self._http_client.get_adaptive_delay()
        if adaptive_delay > 0.0:
            last_done_ts: float | None = getattr(self._worker_tls, "last_done_ts", None)
            if last_done_ts is not None:
                rem_adapt = adaptive_delay - (self._clock() - last_done_ts)
                if rem_adapt > 0.0:
                    self._sleep(rem_adapt)
        last_ts: float | None = getattr(self._worker_tls, "last_req_ts", None)
        if last_ts is not None and self.delay_seconds > 0:
            elapsed = self._clock() - last_ts
            remaining = self.delay_seconds - elapsed
            if remaining > 0:
                self._sleep(remaining)
        if self.max_requests_per_second > 0.0:
            self._http_client.pace_global_rate(
                self.max_requests_per_second, self._clock, self._sleep
            )

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

    def _evaluate_detalle_html(
        self,
        html: str,
        *,
        attempt: int,
        expect_nonempty: bool,
        live_http: bool,
    ) -> list[dict[str, Any]]:
        entries, html_status = inspect_detalle_estacion_html(html)
        if html_status == "ok":
            return entries

        if html_status in (
            "empty_html",
            "truncated_html",
            "error_page",
            "unexpected_html",
        ):
            with self._stats_lock:
                self.anomalous_responses_count += 1
            self._http_client.discard_tls_session()
            self._http_client.record_soft_anomaly(clock_fn=self._clock)
            raise ValueError(
                f"Respuesta HTML anómala desde detalleEstacion.do ({html_status})"
            )

        if html_status == "invalid_emplazamiento":
            if expect_nonempty:
                with self._stats_lock:
                    self.anomalous_responses_count += 1
                self._http_client.discard_tls_session()
                self._http_client.record_soft_anomaly(clock_fn=self._clock)
                raise ValueError(
                    "Respuesta 'Código de emplazamiento no válido' en estación con bandas previas"
                )
            if live_http and (
                attempt == 0
                or self._http_client.has_recent_soft_anomaly_burst(
                    clock_fn=self._clock
                )
            ):
                self._http_client.discard_tls_session()
                if attempt > 0:
                    with self._stats_lock:
                        self.anomalous_responses_count += 1
                    self._http_client.record_soft_anomaly(clock_fn=self._clock)
                raise ValueError(
                    "Verificando respuesta 'Código de emplazamiento no válido' en detalleEstacion.do"
                )
            return []

        if html_status == "valid_table_no_standard_ranges":
            return []

        if html_status == "valid_table_empty_rows":
            if not expect_nonempty:
                return []
            self._http_client.discard_tls_session()
            raise _PendingEmptyBandsVerification(
                "Tabla CARACTERISTICAS TÉCNICAS válida sin filas en estación con bandas previas"
            )

        if expect_nonempty:
            with self._stats_lock:
                self.anomalous_responses_count += 1
            self._http_client.discard_tls_session()
            self._http_client.record_soft_anomaly(clock_fn=self._clock)
            raise ValueError(
                f"Respuesta sin concesiones sospechosa para estación con bandas previas ({html_status})"
            )
        return []

    def _verify_genuine_empty_detalle(
        self,
        gid: str,
        *,
        required_confirmations: int = EMPTY_VERIFICATION_CONFIRMATIONS,
    ) -> list[dict[str, Any]]:
        """
        Verifica de forma secuencial, calmada y con sesiones limpias si una estación
        con bandas previas realmente ya no muestra concesiones en MINETUR
        (`valid_table_empty_rows`).
        - Exige `required_confirmations` (por defecto 2) respuestas consecutivas limpias
          sin ninguna ráfaga activa de anomalías.
        - Si en cualquier comprobación reaparecen concesiones (`ok`), las devuelve sin borrar nada.
        - Si ocurre cualquier error HTTP/HTML o ráfaga de anomalías, lanza `RuntimeError`
          para preservar intactas las bandas previas.
        """
        if self._http_client.has_recent_soft_anomaly_burst(clock_fn=self._clock):
            raise RuntimeError(
                f"Ráfaga reciente de anomalías activa; omitiendo vaciado de bandas en emplazamiento={gid!r}"
            )

        url = build_detalle_estacion_url(gid)
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) WebDeAntenasSpainCrawler/1.0"
            ),
            "Accept": "text/html,application/xhtml+xml,*/*",
        }

        confirmations = 0
        needed = max(1, int(required_confirmations))
        for check_idx in range(needed):
            if (
                self.max_band_requests is not None
                and self.requests_count >= self.max_band_requests
            ):
                raise RuntimeError(
                    f"Presupuesto de peticiones agotado antes de confirmar vaciado en emplazamiento={gid!r}"
                )
            if check_idx > 0 and self._sleep is time.sleep:
                self._sleep(1.0)
            self._http_client.discard_tls_session()
            self._wait_rate_limit()
            with self._stats_lock:
                self.requests_count += 1
                self._unsaved_requests += 1

            try:
                if self._custom_fetch_fn is not None:
                    payload = self._custom_fetch_fn(gid)
                    self._last_request_ts = self._clock()
                    html = (
                        decode_detalle_estacion_payload(payload)
                        if isinstance(payload, (bytes, bytearray))
                        else str(payload)
                    )
                else:
                    raw_bytes = self._http_client.fetch_bytes(
                        url,
                        headers=headers,
                        timeout=self.timeout_seconds,
                        clock_fn=self._clock,
                    )
                    self._last_request_ts = self._clock()
                    html = decode_detalle_estacion_payload(raw_bytes)
            except Exception as exc:
                self._last_request_ts = self._clock()
                self._http_client.discard_tls_session()
                raise RuntimeError(
                    f"Error durante verificación en calma de emplazamiento={gid!r}: {exc}"
                ) from exc

            entries, html_status = inspect_detalle_estacion_html(html)
            if html_status == "ok":
                return entries
            if html_status == "valid_table_no_standard_ranges":
                return []
            if html_status == "valid_table_empty_rows":
                if self._http_client.has_recent_soft_anomaly_burst(
                    clock_fn=self._clock
                ):
                    raise RuntimeError(
                        f"Ráfaga de anomalías durante verificación en calma de emplazamiento={gid!r}"
                    )
                confirmations += 1
                continue

            with self._stats_lock:
                self.anomalous_responses_count += 1
            self._http_client.discard_tls_session()
            self._http_client.record_soft_anomaly(clock_fn=self._clock)
            raise RuntimeError(
                f"Respuesta anómala ({html_status}) al verificar vaciado en emplazamiento={gid!r}"
            )

        with self._stats_lock:
            self.verified_empty_removals_count += 1
        logging.info(
            "Confirmada retirada real de todas las bandas en emplazamiento=%s (%d/%d verificaciones limpias).",
            gid,
            confirmations,
            needed,
        )
        return []

    def _http_fetch_detalle(
        self,
        gid: str,
        *,
        parallel_mode: bool = False,
        expect_nonempty: bool = False,
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
                        self._worker_tls.last_done_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    html = (
                        decode_detalle_estacion_payload(payload)
                        if isinstance(payload, (bytes, bytearray))
                        else str(payload)
                    )
                    return self._evaluate_detalle_html(
                        html,
                        attempt=attempt,
                        expect_nonempty=expect_nonempty,
                        live_http=False,
                    )
                except _PendingEmptyBandsVerification:
                    if not parallel_mode:
                        return self._verify_genuine_empty_detalle(gid)
                    if attempt >= 1:
                        raise
                    last_err = _PendingEmptyBandsVerification(gid)
                except Exception as exc:
                    now_ts = self._clock()
                    if parallel_mode:
                        self._worker_tls.last_req_ts = now_ts
                        self._worker_tls.last_done_ts = now_ts
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
                        self._worker_tls.last_done_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    html = decode_detalle_estacion_payload(raw_bytes)
                    return self._evaluate_detalle_html(
                        html,
                        attempt=attempt,
                        expect_nonempty=expect_nonempty,
                        live_http=True,
                    )
                except _PendingEmptyBandsVerification:
                    if not parallel_mode:
                        return self._verify_genuine_empty_detalle(gid)
                    if attempt >= 1:
                        raise
                    last_err = _PendingEmptyBandsVerification(gid)
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
                        self._worker_tls.last_done_ts = now_ts
                    else:
                        self._last_request_ts = now_ts
                    last_err = exc

            if isinstance(last_err, urllib.error.HTTPError) and last_err.code in (
                400,
                401,
                403,
                404,
                410,
            ):
                break

            if attempt < len(backoffs) - 1:
                wait_s = backoffs[attempt]
                if self._sleep is time.sleep:
                    wait_s += random.uniform(0.0, 0.4)
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
        force_novedades: bool = False,
    ) -> None:
        antenas = dataset.get("antenas") or []
        crawl_stats = dataset.setdefault("crawlStats", {})
        crawl_stats["bandsPopulatedCount"] = (
            int(populated_count)
            if populated_count is not None
            else count_bands_populated(antenas)
        )
        with self._stats_lock:
            crawl_stats["bandRequestsCount"] = self.requests_count
            self._unsaved_requests = 0
        dataset["updatedAt"] = _utc_now_iso(self._now_utc)
        if self.checkpoint_path is not None:
            write_compact_dataset(dataset, self.checkpoint_path)
        if self._novedades_checkpoint_fn is not None:
            cur_nov_len = len(self.discovered_novedades)
            if force_novedades or cur_nov_len != self._last_saved_novedades_len:
                self._novedades_checkpoint_fn(self.discovered_novedades)
                self._last_saved_novedades_len = cur_nov_len
        if self._eliminaciones_checkpoint_fn is not None:
            cur_elim_len = len(self.discovered_eliminaciones)
            if force_novedades or cur_elim_len != self._last_saved_eliminaciones_len:
                self._eliminaciones_checkpoint_fn(self.discovered_eliminaciones)
                self._last_saved_eliminaciones_len = cur_elim_len

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
        batch_freq_elims: list[dict[str, Any]] | None = None,
        gids_by_idx: dict[int, list[str]] | None = None,
        remaining_by_gid: dict[str, int] | None = None,
    ) -> tuple[int, int]:
        """
        Actualiza todas las antenas pendientes de `gid` cuyos GIDs asociados ya están en caché.
        Devuelve `(newly_populated_delta, populated_count_delta)` en O(1) y libera las entradas
        de `gid_entries_cache` ya consumidas por completo para mantener la RAM acotada.
        """
        newly_delta = 0
        populated_delta = 0

        for rec_idx in pending_by_gid.get(gid, ()):
            if rec_idx in completed_pending_indices:
                continue
            rec = antenas[rec_idx]
            rec_gids = (
                gids_by_idx[rec_idx]
                if gids_by_idx is not None and rec_idx in gids_by_idx
                else get_record_gids(rec)
            )
            if not all(g in gid_entries_cache for g in rec_gids):
                continue

            completed_pending_indices.add(rec_idx)
            matched_entries: list[dict[str, Any]] = []
            entries_by_gid: dict[str, list[dict[str, Any]]] = {}
            for rg in rec_gids:
                rg_entries = _extract_record_concessions_for_gid(
                    rec,
                    gid_entries_cache[rg],
                    all_records_per_gid.get(rg, [rec]),
                )
                entries_by_gid[rg] = rg_entries
                matched_entries.extend(rg_entries)
            if remaining_by_gid is not None:
                for rg in rec_gids:
                    rem = remaining_by_gid.get(rg, 0) - 1
                    if rem <= 0:
                        remaining_by_gid.pop(rg, None)
                        gid_entries_cache.pop(rg, None)
                    else:
                        remaining_by_gid[rg] = rem

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
            new_freq_elims: list[dict[str, Any]] = []
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

                new_freq_elims = _diff_record_removed_frequencies(
                    rec,
                    matched_entries,
                    fetched_iso=fetched_iso,
                    new_antenna_ids=self.new_antenna_ids,
                    prior_index=self.prior_index,
                    current_op_gids=self._current_op_gids,
                )
                for elim in new_freq_elims:
                    elim_id = elim["id"]
                    if elim_id not in self._seen_eliminacion_ids:
                        self._seen_eliminacion_ids.add(elim_id)
                        self.discovered_eliminaciones.append(elim)

            should_split_movistar_n78 = (
                str(rec.get("op") or "").strip() == "movistar"
                and len(rec_gids) >= 2
                and sum(
                    1
                    for rg in rec_gids
                    if _entries_have_n78(entries_by_gid.get(rg, []))
                )
                >= 2
            )

            if should_split_movistar_n78:
                primary_gid = str(rec.get("gid") or "").strip()
                ordered_gids = (
                    [primary_gid] + [rg for rg in rec_gids if rg != primary_gid]
                    if primary_gid in rec_gids
                    else list(rec_gids)
                )
                split_records: list[dict[str, Any]] = []
                for rg in ordered_gids:
                    raw_meta = (
                        self._raw_records_by_op_gid.get(("movistar", rg))
                        if self._raw_records_by_op_gid is not None
                        else None
                    )
                    if raw_meta is not None:
                        member_rec = dict(raw_meta)
                        member_rec.pop("mergedGids", None)
                    else:
                        member_rec = dict(rec)
                        member_rec.pop("mergedGids", None)
                        member_rec["gid"] = rg
                        if rg != primary_gid:
                            op_raw_label = str(
                                rec.get("opRaw")
                                or "TELEFONICA MOVILES ESPAÑA, S.A.U."
                            ).strip()
                            member_rec["id"] = f"{op_raw_label} - {rg}"
                    rg_entries = entries_by_gid.get(rg, [])
                    rg_ranges = [
                        (float(e["minMhz"]), float(e["maxMhz"]))
                        for e in rg_entries
                    ]
                    rg_bandas, rg_freqs = summarize_frequency_ranges(rg_ranges)
                    rg_concs = summarize_concessions(rg_entries)
                    member_rec["bandas"] = rg_bandas
                    member_rec["frecuencias"] = rg_freqs
                    member_rec["concesiones"] = rg_concs
                    member_rec["bandsScannedAt"] = fetched_iso
                    split_records.append(member_rec)

                self._pending_movistar_n78_splits[rec_idx] = split_records
                primary_split = split_records[0]
                bandas_sorted = primary_split["bandas"]
                freqs_sorted = primary_split["frecuencias"]
                concs_sorted = primary_split["concesiones"]
                rec.pop("mergedGids", None)
                if not was_bandas_list:
                    populated_delta += 1
                rec["bandas"] = bandas_sorted
                rec["frecuencias"] = freqs_sorted
                rec["concesiones"] = concs_sorted
                rec["bandsScannedAt"] = fetched_iso
                newly_delta += 1

                if self._live_stream is not None:
                    batch_patches.append(
                        {
                            "id": rec["id"],
                            "gid": rec["gid"],
                            "mergedGids": [],
                            "bandas": bandas_sorted,
                            "frecuencias": freqs_sorted,
                            "concesiones": concs_sorted,
                            "bandsScannedAt": fetched_iso,
                        }
                    )
                    self._pending_split_live_siblings.extend(split_records[1:])
                    if new_freq_novs:
                        batch_freq_novs.extend(new_freq_novs)
                    if new_freq_elims and batch_freq_elims is not None:
                        batch_freq_elims.extend(new_freq_elims)
                continue

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
                    or bool(new_freq_elims)
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
                if new_freq_elims and batch_freq_elims is not None:
                    batch_freq_elims.extend(new_freq_elims)

        return newly_delta, populated_delta

    def enrich_dataset(self, dataset: dict[str, Any]) -> dict[str, Any]:
        antenas: list[dict[str, Any]] = dataset.get("antenas") or []
        crawl_stats = dataset.setdefault("crawlStats", {})
        self.saved_final_checkpoint = False
        self._pending_movistar_n78_splits = {}
        self._pending_split_live_siblings = []
        self._current_op_gids = {
            (str(r.get("op") or "").strip(), g)
            for r in antenas
            if isinstance(r, dict) and str(r.get("op") or "").strip()
            for g in get_record_gids(r)
        }

        all_records_per_gid: dict[str, list[dict[str, Any]]] = {}
        gids_by_idx: dict[int, list[str]] = {}
        prior_nonempty_gids: set[str] = set()
        populated_count = 0
        zero_gid_populated = 0
        pending_indices: list[int] = []
        pending_by_gid: dict[str, list[int]] = {}
        for idx, rec in enumerate(antenas):
            has_bandas = isinstance(rec.get("bandas"), list)
            if has_bandas:
                populated_count += 1
            gids = get_record_gids(rec)
            for g in gids:
                all_records_per_gid.setdefault(g, []).append(rec)
            rec_has_prior_rf = bool(rec.get("concesiones")) or bool(rec.get("bandas"))
            if not rec_has_prior_rf and self.prior_index is not None:
                prior_rec = match_prior_antenna(rec, self.prior_index)
                if prior_rec is not None:
                    rec_has_prior_rf = bool(prior_rec.get("concesiones")) or bool(
                        prior_rec.get("bandas")
                    )
            if rec_has_prior_rf:
                for g in gids:
                    prior_nonempty_gids.add(g)
            if not self._needs_band_scan(rec):
                if has_bandas:
                    rec["bandas"] = normalize_band_labels(rec["bandas"])
                continue
            if not gids:
                if not has_bandas:
                    populated_count += 1
                rec["bandas"] = []
                rec["frecuencias"] = []
                rec["concesiones"] = []
                rec["bandsScannedAt"] = _utc_now_iso(self._now_utc)
                zero_gid_populated += 1
                continue
            gids_by_idx[idx] = gids
            pending_indices.append(idx)
            for g in gids:
                pending_by_gid.setdefault(g, []).append(idx)

        remaining_by_gid: dict[str, int] = {
            g: len(idxs) for g, idxs in pending_by_gid.items()
        }

        total_antenas = len(antenas)
        already_scanned_in_cycle = total_antenas - len(pending_indices) - zero_gid_populated
        self.last_total_antennas = total_antenas
        self.last_scanned_antennas = already_scanned_in_cycle + zero_gid_populated

        if not pending_indices:
            self.last_scanned_antennas = total_antenas
            crawl_stats["bandsPopulatedCount"] = populated_count
            crawl_stats["bandRequestsCount"] = 0
            if zero_gid_populated > 0:
                self._save_dataset_checkpoint(
                    dataset, populated_count=populated_count, force_novedades=True
                )
                if self.checkpoint_path is not None:
                    self.saved_final_checkpoint = True
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
        fetched_gids: set[str] = set()
        completed_pending_indices: set[int] = set()
        failed_gids: set[str] = set()
        pending_empty_verify_gids: set[str] = set()
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
            "Iniciando enriquecimiento de bandas: %d antenas pendientes (%d unidades GID, workers=%d, delay=%.3fs, max_rps=%.1f)...",
            len(pending_indices),
            len(units),
            self.workers,
            self.delay_seconds,
            self.max_requests_per_second,
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
                        if g not in fetched_gids and g not in failed_gids
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
                                if g not in fetched_gids and g not in failed_gids
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
                            entries = self._http_fetch_detalle(
                                gid,
                                parallel_mode=False,
                                expect_nonempty=(gid in prior_nonempty_gids),
                            )
                            fetched_iso = _utc_now_iso(self._now_utc)
                            gid_entries_cache[gid] = entries
                            fetched_gids.add(gid)
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
                        batch_freq_elims: list[dict[str, Any]] = []
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
                            batch_freq_elims=batch_freq_elims,
                            gids_by_idx=gids_by_idx,
                            remaining_by_gid=remaining_by_gid,
                        )
                        newly_populated += n_delta
                        populated_count += p_delta

                        now = self._clock()
                        self.last_requests_per_second = round(
                            self.requests_count / max(0.001, now - run_start_ts), 2
                        )

                        flushed_live = False
                        if self._live_stream is not None and (
                            batch_patches or batch_freq_novs or batch_freq_elims
                        ):
                            flushed_live = self._live_stream.record_band_updates(
                                batch_patches,
                                batch_freq_novs,
                                batch_freq_elims,
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

                max_in_flight = max(1, self.workers * 4)
                max_consecutive_failures = max(15, self.workers * 2)
                gid_cursor = 0
                submitted_count = 0
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
                        if self.max_band_requests is not None:
                            with self._stats_lock:
                                cur_reqs_snap = self.requests_count
                            if max(submitted_count, cur_reqs_snap) >= self.max_band_requests:
                                return False
                        if self._would_exceed_time_budget(
                            run_start_ts, parallel_mode=True
                        ):
                            return False
                        return True

                    while _can_submit_next():
                        next_gid = ordered_gids[gid_cursor]
                        gid_cursor += 1
                        submitted_count += 1
                        fut = executor.submit(
                            self._http_fetch_detalle,
                            next_gid,
                            parallel_mode=True,
                            expect_nonempty=(next_gid in prior_nonempty_gids),
                        )
                        in_flight[fut] = next_gid

                    while in_flight:
                        done, _ = concurrent.futures.wait(
                            in_flight.keys(),
                            return_when=concurrent.futures.FIRST_COMPLETED,
                        )
                        batch_patches = []
                        batch_freq_novs = []
                        batch_freq_elims = []
                        last_done_gid = ""

                        for fut in done:
                            gid = in_flight.pop(fut)
                            last_done_gid = gid
                            try:
                                entries = fut.result()
                                fetched_iso = _utc_now_iso(self._now_utc)
                                gid_entries_cache[gid] = entries
                                fetched_gids.add(gid)
                                consecutive_failures = 0
                            except _PendingEmptyBandsVerification:
                                pending_empty_verify_gids.add(gid)
                                continue
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
                                batch_freq_elims=batch_freq_elims,
                                gids_by_idx=gids_by_idx,
                                remaining_by_gid=remaining_by_gid,
                            )
                            newly_populated += n_delta
                            populated_count += p_delta

                        while _can_submit_next():
                            next_gid = ordered_gids[gid_cursor]
                            gid_cursor += 1
                            submitted_count += 1
                            fut = executor.submit(
                                self._http_fetch_detalle,
                                next_gid,
                                parallel_mode=True,
                                expect_nonempty=(next_gid in prior_nonempty_gids),
                            )
                            in_flight[fut] = next_gid

                        now = self._clock()
                        with self._stats_lock:
                            cur_reqs = self.requests_count
                            unsaved_reqs = self._unsaved_requests
                        self.last_requests_per_second = round(
                            cur_reqs / max(0.001, now - run_start_ts), 2
                        )

                        flushed_live = False
                        if self._live_stream is not None and (
                            batch_patches or batch_freq_novs or batch_freq_elims
                        ):
                            flushed_live = self._live_stream.record_band_updates(
                                batch_patches,
                                batch_freq_novs,
                                batch_freq_elims,
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

                        if cur_reqs - last_log_req >= 500:
                            last_log_req = cur_reqs
                            logging.info(
                                "[bandas req #%d | %.1f req/s] emplazamiento=%s -> +%d antenas en esta sesión (total con bandas=%d/%d)",
                                cur_reqs,
                                self.last_requests_per_second,
                                last_done_gid,
                                newly_populated,
                                populated_count,
                                total_antenas,
                            )

                        if (
                            unsaved_reqs >= self.checkpoint_every
                            and (now - last_ckpt_ts)
                            >= MULTI_WORKER_CHECKPOINT_MIN_INTERVAL_S
                        ):
                            self._save_dataset_checkpoint(
                                dataset, populated_count=populated_count
                            )
                            last_ckpt_ts = self._clock()

                # Verificación secuencial en calma para estaciones cuya tabla técnica quedó vacía
                failed_empty_verify_gids: set[str] = set()
                if pending_empty_verify_gids:
                    if len(pending_empty_verify_gids) > EMPTY_VERIFICATION_MAX:
                        logging.warning(
                            "Se detectaron %d estaciones con tabla técnica vacía (> límite seguro %d); omitiendo vaciado masivo para proteger datos previos.",
                            len(pending_empty_verify_gids),
                            EMPTY_VERIFICATION_MAX,
                        )
                        for egid in pending_empty_verify_gids:
                            failed_empty_verify_gids.add(egid)
                            failed_gids.add(egid)
                            self.failed_gids_count += 1
                    elif (
                        not stop_submitting
                        and not self.fail_fast
                        and not self._would_exceed_time_budget(
                            run_start_ts, parallel_mode=True
                        )
                        and (
                            self.max_band_requests is None
                            or self.requests_count < self.max_band_requests
                        )
                    ):
                        verify_list = sorted(pending_empty_verify_gids)
                        logging.info(
                            "Verificando en modo secuencial calmado %d emplazamientos sin concesiones declaradas...",
                            len(verify_list),
                        )
                        burst_wait_s = (
                            self._http_client.seconds_until_soft_anomaly_burst_clears(
                                clock_fn=self._clock
                            )
                        )
                        if burst_wait_s > 0.0:
                            sleep_burst = burst_wait_s + 0.5
                            if not self._would_exceed_time_budget(
                                run_start_ts - sleep_burst, parallel_mode=True
                            ):
                                logging.info(
                                    "Esperando %.1fs a que expire la ventana de anomalías reciente antes de verificar vaciados reales...",
                                    sleep_burst,
                                )
                                self._sleep(sleep_burst)
                        elif self._sleep is time.sleep:
                            self._sleep(1.5)
                        ver_patches: list[dict[str, Any]] = []
                        ver_novs: list[dict[str, Any]] = []
                        ver_elims: list[dict[str, Any]] = []
                        for egid in verify_list:
                            if self._would_exceed_time_budget(
                                run_start_ts, parallel_mode=True
                            ):
                                failed_empty_verify_gids.add(egid)
                                failed_gids.add(egid)
                                self.failed_gids_count += 1
                                continue
                            if (
                                self.max_band_requests is not None
                                and self.requests_count >= self.max_band_requests
                            ):
                                failed_empty_verify_gids.add(egid)
                                failed_gids.add(egid)
                                self.failed_gids_count += 1
                                continue
                            try:
                                entries = self._verify_genuine_empty_detalle(egid)
                                fetched_iso = _utc_now_iso(self._now_utc)
                                gid_entries_cache[egid] = entries
                                fetched_gids.add(egid)
                                n_delta, p_delta = self._apply_completed_gid(
                                    egid,
                                    fetched_iso,
                                    antenas=antenas,
                                    pending_by_gid=pending_by_gid,
                                    completed_pending_indices=completed_pending_indices,
                                    gid_entries_cache=gid_entries_cache,
                                    all_records_per_gid=all_records_per_gid,
                                    batch_patches=ver_patches,
                                    batch_freq_novs=ver_novs,
                                    batch_freq_elims=ver_elims,
                                    gids_by_idx=gids_by_idx,
                                    remaining_by_gid=remaining_by_gid,
                                )
                                newly_populated += n_delta
                                populated_count += p_delta
                            except RuntimeError as exc:
                                failed_empty_verify_gids.add(egid)
                                failed_gids.add(egid)
                                self.failed_gids_count += 1
                                logging.warning(
                                    "No se confirmó vaciado en emplazamiento=%s (se preservan bandas previas): %s",
                                    egid,
                                    exc,
                                )
                        if self._live_stream is not None and (
                            ver_patches or ver_novs or ver_elims
                        ):
                            self._live_stream.record_band_updates(
                                ver_patches, ver_novs, ver_elims
                            )
                    else:
                        for egid in pending_empty_verify_gids:
                            failed_empty_verify_gids.add(egid)
                            failed_gids.add(egid)
                            self.failed_gids_count += 1

                # Ola suave de recuperación secuencial para fallos puntuales de red (evita lanzar Parte 2/2 por pocos GIDs)
                transient_failed_gids = failed_gids - failed_empty_verify_gids
                if (
                    transient_failed_gids
                    and not stop_submitting
                    and not self.fail_fast
                    and len(transient_failed_gids) <= FAILED_GID_RECOVERY_MAX
                    and not self._would_exceed_time_budget(run_start_ts, parallel_mode=True)
                    and (
                        self.max_band_requests is None
                        or self.requests_count < self.max_band_requests
                    )
                ):
                    recovery_list = sorted(transient_failed_gids)
                    logging.info(
                        "Reintentando %d emplazamientos con fallo transitorio en modo suave...",
                        len(recovery_list),
                    )
                    if self._sleep is time.sleep:
                        self._sleep(1.5)
                    rec_patches: list[dict[str, Any]] = []
                    rec_novs: list[dict[str, Any]] = []
                    rec_elims: list[dict[str, Any]] = []
                    recovered_count = 0
                    for rgid in recovery_list:
                        if self._would_exceed_time_budget(run_start_ts, parallel_mode=True):
                            break
                        if (
                            self.max_band_requests is not None
                            and self.requests_count >= self.max_band_requests
                        ):
                            break
                        try:
                            entries = self._http_fetch_detalle(
                                rgid,
                                parallel_mode=False,
                                expect_nonempty=(rgid in prior_nonempty_gids),
                            )
                            fetched_iso = _utc_now_iso(self._now_utc)
                            gid_entries_cache[rgid] = entries
                            fetched_gids.add(rgid)
                            failed_gids.discard(rgid)
                            self.failed_gids_count = max(0, self.failed_gids_count - 1)
                            recovered_count += 1
                            n_delta, p_delta = self._apply_completed_gid(
                                rgid,
                                fetched_iso,
                                antenas=antenas,
                                pending_by_gid=pending_by_gid,
                                completed_pending_indices=completed_pending_indices,
                                gid_entries_cache=gid_entries_cache,
                                all_records_per_gid=all_records_per_gid,
                                batch_patches=rec_patches,
                                batch_freq_novs=rec_novs,
                                batch_freq_elims=rec_elims,
                                gids_by_idx=gids_by_idx,
                                remaining_by_gid=remaining_by_gid,
                            )
                            newly_populated += n_delta
                            populated_count += p_delta
                        except RuntimeError as exc:
                            logging.error("Recuperación fallida para emplazamiento=%s: %s", rgid, exc)
                    if recovered_count > 0:
                        logging.info(
                            "Recuperados %d/%d emplazamientos transitorios en la ola final.",
                            recovered_count,
                            len(recovery_list),
                        )
                        if self._live_stream is not None and (
                            rec_patches or rec_novs or rec_elims
                        ):
                            self._live_stream.record_band_updates(
                                rec_patches, rec_novs, rec_elims
                            )
        finally:
            self._http_client.close_all()

        topology_changed = False
        if self._pending_movistar_n78_splits:
            split_added = 0
            rebuilt_antenas: list[dict[str, Any]] = []
            for idx, rec in enumerate(antenas):
                split_group = self._pending_movistar_n78_splits.get(idx)
                if split_group:
                    rebuilt_antenas.extend(split_group)
                    split_added += len(split_group) - 1
                else:
                    rebuilt_antenas.append(rec)
            dataset["antenas"] = rebuilt_antenas
            antenas = rebuilt_antenas
            if split_added > 0:
                prev_exact_fused = int(crawl_stats.get("exactCoordFusedDuplicates") or 0)
                if prev_exact_fused > 0 or "exactCoordFusedDuplicates" in crawl_stats:
                    crawl_stats["exactCoordFusedDuplicates"] = max(
                        0, prev_exact_fused - split_added
                    )
                newly_populated += split_added
                topology_changed = True
            if self._live_stream is not None and self._pending_split_live_siblings:
                self._live_stream.record_provisional_new_antennas(
                    self._pending_split_live_siblings, []
                )
            self._pending_movistar_n78_splits = {}
            self._pending_split_live_siblings = []

        if _needs_exact_coord_fusion(antenas):
            refused_antenas, newly_refused = fuse_same_operator_exact_coords(antenas)
            if newly_refused > 0:
                dataset["antenas"] = refused_antenas
                antenas = refused_antenas
                prev_exact_fused = int(crawl_stats.get("exactCoordFusedDuplicates") or 0)
                crawl_stats["exactCoordFusedDuplicates"] = (
                    prev_exact_fused + newly_refused
                )
                topology_changed = True

        if topology_changed:
            populated_count = _recompute_dataset_aggregates(dataset)
            antenas = dataset["antenas"]
            total_antenas = len(antenas)

        if self._live_stream is not None:
            self._live_stream.record_band_updates([], [], force_flush=True)

        self.last_total_antennas = total_antenas
        self.last_scanned_antennas = min(
            total_antenas, already_scanned_in_cycle + newly_populated
        )
        with self._stats_lock:
            final_reqs = self.requests_count
        self.last_requests_per_second = round(
            final_reqs / max(0.001, self._clock() - run_start_ts), 2
        )
        crawl_stats["bandsPopulatedCount"] = populated_count
        crawl_stats["bandRequestsCount"] = final_reqs
        if final_reqs > 0 or zero_gid_populated > 0 or topology_changed:
            self._save_dataset_checkpoint(
                dataset, populated_count=populated_count, force_novedades=True
            )
            if self.checkpoint_path is not None:
                self.saved_final_checkpoint = True

        if self._progress_callback is not None:
            self._progress_callback(
                {
                    "phase": "frecuencias",
                    "scannedAntennas": self.last_scanned_antennas,
                    "totalAntennas": total_antenas,
                    "requestsPerSecond": self.last_requests_per_second,
                }
            )

        logging.info(
            "Enriquecimiento finalizado: %d peticiones HTTP (%.1f req/s), +%d antenas enriquecidas (%d/%d totales con bandas, fallos=%d, anomalias_html=%d, bajas_freq=%d, vaciados_confirmados=%d).",
            self.requests_count,
            self.last_requests_per_second,
            newly_populated,
            crawl_stats["bandsPopulatedCount"],
            total_antenas,
            self.failed_gids_count,
            self.anomalous_responses_count,
            len(self.discovered_eliminaciones),
            self.verified_empty_removals_count,
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
    max_requests_per_second: float | None = None,
    fail_fast: bool = False,
    rescan_since: str | None = None,
    new_antenna_ids: set[str] | None = None,
    prior_index: dict[str, Any] | None = None,
    raw_records_by_op_gid: dict[tuple[str, str], dict[str, Any]] | None = None,
    record_novedades: bool = True,
    novedades_checkpoint_fn: Callable[[list[dict[str, Any]]], None] | None = None,
    eliminaciones_checkpoint_fn: Callable[[list[dict[str, Any]]], None] | None = None,
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
        max_requests_per_second=max_requests_per_second,
        fail_fast=fail_fast,
        rescan_since=rescan_since,
        new_antenna_ids=new_antenna_ids,
        prior_index=prior_index,
        raw_records_by_op_gid=raw_records_by_op_gid,
        record_novedades=record_novedades,
        novedades_checkpoint_fn=novedades_checkpoint_fn,
        eliminaciones_checkpoint_fn=eliminaciones_checkpoint_fn,
        live_stream=live_stream,
        progress_callback=progress_callback,
        fetch_fn=fetch_fn,
        sleep_fn=sleep_fn,
        clock_fn=clock_fn,
        now_utc_fn=now_utc_fn,
    )
    return enricher.enrich_dataset(dataset)


def _recompute_dataset_aggregates(dataset: dict[str, Any]) -> int:
    """
    Reordena `dataset["antenas"]` por `(prov, mun, id)` y recalcula `total`,
    `operators`, `provinces` y `bandsPopulatedCount` de forma determinista.
    Devuelve el nuevo `bandsPopulatedCount`.
    """
    sorted_antenas = sorted(
        dataset.get("antenas") or [],
        key=lambda r: (
            str(r.get("prov") or ""),
            str(r.get("mun") or ""),
            str(r.get("id") or ""),
        ),
    )
    dataset["antenas"] = sorted_antenas
    dataset["total"] = len(sorted_antenas)

    op_counts: dict[str, int] = {k: 0 for k in OPERATOR_ORDER}
    op_entities: dict[str, set[str]] = {k: set() for k in OPERATOR_ORDER}
    prov_counts: dict[str, int] = {}
    prov_by_op: dict[str, dict[str, int]] = {}

    for rec in sorted_antenas:
        op_key = str(rec.get("op") or "")
        if op_key not in op_counts:
            op_key = "otros"
        op_counts[op_key] += 1
        if rec.get("opRaw"):
            op_entities[op_key].add(rec["opRaw"])

        prov = str(rec.get("prov") or "")
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

    dataset["operators"] = operators_summary
    dataset["provinces"] = provinces_summary
    populated_count = count_bands_populated(sorted_antenas)
    crawl_stats = dataset.setdefault("crawlStats", {})
    crawl_stats["bandsPopulatedCount"] = populated_count
    return populated_count


def build_dataset(
    records_by_id: dict[str, dict[str, Any]] | list[dict[str, Any]],
    crawl_stats: dict[str, Any],
    updated_at: str | None = None,
    max_distance_m: float = DEFAULT_VODAFONE_FUSION_M,
    preserve_from: dict[str, Any] | list[dict[str, Any]] | Path | str | None = None,
    prior_index: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Construye el objeto `AntenasDataset` tipado según `src/types/antena.ts`,
    fusionando previamente declaraciones duplicadas de Vodafone a `< max_distance_m`
    (por defecto `< 35 m`), integrando Xfera en Orange y fusionando declaraciones
    duplicadas de cualquier misma operadora en la misma coordenada exacta (incluyendo
    Orange y Telefónica, salvo cuando dos antenas de Telefónica tienen banda N78 cada una),
    preservando opcionalmente `bandas`/`frecuencias`/`concesiones` previas y ordenando
    las antenas determinísticamente por `(prov, mun, id)`.
    """
    raw_records = (
        list(records_by_id.values())
        if isinstance(records_by_id, dict)
        else list(records_by_id)
    )
    effective_prior_index = (
        prior_index
        if prior_index is not None
        else (build_prior_antenna_index(preserve_from) if preserve_from is not None else None)
    )
    fused_records, fused_count = fuse_vodafone_duplicates(
        raw_records, max_distance_m=max_distance_m
    )
    fused_records, _ = fuse_xfera_into_orange(
        fused_records, max_distance_m=DEFAULT_XFERA_ORANGE_FUSION_M
    )
    fused_records, exact_coord_fused_count = fuse_same_operator_exact_coords(
        fused_records,
        prior_index=effective_prior_index,
    )

    if preserve_from is not None:
        preserve_bands_in_records(
            fused_records,
            effective_prior_index if effective_prior_index is not None else preserve_from,
        )

    prior_fused = int(crawl_stats.get("vodafoneFusedDuplicates") or 0)
    crawl_stats_out = dict(crawl_stats)
    crawl_stats_out["vodafoneFusedDuplicates"] = prior_fused + fused_count
    prior_exact_fused = int(crawl_stats.get("exactCoordFusedDuplicates") or 0)
    if (
        exact_coord_fused_count > 0
        or "exactCoordFusedDuplicates" in crawl_stats
    ):
        crawl_stats_out["exactCoordFusedDuplicates"] = (
            prior_exact_fused + exact_coord_fused_count
        )

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

    timestamp = updated_at or _utc_now_iso()
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
        help="Segundos mínimos de espera por hilo tras cada respuesta HTTP (por defecto 0.02s).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_BAND_WORKERS,
        help="Hilos concurrentes Keep-Alive para detalleEstacion.do (por defecto 16).",
    )
    parser.add_argument(
        "--max-band-rps",
        type=float,
        default=DEFAULT_MAX_BAND_RPS,
        help="Límite global de peticiones por segundo hacia detalleEstacion.do (por defecto 75; 0 desactiva el techo).",
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
        choices=("append", "reset"),
        default="append",
        help="Modo de escritura de novedades: 'append' (por defecto) conserva permanentemente el historial de novedades previas y añade las nuevas sin sustituirlas; 'reset' reinicia el archivo desde cero.",
    )
    parser.add_argument(
        "--merge-novedades-from",
        default=None,
        help="Fusiona de forma atómica y sin pérdidas el archivo NovedadesDataset indicado sobre --novedades-output y finaliza.",
    )
    parser.add_argument(
        "--eliminaciones-output",
        default=None,
        help="Ruta opcional donde escribir el archivo EliminacionesDataset (ej. public/data/eliminaciones.json).",
    )
    parser.add_argument(
        "--eliminaciones-mode",
        choices=("append", "reset"),
        default="append",
        help="Modo de escritura de eliminaciones: 'append' (por defecto) conserva permanentemente el historial de bajas previas y añade las nuevas; 'reset' reinicia el archivo desde cero.",
    )
    parser.add_argument(
        "--merge-eliminaciones-from",
        default=None,
        help="Fusiona de forma atómica y sin pérdidas el archivo EliminacionesDataset indicado sobre --eliminaciones-output y finaliza.",
    )
    parser.add_argument(
        "--skip-novedades",
        action="store_true",
        help="No contabilizar este escaneo en las secciones Novedades ni Eliminaciones (escaneo forzado de línea base).",
    )
    parser.add_argument(
        "--scan-id",
        default="",
        help="Identificador único del lote de escaneo para NovedadesDataset y EliminacionesDataset.",
    )
    parser.add_argument(
        "--status-output",
        default=None,
        help="Ruta opcional donde escribir en tiempo real el JSON de estado del escaneo (scan-status.json).",
    )
    parser.add_argument(
        "--live-dir",
        default=None,
        help="Directorio donde emitir en tiempo real live-chunk-*.json y live-tail.json para sincronización instantánea con el mapa, novedades y eliminaciones.",
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
        help="Origen del escaneo ('schedule' para diario 00:05 o 'workflow_dispatch' para forzado).",
    )
    parser.add_argument(
        "--scan-part",
        default="",
        help="Etiqueta opcional del tramo en ejecución (ej. '1/2', '2/2').",
    )
    parser.add_argument(
        "--unico-output",
        default=None,
        help="Ruta opcional del archivo unico-5g.json cuyas declaraciones 5G se sincronizan tras actualizar antenas.json (por defecto <dir_output>/unico-5g.json si existe).",
    )
    parser.add_argument(
        "--skip-unico-sync",
        action="store_true",
        help="Omite la sincronización automática de declaraciones UNICO 5G tras actualizar antenas.json.",
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
    live_eliminaciones_count: int = 0,
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
    if live_eliminaciones_count > 0:
        payload["liveEliminacionesCount"] = int(live_eliminaciones_count)
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
    Configura la persistencia atómica de `novedades.json` para modos `'append'` y `'reset'`
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

    historical_items: list[dict[str, Any]] = []
    current_scan_prior_items: list[dict[str, Any]] = []
    effective_prev_scan_at = previous_scan_at

    if novedades_mode == "append":
        existing_doc = load_novedades_dataset(nov_path)
        if existing_doc is not None:
            raw_existing = [
                dict(item)
                for item in (existing_doc.get("novedades") or [])
                if isinstance(item, dict)
            ]
            existing_items = (
                raw_existing
                if (not existing_doc.get("isBaselineScan") or raw_existing)
                else []
            )
            doc_scan_id = str(existing_doc.get("scanId") or "").strip()
            same_scan_doc = bool(
                (effective_scan_id and doc_scan_id == effective_scan_id)
                or (not effective_scan_id and not existing_doc.get("isBaselineScan"))
            )
            if not effective_scan_id and doc_scan_id and same_scan_doc:
                effective_scan_id = doc_scan_id

            if same_scan_doc and "previousScanAt" in existing_doc:
                effective_prev_scan_at = existing_doc.get("previousScanAt")
            elif effective_prev_scan_at is None:
                prev_updated = existing_doc.get("updatedAt")
                if isinstance(prev_updated, str) and prev_updated.strip():
                    effective_prev_scan_at = prev_updated

            can_stamp_doc_scan = bool(
                doc_scan_id
                and doc_scan_id != effective_scan_id
                and not doc_scan_id.startswith("baseline")
            )
            for item in existing_items:
                item_scan_id = str(item.get("scanId") or "").strip()
                if (effective_scan_id and item_scan_id == effective_scan_id) or (
                    same_scan_doc and not item_scan_id
                ):
                    current_scan_prior_items.append(item)
                else:
                    if not item_scan_id and can_stamp_doc_scan:
                        item["scanId"] = doc_scan_id
                    historical_items.append(item)

    def _stamp_current(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
        stamped: list[dict[str, Any]] = []
        for item in raw_list:
            if not isinstance(item, dict):
                continue
            copy_item = dict(item)
            if effective_scan_id and not str(copy_item.get("scanId") or "").strip():
                copy_item["scanId"] = effective_scan_id
            stamped.append(copy_item)
        return stamped

    seeded_source_items = [*current_scan_prior_items, *(initial_novedades or [])]
    seeded_new_ant_ids = {
        str(item["antennaId"])
        for item in seeded_source_items
        if isinstance(item, dict)
        and item.get("tipo") == "antena"
        and item.get("antennaId")
    }
    historical_ids = {
        str(item.get("id") or "").strip()
        for item in historical_items
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }

    def _write_current(discovered: list[dict[str, Any]]) -> None:
        stamped_current = [
            item
            for item in _stamp_current(
                [*current_scan_prior_items, *(initial_novedades or []), *discovered]
            )
            if str(item.get("id") or "").strip() not in historical_ids
        ]
        nov_doc = build_novedades_dataset(
            [*historical_items, *stamped_current],
            scan_id=effective_scan_id,
            previous_scan_at=effective_prev_scan_at,
            is_baseline_scan=False,
        )
        write_novedades_dataset(nov_doc, nov_path)

    _write_current([])
    return _write_current, seeded_new_ant_ids


def _prepare_eliminaciones_writer(
    *,
    eliminaciones_output: str | Path | None,
    eliminaciones_mode: str,
    skip_novedades: bool,
    scan_id: str,
    previous_scan_at: str | None,
    initial_eliminaciones: list[dict[str, Any]] | None = None,
) -> Callable[[list[dict[str, Any]]], None] | None:
    """
    Configura la persistencia atómica de `eliminaciones.json` para modos `'append'` y `'reset'`
    (incluyendo `--skip-novedades`) y devuelve `checkpoint_writer_fn`.
    """
    if not eliminaciones_output:
        return None

    elim_path = Path(eliminaciones_output)
    effective_scan_id = str(scan_id or "").strip()

    if skip_novedades:
        if eliminaciones_mode == "reset" or not elim_path.exists():
            baseline_doc = build_eliminaciones_dataset(
                [],
                scan_id=effective_scan_id or "baseline-scan",
                previous_scan_at=previous_scan_at,
                is_baseline_scan=True,
            )
            write_eliminaciones_dataset(baseline_doc, elim_path)
        return None

    historical_items: list[dict[str, Any]] = []
    current_scan_prior_items: list[dict[str, Any]] = []
    effective_prev_scan_at = previous_scan_at

    if eliminaciones_mode == "append":
        existing_doc = load_eliminaciones_dataset(elim_path)
        if existing_doc is not None:
            raw_existing = [
                dict(item)
                for item in (existing_doc.get("eliminaciones") or [])
                if isinstance(item, dict)
            ]
            existing_items = (
                raw_existing
                if (not existing_doc.get("isBaselineScan") or raw_existing)
                else []
            )
            doc_scan_id = str(existing_doc.get("scanId") or "").strip()
            same_scan_doc = bool(
                (effective_scan_id and doc_scan_id == effective_scan_id)
                or (not effective_scan_id and not existing_doc.get("isBaselineScan"))
            )
            if not effective_scan_id and doc_scan_id and same_scan_doc:
                effective_scan_id = doc_scan_id

            if same_scan_doc and "previousScanAt" in existing_doc:
                effective_prev_scan_at = existing_doc.get("previousScanAt")
            elif effective_prev_scan_at is None:
                prev_updated = existing_doc.get("updatedAt")
                if isinstance(prev_updated, str) and prev_updated.strip():
                    effective_prev_scan_at = prev_updated

            can_stamp_doc_scan = bool(
                doc_scan_id
                and doc_scan_id != effective_scan_id
                and not doc_scan_id.startswith("baseline")
            )
            for item in existing_items:
                item_scan_id = str(item.get("scanId") or "").strip()
                if (effective_scan_id and item_scan_id == effective_scan_id) or (
                    same_scan_doc and not item_scan_id
                ):
                    current_scan_prior_items.append(item)
                else:
                    if not item_scan_id and can_stamp_doc_scan:
                        item["scanId"] = doc_scan_id
                    historical_items.append(item)

    def _stamp_current(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
        stamped: list[dict[str, Any]] = []
        for item in raw_list:
            if not isinstance(item, dict):
                continue
            copy_item = dict(item)
            if effective_scan_id and not str(copy_item.get("scanId") or "").strip():
                copy_item["scanId"] = effective_scan_id
            stamped.append(copy_item)
        return stamped

    historical_ids = {
        str(item.get("id") or "").strip()
        for item in historical_items
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }

    def _write_current(discovered: list[dict[str, Any]]) -> None:
        stamped_current = [
            item
            for item in _stamp_current(
                [
                    *current_scan_prior_items,
                    *(initial_eliminaciones or []),
                    *discovered,
                ]
            )
            if str(item.get("id") or "").strip() not in historical_ids
        ]
        elim_doc = build_eliminaciones_dataset(
            [*historical_items, *stamped_current],
            scan_id=effective_scan_id,
            previous_scan_at=effective_prev_scan_at,
            is_baseline_scan=False,
        )
        write_eliminaciones_dataset(elim_doc, elim_path)

    _write_current([])
    return _write_current


def _sync_unico_5g_declarations(
    dataset: dict[str, Any],
    output_path: Path,
    unico_output: str | None,
    skip_unico_sync: bool,
) -> bool:
    """
    Sincroniza de forma atómica las declaraciones 5G en `unico-5g.json` a partir del
    `dataset` recién actualizado en memoria (sin releer `antenas.json` desde disco).
    """
    if skip_unico_sync:
        return False

    target = Path(unico_output) if unico_output else output_path.parent / "unico-5g.json"
    if not target.exists():
        return False

    try:
        from scripts.build_unico_5g import sync_unico_5g_declarations_file
    except ImportError:
        script_dir = str(Path(__file__).resolve().parent)
        if script_dir not in sys.path:
            sys.path.insert(0, script_dir)
        from build_unico_5g import sync_unico_5g_declarations_file

    updated = sync_unico_5g_declarations_file(target, dataset)
    summary = updated.get("declaredSummary") or {}
    by_band = summary.get("byBand") or {}
    logging.info(
        "Sincronizado UNICO 5G en %s: %d/%d declaradas (N78=%d, N28=%d, N28+=%d).",
        target,
        int(summary.get("declared") or 0),
        int(summary.get("total") or 0),
        int(by_band.get("N78") or 0),
        int(by_band.get("N28") or 0),
        int(by_band.get("N28+") or 0),
    )
    return True


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    args = parse_args(argv)
    if args.merge_novedades_from or args.merge_eliminaciones_from:
        if args.merge_novedades_from:
            if not args.novedades_output:
                logging.error(
                    "Se requiere --novedades-output junto con --merge-novedades-from."
                )
                return 1
            merge_novedades_files(
                Path(args.novedades_output), Path(args.merge_novedades_from)
            )
        if args.merge_eliminaciones_from:
            if not args.eliminaciones_output:
                logging.error(
                    "Se requiere --eliminaciones-output junto con --merge-eliminaciones-from."
                )
                return 1
            merge_eliminaciones_files(
                Path(args.eliminaciones_output), Path(args.merge_eliminaciones_from)
            )
        return 0
    output_path = Path(args.output)
    status_path = Path(args.status_output) if args.status_output else None
    scan_started_iso = args.rescan_since or _utc_now_iso()
    delay = max(0.0, float(args.delay))
    band_workers = max(1, int(args.workers))
    max_band_rps = max(0.0, float(args.max_band_rps))
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
                live_eliminaciones_count=(
                    live_stream_ref.total_eliminaciones if live_stream_ref is not None else 0
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
        migrated_legacy_dataset = False
        if (
            "masmovil" in (dataset.get("operators") or {})
            or any(
                isinstance(r, dict) and r.get("op") == "masmovil"
                for r in (dataset.get("antenas") or [])
            )
            or _needs_exact_coord_fusion(dataset.get("antenas") or [])
        ):
            dataset = build_dataset(
                dataset.get("antenas") or [],
                crawl_stats=dataset.get("crawlStats") or {},
                updated_at=dataset.get("updatedAt"),
            )
            migrated_legacy_dataset = True
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
        elim_writer = _prepare_eliminaciones_writer(
            eliminaciones_output=args.eliminaciones_output,
            eliminaciones_mode=args.eliminaciones_mode,
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
            max_requests_per_second=max_band_rps,
            rescan_since=args.rescan_since,
            new_antenna_ids=seeded_new_ant_ids,
            record_novedades=not args.skip_novedades,
            novedades_checkpoint_fn=nov_writer,
            eliminaciones_checkpoint_fn=elim_writer,
            live_stream=live_stream,
            progress_callback=progress_cb,
        )
        enricher.enrich_dataset(dataset)
        if not enricher.saved_final_checkpoint and (
            enricher.requests_count > 0
            or migrated_legacy_dataset
            or output_path.resolve() != input_path.resolve()
        ):
            write_compact_dataset(dataset, output_path)
        if nov_writer is not None and not enricher.saved_final_checkpoint:
            nov_writer(enricher.discovered_novedades)
        if elim_writer is not None and not enricher.saved_final_checkpoint:
            elim_writer(enricher.discovered_eliminaciones)
        _sync_unico_5g_declarations(
            dataset,
            output_path,
            args.unico_output,
            args.skip_unico_sync,
        )
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
                    live_eliminaciones_count=(
                        live_stream.total_eliminaciones if live_stream is not None else 0
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
            "Modo --enrich-bands-only completado: %d/%d antenas con bandas en %s (%.2f MB, %d peticiones HTTP a %.1f req/s, +%d novedades, -%d bajas de frecuencia).",
            dataset["crawlStats"].get("bandsPopulatedCount", 0),
            dataset["total"],
            output_path,
            size_mb,
            enricher.requests_count,
            enricher.last_requests_per_second,
            len(enricher.discovered_novedades),
            len(enricher.discovered_eliminaciones),
        )
        return 0

    auto_checkpoint = False
    checkpoint_path: Path | None = Path(args.checkpoint) if args.checkpoint else None

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

    is_full_national_crawl = args.region == "all" and not bool(
        dataset["crawlStats"].get("isPartialSeed")
    )
    if (
        is_full_national_crawl
        and prior_index is not None
        and isinstance(prior_index.get("records"), list)
    ):
        prior_count = len(prior_index["records"])
        current_count = len(dataset["antenas"])
        if prior_count >= MIN_PRIOR_ANTENNAS_FOR_DROP_GUARD and current_count < int(
            prior_count * (1.0 - MAX_SAFE_CENSUS_DROP_RATIO)
        ):
            logging.error(
                "Caída anómala del censo nacional (%d -> %d antenas; caída > %.0f%%). "
                "Se aborta sin sobrescribir %s para evitar borrados falsos por fallo de MINETUR.",
                prior_count,
                current_count,
                MAX_SAFE_CENSUS_DROP_RATIO * 100.0,
                output_path,
            )
            return 1

    detected_ant_eliminaciones, removed_antenna_ids = (
        diff_removed_antennas(
            dataset["antenas"],
            prior_index,
            scanned_at_iso=dataset["updatedAt"],
        )
        if (is_full_national_crawl and prior_index is not None)
        else ([], set())
    )
    if (
        is_full_national_crawl
        and prior_index is not None
        and removed_antenna_ids
        and callable(getattr(crawler, "verify_missing_antennas", None))
    ):
        prior_by_id = prior_index.get("by_id") or {}
        candidate_missing_records = [
            prior_by_id[rid]
            for rid in sorted(removed_antenna_ids)
            if rid in prior_by_id
        ]
        if candidate_missing_records:
            restored_missing, _confirmed_removed_ids = crawler.verify_missing_antennas(
                candidate_missing_records
            )
            if restored_missing:
                merged_records = list(dataset["antenas"]) + restored_missing
                crawl_stats_copy = dict(dataset["crawlStats"])
                if hasattr(crawler, "requests_count"):
                    crawl_stats_copy["requestsCount"] = crawler.requests_count
                dataset = build_dataset(
                    merged_records,
                    crawl_stats=crawl_stats_copy,
                    updated_at=dataset["updatedAt"],
                    prior_index=prior_index,
                )
                detected_ant_eliminaciones, removed_antenna_ids = diff_removed_antennas(
                    dataset["antenas"],
                    prior_index,
                    scanned_at_iso=dataset["updatedAt"],
                )

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
        restored = preserve_bands_in_records(
            dataset["antenas"],
            prior_index if prior_index is not None else prior_dataset,
        )
        dataset["crawlStats"]["bandsPopulatedCount"] = count_bands_populated(
            dataset["antenas"]
        )
        prior_band_reqs = (prior_dataset.get("crawlStats") or {}).get("bandRequestsCount")
        if prior_band_reqs is not None and not args.fetch_bands:
            dataset["crawlStats"]["bandRequestsCount"] = int(prior_band_reqs)
        logging.info(
            "Preservadas bandas previas de %d antenas desde %s (antenas nuevas=%d, antenas eliminadas=%d).",
            restored,
            preserve_path,
            len(new_antenna_ids),
            len(removed_antenna_ids),
        )

    if live_stream is not None and prior_index is not None:
        canonical_new_antennas = [
            rec for rec in dataset["antenas"] if rec["id"] in new_antenna_ids
        ]
        reconciled = live_stream.reconcile_post_census_new_antennas(
            canonical_new_antennas,
            [] if args.skip_novedades else detected_ant_novedades,
        )
        recorded_removals = False
        if removed_antenna_ids or detected_ant_eliminaciones:
            recorded_removals = live_stream.record_removed_antennas(
                removed_antenna_ids,
                [] if args.skip_novedades else detected_ant_eliminaciones,
            )
        if (reconciled or recorded_removals) and progress_cb is not None:
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

    full_crawl_scan_id = str(args.scan_id or "").strip()
    if not full_crawl_scan_id and not args.skip_novedades:
        full_crawl_scan_id = f"scan-{_normalize_iso_utc(dataset['updatedAt'])}"
        if args.novedades_output:
            prev_nov_doc = load_novedades_dataset(args.novedades_output)
            if (
                prev_nov_doc is not None
                and str(prev_nov_doc.get("scanId") or "").strip() == full_crawl_scan_id
            ):
                full_crawl_scan_id = (
                    f"{full_crawl_scan_id}-{int(time.time() * 1000) % 100000}"
                )

    nov_writer, seeded_new_ant_ids = _prepare_novedades_writer(
        novedades_output=args.novedades_output,
        novedades_mode=args.novedades_mode,
        skip_novedades=args.skip_novedades,
        scan_id=full_crawl_scan_id,
        previous_scan_at=previous_scan_at,
        initial_novedades=[] if args.skip_novedades else detected_ant_novedades,
    )
    elim_writer = _prepare_eliminaciones_writer(
        eliminaciones_output=args.eliminaciones_output,
        eliminaciones_mode=args.eliminaciones_mode,
        skip_novedades=args.skip_novedades,
        scan_id=full_crawl_scan_id,
        previous_scan_at=previous_scan_at,
        initial_eliminaciones=[] if args.skip_novedades else detected_ant_eliminaciones,
    )
    all_new_ant_ids = new_antenna_ids | seeded_new_ant_ids

    if args.fetch_bands:
        raw_records_by_op_gid: dict[tuple[str, str], dict[str, Any]] = {}
        crawler_raw = getattr(crawler, "records_by_id", None)
        if isinstance(crawler_raw, dict):
            for raw_rec in crawler_raw.values():
                if not isinstance(raw_rec, dict):
                    continue
                r_op = _normalize_operator_key(raw_rec.get("op"), raw_rec.get("opRaw"))
                r_gid = str(raw_rec.get("gid") or "").strip()
                if r_op and r_gid:
                    raw_records_by_op_gid.setdefault((r_op, r_gid), raw_rec)
        enricher = BandEnricher(
            delay_seconds=delay,
            max_band_seconds=args.max_band_seconds,
            max_band_requests=args.max_band_requests,
            checkpoint_path=output_path,
            checkpoint_every=args.band_checkpoint_every,
            workers=band_workers,
            max_requests_per_second=max_band_rps,
            rescan_since=args.rescan_since,
            new_antenna_ids=all_new_ant_ids,
            prior_index=prior_index,
            raw_records_by_op_gid=raw_records_by_op_gid or None,
            record_novedades=not args.skip_novedades,
            novedades_checkpoint_fn=nov_writer,
            eliminaciones_checkpoint_fn=elim_writer,
            live_stream=live_stream,
            progress_callback=progress_cb,
        )
        enricher.enrich_dataset(dataset)
        if enricher.saved_final_checkpoint and output_path.exists():
            size_bytes = output_path.stat().st_size
        else:
            size_bytes = write_compact_dataset(dataset, output_path)
            if nov_writer is not None:
                nov_writer(enricher.discovered_novedades)
            if elim_writer is not None:
                elim_writer(enricher.discovered_eliminaciones)
        _sync_unico_5g_declarations(
            dataset,
            output_path,
            args.unico_output,
            args.skip_unico_sync,
        )
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
                    live_eliminaciones_count=(
                        live_stream.total_eliminaciones if live_stream is not None else 0
                    ),
                    requests_per_second=enricher.last_requests_per_second,
                    completed_dataset_updated_at=(
                        str(dataset.get("updatedAt") or "") if is_all_done else ""
                    ),
                ),
                status_path,
            )
    else:
        _sync_unico_5g_declarations(
            dataset,
            output_path,
            args.unico_output,
            args.skip_unico_sync,
        )
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
                    live_eliminaciones_count=(
                        live_stream.total_eliminaciones if live_stream is not None else 0
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
