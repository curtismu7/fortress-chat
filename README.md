# Fortress Code

Local + US-governed AI chat and coding agent for VS Code. Run models fully on
your machine via llama.cpp, or use approved US models through OpenRouter — with
a governance policy that blocks any non-US model.

## Providers

- **Local (private):** Google Gemma 3 and OpenAI gpt-oss via llama.cpp. Nothing
  leaves your machine. A memory guard refuses to load a model that won't fit.
- **OpenRouter (cloud):** a curated set of **US-origin** models, pinned to **US
  inference providers with no fallback** (`data_collection: deny`). Prompts
  transit OpenRouter (a US company) — less private than Local; the UI says so.

## Governance

Only US-origin, US-hosted models are selectable or addable. Enforcement is a
curated allow-list maintained in the app (OpenRouter exposes no reliable
origin/country signal, so this cannot be auto-detected). Pasting a non-US model
is blocked with a plain-language reason. See
`docs/superpowers/specs/2026-07-03-governance-openrouter-design.md`.

## Install

Download `fortress-code.vsix` from the latest Release → VS Code Extensions →
Install from VSIX. Requirements: Apple Silicon Mac, macOS 13+, VS Code 1.90+.

## Development

    npm install
    npm run build
    npm test
