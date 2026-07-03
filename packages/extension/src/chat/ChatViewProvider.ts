import * as vscode from 'vscode';
import type { DaemonClient } from '../daemon';

// Minimal placeholder — Task 13 replaces this wholesale with the real chat webview.
export class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connect: () => Promise<DaemonClient>,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: false };
    view.webview.html = '<p>Fortress Code chat is not implemented yet.</p>';
  }
}
