import { describe, expect, it } from 'vitest';
import { buildContextQueryIntent, renderContextQuery, renderSemanticContextQuery } from './context-query-intent.js';
import type { KnowledgeRetrievalInput } from './repo-context-engine.js';

function input(overrides: Partial<KnowledgeRetrievalInput> = {}): KnowledgeRetrievalInput {
  return {
    repoId: 'repo1',
    repoName: 'repo',
    repoPath: '/tmp/repo',
    indexId: 'idx',
    indexFreshness: 'fresh',
    workflowName: 'workflow',
    nodeName: 'worker',
    nodeRole: 'billing-specialist',
    attempt: 1,
    state: {},
    prompt: 'Fix an issue in the checkout flow.',
    provider: 'codex',
    currentFiles: [],
    nodes: [],
    ...overrides,
  };
}

describe('context query intent agent role signals', () => {
  it('adds the user prompt and resolved DB agent metadata to query signals', () => {
    const intent = buildContextQueryIntent(input({
      agentRoleSignals: [{
        roleSlot: 'targetRole',
        roleName: 'billing-specialist',
        agentName: 'billing-specialist',
        provider: 'codex',
        teamName: 'payments',
        description: 'Owns Stripe billing API and checkout backend failures.',
        tags: ['stripe', 'payments', 'backend'],
        instructionSummary: 'Prioritize billing API source files and payment runbooks.',
        signalText: 'name billing-specialist | description Owns Stripe billing API and checkout backend failures. | tags stripe, payments, backend | instructions Prioritize billing API source files and payment runbooks.',
      }],
    }));

    expect(intent.agentRoleSignals?.[0]?.agentName).toBe('billing-specialist');
    expect(intent.querySignalSources).toContain('agent.targetRole');
    expect(intent.userPromptSignal).toBe('Fix an issue in the checkout flow.');
    expect(intent.task).toContain('User request: Fix an issue in the checkout flow.');
    expect(intent.agentRoleSignals?.[0]?.signalText).toContain('Stripe billing API');
    expect(intent.requiredCategories).toContain('source');
    expect(intent.preferredCategories).toContain('runbook');
  });

  it('does not replace the user prompt with agent metadata in the rendered query', () => {
    const prompt = 'I want to update product grouping module with asin based variant grouping';
    const intent = buildContextQueryIntent(input({
      nodeRole: 'data-acquisition',
      nodeName: 'data-acquisition',
      prompt,
      agentRoleSignals: [{
        roleSlot: 'nodeRole',
        roleName: 'data-acquisition',
        agentName: 'data-acquisition',
        teamName: 'data-acquisition',
        teamRole: 'lead',
        description: 'Team orchestrator for Data Acquisition. Domain layer responsible for web scraping, vendor onboarding, scraping rule management, search query optimization, vendor category mapping, and raw data collection.',
        signalText: 'name data-acquisition | description Team orchestrator for Data Acquisition. Domain layer responsible for web scraping, vendor onboarding, scraping rule management, search query optimization, vendor category mapping, and raw data collection. Owns Stages 1-2 of the pipeline.',
      }],
    }));
    const rendered = renderContextQuery(intent);

    expect(intent.userPromptSignal).toBe(prompt);
    expect(intent.roleFamily).toBe('implementation');
    expect(intent.task).toContain(`User request: ${prompt}`);
    expect(intent.requiredCategories).toContain('source');
    expect(intent.requiredCategories).not.toContain('prd');
    expect(rendered).toContain(`User request: ${prompt}`);
    expect(rendered).not.toContain('Agent role signals:');
    expect(rendered).not.toContain('Team orchestrator for Data Acquisition');
    expect(intent.task).not.toContain('nodeRole agent context');
    expect(intent.querySignalSources).toContain('prompt.user_request');
    expect(intent.querySignalSources).toContain('agent.nodeRole');
  });

  it('uses explicit context_query instead of noisy spawned-agent instructions', () => {
    const contextQuery = {
      user_request: 'Update product grouping with ASIN based variant grouping',
      task_type: 'implementation',
      requirements: ['Support parent/child ASIN grouping', 'Update product grouping module', 'No file edits', 'No commits', 'Save your analysis as an Allen artifact'],
      topics: ['product grouping', 'asin variants'],
      target_files: ['src/product/grouping.ts', 'src/shared/product-grouping/'],
      path_hints: ['src/product'],
      required_categories: ['source_code', 'repo_backed', 'tests'],
      preferred_categories: ['prd', 'design', 'docs'],
    };
    const intent = buildContextQueryIntent(input({
      prompt: 'Operational instructions: run tests, save artifacts, follow process.',
      contextQuery,
    }));
    const rendered = renderContextQuery(intent);
    const semantic = renderSemanticContextQuery(intent);

    expect(intent.querySignalSources).toEqual(['context_query']);
    expect(intent.userPromptSignal).toBe(contextQuery.user_request);
    expect(intent.task).toContain('ASIN grouping');
    expect(intent.task).not.toContain('No file edits');
    expect(intent.task).not.toContain('No commits');
    expect(intent.task).not.toContain('Save your analysis');
    expect(intent.task).not.toContain('Operational instructions');
    expect(intent.ignoredExecutionConstraints).toEqual(['No file edits', 'No commits', 'Save your analysis as an Allen artifact']);
    expect(intent.currentFiles).toContain('src/product/grouping.ts');
    expect(intent.currentFiles).not.toContain('src/shared/product-grouping/');
    expect(intent.pathScopes).toContain('src/shared/product-grouping');
    expect(intent.pathHints).toContain('src/product');
    expect(intent.requiredCategories).toContain('source');
    expect(intent.requiredCategories).not.toContain('source_code');
    expect(intent.domainHints).toContain('tests');
    expect(intent.groundingPreferences).toContain('repo_backed');
    expect(intent.preferredCategories).toContain('prd');
    expect(intent.preferredCategories).toContain('doc');
    expect(intent.categoryDiagnostics?.some((item) => item.code === 'category_as_domain_hint' && item.category === 'tests')).toBe(true);
    expect(rendered).toContain(`User request: ${contextQuery.user_request}`);
    expect(rendered).toContain('Retrieval signals:');
    expect(rendered).not.toContain('Task signal:');
    expect(rendered).not.toContain('No file edits');
    expect(semantic).toContain(`User request: ${contextQuery.user_request}`);
    expect(semantic).toContain('ASIN grouping');
    expect(semantic).not.toContain('src/product/grouping.ts');
    expect(semantic).not.toContain('src/shared/product-grouping');
    expect(semantic).not.toContain('Path hints:');
  });

  it('maps repo category aliases and keeps domain labels out of categories', () => {
    const intent = buildContextQueryIntent(input({
      contextQuery: {
        user_request: 'Analyze product grouping ASIN variants',
        required_categories: ['repo_code', 'repo_docs'],
        preferred_categories: ['product_grouping', 'data_transformer', 'api_preview'],
      },
    }));
    const semantic = renderSemanticContextQuery(intent);

    expect(intent.requiredCategories).toContain('source');
    expect(intent.requiredCategories).toContain('doc');
    expect(intent.domainHints).toEqual(['product_grouping', 'data_transformer', 'api_preview']);
    expect(semantic).toContain('Domain hints: product_grouping, data_transformer, api_preview');
  });

  it('does not parse inline allen_context_query blocks as retrieval metadata', () => {
    const prompt = '<allen_context_query>{"user_request":"hidden"}</allen_context_query>\nFix checkout retries.';
    const intent = buildContextQueryIntent(input({ prompt }));

    expect(intent.querySignalSources).toContain('prompt.user_request');
    expect(intent.task).toContain('Fix checkout retries');
    expect(intent.task).toContain('allen_context_query');
  });
});
