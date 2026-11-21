#!/usr/bin/env python3
"""
Publicador de baja latencia (< 3s) de telemetría y deltas en tiempo real
(`scan-status.json`, `live-tail.json` y `live-chunk-*.json`) hacia la rama
huérfana `refs/heads/scan-status` mediante fontanería Git (`hash-object` ->
`mktree` -> `commit-tree` -> `push --force`), sin tocar el árbol de trabajo
ni el historial de `main`.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
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

LIVE_CHUNK_RE = re.compile(r"^live-chunk-(\d+)\.json$")
MIN_PUSH_COOLDOWN_SECONDS = 2.5
POLL_STEP_SECONDS = 0.5


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


def write_bytes_atomic(raw: bytes, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".pub.tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, path)


def resolve_live_dir(status_path: Path, live_dir: Path | str | None) -> Path | None:
    if live_dir is not None and str(live_dir).strip():
        return Path(live_dir)
    parent = status_path.parent
    if parent.exists():
        if (parent / "live-tail.json").exists():
            return parent
        try:
            for entry in parent.iterdir():
                if entry.is_file() and LIVE_CHUNK_RE.match(entry.name):
                    return parent
        except OSError:
            pass
    return None


def _git_hash_bytes(raw_bytes: bytes, *, cwd: Path | str | None = None) -> str:
    proc = subprocess.run(
        ["git", "hash-object", "-w", "--stdin"],
        input=raw_bytes,
        capture_output=True,
        timeout=15,
        env=GIT_ENV,
        cwd=cwd,
        check=True,
    )
    return proc.stdout.decode("utf-8").strip()


def _collect_live_files(live_dir: Path | None) -> tuple[Path | None, list[tuple[int, Path]]]:
    if live_dir is None or not live_dir.exists():
        return None, []
    tail_path = live_dir / "live-tail.json"
    eff_tail = tail_path if tail_path.is_file() else None
    chunks: list[tuple[int, Path]] = []
    try:
        for entry in live_dir.iterdir():
            if not entry.is_file():
                continue
            m = LIVE_CHUNK_RE.match(entry.name)
            if m:
                chunks.append((int(m.group(1)), entry))
    except OSError:
        pass
    chunks.sort(key=lambda item: item[0])
    return eff_tail, chunks


def push_status_to_branch(
    status_path: Path,
    live_dir: Path | str | None = None,
    branch: str = "scan-status",
    blob_sha_cache: dict[str, str] | None = None,
    cwd: Path | str | None = None,
) -> bool:
    payload = read_json_safe(status_path)
    if payload is None:
        return False

    eff_live_dir = resolve_live_dir(status_path, live_dir)
    tail_path, chunk_files = _collect_live_files(eff_live_dir)

    if chunk_files:
        max_chunk_count = max(idx + 1 for idx, _ in chunk_files)
        if int(payload.get("chunkCount") or 0) < max_chunk_count:
            payload["chunkCount"] = max_chunk_count
    if tail_path is not None:
        tail_doc = read_json_safe(tail_path)
        if tail_doc is not None:
            tail_seq = int(tail_doc.get("seq") or 0)
            if int(payload.get("deltaSeq") or 0) < tail_seq:
                payload["deltaSeq"] = tail_seq

    payload["updatedAt"] = utc_now_iso()
    status_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    try:
        tree_entries: list[tuple[str, str]] = [
            ("scan-status.json", _git_hash_bytes(status_bytes, cwd=cwd))
        ]

        if tail_path is not None:
            try:
                tail_bytes = tail_path.read_bytes()
                if tail_bytes:
                    tree_entries.append(
                        ("live-tail.json", _git_hash_bytes(tail_bytes, cwd=cwd))
                    )
            except OSError:
                pass

        for _, chunk_path in chunk_files:
            cname = chunk_path.name
            cached_sha = blob_sha_cache.get(cname) if blob_sha_cache is not None else None
            if cached_sha:
                tree_entries.append((cname, cached_sha))
                continue
            try:
                chunk_bytes = chunk_path.read_bytes()
            except OSError:
                continue
            if not chunk_bytes:
                continue
            csha = _git_hash_bytes(chunk_bytes, cwd=cwd)
            if blob_sha_cache is not None:
                blob_sha_cache[cname] = csha
            tree_entries.append((cname, csha))

        tree_entries.sort(key=lambda item: item[0])
        tree_input = "".join(
            f"100644 blob {sha}\t{name}\n" for name, sha in tree_entries
        ).encode("utf-8")

        tree_proc = subprocess.run(
            ["git", "mktree"],
            input=tree_input,
            capture_output=True,
            timeout=15,
            env=GIT_ENV,
            cwd=cwd,
            check=True,
        )
        tree_sha = tree_proc.stdout.decode("utf-8").strip()

        commit_proc = subprocess.run(
            [
                "git",
                "commit-tree",
                tree_sha,
                "-m",
                "telemetry: update scan-status.json and live delta chunks",
            ],
            capture_output=True,
            timeout=15,
            env=GIT_ENV,
            cwd=cwd,
            check=True,
        )
        commit_sha = commit_proc.stdout.decode("utf-8").strip()

        subprocess.run(
            [
                "git",
                "push",
                "--force",
                "--quiet",
                "origin",
                f"{commit_sha}:refs/heads/{branch}",
            ],
            capture_output=True,
            timeout=30,
            env=GIT_ENV,
            cwd=cwd,
            check=True,
        )
        return True
    except Exception as exc:
        print(
            f"[publish_scan_status] aviso al publicar telemetría en {branch}: {exc}",
            file=sys.stderr,
        )
        return False


def restore_from_branch(
    status_path: Path,
    live_dir: Path | str | None = None,
    branch: str = "scan-status",
    expected_scan_id: str = "",
    cwd: Path | str | None = None,
) -> bool:
    """
    Restaura `scan-status.json`, `live-tail.json` y todos los `live-chunk-*.json`
    desde `origin/<branch>` para continuar sin cortes un escaneo multi-tramo (`append`).
    """
    eff_live_dir = Path(live_dir) if live_dir else status_path.parent
    remote_ref = f"refs/remotes/origin/{branch}"

    try:
        fetch_proc = subprocess.run(
            [
                "git",
                "fetch",
                "--depth=1",
                "origin",
                f"refs/heads/{branch}:{remote_ref}",
            ],
            capture_output=True,
            timeout=30,
            env=GIT_ENV,
            cwd=cwd,
            check=False,
        )
        if fetch_proc.returncode != 0:
            return False

        status_proc = subprocess.run(
            ["git", "show", f"{remote_ref}:scan-status.json"],
            capture_output=True,
            timeout=15,
            env=GIT_ENV,
            cwd=cwd,
            check=False,
        )
        if status_proc.returncode != 0 or not status_proc.stdout:
            return False

        remote_status = json.loads(status_proc.stdout.decode("utf-8"))
        if not isinstance(remote_status, dict):
            return False

        clean_expected = str(expected_scan_id or "").strip()
        if clean_expected and str(remote_status.get("scanId") or "") != clean_expected:
            print(
                f"[publish_scan_status] scanId remoto ({remote_status.get('scanId')!r}) "
                f"difiere del esperado ({clean_expected!r}); omitiendo restore.",
                file=sys.stderr,
            )
            return False

        write_json_atomic(remote_status, status_path)

        ls_proc = subprocess.run(
            ["git", "ls-tree", "--name-only", remote_ref],
            capture_output=True,
            timeout=15,
            env=GIT_ENV,
            cwd=cwd,
            check=True,
        )
        names = [
            line.strip()
            for line in ls_proc.stdout.decode("utf-8").splitlines()
            if line.strip()
        ]

        eff_live_dir.mkdir(parents=True, exist_ok=True)
        for name in names:
            if name == "live-tail.json" or LIVE_CHUNK_RE.match(name):
                show_proc = subprocess.run(
                    ["git", "show", f"{remote_ref}:{name}"],
                    capture_output=True,
                    timeout=15,
                    env=GIT_ENV,
                    cwd=cwd,
                    check=False,
                )
                if show_proc.returncode == 0 and show_proc.stdout:
                    write_bytes_atomic(show_proc.stdout, eff_live_dir / name)

        return True
    except Exception as exc:
        print(
            f"[publish_scan_status] aviso al restaurar estado desde {branch}: {exc}",
            file=sys.stderr,
        )
        return False


def _snapshot_watch_signature(
    status_path: Path,
    live_dir: Path | None,
) -> tuple[int, int, str, str, int]:
    doc = read_json_safe(status_path) or {}
    delta_seq = int(doc.get("deltaSeq") or 0)
    chunk_count = int(doc.get("chunkCount") or 0)
    phase = str(doc.get("phase") or "")
    state = str(doc.get("state") or "")
    tail_mtime_ns = 0
    if live_dir is not None:
        tail_path = live_dir / "live-tail.json"
        try:
            tail_mtime_ns = tail_path.stat().st_mtime_ns
        except OSError:
            tail_mtime_ns = 0
    return (delta_seq, chunk_count, phase, state, tail_mtime_ns)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status-file", required=True)
    parser.add_argument(
        "--live-dir",
        default=None,
        help="Directorio opcional con live-tail.json y live-chunk-*.json.",
    )
    parser.add_argument(
        "--mode",
        choices=("watch", "finalize", "restore"),
        required=True,
    )
    parser.add_argument("--interval", type=float, default=8.0)
    parser.add_argument("--branch", default="scan-status")
    parser.add_argument("--scan-id", default="")
    parser.add_argument("--scan-trigger", default="workflow_dispatch")
    parser.add_argument("--record-novedades", default="true")
    parser.add_argument("--part", default="1/2")
    parser.add_argument("--started-at", default="")
    parser.add_argument("--antenas-file", default="public/data/antenas.json")
    parser.add_argument("--job-status", default="success")
    parser.add_argument("--has-more", default="false")
    parser.add_argument("--cwd", default=None)
    args = parser.parse_args(argv)

    status_path = Path(args.status_file)
    eff_live_dir = Path(args.live_dir) if args.live_dir else resolve_live_dir(status_path, None)
    is_first_part = not args.part or args.part.startswith("1/")

    if args.mode == "restore":
        restore_from_branch(
            status_path,
            live_dir=eff_live_dir,
            branch=args.branch,
            expected_scan_id=args.scan_id,
            cwd=args.cwd,
        )
        return 0

    if args.mode == "finalize":
        payload = read_json_safe(status_path) or {
            "schemaVersion": 2,
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
            "deltaSeq": 0,
            "chunkCount": 0,
            "liveNewAntennasCount": 0,
            "liveUpdatedAntennasCount": 0,
            "liveNovedadesCount": 0,
            "requestsPerSecond": 0.0,
        }
        payload["schemaVersion"] = 2
        if args.part:
            payload["part"] = args.part
        payload.setdefault("deltaSeq", 0)
        payload.setdefault("chunkCount", 0)
        payload.setdefault("liveNewAntennasCount", 0)
        payload.setdefault("liveUpdatedAntennasCount", 0)
        payload.setdefault("liveNovedadesCount", 0)
        payload.setdefault("requestsPerSecond", 0.0)

        job_ok = args.job_status.lower() == "success"
        has_more = args.has_more.lower() == "true"
        if job_ok and has_more:
            payload["state"] = "handoff"
            payload.pop("completedDatasetUpdatedAt", None)
        elif job_ok and not has_more:
            payload["state"] = "completed"
            ant_path = Path(args.antenas_file)
            if ant_path.exists():
                ant_doc = read_json_safe(ant_path)
                if ant_doc is not None:
                    if isinstance(ant_doc.get("updatedAt"), str) and ant_doc["updatedAt"]:
                        payload["completedDatasetUpdatedAt"] = ant_doc["updatedAt"]
                    if isinstance(ant_doc.get("total"), int) and ant_doc["total"] > 0:
                        payload["totalAntennas"] = ant_doc["total"]
            total_ant = int(payload.get("totalAntennas") or 0)
            if total_ant > 0:
                payload["scannedAntennas"] = total_ant
            payload["percent"] = 100.0
        else:
            payload["state"] = "stopped"

        payload["updatedAt"] = utc_now_iso()
        write_json_atomic(payload, status_path)
        push_status_to_branch(
            status_path,
            live_dir=eff_live_dir,
            branch=args.branch,
            cwd=args.cwd,
        )
        return 0

    # Modo watch: si aún no existe status_path, sembrar estado inicial v2;
    # si fue restaurado desde un tramo previo ('handoff'), reactivar a 'running'.
    existing_doc = read_json_safe(status_path)
    if existing_doc is None:
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
                if not is_first_part and isinstance(ant_list, list) and args.started_at:
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
            "schemaVersion": 2,
            "state": "running",
            "scanId": args.scan_id,
            "trigger": args.scan_trigger,
            "recordNovedades": args.record_novedades.lower() == "true",
            "part": args.part,
            "phase": "censo" if is_first_part else "frecuencias",
            "startedAt": args.started_at or utc_now_iso(),
            "updatedAt": utc_now_iso(),
            "censusBoxesVisited": 0 if is_first_part else 239,
            "estimatedCensusBoxes": 239,
            "discoveredAntennas": 0,
            "scannedAntennas": seeded_scanned,
            "totalAntennas": fallback_total,
            "percent": seeded_pct,
            "deltaSeq": 0,
            "chunkCount": 0,
            "liveNewAntennasCount": 0,
            "liveUpdatedAntennasCount": 0,
            "liveNovedadesCount": 0,
            "requestsPerSecond": 0.0,
        }
        write_json_atomic(seed, status_path)
    else:
        existing_doc["schemaVersion"] = 2
        existing_doc["state"] = "running"
        if args.part:
            existing_doc["part"] = args.part
        if not is_first_part:
            existing_doc["phase"] = "frecuencias"
        existing_doc["updatedAt"] = utc_now_iso()
        write_json_atomic(existing_doc, status_path)

    stop = False

    def _handle_sig(_signum: int, _frame: Any) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, _handle_sig)
    signal.signal(signal.SIGINT, _handle_sig)

    blob_sha_cache: dict[str, str] = {}
    heartbeat_interval = max(MIN_PUSH_COOLDOWN_SECONDS, float(args.interval))

    push_status_to_branch(
        status_path,
        live_dir=eff_live_dir,
        branch=args.branch,
        blob_sha_cache=blob_sha_cache,
        cwd=args.cwd,
    )
    last_push_ts = time.monotonic()
    last_sig = _snapshot_watch_signature(status_path, eff_live_dir)

    while not stop:
        time.sleep(POLL_STEP_SECONDS)
        if stop:
            break
        if eff_live_dir is None:
            eff_live_dir = resolve_live_dir(status_path, args.live_dir)
        now = time.monotonic()
        elapsed = now - last_push_ts
        cur_sig = _snapshot_watch_signature(status_path, eff_live_dir)
        sig_changed = cur_sig != last_sig

        if (sig_changed and elapsed >= MIN_PUSH_COOLDOWN_SECONDS) or (
            elapsed >= heartbeat_interval
        ):
            push_status_to_branch(
                status_path,
                live_dir=eff_live_dir,
                branch=args.branch,
                blob_sha_cache=blob_sha_cache,
                cwd=args.cwd,
            )
            last_push_ts = time.monotonic()
            last_sig = _snapshot_watch_signature(status_path, eff_live_dir)

    return 0


if __name__ == "__main__":
    sys.exit(main())
