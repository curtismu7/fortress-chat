import { build } from 'esbuild';

// extension host bundle
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  outfile: 'out/extension.js',
  sourcemap: true,
});

// manager daemon bundle shipped inside the extension
await build({
  entryPoints: ['../manager/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'out/manager/index.js',
  sourcemap: true,
});
