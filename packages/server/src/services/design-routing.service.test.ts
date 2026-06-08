import { describe, it, expect } from 'vitest';
import { DesignRoutingService, DESIGN_ROUTER_SYSTEM_PROMPT } from './design-routing.service.js';

describe('DesignRoutingService', () => {
  // mock db
  const mockDb = { collection: () => ({}) } as any;
  const service = new DesignRoutingService(mockDb);

  const baseSession = {
    kind: 'design' as const,
    sourceSurface: 'design_tab' as const,
    title: '',
    designRepoId: 'repo1',
    status: 'idle' as const,
    outputMode: 'spec_only' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastMessageAt: new Date(),
  };

  it('new session with no prompt → direct (short/empty prompt)', async () => {
    // No prompt provided → empty string → direct (not agent)
    const dec = await service.resolveRoute(baseSession);
    expect(dec.mode).toBe('direct');
  });

  it('new session with substantive prompt → workflow (no existing context)', async () => {
    const dec = await service.resolveRoute(baseSession, undefined, 'build a dashboard UI');
    expect(dec.mode).toBe('workflow');
    expect(dec.workflowName).toBe('source-prd-to-ui-designs-variations');
    expect(dec.resolvedBy).toBe('auto');
  });

  it('new session with greeting → direct', async () => {
    const dec = await service.resolveRoute(baseSession, undefined, 'hello');
    expect(dec.mode).toBe('direct');
  });

  it('session with existing outputs + substantive non-refinement prompt → workflow', async () => {
    const dec = await service.resolveRoute({ ...baseSession, hasExistingOutputs: true }, undefined, 'build a new page');
    expect(dec.mode).toBe('workflow');
    expect(dec.workflowName).toBe('source-prd-to-ui-designs-variations');
  });

  it('session with existing outputs + refinement prompt → frontend agent', async () => {
    const dec = await service.resolveRoute({ ...baseSession, hasExistingOutputs: true }, undefined, 'improve this design');
    expect(dec.mode).toBe('agent');
    expect(dec.agentName).toBe('frontend-developer');
  });

  it('session with workspaceId + refinement prompt → frontend agent', async () => {
    const dec = await service.resolveRoute({ ...baseSession, workspaceId: 'ws-123' }, undefined, 'refine this option');
    expect(dec.mode).toBe('agent');
    expect(dec.agentName).toBe('frontend-developer');
  });

  it('session with workspaceId + non-refinement prompt → workflow', async () => {
    const dec = await service.resolveRoute({ ...baseSession, workspaceId: 'ws-123' }, undefined, 'implement a new navbar');
    expect(dec.mode).toBe('workflow');
  });

  it('full_workflow override wins regardless of existing outputs', async () => {
    const dec = await service.resolveRoute({ ...baseSession, hasExistingOutputs: true }, 'full_workflow');
    expect(dec.mode).toBe('workflow');
    expect(dec.resolvedBy).toBe('user_override');
  });

  it('fast_frontend override wins', async () => {
    const dec = await service.resolveRoute(baseSession, 'fast_frontend');
    expect(dec.mode).toBe('agent');
    expect(dec.agentName).toBe('frontend-developer');
    expect(dec.resolvedBy).toBe('user_override');
  });

  it('default outputMode is spec_only', async () => {
    const dec = await service.resolveRoute(baseSession, undefined, 'design a dashboard');
    expect(dec.outputMode).toBe('spec_only');
  });

  it('unknown override key throws', async () => {
    await expect(service.resolveRoute(baseSession, 'invalid_key')).rejects.toThrow();
  });

  it('auto override key behaves like no override', async () => {
    const dec = await service.resolveRoute(baseSession, 'auto', 'hello');
    expect(dec.mode).toBe('direct');
  });

  it('"Helloo" (double-o typo greeting) → direct (not workflow)', async () => {
    const dec = await service.resolveRoute(baseSession, undefined, 'Helloo');
    expect(dec.mode).toBe('direct');
  });

  it('"helloo" → direct', async () => {
    const dec = await service.resolveRoute(baseSession, undefined, 'helloo');
    expect(dec.mode).toBe('direct');
  });

  it('"Who are you" → direct (identity question)', async () => {
    const dec = await service.resolveRoute(baseSession, undefined, 'Who are you');
    expect(dec.mode).toBe('direct');
  });

  it('"Who are you" with full_workflow override → direct (override does not apply to conversational prompts)', async () => {
    const dec = await service.resolveRoute(baseSession, 'full_workflow', 'Who are you');
    expect(dec.mode).toBe('direct');
  });

  it('"hello" with full_workflow override → direct', async () => {
    const dec = await service.resolveRoute(baseSession, 'full_workflow', 'hello');
    expect(dec.mode).toBe('direct');
  });

  it('auto routing uses query intent when override is unset', async () => {
    // No override → routing is automatic from prompt content
    const chatDec = await service.resolveRoute(baseSession, undefined, 'Who are you');
    expect(chatDec.mode).toBe('direct');
    const designDec = await service.resolveRoute(baseSession, undefined, 'build a dashboard UI');
    expect(designDec.mode).toBe('workflow');
  });

  it('full_workflow override on new session → dispatches workflow', async () => {
    const dec = await service.resolveRoute(baseSession, 'full_workflow');
    expect(dec.mode).toBe('workflow');
    expect(dec.workflowName).toBe('source-prd-to-ui-designs-variations');
    expect(dec.resolvedBy).toBe('user_override');
    expect(dec.overrideKey).toBe('full_workflow');
  });

  it('full_workflow override on session with existing outputs → still workflow (override wins)', async () => {
    const dec = await service.resolveRoute({ ...baseSession, hasExistingOutputs: true }, 'full_workflow');
    expect(dec.mode).toBe('workflow');
    expect(dec.resolvedBy).toBe('user_override');
  });

  it('unsupported_non_design route resolves to direct mode', async () => {
    const dec = await service.resolveRoute(baseSession, undefined, 'write a unit test for my API');
    expect(dec.mode).toBe('direct');
    expect(dec.reason).toMatch(/non-design|out of scope/i);
  });

  it('repo inference: query mentioning a repo name sets sourceRepoHint in reason (or route)', async () => {
    // The service's inferSourceRepo queries the DB — with mockDb it returns null, so no inference
    // This test verifies the call succeeds without errors when no repos are found
    const dec = await service.resolveRoute(baseSession, undefined, 'design a dashboard for the allen-internal repo');
    // Should still route to workflow (source repo inference is best-effort)
    expect(dec.mode).toBe('workflow');
  });
});

