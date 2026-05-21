/**
 * Simulation tests for milestone-implementation-from-prd-tdd.yml.
 *
 * Same simulator pattern as feature-plan-and-implement.simulation.test.ts:
 *   - validateWorkflow confirms the YAML loads cleanly.
 *   - Scenario simulator drives nodes via scripted outputs, walking edges
 *     with the real evaluateCondition and engine-mirrored retry semantics.
 *
 * Covers the 12 scenarios from the change plan: happy path, internal
 * self-judge, blocked implementer, validator fail+exhaust, validator
 * pass auto-marks complete, multi-milestone cycle, all-complete → final,
 * final-fail → repair milestone → final pass, final-fail exhaustion,
 * pr_creator after pass, resolved-URL passthrough, state-shape consistency.
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
const WORKFLOW_PATH = join(__dirname, '..', 'workflows', 'milestone-implementation-from-prd-tdd.yml');

const AGENTS: Record<string, AgentDef> = Object.fromEntries(
  [
    'requirements-analyst',
    'engineering-lead',
    'implementation-validator',
    'documentation-writer',
    'pr-creator',
  ].map((n) => [n, { system: 'stub' } satisfies AgentDef]),
);
const BUILT_INS = ['create-workspace'];

let workflow: WorkflowDef;

beforeAll(() => {
  const text = readFileSync(WORKFLOW_PATH, 'utf-8');
  workflow = yaml.load(text) as WorkflowDef;
});

// ────────────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────────────

describe('milestone-implementation-from-prd-tdd.yml — validator', () => {
  it('passes engine validateWorkflow with zero errors', () => {
    const result = validateWorkflow(workflow, AGENTS, BUILT_INS);
    if (result.errors.length) {
      // eslint-disable-next-line no-console
      console.error('Validation errors:', result.errors);
    }
    expect(result.errors).toEqual([]);
  });

  it('removed legacy nodes (milestone_task_planner, milestone_repair_planner, mark_milestone_complete)', () => {
    expect(workflow.nodes.milestone_task_planner).toBeUndefined();
    expect(workflow.nodes.milestone_repair_planner).toBeUndefined();
    expect(workflow.nodes.mark_milestone_complete).toBeUndefined();
  });

  it('still has the surviving 10 nodes', () => {
    for (const name of [
      'load_implementation_context',
      'create_workspace',
      'milestone_planner',
      'select_next_milestone',
      'milestone_implementer',
      'milestone_validator',
      'final_implementation_validator',
      'pr_creator',
      'final_summary',
      'milestone_escalation_review',
    ]) {
      expect(workflow.nodes[name]).toBeDefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Simulator (same as feature-plan-and-implement)
// ────────────────────────────────────────────────────────────────────────

type AgentReply = Record<string, unknown>;
type Script = Record<string, AgentReply[] | ((visitCount: number) => AgentReply)>;

interface SimResult {
  visited: string[];
  finalState: Record<string, unknown>;
  ended: 'END' | 'STUCK';
}

function edgeKey(e: EdgeDef): string {
  return `${e.from}→${e.to}`;
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
  const maxSteps = 400;
  let steps = 0;

  while (current !== 'END' && steps < maxSteps) {
    steps++;
    if (current !== 'START') {
      visited.push(current);
      const visitCount = visitCounts.get(current) ?? 0;
      visitCounts.set(current, visitCount + 1);

      const node = wf.nodes[current];
      if (node?.type === 'code' && current === 'create_workspace') {
        Object.assign(state, {
          workspace_id: 'ws-1',
          worktree_path: '/tmp/wt',
          branch: 'feature/x',
          branch_name: 'feature/x',
          base_branch: 'main',
          repo_path: '/tmp/wt',
          status: 'active',
        });
      } else {
        const reply = pickReply(script, current, visitCount);
        Object.assign(state, reply);
      }
    }

    const fromName = current === 'START' ? 'START' : current;
    const candidates = wf.edges.filter((e) => e.from === fromName);
    if (!candidates.length) {
      return { visited, finalState: state, ended: 'STUCK' };
    }

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
        state.__retry_exhausted_from = e.from as string;
        continue;
      }
      retryCounts.set(key, count + 1);
      if (e.retry_context) state.retry_context = String(e.retry_context);
      nextNode = e.to as string;
      firedRetry = true;
      delete state.__retry_exhausted_from;
      break;
    }

    if (!firedRetry) {
      for (const e of plainEdges) {
        if (!matches(e)) continue;
        nextNode = e.to as string;
        if (e.retry_context) {
          state.retry_context = String(e.retry_context);
          clearExhaustionFor(nextNode);
        } else {
          delete state.retry_context;
        }
        break;
      }
    }

    if (!nextNode) {
      return { visited, finalState: state, ended: 'STUCK' };
    }

    current = nextNode;
  }

  return {
    visited,
    finalState: state,
    ended: current === 'END' ? 'END' : 'STUCK',
  };
}

const INPUT = {
  task: 'Add bookmarks feature',
  repo_path: '/repo',
};

// Canonical replies
const CTX_OK: AgentReply = {
  normalized_task: 'add bookmarks',
  resolved_prd_artifact_url: 'http://art/prd',
  resolved_tdd_artifact_url: 'http://art/tdd',
};
const PLAN_OK: AgentReply = {
  milestone_state: { 'MS-001': 'pending' },
  milestone_plan_artifact_url: 'http://art/plan',
};
const selectPending = (id: string): AgentReply => ({
  milestone_selection_status: 'pending',
  current_milestone_id: id,
  current_milestone_kind: 'normal',
  current_milestone: { id, scope: 'do stuff' },
  milestone_state: { [id]: 'in_progress' },
});
const selectAllComplete = (state: Record<string, string>): AgentReply => ({
  milestone_selection_status: 'all_complete',
  current_milestone_id: '',
  current_milestone_kind: 'normal',
  current_milestone: {},
  milestone_state: state,
});
const selectBlocked: AgentReply = {
  milestone_selection_status: 'blocked',
  current_milestone_id: '',
  current_milestone_kind: 'normal',
  current_milestone: {},
  milestone_state: { 'MS-001': 'blocked' },
};
const implReady = (id: string, kind: 'normal' | 'final_repair' = 'normal'): AgentReply => ({
  implementer_status: 'ready_for_validation',
  current_milestone_id: id,
  current_milestone_kind: kind,
  milestone_files_changed: ['src/x.ts'],
  milestone_test_files: ['src/x.test.ts'],
  implementation_artifact_url: `http://art/impl-${id}`,
  implementation_summary: 'did the thing',
  blockers: [],
});
const implBlocked = (id: string): AgentReply => ({
  implementer_status: 'blocked',
  current_milestone_id: id,
  current_milestone_kind: 'normal',
  milestone_files_changed: [],
  milestone_test_files: [],
  implementation_artifact_url: `http://art/impl-${id}`,
  implementation_summary: 'could not complete',
  blockers: [{ summary: 'missing infra' }],
});
const validatorPass = (id: string, state: Record<string, string>): AgentReply => ({
  milestone_validation_passed: true,
  current_milestone_id: id,
  current_milestone_kind: 'normal',
  milestone_state: { ...state, [id]: 'complete' },
  validator_artifact_url: `http://art/val-${id}`,
  milestone_validation_failures: [],
  validator_feedback: '',
});
const validatorFail = (id: string): AgentReply => ({
  milestone_validation_passed: false,
  current_milestone_id: id,
  current_milestone_kind: 'normal',
  milestone_state: { [id]: 'in_progress' },
  validator_artifact_url: `http://art/val-${id}`,
  milestone_validation_failures: [{ requirement_id: 'AC-001', issue: 'x', expected_fix: 'y' }],
  validator_feedback: 'fix this',
});
const finalValPass: AgentReply = {
  implementation_valid: true,
  final_validator_artifact_url: 'http://art/finalval',
  final_validation_failures: [],
};
const finalValFail = (id: string): AgentReply => ({
  implementation_valid: false,
  current_milestone_kind: 'final_repair',
  current_milestone_id: id,
  current_milestone: { id, scope: 'fix global issues' },
  final_validator_artifact_url: 'http://art/finalval',
  final_validation_failures: [{ requirement_id: 'AC-099', issue: 'cross-cutting bug' }],
  milestone_state: {},
});
const PR_OK: AgentReply = {
  pr_url: 'http://pr/1',
  commit_hash: 'abc123',
  branch_name: 'feature/x',
  pr_status: 'created',
  pr_error: '',
};
const SUMMARY_OK: AgentReply = {
  final_summary_artifact_url: 'http://art/summary',
  workflow_result: 'success',
};

// ────────────────────────────────────────────────────────────────────────
// Scenarios
// ────────────────────────────────────────────────────────────────────────

describe('milestone — happy paths', () => {
  it('single-milestone happy path', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [implReady('MS-001')],
      milestone_validator: [validatorPass('MS-001', { 'MS-001': 'in_progress' })],
      final_implementation_validator: [finalValPass],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual([
      'load_implementation_context', 'create_workspace', 'milestone_planner',
      'select_next_milestone', 'milestone_implementer', 'milestone_validator',
      'select_next_milestone', 'final_implementation_validator',
      'pr_creator', 'final_summary',
    ]);
  });

  it('three-milestone cycle, all pass, all complete', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectPending('MS-002'),
        selectPending('MS-003'),
        selectAllComplete({ 'MS-001': 'complete', 'MS-002': 'complete', 'MS-003': 'complete' }),
      ],
      milestone_implementer: [implReady('MS-001'), implReady('MS-002'), implReady('MS-003')],
      milestone_validator: [
        validatorPass('MS-001', {}),
        validatorPass('MS-002', { 'MS-001': 'complete' }),
        validatorPass('MS-003', { 'MS-001': 'complete', 'MS-002': 'complete' }),
      ],
      final_implementation_validator: [finalValPass],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'milestone_implementer').length).toBe(3);
    expect(r.visited.filter((n) => n === 'milestone_validator').length).toBe(3);
    expect(r.visited.filter((n) => n === 'final_implementation_validator').length).toBe(1);
  });
});

describe('milestone — implementer blocked', () => {
  it('implementer blocks → escalation_review → abandon', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [selectPending('MS-001')],
      milestone_implementer: [implBlocked('MS-001')],
      milestone_escalation_review: [{ escalation_decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('milestone_escalation_review');
    expect(r.visited.indexOf('milestone_validator')).toBe(-1);
  });

  it('implementer blocks → escalation_review → retry_with_feedback → implementer (success)', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [
        implBlocked('MS-001'),
        implReady('MS-001'),
      ],
      milestone_escalation_review: [{ escalation_decision: 'retry_with_feedback', escalation_feedback: 'try harder' }],
      milestone_validator: [validatorPass('MS-001', {})],
      final_implementation_validator: [finalValPass],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('milestone_escalation_review');
    expect(r.visited[escIdx + 1]).toBe('milestone_implementer');
  });
});

describe('milestone — validator failure loops', () => {
  it('validator fail → implementer retry → validator pass', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [implReady('MS-001'), implReady('MS-001')],
      milestone_validator: [
        validatorFail('MS-001'),
        validatorPass('MS-001', {}),
      ],
      final_implementation_validator: [finalValPass],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'milestone_implementer').length).toBe(2);
    expect(r.visited.filter((n) => n === 'milestone_validator').length).toBe(2);
  });

  it('validator fail exhaustion (3rd fail) → escalation_review', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [selectPending('MS-001')],
      milestone_implementer: [implReady('MS-001'), implReady('MS-001'), implReady('MS-001')],
      milestone_validator: [
        validatorFail('MS-001'),
        validatorFail('MS-001'),
        validatorFail('MS-001'),
      ],
      milestone_escalation_review: [{ escalation_decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('milestone_escalation_review');
    expect(r.finalState.__retry_exhausted_from).toBe('milestone_validator');
  });

  it('validator exhaustion → escalation_review → retry_with_feedback → implementer → validator pass', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [
        implReady('MS-001'), implReady('MS-001'), implReady('MS-001'), // 3 visits feeding 3 failing validators
        implReady('MS-001'), // 4th visit after override
      ],
      milestone_validator: [
        validatorFail('MS-001'),
        validatorFail('MS-001'),
        validatorFail('MS-001'),
        validatorPass('MS-001', {}),
      ],
      milestone_escalation_review: [{ escalation_decision: 'retry_with_feedback', escalation_feedback: 'really try' }],
      final_implementation_validator: [finalValPass],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('milestone_escalation_review');
    expect(r.visited[escIdx + 1]).toBe('milestone_implementer');
  });

  it('validator exhaustion → escalation_review → force_continue → select_next_milestone', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      // Override force-continues past MS-001, then selector finds no more pending → all_complete
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'skipped' }),
      ],
      milestone_implementer: [implReady('MS-001'), implReady('MS-001'), implReady('MS-001')],
      milestone_validator: [
        validatorFail('MS-001'),
        validatorFail('MS-001'),
        validatorFail('MS-001'),
      ],
      milestone_escalation_review: [{ escalation_decision: 'force_continue' }],
      final_implementation_validator: [finalValPass],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('milestone_escalation_review');
    expect(r.visited[escIdx + 1]).toBe('select_next_milestone');
  });
});

describe('milestone — final validator', () => {
  it('final validator fail → implementer (final_repair) → final validator pass → pr_creator', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [
        implReady('MS-001', 'normal'),
        implReady('FINAL-REPAIR-1', 'final_repair'),
      ],
      milestone_validator: [validatorPass('MS-001', {})],
      final_implementation_validator: [
        finalValFail('FINAL-REPAIR-1'),
        finalValPass,
      ],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');

    // Verify the final_repair routing — implementer with kind=final_repair
    // routes back to final_implementation_validator, NOT milestone_validator.
    expect(r.visited.filter((n) => n === 'final_implementation_validator').length).toBe(2);
    expect(r.visited.filter((n) => n === 'milestone_implementer').length).toBe(2);
    expect(r.visited.filter((n) => n === 'milestone_validator').length).toBe(1);

    // Confirm the second implementer visit was followed by final_validator
    // (not milestone_validator).
    const implementerIndices = r.visited
      .map((n, i) => (n === 'milestone_implementer' ? i : -1))
      .filter((i) => i >= 0);
    expect(r.visited[implementerIndices[1] + 1]).toBe('final_implementation_validator');
  });

  it('final validator fail exhaustion (3rd fail) → escalation_review', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [
        implReady('MS-001', 'normal'),
        implReady('FINAL-REPAIR-1', 'final_repair'),
        implReady('FINAL-REPAIR-2', 'final_repair'),
        implReady('FINAL-REPAIR-3', 'final_repair'),
      ],
      milestone_validator: [validatorPass('MS-001', {})],
      final_implementation_validator: [
        finalValFail('FINAL-REPAIR-1'),
        finalValFail('FINAL-REPAIR-2'),
        finalValFail('FINAL-REPAIR-3'),
      ],
      milestone_escalation_review: [{ escalation_decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('milestone_escalation_review');
    expect(r.finalState.__retry_exhausted_from).toBe('final_implementation_validator');
  });

  it('final exhaustion → escalation_review → retry_with_feedback → implementer (final_repair)', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [
        implReady('MS-001', 'normal'),
        implReady('FINAL-REPAIR-1', 'final_repair'),
        implReady('FINAL-REPAIR-2', 'final_repair'),
        implReady('FINAL-REPAIR-3', 'final_repair'),
        implReady('FINAL-REPAIR-4', 'final_repair'),
      ],
      milestone_validator: [validatorPass('MS-001', {})],
      final_implementation_validator: [
        finalValFail('FINAL-REPAIR-1'),
        finalValFail('FINAL-REPAIR-2'),
        finalValFail('FINAL-REPAIR-3'),
        finalValPass,
      ],
      milestone_escalation_review: [{ escalation_decision: 'retry_with_feedback', escalation_feedback: 'one more try' }],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('milestone_escalation_review');
    expect(r.visited[escIdx + 1]).toBe('milestone_implementer');
  });

  it('final exhaustion → escalation_review → force_continue → pr_creator', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [
        implReady('MS-001', 'normal'),
        implReady('FINAL-REPAIR-1', 'final_repair'),
        implReady('FINAL-REPAIR-2', 'final_repair'),
        implReady('FINAL-REPAIR-3', 'final_repair'),
      ],
      milestone_validator: [validatorPass('MS-001', {})],
      final_implementation_validator: [
        finalValFail('FINAL-REPAIR-1'),
        finalValFail('FINAL-REPAIR-2'),
        finalValFail('FINAL-REPAIR-3'),
      ],
      milestone_escalation_review: [{ escalation_decision: 'force_continue' }],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('milestone_escalation_review');
    expect(r.visited[escIdx + 1]).toBe('pr_creator');
  });
});

describe('milestone — selector blocked', () => {
  it('select_next blocked → escalation_review → abandon', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [selectBlocked],
      milestone_escalation_review: [{ escalation_decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual([
      'load_implementation_context', 'create_workspace', 'milestone_planner',
      'select_next_milestone', 'milestone_escalation_review',
    ]);
  });

  it('select_next blocked → escalation_review → force_continue → final_implementation_validator', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [selectBlocked],
      milestone_escalation_review: [{ escalation_decision: 'force_continue' }],
      final_implementation_validator: [finalValPass],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('milestone_escalation_review');
    expect(r.visited[escIdx + 1]).toBe('final_implementation_validator');
  });
});

describe('milestone — passthrough state shape', () => {
  it('resolved_*_artifact_url survives through to pr_creator state', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [implReady('MS-001')],
      milestone_validator: [validatorPass('MS-001', {})],
      final_implementation_validator: [finalValPass],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.finalState.resolved_prd_artifact_url).toBe('http://art/prd');
    expect(r.finalState.resolved_tdd_artifact_url).toBe('http://art/tdd');
    expect(r.finalState.pr_url).toBe('http://pr/1');
    expect(r.finalState.final_summary_artifact_url).toBe('http://art/summary');
  });

  it('current_milestone_kind=final_repair set by final_validator drives next routing decision', () => {
    const r = simulate(workflow, {
      load_implementation_context: [CTX_OK],
      milestone_planner: [PLAN_OK],
      select_next_milestone: [
        selectPending('MS-001'),
        selectAllComplete({ 'MS-001': 'complete' }),
      ],
      milestone_implementer: [
        implReady('MS-001', 'normal'),
        implReady('FINAL-REPAIR-1', 'final_repair'),
      ],
      milestone_validator: [validatorPass('MS-001', {})],
      final_implementation_validator: [
        finalValFail('FINAL-REPAIR-1'),
        finalValPass,
      ],
      pr_creator: [PR_OK],
      final_summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    // After the first implementer visit (kind=normal), routing should go
    // to milestone_validator. After the second visit (kind=final_repair),
    // routing should go to final_implementation_validator.
    const implementerIndices = r.visited
      .map((n, i) => (n === 'milestone_implementer' ? i : -1))
      .filter((i) => i >= 0);
    expect(r.visited[implementerIndices[0] + 1]).toBe('milestone_validator');
    expect(r.visited[implementerIndices[1] + 1]).toBe('final_implementation_validator');
  });
});
