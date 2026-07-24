const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const state = {
  messages: [],
  chats: [{ id: 'standalone', title: 'Standalone Chat', preview: '', updatedAt: Date.now(), folder: '', agentMode: false }],
};

function chatHtml() {
  const htmlPath = path.join(__dirname, '../../extension/media/chat.html');
  const raw = fs.readFileSync(htmlPath, 'utf8');
  const mediaFileUrl = (p) => pathToFileURL(path.join(__dirname, '../../extension/media', p)).toString();
  return raw
    .replace(/\{cspSource\}/g, 'file:')
    .replace('chat.css', mediaFileUrl('chat.css'))
    .replace('chat.js', mediaFileUrl('chat.js'))
    .replace('vendor/katex.min.css', mediaFileUrl('vendor/katex.min.css'))
    .replace('vendor/katex.min.js', mediaFileUrl('vendor/katex.min.js'))
    .replace('vendor/auto-render.min.js', mediaFileUrl('vendor/auto-render.min.js'))
    .replace('vendor/mermaid.min.js', mediaFileUrl('vendor/mermaid.min.js'));
}

function post(win, msg) {
  win.webContents.send('fc:message', msg);
}

function postBoot(win) {
  post(win, {
    type: 'policy',
    local: [{
      id: 'standalone-local',
      provider: 'local',
      displayName: 'Standalone Local',
      local: { catalogId: 'standalone-local' },
      agentCapable: true,
    }],
    hidden: [],
    google: [],
    openrouter: [],
  });
  post(win, { type: 'prefs', prompts: [], params: {} });
  post(win, { type: 'personas', personas: [] });
  post(win, { type: 'skills', skills: [] });
  post(win, { type: 'workspace', open: true });
  post(win, { type: 'projectRules', path: '.fortress/rules.md' });
  post(win, { type: 'memory', data: { enabled: false, facts: [] } });
  post(win, { type: 'folders', folders: [] });
  post(win, { type: 'docsStatus', stats: { files: 0, chunks: 0 } });
  post(win, { type: 'modelsDirectory', path: '', effective: '', defaultPath: '' });
  post(win, { type: 'mcpStatus', servers: [] });
  post(win, { type: 'mcpTools', tools: [] });
  post(win, { type: 'openRouterKeySet', set: false });
  post(win, { type: 'googleKeySet', set: false });
  post(win, { type: 'history', messages: state.messages });
  post(win, { type: 'chats', metas: state.chats, activeId: 'standalone' });
  post(win, {
    type: 'state',
    selectedId: 'standalone-local',
    status: {
      state: 'idle',
      binaryInstalled: true,
      downloadedModelIds: [],
      download: null,
      downloadError: null,
      ram: { totalBytes: 0, availableBytes: 0 },
    },
  });
  post(win, { type: 'hint', message: 'Standalone preview mode: VS Code-specific features are disabled.' });
}

function handleMessage(win, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'openSource') return;

  if (msg.type === 'send') {
    const userText = String(msg.text || '').trim();
    if (!userText) return;
    state.messages.push({ role: 'user', content: userText });
    post(win, { type: 'history', messages: state.messages });
    post(win, { type: 'token', text: 'Standalone app is running. ' });
    post(win, { type: 'token', text: 'This shell currently supports chat preview and MCP tool visibility.\n\n' });
    post(win, { type: 'token', text: `You said: ${userText}` });
    state.messages.push({ role: 'assistant', content: `Standalone app is running.\n\nYou said: ${userText}` });
    post(win, { type: 'reasoningDone' });
    post(win, { type: 'history', messages: state.messages });
    return;
  }

  if (msg.type === 'copyText') {
    post(win, { type: 'hint', message: 'Clipboard copy is available in the VS Code extension mode.' });
    return;
  }

  if (msg.type === 'openMcpSettings' || msg.type === 'reloadMcp' || msg.type === 'fetchMcpTools') {
    post(win, { type: 'mcpStatus', servers: [] });
    post(win, { type: 'mcpTools', tools: [] });
    post(win, { type: 'hint', message: 'MCP settings are available in extension mode; standalone MCP runtime is next step.' });
    return;
  }

  if (msg.type === 'attachImage' || msg.type === 'indexWorkspace' || msg.type === 'indexDocs') {
    post(win, { type: 'hint', message: 'This feature is not wired in standalone preview yet.' });
    return;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    title: 'FortressChat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(chatHtml())}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => postBoot(win));

  ipcMain.on('fc:postMessage', (_e, payload) => handleMessage(win, payload));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
