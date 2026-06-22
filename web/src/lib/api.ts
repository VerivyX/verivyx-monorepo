const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost');

export type CreatorUser = {
  id: number;
  email: string;
  // Wallet + domain are collected during onboarding, so they are null until then.
  domain: string | null;
  stellar_address: string | null;
  emailVerified: boolean;
  needsOnboarding: boolean;
  pricePerRequest: number;
  platformFee: number | null;
  apiKey: string | null;
  paywallEnabled: boolean;
  createdAt?: string;
  role?: 'ADMIN' | 'CREATOR';
  /** True once the user has been granted MCP non-custodial wallet early access. */
  mcpEarlyAccess?: boolean;
};

export type AdminStats = {
  financial: {
    gmvAllTime: number;
    gmv7d: number;
    platformProfitAllTime: number;
    platformProfit7d: number;
  };
  ecosystem: {
    totalCreators: number;
    activeCreators7d: number;
    newCreators7d: number;
  };
  traffic: {
    paymentsVerified7d: number;
    botsBlocked7d: number;
    humansServed7d: number;
    powAnomalies7d: number;
  };
  topAgents: {
    agent: string | null;
    category: string | null;
    intercepts: number;
    revenue: number;
  }[];
};

export type AdminCreator = CreatorUser & {
  payments7d: number;
  botsBlocked7d: number;
  gmv7d: number;
  platformFee7d: number;
};

export type AdminLog = {
  id: number;
  adminEmail: string;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export const DOMAIN_REGEX = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;
export const STELLAR_PUBKEY_REGEX = /^G[A-Z2-7]{55}$/;

export function normalizeDomain(input: string): string | null {
  let v = input.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!DOMAIN_REGEX.test(v)) return null;
  return v;
}

export type AnalyticsResponse = {
  totals: {
    earnedUsdc: number;
    earnedDeltaPct: number;
    botsBlocked: number;
    humansServed: number;
    humansFailed: number;
    paymentsVerified: number;
    humanBotRatio: string;
    powAnomalies7d: number;
  };
  powDurationBuckets: {
    under50: number;
    between50_200: number;
    between200_500: number;
    over500: number;
  };
  topJa4: { ja4: string; count: number }[];
  agents: {
    agent: string | null;
    category: string | null;
    intercepts: number;
    revenue: number;
  }[];
  recent: TxRecord[];
};

// A settled payment with full on-chain proof (transfer + distribute hashes, split).
export type TxRecord = {
  id: number;
  type: string;
  agent: string | null;
  category: string | null;
  amountUsdc: number;
  createdAt: string;
  sessionId: string | null;
  txHash: string | null;
  distributeTransaction: string | null;
  creatorAmountUsdc: number | null;
  platformAmountUsdc: number | null;
  network: string | null;
  asset: string | null;
  payer: string | null;
  status: string | null;
  ip: string | null;
  powDurationMs: number | null;
  ja4: string | null;
};

export type AdminTxRecord = TxRecord & { domain: string; creatorEmail: string };

// Payout readiness — whether the creator's wallet can receive USDC yet.
// Includes the asset + network config the frontend uses to build the changeTrust.
export type PayoutStatus = {
  ready: boolean;
  address: string;
  funded: boolean;
  hasTrustline: boolean;
  usdcBalance: string;
  xlmBalance: string;
  asset: { code: string; issuer: string };
  network: string;
  networkPassphrase: string;
  horizonUrl: string;
};

export type TxPage<T> = { transactions: T[]; nextCursor: number | null };

