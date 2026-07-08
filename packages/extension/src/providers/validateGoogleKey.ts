export type GoogleKeyValidation =
  | { ok: true }
  | { ok: false; message: string };

/** Check format and verify a Google AI API key against the Gemini API. */
export async function validateGoogleApiKey(key: string): Promise<GoogleKeyValidation> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, message: 'Enter a Google AI API key.' };
  if (!/^AIza[\w-]{20,}$/i.test(trimmed)) {
    return { ok: false, message: 'That does not look like a Google AI API key (should start with AIza).' };
  }

  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { authorization: `Bearer ${trimmed}` },
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    const detail = body.error?.message?.trim();
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, message: detail || 'Google rejected this API key.' };
    }
    return { ok: false, message: detail || `Could not verify key (HTTP ${res.status}).` };
  } catch {
    return { ok: false, message: 'Could not reach Google to verify the key. Check your network.' };
  }
}
