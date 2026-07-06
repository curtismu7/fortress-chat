// packages/extension/src/test/e2e/suite/index.ts
import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXT_ID = 'coachcurtis.fortress-chat';

type WebviewTestState = {
  webviewCount: number;
  initialized: boolean;
  postedTypes: string[];
  hasPolicy: boolean;
  hasError: boolean;
  hasProjectRules: boolean;
  chatMode: string;
  projectRulesPath: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWebviewState(): Promise<WebviewTestState> {
  return vscode.commands.executeCommand('fortress-chat.test.getWebviewState') as Promise<WebviewTestState>;
}

/** Smoke + webview wiring tests run inside the Extension Development Host. */
export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} should be loaded`);
  await ext!.activate();
  assert.ok(ext!.isActive, 'extension should activate');

  const cmds = await vscode.commands.getCommands(true);
  for (const id of [
    'fortress-chat.openChat',
    'fortress-chat.openChatInEditor',
    'fortress-chat.reloadWebview',
    'fortress-chat.toggleDevMode',
    'fortress-chat.test.getWebviewState',
  ]) {
    assert.ok(cmds.includes(id), `missing command ${id}`);
  }

  assert.ok(
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.includes('sample-app'),
    'fixture workspace should be open',
  );

  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand('fortressChat.chat.focus');
  });

  await sleep(3000);
  let state = await getWebviewState();
  assert.ok(state.webviewCount >= 1, 'sidebar webview should attach');
  assert.ok(
    state.hasPolicy || state.hasError,
    'webview should receive policy or daemon error banner',
  );
  assert.ok(state.hasProjectRules, 'fixture project rules should be posted to webview');
  assert.ok(
    state.projectRulesPath.includes('.fortress/rules.md'),
    'project rules path should point at fixture rules file',
  );

  await vscode.commands.executeCommand('fortress-chat.openChatInEditor');
  await sleep(1500);
  state = await getWebviewState();
  assert.ok(state.webviewCount >= 2, 'editor tab webview should attach alongside sidebar');

  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand('fortress-chat.reloadWebview');
  });
  state = await getWebviewState();
  assert.ok(state.webviewCount >= 2, 'webviews should survive hot reload');
  assert.ok(state.postedTypes.includes('policy') || state.hasError, 'reload should re-post state');
}
