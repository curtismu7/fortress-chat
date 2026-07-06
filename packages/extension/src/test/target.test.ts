import { describe, it, expect } from 'vitest';
import { resolveTarget } from '../providers/target';
import { PolicyViolationError, type PolicyEntry } from '@fortress-chat/shared';

const localEntry: PolicyEntry = {
  id: 'gpt-oss-20b', displayName: 'gpt-oss', provider: 'local', agentCapable: true,
  origin: { org: 'OpenAI', country: 'US' }, hosting: { kind: 'on-device' },
  approved: true, local: { catalogId: 'gpt-oss-20b' },
};

describe('resolveTarget (local)', () => {
  it('builds a local llama-server target with no auth and no bodyExtra', () => {
    const t = resolveTarget(localEntry, { localEndpoint: 'http://127.0.0.1:5599' });
    expect(t.url).toBe('http://127.0.0.1:5599/v1/chat/completions');
    expect(t.headers['content-type']).toBe('application/json');
    expect(t.headers.authorization).toBeUndefined();
    expect(t.bodyExtra).toEqual({});
    expect(t.model).toBeUndefined(); // llama-server ignores model
  });

  it('throws if the local endpoint is missing', () => {
    expect(() => resolveTarget(localEntry, {})).toThrow(/endpoint/i);
  });

  it('throws PolicyViolationError before building for a disallowed entry', () => {
    const bad = { ...localEntry, approved: false };
    expect(() => resolveTarget(bad, { localEndpoint: 'http://x' })).toThrow(PolicyViolationError);
  });
});

const orEntry = {
  id: 'or-gpt-4o', displayName: 'GPT-4o', provider: 'openrouter', agentCapable: true,
  origin: { org: 'OpenAI', country: 'US' },
  hosting: { kind: 'openrouter', usProviders: ['openai', 'azure'] },
  approved: true, openrouter: { slug: 'openai/gpt-4o', contextLength: 128000 },
} as const;

describe('resolveTarget (openrouter)', () => {
  it('builds the fail-closed US-provider-pinned request', () => {
    const t = resolveTarget(orEntry as any, { openRouterKey: 'sk-or-abc' });
    expect(t.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(t.headers.authorization).toBe('Bearer sk-or-abc');
    expect(t.model).toBe('openai/gpt-4o');
    expect(t.bodyExtra.provider).toEqual({ only: ['openai', 'azure'], allow_fallbacks: false, data_collection: 'deny' });
  });

  it('throws if the OpenRouter key is missing', () => {
    expect(() => resolveTarget(orEntry as any, {})).toThrow(/key/i);
  });

  it('throws PolicyViolationError for an OpenRouter entry with no US providers', () => {
    const bad = { ...orEntry, hosting: { kind: 'openrouter', usProviders: [] } };
    expect(() => resolveTarget(bad as any, { openRouterKey: 'sk-or-abc' })).toThrow(PolicyViolationError);
  });
});

const googleEntry = {
  id: 'google-gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', provider: 'google', agentCapable: true,
  origin: { org: 'Google', country: 'US' },
  hosting: { kind: 'google' },
  approved: true, google: { model: 'gemini-2.5-flash', contextLength: 1048576 },
} as const;

describe('resolveTarget (google)', () => {
  it('builds a Google Gemini OpenAI-compatible target', () => {
    const t = resolveTarget(googleEntry as any, { googleKey: 'AIza-test' });
    expect(t.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(t.headers.authorization).toBe('Bearer AIza-test');
    expect(t.model).toBe('gemini-2.5-flash');
    expect(t.bodyExtra).toEqual({});
  });

  it('throws if the Google API key is missing', () => {
    expect(() => resolveTarget(googleEntry as any, {})).toThrow(/Google Gemini API key/i);
  });
});
