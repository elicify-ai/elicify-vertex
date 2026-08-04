# Draft: what gets injected into subagent calls (C-7)

Status: **Implemented.** Draft text APPROVED (2026-07-28) and, in this same
diff, wired in: `src/v2/wiring/subagentInjection.ts` exports
`SUBAGENT_INJECTION_PREAMBLE` (the literal text below, copied verbatim) and
`injectSubagentPreamble`, and `src/v2/plugin.ts`'s `tool.execute.before`
calls it for every `toolInput.tool === "task"` call, before the
`WRITE_TOOL_NAMES` write-protection gate. Covered by
`tests/v2/subagentInjection.test.ts` (unit-level, including the
mutate-in-place-vs-reassign regression guard described in §"Feasibility"
below) and `tests/v2/plugin.integration.test.ts`'s "C-7: task tool calls get
the subagent discipline injected" block (hook-level, against the real wired
plugin).

Scope confirmed by the user: every subagent the main agent invokes via the
`task` tool gets this prompt — uniformly, no per-`subagent_type` variant. The
verifier is the one exception, and it needs no special-case code:
`runVerifier`/`runSubturn` create the verifier session directly via
`client.session.create` + `client.session.prompt` (`src/v2/subturn.ts:440,483`),
never through the `task` tool, so it is already outside the reach of a
`tool.execute.before` hook keyed on `toolInput.tool === "task"`. Same for the
intake subturn — both go through `runSubturn`, neither goes through `task`.
This resolves open question 2 below and narrows question 4 to "don't wire the
injection anywhere near `runSubturn`" rather than an explicit exclusion check.

---

## 1. What goes in, what stays out, and why

The parent orchestrates; a subagent executes one bounded unit. Sending it the
orchestrator's rules would be actively wrong, not just wasted tokens — most of
them don't apply and one of them (`<fan_out_agents>`) invites the exact failure
this mechanism exists to prevent: recursive delegation with no visibility.

