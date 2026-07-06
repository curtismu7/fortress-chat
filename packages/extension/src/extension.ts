import * as vscode from 'vscode';
import { join } from 'node:path';
import { ensureDaemon } from './daemon';
import { ChatViewProvider } from './chat/ChatViewProvider';
import { editFileWithApproval } from './agent/tools';

export function activate(context: vscode.ExtensionContext): void {
  const managerEntry = join(context.extensionPath, 'out', 'manager', 'index.js');
  const provider = new ChatViewProvider(context, () => ensureDaemon(managerEntry));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('fortressChat.chat', provider),
    vscode.commands.registerCommand('fortress-chat.openChatInEditor', () => provider.openInEditor()),
    vscode.commands.registerCommand('fortress-chat.openChat', () =>
      vscode.commands.executeCommand('fortressChat.chat.focus')),
    vscode.commands.registerCommand('fortress-chat.reloadWebview', () => provider.reloadWebviews()),
    vscode.commands.registerCommand('fortress-chat.reloadMcp', () => provider.reloadMcpServers()),
    vscode.commands.registerCommand('fortress-chat.reloadSkills', () => provider.reloadSkillsList()),
    vscode.commands.registerCommand('fortress-chat.toggleDevMode', async () => {
      const on = !context.globalState.get<boolean>('fortressChat.devMode', false);
      if (on) {
        const ok = await vscode.window.showWarningMessage(
          'Developer Mode bypasses the US-only governance and lets you use any Fireworks model (including non-US). Continue?',
          { modal: true }, 'Enable',
        );
        if (ok !== 'Enable') return;
      }
      await context.globalState.update('fortressChat.devMode', on);
      provider.setDevMode(on);
      void vscode.window.showInformationMessage(`FortressChat Developer Mode ${on ? 'ON — governance BYPASSED' : 'off'}`);
    }),
    ...['explain', 'fix', 'test', 'refactor', 'doc'].map((k) =>
      vscode.commands.registerCommand(`fortress-chat.${k}Selection`, async () => {
        await vscode.commands.executeCommand('fortressChat.chat.focus');
        provider.runSelectionAction(k);
      })),
    vscode.commands.registerCommand('fortress-chat.inlineEdit', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { void vscode.window.showErrorMessage('Open a file first.'); return; }
      const range = ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).range : ed.selection;
      const instruction = await vscode.window.showInputBox({ prompt: 'FortressChat — inline edit', placeHolder: 'e.g. add error handling' });
      if (!instruction) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'FortressChat editing…', cancellable: true }, async (_p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        try {
          const newCode = await provider.inlineEdit(ed.document.getText(range), instruction, ed.document.languageId, ac.signal);
          const full = ed.document.getText();
          const next = full.slice(0, ed.document.offsetAt(range.start)) + newCode + full.slice(ed.document.offsetAt(range.end));
          await editFileWithApproval(ed.document.fileName, next, vscode.workspace.asRelativePath(ed.document.fileName));
        } catch (e) {
          void vscode.window.showErrorMessage(`Inline edit failed: ${e instanceof Error ? e.message : e}`);
        }
      });
    }),
  );

  if (process.env.FORTRESS_CHAT_TEST === '1') {
    context.subscriptions.push(
      vscode.commands.registerCommand('fortress-chat.test.getWebviewState', () => provider.getTestState()),
    );
  }
}

export function deactivate(): void {}
