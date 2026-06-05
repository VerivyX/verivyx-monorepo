import React from 'react';

// Verivyx mark — an original geometric monogram: a node (the AI agent) above an
// asymmetric V that doubles as a verification check, set in a rounded tile. The
// rising right stroke reads as "verified / settled".
//
// tone "dark"  → ink tile, yellow mark (use on light/cream/white backgrounds)
// tone "light" → yellow tile, ink mark (use on dark backgrounds)
export function LogoMark({
  size = 32,
  tone = 'dark',
  className,
}: {
  size?: number;
  tone?: 'dark' | 'light';
  className?: string;
}) {
  const tile = tone === 'dark' ? '#0a0a0a' : '#fdda24';
  const mark = tone === 'dark' ? '#fdda24' : '#0a0a0a';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Verivyx"
    >
      <rect width="32" height="32" rx="9" fill={tile} />
      <circle cx="11.3" cy="9.8" r="1.85" fill={mark} />
      <path
        d="M7.4 13.2 L15.2 22.3 L24.8 7.7"
        stroke={mark}
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Full lockup: mark + "Verivyx" wordmark. `tone` controls the mark tile; the
// wordmark uses currentColor so it inherits the surrounding text color.
export function Logo({
  size = 32,
  tone = 'dark',
  showWord = true,
  className,
}: {
  size?: number;
  tone?: 'dark' | 'light';
  showWord?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <LogoMark size={size} tone={tone} />
      {showWord && <span className="text-lg font-semibold tracking-tight">Verivyx</span>}
    </span>
  );
}
