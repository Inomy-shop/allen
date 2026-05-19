/**
 * Simulation tests for feature-plan-and-implement.yml.
 *
 * Two layers:
 *   1. validateWorkflow — confirms the YAML loads with zero errors.
 *   2. Scenario simulator — replays the engine's edge-selection + retry
 *      semantics deterministically: each scenario scripts what each node
 *      "returns", and the simulator walks edges using the real
 *      condition-parser. Asserts the visited node sequence per scenario.
 *
 * The simulator mirrors `engine.getNextNodes()` semantics that matter for
 * routing-only validation:
 *   - condition evaluation via the real evaluateCondition()
 *   - per-edge retry counters; exhaustion sets __retry_exhausted_from
 *   - retry-edge match dedupes to a single next-node target
 *   - human-node outputs are merged from the scenario script
 *   - code-node (create_workspace) emits canned workspace primitives
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
const WORKFLOW_PATH = join(__dirname, '..', 'workflows', 'feature-plan-and-implement.yml');

// Synthetic agent + built-in registry — the validator only checks NAME
// existence, not config. Every agent referenced by the workflow:
const AGENTS: Record<string, AgentDef> = Object.fromEntries(
  [
    'requirements-analyst',
    'doc-auditor',
    'technical-designer',
    'engineering-lead',
    'qa-lead',
    'implementation-validator',
    'documentation-writer',
    'code-reviewer',
    'pr-creator',
  ].map((name) => [name, { system: 'stub' } satisfies AgentDef]),
);

const EXPECTED_AGENTS = [
  'code-reviewer',
  'doc-auditor',
  'documentation-writer',
  'engineering-lead',
  'implementation-validator',
  'pr-creator',
  'qa-lead',
  'requirements-analyst',
  'technical-designer',
].sort();
const BUILT_INS = ['create-workspace'];

let workflow: WorkflowDef;

beforeAll(() => {
  const text = readFileSync(WORKFLOW_PATH, 'utf-8');
  workflow = yaml.load(text) as WorkflowDef;
});

// ────────────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────────────

describe('feature-plan-and-implement.yml — validator', () => {
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

  it('removed legacy nodes (clarify, produce_hla, audit_hla, implementation_self_check)', () => {
    expect(workflow.nodes.clarify).toBeUndefined();
    expect(workflow.nodes.produce_hla).toBeUndefined();
    expect(workflow.nodes.audit_hla).toBeUndefined();
    expect(workflow.nodes.implementation_self_check).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────
// Simulator
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

/**
 * Step the simulator one node at a time.
 *
 * Edge selection model matches the engine for routing-only purposes:
 *   1. Collect all edges with from===current.
 *   2. Split into retry edges (max_retries set) and non-retry edges.
 *   3. For retry edges whose condition is true: if counter < max_retries,
 *      increment and fire that edge (returns its `to`). __retry_exhausted_from
 *      stays unset.
 *   4. If all matching retry edges are exhausted, set
 *      __retry_exhausted_from=<source node name> and re-scan non-retry edges.
 *   5. For non-retry edges whose condition is true (or unconditional): fire
 *      the first match.
 *
 * Multiple matching non-retry edges with the same target dedupe naturally
 * (first match wins; targets are checked individually).
 */
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

      // Inject "node output" into state.
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

    // Find candidate edges
    const fromName = current === 'START' ? 'START' : current;
    const candidates = wf.edges.filter((e) => e.from === fromName);
    if (!candidates.length) {
      return { visited, finalState: state, ended: 'STUCK' };
    }

    const retryEdges = candidates.filter((e) => typeof e.max_retries === 'number');
    const plainEdges = candidates.filter((e) => typeof e.max_retries !== 'number');

    // Helper: evaluate condition; an absent condition is true.
    const matches = (e: EdgeDef): boolean => (e.condition ? evaluateCondition(e.condition, state) : true);

    // Mirror engine.ts:2090-2102: human-override re-route edges (no
    // max_retries, with retry_context) clear __retry_exhausted_from and
    // reset retry counters whose destinations match the override target.
    const clearExhaustionFor = (targetNode: string): void => {
      delete state.__retry_exhausted_from;
      for (const key of [...retryCounts.keys()]) {
        const arrow = key.indexOf('→');
        if (arrow < 0) continue;
        if (key.slice(arrow + 1) === targetNode) retryCounts.delete(key);
      }
    };

    // 1. Try retry edges first.
    let nextNode: string | null = null;
    let firedRetry = false;
    for (const e of retryEdges) {
      if (!matches(e)) continue;
      const key = edgeKey(e);
      const count = retryCounts.get(key) ?? 0;
      const limit = e.max_retries as number;
      if (count >= limit) {
        // Exhausted this retry edge. Mark and try next candidate.
        state.__retry_exhausted_from = e.from as string;
        continue;
      }
      retryCounts.set(key, count + 1);
      // Apply retry_context if present (we don't render it; just record it).
      if (e.retry_context) state.retry_context = String(e.retry_context);
      nextNode = e.to as string;
      firedRetry = true;
      // Clear stale exhaustion when a fresh retry fires.
      delete state.__retry_exhausted_from;
      break;
    }

    if (!firedRetry) {
      // 2. Plain edges. Pick the first matching one.
      for (const e of plainEdges) {
        if (!matches(e)) continue;
        nextNode = e.to as string;
        // Human-override re-route edges clear exhaustion + reset counters.
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

const INPUT = { user_request: 'Add bookmarks', repo_path: '/repo', trusted_mode: false, skip_regression: false };

// Canonical "happy" replies — reused across many scenarios.
const PRD_READY: AgentReply = { ready_to_produce_prd: true, clarifying_questions: [], prd_artifact_url: 'http://art/prd' };
const PRD_APPROVE: AgentReply = { prd_audit_verdict: 'approve', prd_audit_rationale: 'looks good' };
const TDD_OK: AgentReply = { tdd_artifact_url: 'http://art/tdd' };
const TDD_APPROVE: AgentReply = { tdd_audit_verdict: 'approve', tdd_audit_rationale: 'looks good' };
const GATE_APPROVE: AgentReply = { decision: 'approve' };
const IMPL_PASS: AgentReply = {
  implement_verdict: 'pass',
  implementation_plan_artifact_url: 'http://art/plan',
  implement_failure_details: '',
};
const QA_PASS: AgentReply = { qa_verdict: 'pass', qa_artifact_url: 'http://art/qa', qa_failure_details: '' };
const VAL_OK: AgentReply = { prd_satisfied: true, validator_artifact_url: 'http://art/val' };
const DOCS_OK: AgentReply = {};
const REVIEW_OK: AgentReply = { review_verdict: 'APPROVED', code_review_artifact_url: 'http://art/rev' };
const PR_OK: AgentReply = { pr_url: 'http://pr/1' };
const SUMMARY_OK: AgentReply = { summary_artifact_url: 'http://art/sum' };

// ────────────────────────────────────────────────────────────────────────
// Happy path
// ────────────────────────────────────────────────────────────────────────

describe('feature-plan-and-implement — happy paths', () => {
  it('happy path with plan_approval_gate=approve', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY],
      audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK],
      audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS],
      qa: [QA_PASS],
      implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK],
      code_review: [REVIEW_OK],
      open_pr: [PR_OK],
      summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual([
      'produce_prd', 'audit_prd', 'produce_tdd', 'audit_tdd', 'plan_approval_gate',
      'create_workspace', 'implement', 'qa', 'implementation_validator',
      'update_docs', 'code_review', 'open_pr', 'summary',
    ]);
  });

  it('trusted_mode=true skips plan_approval_gate', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY],
      audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK],
      audit_tdd: [TDD_APPROVE],
      implement: [IMPL_PASS],
      qa: [QA_PASS],
      implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK],
      code_review: [REVIEW_OK],
      open_pr: [PR_OK],
      summary: [SUMMARY_OK],
    }, { ...INPUT, trusted_mode: true });
    expect(r.ended).toBe('END');
    expect(r.visited).not.toContain('plan_approval_gate');
    expect(r.visited[4]).toBe('create_workspace');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Clarification loop
