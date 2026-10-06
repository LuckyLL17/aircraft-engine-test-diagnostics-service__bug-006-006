import { calibrateTelemetry } from '../domain/calibration/apply.ts';
import { advanceHealth, initialHealth } from '../domain/health/advance.ts';
import { estimateRemainingLife } from '../domain/life/estimate.ts';
import { evaluatePerformance } from '../domain/performance/evaluate.ts';
import { segmentOperatingPhases } from '../domain/phase/segment.ts';
import { inferRootCauses } from '../domain/root-cause/infer.ts';
import { replayTelemetry } from '../domain/timeline/replay.ts';
import { diagnoseVibration } from '../domain/vibration/fuse.ts';
import type { Calibration, CausalEdge, CausalObservation, LifeModelInput, PerformanceInput, TelemetryEvent, VibrationEvidence } from '../domain/types.ts';

export const diagnosticService = {
  replay(events: TelemetryEvent[]) { return replayTelemetry(events); },
  performance(input: PerformanceInput) { return evaluatePerformance(input); },
  vibration(evidence: VibrationEvidence[], prior?: number) { return diagnoseVibration(evidence, prior); },
  health(intervals: Parameters<typeof advanceHealth>[1], initial = initialHealth()) { return advanceHealth(initial, intervals); },
  rootCause(observations: CausalObservation[], edges: CausalEdge[]) { return inferRootCauses(observations, edges); },
  life(input: LifeModelInput) { return estimateRemainingLife(input); },
  analyze(input: { events: TelemetryEvent[]; calibrations: Calibration[]; performance: PerformanceInput; vibrationEvidence?: VibrationEvidence[]; healthIntervals?: Parameters<typeof advanceHealth>[1]; rootObservations?: CausalObservation[]; rootEdges?: CausalEdge[]; life?: LifeModelInput }) {
    const replayed = replayTelemetry(input.events);
    const calibrated = calibrateTelemetry(replayed, input.calibrations);
    const phases = segmentOperatingPhases(calibrated);
    const performance = evaluatePerformance(input.performance);
    const vibration = diagnoseVibration(input.vibrationEvidence ?? []);
    const health = advanceHealth(initialHealth(), input.healthIntervals ?? []);
    const rootCause = inferRootCauses(input.rootObservations ?? [], input.rootEdges ?? []);
    const life = input.life ? estimateRemainingLife(input.life) : null;
    return { runId: replayed[0]?.runId ?? null, telemetry: { received: input.events.length, replayed: replayed.length, calibrated: calibrated.length }, phases, performance, vibration, health, rootCause, life };
  },
};
