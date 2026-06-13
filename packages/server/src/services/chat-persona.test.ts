/**
 * Unit tests for the Plan Mode → Planner persona logic.
 *
 * Covers:
 *   - selectChatPersona(): Plan Mode toggles the base chat between the routing
 *     assistant and the read-only Planner.
 *   - buildPlannerSystemPrompt(): the Planner prompt encodes the agreed
 *     requirements (brainstorm + PRD only, never assume, ask first, read-only
 *     research, save PRD as artifact, explicit user requirements + acceptance
 *     criteria) and appends the caller-supplied context blocks verbatim.
 *
 * This module is dependency-free by design, so it is imported directly (unlike
 * ChatService, which pulls in the @allen/engine graph).
 */

import { describe, it, expect } from 'vitest';
import {
  selectChatPersona,
  buildPlannerSystemPrompt,
  type ChatPersona,
} from './chat-persona.js';

describe('selectChatPersona', () => {
  it('returns "planner" when plan mode is on', () => {
    expect(selectChatPersona(true)).toBe('planner');
  });

  it('returns "assistant" when plan mode is off', () => {
    expect(selectChatPersona(false)).toBe('assistant');
  });

  it('returns "assistant" when plan mode is null/undefined (default off)', () => {
    expect(selectChatPersona(null)).toBe('assistant');
    expect(selectChatPersona(undefined)).toBe('assistant');
  });

  it('only ever yields the two known personas', () => {
    const values: ChatPersona[] = [
      selectChatPersona(true),
      selectChatPersona(false),
    ];
    for (const v of values) expect(['assistant', 'planner']).toContain(v);
  });
});

describe('buildPlannerSystemPrompt', () => {
  const prompt = buildPlannerSystemPrompt();

  it('establishes the Planner identity, not the routing assistant', () => {
    expect(prompt).toContain('You are Allen Planner');
    // Must NOT fall back to the default assistant identity.
    expect(prompt).not.toContain('intelligent command center');
  });

  it('scopes the persona to brainstorming and PRD authoring only', () => {
    expect(prompt).toContain('TWO JOBS ONLY');
    expect(prompt).toMatch(/Brainstorm/);
    expect(prompt).toMatch(/Author a PRD/);
  });

  it('forbids assuming/guessing and requires clarifying questions first', () => {
    expect(prompt).toContain('NEVER assume or guess');
    expect(prompt).toMatch(/clarifying questions/i);
    expect(prompt).toMatch(/open questions/i);
  });

  it('keeps the assistant tool boundary (no implementation) while allowing artifacts', () => {
    // Behavioral boundary mirrors the assistant: brainstorm/plan, don't build.
    expect(prompt).toMatch(/never write repository code|Do not implement/i);
    expect(prompt).toMatch(/spawn_agent/);
    // It must still be able to save artifacts (PRDs).
    expect(prompt).toContain('allen_save_artifact');
  });

  it('advertises the same tools/access as the assistant (persona is the only difference)', () => {
    expect(prompt).toMatch(/same tools and access as the Allen Assistant/i);
  });

  it('requires PRDs to be saved as an artifact', () => {
    expect(prompt).toContain('allen_save_artifact');
  });

  it('specifies a PRD structure with user requirements and acceptance criteria', () => {
    expect(prompt).toContain('PRD STRUCTURE');
    expect(prompt).toMatch(/User requirements/);
    expect(prompt).toMatch(/Acceptance criteria/);
  });

  it('loads the prd-authoring playbook skill before writing a PRD', () => {
    expect(prompt).toContain('prd-authoring');
    expect(prompt).toMatch(/get_skill|search_skills|list_skills/);
  });

  it('forbids technical code snippets in the PRD', () => {
    expect(prompt).toContain('NO technical code snippets');
    expect(prompt).toMatch(/pseudo-code/);
  });

  it('defaults context blocks to empty and produces no trailing block markers', () => {
    expect(prompt).not.toContain('undefined');
    // With no blocks the prompt ends at the read-only research line.
    expect(prompt.trimEnd().endsWith('use them read-only for research.')).toBe(true);
  });

  it('appends learnings, org, and repos blocks verbatim and in order', () => {
    const blocks = {
      learningsBlock: '\n\n## Memory from previous conversations\n- [preference] use staging DB',
      orgBlock: '\n\nORGCHART_MARKER',
      reposBlock: '\n\nREPOS_MARKER',
    };
    const withBlocks = buildPlannerSystemPrompt(blocks);

    expect(withBlocks).toContain(blocks.learningsBlock);
    expect(withBlocks).toContain(blocks.orgBlock);
    expect(withBlocks).toContain(blocks.reposBlock);

    // Order: learnings → org → repos, all after the static body.
    const iLearnings = withBlocks.indexOf('Memory from previous conversations');
    const iOrg = withBlocks.indexOf('ORGCHART_MARKER');
    const iRepos = withBlocks.indexOf('REPOS_MARKER');
    expect(iLearnings).toBeGreaterThan(0);
    expect(iOrg).toBeGreaterThan(iLearnings);
    expect(iRepos).toBeGreaterThan(iOrg);
  });

  it('tolerates partial blocks without leaking "undefined"', () => {
    const withReposOnly = buildPlannerSystemPrompt({ reposBlock: '\n\nONLY_REPOS' });
    expect(withReposOnly).toContain('ONLY_REPOS');
    expect(withReposOnly).not.toContain('undefined');
  });
});
