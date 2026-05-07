import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlackService } from './slack.service.js';

describe('SlackService provider defaults', () => {
  const originalEffort = process.env.ALLEN_SLACK_REASONING_EFFORT;
  const originalProvider = process.env.ALLEN_SLACK_DEFAULT_PROVIDER;
  const originalModel = process.env.ALLEN_SLACK_DEFAULT_MODEL;

  beforeEach(() => {
    delete process.env.ALLEN_SLACK_REASONING_EFFORT;
    delete process.env.ALLEN_SLACK_DEFAULT_PROVIDER;
    delete process.env.ALLEN_SLACK_DEFAULT_MODEL;
  });

  afterEach(() => {
    if (originalEffort === undefined) delete process.env.ALLEN_SLACK_REASONING_EFFORT;
    else process.env.ALLEN_SLACK_REASONING_EFFORT = originalEffort;
    if (originalProvider === undefined) delete process.env.ALLEN_SLACK_DEFAULT_PROVIDER;
    else process.env.ALLEN_SLACK_DEFAULT_PROVIDER = originalProvider;
    if (originalModel === undefined) delete process.env.ALLEN_SLACK_DEFAULT_MODEL;
    else process.env.ALLEN_SLACK_DEFAULT_MODEL = originalModel;
  });

  it('always starts Slack sessions on Codex 5.5, even if text asks for Claude', () => {
    const service = new SlackService({} as any) as any;

    const defaults = service.resolveSlackDefaults('please use claude for this');

    expect(defaults).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    });
  });
});
