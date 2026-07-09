// packages/extension/src/mcpDefaults.ts
import { type McpServerConfig, parseMcpConfigs } from './mcpClient';

export const PINGONE_MCP_SERVER_NAME = 'pingone';

export interface PingOneMcpSettings {
  enabled?: boolean;
  environmentId?: string;
  clientId?: string;
  rootDomain?: string;
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

/** Merge built-in PingOne MCP with user-configured stdio servers. User entries override by name. */
export function resolveMcpConfigs(userRaw: unknown, pingOneRaw?: unknown): McpServerConfig[] {
  const pingOne = normalizePingOneMcpSettings(pingOneRaw);
  const byName = new Map<string, McpServerConfig>();
  const builtin = defaultPingOneMcpServer(pingOne);
  if (builtin) byName.set(builtin.name, builtin);

  const user = Array.isArray(userRaw) ? userRaw : [];
  for (const entry of user) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as McpServerConfig;
    if (typeof row.name !== 'string') continue;
    if (row.disabled === true) {
      byName.delete(row.name);
      continue;
    }
    if (typeof row.command !== 'string') continue;
    byName.set(row.name, {
      name: row.name,
      command: row.command,
      args: Array.isArray(row.args) ? row.args.filter((a): a is string => typeof a === 'string') : undefined,
      env: row.env && typeof row.env === 'object'
        ? Object.fromEntries(Object.entries(row.env).filter(([, v]) => typeof v === 'string')) as Record<string, string>
        : undefined,
      builtin: row.builtin,
    });
  }

  return [...byName.values()];
}

/** Re-export for callers that only need parsed user entries. */
export { parseMcpConfigs };
