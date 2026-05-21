import { describe, expect, it } from 'vitest';
import {
  buildContextQueryIntent,
  contextQueryIntentHash,
  renderedContextQueryHash,
  renderContextQuery,
} from '../../../../src/services/context/core/context-query-intent.js';
import type { KnowledgeRetrievalInput } from '../../../../src/services/context/core/repo-context-engine.js';

describe('context query intent', () => {
  it('extracts deterministic node query signals from structured state, prompt sections, and paths', () => {
    const input: KnowledgeRetrievalInput = {
      repoId: 'repo-id',
      repoName: 'fixture',
      repoPath: '/tmp/fixture',
      indexId: 'index-1',
      indexFreshness: 'fresh',
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      nodeRole: 'bug-investigator',
      attempt: 1,
      state: {
        changedFiles: ['packages/server/src/services/context/core/repo-context-engine.ts'],
        expectedOutput: 'root cause report',
        bug_summary: 'Context eval shows queued after completion.',
      },
      prompt: [
        'user request: Check why the UI keeps showing queued context evaluation results.',
        'BUG REPORT: Context eval completed but inspector does not show semantic results.',
        'Expected behavior: completed semantic results are visible.',
        'Required investigation path: packages/server/src/services/context/evaluation/context-evaluation-service.ts',
      ].join('\n'),
      provider: 'claude',
      currentFiles: [
        'packages/server/src/services/context/core/repo-context-engine.ts',
        'investigation/old-artifact.md',
      ],
      nodes: [],
    };

    const intent = buildContextQueryIntent(input);
    const query = renderContextQuery(intent);

    expect(intent).toEqual(expect.objectContaining({
      workflowName: 'bug-investigate-and-fix',
      nodeName: 'investigate',
      role: 'bug-investigator',
      roleFamily: 'investigation',
      currentFiles: ['packages/server/src/services/context/core/repo-context-engine.ts'],
      requiredCategories: expect.arrayContaining(['source', 'runbook', 'guideline']),
      preferredCategories: expect.arrayContaining(['design']),
      exclusionCategories: expect.arrayContaining(['agent_persona', 'generated_doc']),
      querySignalSources: expect.arrayContaining(['state.changed_files', 'state.bug_summary', 'prompt.sections']),
      querySignalSections: expect.arrayContaining(['USER REQUEST', 'BUG REPORT', 'Expected behavior', 'Required investigation path']),
    }));
    expect(query).toContain('Role family: investigation');
    expect(query).toContain('Task signal: Changed files: packages/server/src/services/context/core/repo-context-engine.ts');
    expect(query).toContain('Required investigation path: packages/server/src/services/context/evaluation/context-evaluation-service.ts');
    expect(query).toContain('USER REQUEST: Check why the UI keeps showing queued context evaluation results.');
    expect(contextQueryIntentHash(intent)).toBe(contextQueryIntentHash(buildContextQueryIntent(input)));
    expect(renderedContextQueryHash(query)).toMatch(/^[a-f0-9]{64}$/);
  });
});
