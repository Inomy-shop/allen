import { describe, it, expect } from 'vitest';
import {
  resolveAgentSettings,
  toClaudeSdkOptions,
  toCodexArgs,
  AgentSettingsValidationError,
  type AgentLike,
  type AgentOverrides,
} from './agent-settings.js';

const claudeAgent: AgentLike = {
  name: 'coder',
  provider: 'claude-cli',
  model: 'sonnet',
  reasoningEffort: 'medium',
  planMode: false,
};

const opusAgent: AgentLike = {
  name: 'planner',
  provider: 'claude-cli',
  model: 'claude-opus-4-6',
  reasoningEffort: 'high',
  planMode: true,
};

const codexAgent: AgentLike = {
  name: 'codex-dev',
  provider: 'codex',
  model: 'gpt-5-codex',
  reasoningEffort: 'medium',
};

describe('resolveAgentSettings — precedence', () => {
  it('agent-only: returns agent defaults', () => {
    const r = resolveAgentSettings(claudeAgent);
    expect(r.provider).toBe('claude-cli');
    expect(r.model).toBe('sonnet');
    expect(r.reasoningEffort).toBe('medium');
    expect(r.planMode).toBe(false);
  });

  it('session override wins over agent default', () => {
    const sessionOverride: AgentOverrides = { model: 'haiku', reasoningEffort: 'low' };
    const r = resolveAgentSettings(claudeAgent, [undefined, sessionOverride]);
    expect(r.model).toBe('haiku');
    expect(r.reasoningEffort).toBe('low');
  });

  it('node override wins over session override', () => {
    const nodeOverride: AgentOverrides = { reasoningEffort: 'high' };
    const sessionOverride: AgentOverrides = { reasoningEffort: 'low' };
    const r = resolveAgentSettings(claudeAgent, [nodeOverride, sessionOverride]);
    expect(r.reasoningEffort).toBe('high');
  });

  it('node and session override different fields — both apply', () => {
    const nodeOverride: AgentOverrides = { reasoningEffort: 'high' };
    const sessionOverride: AgentOverrides = { model: 'opus' };
    const r = resolveAgentSettings(opusAgent, [nodeOverride, sessionOverride]);
    expect(r.reasoningEffort).toBe('high');
    expect(r.model).toBe('opus'); // session model wins since agent is opus too
  });

  it('null in override layer means "inherit parent"', () => {
    const sessionOverride: AgentOverrides = { reasoningEffort: null };
    const r = resolveAgentSettings(claudeAgent, [undefined, sessionOverride]);
    expect(r.reasoningEffort).toBe('medium'); // agent default
  });

  it('undefined in override layer also means "inherit parent"', () => {
    const sessionOverride: AgentOverrides = { reasoningEffort: undefined };
    const r = resolveAgentSettings(claudeAgent, [undefined, sessionOverride]);
    expect(r.reasoningEffort).toBe('medium');
  });

  it('explicit "off" in override disables effort even when agent has it', () => {
    const override: AgentOverrides = { reasoningEffort: 'off' };
    const r = resolveAgentSettings(claudeAgent, [override]);
    expect(r.reasoningEffort).toBe('off');
  });
});

describe('resolveAgentSettings — validation', () => {
  it('rejects planMode=true on Codex', () => {
    expect(() =>
      resolveAgentSettings(codexAgent, [{ planMode: true }]),
    ).toThrow(AgentSettingsValidationError);
  });

  it('validation error includes the code', () => {
    try {
      resolveAgentSettings(codexAgent, [{ planMode: true }]);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentSettingsValidationError);
      expect((err as AgentSettingsValidationError).code).toBe('plan_mode_claude_only');
    }
  });

  it('rejects effort="max" on Codex', () => {
    expect(() =>
      resolveAgentSettings(codexAgent, [{ reasoningEffort: 'max' }]),
    ).toThrow(/max.*only.*Claude/i);
  });

  it('rejects effort="max" on non-Opus Claude model', () => {
    expect(() =>
      resolveAgentSettings(claudeAgent, [{ reasoningEffort: 'max' }]),
    ).toThrow(/max.*requires.*Opus/i);
  });

  it('accepts effort="max" on Opus', () => {
    const r = resolveAgentSettings(opusAgent, [{ reasoningEffort: 'max' }]);
    expect(r.reasoningEffort).toBe('max');
  });

  it('agent with planMode=true default and Codex provider still throws', () => {
    const bad: AgentLike = { name: 'x', provider: 'codex', model: 'gpt-5', planMode: true };
    expect(() => resolveAgentSettings(bad)).toThrow(AgentSettingsValidationError);
  });
});

