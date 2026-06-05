import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  sourcemap: false,
  outfile: 'dist/gate.min.js',
  target: ['es2020'],
  platform: 'browser',
  format: 'iife',
});

console.log('built dist/gate.min.js');
