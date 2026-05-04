import { describe, it, expect, vi } from 'vitest';

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