#!/usr/bin/env python3
"""Evalúa de forma idempotente si un disparo `schedule` debe iniciar el escaneo diario de las 00:05 (Europe/Madrid).

Diseñado para soportar múltiples ventanas cron escalonadas fuera de minutos punta (:00/:30)
en GitHub Actions sin duplicar nunca el escaneo diario:
1. Antes de las 00:05 en `Europe/Madrid` (turnos `22:xx UTC` en horario de invierno CET = `23:xx`
   del día anterior, o cualquier disparo entre `00:00` y `00:04`), devuelve `should_scan=false`.
2. A partir de las 00:05 en `Europe/Madrid` (`00:05–22:59` del mismo día local), comprueba tanto
   la rama `scan-status` (`scan-status.json`) como las ejecuciones recientes del workflow en
   GitHub Actions desde el corte de las 00:05:00 `Europe/Madrid` de hoy:
   - Si ya existe un escaneo válido completado o actualmente en ejecución desde las 00:05 de hoy,
     devuelve `should_scan=false`.
   - En caso contrario (primer disparo tras las 00:05, o recuperación automática si GitHub descartó
     el turno anterior o falló una ejecución previa), devuelve `should_scan=true`.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

MADRID_TZ = ZoneInfo("Europe/Madrid")
TARGET_MADRID_HOUR = 0
TARGET_MADRID_MINUTE = 5
TARGET_MADRID_LABEL = f"{TARGET_MADRID_HOUR:02d}:{TARGET_MADRID_MINUTE:02d}"
DEFAULT_WORKFLOW_FILE = "update-and-deploy.yml"
STALE_RUNNING_SECONDS = 900  # 15 min sin latido se considera detenido/huérfano
MAX_QUEUED_AGE_SECONDS = 900  # 15 min atascado en queued sin arrancar


def parse_iso_utc(value: Any) -> datetime | None:
    """Convierte una marca temporal ISO-8601 a `datetime` UTC consciente de zona."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if cleaned.endswith("Z"):
        cleaned = f"{cleaned[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def is_in_daily_scan_window(now_madrid: datetime) -> bool:
    """Devuelve `True` si la hora en `Europe/Madrid` cae dentro del ciclo diario (`00:05–22:59`).

    Se descartan siempre las `23:00–23:59` (turnos `22:xx UTC` en invierno CET pensados para
    `00:xx CEST` en verano) y el tramo `00:00–00:04` previo al corte de las `00:05`.
    """
    if now_madrid.hour == 23:
        return False
    if now_madrid.hour == TARGET_MADRID_HOUR and now_madrid.minute < TARGET_MADRID_MINUTE:
        return False
    return True


def compute_madrid_cutoff_utc(now_utc: datetime) -> tuple[datetime, datetime]:
    """Devuelve `(now_madrid, cutoff_utc)` para las 00:05 de la fecha actual en `Europe/Madrid`."""
    aware_utc = (
        now_utc.replace(tzinfo=timezone.utc)
        if now_utc.tzinfo is None
        else now_utc.astimezone(timezone.utc)
    )
    now_madrid = aware_utc.astimezone(MADRID_TZ)
    cutoff_madrid = now_madrid.replace(
        hour=TARGET_MADRID_HOUR,
        minute=TARGET_MADRID_MINUTE,
        second=0,
        microsecond=0,
        fold=0,
    )
    return now_madrid, cutoff_madrid.astimezone(timezone.utc)


