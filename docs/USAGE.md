# Usage

Power-user behavior of the elicify-vertex OpenCode plugin.  
For install and first-run fluff, see the root [README](../README.md). For options and paths, see [CONFIGURATION.md](./CONFIGURATION.md).

## Activation

The plugin always loads with OpenCode. The harness (directive inject + evidence ledger + stop gate) runs only when the **session gate** is active for that `sessionID`.

Activation paths (any one):

| Path | How |
|------|-----|
| **Agent (recommended)** | Primary agent is **Elicify-Vertex-Agent** (`elicify-vertex-agent` / `activeAgent`). |
| **Slash** | User text matches `activeSkillTrigger` (default `/elicify-vertex`) at the start of a line. No `/vertex` alias. |
| **Command** | OpenCode commands `elicify-vertex` or `vertex` (registered in the `config` hook). `command.execute.before` activates immediately; the first matching `chat.message` also activates. |
| **Gate continuation** | After a stop / promise block, an internal `session.prompt` re-enters the turn; that message keeps the gate on and **does not** reset the ledger. |

Deactivation: if `chat.message` reports a different non-empty `agent` than `activeAgent`, the session is deactivated.

Goals tools and goal slash commands are available independent of the session gate (they use the worktree, not directive injection).

## Stop gate

Fires on OpenCode event `session.idle` when the gate is active.

### Mode classification (`classifyStopMode`)

From the user message text (and risk flags):

| Mode | When | Hard-block on idle? |
|------|------|---------------------|
| **quick** | Quick/brief/explain-only signals, or default when nothing stronger matches; **never** if any risk flag is set | No |
| **normal** | Implement/fix/build/test-style signals without deep/risk | No (advisory inject only) |
| **deep** | Deep/thorough/production/deploy/etc. keywords, **or** any risk flag | Yes, if other conditions hold |

**Risk flags** (any → deep): `production`, `database`, `secret-or-auth`, `remote-write`.

Mode guidance is also injected on later LLM calls via `system.transform` (`vertex:verification-advisory` / `vertex:verification-required`).

### Hard-block policy (`EvidenceLedger.shouldBlockStop`)

All of the following:

1. `taskMode === "deep"`
2. Files were recorded as changed this turn
3. Changed file kinds are **not** docs-only (see below)
4. No successful allowlisted verification recorded **after** the latest mutation

Otherwise the gate logs `decision: "allow"` and does not re-prompt.

**Docs-only exemption:** if every recorded change classifies as `"docs"`, never hard-block. Kind rules (`classifyFileKind`): docs extensions/basenames and paths under `docs/`; code extensions win over a `docs/` path segment; common config extensions; else `other`.

**Stale evidence:** successful verification results are dropped when a later mutation is recorded (`recordChangedFiles`). UI-only `file.edited` events attribute to the ledger only when exactly one session is active.

### Cap

After `maxStopBlocks` (default **3**) unverified stop attempts, further blocks become **warn** (enqueue `vertex:stop-warning`, no another forced continuation).

### How block is enforced

The plugin enqueues `vertex:stop-block` and calls `client.session.prompt` with the reason text. If prompt is missing or throws, it logs `decision: "allow"` with a reason; the directive remains queued for the next `system.transform` if a turn happens.

