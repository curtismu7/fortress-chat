// packages/extension/src/mcpDefaults.ts
import { type McpServerConfig, parseMcpConfigs } from './mcpClient';

export const PINGONE_MCP_SERVER_NAME = 'pingone';
export const BRAVE_DIRECT_MCP_SERVER_NAME = 'brave-search';

export interface PingOneMcpSettings {
  enabled?: boolean;
  environmentId?: string;
  clientId?: string;
  rootDomain?: string;
}

export interface BraveDirectMcpSettings {
  enabled?: boolean;
  apiKey?: string;
}

/** Normalize PingOne MCP settings from extension / Mac settings storage. */
export function normalizePingOneMcpSettings(raw: unknown): PingOneMcpSettings {
  if (!raw || typeof raw !== 'object') return { enabled: true, rootDomain: 'pingone.com' };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled !== false,
    environmentId: typeof o.environmentId === 'string' ? o.environmentId.trim() : '',
    clientId: typeof o.clientId === 'string' ? o.clientId.trim() : '',
    rootDomain: typeof o.rootDomain === 'string' && o.rootDomain.trim()
      ? o.rootDomain.trim()
      : 'pingone.com',
  };
}

/** Normalize Brave direct MCP settings from extension / Mac settings storage. */
export function normalizeBraveDirectMcpSettings(raw: unknown): BraveDirectMcpSettings {
  if (!raw || typeof raw !== 'object') return { enabled: false, apiKey: '' };
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey.trim() : '',
  };
}

/** Built-in PingOne MCP server (stdio client; APIs hosted on PingOne). */
export function defaultPingOneMcpServer(settings: PingOneMcpSettings): McpServerConfig | null {
  if (settings.enabled === false) return null;
  const env: Record<string, string> = { PINGONE_ROOT_DOMAIN: settings.rootDomain || 'pingone.com' };
  if (settings.environmentId) env.PINGONE_MCP_ENVIRONMENT_ID = settings.environmentId;
  if (settings.clientId) env.PINGONE_AUTHORIZATION_CODE_CLIENT_ID = settings.clientId;
  return {
    name: PINGONE_MCP_SERVER_NAME,
    command: 'pingone-mcp-server',
    args: ['run'],
    env,
    builtin: true,
  };
}

/**
 * Built-in Brave direct MCP server (stdio).
 * Local-use only: reads BRAVE_API_KEY from setting or process env.
 */
export function defaultBraveDirectMcpServer(settings: BraveDirectMcpSettings): McpServerConfig | null {
  if (settings.enabled !== true) return null;
  const apiKey = settings.apiKey || process.env.BRAVE_API_KEY || '';
  const clean = apiKey.trim();
  if (!clean || clean === 'YOUR_BRAVE_API_KEY') return null;
  return {
    name: BRAVE_DIRECT_MCP_SERVER_NAME,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: clean },
    builtin: true,
  };
}

/** Merge built-in PingOne MCP with user-configured stdio/remote servers. User entries override by name. */
export function resolveMcpConfigs(userRaw: unknown, pingOneRaw?: unknown, braveDirectRaw?: unknown): McpServerConfig[] {
  const pingOne = normalizePingOneMcpSettings(pingOneRaw);
  const braveDirect = normalizeBraveDirectMcpSettings(braveDirectRaw);
  const byName = new Map<string, McpServerConfig>();
  const builtin = defaultPingOneMcpServer(pingOne);
  if (builtin) byName.set(builtin.name, builtin);
  const braveBuiltin = defaultBraveDirectMcpServer(braveDirect);
  if (braveBuiltin) byName.set(braveBuiltin.name, braveBuiltin);

  const user = Array.isArray(userRaw) ? userRaw : [];
  for (const entry of user) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as McpServerConfig;
    if (typeof row.name !== 'string') continue;
    if (row.disabled === true) {
      byName.delete(row.name);
      continue;
    }
    const command = typeof row.command === 'string' && row.command.trim() ? row.command.trim() : undefined;
    const url = typeof row.url === 'string' && row.url.trim() ? row.url.trim() : undefined;
    if (!command && !url) continue;

    byName.set(row.name, {
      name: row.name,
      transport: row.transport,
      command,
      args: Array.isArray(row.args) ? row.args.filter((a): a is string => typeof a === 'string') : undefined,
      env: row.env && typeof row.env === 'object'
        ? Object.fromEntries(Object.entries(row.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : undefined,
      url,
      messageUrl: typeof row.messageUrl === 'string' && row.messageUrl.trim() ? row.messageUrl.trim() : undefined,
      headers: row.headers && typeof row.headers === 'object'
        ? Object.fromEntries(Object.entries(row.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : undefined,
      builtin: row.builtin,
    });
  }

  return [...byName.values()];
}

/** Re-export for callers that only need parsed user entries. */
export { parseMcpConfigs };

function stringMap(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => [k, String(v)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function extractFirstJsonValue(raw: string): string | null {
  const start = raw.search(/[\[{]/);
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }

    if (ch === '}' || ch === ']') {
      const top = stack[stack.length - 1];
      if ((ch === '}' && top === '{') || (ch === ']' && top === '[')) {
        stack.pop();
        if (stack.length === 0) return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseLooseJson(rawText: string): unknown {
  const text = String(rawText || '').trim();
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    const fenced = text.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // Try generic extraction fallback below.
      }
    }

    const extracted = extractFirstJsonValue(text);
    if (extracted) {
      try {
        return JSON.parse(extracted);
      } catch {
        // Fall through to original parse error.
      }
    }

    throw firstErr;
  }
}

/**
 * Parse imported MCP JSON from either fortressChat.mcpServers array format
 * or VS Code .vscode/mcp.json object format ({ servers: { name: {...} } }).
 */
export function parseImportedMcpServersJson(rawText: string): McpServerConfig[] {
  const parsed = parseLooseJson(rawText) as unknown;

  // FortressChat setting shape: [{ name, command|url, ... }]
  if (Array.isArray(parsed)) {
    return resolveMcpConfigs(parsed, { enabled: false }).filter((s) => !s.builtin);
  }

  // VS Code shape: { servers: { "name": { command, args, env, ... } } }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const root = parsed as Record<string, unknown>;
    const servers = root.servers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      const rows: McpServerConfig[] = [];
      for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const src = value as Record<string, unknown>;
        const command = typeof src.command === 'string' && src.command.trim() ? src.command.trim() : undefined;
        const url = typeof src.url === 'string' && src.url.trim() ? src.url.trim() : undefined;
        const args = Array.isArray(src.args) ? src.args.filter((a): a is string => typeof a === 'string') : undefined;
        const messageUrl = typeof src.messageUrl === 'string' && src.messageUrl.trim() ? src.messageUrl.trim() : undefined;
        const transport = src.transport === 'stdio' || src.transport === 'http' || src.transport === 'sse'
          ? src.transport
          : undefined;
        rows.push({
          name,
          transport,
          command,
          args,
          env: stringMap(src.env),
          url,
          messageUrl,
          headers: stringMap(src.headers),
          disabled: src.disabled === true,
        });
      }
      return resolveMcpConfigs(rows, { enabled: false }).filter((s) => !s.builtin);
    }
  }

  throw new Error('Invalid MCP JSON. Expected an array or an object with a "servers" map.');
}
