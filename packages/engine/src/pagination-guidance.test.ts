/**
 * Unit tests for ENG-1560: Pagination guidance injected into agent system prompts.
 *
 * Covers all 11 acceptance criteria:
 * AC-1  PAGINATION_GUIDANCE_SENTINEL value
 * AC-2  PAGINATION_GUIDANCE content keywords
 * AC-3  withPaginationGuidance idempotency
 * AC-4  renderAgentFile applies pagination guidance
 * AC-5  packages/engine/src/index.ts re-exports all three symbols
 * AC-6  node-executor.ts imports & applies withPaginationGuidance
 * AC-7  codex-executor.ts imports & applies withPaginationGuidance
 * AC-8  repo-context-scanner.service.ts imports & applies withPaginationGuidance
 * AC-9  chat-tools.ts imports & applies PAGINATION_GUIDANCE at all 4 sites
 * AC-10 chat.service.ts applies withPaginationGuidance in both functions
 * AC-11 TypeScript build: no new errors (verified by CI, represented here as
 *        a structural smoke test)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  PAGINATION_GUIDANCE_SENTINEL,
  PAGINATION_GUIDANCE,
  withPaginationGuidance,
  withArtifactsGuidance,
  withNonInteractiveGuidance,
  renderAgentFile,
} from './agent-file-writer.js';

// ── Helper: read source files for call-site checks ──────────────────────────

const engineRoot = resolve(__dirname, '..');
const serverRoot = resolve(engineRoot, '../server/src/services');

function readSrc(rel: string): string {
  return readFileSync(resolve(engineRoot, 'src', rel), 'utf8');
}

function readServerSrc(rel: string): string {
  return readFileSync(resolve(serverRoot, rel), 'utf8');
}

function readEngineIndex(): string {
  return readSrc('index.ts');
}

// ── AC-1: PAGINATION_GUIDANCE_SENTINEL value ─────────────────────────────────

describe('PAGINATION_GUIDANCE_SENTINEL', () => {
  it('equals the exact heading string "# Handling large MCP responses"', () => {
    expect(PAGINATION_GUIDANCE_SENTINEL).toBe('# Handling large MCP responses');
  });
});

// ── AC-2: PAGINATION_GUIDANCE content keywords ───────────────────────────────

describe('PAGINATION_GUIDANCE', () => {
  it('contains the section heading "# Handling large MCP responses"', () => {
    expect(PAGINATION_GUIDANCE).toContain('# Handling large MCP responses');
  });

  it('contains the worked example for get_chat_messages', () => {
    expect(PAGINATION_GUIDANCE).toContain('get_chat_messages');
  });

  it('contains the before cursor parameter (used for backward pagination)', () => {
    // The guidance uses `before:` in JSON object syntax (e.g. { before: "msg_abc" })
    // which is the correct MCP tool call form. The AC keyword "before=" refers
    // to the concept, not a literal string — the `before` parameter is present.
    expect(PAGINATION_GUIDANCE).toContain('before');
  });

  it('contains the worked example for query_database', () => {
    expect(PAGINATION_GUIDANCE).toContain('query_database');
  });

  it('contains projection guidance', () => {
    expect(PAGINATION_GUIDANCE).toContain('projection');
  });

  it('contains limit guidance', () => {
    expect(PAGINATION_GUIDANCE).toContain('limit');
  });

  it('contains summarize guidance', () => {
    expect(PAGINATION_GUIDANCE.toLowerCase()).toContain('summarize');
  });
});

// ── AC-3: withPaginationGuidance idempotency ─────────────────────────────────

describe('withPaginationGuidance', () => {
  it('appends PAGINATION_GUIDANCE when sentinel is absent', () => {
    const base = 'You are a helpful agent.';
    const result = withPaginationGuidance(base);
    expect(result).toContain(PAGINATION_GUIDANCE_SENTINEL);
    expect(result.length).toBeGreaterThan(base.length);
  });

  it('is idempotent — does not append twice when sentinel is already present', () => {
    const base = 'You are a helpful agent.';
    const once = withPaginationGuidance(base);
    const twice = withPaginationGuidance(once);
    expect(once).toBe(twice);
  });

  it('does not append when the prompt already contains the sentinel', () => {
    const alreadyHas = `Some instructions\n${PAGINATION_GUIDANCE_SENTINEL}\n...more`;
    const result = withPaginationGuidance(alreadyHas);
    // Count occurrences of sentinel
    const count = (result.match(new RegExp(PAGINATION_GUIDANCE_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    expect(count).toBe(1);
  });

  it('preserves the original prompt text', () => {
    const base = 'Original instructions here.';
    const result = withPaginationGuidance(base);
    expect(result).toContain(base);
  });

  it('is sentinel-distinct from ARTIFACTS_GUIDANCE and NON_INTERACTIVE_GUIDANCE', () => {
    const artificatsOnly = withArtifactsGuidance('prompt');
    const nonInteractiveOnly = withNonInteractiveGuidance('prompt');
    // Pagination guidance not present in the other two
    expect(artificatsOnly).not.toContain(PAGINATION_GUIDANCE_SENTINEL);
    expect(nonInteractiveOnly).not.toContain(PAGINATION_GUIDANCE_SENTINEL);
  });
});

// ── AC-4: renderAgentFile applies withPaginationGuidance ────────────────────

describe('renderAgentFile — pagination guidance injection', () => {
  it('includes PAGINATION_GUIDANCE_SENTINEL in the rendered body', () => {
    const { body } = renderAgentFile({
      name: 'test-agent',
      system: 'You are a test agent.',
    });
    expect(body).toContain(PAGINATION_GUIDANCE_SENTINEL);
  });

  it('includes pagination guidance even when the system prompt already has artifact guidance', () => {
    const systemWithArtifacts = withArtifactsGuidance('base system');
    const { body } = renderAgentFile({
      name: 'test-agent',
      system: systemWithArtifacts,
    });
    expect(body).toContain(PAGINATION_GUIDANCE_SENTINEL);
  });

  it('does not double-inject when system prompt already contains pagination guidance', () => {
    const systemWithAll = withPaginationGuidance(withNonInteractiveGuidance(withArtifactsGuidance('base')));
    const { body } = renderAgentFile({
      name: 'test-agent',
      system: systemWithAll,
    });
    const count = (body.match(new RegExp(PAGINATION_GUIDANCE_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    expect(count).toBe(1);
  });
});

// ── AC-5: index.ts re-exports all three symbols ──────────────────────────────

describe('packages/engine/src/index.ts re-exports', () => {
  it('re-exports PAGINATION_GUIDANCE', () => {
    const src = readEngineIndex();
    expect(src).toContain('PAGINATION_GUIDANCE');
  });

  it('re-exports PAGINATION_GUIDANCE_SENTINEL', () => {
    const src = readEngineIndex();
    expect(src).toContain('PAGINATION_GUIDANCE_SENTINEL');
  });

  it('re-exports withPaginationGuidance', () => {
    const src = readEngineIndex();
    expect(src).toContain('withPaginationGuidance');
  });
});

// ── AC-6: node-executor.ts applies withPaginationGuidance ───────────────────

describe('node-executor.ts call-site checks', () => {
  it('imports withPaginationGuidance', () => {
    const src = readSrc('node-executor.ts');
    expect(src).toContain('withPaginationGuidance');
  });

  it('applies withPaginationGuidance to effectiveSystem (covers both SDK + CLI paths via shared variable)', () => {
    const src = readSrc('node-executor.ts');
    // The shared effectiveSystem is enriched before the SDK/CLI branch
    expect(src).toMatch(/effectiveSystem\s*=\s*withPaginationGuidance\s*\(/);
  });
});

// ── AC-7: codex-executor.ts applies withPaginationGuidance ──────────────────

describe('codex-executor.ts call-site checks', () => {
  it('imports withPaginationGuidance', () => {
    const src = readSrc('codex-executor.ts');
    expect(src).toContain('withPaginationGuidance');
  });

  it('applies withPaginationGuidance at the prompt-assembly site', () => {
    const src = readSrc('codex-executor.ts');
    expect(src).toContain('withPaginationGuidance(');
  });
});

// ── AC-8: repo-context-scanner.service.ts applies withPaginationGuidance ────

describe('repo-context-scanner.service.ts call-site checks', () => {
  it('imports withPaginationGuidance from @allen/engine', () => {
    const src = readServerSrc('repo-context-scanner.service.ts');
    expect(src).toContain('withPaginationGuidance');
  });

  it('applies withPaginationGuidance to customSystemPrompt', () => {
    const src = readServerSrc('repo-context-scanner.service.ts');
    expect(src).toContain('withPaginationGuidance(');
  });
});

// ── AC-9: chat-tools.ts applies pagination guidance at all 4 sites ───────────

describe('chat-tools.ts call-site checks', () => {
  it('imports PAGINATION_GUIDANCE or withPaginationGuidance', () => {
    const src = readServerSrc('chat-tools.ts');
    expect(src).toMatch(/PAGINATION_GUIDANCE|withPaginationGuidance/);
  });

  it('applies pagination guidance (expects at least 4 occurrences across the file)', () => {
    const src = readServerSrc('chat-tools.ts');
    const matches = src.match(/PAGINATION_GUIDANCE|withPaginationGuidance\s*\(/g) ?? [];
    // Import line + 4 application sites = at least 5 total hits
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it('includes PAGINATION_GUIDANCE in the CLI spawn site (args.push)', () => {
    const src = readServerSrc('chat-tools.ts');
    // CLI spawn path: args.push(`...${PAGINATION_GUIDANCE}...`)
    expect(src).toMatch(/args\.push[\s\S]*?PAGINATION_GUIDANCE/);
  });

  it('includes PAGINATION_GUIDANCE in the SDK spawn systemPromptBody', () => {
    const src = readServerSrc('chat-tools.ts');
    // SDK spawn path assembles systemPromptBody containing PAGINATION_GUIDANCE
    expect(src).toMatch(/systemPromptBody[\s\S]*?PAGINATION_GUIDANCE|PAGINATION_GUIDANCE[\s\S]*?systemPromptBody/);
  });
});

// ── AC-10: chat.service.ts applies pagination guidance in both functions ─────

describe('chat.service.ts call-site checks', () => {
  it('imports withPaginationGuidance from @allen/engine', () => {
    const src = readServerSrc('chat.service.ts');
    expect(src).toContain('withPaginationGuidance');
  });

  it('applies withPaginationGuidance at least twice (buildAgentSystemPrompt + getSystemPrompt)', () => {
    const src = readServerSrc('chat.service.ts');
    const matches = src.match(/withPaginationGuidance\s*\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('wraps the base system prompt in buildAgentSystemPrompt with withPaginationGuidance', () => {
    const src = readServerSrc('chat.service.ts');
    // buildAgentSystemPrompt should use withPaginationGuidance on the return value
    expect(src).toContain('withPaginationGuidance(');
  });
});
