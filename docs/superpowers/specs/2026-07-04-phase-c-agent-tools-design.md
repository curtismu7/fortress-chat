# Fortress Code — Phase C: Stronger Agent Tools (design)

**Status:** Approved (Curtis, 2026-07-04 — "do it")
**Builds on:** the agent loop + `agent/tools.ts` (read_file/list_files/search/edit_file) and the diff-approval flow.

## 1. Goal

Turn the agent from "read + edit" into a real coding agent that can **run commands (tests/builds/linters), create files, and search fast** — every action human-approved.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Command execution safety | **Human-approves every command** via a modal showing the exact command. Never auto-runs. No allowlist needed — the human is the gate. |
| Command scope | Runs in the workspace root, 60s timeout, stdout+stderr captured and truncated (~10 KB) before returning to the model. |
| create_file | Reuses the diff-approval flow (path-confined). |
| search | Prefer VS Code's bundled `rg` (ripgrep) for speed; fall back to the existing JS walk if `rg` is absent. |
| Review list | Per-change approval (each edit/create/command modal) IS the review — no separate batch UI. |

## 3. Architecture (extension-only)

All in `packages/extension/src/agent/tools.ts` (+ a tiny pure helper module); the agent loop (`loop.ts`) already dispatches any tool in `TOOL_SCHEMAS`.

### 3.1 New tools in `TOOL_SCHEMAS`
- `run_command` — `{ command: string }`. `executeTool` shows `window.showWarningMessage(command, {modal:true}, 'Run', 'Reject')`; on Run, `execFile('/bin/sh', ['-c', command], { cwd: workspaceRoot, timeout: 60_000, maxBuffer })`, returns `truncate(stdout + stderr + exitLine)`; on Reject returns `'rejected by user'`.
- `create_file` — `{ path, content }`. Path-confined via `resolveInWorkspace`; if the file exists → error (use edit_file); else `editFileWithApproval(abs, content, rel)` (shows the new content as a diff to approve).

### 3.2 `search` → ripgrep
`executeTool`'s `search` case: if an `rg` binary is found (`process.env.VSCODE_RG` or the standard `…/node_modules/@vscode/ripgrep/bin/rg`, or `rg` on PATH), run `rg --line-number --no-heading --color never -S <query>` in the root, cap ~100 hits; else keep the current JS walk. A pure helper `truncate(text, max=10_000)` caps output; `firstLines(text, n)` for hit capping.

### 3.3 Pure helper `agent/exec.ts` (tested)
`truncate(text, max)` and `parseRgHits(stdout, cap)` (normalizes `path:line:match` lines, caps count) — unit-tested without spawning.

## 4. Governance / safety

- Every command, edit, and file creation is **human-approved** in a modal — the agent cannot run or write anything silently.
- Commands run only in the workspace root; tool file access stays path-confined (`resolveInWorkspace`).
- No change to model routing or the US-only governance — this adds tools, not providers.

## 5. Testing

- **Unit (`exec.test.ts`):** `truncate` caps + marks truncation; `parseRgHits` parses/caps ripgrep output and ignores malformed lines. `tools.test.ts` gains: `TOOL_SCHEMAS` now exposes exactly the six tools (`create_file`, `edit_file`, `list_files`, `read_file`, `run_command`, `search`).
- **Manual (UAT):** agent asks to run `npm test` → modal → Run → results come back and the agent continues; agent creates a file → preview diff → Apply writes it; search uses ripgrep on a large repo.

## 6. Success criteria

1. In agent mode, the model can run a shell command **only after you approve it in a modal**; output (truncated) returns to the model.
2. The agent can create a new file, shown as an approvable diff; rejection writes nothing.
3. `search` returns fast repo-wide results (ripgrep when available).
4. `TOOL_SCHEMAS` exposes six tools and the loop dispatches them unchanged.
5. No regression to existing tools, the agent loop, governance, or tests.
