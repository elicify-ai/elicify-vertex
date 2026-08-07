# elicify-vertex

**Make every model behave like a mythos-class model — the way people describe Claude Fable 5.**

*A behavioural contract, live in-loop correction, and an independent verifier that checks the work against your repo. Self-validating, evidence-driven agent loops — so "done" means **proven**, not **claimed**.*

[![GitHub stars](https://img.shields.io/github/stars/elicify-ai/elicify-vertex?style=social)](https://github.com/elicify-ai/elicify-vertex)
[![npm version](https://img.shields.io/npm/v/@elicify-ai/elicify-vertex)](https://www.npmjs.com/package/@elicify-ai/elicify-vertex)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

> **If this helps you, please [star the repo](https://github.com/elicify-ai/elicify-vertex)** — it helps other developers discover it.

---

## The problem

Most coding models *sound* capable. They write plausible code, say “done,” and move on.

What they often **don’t** do — unless you babysit them:

- Run the test that would prove the fix
- Look at the rendered UI instead of trusting a static file write
- Stop after the same failure twice and form a new hypothesis
- Finish the work instead of ending with “I’ll do X next”
- Report calmly with evidence instead of enthusiasm theater

That gap is why a few frontier models feel “mythos-class” (thorough, autonomous, honest) while cheaper or smaller models feel like junior interns with a megaphone.

**elicify-vertex closes that gap with procedure, not luck.**

---

## The story in one line

**elicify-vertex is an [OpenCode](https://opencode.ai) harness that makes *any* model behave more like a mythos-class engineer — the working habits people praise in models like Anthropic’s Claude Fable 5 — by enforcing verify-before-done, evidence-backed stops, and calm reporting.**

It does **not** pretend to be Fable. It encodes the **behaviors** that make that class of work reliable:

| Mythos-class habit | How Vertex enforces it |
|---|---|
| Prove it before you claim it | Stop gate blocks “done” after real code changes without observed verification |
| Don’t promise work you didn’t do | Promise-no-act catches “TODO / I’ll finish later” after edits |
| Investigate, don’t thrash | Repeat-failure inject after the same error twice |
| Actually look at the artifact | Debug / render procedures when the task signals it |
| High-recall review | Two-pass review inject (collect everything, then filter) |
| Own the full arc | Optional multi-story goals with verification receipts |

You keep your preferred model. Vertex raises the floor of how it *works*.

---

## How it works: three layers

Most "prompt engineering" stops at the first one. The interesting part is that the loop **checks its own work**.

**1. A behavioural contract — before the work starts.**
A compact set of working habits is injected into the session: ground yourself in the code before asking, prove it before claiming it, stop thrashing after two failures, report calmly with evidence. This is the part everyone already does.

**2. Live detection and correction — while the work happens.**
Vertex watches the loop as it runs: what was edited, which commands ran, what exited non-zero, whether the same error just repeated, whether a promise was made and quietly dropped. When the run drifts, the correction is injected **at that moment** — not raised in a post-mortem after the damage is done.

**3. An independent verifier — before the work can be called done.**
When the model says a story is finished, a **separate verifier session** opens your actual worktree — real files, real commands, real output — and rules on each acceptance criterion one by one. It can reject the claim, reopen the work, and name exactly what is missing. The model does not get to mark its own homework.

Layer 1 is a prompt. Layer 2 is a control loop. Layer 3 is an audit. Together they make the loop **self-validating**: the model proposes, the harness observes, and an independent verifier decides.

> **Checks vs. criteria.** Technical checks (did the command pass?) are *evidence* and can be loose. Acceptance criteria (is the story actually delivered?) are settled by **judgement**, against your repo. Vertex keeps those two things apart on purpose.

---

## How behaviour changes

When Vertex is **active** for a session (**Elicify-Vertex-Agent** or `/elicify-vertex`), the model’s behaviour shifts in concrete ways:

| Situation | Without Vertex | With Vertex |
|---|---|---|
| Finishes a feature | “Implemented.” (no test run) | Runs an allowlisted verifier (`tsc`, `npm test`, …) and cites the result — or is blocked from stopping |
| Edits code then says done | Session ends | **Deep** tasks: hard **stop-block** until verification (or explicit unverified statement); docs-only edits are exempt |
| Says “I’ll add tests later” / leaves a TODO | Walks away | **Promise-no-act** continuation: finish it or state what remains unverified |
| Same command fails twice | Retries the same fix silently | **Repeat-failure** directive: stop thrashing, new hypothesis or escalate |
| Tool exits non-zero | Often ignored in the narrative | **Tool-failure** reminder: don’t claim completion until fixed or documented |
| Debugging task | Guesses a fix | **Investigation** procedure: reproduce → hypotheses → evidence → causal chain |
| UI / HTML / chart task | Ships markup unseen | **Grounding** loop: run it, observe output, fix what you see |
| Code review | Sparse “looks fine” | **Review-recall**: collect low-confidence findings first, then filter with evidence |
| Multi-step plan | Ad-hoc checklist | Optional **goals** tools + verification receipts so “complete” is earned |
| Tone of the report | Verbose, hype, apology loops | Contract pushes **outcome-first, calm, short** reporting |
| Other OpenCode sessions | — | **Untouched** — zero inject until you pick the agent or run `/elicify-vertex` |

Mechanically: Vertex injects directives into the system prompt, **observes** tools (edits, bash, verifiers), **records** evidence, and on `session.idle` can **block** completion and re-prompt until the bar is met. If the plugin itself errors, it **fails open** so a broken harness never freezes your session.

Details: [docs/USAGE.md](./docs/USAGE.md) · [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Install

```bash
npm install @elicify-ai/elicify-vertex
```

Requires Node **≥ 20**. Current package: **`@elicify-ai/elicify-vertex@0.15.0`**.

> ### Upgrading from 0.9.x — the Judge is now the **Verifier**
>
> One rename, applied everywhere, with no compatibility shim. Nothing is
> required of you unless you touched one of these directly:
>
> | If you… | Change |
> |---|---|
> | set `VERTEX_JUDGE=0` to disable it | use `VERTEX_VERIFIER=0` |
> | parse `.vertex-events.jsonl` | the `judge:*` events are now `verifier:*`, and `story:judge-audit` is `story:verifier-audit` |
> | have a plan mid-flight | the stamp field `story.judge` is now `story.verifier`; an existing plan keeps its stories and simply gets re-audited once |
>
> The `vertex-judge` subagent is registered automatically and becomes
> `vertex-verifier` on restart — nothing to do.
>
> **Not a precedent.** This rename broke continuity with event records already
> on disk, and it happened before FR-033R existed. That rule now forbids it:
> event names are append-only, and a divergent spelling gets *registered*, not
> renamed (`intake:unsupported` was kept rather than corrected to
> `intake:classify-unsupported` for exactly this reason). Do not read the table
> above as licence to rename an event type.
>
> Also in this release: harness continuations no longer carry a `[vertex:…]`
> prefix. They are dispatched as ordinary user messages so the model treats
> them as instructions rather than as automated output it can discount; every
> dispatch is still recorded as `gate:continuation-dispatched` in the event
> log. And a `git diff` run outside a git repository no longer floods the
> terminal past the TUI renderer.

`postinstall` runs `scripts/install-skill.sh` (skill + agent into `~/.config/opencode/…`). Restart OpenCode after install.

```bash
npm run setup
# SKILL_FORCE=1 bash scripts/install-skill.sh   # overwrite existing skill/agent
```

---

## Enable in OpenCode

Global `~/.config/opencode/opencode.json` or project `opencode.json`:

```json
{
  "plugin": ["@elicify-ai/elicify-vertex"]
}
```

Postinstall tries to append this; set it manually if needed.

### If you see `Plugin export is not a function`

Point at the thin entry (`dist/plugin.js`):

```json
{
  "plugin": [
    "file:///absolute/path/to/node_modules/@elicify-ai/elicify-vertex/dist/plugin.js"
  ]
}
```

From a git clone (after `npm run build`):

```json
{
  "plugin": ["file:///absolute/path/to/elicify-vertex/dist/plugin.js"]
}
```

---

## How to use

The plugin loads quietly. It **only changes behaviour when activated** — two ways:

### 1. Elicify-Vertex-Agent (recommended)

In OpenCode, select the primary agent **Elicify-Vertex-Agent** (`elicify-vertex-agent`).

That agent is installed with the package (`postinstall` → `~/.config/opencode/agents/…`). It owns the full arc of a task: plan, decompose, delegate when useful, integrate only after verification. **Choosing this agent turns the harness on for the session automatically** — no slash command required.

### 2. Slash command `/elicify-vertex`

In any other agent/session, run:

```text
/elicify-vertex
```

That **injects the verification discipline into the conversation** (full contract in the slash expansion) **and** turns on the harness for this session (tool evidence + stop/promise gates). It is not a silent flag-only switch.

Optional goal helpers (after the harness is active): `/elicify-vertex-goal-create`, `/elicify-vertex-goal-next`, `/elicify-vertex-goal-checkpoint`, `/elicify-vertex-goal-status`.

### Skill (installed automatically)

The **`vertex`** skill is copied to `~/.config/opencode/skills/vertex/` for OpenCode’s skill catalog. Day-to-day activation is still **agent** or **`/elicify-vertex`**.

---

## Docs

| Doc | Topic |
|-----|--------|
| [docs/README.md](./docs/README.md) | Docs index |
| [docs/USAGE.md](./docs/USAGE.md) | Activation, stop gate, promise-no-act, env vars |
| [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) | Plugin options, `opencode.json` |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Hooks, directive IDs, measurement |
| [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) | Build, test, UAT |

---

## Contributing

Issues, PRs, and discussions are welcome.

| If you want to… | Go to |
|---|---|
| Find live work | [open issues](https://github.com/elicify-ai/elicify-vertex/issues) |
| Ask a question / get help | [SUPPORT.md](./SUPPORT.md) |
| Set up to build | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Community expectations | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) |
| Report a vulnerability | [SECURITY.md](./SECURITY.md) |
| Sign the CLA (before your first PR) | [Contributor License Agreement](./CLA.md) |

The **elicify-vertex** name is reserved per the [trademark policy](./TRADEMARKS.md).

External contributors sign a one-time [CLA](./CLA.md) before their first PR can merge. You keep copyright to your contribution; the CLA grants elicify.ai Pte. Ltd. a license to use it in the project.

---

## License

[MIT](./LICENSE) · Copyright © 2026 [elicify.ai Pte. Ltd.](https://github.com/elicify-ai)
