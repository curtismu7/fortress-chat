export type Provider = 'local' | 'openrouter';
export interface Origin { org: string; country: 'US' }
export type Hosting = { kind: 'on-device' } | { kind: 'openrouter'; usProviders: string[] };

export interface PolicyEntry {
  id: string;
  displayName: string;
  provider: Provider;
  agentCapable: boolean;
  origin: Origin;
  hosting: Hosting;
  approved: boolean;
  local?: { catalogId: string; hidden?: boolean };
  openrouter?: { slug: string; contextLength: number };
}

export class PolicyViolationError extends Error {
  constructor(message: string, public reason: string) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

export function isAllowed(e: PolicyEntry): boolean {
  if (!e.approved) return false;
  if (e.origin.country !== 'US') return false;
  if (e.provider === 'local') return e.hosting.kind === 'on-device';
  return e.hosting.kind === 'openrouter' && e.hosting.usProviders.length > 0;
}

export function assertAllowed(e: PolicyEntry): void {
  if (!isAllowed(e)) {
    throw new PolicyViolationError(
      `Model ${e.id} violates the US-only policy`,
      !e.approved ? 'not-approved'
        : e.origin.country !== 'US' ? 'non-us-origin'
        : 'no-us-hosting',
    );
  }
}
