import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseVibration } from '../src/domain/vibration/fuse.ts';
import { estimateRemainingLife } from '../src/domain/life/estimate.ts';
import { evaluatePerformance } from '../src/domain/performance/evaluate.ts';
import { segmentOperatingPhases } from '../src/domain/phase/segment.ts';
import { replayTelemetry } from '../src/domain/timeline/replay.ts';

function calibratedSample(timeMs: number, sensor: 'rpm' | 'fuel-flow', value: number, eventId: string): any {
  return {
    runId: 'run-1',
    eventId,
    sampleTimeMs: timeMs,
    receivedTimeMs: timeMs + 1,
    sequence: timeMs,
    sensor,
    value,
    unit: sensor === 'rpm' ? 'rpm' : 'kg/s',
    calibratedValue: value,
    uncertainty: 0,
    calibrationVersion: 'v1',
  };
}

function rpmSamples(values: Array<[number, number, number?]>): any[] {
  return values.flatMap(([timeMs, rpm, fuel]) => [
    calibratedSample(timeMs, 'rpm', rpm, `rpm-${timeMs}`),
    ...(fuel === undefined ? [] : [calibratedSample(timeMs, 'fuel-flow', fuel, `fuel-${timeMs}`)]),
  ]);
}

test('replay is deterministic and removes duplicate event ids', () => {
  const events = [
    { runId: 'run-1', eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 4, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
    { runId: 'run-1', eventId: 'a', sampleTimeMs: 1, receivedTimeMs: 3, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' },
    { runId: 'run-1', eventId: 'b', sampleTimeMs: 2, receivedTimeMs: 4, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
  ] as any;
  assert.deepEqual(replayTelemetry(events).map((item) => item.eventId), ['a', 'b']);
});

test('performance produces physical normalized indicators', () => {
  const result = evaluatePerformance({ rpm: 9_000, fuelFlowKgPerSecond: 2, compressorOutletPressureKpa: 900, turbineInletTemperatureK: 1_000, ambientPressureKpa: 101.3, ambientTemperatureK: 288, inletPressureKpa: 100, referenceRpm: 10_000, referenceTemperatureK: 288, referencePressureKpa: 101.3 });
  assert.ok(result.pressureRatio > 1);
  assert.ok(result.compressorEfficiency >= 0 && result.compressorEfficiency <= 1);
});

test('vibration evidence is grouped by correlated source', () => {
  const result = diagnoseVibration([
    { evidenceId: 'a', sensorId: 's1', sourceGroup: 'g1', windowStartMs: 0, windowEndMs: 100, feature: 'bearing-envelope', fault: 'bearing', likelihoodRatio: 4, amplitude: 2 },
    { evidenceId: 'b', sensorId: 's1', sourceGroup: 'g1', windowStartMs: 20, windowEndMs: 80, feature: 'broadband', fault: 'bearing', likelihoodRatio: 4, amplitude: 2 },
    { evidenceId: 'c', sensorId: 's2', sourceGroup: 'g2', windowStartMs: 200, windowEndMs: 300, feature: 'bearing-envelope', fault: 'bearing', likelihoodRatio: 3, amplitude: 2 },
  ]);
  assert.equal(result[0].evidenceIds.length, 2);
});

test('phase boundaries are located inside sparse sample intervals in both directions', () => {
  const start = segmentOperatingPhases(rpmSamples([[0, 400, 10], [1000, 1500, 20]]), 50);
  assert.deepEqual(start.map((phase) => phase.phase), ['shutdown', 'acceleration']);
  assert.equal(start[0].startMs, 0);
  assert.equal(start[1].endMs, 1000);
  assert.equal(start[0].endMs, start[1].startMs);
  assert.ok(Math.abs(start[0].endMs - (1000 / 11)) < 1e-9);
  assert.deepEqual(start.map((phase) => phase.sampleCount), [1, 1]);
  assert.deepEqual(start.map((phase) => phase.meanRpm), [400, 1500]);
  assert.deepEqual(start.map((phase) => phase.meanFuelFlow), [10, 20]);

  const stop = segmentOperatingPhases(rpmSamples([[0, 1500, 30], [1000, 400, 10]]), 50);
  assert.deepEqual(stop.map((phase) => phase.phase), ['deceleration', 'shutdown']);
  assert.equal(stop[0].startMs, 0);
  assert.equal(stop[1].endMs, 1000);
  assert.equal(stop[0].endMs, stop[1].startMs);
  assert.ok(Math.abs(stop[0].endMs - (10000 / 11)) < 1e-9);
});

test('a short reverse phase is merged with recalculated sample statistics', () => {
  const phases = segmentOperatingPhases(rpmSamples([[0, 600, 10], [600, 1000, 20], [700, 800, 25], [1700, 1000, 30]]));
  assert.deepEqual(phases.map((phase) => phase.phase), ['acceleration']);
  assert.equal(phases[0].startMs, 0);
  assert.equal(phases[0].endMs, 1700);
  assert.equal(phases[0].sampleCount, 4);
  assert.equal(phases[0].meanRpm, 850);
  assert.equal(phases[0].peakRpm, 1000);
  assert.equal(phases[0].meanFuelFlow, 21.25);
});

test('life estimate is reproducible for a fixed seed', () => {
  const input = { initialHealth: { compressorEfficiency: 0.95, turbineFlowCapacity: 0.96, bearingFriction: 0.02, hotSectionMargin: 0.9, elapsedHours: 100, version: 1 }, horizonHours: 10_000, samples: 100, seed: 42, meanDegradationPerHour: 0.0002, deviation: 0.00003, temperatureStress: 0.2, vibrationStress: 0.1, failureThreshold: 0.4, correlation: [[1, 0.3], [0.3, 1]] as [[number, number], [number, number]] };
  assert.deepEqual(estimateRemainingLife(input), estimateRemainingLife(input));
});
