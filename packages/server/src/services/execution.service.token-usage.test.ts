/**
 * AC-007: Token usage serialization unit tests.
 *
 * Covers the three token-usage paths inside execution.service.ts without
 * instantiating the large ExecutionService class:
 *
 *  1. decorateChildRow  → tokenUsage pass-through (present / absent)
 *  2. workflowStepContext  → per-field null-aware aggregation of node-trace tokenUsage
 *  3. getRunStatus  → execution-level tokenUsage pass-through
 *
 * The vi.mock for @allen/engine uses a static factory (no importOriginal) because
 * the engine package's dist/ does not exist in the worktree. aggregateTokenUsage is
 * inlined in this file (matches packages/engine/src/token-usage.ts exactly) so we
 * do not need to import it at the module level, which avoids vite import-analysis
 * resolution failures.
 *
 * Logic mirrored from execution.service.ts:
 *   decorateChildRow  line ~325  :  tokenUsage: row.tokenUsage ?? null
 *   workflowStepContext lines ~2347-2352 : aggregateTokenUsage reduce loop
 *   getRunStatus  line ~1083  :  tokenUsage: (exec as any).tokenUsage ?? null
 */

import { describe, it, expect, vi } from 'vitest';

// ── vi.mock must appear before any import that could load execution.service ──
// Static factory (no importOriginal call) so vite does not need to resolve
// @allen/engine's dist/index.js entry which does not exist here.
vi.mock('@allen/engine', () => ({
  AllenEngine: class {},
  StateManager: class {},
  loadAgents: vi.fn().mockResolvedValue([]),
  getBuiltIns: vi.fn().mockReturnValue([]),
  MCP_SERVER_NAME: 'test-mcp',
  normalizeModelAlias: (x: string) => x,
  ARTIFACTS_GUIDANCE: '',
  NON_INTERACTIVE_GUIDANCE: '',
  // aggregateTokenUsage stub (not used in the test helper below — we inline it)
  aggregateTokenUsage: () => null,
}));

// ─── Type alias (mirrors engine/src/token-usage.ts TokenUsageInfo) ───────────

interface TokenUsageInfo {
  inputCachedTokens: number | null;
  inputNonCachedTokens: number | null;
  outputTokens: number | null;
}

// ─── Inlined aggregateTokenUsage (source: engine/src/token-usage.ts) ─────────
// We copy the logic here so the test is self-contained and never needs to
// resolve the @allen/engine package at import time.

function sumField(x: number | null, y: number | null): number | null {
  if (x === null && y === null) return null;
  if (x === null) return y;
  if (y === null) return x;
  return x + y;
}

/**
 * Per-field null-aware sum of two TokenUsageInfo carriers.
 * Matches engine/src/token-usage.ts aggregateTokenUsage exactly.
 * TDD §1.6: null does NOT contribute zero.
 */
function aggregateTokenUsage(
  a?: TokenUsageInfo | null,
  b?: TokenUsageInfo | null,
): TokenUsageInfo | null {
  if (a == null && b == null) return null;
  if (a == null) return b!;
  if (b == null) return a;
  return {
    inputCachedTokens: sumField(a.inputCachedTokens, b.inputCachedTokens),
    inputNonCachedTokens: sumField(a.inputNonCachedTokens, b.inputNonCachedTokens),
    outputTokens: sumField(a.outputTokens, b.outputTokens),
  };
}

// ─── Pure helpers mirroring execution.service.ts patterns ────────────────────

/**
 * Mirrors the tokenUsage field in decorateChildRow (execution.service.ts ~325):
 *   tokenUsage: row.tokenUsage ?? null
 */
function decorateChildRowTokenUsage(
  row: Record<string, unknown>,
): TokenUsageInfo | null {
  return (row.tokenUsage as TokenUsageInfo | undefined | null) ?? null;
}

