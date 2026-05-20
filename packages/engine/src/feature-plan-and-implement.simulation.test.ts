/**
 * Simulation tests for feature-plan-and-implement.yml (v3).
 *
 * The workflow now assumes a PRD is supplied as `user_request`. There are
 * no produce_prd / clarify_human / audit_prd nodes. TDD producer and
 * downstream nodes read the PRD directly from user_request.
 *
 * Two layers:
 *   1. validateWorkflow — confirms the YAML loads with zero errors.
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
const WORKFLOW_PATH = join(__dirname, '..', 'workflows', 'feature-plan-and-implement.yml');

const AGENTS: Record<string, AgentDef> = Object.fromEntries(
  [
    'technical-designer',
    'doc-auditor',
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

  it('removed PRD-related nodes (produce_prd, clarify_human, audit_prd)', () => {
    expect(workflow.nodes.produce_prd).toBeUndefined();
    expect(workflow.nodes.clarify_human).toBeUndefined();
    expect(workflow.nodes.audit_prd).toBeUndefined();
    // Plus the previously-removed nodes from earlier refactors:
    expect(workflow.nodes.clarify).toBeUndefined();
    expect(workflow.nodes.produce_hla).toBeUndefined();
    expect(workflow.nodes.audit_hla).toBeUndefined();
    expect(workflow.nodes.implementation_self_check).toBeUndefined();
  });

  it('START edge points directly to produce_tdd', () => {
    const startEdges = workflow.edges.filter((e) => e.from === 'START');
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0].to).toBe('produce_tdd');
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
  user_request: '## Requirements\nREQ-001: Add bookmarks.\n## ACs\nAC-001: ...',
  repo_path: '/repo',
  trusted_mode: false,
  skip_regression: false,
};

// Canonical replies
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
const DOCS_OK: AgentReply = { docs_updated: true };
const REVIEW_OK: AgentReply = { review_verdict: 'APPROVED', code_review_artifact_url: 'http://art/rev' };
const PR_OK: AgentReply = { pr_url: 'http://pr/1' };
const SUMMARY_OK: AgentReply = { summary_artifact_url: 'http://art/sum' };

// ────────────────────────────────────────────────────────────────────────
// Happy paths
// ────────────────────────────────────────────────────────────────────────

describe('feature-plan-and-implement — happy paths', () => {
  it('happy path with plan_approval_gate=approve', () => {
    const r = simulate(workflow, {
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
      'produce_tdd', 'audit_tdd', 'plan_approval_gate',
      'create_workspace', 'implement', 'qa', 'implementation_validator',
      'update_docs', 'code_review', 'open_pr', 'summary',
    ]);
  });

  it('trusted_mode=true skips plan_approval_gate', () => {
    const r = simulate(workflow, {
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
    expect(r.visited[2]).toBe('create_workspace');
  });
});

// ────────────────────────────────────────────────────────────────────────
// TDD audit
// ────────────────────────────────────────────────────────────────────────

describe('TDD audit retries and escalation', () => {
  it('TDD audit revise → produce_tdd → approve advances', () => {
    const r = simulate(workflow, {
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
    expect(r.finalState.__retry_exhausted_from).toBe('audit_tdd');
  });

  it('TDD audit escalate → escalation_review', () => {
    const r = simulate(workflow, {
      produce_tdd: [TDD_OK],
      audit_tdd: [{ tdd_audit_verdict: 'escalate', tdd_audit_rationale: 'stuck' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual(['produce_tdd', 'audit_tdd', 'escalation_review']);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plan approval gate
// ────────────────────────────────────────────────────────────────────────

describe('plan_approval_gate', () => {
  it('reject → END immediately', () => {
    const r = simulate(workflow, {
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [{ decision: 'reject' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited[r.visited.length - 1]).toBe('plan_approval_gate');
    expect(r.visited).not.toContain('create_workspace');
  });

  it('request_changes → produce_tdd loops back', () => {
    const r = simulate(workflow, {
      produce_tdd: [TDD_OK, TDD_OK],
      audit_tdd: [TDD_APPROVE, TDD_APPROVE],
      plan_approval_gate: [{ decision: 'request_changes', feedback: 'redo TDD' }, GATE_APPROVE],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'produce_tdd').length).toBe(2);
    expect(r.visited.filter((n) => n === 'plan_approval_gate').length).toBe(2);
  });

  it('request_changes exhaustion (3rd time) → escalation_review', () => {
    const r = simulate(workflow, {
      produce_tdd: [TDD_OK, TDD_OK, TDD_OK],
      audit_tdd: [TDD_APPROVE, TDD_APPROVE, TDD_APPROVE],
      plan_approval_gate: [
        { decision: 'request_changes', feedback: 'r1' },
        { decision: 'request_changes', feedback: 'r2' },
        { decision: 'request_changes', feedback: 'r3' },
      ],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('escalation_review');
    expect(r.finalState.__retry_exhausted_from).toBe('plan_approval_gate');
  });
});

// ────────────────────────────────────────────────────────────────────────
// implement node
// ────────────────────────────────────────────────────────────────────────

describe('implement node retries and escalation', () => {
  it('implement fail → self-retry → pass advances', () => {
    const r = simulate(workflow, {
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
      produce_tdd: [TDD_OK], audit_tdd: [TDD_APPROVE],
      plan_approval_gate: [GATE_APPROVE],
      implement: [{ implement_verdict: 'escalate', implementation_plan_artifact_url: 'http://art/plan', implement_failure_details: 'unrecoverable' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited.includes('escalation_review')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// QA, validator, code_review back-loops
// ────────────────────────────────────────────────────────────────────────

describe('QA, validator, and code review back-loops', () => {
  it('qa fail → implement → qa pass advances', () => {
    const r = simulate(workflow, {
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
      produce_tdd: [TDD_OK],
      audit_tdd: [{ tdd_audit_verdict: 'escalate', tdd_audit_rationale: 'x' }],
      escalation_review: [{ decision: 'abandon' }],
    }, INPUT);
    expect(r.ended).toBe('END');
    expect(r.visited[r.visited.length - 1]).toBe('escalation_review');
  });

  it('retry_with_feedback from TDD-audit escalate → produce_tdd', () => {
    const r = simulate(workflow, {
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

  it('override_and_continue from TDD-audit escalate → plan_approval_gate (non-trusted)', () => {
    const r = simulate(workflow, {
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
      produce_tdd: [TDD_OK, TDD_OK, TDD_OK],
      audit_tdd: [TDD_APPROVE, TDD_APPROVE, TDD_APPROVE],
      plan_approval_gate: [
        { decision: 'request_changes', feedback: 'r1' },
        { decision: 'request_changes', feedback: 'r2' },
        { decision: 'request_changes', feedback: 'r3' },
      ],
      escalation_review: [{ decision: 'override_and_continue', feedback: '' }],
      implement: [IMPL_PASS], qa: [QA_PASS], implementation_validator: [VAL_OK],
      update_docs: [DOCS_OK], code_review: [REVIEW_OK], open_pr: [PR_OK], summary: [SUMMARY_OK],
    }, INPUT);
    expect(r.ended).toBe('END');
    const escIdx = r.visited.indexOf('escalation_review');
    expect(r.visited[escIdx + 1]).toBe('create_workspace');
  });
});
