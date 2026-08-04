# Architecture

Two generations ship side by side. **Vertex 2** (`src/v2/*`) is the current
harness and the one described first; the original closed loop (`src/index.ts`)
is documented below it and still supplies the observation and evidence
primitives v2 builds on.

Plugin-only host entry: `src/plugin.ts` → `dist/plugin.js`.

---

## Vertex 2: three layers

The product claim — *"done" means proven, not claimed* — rests on three
distinct mechanisms. They are separate on purpose: each catches what the one
before it cannot.

| Layer | What it is | Where it lives |
|---|---|---|
| **1. Behavioural contract** | Working habits injected into the session before any work starts: ground before asking, prove before claiming, stop thrashing after two failures, report with evidence. | `experimental.chat.system.transform` in `src/v2/plugin.ts`, composed by `src/v2/composer.ts` |
| **2. Live detection and correction** | The loop is watched as it runs — edits, commands, exit codes, repeated failures, dropped promises, scope drift — and a correction is injected **at that moment**. | `tool.execute.after` + `event → session.idle` in `src/v2/plugin.ts`, rules in `src/v2/wiring/gate.ts` |
| **3. Independent verifier** | A **separate subagent session** (`vertex-verifier`) opens the real worktree and rules on each acceptance criterion. It can reject the claim and reopen the work. | `runVerifier` in `src/v2/verifier.ts`, driven by `handleVerifierAudit` in `src/v2/wiring/gate.ts` |

Layer 1 is a prompt. Layer 2 is a control loop. Layer 3 is an audit.

### Why a separate session for the verifier

The verifier runs in a child session created through `src/v2/subturn.ts`
(`runSubturn`), registered as the `vertex-verifier` agent in
`src/v2/wiring/config.ts` under `VERIFIER_PERMISSION`: `"*": "deny"` with
`read`/`grep`/`glob`/`list`/`bash` allowed and `edit`/`write`/`task`/`webfetch`
denied. It can read the tree and run verifiers; it has no edit tool. That
isolation is the point — the session that did the work does not get to grade
it.

Its payload is built by `buildVerifierPayload` (`src/v2/verifier.ts`), which
redacts secrets before anything leaves the process — the plan digest, changed
paths, verifier output and recent transcript are all scanned, including for
secrets wrapped across line boundaries.

### Plan, story, task

Multi-story work is recorded through the plan tools in
`src/v2/wiring/tools.ts` (`elicify_vertex_plan_create`, `_next`,
`_checkpoint`, `_reopen`, `_status`, `_clear`), with state in
`src/v2/story.ts`.

- A **story** carries `acceptanceItems` (what must be true) and `verifiers`
  (commands that produce evidence).
- A story decomposes into **tasks** with `dependsOn` edges; the engine
  computes parallel waves from the dependency graph rather than storing wave
  numbers.
- Checkpointing a task is a **claim**, not a close. When every task in a story
  is complete, the verifier audits it at the next idle and either confirms it or
  reverts it with named gaps (`applyVerifierVerdicts` in `src/v2/story.ts`).

### Checks vs. acceptance criteria

A deliberate split, and the reason receipts and the verifier do not do the same
job:

- **Technical checks** (`verifiers`, verification receipts in
  `src/v2/coverage.ts`) are **evidence**. A receipt asserts exactly one thing —
  this command ran and exited 0 — and may be credited loosely.
- **Acceptance criteria** are settled by **verifierment** against the worktree.
  Acceptance items carry no receipt requirement; the completion verifier is the
  sole arbiter of whether a checkpoint's claim was real.

Applying acceptance-criteria strictness to a technical check was measured to
cost everything and buy nothing: in the audited session it produced 146
relevance-gaps and zero receipts, which also left the verifier's cross-check with
no data.

---

## Vertex 1 closed loop

Implemented primarily in `src/index.ts`, with goal state in `src/goals.ts`,
out-of-band telemetry in `src/measurement.ts`, and disk redaction in
`src/redaction.ts`.

## Closed loop

```
inject → observe → record → check → block
```

| Phase | Mechanism |
|-------|-----------|
| **Inject** | `experimental.chat.system.transform` appends formatted directives to the system prompt for gate-active sessions. |
| **Observe** | `tool.execute.after` (and optionally `file.edited`) sees mutations, bash output/exit, failures. `experimental.text.complete` stores last assistant text. |
| **Record** | Per-session `EvidenceLedger` + in-memory `VerificationReceiptStore`; measurement JSONL side channel. |
| **Check** | On `session.idle`: promise-no-act rules, then `shouldBlockStop`. |
| **Block** | Enqueue reason directive + `client.session.prompt` continuation (or warn past cap / holdout allow). |

Inactive sessions: no inject, no ledger mutation from tools (receipt minting for goals on verified bash still runs so goals work from any agent).

## Hooks table

