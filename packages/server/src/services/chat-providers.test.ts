import { describe, it, expect, vi, afterEach } from 'vitest';
import { PROVIDERS, buildDeepSeekEnvOverlay } from './chat-providers.js';

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

describe('buildDeepSeekEnvOverlay', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of ['ALLEN_DEEPSEEK_API_KEY', 'ALLEN_DEEPSEEK_BASE_URL', 'ALLEN_DEEPSEEK_MODEL',
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('throws when API key is missing', () => {
    delete process.env.ALLEN_DEEPSEEK_API_KEY;
    expect(() => buildDeepSeekEnvOverlay()).toThrow('ALLEN_DEEPSEEK_API_KEY');
  });

  it('returns correct overlay keys when API key is set', () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key-123';
    const overlay = buildDeepSeekEnvOverlay();
    expect(overlay.ANTHROPIC_AUTH_TOKEN).toBe('test-key-123');
    expect(overlay.ANTHROPIC_BASE_URL).toBeDefined();
    expect(overlay.ANTHROPIC_MODEL).toBeDefined();
    expect(overlay.CLAUDE_CODE_SUBAGENT_MODEL).toBeDefined();
  });

  it('does not mutate process.env', () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key-123';
    const beforeAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    buildDeepSeekEnvOverlay();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(beforeAuthToken); // unchanged
  });

  it('uses model override when provided', () => {
    process.env.ALLEN_DEEPSEEK_API_KEY = 'test-key-123';
    const overlay = buildDeepSeekEnvOverlay('deepseek-v4-flash');
    expect(overlay.ANTHROPIC_MODEL).toBe('deepseek-v4-flash');
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
