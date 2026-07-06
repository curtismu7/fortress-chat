// packages/extension/src/test/e2e/runTest.ts
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/** Launch VS Code Extension Development Host and run the smoke test suite. */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const testWorkspace = path.resolve(extensionDevelopmentPath, '../../fixtures/sample-app');
  const tmp = path.join(os.tmpdir(), 'fortress-chat-vscode-test');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      FORTRESS_CODE_TEST: '1',
    },
    launchArgs: [
      testWorkspace,
      `--user-data-dir=${path.join(tmp, 'user-data')}`,
      `--extensions-dir=${path.join(tmp, 'extensions')}`,
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
