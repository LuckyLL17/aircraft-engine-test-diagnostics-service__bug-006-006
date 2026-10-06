import { invariant } from '../errors.ts';
import type { CalibratedSample, EnginePhaseName, PhaseSegment } from '../types.ts';

type RpmPoint = { time: number; rpm: number; fuel: number };
type Span = { startMs: number; endMs: number; phase: EnginePhaseName };
type Run = { spans: Span[]; points: RpmPoint[] };
type Knot = { time: number; rpm: number; fuel: number };

const SHUTDOWN_RPM = 500;
const SLOPE_THRESHOLD = 0.25; // rpm per second

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

function phaseFor(slope: number, rpm: number): EnginePhaseName {
  if (rpm < SHUTDOWN_RPM) return 'shutdown';
  if (slope > SLOPE_THRESHOLD) return 'acceleration';
  if (slope < -SLOPE_THRESHOLD) return 'deceleration';
  return 'steady';
}

function sampledSlope(previous: RpmPoint, point: RpmPoint): number {
  const elapsed = Math.max(1, point.time - previous.time);
  return (point.rpm - previous.rpm) / elapsed * 1000;
}

// Turn every sampled interval into one or two atomic spans. A slope regime
// change only becomes visible at an observed vertex, so the boundary is placed
// there; a 500 rpm threshold crossing happens *inside* the interval and is
// located by linear interpolation instead of assigning the whole gap to a side.
function buildSpans(points: RpmPoint[]): Span[] {
  const spans: Span[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const slope = sampledSlope(a, b);
    const before = phaseFor(slope, a.rpm);
    const after = phaseFor(slope, b.rpm);
    if (before === after) {
      spans.push({ startMs: a.time, endMs: b.time, phase: before });
      continue;
    }
    const ratio = (SHUTDOWN_RPM - a.rpm) / (b.rpm - a.rpm);
    if (ratio <= 0) {
      spans.push({ startMs: a.time, endMs: b.time, phase: after });
    } else if (ratio >= 1) {
      spans.push({ startMs: a.time, endMs: b.time, phase: before });
    } else {
      const crossingMs = a.time + ratio * (b.time - a.time);
      spans.push({ startMs: a.time, endMs: crossingMs, phase: before });
      spans.push({ startMs: crossingMs, endMs: b.time, phase: after });
    }
  }
  return spans;
}

function buildRuns(spans: Span[]): Run[] {
  const runs: Run[] = [];
  for (const span of spans) {
    const previous = runs.at(-1);
    if (previous && previous.spans.at(-1)!.endMs === span.startMs && previous.spans.at(-1)!.phase === span.phase) {
      previous.spans.push(span);
    } else {
      runs.push({ spans: [span], points: [] });
    }
  }
  return runs;
}

function runEndMs(run: Run): number {
  return run.spans.at(-1)!.endMs;
}

function runDurationMs(run: Run): number {
  return run.spans.reduce((total, span) => total + (span.endMs - span.startMs), 0);
}

// Half-open ownership: an interior boundary sample belongs to the run starting
// at that instant, so every sample feeds exactly one run (no double counting).
function assignPoints(runs: Run[], points: RpmPoint[]): void {
  let r = 0;
  for (const point of points) {
    while (r < runs.length - 1 && point.time >= runEndMs(runs[r])) r += 1;
    runs[r].points.push(point);
  }
}

// Repeatedly absorb the shortest too-short run into its shorter neighbour
// (previous run wins an equal tie). All statistics and the phase label are
// derived later from the merged spans and points, never copied.
function mergeShortRuns(runs: Run[], minimumDuration: number): Run[] {
  while (runs.length > 1) {
    let index = -1;
    let shortest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs.length; i += 1) {
      const duration = runDurationMs(runs[i]);
      if (duration < minimumDuration && duration < shortest) {
        index = i;
        shortest = duration;
      }
    }
    if (index === -1) break;
    const mergeWithPrevious = index > 0 && (index === runs.length - 1 || runDurationMs(runs[index - 1]) <= runDurationMs(runs[index + 1]));
    const target = mergeWithPrevious ? index - 1 : index + 1;
    const earlier = Math.min(index, target);
    const later = Math.max(index, target);
    runs[earlier].spans.push(...runs[later].spans);
    runs[earlier].points.push(...runs[later].points);
    runs.splice(later, 1);
  }
  return runs;
}