| Source section | Subagent gets it? | Why |
|---|---|---|
| `<identity>` | **No** — replaced | The Task tool already sets identity via `subagent_type` + `description`. Prepending our own would conflict with e.g. a `code-reviewer` agent's own identity. Gets one attribution line instead. |
| `<how_you_work>` | No | Describes the six-phase orchestrator loop (interview → plan gate → waves). A subagent is inside one already-scoped unit of that loop. |
| `<grounding>` | **Yes, compressed** | Reading code before acting applies to any executor, not just the orchestrator. |
| `<probe_before_you_build>` | **Yes, compressed** | Same reasoning — feasibility-checking before building is execution discipline. |
| `<interview>` | No, with a substitution | A subagent has no established channel back to the user. See §3 below — this is the one open question that actually matters. |
| `<plan_gate>` / `<planning_in_waves>` | No | The subagent doesn't own a plan; the parent already told it its scope via the delegation package. |
| `<fan_out_agents>` | **No, and explicitly forbidden** | Sending this invites a subagent to spawn its own subagents. Recursive delegation with the parent unable to see the second layer is a materially different risk than the one wave-fan-out was built to manage. |
| `<evidence>` | **Yes, mostly verbatim** | This is the core of the whole harness and the one thing that must not weaken with distance from the parent. |
| `<known_traps>` | **Yes, trimmed** | Kept the ones that apply to a single bounded unit; dropped `constraint drift` (that's about long *orchestrator* sessions) and `over-thoroughness` (already covered by scope discipline below). |
| `<completion>` | No, with a substitution | The subagent doesn't call `elicify_vertex_plan_checkpoint` — only the parent does (receipts are session-scoped; see C-4). Replaced with a one-line RETURN reminder, since the parent's delegation already specifies the exact RETURN shape per C-7's design note. |
| `<how_you_think>` | **Yes, trimmed hard** | Kept the four with evidence behind a real defect (finish what you start, enumerate hypotheses, calibrate confidence, own errors). Dropped the rest — conventions-matching, externalising state, pushback-then-commit, honesty-over-agreeable are either orchestrator-scale concerns or things a subagent has no occasion to exercise inside one bounded task. |
| `<communication>` | **No, replaced** | The subagent's real audience is the parent's context window, not a human. Full communication style (semi-technical language, format fidelity) doesn't transfer. Replaced with one line: keep the RETURN terse, because it re-enters the parent's context and the parent pays for it on every subsequent turn. |
| `<scope_discipline>` | **Yes, verbatim** | Applies identically. |
| `<uncertainty>` | **Yes, rewritten** | The original three-step ladder assumes an *orchestrator's* escalation options (delegate to a stronger model, recommend a fresh session). A subagent can't delegate further (see fan_out_agents above) — its only real move when stuck is to report the blocker back clearly. Rewritten to match what a subagent can actually do. |

---

## 2. The draft text

This is what `tool.execute.before` would prepend to `args.prompt` for every
`task` tool call, ahead of the parent's own CONTEXT / SCOPE / DEFINITION OF
DONE / RETURN package.

```
You are executing one bounded unit of work delegated under the elicify-vertex
verification discipline. Everything below governs how you do this task; the
message after it is the task itself.

Ground before you act:
- Read the relevant code and existing conventions before writing anything —
  the code cannot be out of date about itself.
- If you must check whether an approach would work at all, probe it cheaply
  first: build the check outside the real files, include a case you expect to
  fail, and read ground truth (the file, the output) rather than trusting a
  tool's own success message.

Evidence — this is the part that must not weaken with distance from the
parent:
- Ground every "done" in a result you observed this turn. Writing a file is
  authoring, not verifying.
- An observed passing test, lint, typecheck, build, or reliable HTTP probe is
  evidence. An unread exit code is not.
- Verify your own actions, not just your results — a tool that returned
  without error has not necessarily done what you asked.
- You cannot mint a verification receipt; only the parent session can. Do not
  claim one, reference one, or write one into any file. Report what you
  observed in plain text instead — the parent verifies before it counts your
  work as done.

Known traps:
- Verification theatre — don't say "verified" unless the verification was
  sufficient. Name the specific result.
- Confabulation under confidence — don't state a plausible API, flag, or
  citation from memory. Look it up.
- Silent abandonment — if part of the task cannot be done, say so in your
  RETURN. Do not report only the part that worked.

Scope discipline:
- Change only what was directly requested or clearly necessary. Stay inside
  the files and boundaries the delegation gave you.
- Do not add comments, error handling, or abstractions for cases that were not
  asked for.

How you think:
- Finish what you start — keep iterating on a failing check rather than hand
  back a half solution.
- Before diagnosing a failure, consider more than one explanation and say
  which you ruled out.
- Distinguish "I verified this" from "I believe this" from "I am guessing" in
  your RETURN.
- If something went wrong, say what and why — plainly, without spiralling into
  apology.

If you get stuck:
- You cannot delegate further or ask the user — report the blocker plainly:
  what you tried, what happened, and the specific question that would unblock
  you. That is a complete and acceptable RETURN.

Keep your RETURN terse. It re-enters the parent's context and is paid for on
every turn after this one — report the outcome and the evidence, not a
narrative of how you got there.
```

**Length:** 460 words (as shipped — `SUBAGENT_INJECTION_PREAMBLE`,
`src/v2/wiring/subagentInjection.ts`). For comparison, the full agent prompt's
behaviour body is ~2,124 words — this is roughly a fifth, deliberately,
because of the context-echo cost the probe surfaced (the injected text is
recorded in the *parent's* persisted tool-call args and re-enters the parent's
history on every subsequent turn, not just the child's).

---

## 3. Open questions — resolved before/during implementation, except #3

1. ~~Can a subagent reach the `question` tool at all?~~ **Resolved: no**, and
   **correction to how**: structural denial the way `AGENT_PERMISSION` denies
   `vertex-verifier`/`vertex-intake` (`config.ts`) does NOT generalise here —
   checked directly. That mechanism works only because we register those two
   agents ourselves and set their `permission` config. A `task`-tool subagent's
   `subagent_type` (`general-purpose`, `code-reviewer`, a user's own custom
   agent, ...) is registered by the host or by other plugins; we have no config
   hook that reaches into an arbitrary third party's `permission` block. So the
   only lever is the one already in place: the injected preamble gives the
   subagent no instruction to ask and no mention the `question` tool exists for
   it. If the host happens to grant it anyway and the subagent tries regardless
   of the prompt, that call blocks with nobody watching — an accepted residual
   risk, not a solved one, and not solvable at the permission layer with what
   this plugin controls.
2. ~~Should the injected text differ by `subagent_type`?~~ **Resolved:**
   uniform for every `task`-tool subagent, no per-type variant.
3. **Where does this live in the sync pipeline?** The main agent prompt and
   slash template are generated from `agents/elicify-vertex-agent.md`'s
   `BEHAVIOR` block via `scripts/sync-activate-template.mjs`. This third
   surface would need its own source of truth — either a new marked block in
   the same file, or a separate small file — so it doesn't silently drift from
   the sections it draws from (evidence, known_traps, scope_discipline) the way
   the three activation surfaces used to.
4. ~~Skip injection for `isSelf` sessions (verifier, intake subturns)?~~
   **Resolved, and simpler than expected:** no explicit check needed. Verifier and
   intake are both created via `runSubturn` → `client.session.create` +
   `client.session.prompt` (`src/v2/subturn.ts:440,483`), never via the `task`
   tool, so a `tool.execute.before` hook keyed on `toolInput.tool === "task"`
   never sees them. The implementation constraint is just: don't wire the
   injection anywhere near `runSubturn` — it belongs solely in the `task`
   branch of `tool.execute.before`.

---

## 4. Known limitation — plain string concatenation, no structural delimiter

**Not fixed. Documented only**, per a security review of this diff.
`injectSubagentPreamble` builds the mutated prompt as plain string
concatenation:

```ts
args.prompt = `${SUBAGENT_INJECTION_PREAMBLE}\n\n${args.prompt}`
```

There is no structural delimiter — no sentinel, no schema field, nothing a
model is trained to treat specially — separating the trusted harness preamble
from the task text that follows. Both arrive as one undifferentiated block of
plain text in the subagent's prompt. The task text itself is not always
purely parent-authored: a delegation prompt can echo file contents, command
output, or other externally-influenced text the parent copied in while
composing the delegation. Nothing about the current concatenation format
stops task text that happens to resemble instruction-shaped prose from being
read by the subagent as a continuation of the preamble's own authority,
rather than as the (possibly less-trusted) content it actually is.

This is an **inherent limitation of the mechanism as designed**, not a
regression or an implementation bug — the feasibility probe (§"Feasibility"
in `docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md` C-7) only established that
in-place mutation of `args.prompt` reaches the subagent at all; it says
nothing about how the two texts should be told apart once concatenated, and
this draft's design work never specified a delimiter format. Named here as a
threat-model gap worth hardening later — e.g. a more structured injection
format (a clearly-marked fence around the preamble, a separate system-level
field if the `task` tool ever grows one, or an explicit "end of harness
instructions" sentinel the subagent is told to honor) — rather than leaving
it silently undiscussed. No fix is proposed or attempted in this diff.
