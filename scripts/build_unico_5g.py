#!/usr/bin/env python3
"""
Generador determinista del dataset público `public/data/unico-5g.json`
a partir de los ficheros oficiales del Programa UNICO 5G Redes Activas:
  - Fase 1 (Convocatoria 2023): UNICO_5G_REDES_ACTIVAS_FASE_1.xlsx
    (descomprimiendo e incluyendo TODAS las filas, incluidas las 7.228 ocultas por AutoFiltro en Excel)
  - Fase 2 (Convocatoria 2024): Unico_5G_Redes_Activas_Fase_2.xlsx

Reglas de negocio:
  1. Se excluyen por completo el código de emplazamiento (`EMPLAZAMIENTO`) y el `ID PROPIETARIO`.
  2. Todos los proyectos en los que participa Orange (`ORANGE ESPAGNE S.A.`,
     `UTE ORANGE ESPAGNE Y ORANGE COMUNICACIONES FIJAS`, etc.) se agrupan dentro de `orange` ("Orange").
  3. Se resuelven los códigos INE municipales de 5 dígitos de Fase 2 al nombre oficial del municipio.
  4. Las provincias y comunidades autónomas se normalizan al estándar canónico de RadioMapa España,
     ordenadas alfabéticamente (sin rankings).
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import heapq
import json
import math
import os
from pathlib import Path
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from typing import Any

EXCEL_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_ID_ATTR = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"

OPERATOR_ORDER = ("movistar", "orange", "vodafone")

OPERATOR_LABELS: dict[str, str] = {
    "movistar": "Telefonica",
    "orange": "Orange",
    "vodafone": "Vodafone",
}

UNICO_MAX_MATCH_DISTANCE_KM = 1.0
EARTH_RADIUS_KM = 6371.0088
DEG_TO_RAD = math.pi / 180.0
GRID_CELL_DEG = 0.02

BIT_N28 = 1 << 0
BIT_N28_PLUS = 1 << 1
BIT_B20 = 1 << 2
BIT_G9 = 1 << 3
BIT_B3 = 1 << 4
BIT_B1 = 1 << 5
BIT_B38 = 1 << 6
BIT_B7 = 1 << 7
BIT_B7_PLUS = 1 << 8
BIT_N78 = 1 << 9
BIT_N258 = 1 << 10
BIT_SAW_2600_RANGE = 1 << 11
BIT_SAW_700_RANGE = 1 << 12
BIT_EXPLICIT_N28_CODE = 1 << 13
RF_BAND_BITS_MASK = 0x7FF
UNICO_DECLARED_ANY_MASK = BIT_N28 | BIT_N28_PLUS | BIT_N78

FREQ_NUM_TOKEN_RE = re.compile(r"\d+(?:[.,]\d+)?", re.ASCII)
GHZ_UNIT_RE = re.compile(r"ghz", re.IGNORECASE)
PLUS_COLLAPSE_RE = re.compile(r"\s*\+\s*")

DIRECT_BAND_CODE_BITS: dict[str, int] = {
    "n258": BIT_N258,
    "n78": BIT_N78,
    "b7+": BIT_B7_PLUS,
    "b7": BIT_B7,
    "b38": BIT_B38,
    "b1": BIT_B1,
    "b3": BIT_B3,
    "g9": BIT_G9,
    "b20": BIT_B20,
    "n28+": BIT_N28_PLUS,
    "n28": BIT_N28 | BIT_EXPLICIT_N28_CODE,
}

CANONICAL_PROVINCE_TO_CCAA: dict[str, str] = {
    "ALMERÍA": "Andalucía",
    "CÁDIZ": "Andalucía",
    "CÓRDOBA": "Andalucía",
    "GRANADA": "Andalucía",
    "HUELVA": "Andalucía",
    "JAÉN": "Andalucía",
    "MÁLAGA": "Andalucía",
    "SEVILLA": "Andalucía",
    "HUESCA": "Aragón",
    "TERUEL": "Aragón",
    "ZARAGOZA": "Aragón",
    "ASTURIAS": "Principado de Asturias",
    "ILLES BALEARS": "Illes Balears",
    "LAS PALMAS": "Canarias",
    "SANTA CRUZ DE TENERIFE": "Canarias",
    "CANTABRIA": "Cantabria",
    "ALBACETE": "Castilla-La Mancha",
    "CIUDAD REAL": "Castilla-La Mancha",
    "CUENCA": "Castilla-La Mancha",
    "GUADALAJARA": "Castilla-La Mancha",
    "TOLEDO": "Castilla-La Mancha",
    "ÁVILA": "Castilla y León",
    "BURGOS": "Castilla y León",
    "LEÓN": "Castilla y León",
    "PALENCIA": "Castilla y León",
    "SALAMANCA": "Castilla y León",
    "SEGOVIA": "Castilla y León",
    "SORIA": "Castilla y León",
    "VALLADOLID": "Castilla y León",
    "ZAMORA": "Castilla y León",
    "BARCELONA": "Cataluña",
    "GIRONA": "Cataluña",
    "LLEIDA": "Cataluña",
    "TARRAGONA": "Cataluña",
    "ALICANTE": "Comunidad Valenciana",
    "CASTELLÓN": "Comunidad Valenciana",
    "VALENCIA": "Comunidad Valenciana",
    "BADAJOZ": "Extremadura",
    "CÁCERES": "Extremadura",
    "A CORUÑA": "Galicia",
    "LUGO": "Galicia",
    "OURENSE": "Galicia",
    "PONTEVEDRA": "Galicia",
    "MADRID": "Comunidad de Madrid",
    "MURCIA": "Región de Murcia",
    "NAVARRA": "Comunidad Foral de Navarra",
    "ÁLAVA": "País Vasco",
    "BIZKAIA": "País Vasco",
    "GIPUZKOA": "País Vasco",
    "LA RIOJA": "La Rioja",
    "CEUTA": "Ceuta",
    "MELILLA": "Melilla",
}

ZONA_CONCURRENCIA_MAP: dict[str, str] = {
    "ALBACETE": "ALBACETE",
    "ALICANTE/ALACANT": "ALICANTE",
    "ALICANTE": "ALICANTE",
    "ALMERÍA": "ALMERÍA",
    "ALMERIA": "ALMERÍA",
    "ARABA/ÁLAVA": "ÁLAVA",
    "ARABA/ALAVA": "ÁLAVA",
    "ÁLAVA": "ÁLAVA",
    "ASTURIAS": "ASTURIAS",
    "ÁVILA": "ÁVILA",
    "AVILA": "ÁVILA",
    "BADAJOZ": "BADAJOZ",
    "BALEARS, ILLES": "ILLES BALEARS",
    "ILLES BALEARS": "ILLES BALEARS",
    "ISLAS BALEARES": "ILLES BALEARS",
    "BARCELONA": "BARCELONA",
    "BIZKAIA": "BIZKAIA",
    "VIZCAYA": "BIZKAIA",
    "BURGOS": "BURGOS",
    "CÁCERES": "CÁCERES",
    "CACERES": "CÁCERES",
    "CÁDIZ": "CÁDIZ",
    "CADIZ": "CÁDIZ",
    "CANTABRIA": "CANTABRIA",
    "CASTELLÓN/CASTELLÓ": "CASTELLÓN",
    "CASTELLON/CASTELLO": "CASTELLÓN",
    "CASTELLÓN": "CASTELLÓN",
    "CIUDAD REAL": "CIUDAD REAL",
    "CÓRDOBA": "CÓRDOBA",
    "CORDOBA": "CÓRDOBA",
    "CORUÑA, A": "A CORUÑA",
    "A CORUÑA": "A CORUÑA",
    "LA CORUÑA": "A CORUÑA",
    "CUENCA": "CUENCA",
    "GIPUZKOA": "GIPUZKOA",
    "GUIPÚZCOA": "GIPUZKOA",
    "GIRONA": "GIRONA",
    "GERONA": "GIRONA",
    "GRANADA": "GRANADA",
    "GUADALAJARA": "GUADALAJARA",
    "HUELVA": "HUELVA",
    "HUESCA": "HUESCA",
    "JAÉN": "JAÉN",
    "JAEN": "JAÉN",
    "LEÓN": "LEÓN",
    "LEON": "LEÓN",
    "LLEIDA": "LLEIDA",
    "LÉRIDA": "LLEIDA",
    "LUGO": "LUGO",
    "MADRID": "MADRID",
    "MÁLAGA": "MÁLAGA",
    "MALAGA": "MÁLAGA",
    "MURCIA": "MURCIA",
    "NAVARRA": "NAVARRA",
    "OURENSE": "OURENSE",
    "ORENSE": "OURENSE",
    "PALENCIA": "PALENCIA",
    "PALMAS, LAS": "LAS PALMAS",
    "LAS PALMAS": "LAS PALMAS",
    "PONTEVEDRA": "PONTEVEDRA",
    "RIOJA, LA": "LA RIOJA",
    "LA RIOJA": "LA RIOJA",
    "SALAMANCA": "SALAMANCA",
    "SANTA CRUZ DE TENERIFE": "SANTA CRUZ DE TENERIFE",
    "SEGOVIA": "SEGOVIA",
    "SEVILLA": "SEVILLA",
    "SORIA": "SORIA",
    "TARRAGONA": "TARRAGONA",
    "TERUEL": "TERUEL",
    "TOLEDO": "TOLEDO",
    "VALENCIA/VALÈNCIA": "VALENCIA",
    "VALENCIA/VALENCIA": "VALENCIA",
    "VALENCIA": "VALENCIA",
    "VALLADOLID": "VALLADOLID",
    "ZAMORA": "ZAMORA",
    "ZARAGOZA": "ZARAGOZA",
    "CEUTA": "CEUTA",
    "MELILLA": "MELILLA",
}


def strip_accents_sort_key(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text)
    without_marks = "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")
    return without_marks.upper().strip()


def normalize_unico_operator(raw_empresa: str) -> str:
    """
    Agrupa todos los proyectos de Orange (Orange Espagne, UTE Orange Espagne y
    Orange Comunicaciones Fijas, MasOrange, Xfera) y los de Avatel dentro de 'orange'.
    """
    upper = strip_accents_sort_key(raw_empresa)
    if (
        "ORANGE" in upper
        or "MASORANGE" in upper
        or "XFERA" in upper
        or "MASMOVIL" in upper
        or "AVATEL" in upper
    ):
        return "orange"
    if "TELEFONICA" in upper or "MOVISTAR" in upper:
        return "movistar"
    if "VODAFONE" in upper:
        return "vodafone"
    raise ValueError(f"Operador no reconocido en UNICO 5G: {raw_empresa!r}")


def normalize_province_and_ccaa(raw_zona: str) -> tuple[str, str]:
    key = raw_zona.strip().upper()
    canonical_prov = ZONA_CONCURRENCIA_MAP.get(key)
    if not canonical_prov:
        ascii_key = strip_accents_sort_key(key)
        for cand_k, cand_v in ZONA_CONCURRENCIA_MAP.items():
            if strip_accents_sort_key(cand_k) == ascii_key:
                canonical_prov = cand_v
                break
    if not canonical_prov:
        raise ValueError(f"Zona de concurrencia / provincia no reconocida: {raw_zona!r}")
    ccaa = CANONICAL_PROVINCE_TO_CCAA[canonical_prov]
    return canonical_prov, ccaa


def read_xlsx_sheet_rows(xlsx_path: Path, sheet_name: str) -> list[dict[str, str]]:
    """
    Lee TODAS las filas de una hoja `.xlsx` directamente desde el XML interno,
    ignorando atributos `hidden="1"` o `outlineLevel` para no perder filas filtradas/comprimidas.
    """
    with zipfile.ZipFile(xlsx_path, "r") as zf:
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            sst_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in sst_root.findall("m:si", EXCEL_NS):
                shared_strings.append(
                    "".join(t.text or "" for t in si.findall(".//m:t", EXCEL_NS))
                )

        wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
        rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rel_map = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels_root}

        target_xml: str | None = None
        for sheet in wb_root.findall(".//m:sheet", EXCEL_NS):
            if sheet.attrib.get("name") == sheet_name:
                rid = sheet.attrib[REL_ID_ATTR]
                raw_target = rel_map[rid].lstrip("/")
                target_xml = raw_target if raw_target.startswith("xl/") else f"xl/{raw_target}"
                break

        if not target_xml:
            raise KeyError(f"Hoja {sheet_name!r} no encontrada en {xlsx_path}")

        ws_root = ET.fromstring(zf.read(target_xml))
        parsed_rows: list[dict[str, str]] = []
        for row_el in ws_root.findall(".//m:sheetData/m:row", EXCEL_NS):
            cells: dict[str, str] = {}
            for cell_el in row_el.findall("m:c", EXCEL_NS):
                col_ref = re.sub(r"\d+", "", cell_el.attrib.get("r", ""))
                cell_type = cell_el.attrib.get("t")
                v_el = cell_el.find("m:v", EXCEL_NS)
                is_el = cell_el.find("m:is", EXCEL_NS)
                val = ""
                if cell_type == "s" and v_el is not None and v_el.text is not None:
                    val = shared_strings[int(v_el.text)]
                elif cell_type == "inlineStr" and is_el is not None:
                    val = "".join(t.text or "" for t in is_el.findall(".//m:t", EXCEL_NS))
                elif v_el is not None and v_el.text is not None:
                    val = v_el.text
                cells[col_ref] = val.strip()
            if any(v != "" for v in cells.values()):
                parsed_rows.append(cells)

        return parsed_rows


def parse_wgs84_coord(raw_lon: str, raw_lat: str) -> tuple[float, float]:
    lon = round(float(raw_lon.replace(",", ".")), 6)
    lat = round(float(raw_lat.replace(",", ".")), 6)
    if not (-19.5 <= lon <= 5.5 and 27.0 <= lat <= 44.5):
        raise ValueError(f"Coordenadas fuera de España WGS84: lat={lat}, lon={lon}")
    return lat, lon


def build_unico_5g_dataset(
    fase1_path: Path,
    fase2_path: Path,
    ine_municipios_path: Path,
    updated_at: str | None = None,
) -> dict[str, Any]:
    ine_map: dict[str, str] = json.loads(ine_municipios_path.read_text(encoding="utf-8"))

    # 1. Procesar Fase 1 (Hoja 'Definitiva' - incluye todas las filas ocultas/comprimidas)
    f1_rows = read_xlsx_sheet_rows(fase1_path, "Definitiva")
    if not f1_rows or f1_rows[0].get("A") != "Beneficiario":
        raise ValueError("Cabecera inesperada en Fase 1 ('Definitiva')")

    raw_records: list[dict[str, Any]] = []
    for idx, row in enumerate(f1_rows[1:], start=1):
        empresa = row.get("A", "").strip()
        zona = row.get("B", "").strip()
        raw_lon = row.get("C", "").strip()
        raw_lat = row.get("D", "").strip()
        mun = row.get("E", "").strip()
        if not empresa or not zona or not raw_lon or not raw_lat:
            continue

        op = normalize_unico_operator(empresa)
        prov, ccaa = normalize_province_and_ccaa(zona)
        lat, lon = parse_wgs84_coord(raw_lon, raw_lat)
        raw_records.append(
            {
                "fase": 1,
                "op": op,
                "empresa": empresa,
                "ccaa": ccaa,
                "prov": prov,
                "mun": mun,
                "lat": lat,
                "lon": lon,
                "_srcIdx": idx,
            }
        )

    # 2. Procesar Fase 2 (Hoja 'Hoja1' - ignorando deliberadamente EMPLAZAMIENTO [B] e ID PROPIETARIO [C])
    f2_rows = read_xlsx_sheet_rows(fase2_path, "Hoja1")
    if not f2_rows or f2_rows[0].get("A") != "EMPRESA":
        raise ValueError("Cabecera inesperada en Fase 2 ('Hoja1')")

    for idx, row in enumerate(f2_rows[1:], start=1):
        empresa = row.get("A", "").strip()
        # Columnas B ('EMPLAZAMIENTO') y C ('ID PROPIETARIO') se omiten expresamente.
        zona = row.get("D", "").strip()
        raw_lon = row.get("E", "").strip()
        raw_lat = row.get("F", "").strip()
        raw_cod_mun = row.get("G", "").strip()
        if not empresa or not zona or not raw_lon or not raw_lat:
            continue

        op = normalize_unico_operator(empresa)
        prov, ccaa = normalize_province_and_ccaa(zona)
        lat, lon = parse_wgs84_coord(raw_lon, raw_lat)
        ine5 = raw_cod_mun.zfill(5)
        mun = ine_map.get(ine5)
        if not mun:
            raise ValueError(f"Código INE municipal no encontrado en diccionario: {raw_cod_mun!r} ({ine5})")

        raw_records.append(
            {
                "fase": 2,
                "op": op,
                "empresa": empresa,
                "ccaa": ccaa,
                "prov": prov,
                "mun": mun,
                "lat": lat,
                "lon": lon,
                "_srcIdx": idx,
            }
        )

    # 3. Extraer número de proyectos adjudicados de la hoja 'Resumen' de Fase 2
    f2_resumen = read_xlsx_sheet_rows(fase2_path, "Resumen")
    fase2_projects_by_op: dict[str, int] = {k: 0 for k in OPERATOR_ORDER}
    fase2_projects_by_entity: dict[str, int] = {}
    in_empresa_section = False
    for row in f2_resumen:
        ent = row.get("A", "").strip()
        projs = row.get("B", "").strip()
        if ent == "Empresa" and projs.startswith("Proyectos"):
            in_empresa_section = True
            continue
        if not in_empresa_section:
            continue
        if ent.upper() == "TOTAL":
            break
        if ent and projs.isdigit():
            op_key = normalize_unico_operator(ent)
            p_count = int(projs)
            fase2_projects_by_op[op_key] = fase2_projects_by_op.get(op_key, 0) + p_count
            fase2_projects_by_entity[ent] = p_count

    # 4. Orden alfabético territorial neutro (CCAA -> Provincia -> Municipio -> Fase -> Operador)
    raw_records.sort(
        key=lambda r: (
            strip_accents_sort_key(r["ccaa"]),
            strip_accents_sort_key(r["prov"]),
            strip_accents_sort_key(r["mun"]),
            r["fase"],
            OPERATOR_ORDER.index(r["op"]),
            r["_srcIdx"],
        )
    )

    antenas: list[dict[str, Any]] = []
    for seq_idx, rec in enumerate(raw_records, start=1):
        antenas.append(
            {
                "id": f"u5g-{seq_idx}",
                "fase": rec["fase"],
                "op": rec["op"],
                "empresa": rec["empresa"],
                "ccaa": rec["ccaa"],
                "prov": rec["prov"],
                "mun": rec["mun"],
                "lat": rec["lat"],
                "lon": rec["lon"],
            }
        )

    fase1_total = sum(1 for a in antenas if a["fase"] == 1)
    fase2_total = sum(1 for a in antenas if a["fase"] == 2)
    total = len(antenas)

    # 5. Resumen por operador (orden fijo de programa, no ranking competitivo)
    operators_summary: dict[str, Any] = {}
    for op_key in OPERATOR_ORDER:
        op_items = [a for a in antenas if a["op"] == op_key]
        f1_cnt = sum(1 for a in op_items if a["fase"] == 1)
        f2_cnt = sum(1 for a in op_items if a["fase"] == 2)
        entities_breakdown: dict[str, dict[str, int]] = {}
        for a in op_items:
            ent = a["empresa"]
            if ent not in entities_breakdown:
                entities_breakdown[ent] = {"total": 0, "fase1": 0, "fase2": 0}
            entities_breakdown[ent]["total"] += 1
            if a["fase"] == 1:
                entities_breakdown[ent]["fase1"] += 1
            else:
                entities_breakdown[ent]["fase2"] += 1

        entities_list = [
            {
                "empresa": ent_name,
                "total": counts["total"],
                "fase1": counts["fase1"],
                "fase2": counts["fase2"],
                **(
                    {"proyectosFase2": fase2_projects_by_entity[ent_name]}
                    if ent_name in fase2_projects_by_entity
                    else {}
                ),
            }
            for ent_name, counts in sorted(
                entities_breakdown.items(), key=lambda x: strip_accents_sort_key(x[0])
            )
        ]

        operators_summary[op_key] = {
            "key": op_key,
            "label": OPERATOR_LABELS[op_key],
            "total": len(op_items),
            "fase1": f1_cnt,
            "fase2": f2_cnt,
            "proyectosFase2": fase2_projects_by_op.get(op_key, 0),
            "entities": entities_list,
        }

    return {
        "schemaVersion": 1,
        "program": "UNICO 5G Redes Activas",
        "updatedAt": updated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total": total,
        "fase1Total": fase1_total,
        "fase2Total": fase2_total,
        "fase2ProjectsTotal": sum(fase2_projects_by_op.values()),
        "operators": operators_summary,
        "antenas": antenas,
    }


def lookup_direct_band_code_bits(trimmed: str) -> int | None:
    lower = trimmed.lower()
    direct = DIRECT_BAND_CODE_BITS.get(lower)
    if direct is not None:
        return direct
    if "+" in lower:
        return DIRECT_BAND_CODE_BITS.get(PLUS_COLLAPSE_RE.sub("+", lower))
    return None


def parse_decimal_token(token: str) -> float:
    return float(token.replace(",", ".")) if "," in token else float(token)


def classify_frequency_range_bits(raw: str) -> int:
    """Espejo exacto de `classifyFrequencyRangeBits` en `src/hooks/useAntenasData.ts`."""
    if not isinstance(raw, str):
        return 0
    trimmed = raw.strip()
    if not trimmed:
        return 0
    direct_bit = lookup_direct_band_code_bits(trimmed)
    if direct_bit is not None:
        return direct_bit

    m1 = FREQ_NUM_TOKEN_RE.search(trimmed)
    if m1 is None:
        return 0
    m2 = FREQ_NUM_TOKEN_RE.search(trimmed, m1.end())
    a = parse_decimal_token(m1.group(0))
    b = parse_decimal_token(m2.group(0)) if m2 is not None else a
    if not (math.isfinite(a) and math.isfinite(b)):
        return 0

    lo, hi = (a, b) if a <= b else (b, a)
    if GHZ_UNIT_RE.search(trimmed) and hi < 1000:
        lo *= 1000.0
        hi *= 1000.0

    if (24 <= lo and hi <= 29.5) or (24000 <= lo and hi <= 29500):
        return BIT_N258
    if 3300 <= lo and hi <= 3900:
        return BIT_N78
    if 2490 <= lo and hi <= 2700:
        if (
            m2 is not None
            and 2679.5 <= lo <= 2680.5
            and 2689.5 <= hi <= 2690.5
        ):
            return BIT_B7_PLUS | BIT_SAW_2600_RANGE
        if (
            (m2 is not None and 2570 <= lo and hi <= 2620)
            or (m2 is None and lo > 2570 and hi < 2620 and lo != 2600)
        ):
            return BIT_B38 | BIT_SAW_2600_RANGE
        return BIT_B7 | BIT_SAW_2600_RANGE
    if 1900 <= lo and hi <= 2170:
        return BIT_B1
    if 1710 <= lo and hi <= 1880:
        return BIT_B3
    if 880 <= lo and hi <= 960:
        return BIT_G9
    if 791 <= lo and hi <= 862:
        return BIT_B20
    if 698 <= lo and hi <= 788:
        if (
            m2 is not None
            and 757.5 <= lo <= 758.5
            and 787.5 <= hi <= 788.5
        ):
            return BIT_N28_PLUS | BIT_SAW_700_RANGE
        return BIT_N28 | BIT_SAW_700_RANGE
    return 0


def classify_commercial_band_label_bits(
    raw_label: str,
    saw_2600_range: bool,
    saw_700_range: bool,
) -> int:
    """Espejo exacto de `classifyCommercialBandLabelBits` en `src/hooks/useAntenasData.ts`."""
    if not isinstance(raw_label, str):
        return 0
    trimmed = raw_label.strip()
    if not trimmed:
        return 0
    direct_bit = lookup_direct_band_code_bits(trimmed)
    if direct_bit is not None:
        return direct_bit

    m1 = FREQ_NUM_TOKEN_RE.search(trimmed)
    if m1 is None:
        return 0
    m2 = FREQ_NUM_TOKEN_RE.search(trimmed, m1.end())
    if m2 is not None:
        return classify_frequency_range_bits(trimmed)

    val = parse_decimal_token(m1.group(0))
    if not math.isfinite(val):
        return 0
    if GHZ_UNIT_RE.search(trimmed) and val < 1000:
        val *= 1000.0

    if (24 <= val <= 29.5) or (24000 <= val <= 29500):
        return BIT_N258
    if 3300 <= val <= 3900:
        return BIT_N78
    if 2490 <= val <= 2700:
        if 2570 < val < 2620 and val != 2600:
            return BIT_B38
        return 0 if saw_2600_range else BIT_B7
    if 1900 <= val <= 2170:
        return BIT_B1
    if 1710 <= val <= 1880:
        return BIT_B3
    if 880 <= val <= 960:
        return BIT_G9
    if 791 <= val <= 862:
        return BIT_B20
    if 698 <= val <= 788:
        return 0 if saw_700_range else BIT_N28
    return 0


def compute_antenna_rf_band_mask(ant: dict[str, Any]) -> int:
    """Espejo exacto bit a bit de `computeAntennaRfBandMask` en `src/hooks/useAntenasData.ts`."""
    frecuencias = ant.get("frecuencias")
    concesiones = ant.get("concesiones")
    bandas = ant.get("bandas")
    if (
        (not isinstance(frecuencias, list) or len(frecuencias) == 0)
        and (not isinstance(concesiones, list) or len(concesiones) == 0)
        and (not isinstance(bandas, list) or len(bandas) == 0)
    ):
        return 0

    mask = 0
    if isinstance(frecuencias, list):
        for freq in frecuencias:
            if isinstance(freq, str):
                mask |= classify_frequency_range_bits(freq)
    if isinstance(concesiones, list):
        for item in concesiones:
            if isinstance(item, dict):
                freq = item.get("freq")
                if isinstance(freq, str):
                    mask |= classify_frequency_range_bits(freq)
    if (mask & BIT_N28_PLUS) != 0 and (mask & BIT_EXPLICIT_N28_CODE) == 0:
        mask &= ~BIT_N28
    if isinstance(bandas, list):
        saw_2600_range = (mask & BIT_SAW_2600_RANGE) != 0
        saw_700_range = (mask & BIT_SAW_700_RANGE) != 0
        for label in bandas:
            if isinstance(label, str):
                mask |= classify_commercial_band_label_bits(
                    label,
                    saw_2600_range,
                    saw_700_range,
                )
        if (mask & BIT_N28_PLUS) != 0 and (mask & BIT_EXPLICIT_N28_CODE) == 0:
            mask &= ~BIT_N28

    return mask & RF_BAND_BITS_MASK


def compute_antenna_unico_5g_mask(ant: dict[str, Any]) -> int:
    """Devuelve únicamente la máscara de bandas 5G relevantes para UNICO (`N28`, `N28+`, `N78`)."""
    return compute_antenna_rf_band_mask(ant) & UNICO_DECLARED_ANY_MASK


def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distancia geodésica Haversine en kilómetros idéntica a `src/utils/geo.ts`."""
    d_lat = (lat2 - lat1) * DEG_TO_RAD
    d_lon = (lon2 - lon1) * DEG_TO_RAD
    sin_dlat = math.sin(d_lat / 2.0)
    sin_dlon = math.sin(d_lon / 2.0)
    a = (
        sin_dlat * sin_dlat
        + math.cos(lat1 * DEG_TO_RAD) * math.cos(lat2 * DEG_TO_RAD) * sin_dlon * sin_dlon
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return EARTH_RADIUS_KM * c


XFERA_LEGAL_ENTITY_TOKENS: tuple[str, ...] = (
    "XFERA",
    "MASMOVIL",
    "YOIGO",
    "EUSKALTEL",
    "R CABLE",
    "TELECABLE",
)


def resolve_real_station_unico_op(ant: dict[str, Any]) -> str | None:
    """Resuelve el operador UNICO 5G de una estación real de `antenas.json`."""
    op = ant.get("op")
    if op == "movistar":
        return "movistar"
    if op == "vodafone":
        return "vodafone"
    if op in ("orange", "masmovil"):
        return "orange"
    raw_op_name = ant.get("opRaw")
    if isinstance(raw_op_name, str) and raw_op_name:
        op_raw = strip_accents_sort_key(raw_op_name)
        if "AVATEL" in op_raw or any(tok in op_raw for tok in XFERA_LEGAL_ENTITY_TOKENS):
            return "orange"
    return None


def match_unico_declared_antennas_masks(
    unico_antenas: list[dict[str, Any]],
    real_antenas: list[dict[str, Any]],
) -> list[int]:
    """
    Emparejamiento 1-a-1 por operadora entre coordenadas oficiales UNICO 5G y antenas reales:
    - Cada ubicación UNICO 5G solo puede coincidir con 1 antena real de su misma operadora en <= 1.000 m.
    - Las asignaciones se resuelven por cercanía global creciente (distancia mínima primero).
    - Si la antena real más próxima ya ha sido elegida como declarada por otro proyecto del mismo
      operador, se busca la siguiente antena real más cercana disponible dentro de <= 1.000 m.
    - Dos proyectos UNICO de operadoras distintas que coinciden en un emplazamiento real compartido
      se resuelven de forma independiente por operadora y ambos pueden quedar declarados.
    Espejo bit a bit de `matchUnicoDeclaredAntennasMasks` en `src/hooks/useUnico5gData.ts`.
    """
    n_unico = len(unico_antenas)
    result = [0] * n_unico
    if n_unico == 0 or not real_antenas:
        return result

    spatial_buckets: dict[str, dict[int, list[tuple[int, str, float, float, int]]]] = {
        op_key: {} for op_key in OPERATOR_ORDER
    }

    for station_idx, ant in enumerate(real_antenas):
        if not isinstance(ant, dict):
            continue
        target_op = resolve_real_station_unico_op(ant)
        if not target_op:
            continue

        raw_lat = ant.get("lat")
        raw_lon = ant.get("lon")
        if (
            raw_lat is None
            or raw_lon is None
            or isinstance(raw_lat, bool)
            or isinstance(raw_lon, bool)
        ):
            continue
        try:
            lat = float(raw_lat)
            lon = float(raw_lon)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(lat) and math.isfinite(lon)):
            continue

        raw_id = ant.get("id")
        ant_id = raw_id if isinstance(raw_id, str) else ""
        declared_bits = compute_antenna_unico_5g_mask(ant)
        gx = math.floor(lat / GRID_CELL_DEG)
        gy = math.floor(lon / GRID_CELL_DEG)
        cell_key = (gx + 10000) * 100000 + (gy + 20000)
        map_for_op = spatial_buckets[target_op]
        entry = (station_idx, ant_id, lat, lon, declared_bits)
        bucket = map_for_op.get(cell_key)
        if bucket is None:
            map_for_op[cell_key] = [entry]
        else:
            bucket.append(entry)

    max_dist_km = UNICO_MAX_MATCH_DISTANCE_KM
    candidates_by_unico: list[list[tuple[float, int, str, int]]] = [[] for _ in range(n_unico)]
    unico_ops: list[str] = [""] * n_unico
    heap: list[tuple[float, int, int]] = []

    for i, u in enumerate(unico_antenas):
        if not isinstance(u, dict):
            continue
        op_key = str(u.get("op") or "")
        unico_ops[i] = op_key
        map_for_op = spatial_buckets.get(op_key)
        if not map_for_op:
            continue
        raw_u_lat = u.get("lat")
        raw_u_lon = u.get("lon")
        if (
            raw_u_lat is None
            or raw_u_lon is None
            or isinstance(raw_u_lat, bool)
            or isinstance(raw_u_lon, bool)
        ):
            continue
        try:
            u_lat = float(raw_u_lat)
            u_lon = float(raw_u_lon)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(u_lat) and math.isfinite(u_lon)):
            continue

        gx = math.floor(u_lat / GRID_CELL_DEG)
        gy = math.floor(u_lon / GRID_CELL_DEG)
        cands: list[tuple[float, int, str, int]] = []

        for dx in (-1, 0, 1):
            row_base = (gx + dx + 10000) * 100000
            for dy in (-1, 0, 1):
                bucket = map_for_op.get(row_base + (gy + dy + 20000))
                if not bucket:
                    continue
                for station_idx, ant_id, cand_lat, cand_lon, cand_bits in bucket:
                    dist_km = haversine_distance_km(u_lat, u_lon, cand_lat, cand_lon)
                    if dist_km <= max_dist_km:
                        cands.append((dist_km, station_idx, ant_id, cand_bits))

        if cands:
            cands.sort(key=lambda item: (item[0], item[1]))
            candidates_by_unico[i] = cands
            heapq.heappush(heap, (cands[0][0], i, 0))

    claimed_by_op: dict[str, set[int]] = {op_key: set() for op_key in OPERATOR_ORDER}
    claimed_ids_by_op: dict[str, set[str]] = {op_key: set() for op_key in OPERATOR_ORDER}
    resolved = [False] * n_unico

    while heap:
        _, u_idx, cand_pos = heapq.heappop(heap)
        if resolved[u_idx]:
            continue
        op_key = unico_ops[u_idx]
        claimed_for_op = claimed_by_op.get(op_key)
        claimed_ids_for_op = claimed_ids_by_op.get(op_key)
        if claimed_for_op is None or claimed_ids_for_op is None:
            resolved[u_idx] = True
            continue

        cands = candidates_by_unico[u_idx]
        _, station_idx, ant_id, declared_bits = cands[cand_pos]
        if station_idx in claimed_for_op or (ant_id != "" and ant_id in claimed_ids_for_op):
            next_pos = cand_pos + 1
            if next_pos < len(cands):
                heapq.heappush(heap, (cands[next_pos][0], u_idx, next_pos))
            else:
                resolved[u_idx] = True
            continue

        resolved[u_idx] = True
        if declared_bits != 0:
            claimed_for_op.add(station_idx)
            if ant_id != "":
                claimed_ids_for_op.add(ant_id)
            result[u_idx] = declared_bits

    return result


