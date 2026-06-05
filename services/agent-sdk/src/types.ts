// Wire types — must stay in sync with services/x402-gateway/main.go.

// Response from hydration service (gate decision only, no content body).
export interface GateResponse {
  status: 'success';
  served: 'human' | 'paid_agent' | 'passthrough';
  transaction?: string; // present when served === 'paid_agent'
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirement {
  scheme: 'exact' | string;
  network: 'stellar:testnet' | 'stellar:pubnet' | string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirement;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

export interface SettleRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirement;
}

export const X402_VERSION = 2;
