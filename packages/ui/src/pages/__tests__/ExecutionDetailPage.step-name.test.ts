import { describe, expect, it } from 'vitest';
import { executionCostLabel, sentenceCaseStepName } from '../ExecutionDetailPage';

describe('sentenceCaseStepName', () => {
  it('uses sentence case instead of title case', () => {
    expect(sentenceCaseStepName('board_recovery')).toBe('Board recovery');
  });

  it('preserves known technical acronyms', () => {
    expect(sentenceCaseStepName('component_qc')).toBe('Component QC');
    expect(sentenceCaseStepName('run_api_qa')).toBe('Run API QA');
  });
});

describe('executionCostLabel', () => {
  it('keeps failed and missing-cost runs explicitly provisional', () => {
    expect(executionCostLabel('failed', 0)).toBe('cost so far');
    expect(executionCostLabel('failed', 1.25)).toBe('cost so far');
    expect(executionCostLabel('completed', 1.25)).toBe('run cost');
  });
});