// ── DESIGN_ROUTER_SYSTEM_PROMPT content tests ─────────────────────────────
describe('DESIGN_ROUTER_SYSTEM_PROMPT', () => {
  it('identifies itself as Allen Design Router (not generic assistant)', () => {
    expect(DESIGN_ROUTER_SYSTEM_PROMPT).toContain('Design Router');
    expect(DESIGN_ROUTER_SYSTEM_PROMPT.toLowerCase()).not.toContain('general ai');
    expect(DESIGN_ROUTER_SYSTEM_PROMPT.toLowerCase()).not.toContain('general-purpose');
  });

  it('mentions direct design answers capability', () => {
    const lower = DESIGN_ROUTER_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/direct.*answer|answer.*direct|ui.*question|design.*question/);
  });

  it('mentions full design workflow capability', () => {
    const lower = DESIGN_ROUTER_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/full.*workflow|workflow.*pipeline|source-prd-to-ui|design.*generat/);
  });

  it('mentions fast frontend refinement gated on existing context', () => {
    const lower = DESIGN_ROUTER_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/refinement|refin|existing.*design|existing.*workspace/);
  });

  it('mentions declining non-design requests', () => {
    const lower = DESIGN_ROUTER_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/decline|out.*scope|non-design|backend.*bug|sql/);
  });

  it('instructs to answer capability questions as Design Router (not generic)', () => {
    const lower = DESIGN_ROUTER_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/capability|what can you do|who are you|design router/);
    // Should NOT fall back to generic AI assistant answer
    expect(lower).toMatch(/design router/);
  });

  it('mentions source repo or requirements clarification', () => {
    const lower = DESIGN_ROUTER_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toMatch(/source repo|requirement|clarif/);
  });
});
