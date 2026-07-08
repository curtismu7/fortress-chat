import { loadCatalog, type CatalogModel } from './catalog';
import { isAllowed, type PolicyEntry } from './governance';

const LOCAL_ORG: Record<CatalogModel['family'], string> = {
  gemma3: 'Google',
  'gpt-oss': 'OpenAI',
  embedding: 'Nomic AI',
  qwythos: 'Empero AI',
};

function mapLocalEntry(m: ReturnType<typeof loadCatalog>[number]): PolicyEntry {
  return {
    id: m.id,
    displayName: m.displayName,
    provider: 'local',
    agentCapable: m.toolCalling,
    origin: { org: LOCAL_ORG[m.family], country: 'US' },
    hosting: { kind: 'on-device' },
    approved: true,
    local: { catalogId: m.id, hidden: m.hidden ?? false },
  };
}

export const LOCAL_US_ONLY = true;

export function localEntries(): PolicyEntry[] {
  return loadCatalog().map(mapLocalEntry);
}

/** Local models usable for chat — excludes embedding-only models (RAG infrastructure). */
export function chatLocalEntries(): PolicyEntry[] {
  const embeddingIds = new Set(loadCatalog().filter((m) => m.embedding).map((m) => m.id));
  return localEntries().filter((e) => !embeddingIds.has(e.id));
}

export function visibleLocalEntries(): PolicyEntry[] {
  return chatLocalEntries().filter((e) => !e.local?.hidden);
}

export function hiddenLocalEntries(): PolicyEntry[] {
  return chatLocalEntries().filter((e) => e.local?.hidden);
}

/** Cloud OpenRouter models are disabled — FortressChat is local US models only. */
export function openRouterEntries(): PolicyEntry[] {
  return [];
}

/** Curated Google Gemini models via the Google AI API (US-origin developer). */
export function googleEntries(): PolicyEntry[] {
  return [
    {
      id: 'google-gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      provider: 'google',
      agentCapable: true,
      origin: { org: 'Google', country: 'US' },
      hosting: { kind: 'google' },
      approved: true,
      google: { model: 'gemini-2.5-flash', contextLength: 1048576 },
    },
    {
      id: 'google-gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      provider: 'google',
      agentCapable: true,
      origin: { org: 'Google', country: 'US' },
      hosting: { kind: 'google' },
      approved: true,
      google: { model: 'gemini-2.5-pro', contextLength: 1048576 },
    },
    {
      id: 'google-gemini-2.0-flash',
      displayName: 'Gemini 2.0 Flash',
      provider: 'google',
      agentCapable: true,
      origin: { org: 'Google', country: 'US' },
      hosting: { kind: 'google' },
      approved: true,
      google: { model: 'gemini-2.0-flash', contextLength: 1048576 },
    },
  ];
}

export function loadPolicy(): PolicyEntry[] {
  return [...localEntries(), ...googleEntries(), ...openRouterEntries()];
}

// Known non-US developer prefixes → human-readable reason. Used when a user tries
// to add a cloud model slug. Extend as needed; unknown slugs fall through to generic.
const NON_US: { test: RegExp; reason: string }[] = [
  { test: /^deepseek\//i, reason: 'DeepSeek is a China-based developer.' },
  { test: /^(qwen|alibaba)\//i, reason: 'Qwen (Alibaba) is a China-based developer.' },
  { test: /^(01-ai|yi)\//i, reason: 'Yi (01.AI) is a China-based developer.' },
  { test: /^(thudm|z-ai|zhipu|glm)\//i, reason: 'GLM (Zhipu AI) is a China-based developer.' },
  { test: /^(mistralai|mistral)\//i, reason: 'Mistral AI is a France-based developer.' },
  { test: /^cohere\//i, reason: 'Cohere is a Canada-based developer.' },
];

/** Build the fatal policy message shown when a non-local / non-US model is attempted. */
export function formatPolicyFatal(reason: string, slug?: string): string {
  const detail = slug ? ` Model "${slug}" is not allowed.` : '';
  return `${reason}${detail}\n\nFortressChat supports local US models and Google Gemini only.`;
}

export function explainBlock(slugOrId: string): string | null {
  if (loadPolicy().some((e) => (e.openrouter?.slug === slugOrId || e.id === slugOrId) && isAllowed(e))) return null;
  for (const n of NON_US) if (n.test.test(slugOrId)) return n.reason;
  if (LOCAL_US_ONLY && slugOrId.includes('/')) {
    return 'Cloud models are not allowed. FortressChat supports local US models only.';
  }
  return 'This model is not on the local US-approved list.';
}
