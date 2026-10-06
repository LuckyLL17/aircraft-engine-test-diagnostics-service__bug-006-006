import { DomainError, invariant } from '../errors.ts';
import type { TelemetryEvent } from '../types.ts';

function eventFingerprint(event: TelemetryEvent): string {
  return JSON.stringify([event.runId, event.eventId, event.sampleTimeMs, event.sequence, event.sensor, event.value, event.unit, event.channel ?? '']);
}

export function validateTelemetry(events: TelemetryEvent[]): void {
  invariant(Array.isArray(events), 'INVALID_TELEMETRY', 'Telemetry events must be an array');
  for (const [index, event] of events.entries()) {
    invariant(event && typeof event.runId === 'string' && event.runId.length > 0, 'INVALID_RUN_ID', 'Telemetry run id is required', { index });
    invariant(typeof event.eventId === 'string' && event.eventId.length > 0, 'INVALID_EVENT_ID', 'Telemetry event id is required', { index });
    invariant(Number.isFinite(event.sampleTimeMs) && event.sampleTimeMs >= 0, 'INVALID_SAMPLE_TIME', 'Sample time must be finite and non-negative', { index });
    invariant(Number.isFinite(event.receivedTimeMs) && event.receivedTimeMs >= 0, 'INVALID_RECEIVED_TIME', 'Received time must be finite and non-negative', { index });
    invariant(Number.isInteger(event.sequence) && event.sequence >= 0, 'INVALID_SEQUENCE', 'Sequence must be a non-negative integer', { index });
    invariant(Number.isFinite(event.value), 'INVALID_VALUE', 'Telemetry value must be finite', { index });
    invariant(event.quality !== 'missing', 'MISSING_TELEMETRY', 'Missing telemetry cannot be replayed as a measurement', { index });
  }
}

export function replayTelemetry(input: TelemetryEvent[]): TelemetryEvent[] {
  validateTelemetry(input);
  const runIds = new Set(input.map((event) => event.runId));
  invariant(runIds.size === 1, 'MIXED_RUNS', 'A replay batch must contain one test run', { runIds: [...runIds] });
  const byId = new Map<string, string>();
  for (const event of input) {
    const fingerprint = eventFingerprint(event);
    const previous = byId.get(event.eventId);
    if (previous && previous !== fingerprint) throw new DomainError('EVENT_CONFLICT', 'Event id has conflicting payloads', 409, { eventId: event.eventId });
    byId.set(event.eventId, fingerprint);
  }
  return [...new Map(input.map((event) => [event.eventId, event])).values()].sort((a, b) => a.sampleTimeMs - b.sampleTimeMs || a.sequence - b.sequence || a.sensor.localeCompare(b.sensor) || a.eventId.localeCompare(b.eventId));
}

export function indexBySampleTime(events: TelemetryEvent[]): Map<number, TelemetryEvent[]> {
  const index = new Map<number, TelemetryEvent[]>();
  for (const event of replayTelemetry(events)) index.set(event.sampleTimeMs, [...(index.get(event.sampleTimeMs) ?? []), event]);
  return index;
}
