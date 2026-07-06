# Fortress Code development harness

How to run, test, and dogfood the VS Code extension locally.

## Prerequisites

- Node.js 20+
- VS Code or Cursor 1.90+
- Apple Silicon Mac (for local llama.cpp models; E2E tests do **not** require a model)

## Quick start

```bash
npm install
npm run build
npm test          # vitest unit tests (all packages)
npm run test:e2e  # @vscode/test-electron webview + command smoke tests
```

Open the repo in VS Code → **Run and Debug** → **Run Extension (Fixture Workspace)** → F5.

A second window opens with `fixtures/sample-app` as the workspace. Use the Fortress Code sidebar there.

## Launch configurations (`.vscode/launch.json`)

| Config | What it does |
|--------|----------------|
| **Run Extension** | Extension host, empty window |
| **Run Extension (Fixture Workspace)** | Extension host + `fixtures/sample-app` (recommended) |
| **Run Extension (watch + Fixture)** | Same as above, with esbuild watch before launch |
| **Extension Tests (E2E smoke)** | Runs the automated webview test suite in-process |

Every worktree should include `.vscode/launch.json` and `.vscode/tasks.json` so F5 works without copying files by hand.

## Hot reload

| What you changed | What to do |
|------------------|------------|
| `packages/extension/media/*` (HTML/CSS/JS) | **Automatic** in Extension Development mode — webviews reload ~300ms after save |
| `packages/extension/src/*` (TypeScript) | Run **`npm run watch`** (or **`npm run dev`**) then **Developer: Reload Window** in the extension host |
| `@fortress-code/shared` or manager | Stop watch, `npm run build`, reload window |

Manual webview refresh anytime: **Command Palette → “Fortress Code: Reload Chat Webview”** (`fortress-code.reloadWebview`).

Backend (`out/extension.js`) changes always require a window reload; only the webview shell hot-reloads.

## Agent sandbox / fixture repo

`fixtures/sample-app/` is a minimal JavaScript project checked into the repo:

- Intentional bug in `src/greeter.js` for agent/debug testing
- Project rules in `.fortress/rules.md`
- Docs in `docs/notes.md` for `@docs` / RAG testing
- Vitest-style unit test in `src/greeter.test.js`

See **`fixtures/sample-app/AGENT-SANDBOX.md`** for step-by-step dogfooding scenarios (agent fix, undo, @-mentions, modes, etc.).

You can also open **any folder** as the extension host workspace — the fixture is optional but gives repeatable scenarios and stable E2E paths.

## Automated tests

### Unit tests (vitest)

```bash
npm test
```

Most coverage lives in `packages/extension` and `packages/manager`. No VS Code host required.

### E2E / webview tests (@vscode/test-electron)

```bash
npm run test:e2e
```

Runs inside a real VS Code Extension Development Host with `FORTRESS_CODE_TEST=1`:

1. Extension activates
2. Commands exist (including test harness `fortress-code.test.getWebviewState`)
3. Sidebar webview attaches and receives `policy` or daemon `error`
4. Fixture `.fortress/rules.md` is posted as `projectRules`
5. **Open Chat in Editor Tab** attaches a second webview
6. **Reload Chat Webview** re-syncs state without crashing

E2E uses temp user-data under `/tmp/fortress-code-vscode-test` to avoid IPC path-length issues.

Debug E2E interactively: launch **Extension Tests (E2E smoke)** from Run and Debug.

## Typical dev loop

1. `npm run dev` in a terminal (esbuild watch).
2. F5 → **Run Extension (watch + Fixture)**.
3. Edit `media/chat.js` → webview updates automatically.
4. Edit `ChatViewProvider.ts` → wait for esbuild, **Reload Window**.
5. `npm test` before commit; `npm run test:e2e` before PRs that touch webview wiring.

## Troubleshooting

- **Daemon error banner in chat** — expected without llama.cpp binary; E2E still passes if the webview receives the error message.
- **Webview blank after TS change** — Developer: Reload Window (not just reload webview).
- **E2E “fixture workspace should be open”** — launch args must include `fixtures/sample-app`; do not run the suite from an empty host.
- **Watch task never “completes”** — background esbuild watch is intentional; F5 still proceeds once “watching for changes” appears.

## Related docs

- `README.md` — install and high-level dev commands
- `fixtures/sample-app/README.md` — fixture overview
- `fixtures/sample-app/AGENT-SANDBOX.md` — manual agent/RAG scenarios
