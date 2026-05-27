// Bundles the spechub CLI into a single self-contained dist/index.js.
//
// The bundle is what ships through the marketplace install – there is no npm
// install step downstream, so dist/index.js must run with no node_modules next
// to it. esbuild --bundle inlines our deps (commander, chalk, fast-glob, yaml,
// zod) and externalises node built-ins.
//
// The banner injects a real `require` (via createRequire) into the ESM bundle.
// Without it, CommonJS dependencies that internally call `require('node:events')`
// hit esbuild's __require fallback, which throws "Dynamic require of ... is not
// supported". This is the canonical esbuild ESM + CJS-dep workaround.
//
// Run:   node build.mjs           – one-shot build
//        node build.mjs --watch   – rebuild on src/ changes
import { build, context } from 'esbuild';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

const config = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/index.js',
  sourcemap: 'external',
  banner: {
    js: "import { createRequire as __spechubCreateRequire } from 'module'; const require = __spechubCreateRequire(import.meta.url);",
  },
};

rmSync('dist', { recursive: true, force: true });

if (watch) {
  const ctx = await context(config);
  await ctx.watch();
  console.log('esbuild: watching src/ -> dist/index.js');
} else {
  await build(config);
  console.log('esbuild: built dist/index.js');
}