// Build a stellar.expert tx link, network-aware (defaults to testnet).
export function stellarExpertTx(hash: string, network: string | null): string {
  const net = network && network.includes('public') ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

// Classic USDC requirements carry "USDC:ISSUER"; Soroban SAC asset is a bare contract id.
export function railLabel(asset: string | null): 'Soroban' | 'Classic' | '—' {
  if (!asset) return '—';
  return asset.includes(':') ? 'Classic' : 'Soroban';
}

function qs(opts?: Record<string, string | number | undefined>): string {
  if (!opts) return '';
  const parts = Object.entries(opts)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function authHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('paywall_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const errField =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error?: string }).error
        : undefined;
    throw new Error(errField || `Request failed with ${res.status}`);
  }
  return data as T;
}

export type McpWaitlistEntry = {
  id: number;
  email: string;
  source: string;
  invited: boolean;
  createdAt: string;
};

export type McpChain = {
  chain?: string;
  kind: string;
  enabled: boolean;
  asset?: string;
  walletAddress?: string;
  serviceFee?: string;
  testnet?: boolean;
  plannedPhase?: string;
};

export type McpOverview = {
  serviceFee: string;
  mainnetEnabled: boolean;
  apiKeysConfigured: number;
  chains: McpChain[];
  wallets: Record<string, unknown>;
};

export const api = {
  // Register now takes only email + password (+ captcha). Wallet/domain come later
  // in onboarding. Returns no session — the user must verify their email first.
  register: (input: { email: string; password: string; turnstileToken: string }) =>
    request<{ status: string; requiresVerification: boolean; email: string }>(`/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  login: (input: { email: string; password: string; turnstileToken: string }) =>
    request<{ token: string; user: CreatorUser }>(`/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Join the Verivyx x402 MCP early-access waitlist (mcp.verivyx.com coming-soon).
  mcpWaitlist: (input: { email: string; turnstileToken: string }) =>
    request<{ status: string }>(`/api/v1/mcp-waitlist`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Authenticated variant — used from the dashboard where the user is already logged in.
  // Passes an empty turnstileToken; the backend skips validation when TURNSTILE_SECRET
  // is not configured (dev/staging). In production this may require a backend update
  // to accept an auth-service JWT as an alternative to the Turnstile token.
  joinMcpWaitlist: (email: string) =>
    request<{ status: string }>(`/api/v1/mcp-waitlist`, {
      method: 'POST',
      body: JSON.stringify({ email, turnstileToken: '' }),
    }),

  adminMcpWaitlist: () =>
    request<{ total: number; waitlist: McpWaitlistEntry[] }>(`/api/v1/admin/mcp-waitlist`),

  adminMcpOverview: () => request<McpOverview>(`/api/v1/admin/mcp-overview`),

  // Consume an email verification token → marks verified and returns a session.
  verifyEmail: (token: string) =>
    request<{ token: string; user: CreatorUser }>(`/api/v1/auth/verify-email`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  resendVerification: (email: string) =>
    request<{ status: string }>(`/api/v1/auth/resend-verification`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  me: () => request<{ user: CreatorUser }>(`/api/v1/auth/me`),

  updateSettings: (input: {
    pricePerRequest?: number;
    domain?: string;
    stellar_address?: string;
    paywallEnabled?: boolean;
  }) =>
    request<{ user: CreatorUser }>(`/api/v1/auth/settings`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  analytics: () => request<AnalyticsResponse>(`/api/v1/auth/analytics`),

  payoutStatus: () => request<PayoutStatus>(`/api/v1/auth/payout-status`),

  creatorTransactions: (opts?: { limit?: number; cursor?: number }) =>
    request<TxPage<TxRecord>>(`/api/v1/auth/transactions${qs(opts)}`),

  adminTransactions: (opts?: { limit?: number; cursor?: number; domain?: string; since?: string }) =>
    request<TxPage<AdminTxRecord>>(`/api/v1/admin/transactions${qs(opts)}`),

  adminStats: () => request<AdminStats>(`/api/v1/admin/stats`),

  adminCreators: () => request<{ creators: AdminCreator[] }>(`/api/v1/admin/creators`),

  adminUpdateCreator: (id: number, data: { platformFee?: number; paywallEnabled?: boolean }) =>
    request<{ creator: CreatorUser }>(`/api/v1/admin/creators/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  adminDeleteCreator: (id: number) =>
    request<{ status: string; deletedId: number }>(`/api/v1/admin/creators/${id}`, {
      method: 'DELETE',
    }),

  adminLogs: () => request<{ logs: AdminLog[] }>(`/api/v1/admin/logs`),

  // Accept a Hydra login challenge after the user has authenticated.
  // Called with the login_challenge from the URL; returns the Hydra redirect_to URL.
  oauthLoginAccept: (login_challenge: string) =>
    request<{ redirect_to: string }>(`/api/v1/oauth/login/accept`, {
      method: 'POST',
      body: JSON.stringify({ login_challenge }),
    }),
};

// ── Wallet API (non-custodial MCP binding) ────────────────────────────────────
//
// All endpoints require the user's Hydra OAuth / session token as Bearer.
// MCP_BASE points to the MCP server (NEXT_PUBLIC_MCP_BASE_URL, e.g. http://localhost:8088).

const MCP_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_MCP_BASE_URL) || '';

async function mcpRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MCP_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const errField =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error?: string }).error
        : undefined;
    throw new Error(errField || `MCP request failed with ${res.status}`);
  }
  return data as T;
}

export type SessionSignerResponse = {
  /** ed25519 G-address of the session signer (add as Delegated on the context rule). */
  sessionPubkey: string;
};

export type WalletBindingRequest = {
  /** The OZ smart account C-address. */
  smartAccount: string;
  /** Budget in USDC atomic units (i128 as string — avoids JSON number precision loss). */
  budgetAtomic: string;
  /** Expiry ledger sequence as an integer STRING (the MCP /wallet/binding endpoint
   * validates a positive-integer string, so we never send a JSON number here). */
  expiryLedger: string;
};

export type WalletBindingResponse = {
  status: string;
  binding?: {
    smartAccount: string;
    budgetAtomic: string;
    expiryLedger: number;
    sessionPubkey: string;
  };
};

export type WalletStatusResponse = {
  linked: boolean;
  smartAccount?: string;
  sessionPubkey?: string;
  budgetAtomic?: string;
  expiryLedger?: number;
  /** Remaining budget in USDC atomic units (if the MCP tracks spending). */
  remainingBudget?: string;
};

export type WalletRevokeResponse = {
  status: string;
};

export const walletApi = {
  /**
   * Issue (or retrieve an existing) session ed25519 signer for the authenticated user.
   * Idempotent — returns the same sessionPubkey on repeated calls.
   *
   * The returned sessionPubkey is what you pass to smartAccount.delegate() as sessionPubkey.
   *
   * POST {MCP_BASE}/wallet/session-signer
   * Bearer = the user's Hydra OAuth token (localStorage paywall_token).
   */
  issueSessionSigner: () =>
    mcpRequest<SessionSignerResponse>('/wallet/session-signer', { method: 'POST' }),

  /**
   * Confirm the wallet binding after delegate() succeeds on-chain.
   * Records the smart account + budget + expiry on the MCP server.
   *
   * POST {MCP_BASE}/wallet/binding
   * Body: { smartAccount, budgetAtomic (as string), expiryLedger }
   */
  confirmBinding: (body: WalletBindingRequest) =>
    mcpRequest<WalletBindingResponse>('/wallet/binding', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Get the current wallet binding status for the authenticated user.
   * Returns linked=false if no binding exists.
   *
   * GET {MCP_BASE}/wallet/status
   */
  walletStatus: () => mcpRequest<WalletStatusResponse>('/wallet/status'),

  /**
   * Revoke the wallet binding on the MCP server side.
   * Call AFTER remove_context_rule on-chain (revoke() from smartAccount.ts) succeeds.
   *
   * POST {MCP_BASE}/wallet/revoke
   */
  revokeBinding: () => mcpRequest<WalletRevokeResponse>('/wallet/revoke', { method: 'POST' }),
};

export function saveSession(token: string, user: CreatorUser) {
  localStorage.setItem('paywall_token', token);
  localStorage.setItem('paywall_user', JSON.stringify(user));
}

export function updateStoredUser(user: CreatorUser) {
  localStorage.setItem('paywall_user', JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem('paywall_token');
  localStorage.removeItem('paywall_user');
}

export function getStoredUser(): CreatorUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('paywall_user');
    return raw ? (JSON.parse(raw) as CreatorUser) : null;
  } catch {
    return null;
  }
}

export { API_BASE };
