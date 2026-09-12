"""Find (and optionally delete) Windows files whose names cannot be addressed.

A trailing dot or space is legal at the NTFS level but stripped by the Win32 path layer, so the
ordinary API cannot reach such a file: `exists()` returns False and `open()` throws, while a
directory listing shows the entry plainly. A backup written under such a name is a safety net that
no restore can ever use, and it stays on disk until someone removes it through an NT path.

Three traps, all of which produced a false result before this version:
  * the `\\\\?\\` prefix needs BACKSLASHES only — one '/' invalidates it
  * `ntpath.abspath`/`normpath` STRIP the trailing dot, so building the NT path through them
    silently aims at a name that does not exist (WinError 2)
  * `exists()` is useless as a success check here for the same reason: it answers False for the
    stripped name no matter what happened. Only a directory listing is authoritative.

Usage:
  python .re/purge_dotfile.py                      scan and purge ~/.zcode/cli (the config dir)
  python .re/purge_dotfile.py --scan <root>        report only, recursively
  python .re/purge_dotfile.py --purge <root>       delete recursively
"""
import ctypes
import os
import re
import subprocess
import sys

BS = chr(92)
PREFIX = BS * 2 + "?" + BS                      # \\?\
QUOTE = chr(34)
DEFAULT_ROOT = os.path.expanduser("~/.zcode/cli")

SECRET_SHAPES = [
    re.compile(r"sk-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\b[0-9a-f]{32}\.[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\b[0-9a-f]{40,}\b"),
]


def nt(path: str) -> str:
    """Absolute path with backslashes only. Safe for a directory whose own name is well-formed."""
    return PREFIX + os.path.abspath(path).replace("/", BS)


def bad(name: str) -> bool:
    return name.endswith(".") or name.endswith(" ")


def walk(root: str):
    """Yield (dir, name) for every unaddressable entry under root.

    Recursion goes through NT paths and each name is joined RAW — the whole point is to never pass
    the offending component through a normalizing function.
    """
    stack = [os.path.abspath(root)]
    while stack:
        d = stack.pop()
        if not os.path.isdir(nt(d)):
            continue
        try:
            names = os.listdir(nt(d))
        except OSError:
            continue
        for n in names:
            if bad(n):
                yield d, n
            else:
                full = os.path.join(d, n)
                # isdir on a well-formed name is fine; unaddressable ones never reach here.
                if os.path.isdir(nt(full)):
                    stack.append(full)


def scan_for_secrets(path: str) -> None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except Exception as e:
        print(f"    could not read back before deleting: {type(e).__name__}: {e}")
        return
    hits = sorted({m.group(0)[:6] + "..." for rx in SECRET_SHAPES for m in rx.finditer(text)})
    if hits:
        print(f"    NOTE: secret-shaped values present ({len(hits)} distinct, prefixes only): {hits}")
        print("    a credential lived outside the repo; if it was ever live, rotate it")
    else:
        print("    no secret-shaped values")


def delete(d: str, name: str) -> bool:
    target = nt(d) + BS + name

    def gone() -> bool:
        try:
            return name not in os.listdir(nt(d))
        except OSError:
            return False

    if ctypes.windll.kernel32.DeleteFileW(target) and gone():
        return True
    if ctypes.GetLastError() not in (0, 2):
        print(f"    DeleteFileW: error {ctypes.GetLastError()}")
    try:
        subprocess.run(f"del /f /q {QUOTE}{target}{QUOTE}", shell=True, capture_output=True, text=True)
        if gone():
            return True
    except OSError:
        pass
    return False


def main(argv: list[str]) -> int:
    mode, root = "purge", DEFAULT_ROOT
    if len(argv) > 1:
        if argv[1] not in ("--scan", "--purge"):
            print(__doc__)
            return 2
        mode = "scan" if argv[1] == "--scan" else "purge"
        if len(argv) > 2:
            root = argv[2]

    print(f"=== {mode} {root} ===")
    found = sorted(walk(root))
    if not found:
        print("  no unaddressable names")
        return 0

    failures = 0
    for d, name in found:
        print(f"  {os.path.join(d, name)!r}")
        if mode == "scan":
            continue
        print(f"    {os.path.getsize(nt(d) + BS + name)} bytes")
        scan_for_secrets(nt(d) + BS + name)
        if delete(d, name):
            print("    removed")
        else:
            print("    COULD NOT REMOVE")
            failures += 1

    # Authoritative check: a fresh listing, never exists().
    remaining = sorted(walk(root))
    print(f"=== verify: {len(remaining)} remaining ===")
    for d, name in remaining:
        print(f"  {os.path.join(d, name)!r}")
    return 1 if (failures or remaining) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
