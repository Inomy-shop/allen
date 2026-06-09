import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PROVIDERS,
  buildClaudeCompatibleEnvOverlay,
  buildDeepSeekEnvOverlay,
  buildKimiEnvOverlay,
  getEnabledProvidersInDefaultOrder,
  normalizeDeepSeekAnthropicBaseUrl,
} from './chat-providers.js';
import { EnvConfigProvider, resetRuntimeProvidersForTests, setRuntimeConfigProvider, setRuntimeSecretsProvider } from '../runtime/config.js';

/**
 * Test for ENG-1437: Fix Codex resume failure when resumed chat prompt starts with a dash
 *
 * The issue: Allen builds `codex exec resume ... <sessionId> <prompt>` without `--`
 * before positional args, so Codex parses prompts starting with '-' as CLI options.
 *
 * The fix: Insert `--` before sessionId and prompt to separate options from positional args.
 */

// Mock child_process module properly
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    execFile: vi.fn(), // Add this export that was missing
  };
});

describe('Codex resume command construction', () => {

  it('should include -- separator before sessionId and prompt in resume mode', async () => {
    // Import the mocked spawn function
    const { spawn } = await import('node:child_process');

    // Create a mock process object
    const mockProcess = {
      on: vi.fn((event: string, handler: Function) => {
        // Immediately trigger close event with success code
        if (event === 'close') {
          setTimeout(() => handler(0), 0);
        }
      }),
      stdin: { end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    };

    // Mock spawn to return our mock process and capture arguments
    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReturnValue(mockProcess as any);

    // Import after mocking is set up
    const { runCodexCLI } = await import('./chat-providers.js');

    // Test with a prompt that starts with a dash (the problematic case)
    const dashPrompt = '--help me with this task';
    const sessionId = 'test-session-123';

    const mockDb = {} as any; // Simple mock DB
    const mockCallbacks = {
      onText: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
    };

    // Call the function
    const promise = runCodexCLI(
      mockDb,
      'test system prompt',
      [{ role: 'user' as const, content: dashPrompt }],
      'gpt-5.5',
      mockCallbacks,
      sessionId, // This triggers resume mode
    );

    // Wait for the promise to resolve
    try {
      await promise;
    } catch {
      // Expected since we're not fully simulating the process
    }

    // Verify spawn was called with correct arguments
    expect(mockSpawn).toHaveBeenCalled();
    const [command, args] = mockSpawn.mock.calls[0];

    expect(command).toBe('codex');

    // Verify that the args array contains the proper structure:
    // ['exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--', sessionId, prompt]
    expect(args).toContain('exec');
    expect(args).toContain('resume');
    expect(args).toContain('--');

    // Find the position of '--' and verify sessionId and prompt come after it
    const dashIndex = args.indexOf('--');
    expect(dashIndex).toBeGreaterThan(-1); // '--' should exist
    expect(args[dashIndex + 1]).toBe(sessionId);
    expect(args[dashIndex + 2]).toBe(dashPrompt);
  });

  it('should not include -- separator in non-resume mode', async () => {
    // Import the mocked spawn function
    const { spawn } = await import('node:child_process');

    // Clear previous mock calls
    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockClear();

    // Create a mock process object
    const mockProcess = {
      on: vi.fn((event: string, handler: Function) => {
        // Immediately trigger close event with success code
        if (event === 'close') {
          setTimeout(() => handler(0), 0);
        }
      }),
      stdin: { end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    };

    mockSpawn.mockReturnValue(mockProcess as any);

    // Import after mocking
    const { runCodexCLI } = await import('./chat-providers.js');

    const dashPrompt = '--help me with this task';
    const mockDb = {} as any;
    const mockCallbacks = {
      onText: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
    };

    // Trigger without sessionId (non-resume mode)
    const promise = runCodexCLI(
      mockDb,
      'test system prompt',
      [{ role: 'user' as const, content: dashPrompt }],
      'gpt-5.5',
      mockCallbacks,
      undefined, // No resume session ID
    );

    try {
      await promise;
    } catch {
      // Expected since we're not fully simulating the process
    }

    // Verify spawn was called
    expect(mockSpawn).toHaveBeenCalled();
    const [command, args] = mockSpawn.mock.calls[0];

    expect(command).toBe('codex');

    // Verify that in non-resume mode, there's no '--' separator
    expect(args).toContain('exec');
    expect(args).not.toContain('resume');
    expect(args).not.toContain('--');
  });
});

describe('ALLEN_PUBLIC_URL propagation in Allen MCP env', () => {
  const originalPublicUrl = process.env.ALLEN_PUBLIC_URL;
  const originalPort = process.env.PORT;

  afterEach(() => {
    if (originalPublicUrl === undefined) {
      delete process.env.ALLEN_PUBLIC_URL;
    } else {
      process.env.ALLEN_PUBLIC_URL = originalPublicUrl;
    }
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
    vi.clearAllMocks();
  });

  it('runCodexCLI: forwards ALLEN_PUBLIC_URL in per-call -c overrides when chatSessionId is set', async () => {
    process.env.ALLEN_PUBLIC_URL = 'https://test.example.com';
    process.env.PORT = '4023';

    const { spawn } = await import('node:child_process');
    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockClear();

    const mockProcess = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'close') setTimeout(() => handler(0), 0);
      }),
      stdin: { end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    };
    mockSpawn.mockReturnValue(mockProcess as any);

    const { runCodexCLI } = await import('./chat-providers.js');
    const promise = runCodexCLI(
      {} as any,
      'system prompt',
      [{ role: 'user' as const, content: 'hello' }],
      'gpt-5.5',
      { onText: vi.fn(), onToolStart: vi.fn(), onToolResult: vi.fn() },
      undefined,  // no resume
      false,      // skipTools
      undefined,  // cwd
      undefined,  // resolved
      'chat-session-abc123', // chatSessionId — triggers mcpEnvOverrides
    );
    try { await promise; } catch { /* expected */ }

    expect(mockSpawn).toHaveBeenCalled();
    const [, args] = mockSpawn.mock.calls[0];
    const argsStr = args.join(' ');
    expect(argsStr).toContain('ALLEN_PUBLIC_URL="https://test.example.com"');
  });

  it('runCodexCLI: falls back to localhost when ALLEN_PUBLIC_URL is not set', async () => {
    delete process.env.ALLEN_PUBLIC_URL;
    process.env.PORT = '4023';

    const { spawn } = await import('node:child_process');
    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockClear();

    const mockProcess = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'close') setTimeout(() => handler(0), 0);
      }),
      stdin: { end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    };
    mockSpawn.mockReturnValue(mockProcess as any);

    const { runCodexCLI } = await import('./chat-providers.js');
    const promise = runCodexCLI(
      {} as any,
      'system prompt',
      [{ role: 'user' as const, content: 'hello' }],
      'gpt-5.5',
      { onText: vi.fn(), onToolStart: vi.fn(), onToolResult: vi.fn() },
      undefined,
      false,
      undefined,
      undefined,
      'chat-session-abc123',
    );
    try { await promise; } catch { /* expected */ }

    expect(mockSpawn).toHaveBeenCalled();
    const [, args] = mockSpawn.mock.calls[0];
    const argsStr = args.join(' ');
    expect(argsStr).toContain('ALLEN_PUBLIC_URL="http://localhost:4023"');
  });

  it('syncMcpToCodex: includes --env ALLEN_PUBLIC_URL in codex mcp add args', async () => {
    process.env.ALLEN_PUBLIC_URL = 'https://test.example.com';
    process.env.PORT = '4023';

    const { execFile } = await import('node:child_process');
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockClear();

    // execFile is used via promisify in syncMcpToCodex. The real execFile has
    // util.promisify.custom that makes the promise resolve with { stdout, stderr }.
    // vi.fn() lacks that symbol, so promisify resolves with the FIRST success arg.
    // Pass { stdout, stderr } as a single object so destructuring `{ stdout }` works.
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
      if (typeof _opts === 'function') {
        _opts(null, { stdout: '', stderr: '' });
      } else if (typeof callback === 'function') {
        callback(null, { stdout: '', stderr: '' });
      }
      return {} as any;
    });

    // syncMcpToCodex also calls McpService.list — mock the DB/service
    // by importing and dynamically stubbing the McpService import
    vi.doMock('./mcp.service.js', () => ({
      McpService: class {
        list() { return Promise.resolve([]); }
      },
    }));

    const { syncMcpToCodex } = await import('./chat-providers.js');
    try { await syncMcpToCodex({} as any); } catch { /* expected if codex not available */ }

    // Find the 'codex mcp add' call
    const addCall = mockExecFile.mock.calls.find(
      (call: any[]) => call[0] === 'codex' && Array.isArray(call[1]) && call[1].includes('add')
    );
    // The 'codex mcp add' call MUST have been captured — if addCall is undefined,
    // either the mock is broken or the fix was reverted.
    expect(addCall).toBeDefined();
    const addArgs: string[] = addCall![1] as string[];
    const argsStr = addArgs.join(' ');
    expect(argsStr).toContain('ALLEN_PUBLIC_URL=https://test.example.com');
  });
});

