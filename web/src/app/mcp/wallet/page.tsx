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
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
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
  Sparkles,
  Timer,
  Wallet,
  X,
  Zap,
} from 'lucide-react';

import { api, clearSession, getStoredUser, walletApi, type WalletStatusResponse } from '@/lib/api';
import {
  connectWallet,
  createOrConnectAccount,
  delegate,
  getUsdcBalance,
  topUp,
  withdraw,
  ownerHasUsdcTrustline,
  addOwnerUsdcTrustline,
  revoke,
} from '@/lib/smartAccount';
import { validateDelegation, toAtomicUsdc, expiryToLedger } from '@/lib/delegation';
import { DashboardHeader } from '@/components/DashboardHeader';
import { Toast } from '@/components/Toast';
import { rpc as StellarRpc } from '@stellar/stellar-sdk';

// ── Config ─────────────────────────────────────────────────────────────────────

const STELLAR_RPC_URL =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

// ── Types ──────────────────────────────────────────────────────────────────────

type PageView = 'connect' | 'delegate' | 'manage';

/**
 * Three possible early-access states:
 *   'loading'  — still fetching /auth/me
 *   'waitlist' — user does NOT have mcpEarlyAccess; show join-waitlist view
 *   'granted'  — user has mcpEarlyAccess; show connect/delegate/manage flow
 */
