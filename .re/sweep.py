#!/usr/bin/env python3
"""Sweep for network-surface primitives across all extracted JS."""
import io, os, re, glob

PRIMS = [
    r'WebSocketServer',
    r'from"ws"',
    r'from"node:ws"',
    r'require\("ws"\)',
    r'from"http"',
    r'from"https"',
    r'from"node:http"',
    r'from"node:https"',
    r'from"node:net"',
    r'from"net"',
    r'from"node:dgram"',
    r'from"dgram"',
    r'createServer',
    r'\.listen\(',
    r'\.connect\(',
    r'\bhono\b',
    r'\bexpress\b',
    r'\bfastify\b',
    r'\bkoa\b',
    r'WebSocket\(',
    r'server\.address\(',
    r'127\.0\.0\.1',
    r'0\.0\.0\.0',
    r'localhost:',
    r'listen\(\{',
    r'createConnection',
    r'ServerResponse',
    r'IncomingMessage',
]

files = sorted(glob.glob('x/**/*.js', recursive=True) + glob.glob('x/**/*.cjs', recursive=True))
for f in files:
    d = io.open(f, encoding='utf-8', errors='replace').read()
    hits = {}
    for p in PRIMS:
        n = len(re.findall(p, d))
        if n:
            hits[p] = n
    if hits:
        print("=== %s (%d bytes)" % (f, len(d)))
        for k, v in hits.items():
            print("    %-24s %d" % (k, v))