describe('DeepSeek provider registry', () => {
  it('deepseek is in PROVIDERS with correct shape', () => {
    const ds = PROVIDERS.find(p => p.provider === 'deepseek');
    expect(ds).toBeDefined();
    expect(ds?.label).toBe('DeepSeek');
    expect(ds?.open).toBe(true);
    expect(ds?.modelSuggestions).toContain('deepseek-v4-pro[1m]');
    expect(ds?.modelSuggestions).toContain('deepseek-v4-flash');
    expect(ds?.requiresKey).toBe('ALLEN_DEEPSEEK_API_KEY');
  });
});

describe('Claude provider registry', () => {
  it('exposes Fable in the Claude CLI model list', () => {
    const claude = PROVIDERS.find(p => p.provider === 'claude-cli');
    expect(claude).toBeDefined();
    expect(claude?.models).toEqual(['fable', 'sonnet', 'opus', 'haiku']);
  });
});

describe('Xiaomi MiMo provider registry', () => {
  it('xiaomi-mimo is in PROVIDERS with correct shape', () => {
    const mimo = PROVIDERS.find(p => p.provider === 'xiaomi-mimo');
    expect(mimo).toBeDefined();
    expect(mimo?.label).toBe('Xiaomi MiMo');
    expect(mimo?.open).toBe(true);
    expect(mimo?.modelSuggestions).toContain('mimo-v2.5-pro');
    expect(mimo?.requiresKey).toBe('ALLEN_XIAOMI_MIMO_API_KEY');
  });
});

