"""Fix the unreachable-backup defect, and clean up the one already on disk.

THE BUG
  `const backup = `${p}.bak-${new Date().toISOString().replace(/[-:T]/g,'').slice(0,15)}`;`
  Stripping [-:T] from `2026-09-12T15:13:27.123Z` gives `20260912151327.123Z`; slicing to 15 chars
  leaves `20260912151327.` — the millisecond dot as the FINAL character.

  On Windows a filename ending in '.' is legal at the NTFS level but stripped by every Win32 API.
  So the backup file is created and can never be opened: `os.path.exists()` returned False and
  `open()` threw FileNotFoundError, while `glob` still listed the entry. The tool reported that path
  as the backup.

  A backup nobody can restore from is worse than no backup, because it is reported as safety. This
  is precisely the failure mode this project exists to prevent.

TWO FIXES
  1. a timestamp that cannot end in punctuation, matching ZCode's own convention
     (`config.json.bak-20260910-210504`)
  2. READ THE BACKUP BACK before reporting it, and refuse to modify the file if it is unreadable

Run: python .re/patch_backup.py
"""
import glob
import io
import os
import sys

P = "src/zcode/actions/readsurface.ts"

BACKUP_LINE = (
    "    const backup = "
    "`${p}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;"
)

NEW_BACKUP = (
    "    // A timestamp that cannot end in punctuation. Stripping [-:T] from an ISO string and\n"
    "    // slicing leaves the millisecond dot as the FINAL character, and on Windows a name ending\n"
    "    // in '.' is legal at the NTFS level but stripped by every Win32 API: the backup is created\n"
    "    // and can never be opened. That is a backup reported as safety that cannot be restored\n"
    "    // from. Matches ZCode's own convention: `config.json.bak-20260910-210504`.\n"
    "    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');\n"
    "    const backup = `${p}.bak-${stamp}`;"
)

COPY_CALL = "      copyFileSync(p, backup);\n"
COPY_WITH_VERIFY = (
    "      copyFileSync(p, backup);\n"
    "      // Verify the backup is READABLE, not merely created.\n"
    "      try {\n"
    "        const restored = readFileSync(backup, 'utf8');\n"
    "        if (restored.length === 0 && readFileSync(p, 'utf8').length > 0) {\n"
    "          o.fail(`backup at ${backup} is empty; refusing to modify ${p}`);\n"
    "          return null;\n"
    "        }\n"
    "      } catch (err) {\n"
    "        o.fail(`backup at ${backup} cannot be read back (${describe(err)}); refusing to modify ${p}`);\n"
    "        return null;\n"
    "      }\n"
)


def patch_source() -> None:
    s = io.open(P, encoding="utf-8").read()
    if BACKUP_LINE not in s:
        print(f"  !! backup line not found in {P}")
        sys.exit(1)
    s = s.replace(BACKUP_LINE, NEW_BACKUP, 1)
    if COPY_CALL not in s:
        print(f"  !! copyFileSync call not found in {P}")
        sys.exit(1)
    s = s.replace(COPY_CALL, COPY_WITH_VERIFY, 1)
    # the line-based fix earlier left stale eslint pragmas for a require() that no longer exists
    s = s.replace("      // eslint-disable-next-line @typescript-eslint/no-var-requires\n", "")
    io.open(P, "w", encoding="utf-8", newline="").write(s)
    print(f"  patched {P}")


def remove_unreachable() -> None:
    """Delete any config.json.bak-* whose name ends in a dot.

    Such a name cannot be addressed by an ordinary Win32 path. The extended-length prefix `\\\\?\\`
    bypasses Win32 name normalization and can reach it.
    """
    cli = os.path.expanduser("~/.zcode/cli")
    extended = chr(92) * 2 + "?" + chr(92)
    found = 0
    for f in glob.glob(os.path.join(cli, "config.json.bak-*")):
        if not os.path.basename(f).endswith("."):
            continue
        found += 1
        win = os.path.abspath(f)
        print(f"  unreachable backup: {os.path.basename(f)}")
        for label, cand in (("extended path", extended + win),
                            ("plain path", win),
                            ("dot stripped", win.rstrip("."))):
            try:
                os.remove(cand)
                print(f"    removed via {label}")
                break
            except Exception as e:
                print(f"    {label}: {type(e).__name__}")
        else:
            print("    COULD NOT REMOVE. It holds a pre-edit copy of the config; harmless but stuck.")
    if found == 0:
        print("  no unreachable backups found")


if __name__ == "__main__":
    patch_source()
    remove_unreachable()
