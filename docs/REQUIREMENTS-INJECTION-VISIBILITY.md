# Requirements — injection / steering visibility

**Status:** **Approved** by operator (2026-07-24) — implemented in G002  
**Date:** 2026-07-24  
**Package:** `@elicify-ai/elicify-vertex`

## Context

Vertex steers the model by appending `<vertex-directives>` to the OpenCode **system** prompt (`experimental.chat.system.transform`). That path is **not** shown in the normal chat transcript. Operators reported “injection not working” when they expected to **see** it in chat.

## Audience

| Audience | What they get |
|----------|----------------|
| **End user (chat)** | Minimal, non-technical cues only |
| **Operator / developer** | Full proof via `VERTEX_DEBUG=1` and `.vertex-events.jsonl` (documented) |

## Product stance (locked intent)

**Default: gate-visible + one soft activate cue.**

| Event | User-visible chat | System prompt (model-only) | Operator logs |
|-------|-------------------|----------------------------|---------------|
| Routine inject each turn (contract, mode, ledger) | **No** | Yes (unchanged) | `INJECTED N` if debug |
| **Harness activates** (agent or `/elicify-vertex`) | **Yes — one minimal line** | Yes | `ACTIVATED` |
| **Gate fires** (stop-block / promise-no-act) | **Yes — clear reason** (full block text OK) | Queued directives + continuation | `gate_fire`, `STOP BLOCK` / `PROMISE` |
| User asks “is vertex on?” | Short status from tools/logs | — | — |

### Explicit non-goals

- Do **not** dump full `<vertex-directives>` / full contract / investigation procedures into the chat every turn.
- Do **not** show a cue on every `system.transform` inject.
- Do **not** require a third-party plugin; implement with OpenCode hooks Vertex already uses.

## UX shape (minimal line in conversation)

Prefer a **short, single-line** note in the conversation, similar in spirit to how long-running goal UIs surface status (compact status, not a wall of system text):

**Activate (once per activation):** e.g.  
`[vertex] harness on · stopMode=deep · agent=elicify-vertex-agent`

**Gate block (when continuation fires):** keep/improve the existing continuation body so the **user** can read *why* work was blocked (full stop/promise reason is allowed here). Avoid duplicating the entire always-on contract again.

**Implementation preference (to validate in G002):**

1. Reuse host-native patterns first: `session.prompt` continuation parts (already used for gates), and/or a single synthetic text part if the plugin API allows without breaking the session.
2. Study compact status patterns from other OpenCode plugins (e.g. short “Goal set.” / status lines) for tone and length — **do not depend on those plugins being installed**.
3. If the host cannot attach a user-visible line on activate without a hack, fall back to: gate-visible only + excellent operator docs (document the limitation).

## Privacy / safety

- Any user-visible text must pass the same **secret redaction** as debug logs.
- No holdout arm, session internals, or raw measurement payloads in chat.

## Acceptance (after implement + prove)

1. Fresh session with Vertex agent: user sees **one** activate line (or documented fallback).
2. Deep unverified edit → idle: user sees **gate reason** in the continuation path.
3. Normal turns: chat is **not** flooded with directive bodies.
4. With `VERTEX_DEBUG=1`, operator can still prove inject via debug log.
5. Docs (USAGE) explain “invisible system inject vs visible cues.”

## Interview record

| Question | Answer |
|----------|--------|
| Audience | Both (different channels) |
| Routine inject visibility | Soft cue on **activate** (not every turn) |
| When to surface | Activate + gate fire |
| Channel | Minimalistic line in conversation; reuse good OpenCode UX patterns |
| Full contract in chat | **On gate block** only |
| Priority stance label | **Gate-visible only** (interpreted with activate soft cue as above) |

## Sign-off

- [x] Operator confirms this note (approved 2026-07-24)
- [x] G002 implement (activate cue + gate-visible continuation formatting)
- [ ] G003 prove live in OpenCode chat
