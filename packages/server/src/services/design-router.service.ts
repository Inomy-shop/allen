/**
 * Design Router
 *
 * Classifies a user prompt into one of three routes:
 *   - 'direct'   — answer without spawning an agent (greetings, ack, capability Qs)
 *   - 'frontend' — delegate to frontend-developer agent (refinements of existing design context only)
 *   - 'workflow' — run the full source-prd-to-ui-designs-variations workflow
 *
 * Key rule:
 *   frontend is used ONLY when hasExistingContext=true AND prompt has refinement language.
 *   All other substantive requests → workflow (needsConfirmation: !hasExistingContext).
 */

export interface DesignRouteClassification {
  route: 'direct' | 'frontend' | 'workflow' | 'unsupported_non_design';
  reason: string;
  needsConfirmation?: boolean;
}

export interface DesignRouteContext {
  /** True when the session has an existing workspace or generated outputs. */
  hasExistingContext?: boolean;
}

export class DesignRouter {
  classify(prompt: string, overrideKey?: string, context?: DesignRouteContext): DesignRouteClassification {
    // Normalize first — conversational checks must run before any override logic.
    // This prevents 'full_workflow' override from routing "Who are you" to a
    // workflow execution that fails with a missing source_repo_path error.
    const normalized = (prompt ?? '').trim().toLowerCase();
    const hasExistingContext = context?.hasExistingContext ?? false;

    // 1. Conversational prompts always direct-answer, even when an explicit
    //    override is active. Gate: empty/short, greetings, acks, identity/capability Qs.

    // 1a. Empty / very short → direct
    if (normalized.length < 3) {
      return { route: 'direct', reason: 'Empty or very short prompt' };
    }

    // 1b. Greetings — allow optional trailing words like "there" ("hi there", "hello there")
    //     Also handles common typos: double letters (helloo, hii, heyy) and single-l (helo).
    const GREETING_RE = /^(hi+|hell?o+|hey+|howdy|greetings|good (morning|afternoon|evening)|sup|what'?s up)(\s+there)?[!\s.,?]*$/;
    if (GREETING_RE.test(normalized)) {
      return { route: 'direct', reason: 'Greeting' };
    }

    // 1c. Thanks / acknowledgment
    const ACK_RE = /^(thanks?|thank you|great|ok|okay|got it|understood|sure|sounds good|perfect|awesome|cool)[!\s.,?]*$/;
    if (ACK_RE.test(normalized)) {
      return { route: 'direct', reason: 'Acknowledgment' };
    }

    // 1d. Capability / identity / meta questions — includes "who are you"
    const CAPABILITY_RE = /\b(what can you do|what do you do|how (do you work|can you help)|help me|(what|who) are you|are you an? (ai|assistant|bot)|tell me about yourself|capabilities|features)\b/;
    if (CAPABILITY_RE.test(normalized) && normalized.length < 80) {
      return { route: 'direct', reason: 'Capability or identity question' };
    }

    // 1e. Clearly non-design requests
    const NON_DESIGN_RE = /\b(unit test|integration test|write (a test|tests)|backend (code|logic|bug)|database (query|schema|migration)|sql (query|table|schema)|python script|bash script|server-side (logic|api)|fix a bug(?! (in the|this) (ui|layout|design|style|css|component))|debug(?!.*(?:visual|ui|layout|style|css|design))[^.]*error|stack trace|memory leak|calculate|math formula|tax (calculation|refund)|medical advice|weather (forecast|today)|stock price)\b/i;
    if (NON_DESIGN_RE.test(normalized)) {
      return { route: 'unsupported_non_design', reason: 'Non-design request — out of scope for Design chat' };
    }

    // 2. Handle explicit overrides for substantive (non-conversational) prompts.
    if (overrideKey && overrideKey !== 'auto') {
      return this.classifyOverride(overrideKey);
    }

    // 3. Refinement of existing design context → frontend
    // Only when there is existing workspace/generated context AND refinement language.
    const REFINEMENT_RE = /\b(improve|refine|refinement|refining|tweak|adjust|modify|rework|cleanup|clean up|touch up|edit (this|the)|update (this|the)|change (this|the)|fix (this|the))\b/;
    if (hasExistingContext && REFINEMENT_RE.test(normalized)) {
      return { route: 'frontend', reason: 'Refining existing design' };
    }

    // 4. Everything else → workflow (design generation pipeline).
    // needsConfirmation=true only when there is no existing context (fresh generation).
    return {
      route: 'workflow',
      reason: 'Design generation request',
      needsConfirmation: !hasExistingContext,
    };
  }

  private classifyOverride(overrideKey: string): DesignRouteClassification {
    switch (overrideKey) {
      case 'full_workflow':
        return { route: 'workflow', reason: 'User selected full workflow override', needsConfirmation: false };
      case 'fast_frontend':
        return { route: 'frontend', reason: 'User selected fast frontend override' };
      default:
        return { route: 'frontend', reason: `Override key: ${overrideKey}` };
    }
  }
}
