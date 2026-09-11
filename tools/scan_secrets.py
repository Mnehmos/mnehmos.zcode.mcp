#!/usr/bin/env python3
"""Sweep git history for real credentials.

Written after a real API key was committed inside a test fixture — copied from a config dump as a
"fake" sample value, because it *looked* like a synthetic token. It was not. Shape-plausible is not
synthetic, and a test fixture is still a committed file.

This reads the machine's real secret stores, then searches every blob and every commit message in
the repository for those values. It never prints a secret, only where one is.

    python tools/scan_secrets.py            # scan all refs
    python tools/scan_secrets.py --staged   # only what is about to be committed

Exit code 1 if any real value is found, so it can gate a commit or a CI step.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

MIN_SECRET_LEN = 20


def collect_real_secrets() -> dict[str, str]:
    """Every secret-shaped value this machine holds, keyed by a human-readable origin."""
    out: dict[str, str] = {}

    zcode_cfg = os.path.expanduser("~/.zcode/v2/config.json")
    if os.path.exists(zcode_cfg):
        try:
            cfg = json.load(open(zcode_cfg, encoding="utf-8"))
            for pid, provider in (cfg.get("provider") or {}).items():
                key = (provider.get("options") or {}).get("apiKey", "")
                if isinstance(key, str) and len(key) >= MIN_SECRET_LEN:
                    out[f"zcode config provider {pid}"] = key
        except (OSError, ValueError):
            pass

    creds = os.path.expanduser("~/.zcode/v2/credentials.json")
    if os.path.exists(creds):
        try:
            for k, v in json.load(open(creds, encoding="utf-8")).items():
                if isinstance(v, str) and len(v) >= MIN_SECRET_LEN:
                    out[f"zcode credentials {k}"] = v
        except (OSError, ValueError):
            pass

    # A local .env is the most likely place for a real value to be sitting while you work.
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if os.path.exists(env_path):
        for line in open(env_path, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            value = value.strip().strip('"').strip("'")
            if len(value) >= MIN_SECRET_LEN and any(
                t in name.upper() for t in ("KEY", "TOKEN", "SECRET", "PASSWORD")
            ):
                out[f".env {name.strip()}"] = value

    return out


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], capture_output=True).stdout


def scan(secrets: dict[str, str], staged_only: bool) -> list[str]:
    hits: list[str] = []

    if staged_only:
        diff = git("diff", "--cached", "-U0")
        for origin, value in secrets.items():
            if value.encode() in diff:
                hits.append(f"staged content <- {origin}")
        return hits

    # Every object in the repository, so a value removed from HEAD but still in history is caught.
    for line in git("rev-list", "--objects", "--all").decode("utf-8", "replace").splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        sha, path = parts
        content = git("cat-file", "-p", sha)
        for origin, value in secrets.items():
            if value.encode() in content:
                hits.append(f"{sha[:8]}  {path}  <- {origin}")

    messages = git("log", "--all", "--format=%B").decode("utf-8", "replace")
    for origin, value in secrets.items():
        if value in messages:
            hits.append(f"<commit message>  <- {origin}")

    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--staged", action="store_true", help="only check what is staged for commit")
    args = ap.parse_args()

    secrets = collect_real_secrets()
    if not secrets:
        print("no real secrets found on this machine to compare against")
        return 0

    print(f"checking {len(secrets)} real secret value(s) against "
          f"{'the index' if args.staged else 'all git objects and messages'}\n")

    hits = scan(secrets, args.staged)
    if not hits:
        print("CLEAN — no real credential appears in git history")
        return 0

    print(f"FOUND {len(hits)} occurrence(s) of a real credential:\n")
    for h in hits:
        print(f"  {h}")
    print(
        "\nRemoving the value from HEAD does NOT un-expose it: the commit is already public.\n"
        "Rotate the credential. Only then is the exposure closed."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