describe('Kimi provider registry', () => {
  it('kimi is in PROVIDERS with correct shape', () => {
    const kimi = PROVIDERS.find(p => p.provider === 'kimi');
    expect(kimi).toBeDefined();
    expect(kimi?.label).toBe('Kimi');
    expect(kimi?.open).toBe(true);
    expect(kimi?.modelSuggestions).toContain('kimi-k2.6');
    expect(kimi?.modelSuggestions).toContain('kimi-k2.5');
    expect(kimi?.requiresKey).toBe('ALLEN_KIMI_API_KEY');
  });
});

describe('enabled provider registry', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of ['ALLEN_DEEPSEEK_API_KEY', 'ALLEN_XIAOMI_MIMO_API_KEY', 'ALLEN_KIMI_API_KEY']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('hides Claude-compatible API providers without configured API keys', async () => {
    delete process.env.ALLEN_DEEPSEEK_API_KEY;
    delete process.env.ALLEN_XIAOMI_MIMO_API_KEY;
    delete process.env.ALLEN_KIMI_API_KEY;

    const providers = await getEnabledProvidersInDefaultOrder();
    expect(providers.map((provider) => provider.provider)).toEqual(expect.arrayContaining(['codex', 'claude-cli']));
    expect(providers.some((provider) => provider.provider === 'deepseek')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'xiaomi-mimo')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'kimi')).toBe(false);
  });

  it('shows a Claude-compatible API provider when its key is configured', async () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'deepseek-key';
    delete process.env.ALLEN_XIAOMI_MIMO_API_KEY;
    delete process.env.ALLEN_KIMI_API_KEY;

    const providers = await getEnabledProvidersInDefaultOrder();
    expect(providers.some((provider) => provider.provider === 'deepseek')).toBe(true);
    expect(providers.some((provider) => provider.provider === 'xiaomi-mimo')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'kimi')).toBe(false);
  });

  it('shows Kimi when its key is configured', async () => {
    delete process.env.ALLEN_DEEPSEEK_API_KEY;
    delete process.env.ALLEN_XIAOMI_MIMO_API_KEY;
    process.env.ALLEN_KIMI_API_KEY = 'kimi-key';

    const providers = await getEnabledProvidersInDefaultOrder();
    expect(providers.some((provider) => provider.provider === 'deepseek')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'xiaomi-mimo')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'kimi')).toBe(true);
  });
});

