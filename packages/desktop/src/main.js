const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { homedir } = require('node:os');

const state = {
  messages: [],
  chats: [{ id: 'standalone', title: 'Standalone Chat', preview: '', updatedAt: Date.now(), folder: '', agentMode: false }],
  mcpServers: [],
  mcpTools: [],
  activeMcpServerName: '',
  activeMcpSearchToolName: '',
  modelsDirectoryPath: '',
  themeMode: 'dark',
  chatMode: 'ask',
  runMode: 'manual',
  selectedModelId: null,
  localCatalog: [],
};

let loginWindow = null;
let mainWindow = null;
let authInFlight = false;

const REQUIRED_DOMAINS = ['pingidentity.com', 'pingone.com'];
const AUTH_SCOPE = 'openid email profile';
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const STANDALONE_SETTINGS_FILE = 'standalone-settings.json';
const MCP_OAUTH_TIMEOUT_MS = 180000;
const MCP_OAUTH_CALLBACK_PORT = Number.parseInt(String(process.env.FORTRESS_MCP_OAUTH_CALLBACK_PORT || '8759'), 10) || 8759;
const MAX_MCP_SERVERS = 10;
const DEFAULT_MCPPLAYGROUND_SERVER = {
  name: 'mcp-playground-online',
  transport: 'http',
  url: 'https://mcpplaygroundonline.com/mcp-app-server',
};
const LOCAL_ORG = {
  gemma3: 'Google',
  'gpt-oss': 'OpenAI',
  embedding: 'Nomic AI',
  qwythos: 'Empero AI',
};

