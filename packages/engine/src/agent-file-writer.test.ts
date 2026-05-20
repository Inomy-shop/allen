import { describe, expect, it } from 'vitest';
import { renderAgentFile } from './agent-file-writer.js';

describe('renderAgentFile', () => {
  it('omits tools frontmatter when the agent has no explicit tools', () => {
    const rendered = renderAgentFile({
      name: 'researcher',
      system: 'You investigate.',
      mcpToolNames: ['mcp__linear__get_issue'],
    });

    expect(rendered.body).not.toMatch(/^tools:/m);
    expect(rendered.allowedTools).toBeUndefined();
  });

  it('omits tools frontmatter when the explicit tools list is empty', () => {
    const rendered = renderAgentFile({
      name: 'researcher',
      system: 'You investigate.',
      tools: [],
      mcpToolNames: ['mcp__linear__get_issue'],
    });

    expect(rendered.body).not.toMatch(/^tools:/m);
    expect(rendered.allowedTools).toBeUndefined();
  });

  it('injects MCP tools only when an explicit allowlist already exists', () => {
    const rendered = renderAgentFile({
      name: 'developer',
      system: 'You implement.',
      tools: ['filesystem'],
      mcpToolNames: ['mcp__linear__get_issue'],
    });

    const toolsLine = rendered.body.split('\n').find((line) => line.startsWith('tools: '));
    expect(toolsLine).toBeDefined();
    expect(toolsLine).toContain('Read');
    expect(toolsLine).toContain('Write');
    expect(toolsLine).toContain('mcp__allen__spawn_agent');
    expect(toolsLine).toContain('mcp__linear__get_issue');
    expect(rendered.allowedTools).toContain('Read');
    expect(rendered.allowedTools).toContain('mcp__allen__spawn_agent');
    expect(rendered.allowedTools).toContain('mcp__linear__get_issue');
  });
});
