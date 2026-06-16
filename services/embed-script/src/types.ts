// Shared types for the Verivyx embed (gate.min.js).

export interface VxConfig {
  domain: string;
  api: string;
  slug: string;
}

export interface Fingerprint {
  webdriver: boolean;
  languages: string[];
  hardwareConcurrency: number;
  screenWidth: number;
  screenHeight: number;
  userAgent: string;
  webglVendor: string | null;
  webglRenderer: string | null;
  mouseMoved: boolean;
}

export interface ChallengeResponse {
  challenge: string;
  salt: string;
  difficulty: number;
  ttlSeconds: number;
  powSalt?: string;
}

export interface VerifyResponse {
  sessionToken: string;
  ttlSeconds: number;
}

export interface PaymentRequirement {
  amount: string | number;
  network: string;
}

export interface PaymentRequirementsResponse {
  accepts?: PaymentRequirement[];
}

export interface BotSignal {
  name: string;
  score: number;
}

export interface PoWResult {
  nonce: string;
  durationMs: number;
}