def compute_declared_summary(
    unico_antenas: list[dict[str, Any]],
    declared_masks: list[int],
) -> dict[str, Any]:
    """Calcula el resumen global, por banda y por operador de declaraciones UNICO 5G."""
    by_operator: dict[str, dict[str, int]] = {
        op_key: {
            "total": 0,
            "declared": 0,
            "N78": 0,
            "N28": 0,
            "N28+": 0,
        }
        for op_key in OPERATOR_ORDER
    }

    total_declared = 0
    total_n78 = 0
    total_n28 = 0
    total_n28_plus = 0

    for i, rec in enumerate(unico_antenas):
        op_key = str(rec.get("op") or "")
        op_stats = by_operator.get(op_key)
        if op_stats is not None:
            op_stats["total"] += 1

        mask = declared_masks[i] if i < len(declared_masks) else 0
        if (mask & UNICO_DECLARED_ANY_MASK) != 0:
            total_declared += 1
            if op_stats is not None:
                op_stats["declared"] += 1
        if (mask & BIT_N78) != 0:
            total_n78 += 1
            if op_stats is not None:
                op_stats["N78"] += 1
        if (mask & BIT_N28) != 0:
            total_n28 += 1
            if op_stats is not None:
                op_stats["N28"] += 1
        if (mask & BIT_N28_PLUS) != 0:
            total_n28_plus += 1
            if op_stats is not None:
                op_stats["N28+"] += 1

    return {
        "total": len(unico_antenas),
        "declared": total_declared,
        "byBand": {
            "all": total_declared,
            "N78": total_n78,
            "N28": total_n28,
            "N28+": total_n28_plus,
        },
        "byOperator": by_operator,
    }


