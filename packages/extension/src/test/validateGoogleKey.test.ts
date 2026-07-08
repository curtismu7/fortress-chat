import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { validateGoogleApiKey } from '../providers/validateGoogleKey';

describe('validateGoogleApiKey', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects empty keys', async () => {
    await expect(validateGoogleApiKey('   ')).resolves.toEqual({
      ok: false,
      message: 'Enter a Google AI API key.',
    });
  });

  it('rejects malformed keys before calling Google', async () => {
    const result = await validateGoogleApiKey('not-a-google-key');
    expect(result).toEqual({
      ok: false,
      message: 'That does not look like a Google AI API key (should start with AIza).',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a key Google verifies', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    await expect(validateGoogleApiKey('AIzaSy0123456789012345678901234567890')).resolves.toEqual({ ok: true });
  });

  it('returns Google error text when verification fails', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'API key not valid.' } }),
    } as Response);
    await expect(validateGoogleApiKey('AIzaSy0123456789012345678901234567890')).resolves.toEqual({
      ok: false,
      message: 'API key not valid.',
    });
  });
});
