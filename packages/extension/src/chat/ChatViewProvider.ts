import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy, localEntries, explainBlock, type PolicyEntry, type StatusResponse } from '@fortress-code/shared';
import { DaemonClient } from '../daemon';
import { Session } from './session';
import { resolveTarget } from '../providers/target';
import { resolveDevTarget } from '../providers/dev';
import { DEV_PRESETS } from '../devPresets';
import { streamChat } from '../providers/stream';
import { runAgentTurn } from '../agent/loop';
import { getOpenRouterKey, setOpenRouterKey, getFireworksKey, setFireworksKey } from '../secrets';

const SYSTEM_PROMPT = 'You are Fortress Code, a helpful local coding assistant.';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private client: DaemonClient | null = null;
  private session: Session;
  private generating: AbortController | null = null;
  private agentMode = false;
  private selected: PolicyEntry | null = null;
  private devMode = false;
  private devModel: string | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(private context: vscode.ExtensionContext, private connect: () => Promise<DaemonClient>) {
    this.session = Session.load(context.workspaceState);
    this.devMode = context.globalState.get<boolean>('fortressCode.devMode', false);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    let html = readFileSync(join(this.context.extensionPath, 'media', 'chat.html'), 'utf8');
    html = html.replace(/\{cspSource\}/g, view.webview.cspSource);
    for (const f of ['chat.css', 'chat.js']) {
      html = html.replace(f, view.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString());
    }
    view.webview.html = html;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    void this.init();
  }

  private post(msg: unknown): void { void this.view?.webview.postMessage(msg); }
  private banner(message: string): void { this.post({ type: 'error', message }); }

  private async init(): Promise<void> {
    try {
      this.client = await this.connect();
      this.post({ type: 'policy', local: localEntries(), openrouter: loadPolicy().filter((e) => e.provider === 'openrouter') });
      this.post({ type: 'openRouterKeySet', set: !!(await getOpenRouterKey(this.context.secrets)) });
      await this.postDev();
      this.post({ type: 'history', messages: this.session.messages });
      this.poller = setInterval(() => void this.pushStatus(), 2000);
      this.context.subscriptions.push({ dispose: () => this.poller && clearInterval(this.poller) });
      await this.pushStatus();
    } catch (e) {
      this.banner(`Could not start the Fortress Code daemon: ${e}`);
    }
  }

  setDevMode(on: boolean): void {
    this.devMode = on;
    if (!on) this.devModel = null;
    void this.postDev();
  }

  private async postDev(): Promise<void> {
    this.post({ type: 'devMode', on: this.devMode, presets: DEV_PRESETS, fireworksKeySet: !!(await getFireworksKey(this.context.secrets)) });
  }

  private async pushStatus(): Promise<void> {
    if (!this.client) return;
    try {
      const status: StatusResponse = await this.client.status();
      this.post({ type: 'state', status, selectedId: this.selected?.id ?? null });
    } catch {
      this.client = null; // daemon idle-exited; next action re-spawns
    }
  }

  private async onMessage(m: any): Promise<void> {
    try {
      switch (m.type) {
        case 'send': return await this.handleSend(String(m.text));
        case 'cancel': this.generating?.abort(); return;
        case 'newChat': this.session.clear(); this.session.save(this.context.workspaceState); this.post({ type: 'history', messages: [] }); return;
        case 'agentToggle': this.agentMode = !!m.on; return;
        case 'selectModel': return await this.selectModel(String(m.id));
        case 'addModel': return this.handleAddModel(String(m.slug));
        case 'setOpenRouterKey': await setOpenRouterKey(this.context.secrets, String(m.key)); this.post({ type: 'openRouterKeySet', set: true }); return;
        case 'setFireworksKey': await setFireworksKey(this.context.secrets, String(m.key)); await this.postDev(); return;
        case 'selectDevModel': this.devModel = String(m.slug) || null; this.selected = null; return;
        case 'downloadModel': await this.client?.download(String(m.catalogId)); return;
        case 'installBinary': await this.client?.installBinary(); return;
        case 'killForeign': await this.client?.foreignKill(m.pids); return;
      }
    } catch (e) {
      this.banner(String(e));
    }
  }

  private async selectModel(id: string): Promise<void> {
    const entry = loadPolicy().find((e) => e.id === id);
    if (!entry) return;
    this.selected = entry;
    if (entry.provider === 'local') {
      if (!this.client) this.client = await this.connect();
      try {
        const r = await this.client.start(entry.local!.catalogId);
        if (!r.ok) this.post({ type: 'startRejected', rejection: r.rejection, modelId: id });
      } catch (e) {
        const msg = String(e);
        if (msg.includes('428')) this.banner('This model needs to be downloaded first — click it to download.');
        else this.banner(msg);
      }
    }
    await this.pushStatus();
  }

  private handleAddModel(slug: string): void {
    const reason = explainBlock(slug);
    if (reason) { this.post({ type: 'addBlocked', slug, reason }); return; }
    // Approved slug: it is already in the registry; surface it as selectable.
    this.post({ type: 'addAccepted', slug });
  }

  private async targetDeps() {
    const status = this.client ? await this.client.status().catch(() => null) : null;
    return {
      localEndpoint: status?.endpoint ?? undefined,
      openRouterKey: await getOpenRouterKey(this.context.secrets),
    };
  }

  private async handleSend(text: string): Promise<void> {
    let target;
    try {
      if (this.devMode && this.devModel) {
        const key = await getFireworksKey(this.context.secrets);
        target = resolveDevTarget(this.devModel, key ?? '');
      } else if (this.selected) {
        if (!this.client) this.client = await this.connect();
        target = resolveTarget(this.selected, await this.targetDeps());
      } else {
        this.banner('Pick a model first.'); this.post({ type: 'restoreInput', text }); return;
      }
    } catch (e) {
      this.banner(String(e instanceof Error ? e.message : e));
      this.post({ type: 'restoreInput', text });
      return;
    }
    const preTurnLen = this.session.messages.length;
    this.session.addUser(text);
    this.post({ type: 'history', messages: this.session.messages });
    this.generating = new AbortController();
    try {
      if (this.agentMode) {
        await runAgentTurn(target, this.session, SYSTEM_PROMPT, (step) => this.post({ type: 'agentStep', step }), this.generating.signal);
      } else {
        const full = await streamChat(target, this.session.toRequestMessages(SYSTEM_PROMPT), (t) => this.post({ type: 'token', text: t }), this.generating.signal);
        this.session.addAssistant(full);
      }
      this.session.save(this.context.workspaceState);
      this.post({ type: 'history', messages: this.session.messages });
    } catch (e) {
      this.session.messages.length = preTurnLen; // error hygiene: remove user msg + any tool exchange from the failed turn
      this.session.save(this.context.workspaceState);
      this.post({ type: 'history', messages: this.session.messages });
      this.post({ type: 'restoreInput', text });
      this.banner(String(e instanceof Error ? e.message : e));
    } finally {
      this.generating = null;
    }
  }
}
