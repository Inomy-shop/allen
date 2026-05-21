/**
 * UI brand constants — mirror of packages/engine/src/brand.ts but kept
 * separate because the UI package cannot import from the server-side
 * engine package.
 *
 * Keep these in sync with packages/engine/src/brand.ts.
 */

export const BRAND_NAME = 'Allen';
export const BRAND_SLUG = 'allen';

/** Full product tagline shown on login. */
export const BRAND_TAGLINE = `${BRAND_NAME} is invite-only. Ask an admin for an account.`;

/** Chat session title when no specific title is set. */
export const CHAT_TITLE = `${BRAND_NAME} Chat`;

/** Chat input placeholder. */
export const CHAT_PLACEHOLDER = `Message ${BRAND_NAME}...`;

/** Chat empty-state prompt. */
export const CHAT_EMPTY_PROMPT = `Start a conversation with ${BRAND_NAME} Assistant.`;

/** Slack-button / external review CTA. */
export const REVIEW_CTA = `Review in ${BRAND_NAME}`;
