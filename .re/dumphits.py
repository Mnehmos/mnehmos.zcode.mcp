#!/usr/bin/env python3
"""Dump all occurrences with offsets, merged/non-overlapping windows."""
import sys, os, re, glob, io

def main():
    pattern = sys.argv[1]
    files = sys.argv[2:]
    before = 400
    after = 900
    literal = False
    ffiles = []
    i = 0
    while i < len(files):
        a = files[i]
        if a == '--before':
            i += 1; before = int(files[i])
        elif a == '--after':
            i += 1; after = int(files[i])
        elif a == '--literal':
            literal = True
        else:
            ffiles.append(a)
        i += 1

    expanded = []
    for f in ffiles:
        g = glob.glob(f, recursive=True)
        expanded.extend(g if g else [f])

    for path in expanded:
        with io.open(path, 'r', encoding='utf-8', errors='replace') as fh:
            data = fh.read()
        rx = re.compile(re.escape(pattern) if literal else pattern)
        spans = [(m.start(), m.end(), m.group(0)) for m in rx.finditer(data)]
        if not spans:
            continue
        print("#" * 110)
        print("# FILE %s  (%d occurrences)" % (path, len(spans)))
        print("#" * 110)
        # merge
        merged = []
        for s, e, g in spans:
            ws, we = max(0, s - before), min(len(data), e + after)
            if merged and ws <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], we))
            else:
                merged.append((ws, we))
        for idx, (ws, we) in enumerate(merged):
            print("=" * 100)
            print("REGION %d  [%d..%d]" % (idx, ws, we))
            print("-" * 100)
            print(data[ws:we])
            print()

if __name__ == '__main__':
    main()
