const CLAUDE_CHAT_DISALLOWED_NATIVE_TOOLS = ['AskUserQuestion'] as const;

export function applyClaudeChatNativeToolPolicyToArgs(args: string[]): void {
  args.push('--disallowed-tools', ...CLAUDE_CHAT_DISALLOWED_NATIVE_TOOLS);
}

export function applyClaudeChatNativeToolPolicyToSdkOptions(options: Record<string, unknown>): void {
  const existing = Array.isArray(options.disallowedTools)
    ? options.disallowedTools.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0)
    : [];
  const merged = new Set([...existing, ...CLAUDE_CHAT_DISALLOWED_NATIVE_TOOLS]);
  options.disallowedTools = Array.from(merged);
}