def apply_unico_declarations(
    unico_dataset: dict[str, Any],
    antenas_dataset: dict[str, Any],
) -> dict[str, Any]:
    """
    Devuelve una copia actualizada de `unico_dataset` con `declaredUpdatedAt`,
    `declaredMasks` y `declaredSummary` calculados frente a `antenas_dataset`.
    """
    unico_antenas = unico_dataset.get("antenas") or []
    real_antenas = antenas_dataset.get("antenas") or []
    declared_masks = match_unico_declared_antennas_masks(unico_antenas, real_antenas)
    declared_summary = compute_declared_summary(unico_antenas, declared_masks)

    raw_updated_at = antenas_dataset.get("updatedAt")
    declared_updated_at = (
        raw_updated_at.strip()
        if isinstance(raw_updated_at, str) and raw_updated_at.strip()
        else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    )

    updated: dict[str, Any] = {
        k: v
        for k, v in unico_dataset.items()
        if k not in ("declaredUpdatedAt", "declaredSummary", "declaredMasks", "antenas")
    }
    updated["declaredUpdatedAt"] = declared_updated_at
    updated["declaredSummary"] = declared_summary
    updated["declaredMasks"] = declared_masks
    updated["antenas"] = unico_antenas
    return updated


def _write_compact_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".tmp")
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tmp_path.write_bytes(encoded)
    os.replace(tmp_path, path)


