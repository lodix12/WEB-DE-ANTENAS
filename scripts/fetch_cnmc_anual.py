#!/usr/bin/env python3
"""
Generador del respaldo estático `public/data/cnmc-anual.json` a partir de la API
CKAN oficial en 2 pasos de CNMC|Data para el conjunto:
  "Telecomunicaciones Anual Datos Generales" (`idTipoDataSetBD: 203`).

Paso 1 (Catálogo):
  Consulta `package_search?fq=idTipoDataSetBD:203&rows=10` (con respaldos por
  título exacto y `package_show?id=ds_24233_1`) para descubrir la última
  versión publicada y el `resource_id` activo en el Datastore.

Paso 2 (Datastore):
  Consulta `datastore_search?resource_id=<id>&limit=5000&offset=0` paginando
  automáticamente hasta recuperar el 100 % de los registros y serializándolos
  en un JSON compacto fiel tal cual los publica la CNMC.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from typing import Any, Callable
import urllib.parse
import urllib.request

CNMC_CKAN_BASE = "https://catalogodatos.cnmc.es/api/3/action"
CNMC_PORTAL_URL = (
    "https://data.cnmc.es/telecomunicaciones-y-sector-audiovisual/"
    "datos-anuales/datos-generales/telecomunicaciones-anual"
)
CNMC_DATASET_TYPE_ID = "203"
CNMC_DATASET_TITLE = "Telecomunicaciones Anual Datos Generales"
CNMC_FALLBACK_DATASET_NAME = "ds_24233_1"
CNMC_PAGE_LIMIT = 5000

INDICATOR_KEYS = (
    "ingresos",
    "ingresos_por_operador",
    "empleados_por_operador",
    "paquetes",
    "inversiones_por_operador",
    "gastos_por_operador",
)

JsonFetcher = Callable[[str], dict[str, Any]]


def default_fetch_json(url: str, timeout: float = 30.0) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "RedesMovilesEspana/1.0 (+https://github.com/lodix12/WEB-DE-ANTENAS)",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError(f"Respuesta CKAN inválida desde {url}")
    return parsed


def _extras_map(pkg: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in pkg.get("extras") or []:
        if isinstance(item, dict) and isinstance(item.get("key"), str):
            val = item.get("value")
            out[item["key"]] = "" if val is None else str(val).strip()
    return out


def _select_best_package(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    valid = [p for p in candidates if isinstance(p, dict) and isinstance(p.get("resources"), list)]
    if not valid:
        return None

    def sort_key(pkg: dict[str, Any]) -> tuple[int, int, str]:
        extras = _extras_map(pkg)
        is_published = 1 if extras.get("estado", "").lower() == "publicado" else 0
        is_exact_type = 1 if extras.get("idTipoDataSetBD") == CNMC_DATASET_TYPE_ID else 0
        modified = str(pkg.get("metadata_modified") or extras.get("modified") or "")
        return (is_published, is_exact_type, modified)

    valid.sort(key=sort_key, reverse=True)
    return valid[0]


def _select_datastore_resource(pkg: dict[str, Any]) -> dict[str, Any]:
    resources = [r for r in (pkg.get("resources") or []) if isinstance(r, dict) and r.get("id")]
    if not resources:
        raise ValueError("El paquete CNMC no contiene recursos consultables.")

    for res in resources:
        if res.get("datastore_active") is True:
            return res

    for res in resources:
        if str(res.get("format") or "").strip().upper() == "CSV":
            return res

    return resources[0]


def resolve_cnmc_annual_resource(
    fetch_json: JsonFetcher = default_fetch_json,
) -> dict[str, Any]:
    """Paso 1: resuelve el paquete vigente y el resource_id activo del datastore."""
    step1_attempts = [
        f"{CNMC_CKAN_BASE}/package_search?fq={urllib.parse.quote(f'idTipoDataSetBD:{CNMC_DATASET_TYPE_ID}')}&rows=10",
        f"{CNMC_CKAN_BASE}/package_search?q={urllib.parse.quote(f'\"{CNMC_DATASET_TITLE}\"')}&rows=10",
        f"{CNMC_CKAN_BASE}/package_show?id={urllib.parse.quote(CNMC_FALLBACK_DATASET_NAME)}",
    ]

    last_error: Exception | None = None
    chosen_pkg: dict[str, Any] | None = None
    used_step1_url = step1_attempts[0]

    for url in step1_attempts:
        try:
            payload = fetch_json(url)
            if not payload.get("success"):
                continue
            result = payload.get("result")
            if isinstance(result, dict) and isinstance(result.get("results"), list):
                pkg = _select_best_package(result["results"])
            elif isinstance(result, dict) and isinstance(result.get("resources"), list):
                pkg = result
            else:
                pkg = None
            if pkg is not None:
                chosen_pkg = pkg
                used_step1_url = url
                break
        except Exception as exc:  # noqa: BLE001
            last_error = exc

    if chosen_pkg is None:
        raise RuntimeError(
            f"No se pudo resolver el recurso CNMC en el catálogo CKAN: {last_error}"
        )

    resource = _select_datastore_resource(chosen_pkg)
    resource_id = str(resource["id"]).strip()
    extras = _extras_map(chosen_pkg)

    step2_base_url = (
        f"{CNMC_CKAN_BASE}/datastore_search?"
        f"resource_id={urllib.parse.quote(resource_id)}&limit={CNMC_PAGE_LIMIT}&offset=0"
    )

    return {
        "datasetName": str(chosen_pkg.get("name") or CNMC_FALLBACK_DATASET_NAME).strip(),
        "datasetTitle": str(chosen_pkg.get("title") or CNMC_DATASET_TITLE).strip(),
        "version": str(chosen_pkg.get("version") or "").strip(),
        "resourceId": resource_id,
        "resourceUrl": str(resource.get("url") or "").strip(),
        "periodo": extras.get("periodo", ""),
        "modified": extras.get("modified", ""),
        "issued": extras.get("issued", ""),
        "metadataModified": str(chosen_pkg.get("metadata_modified") or "").strip(),
        "novedad": extras.get("novedad", ""),
        "frecuencia": extras.get("frecuenciaActualizacion", "Anual"),
        "licenseTitle": str(chosen_pkg.get("license_title") or "CC-BY-SA-4.0").strip(),
        "licenseUrl": str(
            chosen_pkg.get("license_url")
            or extras.get("license")
            or "https://data.cnmc.es/condiciones-de-uso"
        ).strip(),
        "portalUrl": CNMC_PORTAL_URL,
        "step1Url": used_step1_url,
        "step2Url": step2_base_url,
    }


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.upper() == "N/A" else text


def _parse_optional_number(value: Any) -> float | int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value
    if isinstance(value, str):
        cleaned = value.strip().replace(",", ".")
        if not cleaned:
            return None
        try:
            num = float(cleaned)
        except ValueError:
            return None
        if not math.isfinite(num):
            return None
        return int(num) if num.is_integer() else num
    return None


def compact_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Convierte un registro crudo del datastore CKAN al formato compacto sin pérdida."""
    anno_raw = str(raw.get("anno") or "").strip()
    if not anno_raw.isdigit():
        return None
    anno = int(anno_raw)

    item: dict[str, Any] = {"a": anno}

    mercado = _clean_text(raw.get("tipo_de_mercado"))
    if mercado:
        item["m"] = mercado

    concepto = _clean_text(raw.get("concepto"))
    if concepto:
        item["c"] = concepto

    operador = _clean_text(raw.get("operador"))
    if operador:
        item["o"] = operador

    tipo_ingreso = _clean_text(raw.get("tipo_de_ingreso"))
    if tipo_ingreso:
        item["ti"] = tipo_ingreso

    tipo_paquete = _clean_text(raw.get("tipo_de_paquete"))
    if tipo_paquete:
        item["tp"] = tipo_paquete

    unidades = _clean_text(raw.get("unidades"))
    if unidades:
        item["u"] = unidades

    has_indicator = False
    for key in INDICATOR_KEYS:
        num = _parse_optional_number(raw.get(key))
        if num is not None:
            item[key] = num
            has_indicator = True

    if not has_indicator:
        return None
    return item