function fortressDataDir() {
  const explicit = String(process.env.FC_DATA_DIR || '').trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) fs.mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  const dir = path.join(homedir(), 'Library', 'Application Support', 'fortress-chat');
  const legacy = path.join(homedir(), 'Library', 'Application Support', 'fortress-code');
  if (fs.existsSync(legacy) && !fs.existsSync(dir)) {
    try { fs.renameSync(legacy, dir); } catch { /* keep legacy if rename fails */ }
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function daemonInfoPath() {
  return path.join(fortressDataDir(), 'daemon.json');
}

function readDaemonInfo() {
  try {
    const raw = fs.readFileSync(daemonInfoPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const port = Number(parsed.port);
    const pid = Number(parsed.pid);
    const token = String(parsed.token || '').trim();
    if (!Number.isFinite(port) || port <= 0 || !Number.isFinite(pid) || pid <= 0 || !token) return null;
    return { port, pid, token };
  } catch {
    return null;
  }
}

function createDaemonClient(port, token) {
  const call = async (route, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      ...init,
      headers: {
        'x-fc-token': token,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (res.status === 401) throw new Error('Local runtime auth failed.');
    return res;
  };

  return {
    async alive() {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { 'x-fc-token': token },
          signal: AbortSignal.timeout(1500),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    async status() {
      return (await call('/status')).json();
    },
    async catalog() {
      return (await call('/catalog')).json();
    },
    async installBinary() {
      await call('/install-binary', { method: 'POST', body: '{}' });
    },
    async download(modelId) {
      await call('/download', { method: 'POST', body: JSON.stringify({ modelId }) });
    },
    async cancelDownload() {
      await call('/download/cancel', { method: 'POST', body: '{}' });
    },
    async deleteModel(modelId) {
      await call('/delete-model', { method: 'POST', body: JSON.stringify({ modelId }) });
    },
    async start(modelId) {
      const res = await call('/start', { method: 'POST', body: JSON.stringify({ modelId }) });
      if (res.status === 200) return { ok: true };
      if (res.status === 409) return { ok: false, rejection: await res.json() };
      const body = await res.text().catch(() => '');
      throw new Error(`Model start failed: HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
    },
  };
}

function resolveManagerEntryPath() {
  const candidates = [
    path.join(__dirname, '../../manager/dist/index.js'),
    path.join(process.resourcesPath || '', 'manager/dist/index.js'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked/manager/dist/index.js'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function ensureStandaloneDaemonClient() {
  const existing = readDaemonInfo();
  if (existing) {
    const client = createDaemonClient(existing.port, existing.token);
    if (await client.alive()) return client;
  }

  const entry = resolveManagerEntryPath();
  if (!entry) {
    throw new Error('Local runtime is unavailable (manager bundle not found).');
  }

  spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = readDaemonInfo();
    if (info) {
      const client = createDaemonClient(info.port, info.token);
      if (await client.alive()) return client;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error('Local runtime did not start within 10s.');
}

function mapCatalogToPolicy(catalog) {
  const chatModels = Array.isArray(catalog)
    ? catalog.filter((m) => m && typeof m === 'object' && m.embedding !== true)
    : [];

  const mapped = chatModels.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    provider: 'local',
    agentCapable: !!m.toolCalling,
    origin: { org: LOCAL_ORG[m.family] || 'US Developer', country: 'US' },
    hosting: { kind: 'on-device' },
    approved: true,
    local: { catalogId: m.id, hidden: !!m.hidden },
  }));

  return {
    local: mapped.filter((m) => !m.local.hidden),
    hidden: mapped.filter((m) => m.local.hidden),
  };
}

function pickSelectedModelId(policyModels, status) {
  const all = [...(policyModels.local || []), ...(policyModels.hidden || [])];
  const ids = new Set(all.map((m) => m.id));
  if (state.selectedModelId && ids.has(state.selectedModelId)) return state.selectedModelId;

  const downloaded = Array.isArray(status?.downloadedModelIds) ? status.downloadedModelIds : [];
  const downloadedFirst = all.find((m) => downloaded.includes(m.local?.catalogId || ''));
  if (downloadedFirst) return downloadedFirst.id;
  return all[0]?.id || null;
}

async function syncStandaloneRuntime(win) {
  const client = await ensureStandaloneDaemonClient();
  const [status, catalog] = await Promise.all([client.status(), client.catalog()]);
  state.localCatalog = Array.isArray(catalog) ? catalog : [];

  const policyModels = mapCatalogToPolicy(state.localCatalog);
  state.selectedModelId = pickSelectedModelId(policyModels, status);

  post(win, {
    type: 'policy',
    local: policyModels.local,
    hidden: policyModels.hidden,
    google: [],
    openrouter: [],
  });

  post(win, {
    type: 'state',
    selectedId: state.selectedModelId,
    status,
  });

  return { client, status, policyModels };
}

function userDataPath(fileName) {
  return path.join(app.getPath('userData'), fileName);
}

function normalizeStandaloneMcpServerRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const command = typeof row.command === 'string' ? row.command.trim() : '';
  const url = typeof row.url === 'string' ? row.url.trim() : '';
  if (!name || (!command && !url)) return null;

  const transport = row.transport === 'stdio' || row.transport === 'http' || row.transport === 'sse'
    ? row.transport
    : undefined;
  const args = Array.isArray(row.args) ? row.args.filter((a) => typeof a === 'string') : undefined;
  const env = row.env && typeof row.env === 'object' && !Array.isArray(row.env)
    ? Object.fromEntries(Object.entries(row.env).filter(([, v]) => typeof v === 'string'))
    : undefined;
  const headers = row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)
    ? Object.fromEntries(Object.entries(row.headers).filter(([, v]) => typeof v === 'string'))
    : undefined;
  const messageUrl = typeof row.messageUrl === 'string' ? row.messageUrl.trim() : undefined;
  const oauth = row.oauth && typeof row.oauth === 'object' && !Array.isArray(row.oauth)
    ? {
      authorizeUrl: typeof row.oauth.authorizeUrl === 'string' ? row.oauth.authorizeUrl.trim() : undefined,
      tokenUrl: typeof row.oauth.tokenUrl === 'string' ? row.oauth.tokenUrl.trim() : undefined,
      clientId: typeof row.oauth.clientId === 'string' ? row.oauth.clientId.trim() : undefined,
      scope: typeof row.oauth.scope === 'string' ? row.oauth.scope.trim() : undefined,
      audience: typeof row.oauth.audience === 'string' ? row.oauth.audience.trim() : undefined,
    }
    : undefined;
  const hasOauth = oauth && Object.values(oauth).some((v) => !!v);

  return {
    name,
    transport,
    command: command || undefined,
    args: args?.length ? args : undefined,
    env: env && Object.keys(env).length ? env : undefined,
    url: url || undefined,
    headers: headers && Object.keys(headers).length ? headers : undefined,
    messageUrl: messageUrl || undefined,
    oauth: hasOauth ? oauth : undefined,
    builtin: row.builtin === true,
  };
}

function bytesToGiB(bytes) {
  return `${(Number(bytes || 0) / 2 ** 30).toFixed(1)} GB`;
}

function formatInsufficientMemoryError(rejection, totalBytes) {
  const requiredBytes = Number(rejection?.requiredBytes || 0);
  const availableBytes = Number(rejection?.availableBytes || 0);
  const shortfallBytes = Math.max(0, requiredBytes - availableBytes);
  if (!totalBytes || totalBytes <= 0) {
    return `Unable to start model: required ${bytesToGiB(requiredBytes)}, available ${bytesToGiB(availableBytes)} (short by ${bytesToGiB(shortfallBytes)}). FortressChat also keeps a 15% RAM safety reserve.`;
  }
  const reserveBytes = 0.15 * totalBytes;
  const minimumFreeBytes = requiredBytes + reserveBytes;
  return `Unable to start model: required ${bytesToGiB(requiredBytes)} + reserve ${bytesToGiB(reserveBytes)} (minimum free ${bytesToGiB(minimumFreeBytes)}), available ${bytesToGiB(availableBytes)}.`;
}

function randomBase64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

async function createOAuthCallbackListener(stateExpected) {
  let finish = null;
  const codePromise = new Promise((resolve, reject) => {
    finish = { resolve, reject };
  });

  const server = http.createServer((req, res) => {
    const done = (err, code) => {
      try { server.close(); } catch { /* noop */ }
      if (err) finish.reject(err);
      else finish.resolve(code);
    };

    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const code = String(reqUrl.searchParams.get('code') || '').trim();
      const state = String(reqUrl.searchParams.get('state') || '').trim();
      const error = String(reqUrl.searchParams.get('error') || '').trim();
      const errorDescription = String(reqUrl.searchParams.get('error_description') || '').trim();

      if (error) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Sign-in failed. You can close this tab and return to FortressChat.');
        done(new Error(errorDescription || error));
        return;
      }
      if (!code) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Missing authorization code. You can close this tab and return to FortressChat.');
        done(new Error('Missing authorization code in callback.'));
        return;
      }
      if (state !== stateExpected) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('State mismatch. You can close this tab and return to FortressChat.');
        done(new Error('OAuth state mismatch.'));
        return;
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Sign-in complete. You can close this tab and return to FortressChat.');
      done(null, code);
    } catch (err) {
      done(err instanceof Error ? err : new Error(String(err)));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(MCP_OAUTH_CALLBACK_PORT, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    try { server.close(); } catch { /* noop */ }
    throw new Error('Could not bind OAuth callback listener.');
  }

  const redirectUri = `http://127.0.0.1:${addr.port}/oauth/callback`;
  return {
    redirectUri,
    waitForCode: () => Promise.race([
      codePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('OAuth sign-in timed out.')), MCP_OAUTH_TIMEOUT_MS)),
    ]),
    close: () => {
      try { server.close(); } catch { /* noop */ }
    },
  };
}

function readStandaloneSettings() {
  try {
    const raw = fs.readFileSync(userDataPath(STANDALONE_SETTINGS_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveStandaloneSettings() {
  try {
    const cleanServers = Array.isArray(state.mcpServers)
      ? state.mcpServers
        .map((row) => normalizeStandaloneMcpServerRow(row))
        .filter((row) => row && row.builtin !== true)
      : [];
    const payload = {
      mcpServers: cleanServers,
      modelsDirectoryPath: String(state.modelsDirectoryPath || '').trim(),
      themeMode: state.themeMode === 'light' ? 'light' : 'dark',
      updatedAt: Date.now(),
    };
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(userDataPath(STANDALONE_SETTINGS_FILE), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Persistence should never block app behavior.
  }
}

function loadStandaloneSettings() {
  const saved = readStandaloneSettings();
  if (!saved) return;

  if (Array.isArray(saved.mcpServers)) {
    const byName = new Map();
    saved.mcpServers.forEach((row) => {
      const clean = normalizeStandaloneMcpServerRow(row);
      if (clean?.name) byName.set(clean.name, clean);
    });
    state.mcpServers = [...byName.values()];
  }

  if (typeof saved.modelsDirectoryPath === 'string') {
    state.modelsDirectoryPath = saved.modelsDirectoryPath.trim();
  }

  if (saved.themeMode === 'light' || saved.themeMode === 'dark') {
    state.themeMode = saved.themeMode;
  }
}

function ensureStandaloneMcpDefaults() {
  const current = Array.isArray(state.mcpServers) ? state.mcpServers : [];
  const hasDefaultByName = current.some((row) => String(row?.name || '').trim() === DEFAULT_MCPPLAYGROUND_SERVER.name);
  const hasDefaultByUrl = current.some((row) => String(row?.url || '').trim() === DEFAULT_MCPPLAYGROUND_SERVER.url);
  if (current.length >= MAX_MCP_SERVERS) return;
  if (hasDefaultByName || hasDefaultByUrl) return;
  upsertStandaloneMcpServers([DEFAULT_MCPPLAYGROUND_SERVER]);
}

function normalizeMcpRuntimeError(server, errText) {
  const raw = String(errText || '').trim();
  if (!raw) return 'Unknown MCP error.';
  const lower = raw.toLowerCase();
  const serverUrl = String(server?.url || '').trim().toLowerCase();
  const isBrave = String(server?.command || '').trim() === 'npx'
    && Array.isArray(server?.args)
    && server.args.includes('@modelcontextprotocol/server-brave-search');
  if (isBrave && lower.includes('brave_api_key') && lower.includes('required')) {
    return 'Brave MCP requires BRAVE_API_KEY. Open MCP settings, edit brave-search, and set Env BRAVE_API_KEY to a valid key.';
  }
  const isMcpPlaygroundAuthServer = serverUrl.includes('mcpplaygroundonline.com/mcp-auth-server');
  const authFailure = lower.includes('401') || lower.includes('invalid_token') || lower.includes('no authorization provided');
  if (isMcpPlaygroundAuthServer && authFailure) {
    return 'MCP Playground auth server requires valid OAuth sign-in. Open MCP settings for this server and click Connect OAuth (or replace/remove stale Bearer token), then fetch tools again.';
  }
  return raw;
}

function getEnv(name) {
  return String(process.env[name] || '').trim();
}

function boolEnv(name) {
  const value = getEnv(name).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function normalizeIssuer(issuer) {
  return issuer.replace(/\/+$/, '');
}

async function discoverOidcFromIssuer(issuer) {
  const normalized = normalizeIssuer(issuer);
  const discoveryUrl = `${normalized}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = String(json.error_description || json.error || `OIDC discovery failed (${res.status}).`);
    throw new Error(detail);
  }
  return {
    deviceEndpoint: String(json.device_authorization_endpoint || ''),
    tokenEndpoint: String(json.token_endpoint || ''),
    userinfoEndpoint: String(json.userinfo_endpoint || ''),
  };
}

async function getOidcConfig() {
  const issuer = getEnv('FORTRESS_OIDC_ISSUER');
  let discovered = null;
  let discoveryError = null;
  if (issuer) {
    try {
      discovered = await discoverOidcFromIssuer(issuer);
    } catch (err) {
      discoveryError = err instanceof Error ? err.message : 'OIDC discovery failed.';
    }
  }

  const config = {
    clientId: getEnv('FORTRESS_OIDC_CLIENT_ID'),
    clientSecret: getEnv('FORTRESS_OIDC_CLIENT_SECRET'),
    deviceEndpoint: getEnv('FORTRESS_OIDC_DEVICE_AUTHORIZATION_ENDPOINT') || String(discovered?.deviceEndpoint || ''),
    tokenEndpoint: getEnv('FORTRESS_OIDC_TOKEN_ENDPOINT') || String(discovered?.tokenEndpoint || ''),
    userinfoEndpoint: getEnv('FORTRESS_OIDC_USERINFO_ENDPOINT') || String(discovered?.userinfoEndpoint || ''),
    issuer,
  };

  const missing = [];
  if (!config.clientId) missing.push('FORTRESS_OIDC_CLIENT_ID');
  if (!config.deviceEndpoint) missing.push('FORTRESS_OIDC_DEVICE_AUTHORIZATION_ENDPOINT');
  if (!config.tokenEndpoint) missing.push('FORTRESS_OIDC_TOKEN_ENDPOINT');

  return { config, missing, discoveryError };
}

function isDevAuthEnabled() {
  return !app.isPackaged && boolEnv('FORTRESS_DEV_AUTH_BYPASS');
}

function buildDevAuthSession() {
  const devEmail = (getEnv('FORTRESS_DEV_AUTH_EMAIL') || `dev@${REQUIRED_DOMAINS[0]}`).toLowerCase();
  return validateEmailAndBuildSession({
    email: devEmail,
    emailVerified: true,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  });
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
  const normalized = session.email.toLowerCase();
  if (!REQUIRED_DOMAINS.some((domain) => normalized.endsWith(`@${domain}`))) return false;
  return session.expiresAt > Date.now();
}

function postLoginStatus(payload) {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.webContents.send('fc:auth-status', payload);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJwtClaims(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function fetchForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

function validateEmailAndBuildSession({ email, emailVerified, expiresAt }) {
  const normalized = String(email || '').toLowerCase();
  const rawVerified = String(emailVerified ?? '').toLowerCase();
  const hasVerificationClaim = rawVerified === 'true' || rawVerified === 'false' || emailVerified === true || emailVerified === false;
  const verified = emailVerified === true || rawVerified === 'true';
  const hasAllowedDomain = REQUIRED_DOMAINS.some((domain) => normalized.endsWith(`@${domain}`));
  if (!normalized) {
    throw new Error('Account email is missing or not provided by the IdP.');
  }
  if (hasVerificationClaim && !verified) {
    throw new Error('Account email is not verified by the IdP.');
  }
  if (!hasAllowedDomain) {
    throw new Error(`Only ${REQUIRED_DOMAINS.map((d) => `@${d}`).join(' or ')} accounts are allowed. Received: ${normalized || '(none)'}`);
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('Authentication token is expired.');
  }
  return { email: normalized, expiresAt };
}

function pickEmailFromClaims(claims) {
  if (!claims || typeof claims !== 'object') return '';
  const candidates = [
    claims.email,
    claims.preferred_username,
    claims.upn,
    claims.username,
    claims.mail,
    claims.unique_name,
  ];
  for (const value of candidates) {
    const text = String(value || '').trim();
    if (text.includes('@')) return text;
  }
  return '';
}

function claimKeys(claims) {
  if (!claims || typeof claims !== 'object') return '(none)';
  const keys = Object.keys(claims);
  return keys.length ? keys.join(', ') : '(none)';
}

async function resolveIdentityFromToken({ accessToken, idToken, userinfoEndpoint, expiresInSeconds }) {
  const fallbackClaims = parseJwtClaims(idToken);

  if (userinfoEndpoint && accessToken) {
    const res = await fetch(userinfoEndpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const expiry = Date.now() + Math.max(60, Number(expiresInSeconds || 0)) * 1000;
      const email = pickEmailFromClaims(json);
      return validateEmailAndBuildSession({
        email,
        emailVerified: json.email_verified,
        expiresAt: expiry,
      });
    }
  }

  if (!fallbackClaims) {
    throw new Error('Could not resolve account identity from OIDC token response.');
  }

  const expiryFromClaims = Number(fallbackClaims.exp || 0) * 1000;
  const expiryFromToken = Date.now() + Math.max(60, Number(expiresInSeconds || 0)) * 1000;
  const expiry = Number.isFinite(expiryFromClaims) && expiryFromClaims > Date.now()
    ? expiryFromClaims
    : expiryFromToken;

  const email = pickEmailFromClaims(fallbackClaims);
  if (!email) {
    const keys = claimKeys(fallbackClaims);
    throw new Error(`Account email is missing or not provided by the IdP. Claims seen: ${keys}`);
  }

  return validateEmailAndBuildSession({
    email,
    emailVerified: fallbackClaims.email_verified,
    expiresAt: expiry,
  });
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

async function beginOidcDeviceLogin() {
  if (authInFlight) return;
  authInFlight = true;
  const { config, missing, discoveryError } = await getOidcConfig();

  if (isDevAuthEnabled() && missing.length > 0) {
    try {
      const devSession = buildDevAuthSession();
      writeAuthSession(devSession);
      postLoginStatus({
        state: 'ok',
        message: `DEV bypass active. Signed in as ${devSession.email}`,
      });
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    } catch (err) {
      postLoginStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'DEV sign-in failed.',
      });
    } finally {
      authInFlight = false;
    }
    return;
  }

  if (missing.length > 0) {
    postLoginStatus({
      state: 'error',
      message: discoveryError
        ? `${discoveryError} Missing required env vars: ${missing.join(', ')}`
        : `Missing required env vars: ${missing.join(', ')}`,
    });
    authInFlight = false;
    return;
  }

  postLoginStatus({ state: 'working', message: 'Requesting device sign-in code…' });

  try {
    const start = await fetchForm(config.deviceEndpoint, {
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      scope: AUTH_SCOPE,
    });

    if (!start.ok) {
      const detail = String(start.json.error_description || start.json.error || 'Could not start device authorization flow.');
      throw new Error(detail);
    }

    const deviceCode = String(start.json.device_code || '');
    const userCode = String(start.json.user_code || '');
    const verifyUrl = String(start.json.verification_uri_complete || start.json.verification_uri || '');
    const expiresInSeconds = Math.max(1, Number(start.json.expires_in || 0));
    let pollIntervalSeconds = Math.max(2, Number(start.json.interval || 5));

    if (!deviceCode || !verifyUrl) {
      throw new Error('Device authorization response is missing required fields.');
    }

    await shell.openExternal(verifyUrl);
    if (userCode) {
      postLoginStatus({
        state: 'working',
        message: `In your browser, complete sign-in with code: ${userCode}`,
      });
    } else {
      postLoginStatus({ state: 'working', message: 'Complete sign-in in your browser…' });
    }

    const deadline = Date.now() + Math.min(AUTH_TIMEOUT_MS, expiresInSeconds * 1000);
    let tokenResponse = null;

    while (Date.now() < deadline) {
      await sleep(pollIntervalSeconds * 1000);
      const poll = await fetchForm(config.tokenEndpoint, {
        grant_type: DEVICE_CODE_GRANT,
        device_code: deviceCode,
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      });

      if (poll.ok) {
        tokenResponse = poll.json;
        break;
      }

      const errorCode = String(poll.json.error || '');
      if (errorCode === 'authorization_pending') continue;
      if (errorCode === 'slow_down') {
        pollIntervalSeconds += 5;
        continue;
      }
      if (errorCode === 'access_denied') {
        throw new Error('Sign-in was denied.');
      }
      if (errorCode === 'expired_token') {
        throw new Error('Device sign-in code expired. Please try again.');
      }

      const detail = String(poll.json.error_description || errorCode || 'OIDC token polling failed.');
      throw new Error(detail);
    }

    if (!tokenResponse) {
      throw new Error('Sign-in timed out. Please try again.');
    }

    const verified = await resolveIdentityFromToken({
      accessToken: String(tokenResponse.access_token || ''),
      idToken: String(tokenResponse.id_token || ''),
      userinfoEndpoint: config.userinfoEndpoint,
      expiresInSeconds: Number(tokenResponse.expires_in || 0),
    });

    writeAuthSession(verified);
    postLoginStatus({ state: 'ok', message: `Signed in as ${verified.email}` });

    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  } catch (err) {
    clearAuthSession();
    postLoginStatus({
      state: 'error',
      message: err instanceof Error ? err.message : 'Sign-in failed.',
    });
  } finally {
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

function uiMcpConfig(row) {
  if (!row || typeof row !== 'object') return undefined;
  const headers = row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)
    ? Object.fromEntries(Object.entries(row.headers).filter(([k, v]) => k !== 'Authorization' && typeof v === 'string'))
    : undefined;
  const oauth = row.oauth && typeof row.oauth === 'object' && !Array.isArray(row.oauth)
    ? {
      authorizeUrl: typeof row.oauth.authorizeUrl === 'string' ? row.oauth.authorizeUrl : undefined,
      tokenUrl: typeof row.oauth.tokenUrl === 'string' ? row.oauth.tokenUrl : undefined,
      clientId: typeof row.oauth.clientId === 'string' ? row.oauth.clientId : undefined,
      scope: typeof row.oauth.scope === 'string' ? row.oauth.scope : undefined,
      audience: typeof row.oauth.audience === 'string' ? row.oauth.audience : undefined,
    }
    : undefined;
  return {
    transport: typeof row.transport === 'string' ? row.transport : undefined,
    command: typeof row.command === 'string' ? row.command : undefined,
    args: Array.isArray(row.args) ? row.args.filter((a) => typeof a === 'string') : undefined,
    env: row.env && typeof row.env === 'object' && !Array.isArray(row.env)
      ? Object.fromEntries(Object.entries(row.env).filter(([, v]) => typeof v === 'string'))
      : undefined,
    url: typeof row.url === 'string' ? row.url : undefined,
    messageUrl: typeof row.messageUrl === 'string' ? row.messageUrl : undefined,
    headers: headers && Object.keys(headers).length ? headers : undefined,
    hasAuthorization: !!(row.headers && typeof row.headers === 'object' && typeof row.headers.Authorization === 'string' && row.headers.Authorization.trim()),
    oauth: oauth && Object.values(oauth).some((v) => !!v) ? oauth : undefined,
  };
}

function postMcpState(win) {
  const servers = state.mcpServers.map((s) => ({
    name: s.name,
    connected: false,
    tools: 0,
    error: null,
    builtin: !!s.builtin,
    config: uiMcpConfig(s),
  }));
  post(win, { type: 'mcpStatus', servers });
  post(win, { type: 'mcpTools', tools: [] });
}

function defaultModelsDirectory() {
  return path.join(app.getPath('home'), '.fortress-chat', 'models');
}

function postModelsDirectoryState(win) {
  const selected = String(state.modelsDirectoryPath || '').trim();
  const fallback = defaultModelsDirectory();
  post(win, {
    type: 'modelsDirectory',
    path: selected,
    effective: selected || fallback,
    defaultPath: fallback,
  });
}

function framedPayload(rawJson) {
  return `Content-Length: ${Buffer.byteLength(rawJson, 'utf8')}\r\n\r\n${rawJson}`;
}

function parseRpcMessageFromHttp(text, contentType) {
  const body = String(text || '').trim();
  if (!body) return null;

  const isEventStream = String(contentType || '').toLowerCase().includes('text/event-stream')
    || body.startsWith('event:')
    || body.startsWith('data:');
  if (isEventStream) {
    const chunks = body.split(/\r?\n\r?\n/);
    for (const chunk of chunks) {
      const dataLines = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n').trim();
      if (!payload) continue;
      try { return JSON.parse(payload); } catch { /* try next chunk */ }
    }
    return null;
  }

  try { return JSON.parse(body); } catch { return null; }
}

async function fetchHttpMcpTools(server) {
  if (!server.url) throw new Error('MCP URL is required for HTTP transport.');

  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId++;
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(server.headers || {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await res.text();
    if (!res.ok) {
      const body = text.slice(0, 200);
      if (res.status === 401) {
        throw new Error('MCP auth failed (401): add a Bearer token or use Connect OAuth for this server.');
      }
      throw new Error(`MCP HTTP ${res.status}: ${body}`);
    }
    const msg = parseRpcMessageFromHttp(text, res.headers.get('content-type') || '');
    if (!msg) throw new Error('MCP HTTP response was not valid JSON-RPC');
    if (msg.error) throw new Error(String(msg.error.message || 'MCP error'));
    return msg.result;
  };

  const notify = async (method, params) => {
    await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(server.headers || {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => undefined);
  };

  const protocolVersions = ['2025-03-26', '2024-11-05', '2024-10-07'];
  let initialized = false;
  let initError = null;
  for (const protocolVersion of protocolVersions) {
    try {
      await request('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'fortress-chat-standalone', version: '0.1.0' },
      });
      initialized = true;
      break;
    } catch (e) {
      initError = e;
    }
  }
  if (!initialized) throw (initError || new Error('MCP initialize failed'));

  await notify('notifications/initialized', {});
  const listed = await request('tools/list', {});
  return Array.isArray(listed?.tools)
    ? listed.tools.map((t) => ({
      server: server.name,
      name: `${server.name}__${t.name}`,
      description: t.description || t.name,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))
    : [];
}

async function fetchStdioMcpTools(server, wireMode = 'framed') {
  return new Promise((resolve, reject) => {
    if (!server.command) {
      reject(new Error('Only stdio MCP servers are supported in standalone right now.'));
      return;
    }

    const proc = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
      env: { ...process.env, ...(server.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrText = '';
    let recvBuffer = '';
    let nextId = 1;
    const pending = new Map();
    let settled = false;

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* noop */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* noop */ }
      resolve(value);
    };

    const onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.id == null) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(String(msg.error.message || 'MCP error')));
        return;
      }
      p.resolve(msg.result);
    };

    const onRawMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      onMessage(msg);
    };

    const drainBuffer = () => {
      while (recvBuffer.length > 0) {
        const trimmed = recvBuffer.replace(/^[\r\n]+/, '');
        if (trimmed.length !== recvBuffer.length) recvBuffer = trimmed;
        const headerEndRfc = recvBuffer.indexOf('\r\n\r\n');
        const headerEndLf = recvBuffer.indexOf('\n\n');
        let headerEnd = -1;
        let sepLen = 0;
        if (headerEndRfc >= 0 && (headerEndLf < 0 || headerEndRfc < headerEndLf)) {
          headerEnd = headerEndRfc;
          sepLen = 4;
        } else if (headerEndLf >= 0) {
          headerEnd = headerEndLf;
          sepLen = 2;
        }

        const looksFramed = /^content-length\s*:/i.test(recvBuffer);
        if (looksFramed) {
          if (headerEnd < 0) return;
          const headerBlock = recvBuffer.slice(0, headerEnd);
          const lenMatch = headerBlock.match(/(?:^|\r?\n)content-length\s*:\s*(\d+)/i);
          if (!lenMatch) {
            recvBuffer = recvBuffer.slice(headerEnd + sepLen);
            continue;
          }
          const bodyLength = Number.parseInt(lenMatch[1], 10);
          const bodyStart = headerEnd + sepLen;
          if (recvBuffer.length < bodyStart + bodyLength) return;
          const body = recvBuffer.slice(bodyStart, bodyStart + bodyLength);
          recvBuffer = recvBuffer.slice(bodyStart + bodyLength);
          onRawMessage(body);
          continue;
        }

        const lineEnd = recvBuffer.indexOf('\n');
        if (lineEnd < 0) return;
        const line = recvBuffer.slice(0, lineEnd).trim();
        recvBuffer = recvBuffer.slice(lineEnd + 1);
        if (!line) continue;
        onRawMessage(line);
      }
    };

    proc.stdout.on('data', (d) => {
      recvBuffer += String(d);
      drainBuffer();
    });

    proc.stderr.on('data', (d) => {
      const msg = String(d).trim();
      if (msg) stderrText = `${stderrText}\n${msg}`.trim();
    });

    proc.on('error', (e) => {
      settleReject(new Error(e.message || 'Failed to start MCP process'));
    });

    const request = (method, params, timeoutMs = 8000) => {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      return new Promise((resolveReq, rejectReq) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectReq(new Error(`Timeout waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolveReq(v); },
          reject: (e) => { clearTimeout(timer); rejectReq(e); },
        });
        if (wireMode === 'newline') proc.stdin.write(`${payload}\n`);
        else proc.stdin.write(framedPayload(payload));
      });
    };

    const notify = (method, params) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
      if (wireMode === 'newline') proc.stdin.write(`${payload}\n`);
      else proc.stdin.write(framedPayload(payload));
    };

    (async () => {
      try {
        const protocolVersions = ['2025-03-26', '2024-11-05', '2024-10-07'];
        let initialized = false;
        let initError = null;
        for (const protocolVersion of protocolVersions) {
          try {
            await request('initialize', {
              protocolVersion,
              capabilities: {},
              clientInfo: { name: 'fortress-chat-standalone', version: '0.1.0' },
            }, 8000);
            initialized = true;
            break;
          } catch (e) {
            initError = e;
          }
        }
        if (!initialized) {
          throw initError || new Error('MCP initialize failed');
        }

        notify('notifications/initialized', {});
        const listed = await request('tools/list', {}, 8000);
        const tools = Array.isArray(listed?.tools)
          ? listed.tools.map((t) => ({
            server: server.name,
            name: `${server.name}__${t.name}`,
            description: t.description || t.name,
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
          }))
          : [];
        settleResolve(tools);
      } catch (e) {
        const detail = stderrText ? ` ${stderrText}` : '';
        settleReject(new Error(`${e instanceof Error ? e.message : String(e)}${detail}`.trim()));
      }
    })();
  });
}

async function startMcpOAuth(win, serverName) {
  const name = String(serverName || '').trim();
  if (!name) throw new Error('MCP server name is required for OAuth connect.');

  const server = (state.mcpServers || []).find((s) => s && s.name === name);
  if (!server) throw new Error(`MCP server "${name}" was not found.`);

  const oauth = server.oauth && typeof server.oauth === 'object' ? server.oauth : {};
  const authorizeUrl = String(oauth.authorizeUrl || '').trim();
  const tokenUrl = String(oauth.tokenUrl || '').trim();
  const clientId = String(oauth.clientId || '').trim();
  const scope = String(oauth.scope || 'openid profile').trim();
  const audience = String(oauth.audience || '').trim();

  if (!authorizeUrl || !tokenUrl || !clientId) {
    throw new Error('OAuth config is incomplete. Set authorize URL, token URL, and client ID in MCP settings.');
  }

  post(win, { type: 'hint', message: `Starting OAuth sign-in for MCP server "${name}"...` });

  const stateParam = randomBase64Url(24);
  const codeVerifier = randomBase64Url(64);
  const codeChallenge = sha256Base64Url(codeVerifier);

  let callback;
  try {
    callback = await createOAuthCallbackListener(stateParam);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EADDRINUSE')) {
      throw new Error(`OAuth callback port ${MCP_OAUTH_CALLBACK_PORT} is in use. Free the port or set FORTRESS_MCP_OAUTH_CALLBACK_PORT.`);
    }
    throw err instanceof Error ? err : new Error(msg);
  }
  try {
    const authUrl = new URL(authorizeUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', callback.redirectUri);
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('state', stateParam);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (audience) authUrl.searchParams.set('audience', audience);

    await shell.openExternal(authUrl.toString());
    post(win, { type: 'hint', message: 'Complete sign-in in your browser to connect MCP OAuth.' });

    const code = await callback.waitForCode();

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback.redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    if (audience) body.set('audience', audience);

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      const detail = String(tokenJson.error_description || tokenJson.error || `Token exchange failed (${tokenRes.status})`);
      throw new Error(detail);
    }

    const accessToken = String(tokenJson.access_token || '').trim();
    if (!accessToken) throw new Error('Token response did not include access_token.');

    upsertStandaloneMcpServers([{
      ...server,
      name,
      headers: {
        ...(server.headers && typeof server.headers === 'object' ? server.headers : {}),
        Authorization: `Bearer ${accessToken}`,
      },
      oauth: {
        authorizeUrl,
        tokenUrl,
        clientId,
        scope,
        audience: audience || undefined,
      },
    }]);

    post(win, { type: 'hint', message: `OAuth token saved for MCP server "${name}".` });
  } finally {
    callback.close();
  }
}