Holdout can skip enforcement — see [Env vars](#env-vars).

## Promise-no-act

Also on `session.idle`, after celebrating last assistant text from `experimental.text.complete`.

**Scan:** last **600** characters of the assistant message for keyword/pattern hits (EN + KO deferral, TODO/FIXME/XXX, issue-filing, future-intent, constrained later/tracked, etc.).

**Policy (`shouldBlockPromiseNoAct`):**

- No file changes this turn → never block  
- Tail asks the user (e.g. “shall I”, “would you like”) → never block  
- No hits → never block  
- Unverified + any hit → block  
- Verified → only **strong** labels block (TODO/FIXME/XXX, deferral, issue-filing, future-intent, we-should-X-later, next-iteration, follow-up). Weak later/tracked-only hits do not.

Enforcement mirrors the stop gate (enqueue + `session.prompt`, same `maxStopBlocks` counter family via `promiseBlocks`, holdout skip). Past cap: `vertex:promise-no-act-warn`.

## Verification commands (high level)

Only **bash** tool results are classified. Parser: positive allowlist at executable position (not “substring anywhere”), plus failure-output overrides even when exit is 0, and reject unreliable exit aggregation (`||`, bare `|`, bare `&`, `;` masking after a verifier unless `&&`-only chain).

Allowlisted families (non-exhaustive):

- Direct: `pytest`, `unittest`, `vitest`, `jest`, `tsc`, `eslint`, `ruff`, `mypy`, `playwright`, `cypress`, `rspec`, `curl`, `build`, `check`, `validate`, `verify`
- `python`/`py -m pytest|unittest|json.tool|py_compile`
- `go test`, `cargo test|check|build`, Maven/Gradle test wrappers
- `npm|pnpm|yarn|bun` `test|lint|typecheck|build|check|validate|verify` and `run` scripts whose name parts include those words
- `make|just|task` with those targets
- `npx` / `bunx` / `pnpm exec|dlx` / `yarn dlx` wrappers peeled before match
- Executable basename matching test/lint/typecheck/build/check/validate/verify patterns

**Success for the ledger:** outcome `verified` = verification command, reliable aggregate exit, exit code `0`, no contradictory failure patterns in output. Silent tools (e.g. `tsc`) count. `curl` needs `--fail` / `-f` or explicit HTTP 2xx in output for reliable success.

Successful verifications also mint an in-memory **verification receipt** (`vrf_…`) appended to tool output as `[vertex:verification-receipt] <id>` for goal final checkpoints.

**Not verification:** Write/Edit success, non-allowlisted bash, ambiguous composition, failed exit, or failure text in output.

## Goals tools

Optional multi-story plan with a final verification gate. **Not required** for normal harness use (stop/promise gates work without a plan).

Exposed as OpenCode tools (and matching slash commands under `config`):

| Tool | Role |
|------|------|
| `elicify_vertex_goal_create` | Create sequential multi-story plan under `<project>/.elicify-vertex/goals.json`; appends a final **verification** story automatically. `replace` archives the prior plan. |
| `elicify_vertex_goal_next` | Start or return the active pending story. |
| `elicify_vertex_goal_checkpoint` | Checkpoint active story: `complete` \| `failed` \| `blocked` + evidence. Final verification story requires `verificationReceiptId` from this session’s observed success. |
| `elicify_vertex_goal_status` | Read/validate persisted plan (or null). |

**Workspace root:** goals need a **writable project directory** (never filesystem root `/`). The plugin resolves `worktree` → `directory` → `cwd` → `$HOME` and picks the first writable path. If none work, tools fail with a clear error — open or create a project folder and retry. Do not `sudo mkdir /.elicify-vertex`.

Slash: `/elicify-vertex-goal-create`, `-next`, `-checkpoint`, `-status`. If create is invoked with empty arguments, gather `brief` + `stories` before calling the tool.

**Elicify-Vertex-Agent** includes a multi-story goals section: use these tools when the user wants a formal sequenced plan.

State files (mode `0600`, dir `0700`): `goals.json`, `goals.ledger.jsonl`, lockfile; secrets redacted on disk (`redactForDisk`).

## What you see in chat vs what the model sees

| Path | Visible in chat UI? |
|------|---------------------|
| **Static contract** | In **Elicify-Vertex-Agent** prompt always; also in **`/elicify-vertex` slash template** (injected when you run the slash — not only a silent switch) |
| System inject each turn | **Dynamic only** (mode / ledger / queued failures) — **not** the full static contract |
| **Activate cue** (first harness-on message) | **Yes** — one line, e.g. `[vertex] harness on · stopMode=…` |
| **Gate block** (stop / promise-no-act) | **Yes** — continuation with headline + full reason |
| Verification receipt on tool output | **Yes** — `[vertex:verification-receipt] vrf_…` |
| Operator proof | `VERTEX_DEBUG=1` → `~/.config/opencode/.vertex-debug.log` |

Full requirements: [REQUIREMENTS-INJECTION-VISIBILITY.md](./REQUIREMENTS-INJECTION-VISIBILITY.md).

## Env vars

| Variable | Effect |
|----------|--------|
| `VERTEX_DEBUG=1` | Append redacted lines to `~/.config/opencode/.vertex-debug.log` (mode `0600`). |
| `VERTEX_DATA` | Root directory for measurement JSONL (default: `~/.config/opencode`). Events file: `<VERTEX_DATA>/.vertex-events.jsonl`. |
| `VERTEX_HOLDOUT=1` | Enable 20% deterministic per-session **off** arm. Off-arm sessions skip stop / promise-no-act **enforcement** and log `holdout_suppress`; model never sees the arm. Default unset = gate always on for suppress checks. |

See also [ARCHITECTURE.md](./ARCHITECTURE.md) (loop, hooks, events) and [DEVELOPMENT.md](./DEVELOPMENT.md) (UAT).
