import { assertAllowed, type PolicyEntry } from '@fortress-chat/shared';

export interface TargetDeps {
  localEndpoint?: string;   // http://127.0.0.1:PORT from daemon status, when a local model is ready
  openRouterKey?: string;   // from SecretStorage, for OpenRouter entries
  googleKey?: string;       // from SecretStorage, for Google Gemini entries
}

export interface ResolvedTarget {
  url: string;
  headers: Record<string, string>;
  bodyExtra: Record<string, unknown>;
  model?: string;
}

export function resolveTarget(entry: PolicyEntry, deps: TargetDeps): ResolvedTarget {
  assertAllowed(entry); // fail closed before we build anything

  if (entry.provider === 'local') {
    if (!deps.localEndpoint) throw new Error('No local model endpoint — start a local model first.');
    return {
      url: `${deps.localEndpoint}/v1/chat/completions`,
      headers: { 'content-type': 'application/json' },
      bodyExtra: {},
    };
  }

  if (entry.provider === 'google') {
    if (!deps.googleKey) throw new Error('No Google Gemini API key — add your key in Settings.');
    if (entry.hosting.kind !== 'google' || !entry.google) throw new Error('Malformed Google Gemini entry');
    return {
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.googleKey}`,
      },
      bodyExtra: {},
      model: entry.google.model,
    };
  }

  // OpenRouter: fail-closed — pin US providers, no fallback, deny data collection.
  if (!deps.openRouterKey) throw new Error('No OpenRouter API key — add your key to use cloud models.');
  if (entry.hosting.kind !== 'openrouter' || !entry.openrouter) throw new Error('Malformed OpenRouter entry');
  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.openRouterKey}`,
      'http-referer': 'https://github.com/curtismuir/fortress-chat',
      'x-title': 'FortressChat',
    },
    bodyExtra: {
      provider: { only: entry.hosting.usProviders, allow_fallbacks: false, data_collection: 'deny' },
    },
    model: entry.openrouter.slug,
  };
}
