import { describe, expect, it } from 'vitest';
import {
  findRepoContextUsage,
  findRepoContextUsageInText,
  isRepoContextLoaderToolCall,
  shouldRetryForRepoContextLoadingCompliance,
  withRepoContextUsageOutput,
} from '../src/repo-context-usage.js';
import type { ToolCallRecord } from '../src/tool-call.js';

function toolCall(tool: string): ToolCallRecord {
  return {
    tool,
    description: tool,
    args: {},
    durationMs: 0,
    startedAt: new Date(),
  };
}

describe('repo context usage helpers', () => {
  it('does not add repo_context_usage output for freeform nodes', () => {
    const node = {
      output_format: 'freeform' as const,
      outputs: { summary: 'Plain text summary.' },
    };

    expect(withRepoContextUsageOutput(node)).toBe(node);
  });

  it('adds repo_context_usage output for structured nodes', () => {
    const node = { outputs: { summary: 'Summary.' } };

    expect(withRepoContextUsageOutput(node).outputs).toEqual({
      summary: 'Summary.',
      repo_context_usage: 'Repo context usage report following the injected system repo_context_usage contract.',
    });
  });

  it('keeps an authored repo_context_usage output description', () => {
    const node = { outputs: { repo_context_usage: 'Custom usage contract.' } };

    expect(withRepoContextUsageOutput(node).outputs?.repo_context_usage).toBe('Custom usage contract.');
  });

  it('finds nested repo context usage in objects and raw JSON text', () => {
    const usage = {
      context_loaded: [{ refId: 'ref-guidelines', source: 'get_repo_context_body' }],
    };

    expect(findRepoContextUsage({ output: { repo_context_usage: usage } })).toBe(usage);
    expect(findRepoContextUsage({ context_applied: [{ refId: 'ref-guidelines' }] })).toEqual({
      context_applied: [{ refId: 'ref-guidelines' }],
    });
    expect(findRepoContextUsageInText(`Result\n\n\`\`\`json\n${JSON.stringify({ repo_context_usage: usage })}\n\`\`\``)).toEqual(usage);
  });

  it('detects Allen repo context body-loader tool calls', () => {
    expect(isRepoContextLoaderToolCall(toolCall('get_repo_context_body'))).toBe(true);
    expect(isRepoContextLoaderToolCall(toolCall('get_repo_skill_body'))).toBe(true);
    expect(isRepoContextLoaderToolCall(toolCall('mcp__allen__get_repo_context_body'))).toBe(true);
    expect(isRepoContextLoaderToolCall(toolCall('mcp__allen__get_repo_skill_body'))).toBe(true);
    expect(isRepoContextLoaderToolCall(toolCall('Read'))).toBe(false);
  });

  it('keeps compliance retry disabled by default', () => {
    expect(shouldRetryForRepoContextLoadingCompliance(
      { repo_context_usage: { context_loaded: [{ refId: 'ref-guidelines' }] } },
      undefined,
      [],
      { packetId: 'packet-1' },
      'session-1',
    )).toBe(false);
  });
});
