// Tests for the deterministic reliability calibrator (pure functions — no DB).
// All scores produce advisory ReliabilityLabels only; they do not make pass/fail decisions.

import { describe, it, expect } from 'vitest';
import {
  calibrateReliabilityLabel,
  calibrateScores,
  aggregateReliabilityLabel,
  RELIABILITY_THRESHOLDS,
} from '../../../services/context/judge/deterministic-reliability-calibrator.js';

// ─── calibrateReliabilityLabel ──────────────────────────────────────────────

describe('calibrateReliabilityLabel — boundary conditions', () => {
  it('score = 0.80 (exact confirmed boundary) → confirmed', () => {
    expect(calibrateReliabilityLabel(0.80)).toBe('confirmed');
  });

  it('score = 0.90 (above confirmed threshold) → confirmed', () => {
    expect(calibrateReliabilityLabel(0.90)).toBe('confirmed');
  });

  it('score = 1.0 (maximum) → confirmed', () => {
    expect(calibrateReliabilityLabel(1.0)).toBe('confirmed');
  });

  it('score = 0.79 (just below confirmed boundary) → needs_judge', () => {
    expect(calibrateReliabilityLabel(0.79)).toBe('needs_judge');
  });

  it('score = 0.50 (exact needs_judge boundary) → needs_judge', () => {
    expect(calibrateReliabilityLabel(0.50)).toBe('needs_judge');
  });

  it('score = 0.49 (just above signal_only boundary) → signal_only', () => {
    expect(calibrateReliabilityLabel(0.49)).toBe('signal_only');
  });

  it('score = 0.20 (exact signal_only boundary) → signal_only', () => {
    expect(calibrateReliabilityLabel(0.20)).toBe('signal_only');
  });

  it('score = 0.19 (just below signal_only boundary) → rejected', () => {
    expect(calibrateReliabilityLabel(0.19)).toBe('rejected');
  });

  it('score = 0 → rejected', () => {
    expect(calibrateReliabilityLabel(0)).toBe('rejected');
  });

  it('score = -0.1 (negative edge case) → rejected', () => {
    expect(calibrateReliabilityLabel(-0.1)).toBe('rejected');
  });
});

describe('calibrateReliabilityLabel — RELIABILITY_THRESHOLDS constants match behaviour', () => {
  it('threshold values are as documented', () => {
    expect(RELIABILITY_THRESHOLDS.confirmed).toBe(0.80);
    expect(RELIABILITY_THRESHOLDS.needs_judge).toBe(0.50);
    expect(RELIABILITY_THRESHOLDS.signal_only).toBe(0.20);
  });

  it('score exactly at each threshold produces the correct upper label (advisory-only)', () => {
    // Advisory: calibration only maps scores to labels — no pass/fail gate
    expect(calibrateReliabilityLabel(RELIABILITY_THRESHOLDS.confirmed)).toBe('confirmed');
    expect(calibrateReliabilityLabel(RELIABILITY_THRESHOLDS.needs_judge)).toBe('needs_judge');
    expect(calibrateReliabilityLabel(RELIABILITY_THRESHOLDS.signal_only)).toBe('signal_only');
  });
});

// ─── calibrateScores ────────────────────────────────────────────────────────

describe('calibrateScores', () => {
  it('empty array → empty array', () => {
    expect(calibrateScores([])).toEqual([]);
  });

  it('single dimension gets a label', () => {
    const result = calibrateScores([{ dimension: 'precision', rawScore: 0.75 }]);
    expect(result).toHaveLength(1);
    expect(result[0].dimension).toBe('precision');
    expect(result[0].rawScore).toBe(0.75);
    expect(result[0].reliabilityLabel).toBe('needs_judge');
  });

  it('multiple dimensions each get their own label', () => {
    const result = calibrateScores([
      { dimension: 'precision', rawScore: 0.85 },
      { dimension: 'completeness', rawScore: 0.55 },
      { dimension: 'usefulness', rawScore: 0.15 },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].reliabilityLabel).toBe('confirmed');
    expect(result[1].reliabilityLabel).toBe('needs_judge');
    expect(result[2].reliabilityLabel).toBe('rejected');
  });

  it('labels match individual calibrateReliabilityLabel() calls (advisory consistency)', () => {
    const inputs = [
      { dimension: 'a', rawScore: 0.95 },
      { dimension: 'b', rawScore: 0.60 },
      { dimension: 'c', rawScore: 0.30 },
      { dimension: 'd', rawScore: 0.10 },
    ];
    const result = calibrateScores(inputs);
    for (let i = 0; i < inputs.length; i++) {
      expect(result[i].reliabilityLabel).toBe(
        calibrateReliabilityLabel(inputs[i].rawScore),
      );
    }
  });

  it('preserves dimension name and rawScore in output', () => {
    const result = calibrateScores([{ dimension: 'my_dim', rawScore: 0.42 }]);
    expect(result[0].dimension).toBe('my_dim');
    expect(result[0].rawScore).toBe(0.42);
  });
});

