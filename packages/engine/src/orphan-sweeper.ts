/**
 * Sweeps stale allen-*.md subagent files from ~/.claude/agents/ on engine
 * startup. Covers the case where a prior engine process crashed or was killed
 * before its try/finally could unlink the file it wrote.
 *
 * Only removes files matching the `allen-*` prefix — never touches a user's
 * hand-written agents in the same directory.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export type SweepResult = {
  scanned: number;
  removed: number;
  errors: number;
};

/** Delete allen-*.md files in ~/.claude/agents/ older than maxAgeMs. */
export function sweepOrphanAgentFiles(maxAgeMs: number = DEFAULT_MAX_AGE_MS): SweepResult {
  const dir = resolvePath(homedir(), '.claude', 'agents');
  const result: SweepResult = { scanned: 0, removed: 0, errors: 0 };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory doesn't exist yet — nothing to sweep.
    return result;
  }

  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    if (!name.startsWith('allen-') || !name.endsWith('.md')) continue;
    result.scanned++;
    const filePath = resolvePath(dir, name);
    try {
      const st = statSync(filePath);
      if (st.mtimeMs < cutoff) {
        unlinkSync(filePath);
        result.removed++;
      }
    } catch {
      result.errors++;
    }
  }

  return result;
}