// ────────────────────────────────────────────────────────────────────────

describe('clarification rounds', () => {
  it('1 clarification round, then PRD produced', () => {
    const r = simulate(workflow, {
      produce_prd: [
        { ready_to_produce_prd: false, clarifying_questions: ['q1?'], prd_artifact_url: '' },
        PRD_READY,
      ],
      clarify_human: [{ answers: 'A1' }],
      audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.slice(0, 4)).toEqual(['produce_prd', 'clarify_human', 'produce_prd', 'audit_prd']);
  });

  it('3 clarification rounds, all answered, then PRD produced (budget OK)', () => {
    const r = simulate(workflow, {
      produce_prd: [
        { ready_to_produce_prd: false, clarifying_questions: ['q1?'], prd_artifact_url: '' },
        { ready_to_produce_prd: false, clarifying_questions: ['q2?'], prd_artifact_url: '' },
        { ready_to_produce_prd: false, clarifying_questions: ['q3?'], prd_artifact_url: '' },
        PRD_READY,
      ],
      clarify_human: [{ answers: 'A1' }, { answers: 'A2' }, { answers: 'A3' }],
      audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const prdVisits = r.visited.filter((n) => n === 'produce_prd').length;
    const humanVisits = r.visited.filter((n) => n === 'clarify_human').length;
    expect(prdVisits).toBe(4); // first ask + 3 retries
    expect(humanVisits).toBe(3);
  });

  it('clarify_human exhaustion (4th attempt) routes to escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [
        { ready_to_produce_prd: false, clarifying_questions: ['q1?'], prd_artifact_url: '' },
        { ready_to_produce_prd: false, clarifying_questions: ['q2?'], prd_artifact_url: '' },
        { ready_to_produce_prd: false, clarifying_questions: ['q3?'], prd_artifact_url: '' },
        { ready_to_produce_prd: false, clarifying_questions: ['q4?'], prd_artifact_url: '' },
      ],
      clarify_human: [{ answers: 'A1' }, { answers: 'A2' }, { answers: 'A3' }, { answers: 'A4' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
    // After the 3 clarify retries are spent, the next attempt sets
    // __retry_exhausted_from='clarify_human' and the fallback edge fires.
    // The flag stays set through escalation_review → END (no fresh retry).
    expect(r.finalState.__retry_exhausted_from).toBe('clarify_human');
  });
});

// ────────────────────────────────────────────────────────────────────────
// PRD audit
// ────────────────────────────────────────────────────────────────────────

describe('PRD audit retries and escalation', () => {
  it('PRD audit revise → produce_prd → approve advances', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY, PRD_READY],
      audit_prd: [
        { prd_audit_verdict: 'revise', prd_audit_rationale: 'fix x' },
        PRD_APPROVE,
      ],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'produce_prd').length).toBe(2);
    expect(r.visited.filter((n) => n === 'audit_prd').length).toBe(2);
  });

  it('PRD audit revise exhaustion (3rd revise) → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY, PRD_READY, PRD_READY],
      audit_prd: [
        { prd_audit_verdict: 'revise', prd_audit_rationale: 'r1' },
        { prd_audit_verdict: 'revise', prd_audit_rationale: 'r2' },
        { prd_audit_verdict: 'revise', prd_audit_rationale: 'r3' },
      ],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });

  it('PRD audit escalate → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY],
      audit_prd: [{ prd_audit_verdict: 'escalate', prd_audit_rationale: 'stuck' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual(['produce_prd', 'audit_prd', 'escalation_review']);
  });
});

