---
name: vertex
description: Inject harness directives into the LLM input via the official opencode chat.system.transform and chat.messages.transform hooks. The correct, SDK-native place to add post-tool evidence, loop reminders, and per-session instructions — instead of stamping tool output. Use when wiring a verification/contract block, a stop-block reminder, or any per-session directive that should reach the LLM as a system instruction rather than as part of a tool reply. Triggers on phrases like "add a verification reminder to the LLM", "inject a contract block into the system prompt", or when the elicify-vertex plugin is loaded and a Stop/PostToolUse hook needs to enqueue a directive.
---

# elicify-vertex

Package: **`@elicify-ai/elicify-vertex`**

An opencode plugin that closes the verification loop: inject → observe → record → check → block. It wires the official LLM-input injection hooks — `experimental.chat.system.transform` (preferred, per-session) and optionally `experimental.chat.messages.transform` — plus a tool read-path, stop gate, and promise-no-act guard.

## When to use

- You need to inject a directive (verification reminder, stop-block reason, per-session instruction) into the **next LLM call**, not as a tool-output stamp.
- You want the harness active for a session: enforces verify-before-done, records tool evidence, and can block unverified completion.
- You are wiring a Stop/PostToolUse-style flow and want the directive to land as a system instruction on the model's next turn.

## When NOT to use

- You only need to log evidence (use a sidecar file, not a transform hook).
- You want to steer the user, not the model (this plugin targets the LLM input).
- You need cross-session shared state in the queue (plugin runtime state is per process; lift the queue if you need more).

## Activation

The **static verification contract** lives in the **Elicify-Vertex-Agent** prompt and in the **`/elicify-vertex` slash template** (slash injects behavior, not only a silent flag). Per-turn `system.transform` carries **dynamic** notes only (mode, ledger, queued failures/stops).

The plugin loads with opencode but only **gates / dynamic-injects** when a session is activated:

| Path | How |
|------|-----|
| **Agent (recommended)** | **Elicify-Vertex-Agent** (`elicify-vertex-agent`) — default `activeAgent` |
| **Slash** | `/elicify-vertex` only (default `activeSkillTrigger`; registered via config hook) |

Other agents/sessions stay untouched (gate deactivates when another named agent is selected).

## How it works

1. Session gate activates via agent name, slash trigger, or command.
2. Callers (plugin internals, sibling hooks) `enqueue(sessionID, { id, text })`.
3. On the next LLM call, `experimental.chat.system.transform` drains the queue and appends a tagged block:

```
<vertex-directives ts="2026-07-23T12:00:00.000Z">
[vertex:contract]
...
</vertex-directives>
```

4. `tool.execute.after` records mutations and verification outcomes (read path).
5. On `session.idle`, the stop gate can re-prompt / block unverified deep work or promise-no-act finishes.

## Install (opencode)

```bash
npm install @elicify-ai/elicify-vertex
```

Postinstall copies the skill + agent and registers the package in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@elicify-ai/elicify-vertex"]
}
```

Local development (point at a checkout build entry):

```json
{ "plugin": ["./path/to/elicify-vertex/dist/plugin.js"] }
```

Restart opencode after install. Skill path after install: `~/.config/opencode/skills/vertex/SKILL.md`. Agent: `~/.config/opencode/agents/elicify-vertex-agent.md` (and `agent/` for compatibility).

## Library / plugin API

**Plugin entry** (what opencode loads — only function exports):

```ts
import ElicifyVertexPlugin from "@elicify-ai/elicify-vertex"
// also: export const server = ElicifyVertexPlugin

const hooks = await ElicifyVertexPlugin(ctx /*, options */)
hooks.enqueue(sessionID, {
  id: "post-tool:evidence",
  text: "Tool call observed a failure. Surface it; do not retry silently.",
})
```

**Helpers** (not as the opencode plugin root — use the `/lib` export):

```ts
import {
  formatDirectives,
  parseVerification,
  classifyStopMode,
  detectPromiseNoAct,
  // ... see dist/index.d.ts
} from "@elicify-ai/elicify-vertex/lib"
```

## Configuration

```ts
interface ElicifyVertexOptions {
  maxPerSession?: number              // default 16
  wireMessagesTransform?: boolean     // default true
  systemDirectives?: () => readonly Directive[]  // default: vertex:contract
  activeAgent?: string                // default "elicify-vertex-agent"
  activeSkillTrigger?: string         // default "/elicify-vertex" 
  maxStopBlocks?: number              // default 3
}
```

Env (optional): `VERTEX_DEBUG=1` (debug log under `~/.config/opencode/.vertex-debug.log`), `VERTEX_DATA` (measurement events dir; default `~/.config/opencode`, file `.vertex-events.jsonl`).


## Multi-story goals (optional)

Tools: `elicify_vertex_goal_create` / `_next` / `_checkpoint` / `_status` (slash: `/elicify-vertex-goal-*`).
State: `<writable-project>/.elicify-vertex/`. Not required for harness stop/promise gates.
Requires a writable project directory (never `/`). Final story needs a session verification receipt.

## Verify

```bash
npm install
npm run typecheck
npm test
npm run build
npm run uat                 # Node harness
# bash scripts/uat-opencode-live.sh   # live opencode CLI UAT (requires opencode)
```

## See also

- Companion agent: **Elicify-Vertex-Agent** (`agents/elicify-vertex-agent.md`)
- Developer docs: `docs/` (USAGE, CONFIGURATION, ARCHITECTURE, DEVELOPMENT)
- Opencode plugins: https://opencode.ai/docs/plugins/
