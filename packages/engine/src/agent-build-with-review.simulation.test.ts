/**
 * Regression tests for agent-build-with-review.yml.
 *
 * This workflow is allowed to be lean, but it must not regress to producing
 * merely safe/generic agent blueprints. The analysis, planner, and validator
 * prompts must preserve the core-job excellence gate from ALL-10.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateWorkflow } from './validator.js';
import type { WorkflowDef, AgentDef } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(__dirname, '..', 'workflows', 'agent-build-with-review.yml');

const AGENTS: Record<string, AgentDef> = Object.fromEntries(
  [
    'research-agent',
    'planner-agent',
    'agent-blueprint-validator',
    'agent-builder-agent',
  ].map((name) => [name, { system: 'stub' } satisfies AgentDef]),
);

let workflow: WorkflowDef;

beforeAll(() => {
  const text = readFileSync(WORKFLOW_PATH, 'utf-8');
  workflow = yaml.load(text) as WorkflowDef;
});

describe('agent-build-with-review.yml — core-job excellence gate', () => {
  it('passes engine validateWorkflow with zero errors', () => {
    const result = validateWorkflow(workflow, AGENTS, []);
    if (result.errors.length) {
      // eslint-disable-next-line no-console
      console.error('Validation errors:', result.errors);
    }
    expect(result.errors).toEqual([]);
  });

  it('analysis emits neutral task-adaptive doctrine inputs for expert role design', () => {
    const outputs = workflow.nodes.analyse_requirements.outputs ?? {};
    expect(outputs).toHaveProperty('core_job_doctrine');
    expect(outputs).toHaveProperty('instruction_guidance');
    expect(outputs).toHaveProperty('output_expectations');
    expect(outputs).toHaveProperty('validation_guidance');

    const prompt = workflow.nodes.analyse_requirements.prompt ?? '';
    expect(prompt).toContain('task-adaptive core job doctrine');
    expect(prompt).toContain('instruction guidance that fits the requested task');
    expect(prompt).toContain('do not force quality');
    expect(prompt).not.toContain('quality_bar');
    expect(prompt).not.toContain('expert_checklist');
    expect(prompt).not.toContain('evaluation_scenarios');
  });

  it('planner requires task-adaptive core-job-specific system prompts', () => {
    const prompt = workflow.nodes.plan_blueprint.prompt ?? '';
    expect(prompt).toContain('Core-job excellence is mandatory');
    expect(prompt).toContain('not merely name the role');
    expect(prompt).toContain('task-appropriate instruction structure');
    expect(prompt).toContain('Do not force every');
    expect(prompt).toContain('core job operational');
    expect(prompt).toContain('one-line role label');
    expect(prompt).toMatch(/concrete operating\s+instructions/);
    expect(prompt).toContain('thin request like');
  });

  it('validator blocks structurally valid but generic blueprints', () => {
    const outputs = workflow.nodes.validate_blueprint.outputs ?? {};
    expect(outputs).toHaveProperty('core_job_verdict');
    expect(outputs).toHaveProperty('core_job_validation_evidence');
    expect(outputs).toHaveProperty('generic_prompt_risks');

    const prompt = workflow.nodes.validate_blueprint.prompt ?? '';
    expect(prompt).toContain('task-appropriate instruction structure');
    expect(prompt).toMatch(/requested core job[\s\S]*concrete operating\s+instructions/);
    expect(prompt).toContain('not merely a role label');
    expect(prompt).toContain('optional aids such as checklists');
    expect(prompt).toContain('core_job_validation_evidence');
    expect(prompt).toContain('generic_prompt_risks');
    expect(prompt).toContain('too generic');
  });

  it('human review surfaces core-job validation evidence before creation', () => {
    const human = workflow.nodes.human_plan_review.human;
    expect(human?.highlights ?? []).toContain('Core job verdict: {{core_job_verdict}}');
    expect(human?.evidence ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Core-job validation evidence' }),
        expect.objectContaining({ label: 'Generic prompt risks' }),
      ]),
    );
  });

  it('agent builder enforces the same adaptive core-job gate before creation', () => {
    const prompt = workflow.nodes.create_agent.prompt ?? '';
    expect(prompt).toContain('CORE JOB VERDICT');
    expect(prompt).toContain('CORE-JOB VALIDATION EVIDENCE');
    expect(prompt).toContain('GENERIC PROMPT RISKS');
    expect(prompt).toContain('same core-job instruction gate enforced by planning');
    expect(prompt).toContain('task-appropriate');
    expect(prompt).toContain('not merely a role label');
    expect(prompt).toContain('captures the core');
    expect(prompt).toContain('creation_status');
    expect(prompt).toContain('does not repair');
  });
});
