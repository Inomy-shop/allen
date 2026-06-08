// Maps raw deterministic evaluation scores → ReliabilityLabel
// This is advisory only — it does not make final decisions.
//
// Label thresholds (calibrated from DeepEval score distributions):
//   confirmed   : score >= 0.80
//   needs_judge : score >= 0.50 and < 0.80
//   signal_only : score >= 0.20 and < 0.50
//   rejected    : score < 0.20

import type { ReliabilityLabel, DeterministicScoreInput } from './context-judge.types.js';

export const RELIABILITY_THRESHOLDS = {
  confirmed: 0.80,
  needs_judge: 0.50,
  signal_only: 0.20,
} as const;

export function calibrateReliabilityLabel(rawScore: number): ReliabilityLabel {
  if (rawScore >= RELIABILITY_THRESHOLDS.confirmed) return 'confirmed';
  if (rawScore >= RELIABILITY_THRESHOLDS.needs_judge) return 'needs_judge';
  if (rawScore >= RELIABILITY_THRESHOLDS.signal_only) return 'signal_only';
  return 'rejected';
}

export function calibrateScores(
  inputs: DeterministicScoreInput[],
): Array<{ dimension: string; rawScore: number; reliabilityLabel: ReliabilityLabel }> {
  return inputs.map(({ dimension, rawScore }) => ({
    dimension,
    rawScore,
    reliabilityLabel: calibrateReliabilityLabel(rawScore),
  }));
}

// Derive an overall reliability label from multiple dimension scores
// Strategy: use the minimum score to be conservative (weakest link)
export function aggregateReliabilityLabel(
  scores: Array<{ rawScore: number }>,
): ReliabilityLabel {
  if (scores.length === 0) return 'signal_only';
  const minScore = Math.min(...scores.map((s) => s.rawScore));
  return calibrateReliabilityLabel(minScore);
}

/**
 * Derive a ReliabilityLabel from an agent-reported confidence value (0-1).
 * Used when no deterministic evaluation scores are available (LLM-only judge runs).
 *
 * This prevents high-confidence findings from being downgraded to 'signal_only'
 * when deterministic scores are absent. The mapping intentionally uses confidence
 * as a proxy for reliability, calibrated conservatively:
 *   confirmed   : confidence >= 0.80
 *   needs_judge : confidence >= 0.50
 *   signal_only : confidence >= 0.20
 *   rejected    : confidence < 0.20
 */
export function calibrateReliabilityFromConfidence(confidence: number): ReliabilityLabel {
  return calibrateReliabilityLabel(confidence);
}
