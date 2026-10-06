export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status = 422, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function invariant(condition: unknown, code: string, message: string, details: Record<string, unknown> = {}): asserts condition {
  if (!condition) throw new DomainError(code, message, 422, details);
}
