import * as esbuild from 'esbuild';
import { statSync } from 'node:fs';

const OUTFILE = 'dist/gate.min.js';
const MAX_BYTES = 35 * 1024; // bundle-size budget — keep the embed lean

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: false,
  outfile: OUTFILE,
  target: ['es2020'],
  platform: 'browser',
  format: 'iife',
});

const bytes = statSync(OUTFILE).size;
if (bytes > MAX_BYTES) {
  console.error(`bundle too large: ${bytes} bytes > budget ${MAX_BYTES}`);
  process.exit(1);
}
console.log(`built ${OUTFILE} (${bytes} bytes, budget ${MAX_BYTES})`);