// ─── calibrateReliabilityFromConfidence (Fix 6) ──────────────────────────────

import { calibrateReliabilityFromConfidence } from '../../../services/context/judge/deterministic-reliability-calibrator.js';

describe('calibrateReliabilityFromConfidence — prevents high-confidence signal_only regression', () => {
  it('confidence=0.90 → confirmed (should NOT be signal_only)', () => {
    expect(calibrateReliabilityFromConfidence(0.90)).toBe('confirmed');
  });

  it('confidence=0.80 → confirmed (exact boundary)', () => {
    expect(calibrateReliabilityFromConfidence(0.80)).toBe('confirmed');
  });

  it('confidence=0.79 → needs_judge', () => {
    expect(calibrateReliabilityFromConfidence(0.79)).toBe('needs_judge');
  });

  it('confidence=0.50 → needs_judge (boundary)', () => {
    expect(calibrateReliabilityFromConfidence(0.50)).toBe('needs_judge');
  });

  it('confidence=0.49 → signal_only', () => {
    expect(calibrateReliabilityFromConfidence(0.49)).toBe('signal_only');
  });

  it('confidence=0.20 → signal_only (boundary)', () => {
    expect(calibrateReliabilityFromConfidence(0.20)).toBe('signal_only');
  });

  it('confidence=0.19 → rejected', () => {
    expect(calibrateReliabilityFromConfidence(0.19)).toBe('rejected');
  });

  it('matches calibrateReliabilityLabel (same thresholds)', () => {
    const inputs = [0.95, 0.80, 0.75, 0.50, 0.45, 0.20, 0.15, 0.0];
    for (const c of inputs) {
      expect(calibrateReliabilityFromConfidence(c)).toBe(calibrateReliabilityLabel(c));
    }
  });
});

// ─── aggregateReliabilityLabel ───────────────────────────────────────────────

describe('aggregateReliabilityLabel', () => {
  it('empty array → signal_only (conservative default)', () => {
    expect(aggregateReliabilityLabel([])).toBe('signal_only');
  });

  it('single high score (0.9) → confirmed', () => {
    expect(aggregateReliabilityLabel([{ rawScore: 0.9 }])).toBe('confirmed');
  });

  it('[0.9, 0.3] → signal_only (weakest link = 0.3)', () => {
    expect(aggregateReliabilityLabel([{ rawScore: 0.9 }, { rawScore: 0.3 }])).toBe('signal_only');
  });

  it('[0.9, 0.6] → needs_judge (weakest link = 0.6)', () => {
    expect(aggregateReliabilityLabel([{ rawScore: 0.9 }, { rawScore: 0.6 }])).toBe('needs_judge');
  });

  it('[0.9, 0.85, 0.82] → confirmed (all above confirmed threshold)', () => {
    expect(
      aggregateReliabilityLabel([
        { rawScore: 0.9 },
        { rawScore: 0.85 },
        { rawScore: 0.82 },
      ]),
    ).toBe('confirmed');
  });

  it('all below 0.20 → rejected', () => {
    expect(
      aggregateReliabilityLabel([{ rawScore: 0.10 }, { rawScore: 0.05 }]),
    ).toBe('rejected');
  });

  it('aggregation uses min — even one low score pulls down the result', () => {
    // This verifies the advisory nature: weakest link strategy is conservative
    expect(
      aggregateReliabilityLabel([
        { rawScore: 0.99 },
        { rawScore: 0.99 },
        { rawScore: 0.19 },  // rejected tier
      ]),
    ).toBe('rejected');
  });
});
