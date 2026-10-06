export type SensorKind = 'rpm' | 'fuel-flow' | 'compressor-pressure' | 'turbine-temperature' | 'vibration' | 'oil-temperature';
export type EnginePhaseName = 'idle' | 'acceleration' | 'steady' | 'deceleration' | 'shutdown';
export type Unit = 'rpm' | 'kg/s' | 'kPa' | 'bar' | 'C' | 'K' | 'g' | 'mm/s';

export type TelemetryEvent = {
  runId: string;
  eventId: string;
  sampleTimeMs: number;
  receivedTimeMs: number;
  sequence: number;
  sensor: SensorKind;
  value: number;
  unit: Unit;
  quality?: 'good' | 'suspect' | 'missing';
  channel?: string;
};

export type CalibratedSample = TelemetryEvent & {
  calibratedValue: number;
  uncertainty: number;
  calibrationVersion: string;
};

export type Calibration = {
  sensor: SensorKind;
  channel?: string;
  version: string;
  effectiveFromMs: number;
  effectiveToMs?: number;
  scale: number;
  offset: number;
  temperatureCoefficient?: number;
  referenceTemperatureC?: number;
  uncertainty: number;
};

export type PhaseSegment = {
  phase: EnginePhaseName;
  startMs: number;
  endMs: number;
  sampleCount: number;
  meanRpm: number;
  peakRpm: number;
  meanFuelFlow: number;
};

export type PerformanceInput = {
  rpm: number;
  fuelFlowKgPerSecond: number;
  compressorOutletPressureKpa: number;
  turbineInletTemperatureK: number;
  ambientPressureKpa: number;
  ambientTemperatureK: number;
  inletPressureKpa: number;
  referenceRpm: number;
  referenceTemperatureK: number;
  referencePressureKpa: number;
  baselineThrustKn?: number;
};

export type PerformanceSnapshot = PerformanceInput & {
  pressureRatio: number;
  correctedRpm: number;
  correctedFuelFlowKgPerSecond: number;
  estimatedThrustKn: number;
  compressorEfficiency: number;
  thermalMarginK: number;
};

export type VibrationEvidence = {
  evidenceId: string;
  sensorId: string;
  windowStartMs: number;
  windowEndMs: number;
  feature: 'rotor-order' | 'broadband' | 'bearing-envelope' | 'casing-acceleration';
  fault: 'bearing' | 'gear-mesh' | 'rotor-unbalance' | 'unknown';
  likelihoodRatio: number;
  amplitude: number;
  locationM?: number;
  locationUncertaintyM?: number;
  sourceGroup?: string;
  quality?: 'normal' | 'suspect';
};

export type FaultCandidate = {
  fault: VibrationEvidence['fault'];
  posterior: number;
  evidenceIds: string[];
  representativeWindow: { startMs: number; endMs: number };
  locationM: number | null;
  locationUncertaintyM: number | null;
};

export type ComponentHealth = {
  compressorEfficiency: number;
  turbineFlowCapacity: number;
  bearingFriction: number;
  hotSectionMargin: number;
  elapsedHours: number;
  version: number;
};

export type HealthInterval = {
  durationHours: number;
  temperatureK: number;
  vibrationRms: number;
  operatingLoad: number;
  component?: keyof Pick<ComponentHealth, 'compressorEfficiency' | 'turbineFlowCapacity' | 'bearingFriction' | 'hotSectionMargin'>;
};

export type CausalObservation = {
  id: string;
  node: string;
  observedAtMs: number;
  score: number;
  evidenceIds: string[];
};

export type CausalEdge = { from: string; to: string; weight: number; delayMs: number };
export type RootCauseResult = { ranking: Array<{ node: string; score: number; paths: string[][] }>; observations: CausalObservation[]; rejectedCycles: string[][] };

export type LifeModelInput = {
  initialHealth: ComponentHealth;
  horizonHours: number;
  samples: number;
  seed: number;
  meanDegradationPerHour: number;
  deviation: number;
  temperatureStress: number;
  vibrationStress: number;
  failureThreshold: number;
  correlation: [[number, number], [number, number]];
};

export type LifeEstimate = {
  quantiles: { p05: number | null; p50: number | null; p95: number | null };
  failureProbability: number;
  validSamples: number;
  rejectedSamples: number;
  rejectedReasons: Record<string, number>;
};
