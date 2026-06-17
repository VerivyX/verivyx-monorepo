import type { VxConfig } from './types';

// Fetch the real body from the hydration endpoint and inject it into the stub
// container (#vx-article). Fail-closed: on any error returns false (caller shows
// retry) — never reveals a body that is not authorized.
export async function hydrateInject(cfg: VxConfig, headers: Record<string, string>): Promise<boolean> {
  const target = document.getElementById('vx-article');
  if (!target) return false;
  try {
    const res = await fetch(`${cfg.api}/api/v1/content/hydrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ domain: cfg.domain, slug: cfg.slug }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { html?: string };
    if (typeof data.html !== 'string' || data.html === '') return false;
    target.innerHTML = data.html;
    return true;
  } catch {
    return false;
  }
}

export function showRetry(): void {
  const target = document.getElementById('vx-article');
  if (target) {
    target.innerHTML = '<p class="vx-retry">Content couldn’t load. Please refresh to try again.</p>';
  }
}