def decide_schedule_action(
    *,
    now_utc: datetime,
    current_run_id: str,
    scan_status_doc: dict[str, Any] | None,
    recent_runs_with_jobs: list[tuple[dict[str, Any], list[dict[str, Any]]]],
) -> tuple[bool, str]:
    """Determina de forma pura `(should_scan, motivo)` para un evento `schedule`."""
    now_madrid, cutoff_utc = compute_madrid_cutoff_utc(now_utc)
    aware_now_utc = (
        now_utc.replace(tzinfo=timezone.utc)
        if now_utc.tzinfo is None
        else now_utc.astimezone(timezone.utc)
    )
    cutoff_iso = cutoff_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    madrid_str = now_madrid.strftime("%Y-%m-%d %H:%M:%S %Z")

    if not is_in_daily_scan_window(now_madrid):
        return (
            False,
            f"Antes de las {TARGET_MADRID_LABEL} en Europe/Madrid ({madrid_str}); omitiendo turno UTC previo al ciclo diario.",
        )

    clean_run_id = current_run_id.strip()

    # 1) Comprobar estado publicado en `scan-status.json` (rama `scan-status`)
    if isinstance(scan_status_doc, dict):
        doc_scan_id = str(scan_status_doc.get("scanId") or "").strip()
        doc_state = str(scan_status_doc.get("state") or "").strip()
        doc_record_nov = scan_status_doc.get("recordNovedades", True) is not False
        doc_started_dt = parse_iso_utc(scan_status_doc.get("startedAt"))
        doc_updated_dt = parse_iso_utc(scan_status_doc.get("updatedAt"))

        if (
            doc_scan_id != clean_run_id
            and doc_record_nov
            and doc_started_dt is not None
            and doc_started_dt >= cutoff_utc
        ):
            if doc_state == "completed":
                return (
                    False,
                    f"Escaneo diario >= {TARGET_MADRID_LABEL} Europe/Madrid ya completado hoy (scanId={doc_scan_id}, inicio={doc_started_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}).",
                )
            if doc_state in ("running", "handoff"):
                age_sec = (
                    (aware_now_utc - doc_updated_dt).total_seconds()
                    if doc_updated_dt is not None
                    else 0.0
                )
                if age_sec <= STALE_RUNNING_SECONDS:
                    return (
                        False,
                        f"Ya hay un escaneo >= {TARGET_MADRID_LABEL} Europe/Madrid en curso (scanId={doc_scan_id}, estado={doc_state}).",
                    )

    # 2) Comprobar ejecuciones recientes del workflow y el job real de escaneo (Parte 1/2)
    for run_obj, jobs in recent_runs_with_jobs:
        if not isinstance(run_obj, dict):
            continue
        rid = str(run_obj.get("id") or "").strip()
        if not rid or rid == clean_run_id:
            continue
        event_name = str(run_obj.get("event") or "").strip()
        if event_name not in ("schedule", "workflow_dispatch"):
            continue
        created_dt = parse_iso_utc(
            run_obj.get("created_at") or run_obj.get("run_started_at")
        )
        if created_dt is None or created_dt < cutoff_utc:
            continue

        for job in jobs:
            if not isinstance(job, dict):
                continue
            jname = str(job.get("name") or "")
            if "Escaneo Nacional MINETUR" not in jname and "Parte 1/2" not in jname:
                continue
            jstatus = str(job.get("status") or "").strip()
            jconclusion = str(job.get("conclusion") or "").strip()

            if jstatus == "in_progress":
                return (
                    False,
                    f"Ya existe un job de escaneo activo desde >= {TARGET_MADRID_LABEL} Europe/Madrid (run={rid}, status={jstatus}).",
                )
            if jstatus in ("queued", "waiting", "pending"):
                queued_age = (aware_now_utc - created_dt).total_seconds()
                if queued_age <= MAX_QUEUED_AGE_SECONDS:
                    return (
                        False,
                        f"Ya existe un job de escaneo en cola desde >= {TARGET_MADRID_LABEL} Europe/Madrid (run={rid}, status={jstatus}).",
                    )
            if jstatus == "completed" and jconclusion == "success":
                return (
                    False,
                    f"El escaneo diario >= {TARGET_MADRID_LABEL} Europe/Madrid ya se ejecutó con éxito hoy (run={rid}).",
                )

    return (
        True,
        f"Activando escaneo diario de las {TARGET_MADRID_LABEL} Europe/Madrid ({madrid_str}, corte UTC >= {cutoff_iso}).",
    )


def _github_api_get_json(url: str, token: str, timeout: float = 10.0) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "RadioMapa-Espana-ScheduleGate/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw_bytes = resp.read()
    return json.loads(raw_bytes.decode("utf-8"))


def fetch_remote_scan_status(
    api_base: str, repository: str, token: str
) -> dict[str, Any] | None:
    """Lee y decodifica `scan-status.json` de la rama `scan-status` mediante GitHub API."""
    url = f"{api_base.rstrip('/')}/repos/{repository}/contents/scan-status.json?ref=scan-status"
    try:
        data = _github_api_get_json(url, token)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        print(
            f"[schedule-gate] Aviso: no se pudo leer scan-status.json ({exc}); continuando con API de runs.",
            file=sys.stderr,
        )
        return None

    if not isinstance(data, dict):
        return None
    if isinstance(data.get("content"), str) and data.get("encoding") == "base64":
        try:
            decoded = base64.b64decode(data["content"]).decode("utf-8")
            inner = json.loads(decoded)
            return inner if isinstance(inner, dict) else None
        except (ValueError, UnicodeDecodeError):
            return None
    return data


