import { describe, expect, it, vi } from 'vitest';

vi.mock('@allen/engine', () => ({
  buildSingleServerConfig: vi.fn(),
}));

import { MCP_PRESETS } from './mcp.service.js';

describe('MCP_PRESETS', () => {
  it('includes Playwright MCP preset with safe stdio defaults', () => {
    const playwright = MCP_PRESETS.find((preset) => preset.name === 'playwright');

    expect(playwright).toMatchObject({
      name: 'playwright',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
      envKeys: [],
      docsUrl: 'https://playwright.dev/mcp/installation',
    });

    expect(MCP_PRESETS.filter((preset) => preset.name === 'playwright')).toHaveLength(1);
  });

  it('includes one X API preset backed by xurl and no separate X Docs preset', () => {
    const xapi = MCP_PRESETS.find((preset) => preset.name === 'xapi');

    expect(xapi).toMatchObject({
      name: 'xapi',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@xdevplatform/xurl', 'mcp', 'https://api.x.com/mcp'],
      envKeys: ['CLIENT_ID', 'CLIENT_SECRET'],
      docsUrl: 'https://docs.x.com/tools/mcp',
    });

    expect(MCP_PRESETS.filter((preset) => preset.name === 'xapi')).toHaveLength(1);
    expect(MCP_PRESETS.some((preset) => preset.name === 'x-docs' || preset.name === 'xdocs')).toBe(false);
    expect(MCP_PRESETS.some((preset) => preset.args?.includes('https://docs.x.com/mcp'))).toBe(false);
  });
});
