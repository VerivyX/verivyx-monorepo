'use client';

import React from 'react';
import { Download, Server } from 'lucide-react';
import { type CreatorUser } from '@/lib/api';

export function WordPressPanel({ user: _user }: { user: CreatorUser }) {
  return (
    <>
      {/* WordPress plugin — server-level blocking */}
      <section className="surface-card mt-8 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Server size={18} /> WordPress? Block at the server too
            </h2>
            <p className="mt-1 max-w-xl text-sm text-[var(--color-ink-500)]">
              The script tag stops JS-rendering bots. For full coverage — including{' '}
              <span className="font-mono text-xs">curl</span>, ChatGPT and other raw HTTP
              scrapers — install the WordPress plugin. It enforces the 402 paywall on the
              server before any HTML leaves your site. Humans still pass through automatically.
            </p>
          </div>
          <a
            href="/verivyx-paywall.zip"
            download
            className="btn-primary shrink-0 text-sm"
          >
            <Download size={14} /> Download plugin
          </a>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            {
              step: '01',
              title: 'Upload & activate',
              body: "WordPress Admin → Plugins → Add New → Upload Plugin → choose the ZIP, then Activate. That’s it.",
            },
            {
              step: '02',
              title: 'Zero config',
              body: 'No keys, no IDs. The plugin auto-detects your domain and points at Verivyx on activation. (Optional: Settings → Verivyx to choose which content to protect.)',
            },
            {
              step: '03',
              title: 'Done — raw HTTP pays too',
              body: 'curl, ChatGPT, and AI agents now get a 402 with payment instructions. Browsers load normally.',
            },
          ].map((s) => (
            <div key={s.step} className="rounded-xl border border-[var(--color-cream-200)] bg-[var(--color-cream-50)] p-5">
              <span className="font-mono text-xs text-[var(--color-ink-300)]">{s.step}</span>
              <h3 className="mt-2 text-sm font-semibold">{s.title}</h3>
              <p className="mt-1.5 text-xs text-[var(--color-ink-500)]">{s.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
