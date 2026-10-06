import { DomainError, invariant } from '../errors.ts';
import type { Calibration, CalibratedSample, TelemetryEvent } from '../types.ts';

function matches(calibration: Calibration, event: TelemetryEvent): boolean {
  return calibration.sensor === event.sensor && (!calibration.channel || calibration.channel === event.channel) && event.sampleTimeMs >= calibration.effectiveFromMs && (calibration.effectiveToMs === undefined || event.sampleTimeMs < calibration.effectiveToMs);
}

function chooseCalibration(event: TelemetryEvent, calibrations: Calibration[]): Calibration {
  const matchesForEvent = calibrations.filter((calibration) => matches(calibration, event));
  invariant(matchesForEvent.length === 1, matchesForEvent.length === 0 ? 'CALIBRATION_MISSING' : 'CALIBRATION_OVERLAP', matchesForEvent.length === 0 ? 'No calibration covers telemetry sample' : 'More than one calibration covers telemetry sample', { eventId: event.eventId, sensor: event.sensor });
  return matchesForEvent[0];
}

export function calibrateTelemetry(events: TelemetryEvent[], calibrations: Calibration[]): CalibratedSample[] {
  const result: CalibratedSample[] = [];
  for (const event of events) {
    const calibration = chooseCalibration(event, calibrations);
    invariant(calibration.scale > 0 && calibration.uncertainty >= 0, 'INVALID_CALIBRATION', 'Calibration scale and uncertainty must be valid', { version: calibration.version });
    const reference = calibration.referenceTemperatureC ?? 20;
    const rawTemperature = event.sensor === 'turbine-temperature' || event.sensor === 'oil-temperature' ? event.value : reference;
    const temperatureCorrection = (calibration.temperatureCoefficient ?? 0) * (rawTemperature - reference);
    const calibratedValue = event.value * calibration.scale + calibration.offset + temperatureCorrection;
    const uncertainty = Math.hypot(calibration.uncertainty, Math.abs(event.value * calibration.scale) * 0.001);
    if (!Number.isFinite(calibratedValue) || !Number.isFinite(uncertainty)) throw new DomainError('CALIBRATION_OVERFLOW', 'Calibrated telemetry is not finite', 422, { eventId: event.eventId });
    result.push({ ...event, calibratedValue, uncertainty, calibrationVersion: calibration.version });
  }
  return result;
}
