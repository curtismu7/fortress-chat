import type { SecretStorage } from 'vscode';

export const OPENROUTER_KEY_ID = 'fortressCode.openRouterKey';

export function getOpenRouterKey(secrets: SecretStorage): Promise<string | undefined> {
  return Promise.resolve(secrets.get(OPENROUTER_KEY_ID));
}
export async function setOpenRouterKey(secrets: SecretStorage, key: string): Promise<void> {
  await secrets.store(OPENROUTER_KEY_ID, key.trim());
}
export async function clearOpenRouterKey(secrets: SecretStorage): Promise<void> {
  await secrets.delete(OPENROUTER_KEY_ID);
}
