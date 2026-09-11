#!/usr/bin/env python3
"""Windowed context grep for minified JS."""
import sys, os, re, glob, io

def main():
    if len(sys.argv) < 3:
        print("usage: grepctx.py <pattern> <files...> [--before N] [--after N] [--max N] [--literal] [--files-only]")
        return
    pattern = sys.argv[1]
    args = sys.argv[2:]
    before = 600
    after = 1400
    maxhits = 40
    literal = False
    files_only = False
    files = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--before':
            i += 1; before = int(args[i])
        elif a == '--after':
            i += 1; after = int(args[i])
        elif a == '--max':
            i += 1; maxhits = int(args[i])
        elif a == '--literal':
            literal = True
        elif a == '--files-only':
            files_only = True
        else:
            files.append(a)
        i += 1

    expanded = []
    for f in files:
        g = glob.glob(f, recursive=True)
        expanded.extend(g if g else [f])

    total = 0
    for path in expanded:
        try:
            with io.open(path, 'r', encoding='utf-8', errors='replace') as fh:
                data = fh.read()
        except Exception as e:
            print("ERR", path, e)
            continue
        if literal:
            rx = re.compile(re.escape(pattern))
        else:
            rx = re.compile(pattern)
        hits = list(rx.finditer(data))
        if not hits:
            continue
        if files_only:
            print("FILE %s  hits=%d" % (path, len(hits)))
            continue
        for m in hits:
            if total >= maxhits:
                print("... hit limit reached ...")
                return
            total += 1
            s = max(0, m.start() - before)
            e = min(len(data), m.end() + after)
            print("=" * 100)
            print("FILE %s  OFFSET %d (line %d)  MATCH=%r" % (path, m.start(), data.count('\n', 0, m.start()) + 1, m.group(0)[:200]))
            print("-" * 100)
            print(data[s:e])
            print()

if __name__ == '__main__':
    main()