describe('resolveAgentSettings — non-mutation invariant', () => {
  it('does NOT mutate the agent document', () => {
    const agent: AgentLike = {
      name: 'coder',
      provider: 'claude-cli',
      model: 'sonnet',
      reasoningEffort: 'medium',
      planMode: false,
    };
    const before = JSON.parse(JSON.stringify(agent));
    resolveAgentSettings(agent, [{ reasoningEffort: 'high', planMode: true, model: 'opus' }]);
    expect(agent).toEqual(before);
  });

  it('does NOT mutate the override layers', () => {
    const node: AgentOverrides = { reasoningEffort: 'high' };
    const session: AgentOverrides = { model: 'opus' };
    const beforeN = JSON.parse(JSON.stringify(node));
    const beforeS = JSON.parse(JSON.stringify(session));
    resolveAgentSettings(opusAgent, [node, session]);
    expect(node).toEqual(beforeN);
    expect(session).toEqual(beforeS);
  });
});

describe('toClaudeSdkOptions', () => {
  it('emits promptPrefix "think hard" for high and permissionMode "plan"', () => {
    const r = resolveAgentSettings(opusAgent);
    const opts = toClaudeSdkOptions(r);
    // SDK has no native effort — we inject the Anthropic-documented keyword.
    // opusAgent fixture has reasoningEffort='high', which maps to "think hard".
    expect(opts.promptPrefix).toBe('think hard');
    expect(opts.permissionMode).toBe('plan');
    expect(opts.model).toBe('claude-opus-4-6');
  });

  it('emits "ultrathink" for effort=max', () => {
    const r = resolveAgentSettings({ ...opusAgent, reasoningEffort: 'max' });
    const opts = toClaudeSdkOptions(r);
    expect(opts.promptPrefix).toBe('ultrathink');
  });

  it('omits promptPrefix when effort is "off"', () => {
    const r = resolveAgentSettings({ ...claudeAgent, reasoningEffort: 'off' });
    const opts = toClaudeSdkOptions(r);
    expect(opts.promptPrefix).toBeUndefined();
  });

  it('omits promptPrefix when effort is "low" (CLI default is already low)', () => {
    const r = resolveAgentSettings({ ...claudeAgent, reasoningEffort: 'low' });
    const opts = toClaudeSdkOptions(r);
    expect(opts.promptPrefix).toBeUndefined();
  });

  it('omits promptPrefix when effort is unset', () => {
    const r = resolveAgentSettings({ ...claudeAgent, reasoningEffort: undefined });
    const opts = toClaudeSdkOptions(r);
    expect(opts.promptPrefix).toBeUndefined();
  });

  it('omits permissionMode when planMode is false', () => {
    const r = resolveAgentSettings(claudeAgent);
    const opts = toClaudeSdkOptions(r);
    expect(opts.permissionMode).toBeUndefined();
  });

  it('omits model when agent has no model', () => {
    const r = resolveAgentSettings({ name: 'x', provider: 'claude-cli' });
    const opts = toClaudeSdkOptions(r);
    expect(opts.model).toBeUndefined();
  });

  it('maps effort levels to the right trigger keywords', () => {
    const cases: Array<[typeof opusAgent.reasoningEffort, string | undefined]> = [
      ['off', undefined],
      ['low', undefined],
      ['medium', 'think'],
      ['high', 'think hard'],
      ['max', 'ultrathink'],
    ];
    for (const [effort, expected] of cases) {
      const opts = toClaudeSdkOptions(resolveAgentSettings({ ...opusAgent, reasoningEffort: effort }));
      expect(opts.promptPrefix).toBe(expected);
    }
  });
});

describe('toCodexArgs', () => {
  it('emits model and reasoning_effort config flags', () => {
    const r = resolveAgentSettings(codexAgent);
    const args = toCodexArgs(r);
    expect(args).toContain('model="gpt-5-codex"');
    expect(args).toContain('model_reasoning_effort="medium"');
  });

  it('omits effort when "off"', () => {
    const r = resolveAgentSettings({ ...codexAgent, reasoningEffort: 'off' });
    const args = toCodexArgs(r);
    expect(args.find((a) => a.includes('model_reasoning_effort'))).toBeUndefined();
  });

  it('omits effort when unset', () => {
    const r = resolveAgentSettings({ ...codexAgent, reasoningEffort: undefined });
    const args = toCodexArgs(r);
    expect(args.find((a) => a.includes('model_reasoning_effort'))).toBeUndefined();
  });

  it('does not emit model arg when model is "default"', () => {
    const r = resolveAgentSettings({ ...codexAgent, model: 'default' });
    const args = toCodexArgs(r);
    expect(args.find((a) => a.startsWith('model='))).toBeUndefined();
  });
});
