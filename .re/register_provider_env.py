"""Register a provider key that can ACTUALLY infer, chosen by trying it.

The previous version copied `.env`'s DeepSeek key on the assumption it was live. It was revoked
between two checks an hour apart, so the registration ended up holding a dead credential — which
looks exactly like a working one until a turn fails. Presence is not liveness.

So this version collects every candidate (`.env`, and ZCode's own `~/.zcode/v2/config.json`
providers), makes a minimal real inference call with each against the configured base URL, and
registers the first one that succeeds. If none succeeds, nothing is written and it says so.

Written into the `zcode` server's env block in all three CLI profiles, because mcp-profile.cmd
swaps config.json between them. The user profile only; no value enters the repo, and none is printed.

Run: python .re/register_provider_env.py
"""
import json
import os
import shutil
import sys
import urllib.error
import urllib.request

CLI = os.path.expanduser("~/.zcode/cli")
ZCODE_CFG = os.path.expanduser("~/.zcode/v2/config.json")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(ROOT, ".env")
PROFILES = ["config.json", "config.full.json", "config.glm-safe.json"]
SERVER = "zcode"
TARGET_VAR = "DEEPSEEK_API_KEY"


def dotenv() -> dict:
    out = {}
    if not os.path.exists(ENV_FILE):
        return out
    with open(ENV_FILE, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def candidates() -> list[tuple[str, str]]:
    """Every key that could plausibly serve the configured model, best guess first."""
    out = []
    env = dotenv()
    if env.get("DEEPSEEK_API_KEY"):
        out.append((".env DEEPSEEK_API_KEY", env["DEEPSEEK_API_KEY"]))
    if os.path.exists(ZCODE_CFG):
        try:
            cfg = json.load(open(ZCODE_CFG, encoding="utf-8"))
            for pid, prov in (cfg.get("provider") or {}).items():
                k = (prov.get("options") or {}).get("apiKey")
                if isinstance(k, str) and len(k) >= 20:
                    out.append((f"zcode config {pid}", k))
        except (OSError, ValueError):
            pass
    seen, uniq = set(), []
    for label, k in out:
        if k not in seen:
            seen.add(k)
            uniq.append((label, k))
    return uniq


def can_infer(key: str, base_url: str, model: str) -> tuple[bool, str]:
    """One minimal real call. 200 means this key can serve this model, which is the whole question."""
    url = base_url.rstrip("/") + "/v1/messages"
    body = json.dumps({"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status == 200, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:110]
        return False, f"HTTP {e.code} {detail}"
    except Exception as e:  # noqa: BLE001 - a network fault is just another "not proven live"
        return False, f"{type(e).__name__}: {e}"


def backup(path: str) -> str:
    from datetime import datetime
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = f"{path}.bak-provider-{stamp}"
    n = 2
    while os.path.exists(dest):
        dest = f"{path}.bak-provider-{stamp}-{n}"
        n += 1
    shutil.copy2(path, dest)
    if open(dest, encoding="utf-8").read() != open(path, encoding="utf-8").read():
        raise RuntimeError(f"backup at {dest} does not match {path}")
    return dest


def main() -> int:
    env = dotenv()
    base_url = env.get("ZCODE_MCP_BASE_URL", "")
    model = env.get("ZCODE_MCP_MODEL", "").split("/")[-1]
    if not base_url or not model:
        print("ZCODE_MCP_BASE_URL and ZCODE_MCP_MODEL are needed to test a key; nothing written")
        return 1

    print(f"model: {model}")
    print(f"base : {base_url}\n")

    chosen = None
    for label, key in candidates():
        ok, detail = can_infer(key, base_url, model)
        print(f"  {label:<48} sha256:{__import__('hashlib').sha256(key.encode()).hexdigest()[:8]}  "
              f"{'CAN INFER' if ok else 'no'} — {detail}")
        if ok and chosen is None:
            chosen = (label, key)

    if chosen is None:
        print("\nno candidate can infer; registration left unchanged")
        return 1
    print(f"\nchosen: {chosen[0]}\n")

    for name in PROFILES:
        p = os.path.join(CLI, name)
        if not os.path.exists(p):
            print(f"{name}: absent, skipped")
            continue
        cfg = json.load(open(p, encoding="utf-8"))
        servers = cfg.setdefault("mcp", {}).setdefault("servers", {})
        if SERVER not in servers:
            print(f"{name}: no '{SERVER}' server, skipped")
            continue
        block = servers[SERVER].setdefault("env", {})
        block[TARGET_VAR] = chosen[1]
        b = backup(p)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
            fh.write("\n")
        # Read back from disk, and prove the value on disk is the one that inferred.
        after = json.load(open(p, encoding="utf-8"))
        got = after["mcp"]["servers"][SERVER]["env"].get(TARGET_VAR, "")
        print(f"{name}: {'set' if got == chosen[1] else 'MISMATCH'}  (backup {os.path.basename(b)})")
        if got != chosen[1]:
            return 1

    print("\nwritten to the user profile only; nothing entered the repo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