def fetch_cnmc_datastore_records(
    resource_id: str,
    fetch_json: JsonFetcher = default_fetch_json,
    page_limit: int = CNMC_PAGE_LIMIT,
) -> tuple[list[dict[str, Any]], int]:
    """Paso 2: recupera todos los registros del datastore con paginación automática."""
    all_raw: list[dict[str, Any]] = []
    offset = 0
    total_reported: int | None = None

    while True:
        url = (
            f"{CNMC_CKAN_BASE}/datastore_search?"
            f"resource_id={urllib.parse.quote(resource_id)}"
            f"&limit={page_limit}&offset={offset}"
        )
        payload = fetch_json(url)
        if not payload.get("success"):
            raise RuntimeError(f"Error CKAN datastore_search para resource_id={resource_id}")

        result = payload.get("result") or {}
        batch = result.get("records") or []
        if not isinstance(batch, list):
            raise ValueError("Campo 'records' inválido en datastore_search.")

        if total_reported is None:
            raw_total = result.get("total")
            total_reported = int(raw_total) if isinstance(raw_total, int) else len(batch)

        all_raw.extend(r for r in batch if isinstance(r, dict))

        if len(batch) == 0 or len(all_raw) >= total_reported or len(batch) < page_limit:
            break
        offset += len(batch)

    compact_rows: list[dict[str, Any]] = []
    for row in all_raw:
        compacted = compact_record(row)
        if compacted is not None:
            compact_rows.append(compacted)

    return compact_rows, total_reported if total_reported is not None else len(compact_rows)


def build_cnmc_fallback_payload(
    fetch_json: JsonFetcher = default_fetch_json,
    fetched_at: str | None = None,
) -> dict[str, Any]:
    metadata = resolve_cnmc_annual_resource(fetch_json=fetch_json)
    records, total_records = fetch_cnmc_datastore_records(
        metadata["resourceId"],
        fetch_json=fetch_json,
    )
    timestamp = fetched_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "schemaVersion": 1,
        "fetchedAt": timestamp,
        "metadata": metadata,
        "totalRecords": total_records,
        "records": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Descarga el respaldo compacto de CNMC Telecomunicaciones Anual (API CKAN en 2 pasos)."
    )
    parser.add_argument(
        "--output",
        default="public/data/cnmc-anual.json",
        help="Ruta de salida del JSON compacto de respaldo (por defecto public/data/cnmc-anual.json).",
    )
    args = parser.parse_args()

    payload = build_cnmc_fallback_payload()
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    output_path.write_text(serialized + "\n", encoding="utf-8")

    print(
        f"CNMC respaldo generado en {output_path} "
        f"({len(payload['records'])} registros, versión {payload['metadata']['version']}, "
        f"periodo {payload['metadata']['periodo']}, {output_path.stat().st_size:,} bytes)"
    )


if __name__ == "__main__":
    main()
