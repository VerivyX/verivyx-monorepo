'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Wallet } from 'lucide-react';
import { api, type PayoutStatus } from '@/lib/api';

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Surface a useful message from either a thrown Error or a Horizon submit error.
function errMsg(e: unknown): string {
  if (e && typeof e === 'object' && 'response' in e) {
    const r = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response;
    const codes = r?.data?.extras?.result_codes;
    if (codes) return `Stellar rejected the transaction: ${JSON.stringify(codes)}`;
  }
  return e instanceof Error ? e.message : 'Activation failed';
}

export default function PayoutCard({ onChange }: { onChange?: (ready: boolean) => void }) {
  const [status, setStatus] = useState<PayoutStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.payoutStatus();
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load payout status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activate = useCallback(async () => {
    if (!status) return;
    setWorking(true);
    setError(null);
    try {
      setStep('Checking Freighter…');
      const freighter = await import('@stellar/freighter-api');
      const conn = await freighter.isConnected();
      if (conn.error) throw new Error(conn.error.message);
      if (!conn.isConnected) {
        throw new Error('Freighter extension not detected. Install it from freighter.app, then retry.');
      }

      setStep('Requesting wallet access…');
      const access = await freighter.requestAccess();
      if (access.error) throw new Error(access.error.message);
      if (access.address !== status.address) {
        throw new Error(
          `Connected wallet ${short(access.address)} doesn't match your payout address ${short(status.address)}. Switch Freighter to that account.`,
        );
      }
      if (!status.funded) {
        throw new Error('Your Stellar account has no XLM yet. Fund it with ~1 XLM (covers the trustline reserve + fee), then retry.');
      }

      setStep('Building trustline transaction…');
      const sdk = await import('@stellar/stellar-sdk');
      const server = new sdk.Horizon.Server(status.horizonUrl);
      const account = await server.loadAccount(status.address);
      const tx = new sdk.TransactionBuilder(account, {
        fee: sdk.BASE_FEE,
        networkPassphrase: status.networkPassphrase,
      })
        .addOperation(sdk.Operation.changeTrust({ asset: new sdk.Asset(status.asset.code, status.asset.issuer) }))
        .setTimeout(120)
        .build();

      setStep('Waiting for Freighter signature…');
      const signed = await freighter.signTransaction(tx.toXDR(), {
        networkPassphrase: status.networkPassphrase,
        address: status.address,
      });
      if (signed.error) throw new Error(signed.error.message);

      setStep('Submitting to Stellar…');
      const signedTx = sdk.TransactionBuilder.fromXDR(signed.signedTxXdr, status.networkPassphrase);
      await server.submitTransaction(signedTx);

      setStep('Confirming…');
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await api.payoutStatus();
        if (s.ready) {
          setStatus(s);
          onChange?.(true);
          return;
        }
      }
      setStatus(await api.payoutStatus());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setWorking(false);
      setStep(null);
    }
  }, [status, onChange]);

  return (
    <div className="surface-card p-6">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Wallet size={18} /> USDC wallet
        </h2>
        {status &&
          (status.ready ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-700">
              <CheckCircle2 size={12} /> Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
              <AlertTriangle size={12} /> Action needed
            </span>
          ))}
      </div>

      {loading ? (
        <div className="mt-6 flex items-center gap-2 text-sm text-[var(--color-ink-500)]">
          <RefreshCw size={14} className="animate-spin" /> Checking your wallet…
        </div>
      ) : status?.ready ? (
        <div className="mt-4 space-y-2 text-sm">
          <p className="text-[var(--color-ink-500)]">
            Your wallet can receive USDC. Payments settle straight to it on-chain — no withdrawals needed.
          </p>
          <div className="mt-3 rounded-xl bg-[var(--color-cream-50)] p-4 font-mono text-xs">
            <div className="flex justify-between">
              <span className="text-[var(--color-ink-500)]">Balance</span>
              <span className="font-semibold">{Number(status.usdcBalance).toFixed(4)} USDC</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-[var(--color-ink-500)]">Wallet</span>
              <span>{short(status.address)}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4 text-sm">
          <p className="text-[var(--color-ink-500)]">
            Before AI payments can reach you, your Stellar wallet needs a one-time USDC trustline — its
            permission to hold USDC. Sign it with Freighter; Verivyx never touches your keys.
          </p>
          <button onClick={activate} disabled={working} className="btn-yellow text-sm">
            {working ? <RefreshCw size={14} className="animate-spin" /> : <Wallet size={14} />}
            {working ? step ?? 'Working…' : 'Enable USDC wallet'}
          </button>
          <p className="text-xs text-[var(--color-ink-300)]">
            Wallet {short(status?.address ?? '')}
            {status && !status.funded ? ' · not funded yet — add a little XLM first' : ''}
          </p>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-md bg-[var(--color-stellar-rose)]/10 px-3 py-2 text-xs text-[var(--color-stellar-rose)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}
    </div>
  );
}
