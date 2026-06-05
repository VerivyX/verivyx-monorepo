'use client';

import { useEffect, useRef } from 'react';

// Public Turnstile site key (baked at build time). Empty → widget skipped and the
// backend treats it as a dev bypass (when its secret is also empty).
export const TURNSTILE_SITE_KEY =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) || '';

// Minimal typing for the Cloudflare Turnstile global (explicit-render mode).
type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      theme?: 'light' | 'dark' | 'auto';
    },
  ) => string;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    onTurnstileLoad?: () => void;
  }
}

const SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';

// Renders the Turnstile widget and reports the solved token to the parent.
// When `siteKey` is empty (dev), the widget is skipped. Remount with a changing
// React `key` to reset it (tokens are single-use after a submit attempt).
export function Turnstile({
  siteKey,
  onToken,
  onError,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  onError?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!siteKey) return; // dev bypass — no widget
    const el = ref.current;
    if (!el) return;

    const render = () => {
      if (!window.turnstile || widgetId.current || !ref.current) return;
      widgetId.current = window.turnstile.render(ref.current, {
        sitekey: siteKey,
        theme: 'light',
        callback: onToken,
        'error-callback': onError,
        'expired-callback': onError,
      });
    };

    if (window.turnstile) {
      render();
    } else if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      window.onTurnstileLoad = render;
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else {
      window.onTurnstileLoad = render;
    }

    return () => {
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [siteKey, onToken, onError]);

  if (!siteKey) return null;
  return <div ref={ref} className="flex justify-center" />;
}
