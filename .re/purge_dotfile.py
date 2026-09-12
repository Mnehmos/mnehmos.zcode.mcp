"""Delete a file whose name ends in a dot, on Windows.

A trailing dot is legal at the NTFS level but stripped by the Win32 path layer, so the ordinary API
cannot address such a file: `exists()` returns False and `open()` throws, while a directory listing
still shows the entry.

Three traps, all of which produced a false result before this version:
  * the `\\\\?\\` prefix needs BACKSLASHES only — one '/' invalidates it
  * `ntpath.abspath`/`normpath` STRIP the trailing dot, so building the NT path through them
    silently aims at a name that does not exist (WinError 2)
  * `exists()` is useless as a success check here for the same reason: it answers False for the
    stripped name no matter what happened. Only a directory listing is authoritative.

So: read the name from `os.listdir` on the NT directory path and concatenate it verbatim.

Run: python .re/purge_dotfile.py
"""
import ctypes
import os
import re
import subprocess
import sys

CLI = os.path.expanduser("~/.zcode/cli")
PREFIX = chr(92) * 2 + "?" + chr(92)          # \\?\
BS = chr(92)
QUOTE = chr(34)

SECRET_SHAPES = [
    re.compile(r"sk-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\b[0-9a-f]{32}\.[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\b[0-9a-f]{40,}\b"),
]


def nt_dir() -> str:
    """The directory as an NT path. The directory name is well-formed, so abspath is safe here."""
    return PREFIX + os.path.abspath(CLI).replace("/", BS)


def nt_child(name: str) -> str:
    """Join a RAW name from listdir without normalizing it — that is the whole point."""
    return nt_dir() + BS + name


def listing() -> list[str]:
    return os.listdir(nt_dir())


def bad_names() -> list[str]:
    """Names Windows cannot address: ending in a dot or a space."""
    return sorted(n for n in listing()
                  if n.startswith("config.json") and (n.endswith(".") or n.endswith(" ")))


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


def try_delete(name: str) -> bool:
    target = nt_child(name)

    def gone() -> bool:
        return name not in listing()

    try:
        if ctypes.windll.kernel32.DeleteFileW(target) and gone():
            print("    removed via DeleteFileW (NT path)")
            return True
        print(f"    DeleteFileW: error {ctypes.GetLastError()}")
    except Exception as e:
        print(f"    DeleteFileW: {type(e).__name__}: {e}")

    try:
        os.remove(target)
        if gone():
            print("    removed via os.remove (NT path)")
            return True
    except Exception as e:
        print(f"    os.remove: {type(e).__name__}: {e}")

    # cmd's `del` performs its own wildcard matching, which can reach a name without spelling it.
    try:
        subprocess.run(f"del /f /q {QUOTE}{target}{QUOTE}", shell=True, capture_output=True, text=True)
        if gone():
            print("    removed via cmd del")
            return True
        print("    cmd del: no effect")
    except Exception as e:
        print(f"    cmd del: {type(e).__name__}: {e}")

    return False


def main() -> int:
    print("=== config.json backups on disk ===")
    for n in sorted(listing()):
        if n.startswith("config.json.bak-"):
            mark = "  <-- ends in dot/space" if (n.endswith(".") or n.endswith(" ")) else ""
            print(f"  {n!r}{mark}")

    bad = bad_names()
    if not bad:
        print("\nnothing to clean")
        return 0

    print(f"\n=== purging {len(bad)} ===")
    for name in bad:
        print(f"  {name!r} ({os.path.getsize(nt_child(name))} bytes)")
        scan_for_secrets(nt_child(name))
        if not try_delete(name):
            print("    COULD NOT REMOVE")
            return 1

    # Authoritative check: the directory listing, not exists().
    print("\n=== verify (directory listing) ===")
    remaining = bad_names()
    if remaining:
        print(f"  STILL PRESENT: {remaining}")
        return 1
    print("  gone; no config.json backup name ends in a dot or a space")
    return 0


if __name__ == "__main__":
    sys.exit(main())