// ────────────────────────────────────────────────────────────────────────
// TDD audit
// ────────────────────────────────────────────────────────────────────────

describe('TDD audit retries and escalation', () => {
  it('TDD audit revise → produce_tdd → approve advances', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK, TDD_OK],
      audit_tdd: [
        { tdd_audit_verdict: 'revise', tdd_audit_rationale: 'fix' },
        TDD_APPROVE,
      ],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'produce_tdd').length).toBe(2);
  });

  it('TDD audit revise exhaustion → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK, TDD_OK, TDD_OK],
      audit_tdd: [
        { tdd_audit_verdict: 'revise', tdd_audit_rationale: 'r1' },
        { tdd_audit_verdict: 'revise', tdd_audit_rationale: 'r2' },
        { tdd_audit_verdict: 'revise', tdd_audit_rationale: 'r3' },
      ],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });

  it('TDD audit escalate → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK],
      audit_tdd: [{ tdd_audit_verdict: 'escalate', tdd_audit_rationale: 'stuck' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('escalation_review');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plan approval gate
// ────────────────────────────────────────────────────────────────────────

describe('plan_approval_gate', () => {
  it('reject → END immediately', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [{ decision: 'reject' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited[r.visited.length - 1]).toBe('plan_approval_gate');
    expect(r.visited).not.toContain('create_workspace');
  });

  it('request_changes scope=requirements → produce_prd', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY, PRD_READY],
      audit_prd: [PRD_APPROVE, PRD_APPROVE],
      produce_tdd: [TDD_OK, TDD_OK],
      audit_tdd: [TDD_APPROVE, TDD_APPROVE],
      plan_approval_gate: [{ decision: 'request_changes', scope: 'requirements', feedback: 'redo PRD' }, GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'produce_prd').length).toBe(2);
  });

  it('request_changes scope=technical_design → produce_tdd', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK, TDD_OK],
      audit_tdd: [TDD_APPROVE, TDD_APPROVE],
      plan_approval_gate: [{ decision: 'request_changes', scope: 'technical_design', feedback: 'redo TDD' }, GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'produce_tdd').length).toBe(2);
    expect(r.visited.filter((n) => n === 'produce_prd').length).toBe(1);
  });

  it('request_changes scope=all → produce_prd (full redesign)', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY, PRD_READY],
      audit_prd: [PRD_APPROVE, PRD_APPROVE],
      produce_tdd: [TDD_OK, TDD_OK],
      audit_tdd: [TDD_APPROVE, TDD_APPROVE],
      plan_approval_gate: [{ decision: 'request_changes', scope: 'all', feedback: 'all over' }, GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'produce_prd').length).toBe(2);
  });

  it('request_changes exhaustion (3rd time) → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY, PRD_READY, PRD_READY],
      audit_prd: [PRD_APPROVE, PRD_APPROVE, PRD_APPROVE],
      produce_tdd: [TDD_OK, TDD_OK, TDD_OK],
      audit_tdd: [TDD_APPROVE, TDD_APPROVE, TDD_APPROVE],
      plan_approval_gate: [
        { decision: 'request_changes', scope: 'requirements', feedback: 'r1' },
        { decision: 'request_changes', scope: 'requirements', feedback: 'r2' },
        { decision: 'request_changes', scope: 'requirements', feedback: 'r3' },
      ],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// implement node
// ────────────────────────────────────────────────────────────────────────

describe('implement node retries and escalation', () => {
  it('implement fail → self-retry → pass advances', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [
        { implement_verdict: 'fail', implementation_plan_artifact_url: 'http://art/plan', implement_failure_details: 'missing AC-3' },
        IMPL_PASS,
      ],
      qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'implement').length).toBe(2);
  });

  it('implement fail exhaustion (3rd fail) → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [
        { implement_verdict: 'fail', implementation_plan_artifact_url: 'http://art/plan', implement_failure_details: 'f1' },
        { implement_verdict: 'fail', implementation_plan_artifact_url: 'http://art/plan', implement_failure_details: 'f2' },
        { implement_verdict: 'fail', implementation_plan_artifact_url: 'http://art/plan', implement_failure_details: 'f3' },
      ],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });

  it('implement escalate → escalation_review immediately', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [{ implement_verdict: 'escalate', implementation_plan_artifact_url: 'http://art/plan', implement_failure_details: 'unrecoverable' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'implement').length).toBe(1);
    expect(r.visited.includes('escalation_review')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// QA, validator, code_review back-loops
// ────────────────────────────────────────────────────────────────────────

describe('QA, validator, and code review back-loops', () => {
  it('qa fail → implement → qa pass advances', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS, IMPL_PASS],
      qa: [
        { qa_verdict: 'fail', qa_artifact_url: 'http://art/qa', qa_failure_details: 'tests red' },
        QA_PASS,
      ],
      implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'implement').length).toBe(2);
    expect(r.visited.filter((n) => n === 'qa').length).toBe(2);
  });

  it('qa fail exhaustion → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS, IMPL_PASS, IMPL_PASS],
      qa: [
        { qa_verdict: 'fail', qa_artifact_url: 'http://art/qa', qa_failure_details: 'f1' },
        { qa_verdict: 'fail', qa_artifact_url: 'http://art/qa', qa_failure_details: 'f2' },
        { qa_verdict: 'fail', qa_artifact_url: 'http://art/qa', qa_failure_details: 'f3' },
      ],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });

  it('qa escalate → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS],
      qa: [{ qa_verdict: 'escalate', qa_artifact_url: 'http://art/qa', qa_failure_details: 'stuck' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });

  it('validator prd_satisfied=false → implement loop → satisfied advances', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS, IMPL_PASS],
      qa: [QA_PASS, QA_PASS],
      implementation_validator: [
        { prd_satisfied: false, validator_artifact_url: 'http://art/val' },
        VAL_OK,
      ],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'implementation_validator').length).toBe(2);
  });

  it('validator exhaustion → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS, IMPL_PASS, IMPL_PASS],
      qa: [QA_PASS, QA_PASS, QA_PASS],
      implementation_validator: [
        { prd_satisfied: false, validator_artifact_url: 'http://art/val' },
        { prd_satisfied: false, validator_artifact_url: 'http://art/val' },
        { prd_satisfied: false, validator_artifact_url: 'http://art/val' },
      ],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });

  it('code_review REQUEST_CHANGES → implement loop → APPROVED advances', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS, IMPL_PASS],
      qa: [QA_PASS, QA_PASS],
      implementation_validator: [VAL_OK, VAL_OK],
      update_docs: [DOCS_OK, DOCS_OK],
      code_review: [
        { review_verdict: 'REQUEST_CHANGES', code_review_artifact_url: 'http://art/rev' },
        REVIEW_OK,
      ],
      open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'code_review').length).toBe(2);
    expect(r.visited.filter((n) => n === 'implement').length).toBe(2);
  });

  it('code_review exhaustion → escalation_review', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS, IMPL_PASS, IMPL_PASS],
      qa: [QA_PASS, QA_PASS, QA_PASS],
      implementation_validator: [VAL_OK, VAL_OK, VAL_OK],
      update_docs: [DOCS_OK, DOCS_OK, DOCS_OK],
      code_review: [
        { review_verdict: 'REQUEST_CHANGES', code_review_artifact_url: 'http://art/rev' },
        { review_verdict: 'REQUEST_CHANGES', code_review_artifact_url: 'http://art/rev' },
        { review_verdict: 'REQUEST_CHANGES', code_review_artifact_url: 'http://art/rev' },
      ],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Escalation review decisions
