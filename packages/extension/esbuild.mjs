import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
};

const bundles = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    bundle: true,
    external: ['vscode'],
    outfile: 'out/extension.js',
  },
  {
    ...common,
    entryPoints: ['../manager/src/index.ts'],
    bundle: true,
    outfile: 'out/manager/index.js',
  },
  {
    ...common,
    entryPoints: ['src/test/e2e/runTest.ts'],
    bundle: true,
    outfile: 'out/test/e2e/runTest.js',
  },
  {
    ...common,
    entryPoints: ['src/test/e2e/suite/index.ts'],
    bundle: true,
    external: ['vscode'],
    outfile: 'out/test/e2e/suite/index.js',
  },
];

if (watch) {
  const ctxs = await Promise.all(bundles.map((opts) => context(opts)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching for changes…');
} else {
  await Promise.all(bundles.map((opts) => build(opts)));
}
