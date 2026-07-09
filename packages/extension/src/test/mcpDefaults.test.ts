import { describe, expect, it } from 'vitest';
import {
  defaultPingOneMcpServer,
  normalizePingOneMcpSettings,
  PINGONE_MCP_SERVER_NAME,
  resolveMcpConfigs,
} from '../mcpDefaults';

describe('mcpDefaults', () => {
  it('includes PingOne MCP by default', () => {
    const servers = resolveMcpConfigs([], undefined);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe(PINGONE_MCP_SERVER_NAME);
    expect(servers[0].command).toBe('pingone-mcp-server');
    expect(servers[0].env?.PINGONE_ROOT_DOMAIN).toBe('pingone.com');
    expect(servers[0].builtin).toBe(true);
  });

  it('injects PingOne env vars from settings', () => {
    const servers = resolveMcpConfigs([], {
      environmentId: 'env-123',
      clientId: 'client-456',
      rootDomain: 'pingone.eu',
    });
    expect(servers[0].env).toEqual({
      PINGONE_ROOT_DOMAIN: 'pingone.eu',
      PINGONE_MCP_ENVIRONMENT_ID: 'env-123',
      PINGONE_AUTHORIZATION_CODE_CLIENT_ID: 'client-456',
    });
  });

  it('omits PingOne when disabled via pingOneMcp.enabled', () => {
    expect(resolveMcpConfigs([], { enabled: false })).toEqual([]);
  });

  it('omits PingOne when disabled via mcpServers entry', () => {
    expect(resolveMcpConfigs([{ name: 'pingone', command: 'x', disabled: true }], {})).toEqual([]);
  });

  it('merges additional user servers', () => {
    const servers = resolveMcpConfigs([
      { name: 'docs', command: 'npx', args: ['-y', 'some-mcp'] },
    ], {});
    expect(servers.map((s) => s.name)).toEqual(['pingone', 'docs']);
  });

  it('user config overrides built-in by name', () => {
    const servers = resolveMcpConfigs([
      { name: 'pingone', command: '/custom/pingone-mcp-server', args: ['run'] },
    ], { environmentId: 'ignored' });
    expect(servers).toHaveLength(1);
    expect(servers[0].command).toBe('/custom/pingone-mcp-server');
  });

  it('normalizes partial pingOne settings', () => {
    expect(normalizePingOneMcpSettings(null)).toEqual({ enabled: true, rootDomain: 'pingone.com' });
    expect(defaultPingOneMcpServer(normalizePingOneMcpSettings({ enabled: true }))?.name).toBe('pingone');
  });
});