describe('buildDeepSeekEnvOverlay', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    resetRuntimeProvidersForTests();
    // Restore env
    for (const key of [
      'ALLEN_DEEPSEEK_API_KEY',
      'ALLEN_DEEPSEEK_BASE_URL',
      'ALLEN_DEEPSEEK_MODEL',
      'ALLEN_DEEPSEEK_FLASH_MODEL',
      'ALLEN_XIAOMI_MIMO_API_KEY',
      'ALLEN_XIAOMI_MIMO_BASE_URL',
      'ALLEN_XIAOMI_MIMO_MODEL',
      'ALLEN_XIAOMI_MIMO_FLASH_MODEL',
      'ALLEN_KIMI_API_KEY',
      'ALLEN_KIMI_BASE_URL',
      'ALLEN_KIMI_MODEL',
      'ALLEN_KIMI_OPUS_MODEL',
      'ALLEN_KIMI_FLASH_MODEL',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    resetRuntimeProvidersForTests();
  });

  it('throws when API key is missing', async () => {
    delete process.env.ALLEN_DEEPSEEK_API_KEY;
    await expect(buildDeepSeekEnvOverlay()).rejects.toThrow('ALLEN_DEEPSEEK_API_KEY');
  });

  it('returns correct overlay keys when API key is set', async () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key-123';
    const overlay = await buildDeepSeekEnvOverlay();
    expect(overlay.ANTHROPIC_AUTH_TOKEN).toBe('test-key-123');
    expect(overlay.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(overlay.ANTHROPIC_MODEL).toBeDefined();
    expect(overlay.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4-flash');
    expect(overlay.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it('normalizes the old DeepSeek /v1 default to the Claude Code Anthropic endpoint', () => {
    expect(normalizeDeepSeekAnthropicBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/anthropic');
    expect(normalizeDeepSeekAnthropicBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/anthropic');
  });

  it('resolves desktop runtime secrets and config when process.env is empty', async () => {
    delete process.env.ALLEN_DEEPSEEK_API_KEY;
    delete process.env.ALLEN_DEEPSEEK_BASE_URL;
    delete process.env.ALLEN_DEEPSEEK_MODEL;
    delete process.env.ALLEN_DEEPSEEK_FLASH_MODEL;
    setRuntimeConfigProvider(new EnvConfigProvider({
      ALLEN_DEEPSEEK_BASE_URL: 'https://runtime.deepseek.test/v1',
      ALLEN_DEEPSEEK_MODEL: 'deepseek-runtime-model',
      ALLEN_DEEPSEEK_FLASH_MODEL: 'deepseek-runtime-flash',
    } as NodeJS.ProcessEnv));
    setRuntimeSecretsProvider({
      async getSecret(key: string) {
        return key === 'ALLEN_DEEPSEEK_API_KEY' ? 'runtime-secret-key' : undefined;
      },
    });

    const overlay = await buildDeepSeekEnvOverlay();
    expect(overlay.ANTHROPIC_AUTH_TOKEN).toBe('runtime-secret-key');
    expect(overlay.ANTHROPIC_BASE_URL).toBe('https://runtime.deepseek.test/v1');
    expect(overlay.ANTHROPIC_MODEL).toBe('deepseek-runtime-model');
    expect(overlay.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-runtime-flash');
  });

  it('does not mutate process.env', async () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key-123';
    const beforeAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    await buildDeepSeekEnvOverlay();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(beforeAuthToken); // unchanged
  });

  it('uses model override when provided', async () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key-123';
    const overlay = await buildDeepSeekEnvOverlay('deepseek-v4-flash');
    expect(overlay.ANTHROPIC_MODEL).toBe('deepseek-v4-flash');
  });

  it('builds Xiaomi MiMo overlay from generic Claude-compatible provider config', async () => {
    process.env.ALLEN_XIAOMI_MIMO_API_KEY = 'mimo-key-123';
    const overlay = await buildClaudeCompatibleEnvOverlay('xiaomi-mimo');
    expect(overlay.ANTHROPIC_AUTH_TOKEN).toBe('mimo-key-123');
    expect(overlay.ANTHROPIC_BASE_URL).toBe('https://api.xiaomimimo.com/anthropic');
    expect(overlay.ANTHROPIC_MODEL).toBe('mimo-v2.5-pro');
    expect(overlay.CLAUDE_CODE_SUBAGENT_MODEL).toBe('mimo-v2.5-pro');
  });

  it('builds Kimi overlay from generic Claude-compatible provider config', async () => {
    process.env.ALLEN_KIMI_API_KEY = 'kimi-key-123';
    const overlay = await buildKimiEnvOverlay();
    expect(overlay.ANTHROPIC_AUTH_TOKEN).toBe('kimi-key-123');
    expect(overlay.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(overlay.ANTHROPIC_MODEL).toBe('kimi-k2.5');
    expect(overlay.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.6');
    expect(overlay.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k2.5');
    expect(overlay.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.5');
    expect(overlay.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k2.5');
  });
});

describe('Codex MCP suppression for tool-less calls', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockCodexProcess() {
    return {
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'close') setTimeout(() => handler(0), 0);
      }),
      stdin: { end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    };
  }

  it('runCodexCLI: disables MCP servers when skipTools is true', async () => {
    const { spawn } = await import('node:child_process');
    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReturnValue(mockCodexProcess() as any);

    const { runCodexCLI } = await import('./chat-providers.js');
    const promise = runCodexCLI(
      {} as any,
      'system prompt',
      [{ role: 'user' as const, content: 'hello' }],
      'gpt-5.5',
      { onText: vi.fn(), onToolStart: vi.fn(), onToolResult: vi.fn() },
      undefined,
      true,
      undefined,
      undefined,
      'chat-session-abc123',
    );
    try { await promise; } catch { /* expected */ }

    expect(mockSpawn).toHaveBeenCalled();
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).toContain('-c');
    expect(args).toContain('mcp_servers={}');
    expect(args.join(' ')).not.toContain('mcp_servers.allen.env.ALLEN_CHAT_SESSION_ID');
  });

  it('runCodexCLI: keeps MCP config available when skipTools is false', async () => {
    const { spawn } = await import('node:child_process');
    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReturnValue(mockCodexProcess() as any);

    const { runCodexCLI } = await import('./chat-providers.js');
    const promise = runCodexCLI(
      {} as any,
      'system prompt',
      [{ role: 'user' as const, content: 'hello' }],
      'gpt-5.5',
      { onText: vi.fn(), onToolStart: vi.fn(), onToolResult: vi.fn() },
      undefined,
      false,
      undefined,
      undefined,
      'chat-session-abc123',
    );
    try { await promise; } catch { /* expected */ }

    expect(mockSpawn).toHaveBeenCalled();
    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('mcp_servers={}');
    expect(args.join(' ')).toContain('mcp_servers.allen.env.ALLEN_CHAT_SESSION_ID');
  });
});
