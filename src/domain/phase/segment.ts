import { invariant } from '../errors.ts';
import type { CalibratedSample, EnginePhaseName, PhaseSegment } from '../types.ts';

const SHUTDOWN_RPM = 500;
const SLOPE_THRESHOLD = 0.25;
const MS_PER_SECOND = 1_000;

type RpmPoint = { time: number; rpm: number; fuel: number };

type PhasePiece = {
  phase: EnginePhaseName;
  startMs: number;
  endMs: number;
  startRpm: number;
  endRpm: number;
  peakRpm: number;
  endFuel: number;
  rpmSum: number;
  fuelSum: number;
  fuelSamples: number;
  samples: number;
  phaseDurations: Map<EnginePhaseName, number>;
};

function collectPoints(samples: CalibratedSample[]): RpmPoint[] {
  const byTime = new Map<number, RpmPoint>();
  for (const sample of samples) {
    const point = byTime.get(sample.sampleTimeMs) ?? { time: sample.sampleTimeMs, rpm: Number.NaN, fuel: Number.NaN };
    if (sample.sensor === 'rpm') point.rpm = sample.calibratedValue;
    if (sample.sensor === 'fuel-flow') point.fuel = sample.calibratedValue;
    byTime.set(sample.sampleTimeMs, point);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time).filter((point) => Number.isFinite(point.rpm));
}

function phaseForSlope(slope: number, rpm: number): EnginePhaseName {
  if (rpm < SHUTDOWN_RPM) return 'shutdown';
  if (slope > SLOPE_THRESHOLD) return 'acceleration';
  if (slope < -SLOPE_THRESHOLD) return 'deceleration';
  return 'steady';
}

function sampledSlope(previous: RpmPoint, point: RpmPoint): number {
  const elapsed = Math.max(1, point.time - previous.time);
  return (point.rpm - previous.rpm) / elapsed * MS_PER_SECOND;
}

function crossingFraction(startRpm: number, endRpm: number): number | null {
  const denominator = endRpm - startRpm;
  if (denominator === 0) return null;
  // Linear reconstruction is the unbiased estimator for one crossing between two samples.
  const fraction = (SHUTDOWN_RPM - startRpm) / denominator;
  return fraction > 0 && fraction < 1 ? fraction : null;
}

function interpolateValue(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}

function addSample(piece: PhasePiece, rpm: number, fuel: number): void {
  piece.samples += 1;
  piece.rpmSum += rpm;
  if (Number.isFinite(fuel)) {
    piece.fuelSamples += 1;
    piece.fuelSum += fuel;
  }
}

function makePiece(
  phase: EnginePhaseName,
  startMs: number,
  endMs: number,
  startRpm: number,
  endRpm: number,
  startFuel: number,
  endFuel: number,
  includeStartSample: boolean,
): PhasePiece {
  const durationMs = endMs - startMs;
  const piece: PhasePiece = {
    phase,
    startMs,
    endMs,
    startRpm,
    endRpm,
    peakRpm: Math.max(startRpm, endRpm),
    endFuel,
    rpmSum: 0,
    fuelSum: 0,
    fuelSamples: 0,
    samples: 0,
    phaseDurations: new Map(),
  };
  piece.phaseDurations.set(phase, durationMs);
  if (includeStartSample) addSample(piece, startRpm, startFuel);
  return piece;
}

function buildPieces(points: RpmPoint[]): PhasePiece[] {
  if (points.length === 1) {
    const [point] = points;
    const piece = makePiece(phaseForSlope(0, point.rpm), point.time, point.time, point.rpm, point.rpm, point.fuel, point.fuel, false);
    addSample(piece, point.rpm, point.fuel);
    return [piece];
  }

  const pieces: PhasePiece[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const durationMs = current.time - previous.time;
    invariant(durationMs > 0, 'INVALID_SAMPLE_TIME', 'RPM sample times must be strictly increasing');
    const slope = sampledSlope(previous, current);
    const fraction = crossingFraction(previous.rpm, current.rpm);
    if (fraction === null) {
      pieces.push(makePiece(phaseForSlope(slope, current.rpm), previous.time, current.time, previous.rpm, current.rpm, previous.fuel, current.fuel, true));
      continue;
    }

    const boundaryMs = previous.time + durationMs * fraction;
    const boundaryRpm = interpolateValue(previous.rpm, current.rpm, fraction);
    const boundaryFuel = Number.isFinite(previous.fuel) && Number.isFinite(current.fuel)
      ? interpolateValue(previous.fuel, current.fuel, fraction)
      : Number.NaN;
    pieces.push(makePiece(phaseForSlope(slope, previous.rpm), previous.time, boundaryMs, previous.rpm, boundaryRpm, previous.fuel, boundaryFuel, true));
    pieces.push(makePiece(phaseForSlope(slope, current.rpm), boundaryMs, current.time, boundaryRpm, current.rpm, boundaryFuel, current.fuel, false));
  }

  const finalPoint = points.at(-1)!;
  addSample(pieces.at(-1)!, finalPoint.rpm, finalPoint.fuel);
  return pieces;
}

