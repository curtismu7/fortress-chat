import type { SecretStorage } from 'vscode';

export const OPENROUTER_KEY_ID = 'fortressChat.openRouterKey';
const LEGACY_OPENROUTER_KEY_ID = 'fortressCode.openRouterKey';

/** One-time migration from the pre-rename key to the new one. */
async function migrateSecret(secrets: SecretStorage, legacyId: string, newId: string): Promise<void> {
  if (await secrets.get(newId)) return;
  const legacy = await secrets.get(legacyId);
  if (legacy === undefined) return;
  await secrets.store(newId, legacy);
  await secrets.delete(legacyId);
}

export async function getOpenRouterKey(secrets: SecretStorage): Promise<string | undefined> {
  await migrateSecret(secrets, LEGACY_OPENROUTER_KEY_ID, OPENROUTER_KEY_ID);
  return secrets.get(OPENROUTER_KEY_ID);
}
export async function setOpenRouterKey(secrets: SecretStorage, key: string): Promise<void> {
  await secrets.store(OPENROUTER_KEY_ID, key.trim());
}
export async function clearOpenRouterKey(secrets: SecretStorage): Promise<void> {
  await secrets.delete(OPENROUTER_KEY_ID);
}

export const FIREWORKS_KEY_ID = 'fortressChat.fireworksKey';
const LEGACY_FIREWORKS_KEY_ID = 'fortressCode.fireworksKey';

export async function getFireworksKey(secrets: SecretStorage): Promise<string | undefined> {
  await migrateSecret(secrets, LEGACY_FIREWORKS_KEY_ID, FIREWORKS_KEY_ID);
  return secrets.get(FIREWORKS_KEY_ID);
}
export async function setFireworksKey(secrets: SecretStorage, key: string): Promise<void> {
  await secrets.store(FIREWORKS_KEY_ID, key.trim());
}

export const GOOGLE_KEY_ID = 'fortressChat.googleKey';

export async function getGoogleKey(secrets: SecretStorage): Promise<string | undefined> {
  return secrets.get(GOOGLE_KEY_ID);
}
export async function setGoogleKey(secrets: SecretStorage, key: string): Promise<void> {
  await secrets.store(GOOGLE_KEY_ID, key.trim());
}
export async function clearGoogleKey(secrets: SecretStorage): Promise<void> {
  await secrets.delete(GOOGLE_KEY_ID);
}
