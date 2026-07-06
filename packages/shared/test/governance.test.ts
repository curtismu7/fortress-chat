import { describe, it, expect } from 'vitest';
import { isAllowed, assertAllowed, PolicyViolationError, type PolicyEntry } from '../src/governance';

const local = (over: Partial<PolicyEntry> = {}): PolicyEntry => ({
  id: 'x', displayName: 'X', provider: 'local', agentCapable: true,
  origin: { org: 'Google', country: 'US' }, hosting: { kind: 'on-device' },
  approved: true, local: { catalogId: 'x' }, ...over,
});
const google = (over: Partial<PolicyEntry> = {}): PolicyEntry => ({
  id: 'g', displayName: 'Gemini', provider: 'google', agentCapable: true,
  origin: { org: 'Google', country: 'US' }, hosting: { kind: 'google' },
  approved: true, google: { model: 'gemini-2.5-flash', contextLength: 1048576 }, ...over,
});
const or = (over: Partial<PolicyEntry> = {}): PolicyEntry => ({
  id: 'y', displayName: 'Y', provider: 'openrouter', agentCapable: true,
  origin: { org: 'OpenAI', country: 'US' },
  hosting: { kind: 'openrouter', usProviders: ['openai'] },
  approved: true, openrouter: { slug: 'openai/gpt-4o', contextLength: 128000 }, ...over,
});

describe('isAllowed', () => {
  it('allows an approved US on-device model', () => expect(isAllowed(local())).toBe(true));
  it('allows an approved US Google Gemini model', () => expect(isAllowed(google())).toBe(true));
  it('allows an approved US OpenRouter model with US providers', () => expect(isAllowed(or())).toBe(true));
  it('blocks a non-approved model', () => expect(isAllowed(local({ approved: false }))).toBe(false));
  it('blocks OpenRouter with no US providers (fail closed)', () =>
    expect(isAllowed(or({ hosting: { kind: 'openrouter', usProviders: [] } }))).toBe(false));
  it('blocks a non-US origin even if approved', () =>
    // @ts-expect-error deliberately construct an invalid country to prove the runtime guard
    expect(isAllowed(local({ origin: { org: 'DeepSeek', country: 'CN' } }))).toBe(false));
});

describe('assertAllowed', () => {
  it('throws PolicyViolationError for a blocked model', () => {
    expect(() => assertAllowed(local({ approved: false }))).toThrow(PolicyViolationError);
  });
  it('does not throw for an allowed model', () => expect(() => assertAllowed(or())).not.toThrow());
});
