# elicify-vertex

**Make any model work like a senior engineer — not just answer like one.**

---

## What it does

elicify-vertex is a plugin for [opencode](https://opencode.ai) that makes AI coding assistants more reliable. It ensures the model **proves its work before claiming it's done** — running tests, checking output, and being honest about what's verified and what isn't.

You know how an AI assistant will sometimes say "I've fixed the bug" without actually testing the fix? Or claim "all tests pass" without running them? elicify-vertex stops that. It's a harness that holds the model to the same standard a senior engineer would hold a junior: *show me, don't tell me.*

The plugin is inspired by the working habits of Anthropic's Claude Fable 5 — a model widely praised for its thoroughness, autonomy, and honest reporting. But it doesn't try to imitate Fable. It encodes the **procedures** that make good work reliable: verify before claiming done, investigate before guessing, escalate when stuck, and communicate plainly.

## Why you need it

| Without elicify-vertex | With elicify-vertex |
|---|---|
| "I've implemented the feature." (untested) | "I've implemented the feature. Tests pass — here's the output." |
| "All green!" (ran `echo "ok"`) | Actually runs the test suite and shows you the result |
| Silently retries the same failing fix 5 times | Stops, forms a new hypothesis, or surfaces the blocker |
| Ends with "I'll run the tests next" | Actually runs the tests before stopping |
| Verbose, enthusiastic, performative reports | Calm, factual, outcome-first communication |

## How it works

The plugin sits between you and the model. On every turn where the plugin is active, it quietly adds a set of instructions to the model's system prompt — the part the model reads before generating its response. These instructions remind the model to:

- **Verify before claiming done** — run the test, render the artifact, hit the endpoint. A `Write` success message is authoring, not verifying.
- **Not trust superficial test passes** — a test that has never been observed to fail proves nothing.
- **Control things manually** — automated tests often miss real issues. If browser tools are available, use them to see the actual rendered output.
- **Stop retrying the same failing approach** — if something fails twice the same way, form a different hypothesis.
- **Communicate calmly** — lead with the result, avoid enthusiasm and apology, end when the useful information has been delivered.

The plugin only activates when you want it to — when you're using the **Helmsman** agent or the **`/vertex`** skill. Other sessions are left untouched.

## Installation

### For users

Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["@elicify-ai/elicify-vertex"]
}
```

That's it. opencode installs the package automatically on startup. The skill (`/vertex`) is installed for you — no manual steps, no symlinks, no configuration files to edit.

### For developers

```bash
git clone https://github.com/elicify-ai/elicify-vertex
cd elicify-vertex
npm install
npm run build
```

Then point opencode at your local copy:

```json
{
  "plugin": ["./elicify-vertex/dist/index.js"]
}
```

## How to use

### Option 1: The Helmsman agent

Select the **Helmsman** agent in opencode. The plugin activates automatically for that session. The Helmsman is a principal orchestrator — it decomposes work, delegates to subagents in parallel, and integrates verified results. Think of it as a senior engineer who owns the full arc of a task.

### Option 2: The `/vertex` skill

Type `/vertex` in any opencode session. The plugin activates for that session. Use this when you want the verification discipline without switching agents.

### Option 3: Both

Use the Helmsman agent AND invoke `/vertex` when you need an extra nudge. They work together — the agent provides the strategy, the skill provides the discipline.

## What you'll notice

After installing elicify-vertex, your AI assistant will:

1. **Stop claiming "done" without evidence.** If it says "done," it will show you the tool output that proves it.
2. **Actually run tests** — not just say it ran them. You'll see the command and the output.
3. **Be honest about failures.** If something didn't work, it will tell you — not paper over it.
4. **Communicate more clearly.** Shorter, calmer, more direct. No enthusiasm theater.
5. **Not loop on the same error.** If a fix doesn't work twice, it will try a different approach.

## Configuration

The plugin works out of the box. If you want to customize:

| Option | Default | What it controls |
|---|---|---|
| `activeAgent` | `elicify-vertex-helmsman` | Which agent name activates the plugin |
| `activeSkillTrigger` | `/vertex` | Which slash command activates the plugin |
| `maxPerSession` | `16` | Max directives queued per session |
| `systemDirectives` | built-in verification block | The always-on instructions injected every turn |

## For plugin developers

If you're building your own opencode plugin and want to enqueue directives:

```ts
import { ElicifyVertexPlugin } from "@elicify-ai/elicify-vertex"

const vertex = await ElicifyVertexPlugin(ctx)

// Schedule a directive for the next LLM turn
vertex.enqueue(sessionID, {
  id: "stop:block",
  text: "Verification missing — run a tool and show the output before reporting done.",
})
```

The directive will be injected into the system prompt on the next LLM call (if the session is active).

## Technical details

- **Self-contained** — no symlinks, no external scripts, no system dependencies beyond opencode itself.
- **Gated** — the plugin is always loaded but only injects when the Helmsman agent or `/vertex` skill is active. Other sessions get zero overhead.
- **Fails open** — if the plugin encounters an error, it stays silent. A broken harness must never break your work.
- **ESM + strict TypeScript** — built to the opencode plugin SDK's exact specifications.

## Verify

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT — see [LICENSE](./LICENSE).

## Companion artifacts

- **Skill:** `/vertex` — the slash command that activates the plugin for a session.
- **Agent:** **The Helmsman** (`elicify-vertex-helmsman`) — the principal orchestrator agent that pairs with this plugin. Decomposes work, delegates in parallel, integrates verified results.

## Acknowledgments

The behavioral patterns encoded in this plugin are inspired by the working habits of Anthropic's Claude Fable 5 — a model praised for reducing human supervision, verifying before claiming done, and communicating with calm maturity. The plugin does not imitate Fable; it encodes the **procedures** that make good work reliable, regardless of which model you use.