// ────────────────────────────────────────────────────────────────────────

describe('escalation_review decisions', () => {
  it('abandon → END', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY],
      audit_prd: [{ prd_audit_verdict: 'escalate', prd_audit_rationale: 'x' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited[r.visited.length - 1]).toBe('escalation_review');
  });

  it('retry_with_feedback from PRD-audit escalate → produce_prd', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY, PRD_READY],
      audit_prd: [
        { prd_audit_verdict: 'escalate', prd_audit_rationale: 'x' },
        PRD_APPROVE,
      ],
      escalation_review: [{ decision: 'retry_with_feedback', feedback: 'try again' }],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    // After escalation, PM is invoked again
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('produce_prd');
  });

  it('retry_with_feedback from TDD-audit escalate → produce_tdd', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK, TDD_OK],
      audit_tdd: [
        { tdd_audit_verdict: 'escalate', tdd_audit_rationale: 'x' },
        TDD_APPROVE,
      ],
      escalation_review: [{ decision: 'retry_with_feedback', feedback: 'try again' }],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('produce_tdd');
  });

  it('retry_with_feedback from implement escalate → implement', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [
        { implement_verdict: 'escalate', implementation_plan_artifact_url: 'http://art/plan', implement_failure_details: 'stuck' },
        IMPL_PASS,
      ],
      escalation_review: [{ decision: 'retry_with_feedback', feedback: 'try again' }],
      qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('implement');
  });

  it('override_and_continue from PRD-audit escalate → produce_tdd', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY],
      audit_prd: [{ prd_audit_verdict: 'escalate', prd_audit_rationale: 'x' }],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('produce_tdd');
  });

  it('override_and_continue from TDD-audit escalate → plan_approval_gate (non-trusted)', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK],
      audit_tdd: [{ tdd_audit_verdict: 'escalate', tdd_audit_rationale: 'x' }],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('plan_approval_gate');
  });

  it('override_and_continue from TDD-audit escalate with trusted_mode → create_workspace', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK],
      audit_tdd: [{ tdd_audit_verdict: 'escalate', tdd_audit_rationale: 'x' }],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, { ...INPUT, trusted_mode: true });
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('create_workspace');
  });

  it('override_and_continue from implement → qa', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [{ implement_verdict: 'escalate', implementation_plan_artifact_url: 'http://art/plan', implement_failure_details: 'x' }],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('qa');
  });

  it('override_and_continue from qa → implementation_validator', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS],
      qa: [{ qa_verdict: 'escalate', qa_artifact_url: 'http://art/qa', qa_failure_details: 'x' }],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('implementation_validator');
  });

  it('override_and_continue from validator exhaustion → update_docs', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS, IMPL_PASS, IMPL_PASS],
      qa: [QA_PASS, QA_PASS, QA_PASS],
      implementation_validator: [
        { prd_satisfied: false, validator_artifact_url: 'http://art/val' },
        { prd_satisfied: false, validator_artifact_url: 'http://art/val' },
        { prd_satisfied: false, validator_artifact_url: 'http://art/val' },
      ],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('update_docs');
  });

  it('override_and_continue from code_review REQUEST_CHANGES exhaustion → open_pr', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY], audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS, IMPL_PASS, IMPL_PASS],
      qa: [QA_PASS, QA_PASS, QA_PASS],
      implementation_validator: [VAL_OK, VAL_OK, VAL_OK],
      update_docs: [DOCS_OK, DOCS_OK, DOCS_OK],
      code_review: [
        { review_verdict: 'REQUEST_CHANGES', code_review_artifact_url: 'http://art/rev' },
        { review_verdict: 'REQUEST_CHANGES', code_review_artifact_url: 'http://art/rev' },
        { review_verdict: 'REQUEST_CHANGES', code_review_artifact_url: 'http://art/rev' },
      ],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('open_pr');
  });

  it('override_and_continue from plan_approval_gate exhaustion → create_workspace', () => {
    const r = simulate(workflow, {
      produce_prd: [PRD_READY, PRD_READY, PRD_READY],
      audit_prd: [PRD_APPROVE, PRD_APPROVE, PRD_APPROVE],
      produce_tdd: [TDD_OK, TDD_OK, TDD_OK],
      audit_tdd: [TDD_APPROVE, TDD_APPROVE, TDD_APPROVE],
      plan_approval_gate: [
        { decision: 'request_changes', scope: 'requirements', feedback: 'r1' },
        { decision: 'request_changes', scope: 'requirements', feedback: 'r2' },
        { decision: 'request_changes', scope: 'requirements', feedback: 'r3' },
      ],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('create_workspace');
  });

  it('override_and_continue from clarify exhaustion → produce_prd', () => {
    const r = simulate(workflow, {
      produce_prd: [
        { ready_to_produce_prd: false, clarifying_questions: ['q1?'], prd_artifact_url: '' },
        { ready_to_produce_prd: false, clarifying_questions: ['q2?'], prd_artifact_url: '' },
        { ready_to_produce_prd: false, clarifying_questions: ['q3?'], prd_artifact_url: '' },
        { ready_to_produce_prd: false, clarifying_questions: ['q4?'], prd_artifact_url: '' },
        PRD_READY,
      ],
      clarify_human: [{ answers: 'A1' }, { answers: 'A2' }, { answers: 'A3' }, { answers: 'A4' }],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      audit_prd: [PRD_APPROVE],
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('produce_prd');
  });
});
