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
  );
}

export function deactivate(): void {}
