/**
 * Simulation tests for multi-repo-change-orchestration.yml.
 *
 * Flow:
 *   START → understand_request → (clarify_request ↻ understand_request, max 3)
 *         → plan_repo_changes
 *         → (review_repo_plan when trusted_mode=false: approve/reject/request_changes ↻ plan_repo_changes, max 2)
 *         → execute_repo_plan → final_summary → END
 *
 * Two layers:
 *   1. validateWorkflow — confirms the YAML loads with zero errors
 *      and the structural invariants the orchestration depends on.
 *   2. Scenario simulator — replays engine edge-selection + retry
 *      semantics deterministically; asserts visited node sequence.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateWorkflow } from './validator.js';
import { evaluateCondition } from './condition-parser.js';
import type { WorkflowDef, EdgeDef, AgentDef } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(__dirname, '..', 'workflows', 'multi-repo-change-orchestration.yml');

const AGENTS: Record<string, AgentDef> = Object.fromEntries(
  [
    'requirements-analyst',
    'engineering-lead',
    'documentation-writer',
  ].map((name) => [name, { system: 'stub' } satisfies AgentDef]),
);

const EXPECTED_AGENTS = [
  'documentation-writer',
  'engineering-lead',
  'requirements-analyst',
].sort();
const BUILT_INS: string[] = [];

let workflow: WorkflowDef;
let yamlText: string;

beforeAll(() => {
  yamlText = readFileSync(WORKFLOW_PATH, 'utf-8');
  workflow = yaml.load(yamlText) as WorkflowDef;
});

// ────────────────────────────────────────────────────────────────────────
// Validator + structural invariants
// ────────────────────────────────────────────────────────────────────────

describe('multi-repo-change-orchestration.yml — validator', () => {
  it('passes engine validateWorkflow with zero errors', () => {
    const result = validateWorkflow(workflow, AGENTS, BUILT_INS);
    if (result.errors.length) {
      // eslint-disable-next-line no-console
      console.error('Validation errors:', result.errors);
    }
    expect(result.errors).toEqual([]);
  });

  it('declares only the expected agents', () => {
    const referenced = new Set<string>();
    for (const node of Object.values(workflow.nodes)) {
      if (node && typeof node === 'object' && 'agent' in node && typeof node.agent === 'string') {
        referenced.add(node.agent);
      }
    }
    expect([...referenced].sort()).toEqual(EXPECTED_AGENTS);
  });

  it('exposes the expected 6 nodes', () => {
    expect(Object.keys(workflow.nodes).sort()).toEqual([
      'clarify_request',
      'execute_repo_plan',
      'final_summary',
      'plan_repo_changes',
      'review_repo_plan',
      'understand_request',
    ]);
  });

  it('START edge points to understand_request', () => {
    const startEdges = workflow.edges.filter((e) =>
      (Array.isArray(e.from) ? e.from : [e.from]).includes('START'),
    );
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0].to).toBe('understand_request');
  });

  it('only references the two supported child workflows (no bug-investigate-and-fix in selection rules)', () => {
    // The planner prompt must instruct the agent to pick between
    // feature-plan-and-implement and bug-fix-by-severity. The
    // negative-list mention of "bug-investigate-and-fix" is allowed
    // (it's a guard rail), but the positive selection rules must use
    // the local name.
    expect(yamlText).toContain('feature-plan-and-implement');
    expect(yamlText).toContain('bug-fix-by-severity');
    // The only mention of bug-investigate-and-fix should be the negative
    // "Do NOT use" guard rail.
    const negativeMatches = (yamlText.match(/Do NOT use[^.]*bug-investigate-and-fix/g) || []).length;
    const totalMatches = (yamlText.match(/bug-investigate-and-fix/g) || []).length;
    expect(totalMatches).toBe(negativeMatches);
  });

  it('execute_repo_plan prompt mandates parallel dispatch', () => {
    const execute = workflow.nodes.execute_repo_plan as { prompt?: string };
    expect(execute?.prompt).toMatch(/PARALLEL DISPATCH IS MANDATORY/);
    expect(execute?.prompt).toMatch(/in ONE response turn/i);
    expect(execute?.prompt).toMatch(/mcp__allen__run_workflow/);
    expect(execute?.prompt).toMatch(/Flatten/);
  });

  it('understand_request prompt removes the artificial question cap', () => {
    const understand = workflow.nodes.understand_request as { prompt?: string };
    expect(understand?.prompt).not.toMatch(/up to 3 (concrete )?clarification/i);
    expect(understand?.prompt).toMatch(/no cap on the number of questions/);
  });

  it('clarify_request → understand_request has max_retries=3', () => {
    const e = workflow.edges.find(
      (e) =>
        e.from === 'clarify_request' &&
        e.to === 'understand_request' &&
        typeof e.max_retries === 'number',
    );
    expect(e).toBeDefined();
    expect(e?.max_retries).toBe(3);
  });

  it('review_repo_plan → plan_repo_changes has max_retries=2', () => {
    const e = workflow.edges.find(
      (e) =>
        e.from === 'review_repo_plan' &&
        e.to === 'plan_repo_changes' &&
        typeof e.max_retries === 'number',
    );
    expect(e).toBeDefined();
    expect(e?.max_retries).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Simulator (same shape as tdd-design-by-severity.simulation.test.ts)
// ────────────────────────────────────────────────────────────────────────

type AgentReply = Record<string, unknown>;
type Script = Record<string, AgentReply[] | ((visitCount: number) => AgentReply)>;

interface SimResult {
  visited: string[];
  finalState: Record<string, unknown>;
  ended: 'END' | 'STUCK';
}

function edgeKey(e: EdgeDef): string {
  const from = Array.isArray(e.from) ? e.from.join(',') : e.from;
  const to = Array.isArray(e.to) ? e.to.join(',') : e.to;
  return `${from}→${to}`;
}

function pickReply(script: Script, node: string, visitCount: number): AgentReply {
  const entry = script[node];
  if (!entry) throw new Error(`Scenario missing reply for ${node} (visit #${visitCount + 1})`);
  if (typeof entry === 'function') return entry(visitCount);
  const idx = Math.min(visitCount, entry.length - 1);
  return entry[idx];
}

function simulate(wf: WorkflowDef, script: Script, initialInput: Record<string, unknown>): SimResult {
  const state: Record<string, unknown> = { ...initialInput };
  const visited: string[] = [];
  const visitCounts = new Map<string, number>();
  const retryCounts = new Map<string, number>();

  let current = 'START';
  const maxSteps = 200;
  let steps = 0;

  while (current !== 'END' && steps < maxSteps) {
    steps++;
    if (current !== 'START') {
      visited.push(current);
      const visitCount = visitCounts.get(current) ?? 0;
      visitCounts.set(current, visitCount + 1);
      const reply = pickReply(script, current, visitCount);
      Object.assign(state, reply);
    }

    const fromName = current === 'START' ? 'START' : current;
    const candidates = wf.edges.filter((e) => {
      const froms = Array.isArray(e.from) ? e.from : [e.from];
      return froms.includes(fromName);
    });
    if (!candidates.length) return { visited, finalState: state, ended: 'STUCK' };

    const retryEdges = candidates.filter((e) => typeof e.max_retries === 'number');
    const plainEdges = candidates.filter((e) => typeof e.max_retries !== 'number');
    const matches = (e: EdgeDef): boolean => (e.condition ? evaluateCondition(e.condition, state) : true);

    const clearExhaustionFor = (targetNode: string): void => {
      delete state.__retry_exhausted_from;
      for (const key of [...retryCounts.keys()]) {
        const arrow = key.indexOf('→');
        if (arrow < 0) continue;
        if (key.slice(arrow + 1) === targetNode) retryCounts.delete(key);
      }
    };

    let nextNode: string | null = null;
    let firedRetry = false;
    for (const e of retryEdges) {
      if (!matches(e)) continue;
      const key = edgeKey(e);
      const count = retryCounts.get(key) ?? 0;
      const limit = e.max_retries as number;
      if (count >= limit) {
        state.__retry_exhausted_from = (Array.isArray(e.from) ? e.from[0] : e.from) as string;
        continue;
      }
      retryCounts.set(key, count + 1);
      if (e.retry_context) state.retry_context = String(e.retry_context);
      const to = Array.isArray(e.to) ? e.to[0] : (e.to as string);
      nextNode = to;
      firedRetry = true;
      delete state.__retry_exhausted_from;
      break;
    }

    if (!firedRetry) {
      for (const e of plainEdges) {
        if (!matches(e)) continue;
        const tos = Array.isArray(e.to) ? e.to : [e.to as string];
        if ((e as { parallel?: boolean }).parallel && tos.length > 1) {
          for (let i = 0; i < tos.length - 1; i++) {
            const t = tos[i] as string;
            visited.push(t);
            const vc = visitCounts.get(t) ?? 0;
            visitCounts.set(t, vc + 1);
            const reply = pickReply(script, t, vc);
            Object.assign(state, reply);
          }
          nextNode = tos[tos.length - 1] as string;
        } else {
          nextNode = tos[0] as string;
        }
        if (e.retry_context) {
          state.retry_context = String(e.retry_context);
          clearExhaustionFor(nextNode);
        } else {
          delete state.retry_context;
        }
        break;
      }
    }

    if (!nextNode) return { visited, finalState: state, ended: 'STUCK' };
    current = nextNode;
  }

  return { visited, finalState: state, ended: current === 'END' ? 'END' : 'STUCK' };
}

// ────────────────────────────────────────────────────────────────────────
// Canonical inputs and replies
// ────────────────────────────────────────────────────────────────────────

const INPUT_BASE = {
  request: 'Add a usage-history view to dashboards in allen and ip-seller-portal.',
  target_repos: '',
  trusted_mode: false,
  allow_partial_success: true,
  chat_session_id: 'chat-1',
  started_by_user_id: 'user-1',
};

const UNDERSTAND_READY: AgentReply = {
  clarifying_questions: [],
  ready_to_plan: true,
  refined_request: 'Add a 7-day usage-history view in both UIs.',
  request_kind: 'feature',
};

const UNDERSTAND_NEEDS_CLARIF: AgentReply = {
  clarifying_questions: ['Which timezone?', 'Weekly aggregation or daily?'],
  ready_to_plan: false,
  refined_request: '',
  request_kind: 'feature',
};

const HUMAN_ANSWERS: AgentReply = { answers: 'UTC. Daily.' };

const PLAN_OK: AgentReply = {
  global_summary: 'Two repos: feature in allen, bug fix in es-data-pipeline.',
  execution_strategy: 'all_parallel',
  phases: [
    {
      phase: 1,
      repos: [
        {
          repo_name: 'allen',
          repo_path: '/repos/allen',
          why_this_repo: 'UI lives here',
          change_type: 'feature',
          child_workflow: 'feature-plan-and-implement',
          child_input: {
            user_request: 'Add a 7-day usage-history view.',
            repo_path: '/repos/allen',
            trusted_mode: false,
            chat_session_id: 'chat-1',
            started_by_user_id: 'user-1',
          },
          depends_on: [],
          blocking: true,
        },
        {
          repo_name: 'es-data-pipeline',
          repo_path: '/repos/es-data-pipeline',
          why_this_repo: 'Aggregation bug',
          change_type: 'bug_fix',
          child_workflow: 'bug-fix-by-severity',
          child_input: {
            bug_report: 'Hourly counts double on DST boundary.',
            repo_path: '/repos/es-data-pipeline',
            chat_session_id: 'chat-1',
            started_by_user_id: 'user-1',
          },
          depends_on: [],
          blocking: false,
        },
      ],
    },
  ],
  risks: [],
  unmapped_questions: [],
  plan_markdown: '## Plan\n...\n',
};

const EXECUTE_OK: AgentReply = {
  overall_status: 'completed',
  repo_results: [
    {
      repo_name: 'allen',
      repo_path: '/repos/allen',
      phase: 1,
      status: 'success',
      child_workflow: 'feature-plan-and-implement',
      execution_id: 'exec-1',
      execution_url: 'http://allen/exec/1',
      pr_url: 'http://gh/pr/1',
      summary: 'merged',
      blocking: true,
      depends_on: [],
    },
    {
      repo_name: 'es-data-pipeline',
      repo_path: '/repos/es-data-pipeline',
      phase: 1,
      status: 'success',
      child_workflow: 'bug-fix-by-severity',
      execution_id: 'exec-2',
      execution_url: 'http://allen/exec/2',
      pr_url: 'http://gh/pr/2',
      summary: 'fix shipped',
      blocking: false,
      depends_on: [],
    },
  ],
  blocked_repos: [],
  manual_follow_ups: [],
  requirements_status: { fully_satisfied: ['original'], partially_satisfied: [], not_satisfied: [] },
  execution_report_markdown: '## Execution\nAll repos green.',
};

const SUMMARY_OK: AgentReply = {
  summary_markdown: '## Summary\nAll done.',
  workflow_verdict: 'completed',
};

// ────────────────────────────────────────────────────────────────────────
// Happy paths
// ────────────────────────────────────────────────────────────────────────

describe('happy paths', () => {
  it('trusted_mode=true: understand → plan → execute → summary → END (no review)', () => {
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_READY],
      plan_repo_changes: [PLAN_OK],
      execute_repo_plan: [EXECUTE_OK],
      final_summary: [SUMMARY_OK],
    }, { ...INPUT_BASE, trusted_mode: true });
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual([
      'understand_request',
      'plan_repo_changes',
      'execute_repo_plan',
      'final_summary',
    ]);
    expect(r.visited).not.toContain('review_repo_plan');
  });

  it('non-trusted + approve: understand → plan → review → execute → summary → END', () => {
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_READY],
      plan_repo_changes: [PLAN_OK],
      review_repo_plan: [{ decision: 'approve', feedback: '' }],
      execute_repo_plan: [EXECUTE_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual([
      'understand_request',
      'plan_repo_changes',
      'review_repo_plan',
      'execute_repo_plan',
      'final_summary',
    ]);
  });

  it('reports partial_success outcome from executor unchanged', () => {
    const partial: AgentReply = { ...EXECUTE_OK, overall_status: 'partial_success' };
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_READY],
      plan_repo_changes: [PLAN_OK],
      execute_repo_plan: [partial],
      final_summary: [{ ...SUMMARY_OK, workflow_verdict: 'partial_success' }],
    }, { ...INPUT_BASE, trusted_mode: true });
    expect(r.ended).toBe('END');
    expect(r.finalState.workflow_verdict).toBe('partial_success');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Clarification loop
// ────────────────────────────────────────────────────────────────────────

describe('clarification loop (clarify_request → understand_request, max 3)', () => {
  it('one clarification round → resolves → continues to plan', () => {
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_NEEDS_CLARIF, UNDERSTAND_READY],
      clarify_request: [HUMAN_ANSWERS],
      plan_repo_changes: [PLAN_OK],
      execute_repo_plan: [EXECUTE_OK],
      final_summary: [SUMMARY_OK],
    }, { ...INPUT_BASE, trusted_mode: true });
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'understand_request').length).toBe(2);
    expect(r.visited.filter((n) => n === 'clarify_request').length).toBe(1);
  });

  it('three clarification rounds (within retry cap) → finally resolves', () => {
    const r = simulate(workflow, {
      understand_request: [
        UNDERSTAND_NEEDS_CLARIF,
        UNDERSTAND_NEEDS_CLARIF,
        UNDERSTAND_NEEDS_CLARIF,
        UNDERSTAND_READY,
      ],
      clarify_request: [HUMAN_ANSWERS, HUMAN_ANSWERS, HUMAN_ANSWERS],
      plan_repo_changes: [PLAN_OK],
      execute_repo_plan: [EXECUTE_OK],
      final_summary: [SUMMARY_OK],
    }, { ...INPUT_BASE, trusted_mode: true });
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'understand_request').length).toBe(4);
    expect(r.visited.filter((n) => n === 'clarify_request').length).toBe(3);
  });

  it('clarification exhausted (still ambiguous after 3 retries) → STUCK', () => {
    // No fallback edge exists from clarify_request once max_retries
    // is exhausted; this surfaces the genuine workflow gap.
    const r = simulate(workflow, {
      understand_request: [
        UNDERSTAND_NEEDS_CLARIF,
        UNDERSTAND_NEEDS_CLARIF,
        UNDERSTAND_NEEDS_CLARIF,
        UNDERSTAND_NEEDS_CLARIF,
      ],
      clarify_request: [HUMAN_ANSWERS, HUMAN_ANSWERS, HUMAN_ANSWERS, HUMAN_ANSWERS],
    }, INPUT_BASE);
    expect(r.ended).toBe('STUCK');
    expect(r.finalState.__retry_exhausted_from).toBe('clarify_request');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plan-approval gate (non-trusted mode)
// ────────────────────────────────────────────────────────────────────────

describe('review_repo_plan gate', () => {
  it('reject → END (execute is NOT visited)', () => {
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_READY],
      plan_repo_changes: [PLAN_OK],
      review_repo_plan: [{ decision: 'reject', feedback: 'not now' }],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).not.toContain('execute_repo_plan');
    expect(r.visited).not.toContain('final_summary');
    expect(r.visited[r.visited.length - 1]).toBe('review_repo_plan');
  });

  it('request_changes → plan_repo_changes (1 retry) → approve → execute → END', () => {
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_READY],
      plan_repo_changes: [PLAN_OK, PLAN_OK],
      review_repo_plan: [
        { decision: 'request_changes', feedback: 'split allen repo into two phases' },
        { decision: 'approve', feedback: '' },
      ],
      execute_repo_plan: [EXECUTE_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'plan_repo_changes').length).toBe(2);
    expect(r.visited.filter((n) => n === 'review_repo_plan').length).toBe(2);
  });

  it('request_changes twice (within retry cap) → approve → END', () => {
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_READY],
      plan_repo_changes: [PLAN_OK, PLAN_OK, PLAN_OK],
      review_repo_plan: [
        { decision: 'request_changes', feedback: 'r1' },
        { decision: 'request_changes', feedback: 'r2' },
        { decision: 'approve', feedback: '' },
      ],
      execute_repo_plan: [EXECUTE_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'plan_repo_changes').length).toBe(3);
  });

  it('request_changes exhaustion (3rd time) → STUCK (no fallback edge)', () => {
    // max_retries on review→plan is 2, so the 3rd request_changes
    // exhausts. There is no exhaustion fallback edge from review_repo_plan,
    // so the run is STUCK. Documents the gap.
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_READY],
      plan_repo_changes: [PLAN_OK, PLAN_OK, PLAN_OK],
      review_repo_plan: [
        { decision: 'request_changes', feedback: 'r1' },
        { decision: 'request_changes', feedback: 'r2' },
        { decision: 'request_changes', feedback: 'r3' },
      ],
    }, INPUT_BASE);
    expect(r.ended).toBe('STUCK');
    expect(r.finalState.__retry_exhausted_from).toBe('review_repo_plan');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Combined edge cases
// ────────────────────────────────────────────────────────────────────────

describe('combined edge cases', () => {
  it('clarification (1 round) + non-trusted + 1 request_changes + approve', () => {
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_NEEDS_CLARIF, UNDERSTAND_READY],
      clarify_request: [HUMAN_ANSWERS],
      plan_repo_changes: [PLAN_OK, PLAN_OK],
      review_repo_plan: [
        { decision: 'request_changes', feedback: 'tighter scope' },
        { decision: 'approve', feedback: '' },
      ],
      execute_repo_plan: [EXECUTE_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'understand_request').length).toBe(2);
    expect(r.visited.filter((n) => n === 'plan_repo_changes').length).toBe(2);
    expect(r.visited.filter((n) => n === 'review_repo_plan').length).toBe(2);
    expect(r.visited.filter((n) => n === 'execute_repo_plan').length).toBe(1);
    expect(r.visited.filter((n) => n === 'final_summary').length).toBe(1);
  });

  it('executor emits failed status → summary still runs → END', () => {
    const failedExec: AgentReply = {
      ...EXECUTE_OK,
      overall_status: 'failed',
      repo_results: [
        { ...EXECUTE_OK.repo_results[0], status: 'failure', pr_url: '' },
      ],
    };
    const r = simulate(workflow, {
      understand_request: [UNDERSTAND_READY],
      plan_repo_changes: [PLAN_OK],
      execute_repo_plan: [failedExec],
      final_summary: [{ ...SUMMARY_OK, workflow_verdict: 'failed' }],
    }, { ...INPUT_BASE, trusted_mode: true });
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('execute_repo_plan');
    expect(r.visited).toContain('final_summary');
    expect(r.finalState.workflow_verdict).toBe('failed');
  });
});
