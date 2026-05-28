/**
 * UI brand constants — mirror of packages/engine/src/brand.ts but kept
 * separate because the UI package cannot import from the server-side
 * engine package.
 *
 * Keep these in sync with packages/engine/src/brand.ts.
 */

export const BRAND_NAME = 'Allen';
export const BRAND_SLUG = 'allen';

/** Full product tagline shown in setup surfaces. */
export const BRAND_TAGLINE = `${BRAND_NAME} coordinates agentic software work across repos, runs, and reviews.`;

/** Chat session title when no specific title is set. */
export const CHAT_TITLE = `${BRAND_NAME} Chat`;

/** Chat input placeholder. */
export const CHAT_PLACEHOLDER = `Ask ${BRAND_NAME} to fix a Linear ticket, update tests, or review a PR...`;

/** Chat empty-state prompt. */
export const CHAT_EMPTY_PROMPT = `Start a conversation with ${BRAND_NAME} Assistant.`;

/** Slack-button / external review CTA. */
export const REVIEW_CTA = `Review in ${BRAND_NAME}`;
