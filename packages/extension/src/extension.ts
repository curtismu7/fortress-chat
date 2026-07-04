import * as vscode from 'vscode';
import { join } from 'node:path';
import { ensureDaemon } from './daemon';
import { ChatViewProvider } from './chat/ChatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const managerEntry = join(context.extensionPath, 'out', 'manager', 'index.js');
  const provider = new ChatViewProvider(context, () => ensureDaemon(managerEntry));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('fortressCode.chat', provider),
    vscode.commands.registerCommand('fortress-code.openChat', () =>
      vscode.commands.executeCommand('fortressCode.chat.focus')),
    vscode.commands.registerCommand('fortress-code.toggleDevMode', async () => {
      const on = !context.globalState.get<boolean>('fortressCode.devMode', false);
      if (on) {
        const ok = await vscode.window.showWarningMessage(
          'Developer Mode bypasses the US-only governance and lets you use any Fireworks model (including non-US). Continue?',
          { modal: true }, 'Enable',
        );
        if (ok !== 'Enable') return;
      }
      await context.globalState.update('fortressCode.devMode', on);
      provider.setDevMode(on);
      void vscode.window.showInformationMessage(`Fortress Code Developer Mode ${on ? 'ON — governance BYPASSED' : 'off'}`);
    }),
    ...['explain', 'fix', 'test', 'refactor', 'doc'].map((k) =>
      vscode.commands.registerCommand(`fortress-code.${k}Selection`, async () => {
        await vscode.commands.executeCommand('fortressCode.chat.focus');
        provider.runSelectionAction(k);
      })),
  );
}

export function deactivate(): void {}
