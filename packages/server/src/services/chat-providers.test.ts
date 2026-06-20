import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  PROVIDERS,
  buildClaudeCompatibleEnvOverlay,
  buildDeepSeekEnvOverlay,
  buildKimiEnvOverlay,
  getEnabledProvidersInDefaultOrder,
  normalizeDeepSeekAnthropicBaseUrl,
  getEnabledProvidersFromRegistry,
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
    const claude = PROVIDERS.find(p => p.provider === 'claude');
    expect(claude).toBeDefined();
    expect(claude?.models).toEqual(['claude-fable-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']);
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

describe('zai (GLM/Z.AI) provider', () => {
  it('zai is in PROVIDERS with correct shape', () => {
    const zai = PROVIDERS.find(p => p.provider === 'zai');
    expect(zai).toBeDefined();
    expect(zai?.label).toBe('GLM/Z.AI');
    expect(zai?.open).toBe(true);
    expect(zai?.modelSuggestions).toContain('glm-5.2[1m]');
    expect(zai?.modelSuggestions).toContain('glm-4.7');
    expect(zai?.requiresKey).toBe('ALLEN_ZAI_API_KEY');
  });
});

describe('enabled provider registry', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of ['ALLEN_DEEPSEEK_API_KEY', 'ALLEN_XIAOMI_MIMO_API_KEY', 'ALLEN_KIMI_API_KEY', 'ALLEN_ZAI_API_KEY']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('hides Claude-compatible API providers without configured API keys', async () => {
    delete process.env.ALLEN_DEEPSEEK_API_KEY;
    delete process.env.ALLEN_XIAOMI_MIMO_API_KEY;
    delete process.env.ALLEN_KIMI_API_KEY;
    delete process.env.ALLEN_ZAI_API_KEY;

    const providers = await getEnabledProvidersInDefaultOrder();
    expect(providers.map((provider) => provider.provider)).toEqual(expect.arrayContaining(['codex', 'claude']));
    expect(providers.some((provider) => provider.provider === 'deepseek')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'xiaomi-mimo')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'kimi')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'zai')).toBe(false);
  });

  it('shows a Claude-compatible API provider when its key is configured', async () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'deepseek-key';
    delete process.env.ALLEN_XIAOMI_MIMO_API_KEY;
    delete process.env.ALLEN_KIMI_API_KEY;
    delete process.env.ALLEN_ZAI_API_KEY;

    const providers = await getEnabledProvidersInDefaultOrder();
    expect(providers.some((provider) => provider.provider === 'deepseek')).toBe(true);
    expect(providers.some((provider) => provider.provider === 'xiaomi-mimo')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'kimi')).toBe(false);
    expect(providers.some((provider) => provider.provider === 'zai')).toBe(false);
  });

  it('shows Kimi when its key is configured', async () => {
    delete process.env.ALLEN_DEEPSEEK_API_KEY;
    delete process.env.ALLEN_XIAOMI_MIMO_API_KEY;
    delete process.env.ALLEN_KIMI_API_KEY;
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
      'ALLEN_ZAI_API_KEY',
      'ALLEN_ZAI_BASE_URL',
      'ALLEN_ZAI_MODEL',
      'ALLEN_ZAI_OPUS_MODEL',
      'ALLEN_ZAI_FLASH_MODEL',
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

describe('Z.AI env overlay (via buildClaudeCompatibleEnvOverlay)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    resetRuntimeProvidersForTests();
    for (const key of [
      'ALLEN_ZAI_API_KEY',
      'ALLEN_ZAI_BASE_URL',
      'ALLEN_ZAI_MODEL',
      'ALLEN_ZAI_OPUS_MODEL',
      'ALLEN_ZAI_FLASH_MODEL',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    resetRuntimeProvidersForTests();
  });

  it('throws when ALLEN_ZAI_API_KEY is not set', async () => {
    delete process.env.ALLEN_ZAI_API_KEY;
    await expect(buildClaudeCompatibleEnvOverlay('zai')).rejects.toThrow('ALLEN_ZAI_API_KEY');
  });

  it('returns correct overlay env when key is set', async () => {
    process.env.ALLEN_ZAI_API_KEY = 'za-test-key';
    const overlay = await buildClaudeCompatibleEnvOverlay('zai');
    expect(overlay.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/anthropic');
    expect(overlay.ANTHROPIC_AUTH_TOKEN).toBe('za-test-key');
    expect(overlay.ANTHROPIC_MODEL).toBe('glm-5.2[1m]');
    expect(overlay.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2[1m]');
    expect(overlay.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]');
    expect(overlay.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.7');
    expect(overlay.CLAUDE_CODE_SUBAGENT_MODEL).toBe('glm-4.7');
    expect(overlay.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it('uses explicit model arg override', async () => {
    process.env.ALLEN_ZAI_API_KEY = 'za-test-key';
    const overlay = await buildClaudeCompatibleEnvOverlay('zai', 'glm-4.7');
    expect(overlay.ANTHROPIC_MODEL).toBe('glm-4.7');
  });

  it('ALLEN_ZAI_MODEL env override takes precedence over default', async () => {
    process.env.ALLEN_ZAI_API_KEY = 'za-test-key';
    process.env.ALLEN_ZAI_MODEL = 'glm-4.7-flash';
    const overlay = await buildClaudeCompatibleEnvOverlay('zai');
    expect(overlay.ANTHROPIC_MODEL).toBe('glm-4.7-flash');
  });

  it('ALLEN_ZAI_OPUS_MODEL env override takes precedence over defaultOpusModel', async () => {
    process.env.ALLEN_ZAI_API_KEY = 'za-test-key';
    process.env.ALLEN_ZAI_OPUS_MODEL = 'glm-5';
    const overlay = await buildClaudeCompatibleEnvOverlay('zai');
    expect(overlay.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5');
  });

  it('ALLEN_ZAI_FLASH_MODEL env override takes precedence over defaultFlashModel', async () => {
    process.env.ALLEN_ZAI_API_KEY = 'za-test-key';
    process.env.ALLEN_ZAI_FLASH_MODEL = 'glm-4.5-flash';
    const overlay = await buildClaudeCompatibleEnvOverlay('zai');
    expect(overlay.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-flash');
  });

  it('ALLEN_ZAI_BASE_URL override takes precedence over defaultBaseUrl', async () => {
    process.env.ALLEN_ZAI_API_KEY = 'za-test-key';
    process.env.ALLEN_ZAI_BASE_URL = 'https://custom.z.ai/anthropic';
    const overlay = await buildClaudeCompatibleEnvOverlay('zai');
    expect(overlay.ANTHROPIC_BASE_URL).toBe('https://custom.z.ai/anthropic');
  });

  it('is excluded from enabled providers when key is missing', async () => {
    delete process.env.ALLEN_ZAI_API_KEY;
    const providers = await getEnabledProvidersInDefaultOrder();
    expect(providers.some((p) => p.provider === 'zai')).toBe(false);
  });

  it('is included in enabled providers when key is present', async () => {
    process.env.ALLEN_ZAI_API_KEY = 'za-test-key';
    const providers = await getEnabledProvidersInDefaultOrder();
    expect(providers.some((p) => p.provider === 'zai')).toBe(true);
  });

  it('does not mutate process.env', async () => {
    process.env.ALLEN_ZAI_API_KEY = 'za-test-key';
    const beforeAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    await buildClaudeCompatibleEnvOverlay('zai');
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(beforeAuthToken);
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

// ── REQ-014: Registry-backed provider model patching ──

describe('getEnabledProvidersFromRegistry (REQ-014)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key';
    process.env.ALLEN_XIAOMI_MIMO_API_KEY = 'test-key';
    process.env.ALLEN_KIMI_API_KEY = 'test-key';
    process.env.ALLEN_ZAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    for (const key of [
      'ALLEN_DEEPSEEK_API_KEY', 'ALLEN_XIAOMI_MIMO_API_KEY', 'ALLEN_KIMI_API_KEY', 'ALLEN_ZAI_API_KEY',
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  function makeRegistryDb(records: Array<{ provider: string; fullId: string; sortOrder?: number; providerDisplayName?: string }> = []) {
    const store = records.map((r, i) => ({
      _id: `id-${i}`,
      provider: r.provider,
      fullId: r.fullId,
      providerDisplayName: r.providerDisplayName,
      isActive: true,
      sortOrder: r.sortOrder ?? i + 1,
    }));
    const queryable = () => {
      let results = [...store];
      return {
        sort: () => {
          results.sort((a, b) => a.sortOrder - b.sortOrder);
          return {
            project: () => ({
              toArray: async () => results.map((r) => ({ fullId: r.fullId, providerDisplayName: r.providerDisplayName })),
            }),
            toArray: async () => results.map((r) => ({ fullId: r.fullId, providerDisplayName: r.providerDisplayName })),
          };
        },
        toArray: async () => results.map((r) => ({ fullId: r.fullId, providerDisplayName: r.providerDisplayName })),
      };
    };
    return {
      collection: (name: string) => ({
        find: (query: Record<string, unknown>) => {
          let results = [...store];
          if (query.isActive === true) results = results.filter((r) => r.isActive);
          if (query.provider) results = results.filter((r) => r.provider === query.provider);
          results.sort((a, b) => a.sortOrder - b.sortOrder);
          return {
            sort: () => ({
              project: () => ({
                toArray: async () => results.map((r) => ({ fullId: r.fullId, providerDisplayName: r.providerDisplayName })),
              }),
              toArray: async () => results.map((r) => ({ fullId: r.fullId, providerDisplayName: r.providerDisplayName })),
            }),
            toArray: async () => results.map((r) => ({ fullId: r.fullId, providerDisplayName: r.providerDisplayName })),
          };
        },
        findOne: async () => null,
      }),
    } as any;
  }

  it('patches closed provider (codex) models from registry', async () => {
    const db = makeRegistryDb([
      { provider: 'codex', fullId: 'gpt-5.5', sortOrder: 1 },
      { provider: 'codex', fullId: 'gpt-5.4', sortOrder: 2 },
      { provider: 'codex', fullId: 'o3', sortOrder: 3 },
    ]);

    const providers = await getEnabledProvidersFromRegistry(db);
    const codex = providers.find((p) => p.provider === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.models).toEqual(['gpt-5.5', 'gpt-5.4', 'o3']);
  });

  it('patches open provider (deepseek) modelSuggestions from registry', async () => {
    const db = makeRegistryDb([
      { provider: 'deepseek', fullId: 'deepseek-v4-pro[1m]', sortOrder: 1 },
      { provider: 'deepseek', fullId: 'deepseek-v4-flash', sortOrder: 2 },
    ]);

    const providers = await getEnabledProvidersFromRegistry(db);
    const ds = providers.find((p) => p.provider === 'deepseek');
    expect(ds).toBeDefined();
    expect(ds!.modelSuggestions).toEqual(['deepseek-v4-pro[1m]', 'deepseek-v4-flash']);
  });

  it('falls back to static defaults when registry is empty', async () => {
    const db = makeRegistryDb([]);

    const providers = await getEnabledProvidersFromRegistry(db);
    const claude = providers.find((p) => p.provider === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.models).toEqual(['claude-fable-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-haiku-4-5-20251001']);
  });

  it('falls back to static defaults when registry query throws', async () => {
    const db = {
      collection: () => ({
        find: () => { throw new Error('DB unavailable'); },
      }),
    } as any;

    const providers = await getEnabledProvidersFromRegistry(db);
    const codex = providers.find((p) => p.provider === 'codex');
    expect(codex).toBeDefined();
    // Static fallback mirrors the model-registry seed list (SEED_MODELS).
    expect(codex!.models).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'gpt-5.1-codex-max',
      'gpt-5.2',
      'gpt-5.1-codex-mini',
      'o3',
      'o4-mini',
      'codex-mini',
    ]);
  });

  it('patches provider label from non-empty registry providerDisplayName', async () => {
    const db = makeRegistryDb([
      { provider: 'deepseek', fullId: 'deepseek-v4-flash', sortOrder: 1, providerDisplayName: '  My DeepSeek  ' },
    ]);

    const providers = await getEnabledProvidersFromRegistry(db);
    const ds = providers.find((p) => p.provider === 'deepseek');
    expect(ds).toBeDefined();
    // Label should be set from trimmed providerDisplayName.
    expect(ds!.label).toBe('My DeepSeek');
  });

  it('does not patch provider label from whitespace-only providerDisplayName', async () => {
    const db = makeRegistryDb([
      { provider: 'deepseek', fullId: 'deepseek-v4-flash', sortOrder: 1, providerDisplayName: '   ' },
    ]);

    const providers = await getEnabledProvidersFromRegistry(db);
    const ds = providers.find((p) => p.provider === 'deepseek');
    expect(ds).toBeDefined();
    // Static default label must survive when registry has only whitespace.
    expect(ds!.label).toBe('DeepSeek');
  });

  it('only returns enabled providers', async () => {
    delete process.env.ALLEN_KIMI_API_KEY;
    delete process.env.ALLEN_XIAOMI_MIMO_API_KEY;

    const db = makeRegistryDb([
      { provider: 'codex', alias: 'gpt-5.5' },
      { provider: 'kimi', alias: 'kimi-k2.6' },
    ]);

    const providers = await getEnabledProvidersFromRegistry(db);
    const providerNames = providers.map((p) => p.provider);
    expect(providerNames).toContain('codex');
    expect(providerNames).toContain('deepseek');
    expect(providerNames).not.toContain('kimi');
    expect(providerNames).not.toContain('xiaomi-mimo');
  });
});

// ── REQ-019: Tier resolution priority ──

describe('Tier resolution via buildClaudeCompatibleEnvOverlay (REQ-019)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of [
      'ALLEN_DEEPSEEK_API_KEY', 'ALLEN_DEEPSEEK_MODEL', 'ALLEN_DEEPSEEK_FLASH_MODEL',
      'ALLEN_KIMI_API_KEY',
    ]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  beforeEach(() => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key';
  });

  function makeRegistryWithModel(provider: string, tier: string, fullId: string) {
    return {
      collection: (name: string) => ({
        find: () => ({ toArray: async () => [], sort: () => ({ toArray: async () => [] }) }),
        findOne: async (_query: Record<string, unknown>) => {
          if (name === 'model_registry') {
            return { fullId, provider, tier, isActive: true, sortOrder: 1 };
          }
          return null;
        },
      }),
    } as any;
  }

  it('env override takes highest precedence for default model', async () => {
    process.env.ALLEN_DEEPSEEK_MODEL = 'deepseek-from-env';
    const db = makeRegistryWithModel('deepseek', 'default', 'deepseek-from-registry');

    const overlay = await buildClaudeCompatibleEnvOverlay('deepseek', undefined, db);
    expect(overlay.ANTHROPIC_MODEL).toBe('deepseek-from-env');
  });

  it('registry model is used when env override is absent (default tier)', async () => {
    delete process.env.ALLEN_DEEPSEEK_MODEL;
    const db = makeRegistryWithModel('deepseek', 'default', 'deepseek-from-registry');

    const overlay = await buildClaudeCompatibleEnvOverlay('deepseek', undefined, db);
    expect(overlay.ANTHROPIC_MODEL).toBe('deepseek-from-registry');
  });

  it('static default is used when neither env nor registry provide a value', async () => {
    delete process.env.ALLEN_DEEPSEEK_MODEL;
    const db = {
      collection: () => ({
        find: () => ({ toArray: async () => [], sort: () => ({ toArray: async () => [] }) }),
        findOne: async () => null,
      }),
    } as any;

    const overlay = await buildClaudeCompatibleEnvOverlay('deepseek', undefined, db);
    expect(overlay.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]');
  });

  it('flash tier resolves via registry when env override is absent', async () => {
    delete process.env.ALLEN_DEEPSEEK_FLASH_MODEL;
    const db = makeRegistryWithModel('deepseek', 'flash', 'deepseek-flash-from-registry');

    const overlay = await buildClaudeCompatibleEnvOverlay('deepseek', undefined, db);
    expect(overlay.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-flash-from-registry');
  });

  it('explicit model override takes highest precedence of all', async () => {
    const db = makeRegistryWithModel('deepseek', 'default', 'deepseek-from-registry');
    const overlay = await buildClaudeCompatibleEnvOverlay('deepseek', 'custom-model', db);
    expect(overlay.ANTHROPIC_MODEL).toBe('custom-model');
  });

  it('tier model env override works for Kimi opus model', async () => {
    process.env.ALLEN_KIMI_API_KEY = 'kimi-key';
    process.env.ALLEN_KIMI_OPUS_MODEL = 'kimi-opus-env';

    const db = makeRegistryWithModel('kimi', 'opus', 'kimi-opus-registry');

    const overlay = await buildClaudeCompatibleEnvOverlay('kimi', undefined, db);
    expect(overlay.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-opus-env');
    delete process.env.ALLEN_KIMI_API_KEY;
  });

  it('registry fallback works when db is undefined (backward compat)', async () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key';
    delete process.env.ALLEN_DEEPSEEK_MODEL;

    const overlay = await buildClaudeCompatibleEnvOverlay('deepseek', undefined, undefined);
    expect(overlay.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]');
  });
});
