#!/usr/bin/env python3
"""
Publicador ligero de telemetría en tiempo real (`scan-status.json`) hacia la rama
huérfana `refs/heads/scan-status` mediante fontanería Git (`hash-object` -> `mktree`
-> `commit-tree` -> `push --force`), sin tocar el árbol de trabajo ni el historial de `main`.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from typing import Any


GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "github-actions[bot]",
    "GIT_AUTHOR_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
    "GIT_COMMITTER_NAME": "github-actions[bot]",
    "GIT_COMMITTER_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json_safe(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def write_json_atomic(data: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".pub.tmp")
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    tmp.write_bytes(encoded)
    os.replace(tmp, path)


def push_status_to_branch(status_path: Path, branch: str = "scan-status") -> bool:
    payload = read_json_safe(status_path)
    if payload is None:
        return False

    payload["updatedAt"] = utc_now_iso()
    raw_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    try:
        blob_proc = subprocess.run(
            ["git", "hash-object", "-w", "--stdin"],
            input=raw_bytes,
            capture_output=True,
            timeout=15,
            env=GIT_ENV,
            check=True,
        )
        blob_sha = blob_proc.stdout.decode("utf-8").strip()

        tree_input = f"100644 blob {blob_sha}\tscan-status.json\n".encode("utf-8")
        tree_proc = subprocess.run(
            ["git", "mktree"],
            input=tree_input,
            capture_output=True,
            timeout=15,
            env=GIT_ENV,
            check=True,
        )
        tree_sha = tree_proc.stdout.decode("utf-8").strip()

        commit_proc = subprocess.run(
            ["git", "commit-tree", tree_sha, "-m", "telemetry: update scan-status.json"],
            capture_output=True,
            timeout=15,
            env=GIT_ENV,
            check=True,
        )
        commit_sha = commit_proc.stdout.decode("utf-8").strip()

        subprocess.run(
            ["git", "push", "--force", "--quiet", "origin", f"{commit_sha}:refs/heads/{branch}"],
            capture_output=True,
            timeout=30,
            env=GIT_ENV,
            check=True,
        )
        return True
    except Exception as exc:
        print(f"[publish_scan_status] aviso al publicar telemetría: {exc}", file=sys.stderr)
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--mode", choices=("watch", "finalize"), required=True)
    parser.add_argument("--interval", type=float, default=50.0)
    parser.add_argument("--branch", default="scan-status")
    parser.add_argument("--scan-id", default="")
    parser.add_argument("--scan-trigger", default="workflow_dispatch")
    parser.add_argument("--record-novedades", default="true")
    parser.add_argument("--part", default="1/4")
    parser.add_argument("--started-at", default="")
    parser.add_argument("--antenas-file", default="public/data/antenas.json")
    parser.add_argument("--job-status", default="success")
    parser.add_argument("--has-more", default="false")
    args = parser.parse_args(argv)

    status_path = Path(args.status_file)

    if args.mode == "finalize":
        payload = read_json_safe(status_path) or {
            "schemaVersion": 1,
            "scanId": args.scan_id,
            "trigger": args.scan_trigger,
            "recordNovedades": args.record_novedades.lower() == "true",
            "part": args.part,
            "phase": "frecuencias",
            "startedAt": args.started_at or utc_now_iso(),
            "censusBoxesVisited": 239,
            "estimatedCensusBoxes": 239,
            "discoveredAntennas": 0,
            "scannedAntennas": 0,
            "totalAntennas": 62230,
            "percent": 0.0,
        }
        job_ok = args.job_status.lower() == "success"
        has_more = args.has_more.lower() == "true"
        if job_ok and has_more:
            payload["state"] = "handoff"
        elif job_ok and not has_more:
            payload["state"] = "completed"
            total_ant = int(payload.get("totalAntennas") or 0)
            if total_ant > 0:
                payload["scannedAntennas"] = total_ant
            payload["percent"] = 100.0
        else:
            payload["state"] = "stopped"
        payload["updatedAt"] = utc_now_iso()
        write_json_atomic(payload, status_path)
        push_status_to_branch(status_path, branch=args.branch)
        return 0

    # Modo watch: si aún no existe status_path, sembrar estado inicial exacto
    if not status_path.exists():
        fallback_total = 62230
        seeded_scanned = 0
        ant_path = Path(args.antenas_file)
        if ant_path.exists():
            ant_doc = read_json_safe(ant_path)
            if ant_doc:
                ant_list = ant_doc.get("antenas")
                if isinstance(ant_doc.get("total"), int):
                    fallback_total = ant_doc["total"]
                elif isinstance(ant_list, list):
                    fallback_total = len(ant_list)
                if args.part not in ("", "1/4") and isinstance(ant_list, list) and args.started_at:
                    seeded_scanned = sum(
                        1
                        for a in ant_list
                        if isinstance(a, dict)
                        and isinstance(a.get("bandsScannedAt"), str)
                        and a["bandsScannedAt"] >= args.started_at
                    )
        seeded_pct = (
            round((seeded_scanned / float(fallback_total)) * 100.0, 2)
            if fallback_total > 0 and seeded_scanned > 0
            else 0.0
        )
        seed = {
            "schemaVersion": 1,
            "state": "running",
            "scanId": args.scan_id,
            "trigger": args.scan_trigger,
            "recordNovedades": args.record_novedades.lower() == "true",
            "part": args.part,
            "phase": "censo" if args.part in ("", "1/4") else "frecuencias",
            "startedAt": args.started_at or utc_now_iso(),
            "updatedAt": utc_now_iso(),
            "censusBoxesVisited": 0 if args.part in ("", "1/4") else 239,
            "estimatedCensusBoxes": 239,
            "discoveredAntennas": 0,
            "scannedAntennas": seeded_scanned,
            "totalAntennas": fallback_total,
            "percent": seeded_pct,
        }
        write_json_atomic(seed, status_path)

    stop = False

    def _handle_sig(_signum: int, _frame: Any) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _handle_sig)
    signal.signal(signal.SIGINT, _handle_sig)

    # Publicación inicial rápida y luego primer refresco temprano a los 6s
    push_status_to_branch(status_path, branch=args.branch)
    first_wait = min(6.0, max(2.0, args.interval))
    t0 = time.monotonic()
    while not stop and (time.monotonic() - t0) < first_wait:
        time.sleep(0.5)
    if not stop:
        push_status_to_branch(status_path, branch=args.branch)

    while not stop:
        step_start = time.monotonic()
        while not stop and (time.monotonic() - step_start) < args.interval:
            time.sleep(0.5)
        if not stop:
            push_status_to_branch(status_path, branch=args.branch)

    return 0


if __name__ == "__main__":
    sys.exit(main())
