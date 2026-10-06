import { DomainError, invariant } from '../errors.ts';
import type { LifeEstimate, LifeModelInput } from '../types.ts';

function rng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
}

function normal(random: () => number): number {
  const u = Math.max(1e-12, random());
  const v = Math.max(1e-12, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function quantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

export function estimateRemainingLife(input: LifeModelInput): LifeEstimate {
  invariant(Number.isInteger(input.samples) && input.samples > 0, 'INVALID_SAMPLE_COUNT', 'Life sample count must be a positive integer');
  invariant(input.horizonHours > 0 && input.failureThreshold > 0, 'INVALID_LIFE_HORIZON', 'Life horizon and failure threshold must be positive');
  invariant(Math.abs(input.correlation[0][0] - 1) < 1e-9 && Math.abs(input.correlation[1][1] - 1) < 1e-9, 'INVALID_CORRELATION', 'Correlation diagonal must equal one');
  invariant(Math.abs(input.correlation[0][1]) < 1 && Math.abs(input.correlation[1][0]) < 1 && input.correlation[0][1] === input.correlation[1][0], 'INVALID_CORRELATION', 'Correlation matrix must be symmetric and bounded');
  const random = rng(input.seed);
  const life: number[] = [];
  const rejectedReasons: Record<string, number> = {};
  for (let sample = 0; sample < input.samples; sample += 1) {
    const z1 = normal(random);
    const z2 = normal(random);
    const correlated = input.correlation[0][1] * z1 + Math.sqrt(1 - input.correlation[0][1] ** 2) * z2;
    const rate = input.meanDegradationPerHour + input.deviation * (0.5 * z1 + 0.5 * correlated);
    if (!(rate > 0) || !Number.isFinite(rate)) { rejectedReasons.invalidDegradation = (rejectedReasons.invalidDegradation ?? 0) + 1; continue; }
    const stress = 1 + Math.max(0, input.temperatureStress) + Math.max(0, input.vibrationStress);
    const healthLoss = Math.max(0, 1 - input.initialHealth.compressorEfficiency) + Math.max(0, 1 - input.initialHealth.turbineFlowCapacity) + input.initialHealth.bearingFriction;
    const failureAt = (input.failureThreshold - healthLoss) / (rate * stress);
    if (!(failureAt > 0) || !Number.isFinite(failureAt)) { rejectedReasons.invalidLife = (rejectedReasons.invalidLife ?? 0) + 1; continue; }
    life.push(Math.min(input.horizonHours, failureAt));
  }
  life.sort((a, b) => a - b);
  const failedWithinHorizon = life.filter((hours) => hours < input.horizonHours).length;
  return { quantiles: { p05: quantile(life, 0.05), p50: quantile(life, 0.5), p95: quantile(life, 0.95) }, failureProbability: life.length ? failedWithinHorizon / life.length : 0, validSamples: life.length, rejectedSamples: input.samples - life.length, rejectedReasons };
}
