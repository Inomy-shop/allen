import { describe, expect, it } from 'vitest';
import {
  applyClaudeChatNativeToolPolicyToArgs,
  applyClaudeChatNativeToolPolicyToSdkOptions,
} from './claude-chat-tool-policy.js';

describe('Claude chat native tool policy', () => {
  it('disallows Claude built-in AskUserQuestion for CLI chat runs', () => {
    const args = ['-p', '--output-format', 'stream-json'];

    applyClaudeChatNativeToolPolicyToArgs(args);

    expect(args).toContain('--disallowed-tools');
    expect(args).toContain('AskUserQuestion');
  });

  it('disallows Claude built-in AskUserQuestion for SDK chat runs', () => {
    const options: Record<string, unknown> = { model: 'claude-sonnet-4-6' };

    applyClaudeChatNativeToolPolicyToSdkOptions(options);

    expect(options.disallowedTools).toEqual(['AskUserQuestion']);
  });

  it('preserves existing SDK disallowed tools', () => {
    const options: Record<string, unknown> = { disallowedTools: ['Bash(git push *)'] };

    applyClaudeChatNativeToolPolicyToSdkOptions(options);

    expect(options.disallowedTools).toEqual(['Bash(git push *)', 'AskUserQuestion']);
  });
});
