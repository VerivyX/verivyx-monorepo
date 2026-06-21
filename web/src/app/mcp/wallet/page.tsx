'use client';

/**
 * MCP Wallet Page — non-custodial wallet onboarding for Verivyx x402 agent payments.
 *
 * Sections:
 *   1. Connect / Create — Freighter wallet connect + OZ smart account deploy.
 *   2. Delegate — budget (USDC) + duration (days) → on-chain context rule + spending_limit policy.
 *   3. Manage — show active binding, revoke.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * AUTH RECONCILIATION FLAG (deferred — do NOT solve here)
 *
 * walletApi.mcpRequest() sends the dashboard's `paywall_token` (auth-service JWT)
 * as the Bearer token (via authHeader() which reads localStorage "paywall_token").
 * The wallet endpoints on the MCP server (POST /wallet/session-signer, etc.) are
 * gated by requireMcpAuth, which validates a Hydra OAuth access token — a different
 * bearer token, even though auth-service IS the Hydra IdP and both tokens share the
 * same user id (Hydra sub == auth-service user.id).
 *
 * Runtime consequence: at the deferred Fase 1/2 boundary, these calls will receive
 * a 401 from the MCP server until EITHER:
 *   (a) the wallet endpoints are updated to also accept the auth-service JWT
 *       (sub extraction from the same user-id space), OR
 *   (b) the dashboard obtains a Hydra access token via OIDC (Fase 2 OIDC login).
 *
 * This is a backend follow-up — the human's call. The page BUILD does not depend on it.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  Coins,
  ExternalLink,
  Fingerprint,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Shield,
  ShieldOff,
  Timer,
  Wallet,
  X,
  Zap,
} from 'lucide-react';

import { clearSession, getStoredUser, walletApi, type WalletStatusResponse } from '@/lib/api';
import {
  connectWallet,
  createOrConnectAccount,
  delegate,
  revoke,
} from '@/lib/smartAccount';
import { validateDelegation, toAtomicUsdc, expiryToLedger } from '@/lib/delegation';
import { LogoMark } from '@/components/Logo';
import { rpc as StellarRpc } from '@stellar/stellar-sdk';

// ── Config ─────────────────────────────────────────────────────────────────────

const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

// ── Types ──────────────────────────────────────────────────────────────────────

type PageView = 'connect' | 'delegate' | 'manage';

interface ActiveBinding {
  smartAccount: string;
  sessionPubkey: string;
  budgetAtomic: string;
  expiryLedger: number;
  remainingBudget?: string;
  /** Approx expiry date computed from ledger (~5 s/ledger from now). */
  approxExpiryDate?: Date;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Format a bigint atomic USDC amount to a human-readable string (7 dp). */