function interpolate(points: RpmPoint[], time: number): { rpm: number; fuel: number } {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (points[lo].time === time) return { rpm: points[lo].rpm, fuel: points[lo].fuel };
  const [a, b] = points[lo].time > time ? [points[lo - 1], points[lo]] : [points[lo], points[lo + 1]];
  const ratio = (time - a.time) / (b.time - a.time);
  return {
    rpm: a.rpm + (b.rpm - a.rpm) * ratio,
    fuel: Number.isFinite(a.fuel) && Number.isFinite(b.fuel) ? a.fuel + (b.fuel - a.fuel) * ratio : Number.NaN,
  };
}

function runKnots(run: Run, points: RpmPoint[]): Knot[] {
  const start = run.spans[0].startMs;
  const end = run.spans.at(-1)!.endMs;
  const knots: Knot[] = [];
  if (run.points[0].time !== start) knots.push({ time: start, ...interpolate(points, start) });
  for (const point of run.points) knots.push({ time: point.time, rpm: point.rpm, fuel: point.fuel });
  if (run.points.at(-1)!.time !== end) knots.push({ time: end, ...interpolate(points, end) });
  return knots;
}

function dominantPhase(run: Run): EnginePhaseName {
  const totals = new Map<EnginePhaseName, number>();
  for (const span of run.spans) totals.set(span.phase, (totals.get(span.phase) ?? 0) + span.endMs - span.startMs);
  let phase = run.spans[0].phase;
  let best = -1;
  for (const [name, ms] of totals) {
    if (ms > best) {
      best = ms;
      phase = name;
    }
  }
  return phase;
}

// Time-weighted (trapezoid) statistics over the samples actually owned by the
// run, with interpolation knots closing gaps up to the boundary instants.
function summarize(run: Run, points: RpmPoint[]): PhaseSegment {
  const start = run.spans[0].startMs;
  const end = run.spans.at(-1)!.endMs;
  const knots = runKnots(run, points);
  const duration = end - start;

  let rpmArea = 0;
  let fuelArea = 0;
  let fuelCovered = 0;
  let peakRpm = knots[0].rpm;
  for (let i = 1; i < knots.length; i += 1) {
    const dt = knots[i].time - knots[i - 1].time;
    rpmArea += ((knots[i - 1].rpm + knots[i].rpm) / 2) * dt;
    peakRpm = Math.max(peakRpm, knots[i].rpm);
    if (Number.isFinite(knots[i - 1].fuel) && Number.isFinite(knots[i].fuel)) {
      fuelArea += ((knots[i - 1].fuel + knots[i].fuel) / 2) * dt;
      fuelCovered += dt;
    }
  }

  return {
    phase: dominantPhase(run),
    startMs: start,
    endMs: end,
    sampleCount: run.points.length,
    meanRpm: duration > 0 ? rpmArea / duration : knots.reduce((sum, knot) => sum + knot.rpm, 0) / knots.length,
    peakRpm,
    meanFuelFlow: fuelCovered > 0 ? fuelArea / fuelCovered : 0,
  };
}

export function segmentOperatingPhases(samples: CalibratedSample[], minimumPhaseDurationMs = 500): PhaseSegment[] {
  const points = collectPoints(samples);
  invariant(points.length > 0, 'RPM_DATA_MISSING', 'At least one calibrated RPM sample is required');

  const runs = points.length === 1
    ? [{ spans: [{ startMs: points[0].time, endMs: points[0].time, phase: phaseFor(0, points[0].rpm) }], points: [] as RpmPoint[] }]
    : buildRuns(buildSpans(points));
  assignPoints(runs, points);

  return mergeShortRuns(runs, minimumPhaseDurationMs).map((run) => summarize(run, points));
}
