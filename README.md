# elicify-vertex

**Make every model behave like a mythos-class model — the way people describe Claude Fable 5.**

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

Requires Node **≥ 20**. Current package: **`@elicify-ai/elicify-vertex@0.9.2`**.

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

That is the **only** activation slash command. It turns on the same verification harness for the current session without switching primary agents.

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