async function refreshMcpTools(win, selectedServerName = '') {
  const rows = Array.isArray(state.mcpServers) ? state.mcpServers : [];
  const statuses = [];
  const allTools = [];
  const selected = String(selectedServerName || '').trim();

  for (const server of rows) {
    if (!server?.name) continue;
    if (!server.command && !server.url) {
      statuses.push({
        name: server.name,
        connected: false,
        tools: 0,
        error: 'MCP server is missing command or URL.',
        builtin: !!server.builtin,
        config: uiMcpConfig(server),
      });
      continue;
    }

    try {
      let tools;
      if (server.command) {
        try {
          tools = await fetchStdioMcpTools(server, 'framed');
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e).toLowerCase();
          if (!msg.includes('timeout waiting for initialize')) throw e;
          tools = await fetchStdioMcpTools(server, 'newline');
        }
      } else {
        tools = await fetchHttpMcpTools(server);
      }
      statuses.push({
        name: server.name,
        connected: true,
        tools: tools.length,
        error: null,
        builtin: !!server.builtin,
        config: uiMcpConfig(server),
      });
      allTools.push(...tools);
    } catch (e) {
      const errTextRaw = e instanceof Error ? e.message : String(e);
      const errText = normalizeMcpRuntimeError(server, errTextRaw);
      const hasOauth = !!(server.oauth && typeof server.oauth === 'object');
      if (hasOauth && errText.includes('401')) {
        try {
          await startMcpOAuth(win, String(server.name || ''));
          const tools = server.command
            ? await fetchStdioMcpTools(server)
            : await fetchHttpMcpTools(server);
          statuses.push({
            name: server.name,
            connected: true,
            tools: tools.length,
            error: null,
            builtin: !!server.builtin,
            config: uiMcpConfig(server),
          });
          allTools.push(...tools);
          continue;
        } catch (oauthErr) {
          statuses.push({
            name: server.name,
            connected: false,
            tools: 0,
            error: oauthErr instanceof Error ? oauthErr.message : String(oauthErr),
            builtin: !!server.builtin,
            config: uiMcpConfig(server),
          });
          continue;
        }
      }
      statuses.push({
        name: server.name,
        connected: false,
        tools: 0,
        error: errText,
        builtin: !!server.builtin,
        config: uiMcpConfig(server),
      });
    }
  }

  const tools = selected
    ? allTools.filter((t) => String(t?.name || '').startsWith(`${selected}__`))
    : allTools;

  state.mcpTools = tools;

  post(win, { type: 'mcpStatus', servers: statuses });
  post(win, { type: 'mcpTools', tools });
  if (!rows.length) {
    post(win, { type: 'hint', message: 'No MCP servers configured yet. Import JSON or add a server first.' });
  } else if (!tools.length) {
    post(win, { type: 'hint', message: 'MCP servers loaded, but no tools were returned. Check server command/args and MCP status errors.' });
  } else {
    const scope = selected ? ` for ${selected}` : '';
    post(win, { type: 'hint', message: `Fetched ${tools.length} MCP tool${tools.length === 1 ? '' : 's'}${scope}.` });
  }
}

