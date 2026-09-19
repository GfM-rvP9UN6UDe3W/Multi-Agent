export class OrchestrationError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.details = details;
  }
}
export function fail(code: string, message: string, details: Record<string, unknown> = {}): never {
  throw new OrchestrationError(code, message, details);
}