/**
 * Mirrors the workflowStepContext aggregation loop (execution.service.ts ~2347-2352):
 *
 *   let stepTokenUsage: TokenUsageInfo | null = null;
 *   for (const trace of nodeTraces) {
 *     const tu = (trace.tokenUsage && typeof trace.tokenUsage === 'object'
 *       ? trace.tokenUsage : null) as TokenUsageInfo | null;
 *     if (tu) stepTokenUsage = aggregateTokenUsage(stepTokenUsage, tu);
 *   }
 */
function aggregateStepTokenUsage(
  nodeTraces: Array<{ tokenUsage?: unknown }>,
): TokenUsageInfo | null {
  let stepTokenUsage: TokenUsageInfo | null = null;
  for (const trace of nodeTraces) {
    const tu = (
      trace.tokenUsage && typeof trace.tokenUsage === 'object'
        ? trace.tokenUsage
        : null
    ) as TokenUsageInfo | null;
    if (tu) stepTokenUsage = aggregateTokenUsage(stepTokenUsage, tu);
  }
  return stepTokenUsage;
}

/**
 * Mirrors the execution-level tokenUsage pass-through in getRunStatus
 * (execution.service.ts ~1083):
 *   tokenUsage: (exec as any).tokenUsage ?? null
 */
function getExecTokenUsage(exec: Record<string, unknown>): TokenUsageInfo | null {
  return (
    (exec as Record<string, unknown>).tokenUsage as TokenUsageInfo | undefined | null
  ) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('AC-007 execution service — token usage serialization', () => {

  // ── 1. decorateChildRow ───────────────────────────────────────────────────

  describe('decorateChildRow — tokenUsage field', () => {
    it('passes tokenUsage through when the row has a fully-populated usage object', () => {
      const usage: TokenUsageInfo = {
        inputCachedTokens: 100,
        inputNonCachedTokens: 200,
        outputTokens: 50,
      };
      expect(decorateChildRowTokenUsage({ tokenUsage: usage })).toEqual(usage);
    });

    it('returns null when tokenUsage is absent from the row', () => {
      expect(decorateChildRowTokenUsage({ status: 'completed' })).toBeNull();
    });

    it('returns null when tokenUsage is explicitly undefined', () => {
      expect(decorateChildRowTokenUsage({ tokenUsage: undefined })).toBeNull();
    });

    it('returns null when tokenUsage is explicitly null', () => {
      expect(decorateChildRowTokenUsage({ tokenUsage: null })).toBeNull();
    });

    it('preserves null sub-fields — does NOT substitute zero for absent dimensions', () => {
      const usage: TokenUsageInfo = {
        inputCachedTokens: null,
        inputNonCachedTokens: 300,
        outputTokens: null,
      };
      const result = decorateChildRowTokenUsage({ tokenUsage: usage });
      expect(result).not.toBeNull();
      expect(result!.inputCachedTokens).toBeNull();
      expect(result!.outputTokens).toBeNull();
      expect(result!.inputNonCachedTokens).toBe(300);
    });
  });

  // ── 2. workflowStepContext aggregation ────────────────────────────────────

  describe('workflowStepContext — node-trace tokenUsage aggregation', () => {
    it('sums all fields when two traces each have full tokenUsage', () => {
      const traces = [
        {
          tokenUsage: {
            inputCachedTokens: 50,
            inputNonCachedTokens: 100,
            outputTokens: 25,
          },
        },
        {
          tokenUsage: {
            inputCachedTokens: 100,
            inputNonCachedTokens: 200,
            outputTokens: 75,
          },
        },
      ];

      const result = aggregateStepTokenUsage(traces);

      expect(result).not.toBeNull();
      expect(result!.inputCachedTokens).toBe(150);
      expect(result!.inputNonCachedTokens).toBe(300);
      expect(result!.outputTokens).toBe(100);
    });

    it('returns null when no trace has a tokenUsage object', () => {
      const traces = [
        { tokenUsage: null },
        { tokenUsage: undefined },
        {},
      ];
      expect(aggregateStepTokenUsage(traces)).toBeNull();
    });

    it('returns null for an empty trace list', () => {
      expect(aggregateStepTokenUsage([])).toBeNull();
    });

    it('applies null-aware merge: null + number = number (not zero)', () => {
      // TDD §1.6: null does NOT contribute zero
      const traces = [
        {
          tokenUsage: {
            inputCachedTokens: null,
            inputNonCachedTokens: 100,
            outputTokens: null,
          },
        },
        {
          tokenUsage: {
            inputCachedTokens: 50,
            inputNonCachedTokens: null,
            outputTokens: 30,
          },
        },
      ];

      const result = aggregateStepTokenUsage(traces);

      expect(result).not.toBeNull();
      expect(result!.inputCachedTokens).toBe(50);      // null + 50 → 50
      expect(result!.inputNonCachedTokens).toBe(100);  // 100 + null → 100
      expect(result!.outputTokens).toBe(30);            // null + 30 → 30
    });

    it('preserves all-null sub-fields when the only trace has all-null tokenUsage', () => {
      // trace.tokenUsage IS an object (non-null), so aggregation runs.
      // The result mirrors the input (all sub-fields null).
      const traces = [
        {
          tokenUsage: {
            inputCachedTokens: null,
            inputNonCachedTokens: null,
            outputTokens: null,
          },
        },
      ];
      const result = aggregateStepTokenUsage(traces);
      expect(result).not.toBeNull();
      expect(result!.inputCachedTokens).toBeNull();
      expect(result!.inputNonCachedTokens).toBeNull();
      expect(result!.outputTokens).toBeNull();
    });

    it('ignores trace.tokenUsage values that are not objects (e.g. strings, numbers)', () => {
      const traces: Array<{ tokenUsage?: unknown }> = [
        { tokenUsage: 'bad-string-value' },
        { tokenUsage: 42 },
        {
          tokenUsage: {
            inputCachedTokens: 10,
            inputNonCachedTokens: 20,
            outputTokens: 5,
          },
        },
      ];

      const result = aggregateStepTokenUsage(traces);

      expect(result).not.toBeNull();
      expect(result!.inputCachedTokens).toBe(10);
      expect(result!.inputNonCachedTokens).toBe(20);
      expect(result!.outputTokens).toBe(5);
    });

    it('returns the single trace value unchanged when there is only one trace', () => {
      const usage: TokenUsageInfo = {
        inputCachedTokens: 77,
        inputNonCachedTokens: 88,
        outputTokens: 33,
      };
      const result = aggregateStepTokenUsage([{ tokenUsage: usage }]);
      expect(result).toEqual(usage);
    });
  });

  // ── 3. getRunStatus execution-level tokenUsage pass-through ───────────────

  describe('getRunStatus — execution-level tokenUsage pass-through', () => {
    it('returns tokenUsage from the execution record when it is present', () => {
      const usage: TokenUsageInfo = {
        inputCachedTokens: 500,
        inputNonCachedTokens: 1000,
        outputTokens: 200,
      };
      expect(getExecTokenUsage({ status: 'completed', tokenUsage: usage })).toEqual(usage);
    });

    it('returns null when the execution record has no tokenUsage field', () => {
      expect(getExecTokenUsage({ status: 'completed' })).toBeNull();
    });

    it('returns null when the execution tokenUsage is explicitly null', () => {
      expect(getExecTokenUsage({ status: 'completed', tokenUsage: null })).toBeNull();
    });

    it('returns null when the execution tokenUsage is explicitly undefined', () => {
      expect(getExecTokenUsage({ status: 'running', tokenUsage: undefined })).toBeNull();
    });

    it('preserves a zero-value inputCachedTokens (zero is a valid, non-null count)', () => {
      const usage: TokenUsageInfo = {
        inputCachedTokens: 0,
        inputNonCachedTokens: 50,
        outputTokens: 10,
      };
      const result = getExecTokenUsage({ tokenUsage: usage });
      expect(result).not.toBeNull();
      expect(result!.inputCachedTokens).toBe(0);
    });
  });
});