def sync_unico_5g_declarations_file(
    unico_path: Path,
    antenas_source: Path | dict[str, Any],
) -> dict[str, Any]:
    """
    Carga `unico_path`, calcula declaraciones 5G frente a `antenas_source` (ruta o dict en memoria),
    escribe el JSON compacto de forma atómica y devuelve el dataset actualizado.
    """
    target_path = Path(unico_path)
    unico_dataset = json.loads(target_path.read_text(encoding="utf-8"))
    if isinstance(antenas_source, (Path, str)):
        antenas_dataset = json.loads(Path(antenas_source).read_text(encoding="utf-8"))
    else:
        antenas_dataset = antenas_source

    updated = apply_unico_declarations(unico_dataset, antenas_dataset)
    _write_compact_json_atomic(target_path, updated)
    return updated


def _print_declared_summary(dataset: dict[str, Any]) -> None:
    summary = dataset.get("declaredSummary")
    if not isinstance(summary, dict):
        return
    total = int(summary.get("total") or 0)
    declared = int(summary.get("declared") or 0)
    pct_total = (declared / total * 100.0) if total else 0.0
    by_band = summary.get("byBand") or {}
    print(
        f"Declaradas 5G (<= 1,0 km): {declared}/{total} ({pct_total:.2f}%) "
        f"[N78={by_band.get('N78', 0)}, N28={by_band.get('N28', 0)}, N28+={by_band.get('N28+', 0)}] · "
        f"antenasUpdatedAt={dataset.get('declaredUpdatedAt', '')}"
    )
    by_operator = summary.get("byOperator") or {}
    for op_key in OPERATOR_ORDER:
        op_stat = by_operator.get(op_key) or {}
        op_total = int(op_stat.get("total") or 0)
        op_decl = int(op_stat.get("declared") or 0)
        op_pct = (op_decl / op_total * 100.0) if op_total else 0.0
        print(
            f"  - {OPERATOR_LABELS[op_key]}: {op_decl}/{op_total} ({op_pct:.2f}%) "
            f"[N78={op_stat.get('N78', 0)}, N28={op_stat.get('N28', 0)}, N28+={op_stat.get('N28+', 0)}]"
        )


