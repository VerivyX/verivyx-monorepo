import type { PoWResult } from './types';

// Proof-of-Work solver running in an inline blob Worker so the main thread stays free.
const WORKER_CODE = `
  var MAX_ITER_PER_CHECK = 1024;
  function leadingZeroBits(buf) {
    var bits = 0;
    for (var i = 0; i < buf.length; i++) {
      var byte_ = buf[i] !== undefined ? buf[i] : 0;
      if (byte_ === 0) { bits += 8; continue; }
      for (var b = 7; b >= 0; b--) {
        if ((byte_ >> b) & 1) return bits;
        bits += 1;
      }
      return bits;
    }
    return bits;
  }
  async function sha256(input) {
    var bytes = new TextEncoder().encode(input);
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }
  self.onmessage = async function(e) {
    var challenge = e.data.challenge, salt = e.data.salt;
    var difficulty = e.data.difficulty;
    var budgetMs = e.data.budgetMs !== undefined ? e.data.budgetMs : 15000;
    var start = performance.now();
    var nonce = BigInt(0);
    var iterations = 0;
    while (performance.now() - start < budgetMs) {
      for (var i = 0; i < MAX_ITER_PER_CHECK; i++) {
        var h = await sha256(challenge + ':' + salt + ':' + nonce.toString(16));
        iterations++;
        if (leadingZeroBits(h) >= difficulty) {
          self.postMessage({ ok: true, nonce: nonce.toString(16), iterations: iterations, durationMs: performance.now() - start });
          return;
        }
        nonce++;
      }
      await new Promise(function(r) { setTimeout(r, 0); });
    }
    self.postMessage({ ok: false, reason: 'budget_exceeded' });
  };
`;

type WorkerDoneMsg = { ok: true; nonce: string; durationMs: number } | { ok: false; reason: string };

export async function solvePoW(challenge: string, salt: string, difficulty: number): Promise<PoWResult> {
  return new Promise((resolve, reject) => {
    let worker!: Worker;
    try {
      const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl);
      URL.revokeObjectURL(blobUrl);
    } catch {
      reject(new Error('Failed to create PoW worker'));
      return;
    }
    worker.onmessage = (e: MessageEvent<WorkerDoneMsg>) => {
      worker.terminate();
      e.data.ok ? resolve({ nonce: e.data.nonce, durationMs: e.data.durationMs }) : reject(new Error(e.data.reason));
    };
    worker.onerror = (err: ErrorEvent) => { worker.terminate(); reject(new Error(err.message || 'worker_error')); };
    worker.postMessage({ challenge, salt, difficulty, budgetMs: 20000 });
  });
}
