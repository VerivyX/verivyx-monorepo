'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// Code block with a copy button. `lang` is shown as a label only.
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-ink-900)]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="font-mono text-xs uppercase tracking-widest text-white/40">{lang ?? 'code'}</span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 text-xs text-white/60 transition hover:text-white"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-relaxed text-[var(--color-cream-100)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}
