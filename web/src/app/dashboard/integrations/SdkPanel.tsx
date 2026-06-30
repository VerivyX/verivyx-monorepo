'use client';

import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  RefreshCw,
  X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { type Framework, FRAMEWORKS, snippetFor, type FrameworkSnippet } from './snippets';

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

function CodeHero({ snippet }: { snippet: FrameworkSnippet }) {
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
      // verivyxProxy / verivyxMiddleware / verivyxHonoMiddleware — the SDK call (mint)
      .replace(
        /(verivyx[A-Za-z]*)/g,
        '<span style="color:var(--color-stellar-mint)">$1</span>',
      )
      // import / const / export / from (ink-400)
      .replace(
        /\b(import|const|export|from|default)\b/g,
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
// Main SdkPanel — token-only. No domain entry, no DNS-TXT verification.
// Fetches the site token issued at signup and shows the copy-paste snippet.
// ---------------------------------------------------------------------------

export function SdkPanel() {
  const [token, setToken] = useState<string | null>(null);
  const [framework, setFramework] = useState<Framework>('next');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.sdkSite();
      setToken(res.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your site token.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snippet = snippetFor(framework, token ?? '');

  return (
    <div className="space-y-6">
      {/* Heading */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-ink-500)]">
          SDK integration
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">Connect your site</h2>
        <p className="mt-1 text-sm text-[var(--color-ink-500)]">
          Copy your site token and add one line of middleware. No domain, no DNS setup —
          humans pass through free, AI agents pay.
        </p>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-ink-500)]">
          <RefreshCw size={14} className="motion-safe:animate-spin" /> Loading your site token…
        </div>
      ) : (
        <>
          {/* Token */}
          <div className="rounded-xl border-2 border-[var(--color-stellar-yellow)] bg-[var(--color-stellar-yellow)]/5 p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-bold text-[var(--color-ink-900)]">Your VERIVYX_TOKEN</p>
                <p className="mt-0.5 text-xs text-[var(--color-ink-500)]">
                  Keep it secret — it authenticates your site to Verivyx.
                </p>
              </div>
              {token && <CopyButton text={token} label="Copy token" />}
            </div>
            <code className="block break-all rounded-lg bg-[var(--color-ink-900)] px-4 py-3 font-mono text-sm text-[var(--color-cream-100)]">
              {token ?? '—'}
            </code>
          </div>

          {/* Framework selector */}
          <div>
            <p className="mb-3 text-sm font-semibold text-[var(--color-ink-700)]">Framework</p>
            <FrameworkSelector value={framework} onChange={setFramework} />
          </div>

          {/* Install line */}
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded-lg border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] px-4 py-2 font-mono text-sm text-[var(--color-ink-800,#1e293b)]">
              {snippet.install}
            </code>
            <CopyButton text={snippet.install} label="Copy install" small />
          </div>

          {/* Code-as-hero */}
          <CodeHero snippet={snippet} />

          {/* Docs link */}
          <div>
            <a
              href="/docs/sdk"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-ink-700)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ink-900)]"
            >
              View SDK docs <ExternalLink size={13} />
            </a>
          </div>
        </>
      )}
    </div>
  );
}
