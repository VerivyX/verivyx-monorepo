'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { api, normalizeDomain, type CreatorUser } from '@/lib/api';
import { type Framework, FRAMEWORKS, envBlock, snippetFor } from './snippets';
import { provisionErrorMessage } from './provision-errors';
import { dnsRecordName } from './dns-record-name';

// ---------------------------------------------------------------------------
// Framework selector
// ---------------------------------------------------------------------------

function FrameworkSelector({
  value,
  onChange,
}: {
  value: Framework;
  onChange: (fw: Framework) => void;
}) {
  const labels: Record<Framework, string> = {
    next: 'Next.js',
    express: 'Express',
    hono: 'Hono',
  };
  return (
    <div
      role="group"
      aria-label="Framework"
      className="inline-flex rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-100)] p-1"
    >
      {FRAMEWORKS.map((fw) => (
        <button
          key={fw}
          type="button"
          onClick={() => onChange(fw)}
          aria-pressed={value === fw}
          className={[
            'rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink-900)]',
            value === fw
              ? 'bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)] shadow-sm'
              : 'text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]',
          ].join(' ')}
        >
          {labels[fw]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copy button (shared pattern)
// ---------------------------------------------------------------------------

function CopyButton({
  text,
  label = 'Copy',
  small = false,
}: {
  text: string;
  label?: string;
  small?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: silently ignore (clipboard API may be blocked in some contexts)
    }
  };

  if (small) {
    return (
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : label}
        className={[
          'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink-900)]',
          copied
            ? 'bg-[var(--color-stellar-mint)]/20 text-[var(--color-stellar-mint)]'
            : 'bg-[var(--color-cream-200)] text-[var(--color-ink-700)] hover:bg-[var(--color-cream-300,#dcdbd2)]',
        ].join(' ')}
      >
        {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
        {copied ? 'Copied' : label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : label}
      className={copied ? 'btn-dark text-xs' : 'btn-yellow text-xs'}
    >
      {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
      {copied ? 'Copied!' : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Code-as-hero block (the signature element)
// ---------------------------------------------------------------------------

function CodeHero({ framework, domain }: { framework: Framework; domain: string }) {
  const snippet = snippetFor(framework, domain);
  const env = envBlock(domain);

  // Lightweight syntax highlighting — accent the key identifiers without a
  // full parser. We replace known brand strings with styled <span>s using
  // dangerouslySetInnerHTML after escaping the rest of the string.
  const highlight = (raw: string): string => {
    // Escape HTML first
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    return escaped
      // Strings (double-quoted)
      .replace(
        /(&quot;[^&]*&quot;)/g,
        '<span style="color:var(--color-stellar-yellow)">$1</span>',
      )
      // vx.protect — the core SDK call (violet)
      .replace(
        /(vx\.protect)/g,
        '<span style="color:#7e5afe">$1</span>',
      )
      // verivyxNext / verivyxExpress / verivyxHono — constructor (mint)
      .replace(
        /(verivyx(?:Next|Express|Hono))/g,
        '<span style="color:var(--color-stellar-mint)">$1</span>',
      )
      // import / const / export (ink-400)
      .replace(
        /\b(import|const|export|from)\b/g,
        '<span style="color:#94a3b8">$1</span>',
      )
      // Comments (// ...) — ink-500
      .replace(
        /(\/\/[^\n]*)/g,
        '<span style="color:#64748b">$1</span>',
      );
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-ink-800,#1e293b)] bg-[var(--color-ink-900)]">
      {/* Window chrome */}
      <div className="flex items-center justify-between border-b border-[var(--color-ink-800,#1e293b)] px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-rose)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-yellow)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-stellar-mint)]" />
          <span className="ml-3 font-mono text-xs text-[var(--color-ink-400,#94a3b8)]">
            {snippet.codeFile}
          </span>
        </div>
        <CopyButton text={snippet.code} label="Copy snippet" />
      </div>

      {/* Code */}
      <pre
        className="overflow-x-auto px-6 py-5 font-mono text-[13px] leading-relaxed text-[var(--color-cream-100)]"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: highlight(snippet.code) }}
      />

      {/* Routing legend — the thesis of the SDK */}
      <div className="border-t border-[var(--color-ink-800,#1e293b)] px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-xs">
          <span>
            <span className="text-[var(--color-ink-400,#94a3b8)]">human</span>
            <span className="mx-1.5 text-[var(--color-ink-600,#475569)]">→</span>
            <span className="text-[var(--color-cream-100)]">free</span>
          </span>
          <span>
            <span className="text-[var(--color-ink-400,#94a3b8)]">search crawler</span>
            <span className="mx-1.5 text-[var(--color-ink-600,#475569)]">→</span>
            <span style={{ color: 'var(--color-stellar-violet)' }}>preview</span>
          </span>
          <span>
            <span className="text-[var(--color-ink-400,#94a3b8)]">AI agent</span>
            <span className="mx-1.5 text-[var(--color-ink-600,#475569)]">→</span>
            <span className="text-[var(--color-stellar-yellow)]">402, pays</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Env block
// ---------------------------------------------------------------------------

function EnvBlock({ domain }: { domain: string }) {
  const text = envBlock(domain);
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-cream-200)]">
      <div className="flex items-center justify-between border-b border-[var(--color-cream-200)] bg-[var(--color-cream-100)] px-4 py-2">
        <span className="font-mono text-xs text-[var(--color-ink-500)]">.env</span>
        <CopyButton text={text} label="Copy .env" small />
      </div>
      <pre className="overflow-x-auto bg-[var(--color-cream-50)] px-5 py-4 font-mono text-[13px] leading-relaxed text-[var(--color-ink-700)]">
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error banner
// ---------------------------------------------------------------------------

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl bg-[var(--color-stellar-rose)]/10 px-4 py-3 text-sm text-[var(--color-stellar-rose)]"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="text-[var(--color-stellar-rose)] hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-stellar-rose)]"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper header
// ---------------------------------------------------------------------------

const STEPS = ['Add domain', 'Prove ownership', 'Install'] as const;

function Stepper({ current }: { current: 1 | 2 | 3 }) {
  return (
    <nav aria-label="Provisioning steps" className="mb-8">
      <ol className="flex items-center gap-0">
        {STEPS.map((label, index) => {
          const stepNum = (index + 1) as 1 | 2 | 3;
          const isCompleted = stepNum < current;
          const isActive = stepNum === current;
          const isLast = index === STEPS.length - 1;

          return (
            <React.Fragment key={label}>
              <li className="flex items-center gap-2">
                {/* Step indicator */}
                <div
                  aria-current={isActive ? 'step' : undefined}
                  className={[
                    'grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors',
                    // respect prefers-reduced-motion: we only use color transitions (no translate/scale)
                    'motion-safe:transition-colors',
                    isCompleted
                      ? 'bg-[var(--color-stellar-mint)] text-[var(--color-ink-900)]'
                      : isActive
                        ? 'bg-[var(--color-stellar-yellow)] text-[var(--color-ink-900)]'
                        : 'bg-[var(--color-cream-200)] text-[var(--color-ink-400,#94a3b8)]',
                  ].join(' ')}
                >
                  {isCompleted ? <Check size={13} /> : stepNum}
                </div>
                {/* Label */}
                <span
                  className={[
                    'text-sm font-semibold',
                    isActive
                      ? 'text-[var(--color-ink-900)]'
                      : isCompleted
                        ? 'text-[var(--color-stellar-mint)]'
                        : 'text-[var(--color-ink-400,#94a3b8)]',
                  ].join(' ')}
                >
                  {label}
                </span>
              </li>
              {/* Connector */}
              {!isLast && (
                <div
                  aria-hidden
                  className={[
                    'mx-3 h-px flex-1 min-w-[1.5rem] transition-colors',
                    'motion-safe:transition-colors',
                    stepNum < current
                      ? 'bg-[var(--color-stellar-mint)]'
                      : 'bg-[var(--color-cream-200)]',
                  ].join(' ')}
                />
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Main SdkPanel
// ---------------------------------------------------------------------------

export function SdkPanel({
  user,
  onVerified,
}: {
  user: CreatorUser;
  onVerified: (domain: string) => void;
}) {
  // If the user already has a verified domain, skip the wizard and show the
  // verified/return state. Re-issue puts them into step 2.
  const isVerified = !!(user.domainVerified && user.domain);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [domain, setDomain] = useState<string>(user.domain ?? '');
  const [nonce, setNonce] = useState<string>('');
  const [token, setToken] = useState<string>('');
  const [framework, setFramework] = useState<Framework>('next');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether we're in "re-issue" mode (verified return user clicking Re-issue token)
  const [reissuing, setReissuing] = useState(false);

  // Focus management: move focus to the step container when step changes
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only move focus on step changes in the wizard (not on initial mount)
    if (step > 1) {
      stepRef.current?.focus();
    }
  }, [step]);

  // ---- Step 2: init on mount (or when entering step 2) ----
  const [initDone, setInitDone] = useState(false);

  const runInit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.sdkProvisionInit();
      setNonce(res.nonce);
      setInitDone(true);
    } catch (e) {
      setError(provisionErrorMessage(e instanceof Error ? e.message : ''));
    } finally {
      setBusy(false);
    }
  };

  // Auto-init when step 2 is first entered
  useEffect(() => {
    if (step === 2 && !initDone) {
      void runInit();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ---- Step 1 handlers ----
  const handleContinue = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      setError('Enter a valid public domain (e.g. example.com — no http:// or paths).');
      return;
    }
    setDomain(normalized);
    setError(null);
    setInitDone(false);
    setNonce('');
    setStep(2);
  };

  // ---- Step 2 handlers ----
  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.sdkProvisionVerify(domain, nonce);
      setToken(res.token);
      onVerified(domain);
      setStep(3);
      setReissuing(false);
    } catch (e) {
      setError(provisionErrorMessage(e instanceof Error ? e.message : ''));
    } finally {
      setBusy(false);
    }
  };

  const handleReInit = () => {
    setInitDone(false);
    setNonce('');
    setError(null);
    void runInit();
  };

  // ---- Re-issue token ----
  const handleReissue = () => {
    const confirmed = window.confirm(
      'Re-issuing your token rotates it immediately. Your old VERIVYX_TOKEN will stop working as soon as you save the new one. Continue?',
    );
    if (!confirmed) return;
    setReissuing(true);
    setDomain(user.domain ?? '');
    setError(null);
    setInitDone(false);
    setNonce('');
    setToken('');
    setStep(2);
  };

  // ---- Verified return state (no wizard) ----
  // Skip this when we hold a freshly-issued `token` — that token is shown once,
  // only in Step 3, so a just-completed verify (which flips isVerified via the
  // api.me() refresh in onVerified) must still render Step 3 to reveal it.
  if (isVerified && !reissuing && !token) {
    const verifiedDomain = user.domain!;
    return (
      <div className="space-y-6">
        {/* Heading */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
              SDK integration
            </p>
            <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="font-mono normal-case tracking-normal">{verifiedDomain}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-stellar-mint)]/15 px-2.5 py-0.5 text-sm font-semibold text-[var(--color-stellar-mint)]">
                <Check size={12} /> verified
              </span>
            </h2>
          </div>
          <button
            type="button"
            onClick={handleReissue}
            className="btn-dark text-sm"
          >
            <RotateCcw size={14} /> Re-issue token
          </button>
        </div>

        {/* Framework selector */}
        <div>
          <p className="mb-3 text-sm font-semibold text-[var(--color-ink-700)]">Framework</p>
          <FrameworkSelector value={framework} onChange={setFramework} />
        </div>

        {/* Install line */}
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-lg border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-2 font-mono text-sm text-[var(--color-ink-800,#1e293b)]">
            {snippetFor(framework, verifiedDomain).install}
          </code>
          <CopyButton text={snippetFor(framework, verifiedDomain).install} label="Copy install" small />
        </div>

        {/* Code-as-hero */}
        <CodeHero framework={framework} domain={verifiedDomain} />

        {/* .env */}
        <EnvBlock domain={verifiedDomain} />

        {/* Docs link */}
        <div>
          <a
            href="/docs/sdk"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-ink-700)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink-900)]"
          >
            View SDK docs <ExternalLink size={13} />
          </a>
        </div>
      </div>
    );
  }

  // ---- Wizard ----
  return (
    <div className="space-y-6">
      {/* Wizard heading */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
          SDK integration
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">
          {reissuing ? 'Re-issue your token' : 'Connect your site'}
        </h2>
        {!reissuing && (
          <p className="mt-1 text-sm text-[var(--color-ink-500)]">
            Prove you own the domain, get your token, and add one line to your route handler.
          </p>
        )}
      </div>

      {/* Stepper */}
      <Stepper current={step} />

      {/* Step container — receives focus on step change for keyboard/SR users */}
      <div
        ref={stepRef}
        tabIndex={-1}
        className="rounded-2xl border border-[var(--color-cream-200)] bg-white p-6 focus-visible:outline-none"
      >
        {/* --- Step 1: Add domain --- */}
        {step === 1 && (
          <form onSubmit={handleContinue} noValidate className="space-y-5">
            <div>
              <label htmlFor="sdk-domain" className="mb-1.5 block text-sm font-semibold text-[var(--color-ink-700)]">
                Your site domain
              </label>
              <input
                id="sdk-domain"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="example.com"
                value={domain}
                onChange={(e) => { setDomain(e.target.value); setError(null); }}
                className="input-field w-full"
              />
              <p className="mt-1.5 text-xs text-[var(--color-ink-400,#94a3b8)]">
                Enter just the domain — no https://, no path.
              </p>
            </div>

            {error && (
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            )}

            <button type="submit" className="btn-yellow">
              Continue
            </button>
          </form>
        )}

        {/* --- Step 2: Prove ownership --- */}
        {step === 2 && (
          <div className="space-y-5">
            <div>
              <p className="text-sm font-semibold text-[var(--color-ink-700)]">
                Add a DNS TXT record
              </p>
              <p className="mt-1 text-sm text-[var(--color-ink-500)]">
                Add the TXT record below at your DNS provider, then click Verify.
              </p>
            </div>

            {busy && !nonce ? (
              <div className="flex items-center gap-2 text-sm text-[var(--color-ink-500)]">
                <RefreshCw size={14} className="motion-safe:animate-spin" /> Getting your verification code…
              </div>
            ) : nonce ? (
              <>
                {/* DNS TXT record */}
                <div className="rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] p-4 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-400,#94a3b8)]">
                    Add this DNS TXT record at your DNS provider
                  </p>
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-[var(--color-ink-400,#94a3b8)]">Type</dt>
                    <dd className="font-mono text-[var(--color-ink-800,#1e293b)]">TXT</dd>
                    <dt className="text-[var(--color-ink-400,#94a3b8)]">Name / Host</dt>
                    <dd className="font-mono text-[var(--color-ink-800,#1e293b)]">
                      {dnsRecordName(domain).name}
                      <span className="block font-sans text-xs text-[var(--color-ink-400,#94a3b8)]">
                        Creates the record at <span className="font-mono">{dnsRecordName(domain).host}</span>. Most panels: enter the name shown above (for a root domain, <span className="font-mono">@</span>); some want the full name.
                      </span>
                    </dd>
                    <dt className="text-[var(--color-ink-400,#94a3b8)]">Value</dt>
                    <dd className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3">
                        <code className="min-w-0 flex-1 break-all font-mono text-[var(--color-ink-800,#1e293b)]">
                          {`verivyx-site-verification=${nonce}`}
                        </code>
                        <CopyButton text={`verivyx-site-verification=${nonce}`} label="Copy value" small />
                      </div>
                    </dd>
                  </dl>
                </div>

                {/* Propagation + expiry note */}
                <p className="text-xs text-[var(--color-ink-400,#94a3b8)]">
                  DNS can take a few minutes to propagate — click Verify after adding it. This code expires in 60 minutes.{' '}
                  <button
                    type="button"
                    onClick={handleReInit}
                    className="font-semibold underline underline-offset-2 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink-900)]"
                  >
                    Get a new code
                  </button>{' '}
                  if it expires.
                </p>
              </>
            ) : (
              /* init failed — offer retry */
              <button type="button" onClick={handleReInit} className="btn-dark text-sm">
                <RefreshCw size={13} /> Get verification code
              </button>
            )}

            {error && (
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            )}

            <form onSubmit={handleVerify} noValidate>
              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={busy || !nonce}
                  className="btn-yellow"
                >
                  {busy ? (
                    <>
                      <RefreshCw size={13} className="motion-safe:animate-spin" /> Verifying…
                    </>
                  ) : (
                    'Verify'
                  )}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setStep(1);
                    setInitDone(false);
                    setNonce('');
                    setError(null);
                  }}
                  className="btn-ghost text-sm"
                >
                  <ArrowLeft size={13} /> Back
                </button>
              </div>
            </form>
          </div>
        )}

        {/* --- Step 3: Install --- */}
        {step === 3 && (
          <div className="space-y-6">
            {/* Token — shown once */}
            {token && (
              <div className="rounded-xl border-2 border-[var(--color-stellar-yellow)] bg-[var(--color-stellar-yellow)]/5 p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-[var(--color-ink-900)]">Your VERIVYX_TOKEN</p>
                    <p className="mt-0.5 text-xs font-semibold text-[var(--color-stellar-yellow)]">
                      Copy it now — shown once. You cannot retrieve it again.
                    </p>
                  </div>
                  <CopyButton text={token} label="Copy token" />
                </div>
                <code className="block break-all rounded-lg bg-[var(--color-ink-900)] px-4 py-3 font-mono text-sm text-[var(--color-cream-100)]">
                  {token}
                </code>
              </div>
            )}

            {/* Framework selector */}
            <div>
              <p className="mb-3 text-sm font-semibold text-[var(--color-ink-700)]">Framework</p>
              <FrameworkSelector value={framework} onChange={setFramework} />
            </div>

            {/* Install line */}
            <div className="flex flex-wrap items-center gap-3">
              <code className="rounded-lg border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-2 font-mono text-sm text-[var(--color-ink-800,#1e293b)]">
                {snippetFor(framework, domain).install}
              </code>
              <CopyButton text={snippetFor(framework, domain).install} label="Copy install" small />
            </div>

            {/* Code-as-hero */}
            <CodeHero framework={framework} domain={domain} />

            {/* .env */}
            <EnvBlock domain={domain} />

            {/* Docs link */}
            <div>
              <a
                href="/docs/sdk"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-ink-700)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink-900)]"
              >
                View SDK docs <ExternalLink size={13} />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
