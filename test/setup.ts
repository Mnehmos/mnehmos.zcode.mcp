/** Shared test fixtures. Kept intentionally small: the interesting behaviour is in the
 *  modules under test, not here. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A scratch directory that exists for the duration of a test run. */
export function scratchDir(name = 'zcode-mcp-test'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  return dir;
}

export function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** A syntactically valid installed bundle path, for env tests that must not spawn. */
export const FAKE_CLI = path.join(os.tmpdir(), 'not-a-real-zcode.cjs');
