import { invariant } from '../errors.ts';
import type { CalibratedSample, EnginePhaseName, PhaseSegment } from '../types.ts';

type RpmPoint = { time: number; rpm: number; fuel: number };

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
  if (rpm < 500) return 'shutdown';
  if (slope > 0.25) return 'acceleration';
  if (slope < -0.25) return 'deceleration';
  return 'steady';
}

function sampledSlope(previous: RpmPoint, point: RpmPoint): number {
  const elapsed = Math.max(1, point.time - previous.time);
  return (point.rpm - previous.rpm) / elapsed * 1000;
}

function phaseBoundaries(points: RpmPoint[], minimumPhaseDurationMs: number): number[] {
  const boundaries: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const phaseBefore = phaseForSlope(sampledSlope(points[i - 1], points[i]), points[i - 1].rpm);
    const phaseAfter = phaseForSlope(sampledSlope(points[i - 1], points[i]), points[i].rpm);
    const gap = points[i].time - points[i - 1].time;
    if (phaseBefore !== phaseAfter && gap >= minimumPhaseDurationMs) boundaries.push(i);
  }
  return boundaries;
}

export function segmentOperatingPhases(samples: CalibratedSample[], minimumPhaseDurationMs = 500): PhaseSegment[] {
  const points = collectPoints(samples);
  invariant(points.length > 0, 'RPM_DATA_MISSING', 'At least one calibrated RPM sample is required');
  const boundaries = new Set(phaseBoundaries(points, minimumPhaseDurationMs));
  const segments: PhaseSegment[] = [];
  let start = 0;
  for (let i = 1; i <= points.length; i += 1) {
    if (i !== points.length && !boundaries.has(i)) continue;
    const chunk = points.slice(start, i + (i < points.length ? 1 : 0));
    const first = chunk[0];
    const last = chunk.at(-1)!;
    const slope = chunk.length > 1 ? sampledSlope(chunk[0], chunk.at(-1)!) : 0;
    segments.push(toSegment(phaseForSlope(slope, last.rpm), chunk));
    start = i;
  }
  return mergeShortSegments(segments, minimumPhaseDurationMs);
}

function toSegment(phase: EnginePhaseName, points: RpmPoint[]): PhaseSegment {
  const finiteFuel = points.map((point) => point.fuel).filter(Number.isFinite);
  const rpms = points.map((point) => point.rpm);
  return { phase, startMs: points[0].time, endMs: points.at(-1)!.time, sampleCount: points.length, meanRpm: rpms.reduce((a, b) => a + b, 0) / rpms.length, peakRpm: Math.max(...rpms), meanFuelFlow: finiteFuel.length ? finiteFuel.reduce((a, b) => a + b, 0) / finiteFuel.length : 0 };
}

function mergeShortSegments(segments: PhaseSegment[], minimumDuration: number): PhaseSegment[] {
  if (segments.length < 2) return segments;
  const result: PhaseSegment[] = [];
  for (const segment of segments) {
    const previous = result.at(-1);
    if (previous && segment.endMs - segment.startMs < minimumDuration) {
      const total = previous.sampleCount + segment.sampleCount;
      const merged = { ...previous, endMs: segment.endMs, sampleCount: total, peakRpm: Math.max(previous.peakRpm, segment.peakRpm), meanRpm: (previous.meanRpm * previous.sampleCount + segment.meanRpm * segment.sampleCount) / total, meanFuelFlow: (previous.meanFuelFlow * previous.sampleCount + segment.meanFuelFlow * segment.sampleCount) / total };
      result[result.length - 1] = merged;
    } else result.push(segment);
  }
  return result;
}
