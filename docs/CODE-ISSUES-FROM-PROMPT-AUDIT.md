# Code issues found by auditing the agent prompt

Status: **OPEN.** Raised 2026-07-28 while rewriting `agents/elicify-vertex-agent.md`.

Each item below was a *prompt rule* compensating for a *code defect*. The rules
have been removed from the prompt — a prompt that teaches the model to route
around a harness limitation hides the limitation and makes it permanent. The
model's behaviour is now the specification; the harness has to meet it.

Ordered by severity.

---

## C-1 — The harness cannot read a chained command's exit status

**Severity: high.** Directly caused 28 `verify:ambiguous-exit` events in one
session, and through them a request to waive the evidence requirement.

A verifier run as `go test ./... 2>&1; echo "exit:$?"` or `npx vitest run | tail
-50` reports the *last* command's status — nearly always 0 — so the harness
refuses to mint a receipt. The passing test does not count.

The prompt used to carry the workaround: "run verifiers as a single standalone
command", with good/bad examples. That taught the model to avoid a shape the
harness should simply handle. Chaining and piping are normal shell usage.

**Fix:** parse the sub-command structure (`src/v2/coverage.ts` already has
`parseSubcommands` for exactly this) and attribute the exit status to the
verifier sub-command rather than to the aggregate. `parseSubcommands` +
`isTestRunnerCommand` are the pieces; the receipt path is what needs to consume
them.

**Until fixed:** models that chain get no receipt and cannot checkpoint, with no
prompt-level hint explaining why. That is the cost of removing the workaround,
and it is the right cost — it makes the defect visible instead of routing
around it.

## C-2 — A passing verifier that mints nothing gives the model no usable signal

**Severity: high.** Same session, same root cause as C-1.

When the harness declines to mint, the model sees a green test and a blocked
checkpoint with no explanation connecting them. Its observed response was to ask
the user to waive the evidence requirement — the one move that defeats the whole
mechanism.

The prompt used to say "fix the command's shape, do not reach for a waiver".
That is a workaround for a missing diagnostic.

**Fix:** when a verifier passes but no receipt is minted, say so at the point of
failure, with the reason and the remedy. The `receipt:scope-unverifiable`
finding at `src/v2/plugin.ts:809-819` is the right pattern — it explains why no
citable receipt was issued. Ambiguous exit needs the same treatment.

## C-3 — `resolveGoalWorkspaceRoot`'s refusal is swallowed in v2

**Severity: medium.** A behaviour regression from v1, not just a prompt issue.

v1's `GoalStore` constructor checked writability and threw
(`src/goals.ts:1133`). v2 calls `resolveGoalWorkspaceRoot` once at plugin init
and catches the throw, falling back to `process.cwd()`
(`src/v2/plugin.ts:229-234`); `StoryEngine` takes `stateDir` as a plain string
and never re-checks. So a session at filesystem root now writes state to `/`
where v1 refused loudly.

The prompt used to carry "if create fails with a writable-directory error, cd
into a real project folder; never `sudo mkdir` under `/`" — advice keyed to an
error string the v2 model can never see.

**Fix:** decide whether the fallback is intended. If yes, log it. If no, restore
the refusal in `StoryEngine`'s constructor and let `plan_create` surface it.

## C-4 — Subagents cannot mint receipts, and nothing says so

**Severity: medium — by design, but undocumented at the point of use.**

`tool.execute.after` returns early at `if (!state || !state.active) return`
(`src/v2/plugin.ts:601`), and activation requires `msgInput.agent ===
opts.activeAgent`, the slash trigger, or a command-activated session
(`plugin.ts:479-482`). A task-tool subagent has none, so its verifier runs
produce no evidence.

This is deliberate — it is what forces the main agent to verify — but the prompt
had it backwards ("every agent clears its own evidence gate"), which gave the
model a reason to skip its own verification.

**Fix (docs, not behaviour):** the constraint is correct and should be
preserved. It needs a test asserting it, so a future change to the activation
condition cannot silently let subagent receipts through.

## C-5 — Subagents receive no injected directives

**Severity: low.** Consequence of the same gate.

`system.transform` is behind `state.active`, so a subagent gets no
plugin-injected procedure for its task signal. The prompt's delegation package
told the parent to instruct subagents to "follow any plugin-injected procedure",
which describes nothing.

**Fix:** either accept it (the parent writes the discipline into the delegation
text, which is what actually happens), or give child sessions a read-only
directive channel. Accepting it is probably right; it needs a decision.

## C-7 — Subagents get the discipline only if the parent remembers to write it

**Severity: high.** The largest remaining gap between intent and enforcement.

A subagent should behave the same way the parent does — different process,
same discipline. Today that depends entirely on the parent hand-writing the
discipline into each delegation, which is self-report by another name: nothing
checks it, and under time pressure it is the first thing dropped.

The prompt used to carry a `VERTEX` bullet in the delegation package instructing
the parent to do exactly this. It has been removed, because asking the model to
remember is the wrong mechanism for something the harness can guarantee.

**Fix:** inject the behaviour prompt into every subagent call from
`tool.execute.before`. The hook already receives a mutable args object
(`src/v2/plugin.ts:574`), and the plugin already mutates `toolOutput.output` /
`toolOutput.metadata` in the `after` hook to deliver receipt ids
(`plugin.ts:822-823`), so the mechanism is established — though `before`-hook
arg mutation is a different hook and needs an empirical probe before anything is
built on it.

Design constraints:

- **Send the execution half only.** A subagent executes; it does not
  orchestrate. `fan_out_agents` would invite recursive delegation;
  `plan_gate` / `planning_in_waves` / `completion` point at plan tools whose
  receipts land in the wrong session bucket (see C-4), so it can never
  checkpoint; `interview` assumes a user it cannot reach. Ship `grounding`,
  `evidence`, `scope_discipline`, `how_you_think`, `known_traps`,
  `uncertainty`.
- This means splitting the agent file's `BEHAVIOR` block into two marked zones —
  shared execution core and orchestrator-only — and teaching
  `scripts/sync-activate-template.mjs` about both.
- Skip injection for `isSelf` sessions: the judge and intake subturns are
  zero-tool and have nothing to act on.
- `<evidence>` transfers cleanly as written, because the receipt mechanics were
  stripped out of it (C-1/C-2). Keep it that way; a subagent told to cite a
  `receiptId` would be chasing something it cannot obtain.

## C-6 — `blocked`/`failed` stories have no reopen path

**Severity: medium.** Pre-existing, restated here so the list is complete.

`"active"` is assigned only at `createPlan` index 0 and on complete-promotion,
so a plan containing a `blocked` or `failed` story can never reach all-complete.
The idle gate then nudges forever.

---

## Test gap behind all of these

`tests/agent-prompt.test.ts` checks tool *names*, slash commands and paths
against the code. Not one of C-1..C-5 would have failed it, because they are
claims about *behaviour* rather than identifiers.

**Fix:** extend the contract tests to the behavioural claims the prompt makes —
argument shapes, status enums, and whether a described failure mode is
reachable at all.
