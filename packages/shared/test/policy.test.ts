import { describe, it, expect } from 'vitest';
import { loadPolicy, localEntries, chatLocalEntries, openRouterEntries, googleEntries, explainBlock, formatPolicyFatal, LOCAL_US_ONLY, visibleLocalEntries, hiddenLocalEntries, DEFAULT_US_CLOUD_PROVIDER_ALLOWLIST } from '../src/policy';
import { isAllowed } from '../src/governance';

describe('policy registry', () => {
  it('maps every local catalog model to an approved US on-device entry', () => {
    const locals = localEntries();
    expect(locals.length).toBe(8); // seven catalog models + qwythos hidden
    for (const e of locals) {
      expect(e.provider).toBe('local');
      expect(e.origin.country).toBe('US');
      expect(e.hosting.kind).toBe('on-device');
      expect(isAllowed(e)).toBe(true);
      expect(e.local?.catalogId).toBe(e.id);
    }
    const orgs = new Set(locals.map((e) => e.origin.org));
    expect(orgs).toContain('Google');   // gemma
    expect(orgs).toContain('OpenAI');   // gpt-oss
    expect(orgs).toContain('Nomic AI'); // embedding
  });

  it('splits visible and hidden local entries', () => {
    expect(visibleLocalEntries().length).toBe(6);
    expect(visibleLocalEntries().some((e) => e.id === 'nomic-embed-text-v1.5')).toBe(false);
    expect(hiddenLocalEntries().map((e) => e.id)).toEqual(['qwythos-9b-q4']);
  });

  it('chatLocalEntries excludes embedding-only models', () => {
    expect(chatLocalEntries().some((e) => e.id === 'nomic-embed-text-v1.5')).toBe(false);
    expect(chatLocalEntries().length).toBe(localEntries().length - 1);
  });

  it('OpenRouter entries are disabled in local-US-only mode', () => {
    expect(LOCAL_US_ONLY).toBe(true);
    expect(openRouterEntries()).toEqual([]);
  });

  it('includes curated Google Gemini entries', () => {
    const google = googleEntries();
    expect(google.length).toBe(3);
    for (const e of google) {
      expect(e.provider).toBe('google');
      expect(e.origin).toEqual({ org: 'Google', country: 'US' });
      expect(e.hosting.kind).toBe('google');
      expect(isAllowed(e)).toBe(true);
      expect(e.google?.model).toBeTruthy();
    }
  });

  it('loadPolicy includes local and Google entries', () => {
    expect(loadPolicy().length).toBe(localEntries().length + googleEntries().length);
    expect(loadPolicy().some((e) => e.provider === 'google')).toBe(true);
  });

  it('explainBlock names known non-US developers and allows known US cloud developers', () => {
    expect(explainBlock('deepseek/deepseek-chat')).toMatch(/China/i);
    expect(explainBlock('qwen/qwen-2.5-72b-instruct')).toMatch(/China/i);
    expect(explainBlock('mistralai/mistral-large')).toMatch(/France/i);
    expect(explainBlock('openai/gpt-4o')).toBeNull();
    expect(explainBlock('google/gemini-2.5-pro')).toBeNull();
    expect(explainBlock('meta-llama/llama-3.3-70b-instruct')).toBeNull();
    expect(explainBlock('nvidia/llama-3.1-nemotron-ultra-253b-v1')).toBeNull();
    expect(explainBlock('some/unknown-model')).toMatch(/US-based allowlist/i);
    expect(explainBlock(localEntries()[0]!.id)).toBeNull();
    expect(explainBlock(googleEntries()[0]!.id)).toBeNull();
  });

  it('supports configurable US cloud allowlist overrides', () => {
    const googleOnly = ['google'];
    expect(explainBlock('google/gemini-2.5-pro', googleOnly)).toBeNull();
    expect(explainBlock('openai/gpt-4o', googleOnly)).toMatch(/US-based allowlist/i);

    expect(explainBlock('openai/gpt-4o', ['openai/'])).toBeNull();
    expect(explainBlock('nvidia/llama-3.1-nemotron-ultra-253b-v1', ['nvidia'])).toBeNull();
    expect(explainBlock('openai/gpt-4o', [])).toBeNull();

    expect(DEFAULT_US_CLOUD_PROVIDER_ALLOWLIST).toContain('google');
    expect(DEFAULT_US_CLOUD_PROVIDER_ALLOWLIST).toContain('openai');
  });

  it('formatPolicyFatal includes the US-based policy message', () => {
    const msg = formatPolicyFatal('DeepSeek is a China-based developer.', 'deepseek/deepseek-chat');
    expect(msg).toMatch(/US-based developers/i);
    expect(msg).toContain('deepseek/deepseek-chat');
  });

  it('policy exposes the embed model as an approved US entry', () => {
    const e = loadPolicy().find((x) => x.id === 'nomic-embed-text-v1.5');
    expect(e).toBeTruthy();
    expect(isAllowed(e!)).toBe(true);
    expect(e!.origin).toEqual({ org: 'Nomic AI', country: 'US' });
  });
});