function shortMcpToolName(fullName, serverName) {
  const full = String(fullName || '').trim();
  const prefix = `${String(serverName || '').trim()}__`;
  if (prefix !== '__' && full.startsWith(prefix)) return full.slice(prefix.length);
  return full;
}

function isSearchIntent(text) {
  const q = String(text || '').trim();
  return /^(search|find|look\s+up|web\s+search)\b/i.test(q);
}

function extractSearchQuery(text) {
  const q = String(text || '').trim();
  return q.replace(/^(search|find|look\s+up|web\s+search)\s*/i, '').trim() || q;
}

function looksLikeSearchTool(tool) {
  if (!tool || typeof tool !== 'object') return false;
  const name = String(tool.name || '').toLowerCase();
  const props = Object.keys(tool.inputSchema?.properties || {}).map((k) => k.toLowerCase());
  const hasQueryArg = props.includes('q') || props.includes('query') || props.includes('keywords');
  const searchName = name.includes('search') || name.includes('news') || name.includes('web');
  return hasQueryArg && searchName;
}

function toolServerName(tool) {
  const explicit = String(tool?.server || '').trim();
  if (explicit) return explicit;
  const full = String(tool?.name || '');
  const idx = full.indexOf('__');
  if (idx > 0) return full.slice(0, idx);
  return '';
}

