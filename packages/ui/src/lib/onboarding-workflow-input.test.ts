import { describe, expect, it } from 'vitest';
import { buildOnboardingBugFixInput, buildOnboardingWorkflowInput } from './onboarding-workflow-input';

describe('buildOnboardingBugFixInput', () => {
  it('passes only the latest bug-fix-by-severity input fields declared by schema', () => {
    const input = buildOnboardingBugFixInput(
      {
        parsed: {
          input: {
            bug_report: { type: 'string', required: true },
            repo_path: { type: 'string', required: true },
            chat_session_id: { type: 'string', required: false },
            started_by_user_id: { type: 'string', required: false },
          },
        },
      },
      {
        bugReport: '  Fix the readiness widget at exactly 50.  ',
        repoPath: '  /tmp/test-website  ',
      },
    );

    expect(input).toEqual({
      bug_report: 'Fix the readiness widget at exactly 50.',
      repo_path: '/tmp/test-website',
    });
    expect(input).not.toHaveProperty('related_pr');
  });

  it('falls back to required onboarding fields if workflow schema is unavailable', () => {
    expect(buildOnboardingBugFixInput(null, {
      bugReport: 'Fix it',
      repoPath: '/repo',
    })).toEqual({
      bug_report: 'Fix it',
      repo_path: '/repo',
    });
  });

  it('builds feature-plan-and-implement payload with user_request and repo_path', () => {
    const input = buildOnboardingWorkflowInput(
      {
        parsed: {
          input: {
            user_request: { type: 'string', required: true },
            repo_path: { type: 'string', required: true },
            trusted_mode: { type: 'boolean', required: false },
            skip_regression: { type: 'boolean', required: false },
            chat_session_id: { type: 'string', required: false },
            started_by_user_id: { type: 'string', required: false },
          },
        },
      },
      {
        taskType: 'feature',
        request: '  Add dark mode.  ',
        repoPath: '  /tmp/test-website  ',
      },
    );

    expect(input).toEqual({
      user_request: 'Add dark mode.',
      repo_path: '/tmp/test-website',
      trusted_mode: false,
      skip_regression: false,
    });
    expect(input).not.toHaveProperty('bug_report');
  });
});
