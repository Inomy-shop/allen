import { describe, expect, it } from 'vitest';
import { renderHumanHistory, renderHumanResumePrompt, renderReviewFeedbackRetryPrompt } from './human-intervention.js';
import type { HumanEvent, HumanResumeInput } from './types.js';

describe('human intervention prompt rendering', () => {
  it('omits plain approvals from human history', () => {
    const humanInput: HumanResumeInput = {
      kind: 'review',
      sourceNode: 'implementation_approval_human',
      actionId: 'approve',
      decision: 'approve',
      route: { type: 'continue' },
      summary: 'The user approved the work.',
      fields: [
        {
          name: 'approval_decision',
          label: 'Approve this root cause and fix scope?',
          value: 'approve',
        },
      ],
      fieldsByName: {
        approval_decision: {
          name: 'approval_decision',
          label: 'Approve this root cause and fix scope?',
          value: 'approve',
        },
      },
      createdAt: '2026-05-27T00:00:00.000Z',
    };
    const event: HumanEvent = {
      kind: 'review',
      node: 'implementation_approval_human',
      actionId: 'approve',
      decision: 'approve',
      humanInput,
      values: { approval_decision: 'approve' },
      route: { type: 'continue' },
      createdAt: '2026-05-27T00:00:00.000Z',
    };

    const rendered = renderHumanHistory({ __human_events: [event] });

    expect(rendered).toBe('');
    expect(rendered).not.toContain('User provided:');
    expect(rendered).not.toContain('Approve this root cause and fix scope?');
  });

  it('omits plain approvals from direct human resume prompts', () => {
    const humanInput: HumanResumeInput = {
      kind: 'review',
      sourceNode: 'implementation_approval_human',
      actionId: 'approve',
      decision: 'approve',
      route: { type: 'continue' },
      summary: 'The user approved the work.',
      fields: [
        {
          name: 'approval_decision',
          label: 'Approve this root cause and fix scope?',
          value: 'approve',
        },
      ],
      fieldsByName: {
        approval_decision: {
          name: 'approval_decision',
          label: 'Approve this root cause and fix scope?',
          value: 'approve',
        },
      },
      createdAt: '2026-05-27T00:00:00.000Z',
    };

    expect(renderHumanResumePrompt(humanInput)).toBe('');
  });

  it('keeps feedback while omitting duplicate decision and feedback fields', () => {
    const humanInput: HumanResumeInput = {
      kind: 'review',
      sourceNode: 'implementation_approval_human',
      actionId: 'request_changes',
      decision: 'request_changes',
      route: { type: 'retry', targetNode: 'investigate' },
      summary: 'The user requested changes before the workflow continues.',
      fields: [
        {
          name: 'approval_decision',
          label: 'Approve this root cause and fix scope?',
          value: 'request_changes',
        },
        {
          name: 'approval_feedback',
          label: 'Feedback or reason',
          value: 'Check the header color requirement again.',
        },
      ],
      fieldsByName: {
        approval_decision: {
          name: 'approval_decision',
          label: 'Approve this root cause and fix scope?',
          value: 'request_changes',
        },
        approval_feedback: {
          name: 'approval_feedback',
          label: 'Feedback or reason',
          value: 'Check the header color requirement again.',
        },
      },
      feedback: {
        label: 'Review feedback',
        value: 'Check the header color requirement again.',
      },
      createdAt: '2026-05-27T00:00:00.000Z',
    };

    const rendered = renderHumanResumePrompt(humanInput);

    expect(rendered).toContain('Decision: request_changes');
    expect(rendered).toContain('Review feedback:');
    expect(rendered).toContain('Check the header color requirement again.');
    expect(rendered).not.toContain('User-provided fields:');
    expect(rendered).not.toContain('Approve this root cause and fix scope?');
  });

  it('renders review retry feedback without resume metadata or duplication', () => {
    const rendered = renderReviewFeedbackRetryPrompt({
      resumeContext: {
        type: 'node_feedback',
        sourceNode: 'implementation_approval_human',
        targetNode: 'investigate',
        nodeFeedback: {
          summary: 'Human requested investigation changes before implementation:\nNot just header , i want complete website backgroudn color to red',
          fields: [
            {
              name: 'approval_feedback',
              label: 'Approval Feedback',
              value: 'Not just header , i want complete website backgroudn color to red',
            },
          ],
        },
        createdAt: '2026-05-27T00:00:00.000Z',
      },
      retryContext: 'Human requested investigation changes before implementation:\nNot just header , i want complete website backgroudn color to red',
    });

    expect(rendered).toBe(`REVIEW FEEDBACK

Your previous output was reviewed and feedback was provided.
Use the feedback below to update your previous result and re-emit the required JSON output.

Feedback:
Not just header , i want complete website backgroudn color to red

Apply this as a targeted update. Do not redo analysis that is still valid.
Use whatever verification your node role requires before returning.`);
    expect(rendered).not.toContain('RESUME CONTEXT');
    expect(rendered).not.toContain('Source node');
    expect(rendered).not.toContain('rejected');
  });
});
