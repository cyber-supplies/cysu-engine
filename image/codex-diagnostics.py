#!/usr/bin/env python3
"""Emit safe request metadata from Codex's local log after a failed attempt.

Never copy the log database or its free-form messages out of the worker: they
can contain prompts, tool output, URLs, and credentials. Only allowlisted
status and correlation fields leave the container.
"""

import json
import os
import re
import sqlite3
import sys
from pathlib import Path


STATUS = re.compile(r"(?:unexpected status|\bstatus[=:])\s*(\d{3})\b", re.I)
REQUEST_ID = re.compile(r"\brequest[ _-]?id\s*[:=]\s*([A-Za-z0-9_-]{8,128})", re.I)
CF_RAY = re.compile(r"\bcf-ray\s*[:=]\s*([A-Za-z0-9_-]{8,128})", re.I)
ERROR_CODE = re.compile(r'"code"\s*:\s*"([A-Za-z0-9_.-]{1,100})"')
ERROR_PARAM = re.compile(r'"param"\s*:\s*"([A-Za-z0-9_.-]{1,100})"')
MAX_ROWS = 500
MAX_RECORDS = 10


def extract(body):
    if not isinstance(body, str) or "chatgpt.com/backend-api/codex/responses" not in body:
        return None
    fields = {}
    for key, pattern in (("status", STATUS), ("requestId", REQUEST_ID),
                         ("cfRay", CF_RAY), ("errorCode", ERROR_CODE),
                         ("errorParam", ERROR_PARAM)):
        match = pattern.search(body)
        if match:
            fields[key] = int(match[1]) if key == "status" else match[1]
    return fields or None


def collect(since, home):
    paths = (home / ".codex" / "logs_2.sqlite", home / ".codex" / "sqlite" / "logs_2.sqlite")
    found = False
    records = []
    for path in paths:
        if not path.is_file():
            continue
        found = True
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1)
            try:
                con.execute("PRAGMA query_only=ON")
                rows = con.execute(
                    "SELECT ts, feedback_log_body FROM logs WHERE ts >= ? "
                    "AND level IN ('WARN', 'ERROR') ORDER BY ts DESC LIMIT ?",
                    (since, MAX_ROWS),
                )
                for ts, body in rows:
                    fields = extract(body)
                    if fields:
                        records.append({"timestamp": int(ts), **fields})
            finally:
                con.close()
        except (sqlite3.Error, OSError):
            continue
    # Retry logs can repeat the same request. Keep the most recent distinct
    # records, and bound the engine event even when a run has many failures.
    unique = list(dict.fromkeys(json.dumps(r, sort_keys=True) for r in records))
    return found, [json.loads(r) for r in unique[:MAX_RECORDS]]


def main():
    since = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    kind = sys.argv[2] if len(sys.argv) > 2 else ""
    found, records = collect(since, Path(os.environ.get("HOME", "/home/runner")))
    print(json.dumps({"type": "engine.codex.diagnostic", "kind": kind,
                      "logFound": found, "records": records}, separators=(",", ":")))


if __name__ == "__main__":
    main()
