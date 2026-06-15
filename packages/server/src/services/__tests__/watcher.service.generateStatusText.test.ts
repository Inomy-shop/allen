import { describe, expect, it } from 'vitest';
import { generateStatusText, type StatusTextInput } from '../watcher.service.js';

describe('generateStatusText', () => {
  const baseInput: StatusTextInput = {
    execStatus: 'running',
    lastCheckedAt: new Date(),
  };

  it('returns completed text when status is completed', () => {
    const result = generateStatusText({ ...baseInput, execStatus: 'completed', workflowName: 'my-workflow' });
    expect(result).toContain('my-workflow completed');
    expect(result).toContain('Last checked');
  });

  it('returns agent completed text when status is completed (no workflowName)', () => {
    const result = generateStatusText({ ...baseInput, execStatus: 'completed', agentDisplayName: 'Backend Developer' });
    expect(result).toContain('Backend Developer completed');
  });

  it('returns failed text when status is failed', () => {
    const result = generateStatusText({ ...baseInput, execStatus: 'failed', workflowName: 'bug-fix-by-severity' });
    expect(result).toContain('bug-fix-by-severity failed');
  });

  it('returns cancelled text when status is cancelled', () => {
    const result = generateStatusText({ ...baseInput, execStatus: 'cancelled', agentDisplayName: 'Frontend Developer' });
    expect(result).toContain('Frontend Developer cancelled');
  });

  it('returns waiting for input text', () => {
    const result = generateStatusText({ ...baseInput, execStatus: 'waiting_for_input', workflowName: 'feature-plan' });
    expect(result).toContain('feature-plan is waiting for input');
  });

  it('returns milestone-enhanced text when log contains known milestone', () => {
    const result = generateStatusText({
      ...baseInput,
      execStatus: 'running',
      workflowName: 'feature-plan-and-implement',
      recentLogs: [
        { message: 'qa_completed', node: 'qa', type: 'milestone' },
        { message: 'moving to code review', node: 'review', type: 'log' },
      ],
    });
    expect(result).toContain('feature-plan-and-implement');
    expect(result).toContain('Qa completed');
  });

  it('returns milestone-enhanced text when node name matches milestone', () => {
    const result = generateStatusText({
      ...baseInput,
      execStatus: 'running',
      workflowName: 'feature-plan-and-implement',
      recentLogs: [
        { message: 'starting review_completed', node: 'review_completed', type: 'log' },
      ],
    });
    // "review_completed" matches the milestone
    expect(result).toContain('Review completed');
  });

  it('does NOT claim completed when status is running (R8 guard)', () => {
    const result = generateStatusText({
      ...baseInput,
      execStatus: 'running',
      workflowName: 'my-workflow',
    });
    expect(result).not.toContain('completed');
    expect(result).not.toContain('Completed');
    expect(result).toContain('running');
  });

  it('shows workflow progress with current and completed nodes', () => {
    const result = generateStatusText({
      ...baseInput,
      execStatus: 'running',
      workflowName: 'feature-plan-and-implement',
      currentNodes: ['audit_tdd'],
      completedNodes: ['produce_tdd'],
    });
    expect(result).toContain('completed produce_tdd');
    expect(result).toContain('now running audit_tdd');
  });

  it('shows child agent completed for lead/agent', () => {
    const result = generateStatusText({
      ...baseInput,
      execStatus: 'running',
      agentDisplayName: 'Engineering Lead',
      childExecs: [
        { status: 'completed', agentName: 'backend-dev', displayName: 'Backend Developer' },
      ],
    });
    expect(result).toContain('Engineering Lead is running');
    expect(result).toContain('Backend Developer completed');
  });

  it('shows agent activity from recent logs', () => {
    const result = generateStatusText({
      ...baseInput,
      execStatus: 'running',
      agentDisplayName: 'Frontend Developer',
      currentNodes: ['Frontend Developer'],
      recentLogs: [
        { message: 'inspected a product card component', node: 'Frontend Developer', type: 'text' },
      ],
    });
    expect(result).toContain('Frontend Developer is');
    expect(result).toContain('inspected a product card component');
  });

  it('provides generic fallback for unknown status', () => {
    const result = generateStatusText({
      ...baseInput,
      execStatus: 'queued',
      workflowName: 'my-workflow',
    });
    expect(result).toContain('my-workflow');
    expect(result).toContain('queued');
  });

  it('includes "Last checked" in output', () => {
    const result = generateStatusText({ ...baseInput, execStatus: 'running', workflowName: 'test' });
    expect(result).toMatch(/Last checked/);
  });

  it('handles no workflowName or agentDisplayName gracefully', () => {
    const result = generateStatusText({ ...baseInput, execStatus: 'completed' });
    expect(result).toContain('completed');
  });
});
