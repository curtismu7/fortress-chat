import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({ resolve: { alias: { vscode: resolve(__dirname, 'src/test/vscode-stub.ts') } } });
