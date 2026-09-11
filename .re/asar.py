"""Minimal ASAR reader/listing/extractor.

ASAR = Chromium Pickle header:
  u32 @0  = 4
  u32 @4  = header payload size (size of the following pickle content)
  u32 @8  = string payload size (header JSON len + padding)
  u32 @12 = header JSON byte length
  u32 @16 = header JSON byte length (dup)
  header JSON at 16
  file data begins at 8 + header_size
"""
import json
import os
import struct
import sys

BLOCK = 4 * 1024 * 1024


class Asar:
    def __init__(self, path):
        self.path = path
        self.f = open(path, "rb")
        head = self.f.read(16)
        (self.pickle0, self.header_size, self.str_size,
         self.json_len) = struct.unpack("<IIII", head)
        self.json_bytes = self.f.read(self.str_size)
        self.header = json.loads(
            self.json_bytes[: self.json_len].decode("utf-8"))
        self.data_offset = 8 + self.header_size

    def resolve(self, inner):
        """inner path uses '/' separators, no leading slash."""
        node = self.header
        if inner in ("", "/"):
            return node
        for part in inner.strip("/").split("/"):
            if "files" not in node:
                return None
            node = node["files"].get(part)
            if node is None:
                return None
        return node

    def read(self, inner):
        node = self.resolve(inner)
        if node is None or "offset" not in node:
            return None
        size = int(node["size"])
        off = self.data_offset + int(node["offset"])
        self.f.seek(off)
        if "unpacked" in node:
            up = self.path + ".unpacked"
            with open(os.path.join(up, inner.replace("/", os.sep)), "rb") as g:
                return g.read()
        buf = bytearray()
        while len(buf) < size:
            chunk = self.f.read(min(BLOCK, size - len(buf)))
            if not chunk:
                break
            buf += chunk
        return bytes(buf)

    def walk(self, node=None, prefix=""):
        node = node or self.header
        for name, child in (node.get("files") or {}).items():
            p = f"{prefix}/{name}" if prefix else name
            if "files" in child:
                yield from self.walk(child, p)
            else:
                yield p, int(child.get("size", 0)), bool(child.get("unpacked"))


def fmt(n):
    for u in ("B", "K", "M", "G"):
        if n < 1024:
            return f"{n:.0f}{u}"
        n /= 1024.0
    return f"{n:.1f}T"


if __name__ == "__main__":
    a = Asar(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) > 2 else "list"
    if mode == "list":
        filt = sys.argv[3] if len(sys.argv) > 3 else ""
        lim = int(sys.argv[4]) if len(sys.argv) > 4 else 10 ** 9
        rows = sorted(
            (p, s, u) for p, s, u in a.walk() if filt.lower() in p.lower())
        print(f"# {len(rows)} entries matching {filt!r}")
        for p, s, u in rows[:lim]:
            print(f"{fmt(s):>9}  {p}{'  [unpacked]' if u else ''}")
    elif mode == "cat":
        d = a.read(sys.argv[3])
        if d is None:
            print("NOT FOUND", file=sys.stderr)
            sys.exit(1)
        sys.stdout.buffer.write(d[: int(sys.argv[4])] if len(sys.argv) > 4 else d)
    elif mode == "extract":
        inner, dest = sys.argv[3], sys.argv[4]
        d = a.read(inner)
        if d is None:
            print("NOT FOUND", file=sys.stderr)
            sys.exit(1)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as g:
            g.write(d)
        print(f"wrote {len(d)} bytes -> {dest}")
    elif mode == "sizes":
        # top-level dir sizes
        agg = {}

        def rec(node, prefix, depth):
            for name, child in (node.get("files") or {}).items():
                p = f"{prefix}/{name}" if prefix else name
                if "files" in child:
                    if depth == 0:
                        rec(child, p, depth + 1)
                    else:
                        rec(child, p, depth + 1)
                else:
                    key = "/".join(p.split("/")[:2]) if depth else p
                    agg[key] = agg.get(key, 0) + int(child.get("size", 0))
        rec(a.header, "", 0)
        for k, v in sorted(agg.items(), key=lambda kv: -kv[1])[:60]:
            print(f"{fmt(v):>9}  {k}")
