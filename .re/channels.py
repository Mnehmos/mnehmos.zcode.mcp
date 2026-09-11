"""Extract the IPC channel constant map from a bundled Electron file.

Handles both `Name:"channel:str"` (minified object literal) and the
`exposeInMainWorld("api",{...})` surface.
"""
import json
import re
import sys

path = sys.argv[1]
s = open(path, "r", encoding="utf-8", errors="replace").read()

# --- 1. channel map: Ident:"string" pairs, focused on zcode:/app: style names
pairs = re.findall(r'([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*"([^"]{2,120})"', s)
chan = {}
for k, v in pairs:
    if re.match(r'^[a-z][a-z0-9-]*:', v) or v.startswith(("zcode", "app", "arms")):
        chan.setdefault(k, set()).add(v)

out = {k: sorted(v) for k, v in sorted(chan.items())}
print(f"# {len(out)} named channel constants in {path}")
if len(sys.argv) > 2 and sys.argv[2] == "json":
    json.dump(out, open(sys.argv[3], "w", encoding="utf-8"), indent=1)
else:
    for k, v in out.items():
        print(f"{k} = {v[0]}" + ("  (multiple!)" if len(v) > 1 else ""))