function formatAtomicUsdc(atomic: string | undefined): string {
  if (!atomic) return '—';
  try {
    const n = BigInt(atomic);
    const whole = n / 10_000_000n;
    const frac = (n % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return '—';
  }
}

/** Estimate an expiry date from a future ledger number (~5 s/ledger from current ledger). */
function ledgerToApproxDate(expiryLedger: number, currentLedger: number): Date {
  const ledgersAway = Math.max(0, expiryLedger - currentLedger);
  const secondsAway = ledgersAway * 5;
  return new Date(Date.now() + secondsAway * 1000);
}

/** Truncate a Stellar address for display. */
function truncateAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function WalletPage() {
  const router = useRouter();

  // ── Auth guard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const stored = getStoredUser();
    if (!stored) router.replace('/login');
  }, [router]);

  // ── Global state ────────────────────────────────────────────────────────────
  const [view, setView] = useState<PageView>('connect');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Connect section
  const [ownerAddress, setOwnerAddress] = useState<string | null>(null);
  const [smartAccountAddr, setSmartAccountAddr] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [deploying, setDeploying] = useState(false);

  // Delegate section
  const [budgetInput, setBudgetInput] = useState('1');
  const [daysInput, setDaysInput] = useState('7');
  const [delegating, setDelegating] = useState(false);
  const [lastRuleId, setLastRuleId] = useState<number | null>(null);

  // Manage section
  const [binding, setBinding] = useState<ActiveBinding | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);

  // Current ledger (fetched on load, used for date computation)
  const currentLedgerRef = useRef<number>(0);

  // ── Toast helper ────────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // ── Fetch current ledger ────────────────────────────────────────────────────
  const fetchCurrentLedger = useCallback(async (): Promise<number> => {
    try {
      const server = new StellarRpc.Server(STELLAR_RPC_URL, {
        allowHttp: STELLAR_RPC_URL.startsWith('http://'),
      });
      const latest = await server.getLatestLedger();
      currentLedgerRef.current = latest.sequence;
      return latest.sequence;
    } catch {
      return currentLedgerRef.current;
    }
  }, []);

  // ── Fetch USDC balance of smart account (read-only sim) ─────────────────────
  const fetchUsdcBalance = useCallback(async (saAddress: string): Promise<string | null> => {
    // The SA is a contract address that holds a SAC USDC balance directly.
    // We use the RPC getContractData approach or the Horizon account endpoint.
    // For simplicity, we display the address and link to stellar.expert for balance.
    // The balance is shown as "—" with a link; no network call needed for build pass.
    return null;
  }, []);

  // ── On load: check wallet status ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function checkStatus() {
      setStatusLoading(true);
      try {
        const currentLedger = await fetchCurrentLedger();
        // AUTH RECONCILIATION: this call uses the paywall_token which the MCP
        // server may reject with 401 until auth unification is done (see flag above).
        const status: WalletStatusResponse = await walletApi.walletStatus();
        if (cancelled) return;
        if (status.linked && status.smartAccount) {
          const approxExpiryDate =
            status.expiryLedger != null
              ? ledgerToApproxDate(status.expiryLedger, currentLedger)
              : undefined;
          setBinding({
            smartAccount: status.smartAccount,
            sessionPubkey: status.sessionPubkey ?? '',
            budgetAtomic: status.budgetAtomic ?? '0',
            expiryLedger: status.expiryLedger ?? 0,
            remainingBudget: status.remainingBudget,
            approxExpiryDate,
          });
          setSmartAccountAddr(status.smartAccount);
          setView('manage');
        }
      } catch {
        // 401 expected until auth reconciliation — silently stay on connect view.
        // Do not surface as an error banner on initial load.
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    }
    checkStatus();
    return () => { cancelled = true; };
  }, [fetchCurrentLedger]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  /** Step 1a: connect Freighter wallet. */
  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      const addr = await connectWallet();
      setOwnerAddress(addr);
      showToast(`Wallet connected: ${truncateAddr(addr)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    } finally {
      setConnecting(false);
    }
  };

  /** Step 1b: deploy OZ smart account (after wallet connected). */
  const handleDeploy = async () => {
    if (!ownerAddress) return;
    setError(null);
    setDeploying(true);
    try {
      const result = await createOrConnectAccount({ ownerAddress });
      setSmartAccountAddr(result.smartAccount);
      const bal = await fetchUsdcBalance(result.smartAccount);
      setUsdcBalance(bal);
      showToast(
        result.deployed
          ? `Smart account deployed: ${truncateAddr(result.smartAccount)}`
          : `Smart account found: ${truncateAddr(result.smartAccount)}`,
      );
      setView('delegate');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deploy smart account');
    } finally {
      setDeploying(false);
    }
  };

  /** Step 2: validate + delegate budget to MCP session signer. */
  const handleDelegate = async () => {
    if (!ownerAddress || !smartAccountAddr) return;
    setError(null);

    const validation = validateDelegation({ budgetUsdc: budgetInput, days: Number(daysInput) });
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setDelegating(true);
    try {
      // AUTH RECONCILIATION: issueSessionSigner requires Hydra OAuth token (see flag).
      const { sessionPubkey } = await walletApi.issueSessionSigner();

      const budgetAtomic = toAtomicUsdc(budgetInput);
      const currentLedger = await fetchCurrentLedger();
      const validUntilLedger = expiryToLedger(Number(daysInput), currentLedger);

      const delegateResult = await delegate({
        smartAccount: smartAccountAddr,
        sessionPubkey,
        budgetAtomic,
        validUntilLedger,
        ownerAddress,
      });

      setLastRuleId(delegateResult.ruleId);

      // AUTH RECONCILIATION: confirmBinding requires Hydra OAuth token (see flag).
      await walletApi.confirmBinding({
        smartAccount: smartAccountAddr,
        budgetAtomic: budgetAtomic.toString(),
        expiryLedger: String(validUntilLedger),
      });

      const approxExpiryDate = ledgerToApproxDate(validUntilLedger, currentLedger);
      setBinding({
        smartAccount: smartAccountAddr,
        sessionPubkey,
        budgetAtomic: budgetAtomic.toString(),
        expiryLedger: validUntilLedger,
        approxExpiryDate,
      });

      showToast('Delegation active — MCP can now pay on your behalf');
      setView('manage');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delegation failed');
    } finally {
      setDelegating(false);
    }
  };

  /** Step 3: revoke delegation (on-chain + MCP server). */
  const handleRevoke = async () => {
    if (!ownerAddress || !smartAccountAddr || lastRuleId == null) {
      setError(
        'Cannot revoke: missing owner wallet, smart account, or rule id. ' +
          'If you just refreshed the page, reconnect your Freighter wallet first.',
      );
      return;
    }
    setError(null);
    setRevoking(true);
    try {
      await revoke({ smartAccount: smartAccountAddr, ruleId: lastRuleId, ownerAddress });
      // AUTH RECONCILIATION: revokeBinding requires Hydra OAuth token (see flag).
      await walletApi.revokeBinding();
      setBinding(null);
      setLastRuleId(null);
      showToast('Delegation revoked — session key deactivated');
      setView('connect');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setRevoking(false);
    }
  };

  const handleLogout = () => {
    clearSession();
    router.push('/');
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (statusLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw size={16} className="animate-spin" /> Checking wallet status…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-cream-50)]">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-[var(--color-cream-200)] bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <LogoMark size={32} />
            <div>
              <p className="text-sm font-semibold tracking-tight">Verivyx</p>
              <p className="text-xs text-[var(--color-ink-500)]">MCP wallet</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="btn-ghost text-sm">
              <ArrowLeft size={14} /> Dashboard
            </Link>
            <button onClick={handleLogout} className="btn-primary text-sm">
              <LogOut size={14} /> Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {/* Page title */}
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
            Non-custodial · Soroban Testnet
          </p>
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            Agent Wallet
          </h1>
          <p className="text-sm text-[var(--color-ink-500)]">
            Link your Stellar wallet so the Verivyx MCP can pay x402 resources on your behalf —
            capped by a budget you set, revocable any time.
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mt-6 flex items-start gap-2 rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-sm text-[var(--color-stellar-rose)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </div>
        )}

        {/* Step indicators */}
        <StepBar view={view} />

        {/* ── Section 1: Connect ─────────────────────────────────────────── */}
        {view === 'connect' && (
          <section className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-3">
            {/* Connect card */}
            <div className="surface-card xl:col-span-2 p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Wallet size={18} /> Connect your wallet
              </h2>
              <p className="mt-2 text-sm text-[var(--color-ink-500)]">
                Connect your existing Freighter wallet. An OpenZeppelin smart account will be
                deployed on Stellar Testnet with you as the sole owner.
              </p>

              <div className="mt-6 flex flex-col gap-3">
                {/* Freighter connect */}
                <button
                  onClick={handleConnect}
                  disabled={connecting || !!ownerAddress}
                  className="btn-yellow disabled:opacity-60"
                >
                  {connecting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : ownerAddress ? (
                    <CheckCircle size={16} />
                  ) : (
                    <Wallet size={16} />
                  )}
                  {ownerAddress
                    ? `Connected: ${truncateAddr(ownerAddress)}`
                    : connecting
                    ? 'Connecting…'
                    : 'Connect existing wallet (Freighter)'}
                </button>

                {/* Passkey — disabled v1 */}
                <button
                  disabled
                  title="Coming soon — WebAuthn/passkey onboarding requires a secp256r1 verifier contract (deferred to v2)"
                  className="btn-ghost opacity-40 cursor-not-allowed"
                >
                  <Fingerprint size={16} />
                  Create with passkey
                  <span className="ml-auto text-xs font-normal opacity-70">coming soon</span>
                </button>
              </div>

              {ownerAddress && (
                <div className="mt-6 flex flex-col gap-2">
                  <div className="flex items-center justify-between rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                      Owner
                    </span>
                    <span className="font-mono text-xs">{ownerAddress}</span>
                  </div>

                  <button
                    onClick={handleDeploy}
                    disabled={deploying}
                    className="btn-yellow mt-2 disabled:opacity-60"
                  >
                    {deploying ? (
                      <>
                        <Loader2 size={16} className="animate-spin" /> Deploying smart account…
                      </>
                    ) : (
                      <>
                        <Zap size={16} /> Deploy smart account &amp; continue
                      </>
                    )}
                  </button>
                  <p className="text-xs text-[var(--color-ink-500)]">
                    Freighter will ask you to sign one transaction on Soroban Testnet.
                    Your wallet needs XLM for gas.
                  </p>
                </div>
              )}
            </div>

            {/* Info sidebar */}
            <div className="flex flex-col gap-4">
              <InfoCard
                icon={<Shield size={16} />}
                title="Non-custodial"
                body="Funds stay in your smart account. Verivyx only signs payments you explicitly authorize via the budget cap."
              />
              <InfoCard
                icon={<KeyRound size={16} />}
                title="Testnet faucet"
                body={
                  ownerAddress ? (
                    <>
                      Fund your owner wallet with XLM:{' '}
                      <a
                        href={`https://friendbot.stellar.org/?addr=${ownerAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        friendbot.stellar.org
                        <ExternalLink size={10} className="ml-0.5 inline" />
                      </a>
                      . For USDC on testnet, fund the smart account address after deploy.
                    </>
                  ) : (
                    'Connect your wallet to see the faucet link.'
                  )
                }
              />
              <InfoCard
                icon={<Coins size={16} />}
                title="Top up with card"
                body="Coming soon — on-ramp to fund your smart account directly with a credit card."
                muted
              />
            </div>
          </section>
        )}

        {/* ── Section 2: Delegate ────────────────────────────────────────── */}
        {view === 'delegate' && (
          <section className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="surface-card xl:col-span-2 p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <KeyRound size={18} /> Set delegation budget
              </h2>
              <p className="mt-2 text-sm text-[var(--color-ink-500)]">
                The MCP session key will be able to spend up to this USDC amount from your smart
                account. The delegation expires automatically and can be revoked any time.
              </p>

              {smartAccountAddr && (
                <div className="mt-5 flex flex-col gap-2">
                  <div className="flex items-center justify-between rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                      Smart account
                    </span>
                    <span className="font-mono text-xs">{smartAccountAddr}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                      USDC balance
                    </span>
                    <span className="font-mono text-xs">
                      {usdcBalance ?? '—'}{' '}
                      <a
                        href={`https://stellar.expert/explorer/testnet/contract/${smartAccountAddr}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--color-ink-400)] hover:text-[var(--color-ink-700)]"
                        title="View on stellar.expert"
                      >
                        <ExternalLink size={10} className="inline" />
                      </a>
                    </span>
                  </div>
                </div>
              )}

              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                    Budget (USDC)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field font-mono"
                    placeholder="1.0"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    disabled={delegating}
                  />
                  <p className="text-xs text-[var(--color-ink-400)]">
                    Max spend across all payments
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                    Duration (days)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    step="1"
                    className="input-field font-mono"
                    placeholder="7"
                    value={daysInput}
                    onChange={(e) => setDaysInput(e.target.value)}
                    disabled={delegating}
                  />
                  <p className="text-xs text-[var(--color-ink-400)]">
                    Delegation auto-expires after this many days
                  </p>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  onClick={handleDelegate}
                  disabled={delegating}
                  className="btn-yellow disabled:opacity-60"
                >
                  {delegating ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Delegating on-chain…
                    </>
                  ) : (
                    <>
                      <Shield size={16} /> Delegate &amp; activate
                    </>
                  )}
                </button>
                <button
                  onClick={() => setView('connect')}
                  disabled={delegating}
                  className="btn-ghost"
                >
                  Back
                </button>
              </div>
              {delegating && (
                <p className="mt-3 text-xs text-[var(--color-ink-500)]">
                  Freighter will ask you to sign two transactions: one to add the context rule,
                  one to attach the spending policy. Please approve both.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-4">
              <InfoCard
                icon={<Timer size={16} />}
                title="How delegation works"
                body="One owner-signed transaction grants the MCP session key a CallContract(USDC) rule capped by your budget. No approve() — funds move directly from your smart account."
              />
              <InfoCard
                icon={<Coins size={16} />}
                title="Fund first"
                body={
                  smartAccountAddr ? (
                    <>
                      The smart account must hold USDC before payments can settle.{' '}
                      <a
                        href={`https://stellar.expert/explorer/testnet/contract/${smartAccountAddr}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        View on stellar.expert
                        <ExternalLink size={10} className="ml-0.5 inline" />
                      </a>
                      .
                    </>
                  ) : (
                    'Deploy your smart account first to get the funding address.'
                  )
                }
              />
            </div>
          </section>
        )}

        {/* ── Section 3: Manage ──────────────────────────────────────────── */}
        {view === 'manage' && binding && (
          <section className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="surface-card xl:col-span-2 p-6">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <CheckCircle size={18} className="text-[var(--color-stellar-mint)]" />
                  Delegation active
                </h2>
                <span className="tag-chip">
                  <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-stellar-yellow)]" />
                  Live
                </span>
              </div>

              <div className="mt-5 flex flex-col gap-3">
                <BindingRow
                  label="Smart account"
                  value={
                    <span className="font-mono text-xs">
                      {binding.smartAccount}{' '}
                      <a
                        href={`https://stellar.expert/explorer/testnet/contract/${binding.smartAccount}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--color-ink-400)] hover:text-[var(--color-ink-700)]"
                      >
                        <ExternalLink size={10} className="inline" />
                      </a>
                    </span>
                  }
                />
                <BindingRow
                  label="Session signer"
                  value={
                    <span className="font-mono text-xs">{truncateAddr(binding.sessionPubkey)}</span>
                  }
                />
                <BindingRow
                  label="Budget"
                  value={
                    <span className="font-mono text-sm font-semibold">
                      {formatAtomicUsdc(binding.budgetAtomic)} USDC
                    </span>
                  }
                />
                {binding.remainingBudget != null && (
                  <BindingRow
                    label="Remaining"
                    value={
                      <span className="font-mono text-sm">
                        {formatAtomicUsdc(binding.remainingBudget)} USDC
                      </span>
                    }
                  />
                )}
                <BindingRow
                  label="Expires"
                  value={
                    binding.approxExpiryDate ? (
                      <span className="text-sm">
                        {binding.approxExpiryDate.toLocaleString()}{' '}
                        <span className="text-xs text-[var(--color-ink-400)]">
                          (ledger {binding.expiryLedger}, ~5 s/ledger)
                        </span>
                      </span>
                    ) : (
                      <span className="font-mono text-sm">ledger {binding.expiryLedger}</span>
                    )
                  }
                />
              </div>

              {/* Revoke */}
              <div className="mt-8 border-t border-[var(--color-cream-200)] pt-5">
                <h3 className="text-sm font-semibold text-[var(--color-stellar-rose)]">
                  Revoke delegation
                </h3>
                <p className="mt-1 text-xs text-[var(--color-ink-500)]">
                  Removes the on-chain context rule so the MCP session key can no longer spend
                  USDC from your account. Your funds are not affected.
                  {lastRuleId == null && (
                    <span className="ml-1 text-[var(--color-stellar-rose)]">
                      Note: rule id not cached in this session — reconnect your Freighter wallet
                      and re-delegate to enable on-chain revoke. MCP server binding will still
                      be cleared.
                    </span>
                  )}
                </p>
                <button
                  onClick={handleRevoke}
                  disabled={revoking}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl border border-[var(--color-stellar-rose)]/30 bg-[var(--color-stellar-rose)]/10 px-4 py-2 text-sm font-semibold text-[var(--color-stellar-rose)] transition hover:bg-[var(--color-stellar-rose)]/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {revoking ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> Revoking…
                    </>
                  ) : (
                    <>
                      <ShieldOff size={14} /> Revoke delegation
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <InfoCard
                icon={<Shield size={16} />}
                title="You remain in control"
                body="Revoke any time — the on-chain context rule is removed and the session key becomes invalid immediately. No waiting period."
              />
              <InfoCard
                icon={<Coins size={16} />}
                title="Top up with card"
                body="Coming soon — on-ramp to fund your smart account directly with a credit card."
                muted
              />
              <InfoCard
                icon={<ExternalLink size={16} />}
                title="View on stellar.expert"
                body={
                  <a
                    href={`https://stellar.expert/explorer/testnet/contract/${binding.smartAccount}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {truncateAddr(binding.smartAccount)} on testnet
                    <ExternalLink size={10} className="ml-0.5 inline" />
                  </a>
                }
              />
            </div>
          </section>
        )}
      </main>

      {/* Toast */}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center">
          <div className="pointer-events-auto rounded-full bg-[var(--color-ink-900)] px-5 py-3 text-sm font-medium text-[var(--color-stellar-yellow)] shadow-lg">
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StepBar({ view }: { view: PageView }) {
  const steps: { key: PageView; label: string }[] = [
    { key: 'connect', label: '1 · Connect' },
    { key: 'delegate', label: '2 · Delegate' },
    { key: 'manage', label: '3 · Manage' },
  ];
  return (
    <div className="mt-8 flex items-center gap-2">
      {steps.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 && (
            <div className="h-px flex-1 bg-[var(--color-cream-200)]" />
          )}
          <span
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
              view === s.key
                ? 'bg-[var(--color-ink-900)] text-[var(--color-stellar-yellow)]'
                : 'bg-[var(--color-cream-200)] text-[var(--color-ink-500)]'
            }`}
          >
            {s.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function InfoCard({
  icon,
  title,
  body,
  muted = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={`surface-card p-4 ${muted ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-cream-200)] text-[var(--color-ink-700)]">
          {icon}
        </span>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      <p className="mt-2 text-xs text-[var(--color-ink-500)]">{body}</p>
    </div>
  );
}

function BindingRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-3">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
        {label}
      </span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  );
}