| Hook | Role |
|------|------|
| `config` | Registers `/elicify-vertex` and goal slash commands. |
| `command.execute.before` | Activates gate for `elicify-vertex` / `vertex` commands. |
| `chat.message` | Activate/deactivate gate; classify task + stop mode; reset ledger (unless gate continuation). |
| `tool.execute.after` | Observe mutations and bash verification/failures; mint receipts; enqueue failure / repeat-failure directives. |
| `experimental.chat.system.transform` | **Only** consumer of `DirectiveQueue.drain`; injects always-on + signal + mode + ledger + queued blocks. |
| `experimental.chat.messages.transform` | Present when `wireMessagesTransform` (default true); **no-op**, does not drain queue (avoids racing system path). |
| `experimental.text.complete` | Cache last assistant text for promise-no-act. |
| `experimental.session.compacting` | Mark session compacting so system transform **skips drain** (preserves queued directives across compaction). |
| `event` → `session.compacted` | Clear compacting flag. |
| `event` → `file.edited` | If exactly one active session: invalidate receipts + record path as changed. |
| `event` → `session.idle` | Stop gate + promise-no-act enforcement. |
| `tool` (`elicify_vertex_goal_*`) | Persisted multi-story goals API. |

Public method on the hooks object: `enqueue(sessionID, directive)` for external callers.

## Directive IDs

IDs appear in formatted blocks as `[id]` / narrative tags `[vertex:…]`.

| ID | Source |
|----|--------|
| `vertex:contract` | Default always-on system directive |
| `vertex:investigation` | Task mode `debugging` |
| `vertex:grounding` | Task mode `render` |
| `vertex:review-recall` | Review-task signal (`isReviewTask`) |
| `vertex:verification-advisory` | Stop mode normal |
| `vertex:verification-required` | Stop mode deep |
| `vertex:ledger` | Non-empty evidence summary this turn |
| `vertex:tool-failure` | Bash non-zero exit (first occurrence class) |
| `vertex:repeat-failure` | Same failure signature ≥ 2 times this turn |
| `vertex:stop-block` | Deep + changed + non-docs + unverified idle |
| `vertex:stop-warning` | Stop blocks at/over cap |
| `vertex:promise-no-act` | Promise-no-act hard block |
| `vertex:promise-no-act-warn` | Promise-no-act past cap |
| `vertex:verification-receipt` | Suffix on tool output (not a system directive); receipt id for goals |

Formatted envelope:

```text
<vertex-directives ts="ISO8601">
[id @ optional-iso]
text
---
…
</vertex-directives>
```

## Measurement events

Module: `src/measurement.ts`. **Never** injected into the model. Append-only JSONL at `eventsPath()` = `<VERTEX_DATA|~/.config/opencode>/.vertex-events.jsonl`. Payloads pass through `redactForDisk`.

Each line includes: `ts`, `session_id`, `holdout_arm` (`on`|`off`), `event_type`, `payload`.

| `event_type` | Typical payload | When |
|--------------|-----------------|------|
| `classify` | `mode`, optional `agent`, `trigger`, `risks`, `review` | Gate activation on user message |
| `gate_fire` | `decision` (`block`\|`warn`\|`allow`), `changed`, `verified`, `stop_blocks`, `max_stop_blocks`, `would_block`, optional `reason` | Idle gate / promise paths; also allow when nothing to block |
| `holdout_suppress` | `reason` | `VERTEX_HOLDOUT=1` and arm `off` skipped enforcement |
| `recovery_repeat` | `signature`, `count` | Repeat failure detected in tool path |
| `outcome` | optional rework counters | Writer API exists for post-hoc collectors; not written on the hot path by the plugin |

Holdout: SHA-256 of `"holdout|" + sessionId` → ~20% `off` (`HOLDOUT_OFF_FRACTION`). Suppression only if env `VERTEX_HOLDOUT=1`. Sunset constant `SUNSET_SESSIONS = 50` is exported for offline analysis (plugin does not auto-disable).

## Supporting modules

| Module | Responsibility |
|--------|----------------|
| `EvidenceLedger` | Per-turn mutation kinds, mode, risks, verification list, failure signatures, stop/promise counters |
| `DirectiveQueue` | Per-session FIFO capped queue |
| `SessionGate` | Active session set |
| `parseVerification` / `changedPathsFromTool` / `isMutatingBashCommand` | Observe path classifiers |
| `MultiStoryGoalEngine` | Locked write of `.elicify-vertex/goals.json` + ledger |
| `VerificationReceiptStore` | Session-scoped verified bash receipts (invalidated on mutation) |
| `redactSecrets` / `redactForDisk` | All disk and debug writes |

## Package boundary

- `export default` / `server` from `src/plugin.ts`: factory only (OpenCode host).
- `./lib` export (`dist/index.js`): factory **plus** pure helpers for tests and tooling.

See [CONFIGURATION.md](./CONFIGURATION.md), [USAGE.md](./USAGE.md), [DEVELOPMENT.md](./DEVELOPMENT.md).
