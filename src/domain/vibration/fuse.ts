import { DomainError, invariant } from '../errors.ts';
import type { FaultCandidate, VibrationEvidence } from '../types.ts';

function overlap(a: VibrationEvidence, b: VibrationEvidence): boolean {
  return Math.max(a.windowStartMs, b.windowStartMs) <= Math.min(a.windowEndMs, b.windowEndMs);
}

function independent(a: VibrationEvidence, b: VibrationEvidence): boolean {
  return a.sourceGroup !== b.sourceGroup && a.sensorId !== b.sensorId && !overlap(a, b);
}

export function diagnoseVibration(evidence: VibrationEvidence[], prior = 0.05): FaultCandidate[] {
  invariant(prior > 0 && prior < 1, 'INVALID_PRIOR', 'Fault prior must be between zero and one');
  const valid = evidence.map((item) => {
    invariant(item.windowEndMs > item.windowStartMs, 'INVALID_VIBRATION_WINDOW', 'Vibration window must have positive duration', { evidenceId: item.evidenceId });
    invariant(Number.isFinite(item.likelihoodRatio) && item.likelihoodRatio > 0, 'INVALID_LIKELIHOOD_RATIO', 'Likelihood ratio must be positive', { evidenceId: item.evidenceId });
    invariant(Number.isFinite(item.amplitude) && item.amplitude >= 0, 'INVALID_VIBRATION_AMPLITUDE', 'Vibration amplitude must be non-negative', { evidenceId: item.evidenceId });
    return item;
  });
  const representatives: VibrationEvidence[] = [];
  for (const item of [...valid].sort((a, b) => a.windowStartMs - b.windowStartMs || a.evidenceId.localeCompare(b.evidenceId))) {
    const duplicate = representatives.find((candidate) => candidate.fault === item.fault && !independent(candidate, item));
    if (!duplicate || item.quality === 'normal' && duplicate.quality === 'suspect') representatives.push(item);
  }
  const total = representatives.reduce((sum, item) => sum + Math.max(0, Math.log(item.likelihoodRatio)), 0);
  const byFault = new Map<string, VibrationEvidence[]>();
  for (const item of representatives) byFault.set(item.fault, [...(byFault.get(item.fault) ?? []), item]);
  return [...byFault.entries()].filter(([fault]) => fault !== 'unknown').map(([fault, items]) => {
    const score = items.reduce((sum, item) => sum + Math.log(item.likelihoodRatio), 0);
    const odds = prior / (1 - prior) * Math.exp(score);
    const posterior = odds / (1 + odds);
    const weighted = items.filter((item) => item.locationM !== undefined);
    const weight = weighted.reduce((sum, item) => sum + 1 / Math.max(1e-6, item.locationUncertaintyM ?? 1), 0);
    return { fault: fault as FaultCandidate['fault'], posterior: total ? posterior : prior, evidenceIds: items.map((item) => item.evidenceId), representativeWindow: { startMs: Math.min(...items.map((item) => item.windowStartMs)), endMs: Math.max(...items.map((item) => item.windowEndMs)) }, locationM: weight ? weighted.reduce((sum, item) => sum + item.locationM! / Math.max(1e-6, item.locationUncertaintyM ?? 1), 0) / weight : null, locationUncertaintyM: weight ? Math.sqrt(1 / weight) : null };
  }).sort((a, b) => b.posterior - a.posterior || a.fault.localeCompare(b.fault));
}
