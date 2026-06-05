// Web Worker that solves a PoW: find a nonce such that
// SHA-256(`${challenge}:${salt}:${nonce}`) has at least `difficulty` leading zero bits.
// We use the SubtleCrypto API available inside Workers.

declare const self: DedicatedWorkerGlobalScope;

type StartMsg = { challenge: string; salt: string; difficulty: number; budgetMs?: number };
type DoneMsg = { ok: true; nonce: string; iterations: number; durationMs: number } | { ok: false; reason: string };

const MAX_ITER_PER_CHECK = 1024;

function leadingZeroBits(buf: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let b = 7; b >= 0; b--) {
      if ((byte >> b) & 1) return bits;
      bits += 1;
    }
    return bits;
  }
  return bits;
}

async function sha256(input: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

self.onmessage = async (e: MessageEvent<StartMsg>) => {
  const { challenge, salt, difficulty } = e.data;
  const budgetMs = e.data.budgetMs ?? 15000;
  const start = performance.now();
  let nonce = 0n;
  let iterations = 0;

  while (performance.now() - start < budgetMs) {
    for (let i = 0; i < MAX_ITER_PER_CHECK; i++) {
      const h = await sha256(`${challenge}:${salt}:${nonce.toString(16)}`);
      iterations++;
      if (leadingZeroBits(h) >= difficulty) {
        const done: DoneMsg = {
          ok: true,
          nonce: nonce.toString(16),
          iterations,
          durationMs: performance.now() - start,
        };
        self.postMessage(done);
        return;
      }
      nonce++;
    }
    // yield control briefly (also keeps workers alive on Safari)
    await new Promise((r) => setTimeout(r, 0));
  }
  const failed: DoneMsg = { ok: false, reason: 'budget_exceeded' };
  self.postMessage(failed);
};
