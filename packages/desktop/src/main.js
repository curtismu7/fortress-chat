const { app, BrowserWindow, ipcMain, shell } = require('electron');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { URL, pathToFileURL } = require('node:url');

const state = {
  messages: [],
  chats: [{ id: 'standalone', title: 'Standalone Chat', preview: '', updatedAt: Date.now(), folder: '', agentMode: false }],
};

let loginWindow = null;
let mainWindow = null;
let authInFlight = false;

const REQUIRED_DOMAIN = 'pingidentity.com';
const AUTH_SCOPE = 'openid email profile';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function userDataPath(fileName) {
  return path.join(app.getPath('userData'), fileName);
}

function getGoogleClientId() {
  return String(process.env.FORTRESS_GOOGLE_CLIENT_ID || '').trim();
}

function readAuthSession() {
  try {
    const raw = fs.readFileSync(userDataPath('auth-session.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeAuthSession(session) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userDataPath('auth-session.json'), JSON.stringify(session, null, 2), 'utf8');
}

function clearAuthSession() {
  try { fs.unlinkSync(userDataPath('auth-session.json')); } catch { /* noop */ }
}

function isSessionValid(session) {
  if (!session || typeof session !== 'object') return false;
  if (typeof session.email !== 'string' || typeof session.expiresAt !== 'number') return false;
  if (!session.email.toLowerCase().endsWith(`@${REQUIRED_DOMAIN}`)) return false;
  return session.expiresAt > Date.now();
}

function postLoginStatus(payload) {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.webContents.send('fc:auth-status', payload);
}

async function exchangeCodeForToken({ code, clientId, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json && typeof json.error_description === 'string' ? json.error_description : 'Token exchange failed.';
    throw new Error(detail);
  }
  return json;
}

async function verifyGoogleIdToken(idToken, clientId) {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json && typeof json.error_description === 'string' ? json.error_description : 'Could not verify Google ID token.';
    throw new Error(detail);
  }
  const email = String(json.email || '').toLowerCase();
  const emailVerified = String(json.email_verified || '').toLowerCase() === 'true';
  const hd = String(json.hd || '').toLowerCase();
  const aud = String(json.aud || '');
  const exp = Number(json.exp || 0);

  if (!email || !emailVerified) throw new Error('Google account email is not verified.');
  if (!email.endsWith(`@${REQUIRED_DOMAIN}`)) throw new Error(`Only @${REQUIRED_DOMAIN} accounts are allowed.`);
  if (hd && hd !== REQUIRED_DOMAIN) throw new Error(`Hosted domain mismatch. Expected ${REQUIRED_DOMAIN}.`);
  if (aud !== clientId) throw new Error('Token audience does not match this app.');
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) throw new Error('Google token is expired.');

  return { email, expiresAt: exp * 1000 };
}

function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return loginWindow;
  }
  loginWindow = new BrowserWindow({
    width: 520,
    height: 620,
    title: 'FortressChat Sign In',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const loginUrl = pathToFileURL(path.join(__dirname, 'login.html')).toString();
  loginWindow.loadURL(loginUrl);
  loginWindow.on('closed', () => { loginWindow = null; });
  return loginWindow;
}

async function beginGoogleLogin() {
  if (authInFlight) return;
  authInFlight = true;
  const clientId = getGoogleClientId();
  if (!clientId) {
    postLoginStatus({ state: 'error', message: 'Missing FORTRESS_GOOGLE_CLIENT_ID. Set it before launching the app.' });
    authInFlight = false;
    return;
  }

  postLoginStatus({ state: 'working', message: 'Opening Google sign-in in your browser…' });

  const codeVerifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
  const stateToken = base64Url(crypto.randomBytes(24));

  let timeoutId = null;
  let server = null;

  try {
    server = http.createServer();
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.on('error', reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Could not start local OAuth callback server.');
    const redirectUri = `http://127.0.0.1:${addr.port}/oauth2/callback`;

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', AUTH_SCOPE);
    authUrl.searchParams.set('prompt', 'select_account');
    authUrl.searchParams.set('hd', REQUIRED_DOMAIN);
    authUrl.searchParams.set('state', stateToken);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    timeoutId = setTimeout(() => {
      try { server && server.close(); } catch { /* noop */ }
    }, AUTH_TIMEOUT_MS);

    await shell.openExternal(authUrl.toString());
    postLoginStatus({ state: 'working', message: 'Waiting for Google sign-in…' });

    const authResult = await new Promise((resolve, reject) => {
      if (!server) return reject(new Error('OAuth callback server missing.'));
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      server.on('request', (req, res) => {
        try {
          const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
          if (reqUrl.pathname !== '/oauth2/callback') {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
          }

          const error = reqUrl.searchParams.get('error');
          const code = reqUrl.searchParams.get('code');
          const gotState = reqUrl.searchParams.get('state');

          if (error) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<h2>Sign-in cancelled.</h2><p>You can return to FortressChat.</p>');
            done(reject, new Error(`Google sign-in failed: ${error}`));
            return;
          }
          if (!code || !gotState || gotState !== stateToken) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<h2>Sign-in failed.</h2><p>Invalid callback state.</p>');
            done(reject, new Error('Invalid OAuth callback state.'));
            return;
          }

          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<h2>Sign-in complete.</h2><p>You can close this tab and return to FortressChat.</p>');
          done(resolve, { code });
        } catch (err) {
          done(reject, err);
        }
      });

      server.on('close', () => {
        done(reject, new Error('Google sign-in timed out. Please try again.'));
      });
      server.on('error', (err) => done(reject, err));
    });

    const token = await exchangeCodeForToken({
      code: authResult.code,
      clientId,
      redirectUri,
      codeVerifier,
    });

    const idToken = String(token.id_token || '');
    if (!idToken) throw new Error('Google did not return an ID token.');

    const verified = await verifyGoogleIdToken(idToken, clientId);
    writeAuthSession(verified);
    postLoginStatus({ state: 'ok', message: `Signed in as ${verified.email}` });

    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  } catch (err) {
    clearAuthSession();
    postLoginStatus({
      state: 'error',
      message: err instanceof Error ? err.message : 'Google sign-in failed.',
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try { server && server.close(); } catch { /* noop */ }
    authInFlight = false;
  }
}

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

  mainWindow = win;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(chatHtml())}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => postBoot(win));

  ipcMain.on('fc:postMessage', (_e, payload) => handleMessage(win, payload));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

app.whenReady().then(() => {
  const existing = readAuthSession();
  if (isSessionValid(existing)) createWindow();
  else {
    clearAuthSession();
    createLoginWindow();
  }

  ipcMain.handle('fc:auth-begin', async () => {
    await beginGoogleLogin();
    return { ok: true };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const current = readAuthSession();
      if (isSessionValid(current)) createWindow();
      else createLoginWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
