# Google Gemini Cloud — Design Delta

**Status:** Shipped (PR #9, 2026-07-06)
**Replaces:** OpenRouter as the approved cloud provider path.

## Decision

FortressChat supports **local US models** plus **Google Gemini via direct API key**. OpenRouter and developer/Fireworks modes remain disabled.

## Policy

- New provider: `google` in `governance.ts`
- Curated entries in `googleEntries()`: Gemini 2.5 Flash, 2.5 Pro, 2.0 Flash
- US-origin (Google), fail-closed for other cloud slugs

## Extension integration

- Secret: `fortressChat.googleKey` in VS Code SecretStorage
- Target: `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- UI: Settings → Google Gemini; models appear when key is set
- Daemon optional when Google key is configured

## Mac parity

Ported in M1 milestone (`fortress-code-mac` controller + secrets).

## UI copy

"FortressChat supports local US models and Google Gemini only."
