import { invariant } from '../errors.ts';
import type { PerformanceInput, PerformanceSnapshot } from '../types.ts';

export function evaluatePerformance(input: PerformanceInput): PerformanceSnapshot {
  for (const [key, value] of Object.entries(input)) if (typeof value === 'number') invariant(Number.isFinite(value), 'INVALID_PERFORMANCE_INPUT', `Performance input ${key} must be finite`, { key, value });
  invariant(input.ambientTemperatureK > 0 && input.referenceTemperatureK > 0 && input.turbineInletTemperatureK > 0, 'INVALID_TEMPERATURE', 'Temperatures must be in Kelvin and positive');
  invariant(input.ambientPressureKpa > 0 && input.inletPressureKpa > 0 && input.compressorOutletPressureKpa > 0, 'INVALID_PRESSURE', 'Pressures must be absolute and positive');
  invariant(input.referenceRpm > 0 && input.rpm >= 0 && input.fuelFlowKgPerSecond >= 0, 'INVALID_ENGINE_STATE', 'RPM and fuel flow are outside physical bounds');
  const pressureRatio = input.compressorOutletPressureKpa / input.inletPressureKpa;
  const correctedRpm = input.rpm * Math.sqrt(input.referenceTemperatureK / input.ambientTemperatureK) / (input.ambientPressureKpa / input.referencePressureKpa) ** 0.05;
  const correctedFuelFlowKgPerSecond = input.fuelFlowKgPerSecond * Math.sqrt(input.ambientTemperatureK / input.referenceTemperatureK) / (input.ambientPressureKpa / input.referencePressureKpa);
  const thermalMarginK = Math.max(0, 1_150 - input.turbineInletTemperatureK);
  const compressorEfficiency = Math.max(0, Math.min(1, 0.72 + 0.00002 * (input.rpm - input.referenceRpm) - 0.03 * Math.max(0, pressureRatio - 8)));
  const baseline = input.baselineThrustKn ?? 0;
  const estimatedThrustKn = baseline + correctedFuelFlowKgPerSecond * 42 * compressorEfficiency * Math.log1p(pressureRatio);
  return { ...input, pressureRatio, correctedRpm, correctedFuelFlowKgPerSecond, estimatedThrustKn, compressorEfficiency, thermalMarginK };
}