def fetch_recent_runs_with_jobs(
    api_base: str,
    repository: str,
    workflow_file: str,
    token: str,
    cutoff_utc: datetime,
    current_run_id: str,
) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """Obtiene únicamente las ejecuciones posteriores a `cutoff_utc` junto con sus jobs."""
    runs_url = (
        f"{api_base.rstrip('/')}/repos/{repository}/actions/workflows/"
        f"{workflow_file}/runs?per_page=25"
    )
    try:
        runs_payload = _github_api_get_json(runs_url, token)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        print(
            f"[schedule-gate] Aviso: no se pudo consultar runs del workflow ({exc}).",
            file=sys.stderr,
        )
        return []

    if not isinstance(runs_payload, dict) or not isinstance(
        runs_payload.get("workflow_runs"), list
    ):
        return []

    clean_current = current_run_id.strip()
    collected: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []

    for run_obj in runs_payload["workflow_runs"]:
        if not isinstance(run_obj, dict):
            continue
        rid = str(run_obj.get("id") or "").strip()
        if not rid or rid == clean_current:
            continue
        ev = str(run_obj.get("event") or "").strip()
        if ev not in ("schedule", "workflow_dispatch"):
            continue
        created_dt = parse_iso_utc(
            run_obj.get("created_at") or run_obj.get("run_started_at")
        )
        if created_dt is None or created_dt < cutoff_utc:
            continue

        jobs_url = f"{api_base.rstrip('/')}/repos/{repository}/actions/runs/{rid}/jobs?per_page=20"
        jobs_list: list[dict[str, Any]] = []
        try:
            jobs_payload = _github_api_get_json(jobs_url, token)
            if isinstance(jobs_payload, dict) and isinstance(
                jobs_payload.get("jobs"), list
            ):
                jobs_list = [j for j in jobs_payload["jobs"] if isinstance(j, dict)]
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            print(
                f"[schedule-gate] Aviso: no se pudieron leer jobs del run {rid} ({exc}).",
                file=sys.stderr,
            )
        collected.append((run_obj, jobs_list))

    return collected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=f"Evalúa si el evento schedule actual debe lanzar el escaneo diario de las {TARGET_MADRID_LABEL} Europe/Madrid."
    )
    parser.add_argument(
        "--run-id",
        default=os.environ.get("RUN_ID", ""),
        help="ID de la ejecución actual de GitHub Actions.",
    )
    parser.add_argument(
        "--repository",
        default=os.environ.get("GITHUB_REPOSITORY", "lodix12/WEB-DE-ANTENAS"),
        help="Repositorio owner/repo.",
    )
    parser.add_argument(
        "--workflow-file",
        default=DEFAULT_WORKFLOW_FILE,
        help="Nombre del archivo de workflow en .github/workflows/.",
    )
    parser.add_argument(
        "--api-url",
        default=os.environ.get("GITHUB_API_URL", "https://api.github.com"),
        help="URL base de la API REST de GitHub.",
    )
    parser.add_argument(
        "--github-output",
        default="",
        help="Ruta opcional al archivo $GITHUB_OUTPUT donde escribir should_scan y record_novedades.",
    )
    parser.add_argument(
        "--now-utc",
        default="",
        help="Sobrescritura ISO-8601 UTC para pruebas deterministas.",
    )
    args = parser.parse_args(argv)

    now_utc = (
        parse_iso_utc(args.now_utc)
        if args.now_utc
        else datetime.now(timezone.utc)
    )
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)

    now_madrid, cutoff_utc = compute_madrid_cutoff_utc(now_utc)
    token = os.environ.get("GITHUB_TOKEN", "").strip()

    if not is_in_daily_scan_window(now_madrid):
        should_scan, reason = decide_schedule_action(
            now_utc=now_utc,
            current_run_id=args.run_id,
            scan_status_doc=None,
            recent_runs_with_jobs=[],
        )
    else:
        status_doc = fetch_remote_scan_status(args.api_url, args.repository, token)
        runs_with_jobs = fetch_recent_runs_with_jobs(
            api_base=args.api_url,
            repository=args.repository,
            workflow_file=args.workflow_file,
            token=token,
            cutoff_utc=cutoff_utc,
            current_run_id=args.run_id,
        )
        should_scan, reason = decide_schedule_action(
            now_utc=now_utc,
            current_run_id=args.run_id,
            scan_status_doc=status_doc,
            recent_runs_with_jobs=runs_with_jobs,
        )

    flag = "true" if should_scan else "false"
    print(f"[schedule-gate] {reason}")
    print(f"should_scan={flag}")
    print(f"record_novedades={flag}")

    if args.github_output:
        out_path = Path(args.github_output)
        with out_path.open("a", encoding="utf-8") as fh:
            fh.write(f"should_scan={flag}\n")
            fh.write(f"record_novedades={flag}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