def main(argv: list[str] | None = None) -> None:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Construye public/data/unico-5g.json")
    parser.add_argument(
        "--fase1",
        type=Path,
        default=Path("/home/antigravity/UNICO_5G_REDES_ACTIVAS_FASE_1.xlsx"),
    )
    parser.add_argument(
        "--fase2",
        type=Path,
        default=Path("/home/antigravity/Unico_5G_Redes_Activas_Fase_2.xlsx"),
    )
    parser.add_argument(
        "--ine",
        type=Path,
        default=repo_root / "scripts" / "ine_municipios.json",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=repo_root / "public" / "data" / "unico-5g.json",
    )
    parser.add_argument(
        "--antenas",
        type=Path,
        default=repo_root / "public" / "data" / "antenas.json",
        help="Dataset de antenas reales para sincronizar declaraciones automáticamente tras construir desde Excel.",
    )
    parser.add_argument(
        "--sync-antenas",
        type=Path,
        default=None,
        help="Sincroniza las declaraciones 5G en --unico-file frente al archivo antenas.json indicado sin requerir Excels.",
    )
    parser.add_argument(
        "--unico-file",
        type=Path,
        default=repo_root / "public" / "data" / "unico-5g.json",
        help="Ruta del archivo unico-5g.json usado con --sync-antenas.",
    )
    args = parser.parse_args(argv)

    if args.sync_antenas is not None:
        updated = sync_unico_5g_declarations_file(args.unico_file, args.sync_antenas)
        print(
            f"Sincronizado {args.unico_file} ({args.unico_file.stat().st_size / 1024:.1f} KB)"
        )
        _print_declared_summary(updated)
        return

    dataset = build_unico_5g_dataset(
        fase1_path=args.fase1,
        fase2_path=args.fase2,
        ine_municipios_path=args.ine,
    )
    if args.antenas is not None and args.antenas.exists():
        antenas_dataset = json.loads(args.antenas.read_text(encoding="utf-8"))
        dataset = apply_unico_declarations(dataset, antenas_dataset)

    _write_compact_json_atomic(args.out, dataset)
    print(
        f"Generado {args.out} ({args.out.stat().st_size / 1024:.1f} KB) · "
        f"Total={dataset['total']} (Fase 1={dataset['fase1Total']}, Fase 2={dataset['fase2Total']})"
    )
    for op_key in OPERATOR_ORDER:
        op_info = dataset["operators"][op_key]
        pct = (op_info["total"] / dataset["total"]) * 100
        print(
            f"  - {op_info['label']}: {op_info['total']} ({pct:.2f}%) "
            f"[F1={op_info['fase1']}, F2={op_info['fase2']}]"
        )
    if "declaredSummary" in dataset:
        _print_declared_summary(dataset)


if __name__ == "__main__":
    main()
