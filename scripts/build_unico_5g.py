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
import json
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
    "movistar": "Movistar",
    "orange": "Orange",
    "vodafone": "Vodafone",
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


def main() -> None:
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
    args = parser.parse_args()

    dataset = build_unico_5g_dataset(
        fase1_path=args.fase1,
        fase2_path=args.fase2,
        ine_municipios_path=args.ine,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(dataset, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
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


if __name__ == "__main__":
    main()
