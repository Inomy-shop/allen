import { describe, it, expect } from 'vitest';
import { DesignRouter } from './design-router.service.js';

describe('DesignRouter.classify', () => {
  const router = new DesignRouter();

  // ── Direct route ──────────────────────────────────────────────────────────
  it('routes "hello" to direct', () => {
    expect(router.classify('hello').route).toBe('direct');
  });
  it('routes "Helloo" (double-o typo) to direct', () => {
    expect(router.classify('Helloo').route).toBe('direct');
  });
  it('routes "helloo" to direct', () => {
    expect(router.classify('helloo').route).toBe('direct');
  });
  it('routes "helo" (single-l typo) to direct', () => {
    expect(router.classify('helo').route).toBe('direct');
  });
  it('routes "hii" (double-i typo) to direct', () => {
    expect(router.classify('hii').route).toBe('direct');
  });
  it('routes "heyy" to direct', () => {
    expect(router.classify('heyy').route).toBe('direct');
  });
  it('routes "hi there" to direct', () => {
    expect(router.classify('hi there').route).toBe('direct');
  });
  it('routes "hey" to direct', () => {
    expect(router.classify('hey').route).toBe('direct');
  });
  it('routes "thanks" to direct', () => {
    expect(router.classify('thanks').route).toBe('direct');
  });
  it('routes "thank you" to direct', () => {
    expect(router.classify('thank you').route).toBe('direct');
  });
  it('routes "what can you do?" to direct', () => {
    expect(router.classify('what can you do?').route).toBe('direct');
  });
  it('routes empty string to direct', () => {
    expect(router.classify('').route).toBe('direct');
  });
  it('routes "ok" to direct', () => {
    expect(router.classify('ok').route).toBe('direct');
  });

  // ── Identity / "who are you" questions ───────────────────────────────────
  it('routes "Who are you" to direct', () => {
    expect(router.classify('Who are you').route).toBe('direct');
  });
  it('routes "who are you?" to direct', () => {
    expect(router.classify('who are you?').route).toBe('direct');
  });
  it('routes "what are you?" to direct', () => {
    expect(router.classify('what are you?').route).toBe('direct');
  });
  it('routes "are you an AI?" to direct', () => {
    expect(router.classify('are you an AI?').route).toBe('direct');
  });
  it('routes "tell me about yourself" to direct', () => {
    expect(router.classify('tell me about yourself').route).toBe('direct');
  });

  // ── Conversational prompts direct-answer even with full_workflow override ─
  it('routes "Who are you" to direct even with full_workflow override', () => {
    expect(router.classify('Who are you', 'full_workflow').route).toBe('direct');
  });
  it('routes "hello" to direct even with full_workflow override', () => {
    expect(router.classify('hello', 'full_workflow').route).toBe('direct');
  });
  it('routes "thanks" to direct even with full_workflow override', () => {
    expect(router.classify('thanks', 'full_workflow').route).toBe('direct');
  });
  it('routes "what can you do?" to direct even with full_workflow override', () => {
    expect(router.classify('what can you do?', 'full_workflow').route).toBe('direct');
  });
  it('routes substantive prompt with full_workflow override to workflow', () => {
    // Non-conversational prompt → override still applies
    expect(router.classify('build a dashboard UI', 'full_workflow').route).toBe('workflow');
  });
  it('auto override falls through to classification for substantive prompt', () => {
    expect(router.classify('build a navbar', 'auto').route).toBe('workflow');
  });

  // ── Workflow route: implementation/prototype without existing context ───────
  it('routes "implement a navbar component" without context to workflow', () => {
    expect(router.classify('implement a navbar component').route).toBe('workflow');
  });
  it('routes "add a submit button to the form" without context to workflow', () => {
    expect(router.classify('add a submit button to the form').route).toBe('workflow');
  });
  it('routes "create a prototype for the login page" without context to workflow', () => {
    expect(router.classify('create a prototype for the login page').route).toBe('workflow');
  });
  it('routes "build a prototype" without context to workflow', () => {
    expect(router.classify('build a prototype').route).toBe('workflow');
  });
  it('routes "design a card component" without context to workflow', () => {
    expect(router.classify('design a card component').route).toBe('workflow');
  });
  it('routes "fix the layout" without context to workflow', () => {
    expect(router.classify('fix the layout').route).toBe('workflow');
  });
  it('routes a general design request without context to workflow', () => {
    expect(router.classify('I need a landing page design').route).toBe('workflow');
  });
  it('needsConfirmation is true when no existing context', () => {
    const result = router.classify('build a dashboard');
    expect(result.route).toBe('workflow');
    expect(result.needsConfirmation).toBe(true);
  });
  it('needsConfirmation is false when existing context (workflow still chosen for non-refinement)', () => {
    const result = router.classify('build a new navbar', undefined, { hasExistingContext: true });
    expect(result.route).toBe('workflow');
    expect(result.needsConfirmation).toBe(false);
  });

  // ── Workflow route: explicit multiple variations / design generation ────────
  it('routes "generate multiple design variations for my landing page" to workflow', () => {
    const result = router.classify('generate multiple design variations for my landing page');
    expect(result.route).toBe('workflow');
  });
  it('routes "create design options for my dashboard" to workflow', () => {
    expect(router.classify('create design options for my dashboard').route).toBe('workflow');
  });
  it('routes "design system for our app" to workflow', () => {
    expect(router.classify('design system for our app').route).toBe('workflow');
  });

  // ── Frontend route: refinement WITH existing context ──────────────────────
  it('routes "improve this design" with existing context to frontend', () => {
    const result = router.classify('improve this design', undefined, { hasExistingContext: true });
    expect(result.route).toBe('frontend');
  });
  it('routes "refine this option" with existing context to frontend', () => {
    const result = router.classify('refine this option', undefined, { hasExistingContext: true });
    expect(result.route).toBe('frontend');
  });
  it('routes "update this route" with existing context to frontend', () => {
    const result = router.classify('update this route', undefined, { hasExistingContext: true });
    expect(result.route).toBe('frontend');
  });
  it('routes "tweak the layout a bit" with existing context to frontend', () => {
    const result = router.classify('tweak the layout a bit', undefined, { hasExistingContext: true });
    expect(result.route).toBe('frontend');
  });
  it('routes "change the color of this option" with existing context to frontend', () => {
    const result = router.classify('change the color of this option', undefined, { hasExistingContext: true });
    expect(result.route).toBe('frontend');
  });
  it('routes "fix this button style" with existing context to frontend', () => {
    const result = router.classify('fix this button style', undefined, { hasExistingContext: true });
    expect(result.route).toBe('frontend');
  });
  it('refinement WITHOUT existing context still goes to workflow', () => {
    // No context → workflow even for refinement language (nothing to refine)
    const result = router.classify('improve this design', undefined, { hasExistingContext: false });
    expect(result.route).toBe('workflow');
  });
  it('non-refinement request WITH existing context still goes to workflow', () => {
    // Existing context but not refinement language → workflow
    const result = router.classify('build a completely new navbar component', undefined, { hasExistingContext: true });
    expect(result.route).toBe('workflow');
  });

  // ── Override handling — only for substantive prompts ────────────────────
  it('routes full_workflow override to workflow', () => {
    expect(router.classify('anything', 'full_workflow').route).toBe('workflow');
  });
  it('routes fast_frontend override to frontend', () => {
    expect(router.classify('anything', 'fast_frontend').route).toBe('frontend');
  });
  it('auto override falls through to classification', () => {
    expect(router.classify('hello', 'auto').route).toBe('direct');
  });

  // ── Non-design / unsupported ──────────────────────────────────────────────
  it('routes "fix a bug in my backend code" to unsupported_non_design', () => {
    expect(router.classify('fix a bug in my backend code').route).toBe('unsupported_non_design');
  });
  it('routes "write a unit test for my function" to unsupported_non_design', () => {
    expect(router.classify('write a unit test for my function').route).toBe('unsupported_non_design');
  });
  it('routes "debug stack trace error" to unsupported_non_design', () => {
    expect(router.classify('debug stack trace error').route).toBe('unsupported_non_design');
  });
  it('routes "SQL query to find users" to unsupported_non_design', () => {
    expect(router.classify('SQL query to find users').route).toBe('unsupported_non_design');
  });
  it('routes "calculate my tax refund" to unsupported_non_design', () => {
    expect(router.classify('calculate my tax refund').route).toBe('unsupported_non_design');
  });

  // ── Design-adjacent requests NOT flagged as non-design ────────────────────
  it('routes "fix the button style" (design task) to frontend with context, not unsupported', () => {
    const result = router.classify('fix the button style', undefined, { hasExistingContext: true });
    expect(result.route).toBe('frontend');
  });
  it('routes "fix this layout" without context to workflow, not unsupported', () => {
    expect(router.classify('fix this layout').route).toBe('workflow');
  });
  it('routes "debug the visual layout" to workflow (visual debugging is design-adjacent)', () => {
    expect(router.classify('debug the visual layout').route).toBe('workflow');
  });
});

// ── Capability classification routes to 'direct' for explicit phrases ─────
describe('DesignRouter.classify — capability/identity routing', () => {
  const router = new DesignRouter();

  it('routes "how do you work?" to direct', () => {
    expect(router.classify('how do you work?').route).toBe('direct');
  });

  it('routes "what can you help me with?" to direct', () => {
    expect(router.classify('what can you help me with?').route).toBe('direct');
  });

  it('routes "can you help me?" to direct', () => {
    expect(router.classify('can you help me?').route).toBe('direct');
  });

  it('routes "what are your features?" to direct', () => {
    expect(router.classify('what are your features?').route).toBe('direct');
  });
});
