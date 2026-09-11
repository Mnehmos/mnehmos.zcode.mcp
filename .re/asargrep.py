#!/usr/bin/env python3
"""Stream-grep the asar for a pattern, printing matching inner paths with hit counts + small windows."""
import sys, re, io
sys.path.insert(0, r'F:\Github\mcp\mnehmos.zcode.mcp\.re')
from asar import Asar

def main():
    asar_path = sys.argv[1]
    prefix = sys.argv[2]
    pattern = sys.argv[3]
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else 20
    ctx = int(sys.argv[5]) if len(sys.argv) > 5 else 200

    a = Asar(asar_path)
    rx = re.compile(pattern)
    shown = 0
    for p, size, unpacked in sorted(a.walk()):
        if prefix not in p:
            continue
        if size > 6 * 1024 * 1024:
            continue
        try:
            raw = a.read(p)
        except Exception:
            continue
        if raw is None:
            continue
        if b'webRemoteControl' not in raw and b'WebRemoteControl' not in raw and b'qrUrl' not in raw:
            continue
        d = raw.decode('utf-8', 'replace')
        hits = list(rx.finditer(d))
        if not hits:
            continue
        print("### %s  size=%d hits=%d" % (p, size, len(hits)))
        for m in hits[:limit]:
            s = max(0, m.start() - ctx)
            e = min(len(d), m.end() + ctx)
            print("   [%d] ...%s..." % (m.start(), d[s:e].replace('\n', ' ')))
            shown += 1
            if shown >= limit:
                return
        print()

if __name__ == '__main__':
    main()
