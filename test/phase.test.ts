import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentOperatingPhases } from '../src/domain/phase/segment.ts';
import type { CalibratedSample } from '../src/domain/types.ts';

function rpmSamples(series: Array<[number, number]>, fuelSeries?: Array<[number, number]>): CalibratedSample[] {
  const samples: any[] = series.map(([time, value]) => ({
    runId: 'run-1', eventId: `rpm-${time}`, sampleTimeMs: time, receivedTimeMs: time + 1, sequence: time,
    sensor: 'rpm', value, unit: 'rpm', calibratedValue: value, uncertainty: 0, calibrationVersion: 'v1',
  }));
  for (const [time, value] of fuelSeries ?? []) {
    samples.push({
      runId: 'run-1', eventId: `fuel-${time}`, sampleTimeMs: time, receivedTimeMs: time + 1, sequence: time,
      sensor: 'fuel-flow', value, unit: 'kg/s', calibratedValue: value, uncertainty: 0, calibrationVersion: 'v1',
    });
  }
  return samples;
}

test('phases are time ordered, boundary disjoint, and cover the full observed range', () => {
  // idle/steady -> acceleration -> steady -> deceleration -> shutdown, coarse samples
  const phases = segmentOperatingPhases(rpmSamples([
    [0, 400], [1000, 600], [2000, 1200], [3000, 1500],
    [5000, 1500.2], [7000, 1499.8], [8000, 900], [9000, 300], [10_000, 200],
  ]));
  assert.equal(phases[0].startMs, 0);
  assert.equal(phases.at(-1)!.endMs, 10_000);
  for (let i = 1; i < phases.length; i += 1) assert.equal(phases[i - 1].endMs, phases[i].startMs);
  assert.deepEqual(phases.map((segment) => segment.phase), ['shutdown', 'acceleration', 'steady', 'deceleration', 'shutdown']);
});

test('shutdown threshold crossing inside a sampling interval is located by interpolation', () => {
  // linear ramp 400 -> 600 between t=0 and t=1000: 500 rpm crossing at t=500
  const phases = segmentOperatingPhases(rpmSamples([[0, 400], [1000, 600], [2000, 900]]));
  assert.equal(phases[0].phase, 'shutdown');
  assert.equal(phases[0].endMs, 500);
  assert.equal(phases[1].startMs, 500);
  assert.equal(phases[1].phase, 'acceleration');
  assert.equal(phases[0].sampleCount + phases[1].sampleCount, 3);
  assert.equal(phases.reduce((sum, segment) => sum + segment.sampleCount, 0), 3);
});

test('each sample is counted once across segments even at boundary instants', () => {
  const series: Array<[number, number]> = [[0, 900], [1000, 1500], [2000, 1500], [3000, 900]];
  const phases = segmentOperatingPhases(rpmSamples(series));
  assert.equal(phases.reduce((sum, segment) => sum + segment.sampleCount, 0), series.length);
  assert.deepEqual(phases.map((segment) => segment.phase), ['acceleration', 'steady', 'deceleration']);
});

test('a short reversal phase is merged away with fully recomputed statistics', () => {
  // 100 ms steady blip between two 1000 ms equal-length ramps -> tie merges with previous
  const phases = segmentOperatingPhases(rpmSamples([
    [0, 1000], [1000, 1300], [1100, 1302], [2100, 1000],
  ]), 500);
  assert.equal(phases.length, 2);
  assert.equal(phases[0].phase, 'acceleration');
  assert.equal(phases[0].endMs, 1100);
  assert.equal(phases[0].sampleCount, 2);
  assert.equal(phases[1].sampleCount, 2);
  assert.equal(phases.reduce((sum, segment) => sum + segment.sampleCount, 0), 4);
  assert.equal(phases[0].meanRpm, 1_280_100 / 1100);
  assert.equal(phases[0].peakRpm, 1302);
  assert.equal(phases[0].endMs, phases[1].startMs);
});

test('merged statistics are time weighted rather than reusing stale segment means', () => {
  // unequal samples in the two parts: a stale sample-weighted mean would be wrong
  const phases = segmentOperatingPhases(rpmSamples([
    [0, 1000], [1000, 1300], [1100, 1301], [2100, 1000],
  ], [[0, 0.1], [1000, 0.5], [1100, 0.5], [2100, 0.1]]), 500);
  assert.equal(phases.length, 2);
  assert.ok(Number.isFinite(phases[0].meanFuelFlow));
  // trapezoid over [0,1000,1100]: area 300 + 50 = 350 / 1100
  assert.ok(Math.abs(phases[0].meanFuelFlow - 350 / 1100) < 1e-12);
});
