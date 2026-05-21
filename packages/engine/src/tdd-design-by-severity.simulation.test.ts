/**
 * Simulation tests for tdd-design-by-severity.yml.
 *
 * The workflow consumes a user-supplied requirement and produces only the
 * TDD (no PRD generation). Severity routing:
 *   small  → simple_tdd_design → validator
 *   medium → 2 TDD proposals → tdd_finalizer → validator
 *   large  → 3 TDD proposals → tdd_finalizer → validator
 *
 * Validator failure auto-retries up to 2 attempts back to tdd_finalizer
 * (handles small-lane MODE B by revising the simple TDD). After
 * exhaustion, design_escalation_review takes over.
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
const WORKFLOW_PATH = join(__dirname, '..', 'workflows', 'tdd-design-by-severity.yml');

const AGENTS: Record<string, AgentDef> = Object.fromEntries(
  [
    'codebase-navigator',
    'technical-designer',
    'solution-architect',
    'implementation-validator',
  ].map((name) => [name, { system: 'stub' } satisfies AgentDef]),
);

const EXPECTED_AGENTS = [
  'codebase-navigator',
  'implementation-validator',
  'solution-architect',
  'technical-designer',
].sort();
const BUILT_INS: string[] = [];

let workflow: WorkflowDef;

beforeAll(() => {
  const text = readFileSync(WORKFLOW_PATH, 'utf-8');
  workflow = yaml.load(text) as WorkflowDef;
});

// ────────────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────────────

describe('tdd-design-by-severity.yml — validator', () => {
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

  it('removed PRD-creation nodes (prd_finalizer, prd_proposal_*, simple_design_and_tdd, prd_human_clarification, validator_failure_human, tdd_proposal_files_impact)', () => {
    expect(workflow.nodes.prd_finalizer).toBeUndefined();
    expect(workflow.nodes.prd_proposal_user_flow).toBeUndefined();
    expect(workflow.nodes.prd_proposal_technical_feasibility).toBeUndefined();
    expect(workflow.nodes.prd_proposal_business_scope).toBeUndefined();
    expect(workflow.nodes.simple_design_and_tdd).toBeUndefined();
    expect(workflow.nodes.prd_human_clarification).toBeUndefined();
    expect(workflow.nodes.validator_failure_human).toBeUndefined();
    expect(workflow.nodes.tdd_proposal_files_impact).toBeUndefined();
  });

  it('exposes the expected 10 nodes', () => {
    expect(Object.keys(workflow.nodes).sort()).toEqual([
      'codebase_grounding',
      'design_escalation_review',
      'implementation_readiness_validator',
      'severity_classification_human',
      'simple_tdd_design',
      'tdd_finalizer',
      'tdd_human_clarification',
      'tdd_proposal_data_schema',
      'tdd_proposal_flow',
      'tdd_proposal_system_design',
    ]);
  });

  it('START edge points to codebase_grounding', () => {
    const startEdges = workflow.edges.filter((e) =>
      (Array.isArray(e.from) ? e.from : [e.from]).includes('START'),
    );
    expect(startEdges).toHaveLength(1);
    expect(startEdges[0].to).toBe('codebase_grounding');
  });

  it('validator failure retry edge has max_retries=2 and targets tdd_finalizer', () => {
    const failEdge = workflow.edges.find(
      (e) =>
        e.from === 'implementation_readiness_validator' &&
        e.to === 'tdd_finalizer' &&
        typeof e.max_retries === 'number',
    );
    expect(failEdge).toBeDefined();
    expect(failEdge?.max_retries).toBe(2);
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
    // Edges may have `from` as an array (fan-in). In the real engine the
    // join only fires when all source branches are ready; in this linear
    // simulator we evaluate join edges as "source set contains current".
    const candidates = wf.edges.filter((e) => {
      const froms = Array.isArray(e.from) ? e.from : [e.from];
      return froms.includes(fromName);
    });
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
          // Parallel fan-out: visit every target except the last in this
          // step (the main loop will visit the last one normally). State
          // accumulates so the downstream join edge sees outputs from
          // every branch.
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

// ────────────────────────────────────────────────────────────────────────
// Canonical inputs and replies
// ────────────────────────────────────────────────────────────────────────

const INPUT_BASE = {
  requirement: 'Add a 7-day usage-history view to the dashboard.',
  repo_path: '/repo',
  product_context: '',
  size_override: 'auto',
};

const GROUNDING_OK = (severity: 'small' | 'medium' | 'large'): AgentReply => ({
  codebase_grounding_artifact_url: 'http://art/grounding',
  affected_modules_index: ['src/dashboard'],
  repo_stack_summary: 'node/express/mongo',
  prior_design_doc_urls: [],
  severity,
  triage_rationale: `Picked ${severity}.`,
  override_applied: false,
});

const GROUNDING_INVALID: AgentReply = {
  codebase_grounding_artifact_url: 'http://art/grounding',
  affected_modules_index: ['src/dashboard'],
  repo_stack_summary: 'node/express/mongo',
  prior_design_doc_urls: [],
  severity: 'huge', // invalid → routes to severity_classification_human
  triage_rationale: 'Could not decide.',
  override_applied: false,
};

const SIMPLE_TDD_OK: AgentReply = {
  simple_tdd_artifact_url: 'http://art/simple-tdd',
  scope_creep_detected: false,
  severity: 'small',
};

const SIMPLE_TDD_SCOPE_CREEP: AgentReply = {
  simple_tdd_artifact_url: 'http://art/simple-tdd-aborted',
  scope_creep_detected: true,
  severity: 'medium',
};

const PROP_SCHEMA_OK: AgentReply = {
  tdd_data_schema_artifact_url: 'http://art/schema',
  tdd_data_schema_summary: 'schema',
};
const PROP_SYSTEM_OK: AgentReply = {
  tdd_system_design_artifact_url: 'http://art/system',
  tdd_system_design_summary: 'system',
};
const PROP_FLOW_OK: AgentReply = {
  tdd_flow_artifact_url: 'http://art/flow',
  tdd_flow_summary: 'flow',
  has_ui: true,
};

const FINALIZER_OK: AgentReply = {
  tdd_needs_clarification: false,
  tdd_clarification_questions: [],
  tdd_finalizer_gaps: [],
  tdd_finalizer_conflicts: [],
  tdd_self_critique_findings: [],
  tdd_finalizer_decision_artifact_url: 'http://art/fin-decision',
  final_tdd_artifact_url: 'http://art/final-tdd',
  final_tdd_coverage_matrix: {},
  final_tdd_uncovered_requirements: [],
};

const FINALIZER_NEEDS_CLARIF: AgentReply = {
  tdd_needs_clarification: true,
  tdd_clarification_questions: ['Which timezone?'],
  tdd_finalizer_gaps: ['timezone'],
  tdd_finalizer_conflicts: [],
  tdd_self_critique_findings: [],
  tdd_finalizer_decision_artifact_url: 'http://art/fin-decision',
  final_tdd_artifact_url: '',
  final_tdd_coverage_matrix: {},
  final_tdd_uncovered_requirements: [],
};

const HUMAN_CLARIF_OK: AgentReply = {
  tdd_clarification_answers: 'Use UTC.',
  tdd_extra_notes: '',
};

const VALIDATOR_READY: AgentReply = {
  ready_for_implementation: true,
  implementation_readiness_verdict: 'ready',
  implementation_readiness_blockers: [],
  implementation_readiness_risks: [],
  implementation_readiness_scope_findings: [],
  implementation_problem_statement: 'Build the view.',
  implementation_final_tdd_artifact_url: 'http://art/final-tdd',
  implementation_simple_tdd_artifact_url: '',
  implementation_agent_handoff_prompt: 'Implement…',
  implementation_readiness_handoff_artifact_url: 'http://art/handoff',
};

const VALIDATOR_NOT_READY: AgentReply = {
  ready_for_implementation: false,
  implementation_readiness_verdict: 'blocked',
  implementation_readiness_blockers: ['REQ-001 not covered'],
  implementation_readiness_risks: [],
  implementation_readiness_scope_findings: [],
  implementation_problem_statement: '',
  implementation_final_tdd_artifact_url: '',
  implementation_simple_tdd_artifact_url: '',
  implementation_agent_handoff_prompt: '',
  implementation_readiness_handoff_artifact_url: 'http://art/handoff',
};

// ────────────────────────────────────────────────────────────────────────
// Happy paths — small / medium / large
// ────────────────────────────────────────────────────────────────────────

describe('happy paths by severity', () => {
  it('small severity: grounding → simple_tdd_design → validator → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('small')],
      simple_tdd_design: [SIMPLE_TDD_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual([
      'codebase_grounding',
      'simple_tdd_design',
      'implementation_readiness_validator',
    ]);
  });

  it('medium severity: grounding → 2 proposals → tdd_finalizer → validator → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('codebase_grounding');
    expect(r.visited).toContain('tdd_proposal_data_schema');
    expect(r.visited).toContain('tdd_proposal_system_design');
    expect(r.visited).not.toContain('tdd_proposal_flow');
    expect(r.visited).toContain('tdd_finalizer');
    expect(r.visited[r.visited.length - 1]).toBe('implementation_readiness_validator');
  });

  it('large severity: grounding → 3 proposals → tdd_finalizer → validator → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('large')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_proposal_flow: [PROP_FLOW_OK],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('tdd_proposal_flow');
    expect(r.visited).toContain('tdd_finalizer');
    expect(r.visited[r.visited.length - 1]).toBe('implementation_readiness_validator');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Invalid severity → human fallback
// ────────────────────────────────────────────────────────────────────────

describe('severity_classification_human fallback', () => {
  it('invalid severity → severity_classification_human → routes by human answer', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_INVALID],
      severity_classification_human: [{ severity: 'small' }],
      simple_tdd_design: [SIMPLE_TDD_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('severity_classification_human');
    expect(r.visited).toContain('simple_tdd_design');
  });

  it('human picks medium severity → 2-proposal lane runs', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_INVALID],
      severity_classification_human: [{ severity: 'medium' }],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('tdd_proposal_data_schema');
    expect(r.visited).not.toContain('tdd_proposal_flow');
  });
});

// ────────────────────────────────────────────────────────────────────────
// TDD clarification loop
// ────────────────────────────────────────────────────────────────────────

describe('tdd_human_clarification retries and escalation', () => {
  it('one clarification round → resolves → validator → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_NEEDS_CLARIF, FINALIZER_OK],
      tdd_human_clarification: [HUMAN_CLARIF_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'tdd_finalizer').length).toBe(2);
    expect(r.visited).toContain('tdd_human_clarification');
  });

  it('clarification exhausted (3rd retry) → design_escalation_review → abandon', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_NEEDS_CLARIF, FINALIZER_NEEDS_CLARIF, FINALIZER_NEEDS_CLARIF],
      tdd_human_clarification: [HUMAN_CLARIF_OK, HUMAN_CLARIF_OK, HUMAN_CLARIF_OK],
      design_escalation_review: [{ escalation_decision: 'abandon', escalation_feedback: 'give up' }],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('design_escalation_review');
    expect(r.finalState.__retry_exhausted_from).toBe('tdd_human_clarification');
  });

  it('clarification exhausted → escalation retry_with_feedback → tdd_finalizer resolves → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_NEEDS_CLARIF, FINALIZER_NEEDS_CLARIF, FINALIZER_NEEDS_CLARIF, FINALIZER_OK],
      tdd_human_clarification: [HUMAN_CLARIF_OK, HUMAN_CLARIF_OK, HUMAN_CLARIF_OK],
      design_escalation_review: [{ escalation_decision: 'retry_with_feedback', escalation_feedback: 'try harder' }],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('design_escalation_review');
    expect(r.visited[r.visited.length - 1]).toBe('implementation_readiness_validator');
  });

  it('clarification exhausted → escalation force_continue → validator → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_NEEDS_CLARIF, FINALIZER_NEEDS_CLARIF, FINALIZER_NEEDS_CLARIF],
      tdd_human_clarification: [HUMAN_CLARIF_OK, HUMAN_CLARIF_OK, HUMAN_CLARIF_OK],
      design_escalation_review: [{ escalation_decision: 'force_continue', escalation_feedback: 'ship it' }],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('design_escalation_review');
    expect(r.visited[r.visited.length - 1]).toBe('implementation_readiness_validator');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Validator failure auto-retry to tdd_finalizer (max_retries=2)
// ────────────────────────────────────────────────────────────────────────

describe('validator failure auto-retry to tdd_finalizer', () => {
  it('1st fail → tdd_finalizer revises → 2nd pass → END (medium)', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_OK, FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'implementation_readiness_validator').length).toBe(2);
    expect(r.visited.filter((n) => n === 'tdd_finalizer').length).toBe(2);
  });

  it('2 fails (uses both retries) → tdd_finalizer → 3rd pass → END (large)', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('large')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_proposal_flow: [PROP_FLOW_OK],
      tdd_finalizer: [FINALIZER_OK, FINALIZER_OK, FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_NOT_READY, VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'implementation_readiness_validator').length).toBe(3);
    expect(r.visited.filter((n) => n === 'tdd_finalizer').length).toBe(3);
  });

  it('3 fails (retries exhausted) → design_escalation_review → abandon → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_OK, FINALIZER_OK, FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_NOT_READY, VALIDATOR_NOT_READY],
      design_escalation_review: [{ escalation_decision: 'abandon', escalation_feedback: 'give up' }],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('design_escalation_review');
    expect(r.finalState.__retry_exhausted_from).toBe('implementation_readiness_validator');
  });

  it('validator exhausted → escalation retry_with_feedback → tdd_finalizer → validator passes → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_OK, FINALIZER_OK, FINALIZER_OK, FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_NOT_READY, VALIDATOR_NOT_READY, VALIDATOR_READY],
      design_escalation_review: [{ escalation_decision: 'retry_with_feedback', escalation_feedback: 'fix REQ-001' }],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('design_escalation_review');
    expect(r.visited[r.visited.length - 1]).toBe('implementation_readiness_validator');
  });

  it('validator exhausted → escalation force_continue → END (ship as-is)', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_OK, FINALIZER_OK, FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_NOT_READY, VALIDATOR_NOT_READY],
      design_escalation_review: [{ escalation_decision: 'force_continue', escalation_feedback: 'ship' }],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited[r.visited.length - 1]).toBe('design_escalation_review');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Small-lane MODE B: validator failure routes to tdd_finalizer (not back
// to simple_tdd_design). tdd_finalizer detects MODE B from inputs.
// ────────────────────────────────────────────────────────────────────────

describe('small-lane MODE B (tdd_finalizer revises simple TDD on validator failure)', () => {
  it('small lane: simple_tdd → validator fail → tdd_finalizer → validator pass → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('small')],
      simple_tdd_design: [SIMPLE_TDD_OK],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toEqual([
      'codebase_grounding',
      'simple_tdd_design',
      'implementation_readiness_validator',
      'tdd_finalizer',
      'implementation_readiness_validator',
    ]);
    // simple_tdd_design must NOT be revisited (the retry goes to
    // tdd_finalizer regardless of severity).
    expect(r.visited.filter((n) => n === 'simple_tdd_design').length).toBe(1);
  });

  it('small lane: validator exhausts → escalation retry → tdd_finalizer (not simple_tdd_design)', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('small')],
      simple_tdd_design: [SIMPLE_TDD_OK],
      tdd_finalizer: [FINALIZER_OK, FINALIZER_OK, FINALIZER_OK, FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_NOT_READY, VALIDATOR_NOT_READY, VALIDATOR_READY],
      design_escalation_review: [{ escalation_decision: 'retry_with_feedback', escalation_feedback: 'fix' }],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    // Only one simple_tdd_design visit; all retries go via tdd_finalizer.
    expect(r.visited.filter((n) => n === 'simple_tdd_design').length).toBe(1);
    expect(r.visited.filter((n) => n === 'tdd_finalizer').length).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Scope-creep auto-upgrade: small lane drafter sets
// scope_creep_detected=true AND severity='medium' → re-routes to the
// medium proposal lane instead of going to the validator.
// ────────────────────────────────────────────────────────────────────────

describe('scope_creep_detected auto-upgrades small → medium proposals', () => {
  it('grounding=small → simple_tdd reports scope creep → 2 proposals → finalizer → validator → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('small')],
      simple_tdd_design: [SIMPLE_TDD_SCOPE_CREEP],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    // The simple drafter ran, the medium proposals ran, but the small
    // validator path was NOT taken on the first pass — the auto-upgrade
    // fired instead.
    expect(r.visited).toContain('simple_tdd_design');
    expect(r.visited).toContain('tdd_proposal_data_schema');
    expect(r.visited).toContain('tdd_proposal_system_design');
    expect(r.visited).not.toContain('tdd_proposal_flow'); // medium, not large
    expect(r.visited).toContain('tdd_finalizer');
    expect(r.finalState.severity).toBe('medium');
  });

  it('scope_creep_detected=false → normal small lane (no proposals)', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('small')],
      simple_tdd_design: [SIMPLE_TDD_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).not.toContain('tdd_proposal_data_schema');
    expect(r.visited).not.toContain('tdd_finalizer');
    expect(r.visited).toEqual([
      'codebase_grounding',
      'simple_tdd_design',
      'implementation_readiness_validator',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// More edge cases surfaced by the audit fixes
// ────────────────────────────────────────────────────────────────────────

describe('size_override honored (codebase_grounding pass-through)', () => {
  // Triage emits whichever severity the user override said to use.
  // The simulator just verifies the lane that follows matches.
  it('size_override=large → 3-proposal large lane runs', () => {
    const r = simulate(workflow, {
      codebase_grounding: [{ ...GROUNDING_OK('large'), override_applied: true }],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_proposal_flow: [PROP_FLOW_OK],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, { ...INPUT_BASE, size_override: 'large' });
    expect(r.ended).toBe('END');
    expect(r.finalState.override_applied).toBe(true);
    expect(r.visited).toContain('tdd_proposal_flow');
  });

  it('size_override=small → simple_tdd_design lane runs', () => {
    const r = simulate(workflow, {
      codebase_grounding: [{ ...GROUNDING_OK('small'), override_applied: true }],
      simple_tdd_design: [SIMPLE_TDD_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, { ...INPUT_BASE, size_override: 'small' });
    expect(r.ended).toBe('END');
    expect(r.finalState.override_applied).toBe(true);
    expect(r.visited).toContain('simple_tdd_design');
  });
});

describe('large lane: backend-only feature (has_ui=false)', () => {
  it('tdd_proposal_flow emits has_ui=false → finalizer/validator still pass', () => {
    const FLOW_NO_UI: AgentReply = {
      tdd_flow_artifact_url: 'http://art/flow-noui',
      tdd_flow_summary: 'backend-only: no UI section',
      has_ui: false,
    };
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('large')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_proposal_flow: [FLOW_NO_UI],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.finalState.has_ui).toBe(false);
    expect(r.visited).toContain('tdd_proposal_flow');
  });
});

describe('scope-creep upgrade + validator failure → MODE A (not MODE B)', () => {
  it('small → scope_creep → proposals → finalizer → validator FAIL → finalizer retry (MODE A, proposals still set) → validator OK', () => {
    // After the upgrade, proposal URLs are populated, so the
    // tdd_finalizer should detect MODE A — not MODE B — even though
    // simple_tdd_artifact_url is also set in state from the aborted
    // small-lane draft.
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('small')],
      simple_tdd_design: [SIMPLE_TDD_SCOPE_CREEP],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_OK, FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.finalState.severity).toBe('medium');
    // Proposal URLs remain set in state — the finalizer's MODE A check
    // (simple_tdd set AND proposals empty) is false because proposals
    // are set.
    expect(r.finalState.tdd_data_schema_artifact_url).toBeTruthy();
    expect(r.finalState.tdd_system_design_artifact_url).toBeTruthy();
    expect(r.finalState.simple_tdd_artifact_url).toBeTruthy();
    expect(r.visited.filter((n) => n === 'tdd_finalizer').length).toBe(2);
    expect(r.visited.filter((n) => n === 'implementation_readiness_validator').length).toBe(2);
  });
});

describe('two clarification rounds (at the retry cap) then resolves', () => {
  it('finalizer needs clarif x2 → human x2 → resolves → validator → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_NEEDS_CLARIF, FINALIZER_NEEDS_CLARIF, FINALIZER_OK],
      tdd_human_clarification: [HUMAN_CLARIF_OK, HUMAN_CLARIF_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'tdd_human_clarification').length).toBe(2);
    expect(r.visited.filter((n) => n === 'tdd_finalizer').length).toBe(3);
  });
});

describe('combined edge case: clarification + later validator failure + recovery', () => {
  it('1 clarif round → resolves → validator FAIL → finalizer revises → validator OK → END', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('medium')],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_finalizer: [FINALIZER_NEEDS_CLARIF, FINALIZER_OK, FINALIZER_OK],
      tdd_human_clarification: [HUMAN_CLARIF_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited.filter((n) => n === 'tdd_human_clarification').length).toBe(1);
    expect(r.visited.filter((n) => n === 'tdd_finalizer').length).toBe(3);
    expect(r.visited.filter((n) => n === 'implementation_readiness_validator').length).toBe(2);
  });
});

describe('invalid severity + human picks large → 3-proposal lane', () => {
  it('grounding emits unknown severity → human picks large → 3 proposals run', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_INVALID],
      severity_classification_human: [{ severity: 'large' }],
      tdd_proposal_data_schema: [PROP_SCHEMA_OK],
      tdd_proposal_system_design: [PROP_SYSTEM_OK],
      tdd_proposal_flow: [PROP_FLOW_OK],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    expect(r.visited).toContain('severity_classification_human');
    expect(r.visited).toContain('tdd_proposal_flow');
    expect(r.finalState.severity).toBe('large');
  });
});

describe('validator failure on small lane uses MODE B (proposals empty)', () => {
  it('small lane validator fail → finalizer detects MODE B (proposals empty) → validator OK', () => {
    const r = simulate(workflow, {
      codebase_grounding: [GROUNDING_OK('small')],
      simple_tdd_design: [SIMPLE_TDD_OK],
      tdd_finalizer: [FINALIZER_OK],
      implementation_readiness_validator: [VALIDATOR_NOT_READY, VALIDATOR_READY],
    }, INPUT_BASE);
    expect(r.ended).toBe('END');
    // MODE B contract: simple_tdd set AND proposal URLs empty
    expect(r.finalState.simple_tdd_artifact_url).toBeTruthy();
    expect(r.finalState.tdd_data_schema_artifact_url).toBeFalsy();
    expect(r.finalState.tdd_system_design_artifact_url).toBeFalsy();
    // After MODE B, final_tdd_artifact_url is set (the validator's
    // precedence rule now reads this instead of the stale simple TDD).
    expect(r.finalState.final_tdd_artifact_url).toBeTruthy();
  });
});