function combinePhaseDurations(first: PhasePiece, second: PhasePiece): Map<EnginePhaseName, number> {
  const result = new Map<EnginePhaseName, number>();
  for (const [phase, duration] of first.phaseDurations) result.set(phase, duration);
  for (const [phase, duration] of second.phaseDurations) result.set(phase, (result.get(phase) ?? 0) + duration);
  return result;
}

function dominantPhase(piece: PhasePiece): EnginePhaseName {
  let selected = piece.phase;
  let selectedDuration = -1;
  for (const [phase, duration] of piece.phaseDurations) {
    if (duration > selectedDuration) {
      selected = phase;
      selectedDuration = duration;
    }
  }
  return selected;
}

function addPiece(span: PhasePiece, piece: PhasePiece): PhasePiece {
  const merged: PhasePiece = {
    ...span,
    endMs: piece.endMs,
    endRpm: piece.endRpm,
    endFuel: piece.endFuel,
    peakRpm: Math.max(span.peakRpm, piece.peakRpm),
    rpmSum: span.rpmSum + piece.rpmSum,
    fuelSum: span.fuelSum + piece.fuelSum,
    fuelSamples: span.fuelSamples + piece.fuelSamples,
    samples: span.samples + piece.samples,
    phaseDurations: combinePhaseDurations(span, piece),
  };
  merged.phase = dominantPhase(merged);
  return merged;
}

function coalesceSpans(pieces: PhasePiece[]): PhasePiece[] {
  const spans: PhasePiece[] = [];
  for (const piece of pieces) {
    const previous = spans.at(-1);
    if (previous && previous.phase === piece.phase) spans[spans.length - 1] = addPiece(previous, piece);
    else spans.push({ ...piece, phaseDurations: new Map(piece.phaseDurations) });
  }
  return spans;
}

function mergeShortestSpan(spans: PhasePiece[], minimumDuration: number): PhasePiece[] {
  let shortIndex = -1;
  let shortDuration = Number.POSITIVE_INFINITY;
  for (const [index, span] of spans.entries()) {
    const duration = span.endMs - span.startMs;
    if (duration < minimumDuration && duration < shortDuration) {
      shortIndex = index;
      shortDuration = duration;
    }
  }
  if (shortIndex === -1 || spans.length < 2) return spans;

  const mergeIndex = shortIndex > 0 ? shortIndex - 1 : 1;
  const result = spans.map((span) => ({ ...span, phaseDurations: new Map(span.phaseDurations) }));
  result[mergeIndex] = addPiece(result[mergeIndex], result[shortIndex]);
  result.splice(shortIndex, 1);
  return coalesceSpans(result);
}

function normalizeShortSpans(spans: PhasePiece[], minimumDuration: number): PhasePiece[] {
  let normalized = coalesceSpans(spans);
  while (normalized.some((span) => span.endMs - span.startMs < minimumDuration) && normalized.length > 1) {
    normalized = mergeShortestSpan(normalized, minimumDuration);
  }
  return normalized;
}

function toSegment(span: PhasePiece): PhaseSegment {
  return {
    phase: span.phase,
    startMs: span.startMs,
    endMs: span.endMs,
    sampleCount: span.samples,
    meanRpm: span.rpmSum / span.samples,
    peakRpm: span.peakRpm,
    meanFuelFlow: span.fuelSamples ? span.fuelSum / span.fuelSamples : 0,
  };
}

export function segmentOperatingPhases(samples: CalibratedSample[], minimumPhaseDurationMs = 500): PhaseSegment[] {
  const points = collectPoints(samples);
  invariant(points.length > 0, 'RPM_DATA_MISSING', 'At least one calibrated RPM sample is required');
  const spans = normalizeShortSpans(coalesceSpans(buildPieces(points)), minimumPhaseDurationMs);
  return spans.map(toSegment);
}