type EarlyAccessState = 'loading' | 'waitlist' | 'granted';

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

  // ── Early-access gate ───────────────────────────────────────────────────────
  // We call api.me() on every mount to get a FRESH user record (not relying on
  // the possibly-stale getStoredUser() cache for the mcpEarlyAccess flag).
  const [earlyAccess, setEarlyAccess] = useState<EarlyAccessState>('loading');
  const [waitlistDone, setWaitlistDone] = useState(false);
  const [waitlistBusy, setWaitlistBusy] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);

  // Cached user email for the waitlist join button.
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function checkEarlyAccess() {
      // Fast path: check stored token first.
      const stored = getStoredUser();
      if (!stored) {
        router.replace('/login');
        return;
      }
      try {
        const { user } = await api.me();
        if (cancelled) return;
        setUserEmail(user.email);
        setEarlyAccess(user.mcpEarlyAccess === true ? 'granted' : 'waitlist');
      } catch {
        // Network error or 401 — redirect to login.
        if (!cancelled) router.replace('/login');
      }
    }
    checkEarlyAccess();
    return () => { cancelled = true; };
  }, [router]);

  const handleJoinWaitlist = useCallback(async () => {
    if (!userEmail || waitlistBusy) return;
    setWaitlistError(null);
    setWaitlistBusy(true);
    try {
      await api.joinMcpWaitlist(userEmail);
      setWaitlistDone(true);
    } catch (err) {
      setWaitlistError(err instanceof Error ? err.message : 'Failed to join waitlist. Try again.');
    } finally {
      setWaitlistBusy(false);
    }
  }, [userEmail, waitlistBusy]);

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

  // Top-up sub-section
  const [topUpInput, setTopUpInput] = useState('');
  const [toppingUp, setToppingUp] = useState(false);

  // Withdraw sub-section
  const [withdrawInput, setWithdrawInput] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [addingTrustline, setAddingTrustline] = useState(false);
  const [needsTrustline, setNeedsTrustline] = useState(false);

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
    try {
      const bal = await getUsdcBalance(saAddress);
      // "0" is a valid balance — return it so the UI shows "0" rather than "—".
      return bal;
    } catch {
      return null;
    }
  }, []);

  // ── On load: check wallet status ────────────────────────────────────────────
  useEffect(() => {
    // Skip wallet status check if early-access not yet resolved or not granted.
    if (earlyAccess !== 'granted') return;

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
          // Kick off a balance fetch in the background (non-blocking).
          getUsdcBalance(status.smartAccount)
            .then((bal) => { if (!cancelled) setUsdcBalance(bal); })
            .catch(() => {/* non-fatal */});
        }
      } catch (err) {
        // 403 early_access_required: a race between EA grant revocation and page load.
        // Fall back to the waitlist view so the user is never stranded.
        if (err instanceof Error && err.message === 'early_access_required') {
          if (!cancelled) setEarlyAccess('waitlist');
          return;
        }
        // 401 expected until auth reconciliation — silently stay on connect view.
        // Do not surface as an error banner on initial load.
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    }
    checkStatus();
    return () => { cancelled = true; };
  }, [earlyAccess, fetchCurrentLedger]);

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
    setError(null);
    // Ensure Freighter is connected (needed when re-authorizing from the manage view,
    // where ownerAddress isn't set until the user reconnects after a page load).
    let owner = ownerAddress;
    if (!owner) {
      try {
        owner = await connectWallet();
        setOwnerAddress(owner);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connect your Freighter wallet first.');
        return;
      }
    }
    if (!owner || !smartAccountAddr) return;

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
        ownerAddress: owner,
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
      // 403 early_access_required: EA was revoked mid-flow; fall back to waitlist view.
      if (err instanceof Error && err.message === 'early_access_required') {
        setEarlyAccess('waitlist');
        return;
      }
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
      // 403 early_access_required: fall back to waitlist view.
      if (err instanceof Error && err.message === 'early_access_required') {
        setEarlyAccess('waitlist');
        return;
      }
      setError(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setRevoking(false);
    }
  };

  /** Refresh the smart-account USDC balance and update state. */
  const handleRefreshBalance = useCallback(async () => {
    const sa = smartAccountAddr ?? binding?.smartAccount;
    if (!sa) return;
    const bal = await fetchUsdcBalance(sa);
    setUsdcBalance(bal);
  }, [smartAccountAddr, binding, fetchUsdcBalance]);

  /** Top up: transfer USDC from owner Freighter wallet to smart account. */
  const handleTopUp = async () => {
    setError(null);
    let owner = ownerAddress;
    if (!owner) {
      try {
        owner = await connectWallet();
        setOwnerAddress(owner);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connect your Freighter wallet first.');
        return;
      }
    }
    const sa = smartAccountAddr ?? binding?.smartAccount;
    if (!owner || !sa) return;

    let amountAtomic: bigint;
    try {
      amountAtomic = toAtomicUsdc(topUpInput);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid amount');
      return;
    }

    setToppingUp(true);
    try {
      const { txHash } = await topUp({ ownerAddress: owner, smartAccount: sa, amountAtomic });
      showToast(`Top-up sent — tx ${txHash.slice(0, 8)}…`);
      setTopUpInput('');
      await handleRefreshBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Top-up failed');
    } finally {
      setToppingUp(false);
    }
  };

  /** Withdraw: pull USDC from smart account back to owner Freighter wallet. */
  const handleWithdraw = async () => {
    setError(null);
    setNeedsTrustline(false);
    let owner = ownerAddress;
    if (!owner) {
      try {
        owner = await connectWallet();
        setOwnerAddress(owner);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connect your Freighter wallet first.');
        return;
      }
    }
    const sa = smartAccountAddr ?? binding?.smartAccount;
    if (!owner || !sa) return;

    let amountAtomic: bigint;
    try {
      amountAtomic = toAtomicUsdc(withdrawInput);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid amount');
      return;
    }

    // Check trustline before attempting withdraw.
    const hasTrustline = await ownerHasUsdcTrustline(owner);
    if (!hasTrustline) {
      setNeedsTrustline(true);
      return;
    }

    setWithdrawing(true);
    try {
      const { txHash } = await withdraw({ ownerAddress: owner, smartAccount: sa, amountAtomic });
      showToast(`Withdrawn — tx ${txHash.slice(0, 8)}…`);
      setWithdrawInput('');
      await handleRefreshBalance();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdraw failed');
    } finally {
      setWithdrawing(false);
    }
  };

  /** Add a USDC trustline to the owner's wallet, then retry the withdraw. */
  const handleAddTrustline = async () => {
    setError(null);
    let owner = ownerAddress;
    if (!owner) {
      try {
        owner = await connectWallet();
        setOwnerAddress(owner);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connect your Freighter wallet first.');
        return;
      }
    }
    setAddingTrustline(true);
    try {
      await addOwnerUsdcTrustline(owner);
      setNeedsTrustline(false);
      showToast('USDC trustline added — you can now withdraw');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add trustline');
    } finally {
      setAddingTrustline(false);
    }
  };

  const handleLogout = async () => {
    // Best-effort: end the Hydra SSO session so a new MCP connector can't
    // silently re-authorize. Always clear the local session + redirect.
    await api.oauthLogout().catch(() => {});
    clearSession();
    router.push('/');
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  // ── Loading: early-access check or wallet status ───────────────────────────
  if (earlyAccess === 'loading' || (earlyAccess === 'granted' && statusLoading)) {
    return (
      <div className="grid min-h-screen place-items-center bg-white text-[var(--color-ink-500)]">
        <div className="flex items-center gap-3 text-sm">
          <RefreshCw size={16} className="animate-spin" />
          {earlyAccess === 'loading' ? 'Checking access…' : 'Checking wallet status…'}
        </div>
      </div>
    );
  }

  // ── Waitlist view: user does not have mcpEarlyAccess ───────────────────────
  if (earlyAccess === 'waitlist') {
    return (
      <div className="app-shell">
        <DashboardHeader
          subtitle="MCP wallet"
          width="mid"
          actions={
            <>
              <Link href="/dashboard" className="btn-ghost text-sm">
                <ArrowLeft size={14} /> Dashboard
              </Link>
              <button onClick={handleLogout} className="btn-primary text-sm">
                <LogOut size={14} /> Logout
              </button>
            </>
          }
        />

        <main className="app-main app-width-mid">
          <div className="flex flex-col">
            <p className="eyebrow">Non-custodial · Soroban Testnet</p>
            <h1 className="page-title">Agent wallet</h1>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-6 xl:grid-cols-3">
            {/* Main card */}
            <div className="surface-card xl:col-span-2 p-8">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--color-stellar-yellow-soft)] text-[var(--color-ink-900)]">
                  <Sparkles size={18} />
                </span>
                <div>
                  <span className="tag-chip bg-[var(--color-stellar-violet-soft)] text-[var(--color-ink-900)] text-xs">
                    Early access
                  </span>
                </div>
              </div>

              <h2 className="mt-5 text-xl font-semibold tracking-tight">
                Non-custodial agent payments are in early access
              </h2>
              <p className="mt-3 text-sm text-[var(--color-ink-500)]">
                The MCP wallet — link your Stellar smart account so the Verivyx MCP can pay x402
                resources on your behalf — is currently available to early-access members only.
                Join the waitlist and we&apos;ll enable your account as soon as a spot opens.
              </p>

              <div className="mt-8">
                {waitlistDone ? (
                  <div className="flex items-start gap-3 rounded-xl border border-[var(--color-stellar-mint)]/30 bg-[var(--color-stellar-mint)]/10 px-4 py-4">
                    <CheckCircle size={18} className="mt-0.5 shrink-0 text-[var(--color-stellar-mint)]" />
                    <div>
                      <p className="text-sm font-semibold">You&apos;re on the waitlist</p>
                      <p className="mt-1 text-xs text-[var(--color-ink-500)]">
                        We&apos;ll enable your account soon. Check your inbox for a confirmation email.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={handleJoinWaitlist}
                      disabled={waitlistBusy}
                      className="btn-yellow self-start disabled:opacity-60"
                    >
                      {waitlistBusy ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Bell size={16} />
                      )}
                      {waitlistBusy ? 'Joining…' : 'Join the waitlist'}
                    </button>
                    {waitlistError && (
                      <p className="text-xs text-[var(--color-stellar-rose)]">{waitlistError}</p>
                    )}
                    {userEmail && (
                      <p className="text-xs text-[var(--color-ink-400)]">
                        We&apos;ll notify <span className="font-medium">{userEmail}</span> when your account is enabled.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Info sidebar */}
            <div className="flex flex-col gap-4">
              <InfoCard
                icon={<Shield size={16} />}
                title="Non-custodial"
                body="Funds stay in your smart account. Verivyx only signs payments you explicitly authorize via a budget cap."
              />
              <InfoCard
                icon={<KeyRound size={16} />}
                title="Revocable any time"
                body="Once granted, the delegation has an on-chain expiry and can be revoked with one transaction. No waiting period."
              />
              <InfoCard
                icon={<Coins size={16} />}
                title="x402 native"
                body="Built on the open HTTP 402 standard. Pay for any x402 resource across Stellar, Base, and Solana."
              />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <DashboardHeader
        subtitle="MCP wallet"
        width="mid"
        actions={
          <>
            <Link href="/dashboard" className="btn-ghost text-sm">
              <ArrowLeft size={14} /> Dashboard
            </Link>
            <button onClick={handleLogout} className="btn-primary text-sm">
              <LogOut size={14} /> Logout
            </button>
          </>
        }
      />

      <main className="app-main app-width-mid">
        {/* Page title */}
        <div className="flex flex-col">
          <p className="eyebrow">Non-custodial · Soroban Testnet</p>
          <h1 className="page-title">Agent wallet</h1>
          <p className="page-lead">
            Link your Stellar wallet so the Verivyx MCP can pay x402 resources on your behalf —
            capped by a budget you set, revocable any time.
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="alert-error mt-6">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error">
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
              <h2 className="card-title">
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
              <h2 className="card-title">
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
                <h2 className="card-title">
                  <CheckCircle size={18} className="text-[var(--color-stellar-mint-700)]" />
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
                {/* Live USDC balance of the smart account */}
                <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-3">
                  <span className="shrink-0 text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
                    Balance
                  </span>
                  <span className="flex items-center gap-2 min-w-0 truncate text-right">
                    <span className="font-mono text-sm font-semibold">
                      {usdcBalance != null ? `${formatAtomicUsdc(usdcBalance)} USDC` : '—'}
                    </span>
                    <button
                      onClick={handleRefreshBalance}
                      title="Refresh balance"
                      className="text-[var(--color-ink-400)] hover:text-[var(--color-ink-700)] transition"
                    >
                      <RefreshCw size={12} />
                    </button>
                  </span>
                </div>
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

              {/* Top up */}
              <div className="mt-8 border-t border-[var(--color-cream-200)] pt-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-ink-700)]">
                  <ArrowUpFromLine size={14} /> Top up agent account
                </h3>
                <p className="mt-1 text-xs text-[var(--color-ink-500)]">
                  Transfer USDC from your Freighter wallet to your agent smart account.
                  Freighter will sign one transaction.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field font-mono w-36"
                    placeholder="0.00"
                    value={topUpInput}
                    onChange={(e) => setTopUpInput(e.target.value)}
                    disabled={toppingUp}
                  />
                  <span className="text-xs text-[var(--color-ink-500)]">USDC</span>
                  <button
                    onClick={handleTopUp}
                    disabled={toppingUp || !topUpInput}
                    className="btn-yellow text-sm disabled:opacity-60"
                  >
                    {toppingUp ? (
                      <><Loader2 size={14} className="animate-spin" /> Topping up…</>
                    ) : (
                      <><ArrowUpFromLine size={14} /> Top up</>
                    )}
                  </button>
                </div>
              </div>

              {/* Withdraw */}
              <div className="mt-8 border-t border-[var(--color-cream-200)] pt-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-ink-700)]">
                  <ArrowDownToLine size={14} /> Withdraw to my wallet
                </h3>
                <p className="mt-1 text-xs text-[var(--color-ink-500)]">
                  Pull USDC from your agent account back to your Freighter wallet.
                  Your agent delegation stays active — no revoke needed.
                </p>

                {needsTrustline && (
                  <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[var(--color-stellar-yellow)]/40 bg-[var(--color-stellar-yellow-soft)] px-4 py-3">
                    <p className="text-xs font-semibold text-[var(--color-ink-800)]">
                      Your Freighter wallet needs a USDC trustline to receive USDC.
                    </p>
                    <p className="text-xs text-[var(--color-ink-500)]">
                      This is a one-time classic Stellar operation (not Soroban). Sign it once with Freighter, then withdraw.
                    </p>
                    <button
                      onClick={handleAddTrustline}
                      disabled={addingTrustline}
                      className="btn-yellow self-start text-sm disabled:opacity-60"
                    >
                      {addingTrustline ? (
                        <><Loader2 size={14} className="animate-spin" /> Adding trustline…</>
                      ) : (
                        <><CheckCircle size={14} /> Add USDC trustline</>
                      )}
                    </button>
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-field font-mono w-36"
                    placeholder="0.00"
                    value={withdrawInput}
                    onChange={(e) => setWithdrawInput(e.target.value)}
                    disabled={withdrawing}
                  />
                  <span className="text-xs text-[var(--color-ink-500)]">USDC</span>
                  {usdcBalance != null && usdcBalance !== '0' && (
                    <button
                      onClick={() => setWithdrawInput(formatAtomicUsdc(usdcBalance))}
                      className="text-xs text-[var(--color-ink-400)] hover:text-[var(--color-ink-700)] underline transition"
                      title="Set to full balance"
                    >
                      Max
                    </button>
                  )}
                  <button
                    onClick={handleWithdraw}
                    disabled={withdrawing || !withdrawInput}
                    className="btn-ghost text-sm disabled:opacity-60"
                  >
                    {withdrawing ? (
                      <><Loader2 size={14} className="animate-spin" /> Withdrawing…</>
                    ) : (
                      <><ArrowDownToLine size={14} /> Withdraw</>
                    )}
                  </button>
                </div>
              </div>

              {/* Re-authorize / fix delegation */}
              <div className="mt-8 border-t border-[var(--color-cream-200)] pt-5">
                <h3 className="text-sm font-semibold text-[var(--color-ink-700)]">
                  Re-authorize delegation
                </h3>
                <p className="mt-1 text-xs text-[var(--color-ink-500)]">
                  Re-runs the on-chain delegation on this same account (it first removes the old
                  rule, then re-adds it with the spending limit properly installed). Use this if a
                  payment fails with a delegation/authorization error. Your account and USDC balance
                  are kept — you&apos;ll sign a few Freighter prompts.
                </p>
                <button
                  onClick={handleDelegate}
                  disabled={delegating}
                  className="btn-soft mt-4"
                >
                  {delegating ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> Re-authorizing…
                    </>
                  ) : (
                    <>
                      <RefreshCw size={14} /> Re-authorize (fix delegation)
                    </>
                  )}
                </button>
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
                  className="btn-danger mt-4"
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
                icon={<ArrowUpFromLine size={16} />}
                title="Top up"
                body="Send USDC from your Freighter wallet to the agent smart account. One Freighter signature — plain SAC transfer."
              />
              <InfoCard
                icon={<ArrowDownToLine size={16} />}
                title="Withdraw"
                body="Pull USDC back to your Freighter wallet at any time. Your agent delegation stays active — no revoke needed."
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

      <Toast message={toast} />
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
