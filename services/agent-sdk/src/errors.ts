export type PaywallErrorCode = 'config' | 'payment' | 'hydration' | 'settlement' | 'requirements';

export class PaywallError extends Error {
  readonly status?: number;
  readonly code: PaywallErrorCode;
  readonly cause?: unknown;
  constructor(code: PaywallErrorCode, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'PaywallError';
    this.code = code;
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

export class NoMatchingRequirementError extends PaywallError {
  constructor(detail: string) {
    super('requirements', `No PaymentRequirement matched the agent's wallet: ${detail}`);
  }
}

export class SettlementFailedError extends PaywallError {
  readonly response: unknown;
  constructor(reason: string, response: unknown) {
    super('settlement', `Settlement was rejected: ${reason}`);
    this.response = response;
  }
}

export class HydrationFailedError extends PaywallError {
  readonly responseBody: unknown;
  constructor(status: number, body: unknown) {
    super('hydration', `Hydration call returned ${status}`, { status });
    this.responseBody = body;
  }
}