function buildSearchToolArgs(tool, queryText) {
  const out = {};
  const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(props).map((k) => k.toLowerCase());
  if (keys.includes('q')) out.q = queryText;
  else if (keys.includes('query')) out.query = queryText;
  else if (keys.includes('keywords')) out.keywords = queryText;

  if (keys.includes('country')) out.country = 'US';
  if (keys.includes('search_lang')) out.search_lang = 'en';
  if (keys.includes('freshness')) out.freshness = 'pm';
  return out;
}

function extractToolText(result) {
  if (!result || typeof result !== 'object') return String(result || '');
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      if (typeof c.text === 'string') return c.text;
      if (Object.hasOwn(c, 'json')) {
        try { return JSON.stringify(c.json); } catch { return ''; }
      }
      return '';
    })
    .filter(Boolean);
  if (parts.length) return parts.join('\n');
  if (Object.hasOwn(result, 'structuredContent')) {
    try { return JSON.stringify(result.structuredContent, null, 2); } catch { return String(result.structuredContent); }
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

function parseRpcMessageFromSseBody(text) {
  const body = String(text || '');
  const chunks = body.split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    const dataLines = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload) continue;
    try { return JSON.parse(payload); } catch { /* continue */ }
  }
  return null;
}

async function callHttpMcpTool(server, fullToolName, args) {
  if (!server.url) throw new Error('MCP URL is required for HTTP transport.');
  let nextId = 1;

  const request = async (method, params) => {
    const id = nextId++;
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(server.headers || {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await res.text();
    if (!res.ok) {
      const body = text.slice(0, 200);
      if (res.status === 401) throw new Error('MCP auth failed (401).');
      throw new Error(`MCP HTTP ${res.status}: ${body}`);
    }
    const rpc = parseRpcMessageFromHttp(text, res.headers.get('content-type') || '')
      || parseRpcMessageFromSseBody(text);
    if (!rpc) throw new Error('MCP HTTP response was not valid JSON-RPC');
    if (rpc.error) throw new Error(String(rpc.error.message || 'MCP error'));
    return rpc.result;
  };

  const notify = async (method, params) => {
    await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(server.headers || {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => undefined);
  };

  const protocolVersions = ['2025-03-26', '2024-11-05', '2024-10-07'];
  let initialized = false;
  let initError = null;
  for (const protocolVersion of protocolVersions) {
    try {
      await request('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'fortress-chat-standalone', version: '0.1.0' },
      });
      initialized = true;
      break;
    } catch (e) {
      initError = e;
    }
  }
  if (!initialized) throw (initError || new Error('MCP initialize failed'));

  await notify('notifications/initialized', {});
  const short = shortMcpToolName(fullToolName, server.name);
  return request('tools/call', { name: short, arguments: args || {} });
}

async function callStdioMcpTool(server, fullToolName, args, wireMode = 'framed') {
  return new Promise((resolve, reject) => {
    if (!server.command) {
      reject(new Error('Only stdio MCP servers are supported in standalone right now.'));
      return;
    }

    const proc = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
      env: { ...process.env, ...(server.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrText = '';
    let recvBuffer = '';
    let nextId = 1;
    const pending = new Map();
    let settled = false;

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* noop */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch { /* noop */ }
      resolve(value);
    };

    const onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.id == null) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(String(msg.error.message || 'MCP error')));
        return;
      }
      p.resolve(msg.result);
    };

    const onRawMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      onMessage(msg);
    };

    const drainBuffer = () => {
      while (recvBuffer.length > 0) {
        const trimmed = recvBuffer.replace(/^[\r\n]+/, '');
        if (trimmed.length !== recvBuffer.length) recvBuffer = trimmed;
        const headerEndRfc = recvBuffer.indexOf('\r\n\r\n');
        const headerEndLf = recvBuffer.indexOf('\n\n');
        let headerEnd = -1;
        let sepLen = 0;
        if (headerEndRfc >= 0 && (headerEndLf < 0 || headerEndRfc < headerEndLf)) {
          headerEnd = headerEndRfc;
          sepLen = 4;
        } else if (headerEndLf >= 0) {
          headerEnd = headerEndLf;
          sepLen = 2;
        }

        const looksFramed = /^content-length\s*:/i.test(recvBuffer);
        if (looksFramed) {
          if (headerEnd < 0) return;
          const headerBlock = recvBuffer.slice(0, headerEnd);
          const lenMatch = headerBlock.match(/(?:^|\r?\n)content-length\s*:\s*(\d+)/i);
          if (!lenMatch) {
            recvBuffer = recvBuffer.slice(headerEnd + sepLen);
            continue;
          }
          const bodyLength = Number.parseInt(lenMatch[1], 10);
          const bodyStart = headerEnd + sepLen;
          if (recvBuffer.length < bodyStart + bodyLength) return;
          const body = recvBuffer.slice(bodyStart, bodyStart + bodyLength);
          recvBuffer = recvBuffer.slice(bodyStart + bodyLength);
          onRawMessage(body);
          continue;
        }

        const lineEnd = recvBuffer.indexOf('\n');
        if (lineEnd < 0) return;
        const line = recvBuffer.slice(0, lineEnd).trim();
        recvBuffer = recvBuffer.slice(lineEnd + 1);
        if (!line) continue;
        onRawMessage(line);
      }
    };

    proc.stdout.on('data', (d) => {
      recvBuffer += String(d);
      drainBuffer();
    });

    proc.stderr.on('data', (d) => {
      const msg = String(d).trim();
      if (msg) stderrText = `${stderrText}\n${msg}`.trim();
    });

    proc.on('error', (e) => {
      settleReject(new Error(e.message || 'Failed to start MCP process'));
    });

    const request = (method, params, timeoutMs = 8000) => {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      return new Promise((resolveReq, rejectReq) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectReq(new Error(`Timeout waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolveReq(v); },
          reject: (e) => { clearTimeout(timer); rejectReq(e); },
        });
        if (wireMode === 'newline') proc.stdin.write(`${payload}\n`);
        else proc.stdin.write(framedPayload(payload));
      });
    };

    const notify = (method, params) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
      if (wireMode === 'newline') proc.stdin.write(`${payload}\n`);
      else proc.stdin.write(framedPayload(payload));
    };

    (async () => {
      try {
        const protocolVersions = ['2025-03-26', '2024-11-05', '2024-10-07'];
        let initialized = false;
        let initError = null;
        for (const protocolVersion of protocolVersions) {
          try {
            await request('initialize', {
              protocolVersion,
              capabilities: {},
              clientInfo: { name: 'fortress-chat-standalone', version: '0.1.0' },
            }, 8000);
            initialized = true;
            break;
          } catch (e) {
            initError = e;
          }
        }
        if (!initialized) {
          throw initError || new Error('MCP initialize failed');
        }

        notify('notifications/initialized', {});
        const short = shortMcpToolName(fullToolName, server.name);
        const result = await request('tools/call', { name: short, arguments: args || {} }, 12000);
        settleResolve(result);
      } catch (e) {
        const detail = stderrText ? ` ${stderrText}` : '';
        settleReject(new Error(`${e instanceof Error ? e.message : String(e)}${detail}`.trim()));
      }
    })();
  });
}

async function runMcpTool(server, fullToolName, args) {
  if (server.command) {
    try {
      return await callStdioMcpTool(server, fullToolName, args, 'framed');
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).toLowerCase();
      if (!msg.includes('timeout waiting for initialize')) throw e;
      return callStdioMcpTool(server, fullToolName, args, 'newline');
    }
  }
  return callHttpMcpTool(server, fullToolName, args);
}

async function maybeRunMcpSearch(win, userText) {
  if (!isSearchIntent(userText)) return null;

  const activeServer = String(state.activeMcpServerName || '').trim();
  if (!activeServer) {
    post(win, { type: 'hint', message: 'MCP search routing is strict: pick an active MCP server first.' });
    return null;
  }

  if (!Array.isArray(state.mcpTools) || state.mcpTools.length === 0) {
    await refreshMcpTools(win, activeServer).catch(() => undefined);
  }

  const tools = Array.isArray(state.mcpTools)
    ? state.mcpTools.filter((t) => toolServerName(t) === activeServer)
    : [];
  const activeToolName = String(state.activeMcpSearchToolName || '').trim();
  if (!activeToolName) {
    post(win, { type: 'hint', message: 'MCP search routing is strict: choose a specific MCP tool (Use tool) for search.' });
    return null;
  }
  const tool = tools.find((t) => String(t.name || '') === activeToolName && looksLikeSearchTool(t));
  if (!tool) {
    post(win, { type: 'hint', message: `Active MCP search tool not available on server ${activeServer}. Re-select a tool.` });
    return null;
  }

  const server = (state.mcpServers || []).find((s) => s && s.name === activeServer);
  if (!server) return null;

  const queryText = extractSearchQuery(userText);
  const args = buildSearchToolArgs(tool, queryText);
  try {
    const result = await runMcpTool(server, tool.name, args);
    const text = extractToolText(result).trim();
    if (!text) return null;
    post(win, { type: 'hint', message: `Used MCP tool ${tool.name} for web search context.` });
    return `MCP tool ${tool.name} result:\n${text.slice(0, 10000)}`;
  } catch {
    post(win, { type: 'hint', message: `MCP search tool failed (${tool.name}); continuing without MCP context.` });
    return null;
  }
}

async function executeMcpToolImmediate(win, fullToolName, args) {
  const toolName = String(fullToolName || '').trim();
  if (!toolName) throw new Error('Missing MCP tool name.');
  if (!Array.isArray(state.mcpTools) || state.mcpTools.length === 0) {
    await refreshMcpTools(win, String(state.activeMcpServerName || '').trim()).catch(() => undefined);
  }

  const tool = (state.mcpTools || []).find((t) => String(t?.name || '') === toolName);
  if (!tool) throw new Error(`MCP tool not found: ${toolName}`);

  const serverName = toolServerName(tool);
  if (!serverName) throw new Error(`Could not resolve MCP server for tool ${toolName}`);
  if (state.activeMcpServerName && state.activeMcpServerName !== serverName) {
    throw new Error(`Tool ${toolName} does not belong to active MCP server ${state.activeMcpServerName}.`);
  }

  const server = (state.mcpServers || []).find((s) => s && s.name === serverName);
  if (!server) throw new Error(`MCP server not found: ${serverName}`);

  const result = await runMcpTool(server, toolName, (args && typeof args === 'object' && !Array.isArray(args)) ? args : {});
  const text = extractToolText(result).trim();
  if (!text) throw new Error(`MCP tool returned no content: ${toolName}`);
  return text;
}

function normalizeImportedMcpServers(parsed) {
  if (Array.isArray(parsed)) {
    return parsed
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const row = entry;
        return {
          name: String(row.name || '').trim(),
          transport: typeof row.transport === 'string' ? row.transport : undefined,
          command: typeof row.command === 'string' ? row.command.trim() : undefined,
          args: Array.isArray(row.args) ? row.args.filter((a) => typeof a === 'string') : undefined,
          env: row.env && typeof row.env === 'object'
            ? Object.fromEntries(Object.entries(row.env).filter(([, v]) => typeof v === 'string'))
            : undefined,
          url: typeof row.url === 'string' ? row.url.trim() : undefined,
          messageUrl: typeof row.messageUrl === 'string' ? row.messageUrl.trim() : undefined,
          headers: row.headers && typeof row.headers === 'object'
            ? Object.fromEntries(Object.entries(row.headers).filter(([, v]) => typeof v === 'string'))
            : undefined,
          oauth: row.oauth && typeof row.oauth === 'object' && !Array.isArray(row.oauth)
            ? {
              authorizeUrl: typeof row.oauth.authorizeUrl === 'string' ? row.oauth.authorizeUrl.trim() : undefined,
              tokenUrl: typeof row.oauth.tokenUrl === 'string' ? row.oauth.tokenUrl.trim() : undefined,
              clientId: typeof row.oauth.clientId === 'string' ? row.oauth.clientId.trim() : undefined,
              scope: typeof row.oauth.scope === 'string' ? row.oauth.scope.trim() : undefined,
              audience: typeof row.oauth.audience === 'string' ? row.oauth.audience.trim() : undefined,
            }
            : undefined,
          disabled: row.disabled === true,
          builtin: row.builtin === true,
        };
      })
      .filter((row) => row.name && row.disabled !== true && (row.command || row.url));
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.servers && typeof parsed.servers === 'object') {
    return Object.entries(parsed.servers)
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([name, value]) => {
        const row = value;
        return {
          name,
          transport: row.transport === 'stdio' || row.transport === 'http' || row.transport === 'sse'
            ? row.transport
            : undefined,
          command: typeof row.command === 'string' ? row.command.trim() : undefined,
          args: Array.isArray(row.args) ? row.args.filter((a) => typeof a === 'string') : undefined,
          env: row.env && typeof row.env === 'object'
            ? Object.fromEntries(Object.entries(row.env).filter(([, v]) => typeof v === 'string'))
            : undefined,
          url: typeof row.url === 'string' ? row.url.trim() : undefined,
          messageUrl: typeof row.messageUrl === 'string' ? row.messageUrl.trim() : undefined,
          headers: row.headers && typeof row.headers === 'object'
            ? Object.fromEntries(Object.entries(row.headers).filter(([, v]) => typeof v === 'string'))
            : undefined,
          oauth: row.oauth && typeof row.oauth === 'object' && !Array.isArray(row.oauth)
            ? {
              authorizeUrl: typeof row.oauth.authorizeUrl === 'string' ? row.oauth.authorizeUrl.trim() : undefined,
              tokenUrl: typeof row.oauth.tokenUrl === 'string' ? row.oauth.tokenUrl.trim() : undefined,
              clientId: typeof row.oauth.clientId === 'string' ? row.oauth.clientId.trim() : undefined,
              scope: typeof row.oauth.scope === 'string' ? row.oauth.scope.trim() : undefined,
              audience: typeof row.oauth.audience === 'string' ? row.oauth.audience.trim() : undefined,
            }
            : undefined,
          disabled: row.disabled === true,
          builtin: false,
        };
      })
      .filter((row) => row.name && row.disabled !== true && (row.command || row.url));
  }

  throw new Error('Invalid MCP JSON. Expected an array or an object with a "servers" map.');
}

function upsertStandaloneMcpServers(rows) {
  const byName = new Map();
  for (const row of state.mcpServers) {
    const clean = normalizeStandaloneMcpServerRow(row);
    if (clean) byName.set(clean.name, clean);
  }
  for (const row of rows) {
    const clean = normalizeStandaloneMcpServerRow(row);
    if (clean) byName.set(clean.name, clean);
  }
  const merged = [...byName.values()];
  if (merged.length > MAX_MCP_SERVERS) {
    throw new Error(`You can configure up to ${MAX_MCP_SERVERS} MCP servers.`);
  }
  state.mcpServers = merged;
  saveStandaloneSettings();
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
  post(win, { type: 'prefs', prompts: [], params: {}, theme: state.themeMode === 'light' ? 'light' : 'dark' });
  post(win, { type: 'personas', personas: [] });
  post(win, { type: 'skills', skills: [] });
  post(win, { type: 'workspace', open: true });
  post(win, { type: 'projectRules', path: '.fortress/rules.md' });
  post(win, { type: 'memory', data: { enabled: false, facts: [] } });
  post(win, { type: 'folders', folders: [] });
  post(win, { type: 'docsStatus', stats: { files: 0, chunks: 0 } });
  postModelsDirectoryState(win);
  postMcpState(win);
  post(win, { type: 'openRouterKeySet', set: false });
  post(win, { type: 'googleKeySet', set: false });
  post(win, { type: 'history', messages: state.messages });
  post(win, { type: 'chats', metas: state.chats, activeId: 'standalone' });
  post(win, { type: 'chatMode', mode: state.chatMode, compareId: null, agentCapable: true });
  post(win, { type: 'runMode', mode: state.runMode });
  post(win, {
    type: 'state',
    selectedId: 'standalone-local',
    status: {
      state: 'idle',
      binaryInstalled: false,
      downloadedModelIds: [],
      download: null,
      downloadError: null,
      ram: { totalBytes: 0, availableBytes: 0 },
    },
  });
  post(win, { type: 'hint', message: 'Starting local runtime…' });
  void (async () => {
    try {
      await syncStandaloneRuntime(win);
      post(win, { type: 'hint', message: 'Standalone local runtime is ready.' });
    } catch (err) {
      post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      post(win, { type: 'hint', message: 'Local runtime is unavailable. Build the manager package, then restart standalone.' });
    }
  })();
}

function handleMessage(win, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'openSource') return;

  if (msg.type === 'setChatMode') {
    const mode = String(msg.mode || 'ask');
    if (!['ask', 'agent', 'plan', 'debug', 'multitask'].includes(mode)) return;
    state.chatMode = mode;
    state.chats = state.chats.map((chat) => (chat.id === 'standalone'
      ? { ...chat, agentMode: mode === 'agent' || mode === 'plan' || mode === 'debug' }
      : chat));
    post(win, { type: 'chatMode', mode: state.chatMode, compareId: null, agentCapable: true });
    post(win, { type: 'chats', metas: state.chats, activeId: 'standalone' });
    return;
  }

  if (msg.type === 'setRunMode') {
    const mode = String(msg.mode || 'manual');
    state.runMode = mode === 'auto' ? 'auto' : 'manual';
    post(win, { type: 'runMode', mode: state.runMode });
    return;
  }

  if (msg.type === 'setActiveMcpServer') {
    const name = String(msg.name || '').trim();
    state.activeMcpServerName = name;
    const activeToolName = String(state.activeMcpSearchToolName || '').trim();
    if (activeToolName) {
      const tool = (state.mcpTools || []).find((t) => String(t?.name || '') === activeToolName);
      if (!tool || toolServerName(tool) !== name) state.activeMcpSearchToolName = '';
    }
    return;
  }

  if (msg.type === 'setActiveMcpSearchTool') {
    const name = String(msg.name || '').trim();
    if (!name) {
      state.activeMcpSearchToolName = '';
      return;
    }
    const tool = (state.mcpTools || []).find((t) => String(t?.name || '') === name);
    if (!tool) return;
    const serverName = toolServerName(tool);
    if (state.activeMcpServerName && serverName && serverName !== state.activeMcpServerName) {
      return;
    }
    state.activeMcpSearchToolName = name;
    if (!state.activeMcpServerName && serverName) state.activeMcpServerName = serverName;
    post(win, { type: 'hint', message: `Active MCP search tool set to ${name}.` });
    return;
  }

  if (msg.type === 'selectModel') {
    state.selectedModelId = typeof msg.id === 'string' && msg.id.trim() ? msg.id.trim() : null;
    void (async () => {
      try {
        const { client, status, policyModels } = await syncStandaloneRuntime(win);
        const allModels = [...(policyModels.local || []), ...(policyModels.hidden || [])];
        const selected = allModels.find((m) => m.id === state.selectedModelId);
        if (!selected) return;
        const selectedCatalogId = selected.local?.catalogId || selected.id;
        if (Array.isArray(status.downloadedModelIds) && status.downloadedModelIds.includes(selectedCatalogId)) {
          const started = await client.start(selectedCatalogId);
          if (!started.ok) {
            post(win, { type: 'startRejected', rejection: started.rejection, modelId: selectedCatalogId });
            return;
          }
          await syncStandaloneRuntime(win);
        }
      } catch (err) {
        post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }

  if (msg.type === 'downloadModel') {
    const catalogId = typeof msg.catalogId === 'string' && msg.catalogId.trim() ? msg.catalogId.trim() : '';
    void (async () => {
      try {
        const client = await ensureStandaloneDaemonClient();
        if (!catalogId) throw new Error('No model selected for download.');
        await client.download(catalogId);
        post(win, { type: 'hint', message: 'Model download started.' });
        await syncStandaloneRuntime(win);
      } catch (err) {
        post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }

  if (msg.type === 'cancelDownload') {
    void (async () => {
      try {
        const client = await ensureStandaloneDaemonClient();
        await client.cancelDownload();
        await syncStandaloneRuntime(win);
        post(win, { type: 'hint', message: 'Download cancelled.' });
      } catch (err) {
        post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }

  if (msg.type === 'installBinary') {
    void (async () => {
      try {
        const client = await ensureStandaloneDaemonClient();
        await client.installBinary();
        post(win, { type: 'hint', message: 'Installing local engine…' });
        await syncStandaloneRuntime(win);
      } catch (err) {
        post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }

  if (msg.type === 'deleteModel') {
    const catalogId = typeof msg.catalogId === 'string' && msg.catalogId.trim() ? msg.catalogId.trim() : '';
    void (async () => {
      try {
        if (!catalogId) throw new Error('No model selected for delete.');
        const client = await ensureStandaloneDaemonClient();
        await client.deleteModel(catalogId);
        await syncStandaloneRuntime(win);
        post(win, { type: 'hint', message: 'Model deleted from disk.' });
      } catch (err) {
        post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }

  if (msg.type === 'send') {
    const userText = String(msg.text || '').trim();
    if (!userText) return;

    void (async () => {
      const preLen = state.messages.length;
      state.messages.push({ role: 'user', content: userText });
      post(win, { type: 'history', messages: state.messages });

      try {
        const client = await ensureStandaloneDaemonClient();
        const status = await client.status();

        const policyModels = mapCatalogToPolicy(state.localCatalog);
        const allModels = [...policyModels.local, ...policyModels.hidden];
        const selected = allModels.find((m) => m.id === state.selectedModelId) || allModels[0];
        if (!selected) {
          throw new Error('No local model available.');
        }

        const selectedCatalogId = selected.local?.catalogId || selected.id;
        if (!Array.isArray(status.downloadedModelIds) || !status.downloadedModelIds.includes(selectedCatalogId)) {
          throw new Error(`Model "${selected.displayName}" is not downloaded yet.`);
        }

        let activeStatus = status;
        const needsStart = !activeStatus.endpoint || activeStatus.modelId !== selectedCatalogId;
        if (needsStart) {
          const started = await client.start(selectedCatalogId);
          if (!started.ok) {
            post(win, { type: 'startRejected', rejection: started.rejection, modelId: selectedCatalogId });
            if (started.rejection?.reason === 'insufficient-memory') {
              throw new Error(formatInsufficientMemoryError(started.rejection, status?.ram?.totalBytes));
            }
            throw new Error('Unable to start selected local model.');
          }
          await syncStandaloneRuntime(win);
          activeStatus = await client.status();
        }

        if (!activeStatus.endpoint) throw new Error('Local model endpoint is unavailable.');

        const mcpContext = await maybeRunMcpSearch(win, userText);
        const convo = state.messages.map((m) => ({ role: m.role, content: String(m.content || '') }));
        if (mcpContext && convo.length > 0) {
          const last = convo[convo.length - 1];
          convo[convo.length - 1] = {
            role: last.role,
            content: `${String(last.content || '')}\n\nUse this external MCP search context when answering:\n${mcpContext}`,
          };
        }

        if (state.chatMode === 'plan' || state.chatMode === 'debug') {
          convo.push({
            role: 'system',
            content: state.chatMode === 'plan'
              ? 'You are in plan mode. Provide a clear step-by-step plan before implementation details.'
              : 'You are in debug mode. Focus on root cause analysis and minimal fixes.',
          });
        }
        const res = await fetch(`${activeStatus.endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: selectedCatalogId,
            stream: false,
            messages: convo,
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Inference failed: HTTP ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
        }

        const json = await res.json().catch(() => null);
        const content = String(json?.choices?.[0]?.message?.content || '').trim() || '(no reply)';
        post(win, { type: 'token', text: content });
        state.messages.push({ role: 'assistant', content });
        post(win, { type: 'reasoningDone' });
        post(win, { type: 'history', messages: state.messages });
      } catch (err) {
        state.messages.length = preLen;
        post(win, { type: 'history', messages: state.messages });
        post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
        post(win, { type: 'restoreInput', text: userText });
      }
    })();
    return;
  }

  if (msg.type === 'copyText') {
    post(win, { type: 'hint', message: 'Clipboard copy is available in the VS Code extension mode.' });
    return;
  }

  if (msg.type === 'openMcpSettings') {
    post(win, { type: 'hint', message: 'Use Import JSON or add MCP servers directly in this panel.' });
    return;
  }

  if (msg.type === 'reloadMcp' || msg.type === 'fetchMcpTools') {
    const selected = msg.type === 'fetchMcpTools' && typeof msg.server === 'string' ? msg.server.trim() : '';
    void refreshMcpTools(win, selected);
    return;
  }

  if (msg.type === 'executeMcpTool') {
    const name = String(msg.name || '').trim();
    const args = (msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args)) ? msg.args : {};
    void (async () => {
      try {
        const output = await executeMcpToolImmediate(win, name, args);
        const content = `MCP tool ${name} result:\n${output}`;
        state.messages.push({ role: 'assistant', content });
        post(win, { type: 'history', messages: state.messages });
        post(win, { type: 'hint', message: `Executed MCP tool ${name}.` });
      } catch (err) {
        post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }

  if (msg.type === 'importMcpJson') {
    const raw = String(msg.text || '').trim();
    if (!raw) {
      post(win, { type: 'error', message: 'No MCP JSON provided.' });
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const imported = normalizeImportedMcpServers(parsed);
      if (!imported.length) {
        post(win, { type: 'error', message: 'No valid MCP servers found in JSON.' });
        return;
      }
      upsertStandaloneMcpServers(imported);
      postMcpState(win);
      post(win, { type: 'hint', message: `Imported ${imported.length} MCP server${imported.length === 1 ? '' : 's'}.` });
    } catch (err) {
      post(win, { type: 'error', message: `Could not import MCP JSON: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }

  if (msg.type === 'importMcpJsonFile') {
    dialog.showOpenDialog(win, {
      title: 'Import MCP JSON file',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      defaultPath: path.join(process.cwd(), '.vscode', 'mcp.json'),
      buttonLabel: 'Import MCP JSON',
    }).then((result) => {
      if (result.canceled || !result.filePaths?.length) return;
      try {
        const raw = fs.readFileSync(result.filePaths[0], 'utf8');
        const parsed = JSON.parse(raw);
        const imported = normalizeImportedMcpServers(parsed);
        if (!imported.length) {
          post(win, { type: 'error', message: 'No valid MCP servers found in selected file.' });
          return;
        }
        upsertStandaloneMcpServers(imported);
        postMcpState(win);
        post(win, { type: 'hint', message: `Imported ${imported.length} MCP server${imported.length === 1 ? '' : 's'} from file.` });
      } catch (err) {
        post(win, { type: 'error', message: `Could not import MCP JSON file: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
    return;
  }

  if (msg.type === 'saveMcpServer') {
    const row = msg.server && typeof msg.server === 'object' ? msg.server : null;
    const name = row && typeof row.name === 'string' ? row.name.trim() : '';
    const command = row && typeof row.command === 'string' ? row.command.trim() : '';
    const url = row && typeof row.url === 'string' ? row.url.trim() : '';
    if (!name) {
      post(win, { type: 'error', message: 'MCP server name is required.' });
      return;
    }
    if (!command && !url) {
      post(win, { type: 'error', message: 'Provide an MCP command or URL.' });
      return;
    }
    const args = Array.isArray(row?.args) ? row.args.filter((a) => typeof a === 'string') : undefined;
    const env = row?.env && typeof row.env === 'object' && !Array.isArray(row.env)
      ? Object.fromEntries(Object.entries(row.env).filter(([, v]) => typeof v === 'string'))
      : undefined;
    const headers = row?.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)
      ? Object.fromEntries(Object.entries(row.headers).filter(([, v]) => typeof v === 'string'))
      : undefined;
    const transport = row?.transport === 'stdio' || row?.transport === 'http' || row?.transport === 'sse'
      ? row.transport
      : undefined;
    const messageUrl = row && typeof row.messageUrl === 'string' ? row.messageUrl.trim() : '';
    const oauth = row?.oauth && typeof row.oauth === 'object' && !Array.isArray(row.oauth)
      ? {
        authorizeUrl: typeof row.oauth.authorizeUrl === 'string' ? row.oauth.authorizeUrl.trim() : undefined,
        tokenUrl: typeof row.oauth.tokenUrl === 'string' ? row.oauth.tokenUrl.trim() : undefined,
        clientId: typeof row.oauth.clientId === 'string' ? row.oauth.clientId.trim() : undefined,
        scope: typeof row.oauth.scope === 'string' ? row.oauth.scope.trim() : undefined,
        audience: typeof row.oauth.audience === 'string' ? row.oauth.audience.trim() : undefined,
      }
      : undefined;
    const hasOauth = oauth && Object.values(oauth).some((v) => !!v);

    try {
      upsertStandaloneMcpServers([{
        name,
        transport,
        command: command || undefined,
        args: args?.length ? args : undefined,
        env: env && Object.keys(env).length ? env : undefined,
        url: url || undefined,
        headers: headers && Object.keys(headers).length ? headers : undefined,
        messageUrl: messageUrl || undefined,
        oauth: hasOauth ? oauth : undefined,
      }]);
    } catch (err) {
      post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    postMcpState(win);
    post(win, { type: 'hint', message: `Saved MCP server "${name}".` });
    return;
  }

  if (msg.type === 'startMcpOAuth') {
    const serverName = String(msg.serverName || '').trim();
    void (async () => {
      try {
        await startMcpOAuth(win, serverName);
        await refreshMcpTools(win);
      } catch (err) {
        post(win, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }

  if (msg.type === 'pickModelsDirectory') {
    dialog.showOpenDialog(win, {
      title: 'Choose local models folder',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultPath: String(state.modelsDirectoryPath || defaultModelsDirectory()),
      buttonLabel: 'Use this folder',
    }).then((result) => {
      if (result.canceled || !result.filePaths?.length) return;
      state.modelsDirectoryPath = String(result.filePaths[0] || '').trim();
      saveStandaloneSettings();
      postModelsDirectoryState(win);
      post(win, { type: 'modelsDirectoryStatus', message: 'Local models folder updated.' });
    }).catch((err) => {
      post(win, { type: 'error', message: `Could not open folder picker: ${err instanceof Error ? err.message : String(err)}` });
    });
    return;
  }

  if (msg.type === 'clearModelsDirectory') {
    state.modelsDirectoryPath = '';
    saveStandaloneSettings();
    postModelsDirectoryState(win);
    post(win, { type: 'modelsDirectoryStatus', message: 'Using default local models folder.' });
    return;
  }

  if (msg.type === 'setTheme') {
    state.themeMode = msg.mode === 'light' ? 'light' : 'dark';
    saveStandaloneSettings();
    post(win, { type: 'prefs', prompts: [], params: {}, theme: state.themeMode });
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
  const renderedChatPath = userDataPath('chat-rendered.html');
  fs.mkdirSync(path.dirname(renderedChatPath), { recursive: true });
  fs.writeFileSync(renderedChatPath, chatHtml(), 'utf8');
  win.loadFile(renderedChatPath);
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
  loadStandaloneSettings();
  ensureStandaloneMcpDefaults();

  const existing = readAuthSession();
  if (isSessionValid(existing)) createWindow();
  else {
    clearAuthSession();
    createLoginWindow();
  }

  ipcMain.handle('fc:auth-begin', async () => {
    await beginOidcDeviceLogin();
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
