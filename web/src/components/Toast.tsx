'use client';

import React from 'react';

/** Single bottom-center toast, identical across every dashboard page. */
export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center px-4"
    >
      <div className="pointer-events-auto rounded-full bg-[var(--color-ink-900)] px-5 py-3 text-sm font-medium text-[var(--color-stellar-yellow)] shadow-lg">
        {message}
      </div>
    </div>
  );
}
