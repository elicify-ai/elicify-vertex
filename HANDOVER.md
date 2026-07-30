# Handover — elicify-vertex verification-gate redesign

**For the next session.** Everything below is established and agreed, ready to pick up from. Repo: `/home/dev/elicify-vertex` (OpenCode plugin, TypeScript, vitest, strict ESM). Branch `main` @ `5f99039`.

---

## What's already done and shipped (do not redo)

- Two full `/goal` cycles this session closed **every** item in `docs/CODE-ISSUES-FROM-PROMPT-AUDIT.md` (C-1 through C-16), including:
  - **Judge redesign** (`docs/JUDGE-PROMPT.md`): richer verdict shape (`fit/summary/gaps`), richer 5-field payload (adds real `lastResponse`/`recentTranscript` fetched via `client.session.messages`, not a synthetic summary), scanned for secrets *before* truncation.
  - **Subagent prompt injection** (`docs/SUBAGENT-INJECTION-DRAFT.md`, `src/v2/wiring/subagentInjection.ts`): a 460-word behavior preamble prepended to every `task` tool call. Built and UAT-tested but **never actually fired in a real session** (see below).
  - A new `elicify_vertex_plan_reopen` tool; a checkpoint fix so the plan's final story can't report "complete" with unresolved siblings (C-11); an activation-flap fix (C-14); a redaction/entropy fix (C-15); and a story-promotion fix (C-16, promotion now fires on any active-slot vacancy, not just `complete`).
- All of it is committed and pushed to `main`. Verified at handover: **1315/1315 unit+integration tests, 112/112 host-faithful UAT scenarios** (`scripts/uat-harness.mjs`), clean `tsc` + `build`.
- The current build is installed in this environment for testing: `opencode.json` points at `file:///home/dev/elicify-vertex/dist/plugin.js` (live, rebuild updates it — no reinstall needed). **Restart opencode** to pick up any new build.

## The problem we're now designing against (evidence, not conjecture)

A real 3h18m MiniMax-M3 session (`/workspace/vertextTest2`, session `ses_052ae33aaffe7nCYADyYPRFVUp`, 894 messages, 466 bash calls) surfaced the core defect, verified directly in this session:

- **All 5 stories ended `blocked`, 0 receipts minted, 0 acceptance items evidenced** — despite the work being **genuinely real**: I independently ran `make check` (892/892 tests pass) and spot-checked S1 and S5's specific acceptance criteria against real files; everything I checked held up. The work was done; the harness had no way to credit it.
- **Root cause:** every verifier invocation the model produced was piped into `tail` or chained with `; echo "exit=$?"` — the exact anti-pattern `hasReliableAggregateExit` correctly refuses. 19 identical "ambiguous exit" warnings, never corrected.
- **Second cause:** the model had to cite a real `receiptId` or `waiverSourceMessageId` to checkpoint, and fabricated plausible-sounding IDs 13 times in a row on S1 alone before giving up and just blocking everything with no evidence.
- **The completion judge never fired.** It's gated behind *every* story reaching `"complete"` via the deterministic gate first (`gate.ts`'s `appendJudgeCloseOut` returns early otherwise) — so the judge can never rescue a session that stalls on the deterministic gate, which is exactly the failure mode it exists for.
- **No subagents were ever used.** 0 `task` tool calls, 0 child sessions, 894 messages of purely serial work.
- **Confirmed architectural cause for the subagent gap:** `StoryEngine` has **no wave/multi-active concept at all** — exactly one story is `"active"` at a time, and `checkpoint` rejects completing any story that isn't the active one (`story.ts`, documented in its own comments). The agent prompt (`agents/elicify-vertex-agent.md`) claims it "plans multi-story implementation as parallel waves, fans out agents wave by wave" — a capability the engine does not actually have.

## Agreed redesign direction (confirmed across the last several turns)

1. **Remove the per-story receipt/waiver citation entirely.** No more `receiptId`/`waiverSourceMessageId` arguments blocking checkpoint.
2. **The judge becomes the sole arbiter of story/plan completion**, triggered at `session.idle` (same trigger point as today, not a new one).
3. **Judge gets real tools** — read / grep / glob / bash (to independently re-run verifiers itself, exactly as done by hand this session) — **no write/edit**. This reverses an earlier deliberate zero-tool security decision (`src/v2/subturn.ts`'s permission wildcard-deny); the user explicitly chose this.
4. **Judge output is structured, per-acceptance-item feedback** — which criteria are met, which aren't, what's specifically missing — not prose fit/summary.
5. **Acceptance criteria stay authored in the planning tool**, but as **functional/technical claims** (e.g. "`NormalizedTrace` model exists with fields X/Y/Z", "`make check` passes"), not tied to any citation mechanism.
6. **The planning engine gets real wave support** — multiple stories genuinely active at once within a wave, replacing the single-active-story constraint — and should actively encourage fan-out across a wave.
7. **Remove the current broad per-turn nagging** (`verify-gap` firing every turn regardless of relevance); keep a **lightweight, capped, deterministic nudge "only when justified"** instead.
8. **Continuations stay fully-visible chat messages** and get **constructive, per-story detail** ("story S2 not delivered — A3, A4 still missing") instead of generic reminders.
9. **Adopt from `opencode-goal-plugin`** (cloned to `/tmp/claude-1000/.../scratchpad/opencode-goal-plugin/`): task-blocking awareness (defer nudging while a delegated subagent is mid-delegation) and stall detection (`no_progress_token_threshold`/`max_no_progress_turns`). Note: that repo does **not** have a judge or acceptance-criteria-writing step — its whole completion model is self-report plus nagging; use it only for the continuation/watchdog machinery.

## Current state of the decision

- The full design (points 1-9) is agreed in conversation but **no spec exists yet** and **no implementation has started**.
- The user was asked whether to run this through `/plan-spec` first given the scope (touches plan data model, judge, idle gate, composer/findings, agent prompt) — **that question was not yet answered** when the handover was requested. It's the natural next decision.

## Two reference artifacts (still accessible)

- Directive-injection audit (elicify-vertex vs. fablize, every prompt + trigger + a 6-axis neutral comparison): https://claude.ai/code/artifact/266ab726-b1cb-4992-8cb6-f3d2fdd4997b
- Improvement design (5 prioritized, evidence-grounded findings from the MiniMax session): https://claude.ai/code/artifact/8296ab53-38ee-480c-a61d-5ce503c7c932

## Useful specifics for whoever picks this up

- Task-mode keyword classification (`classifyStopMode` in `src/index.ts`) is **the same regex as fablize's `classify_task.py`**, word for word (both ported from the same "fable-ish" experiment) — don't redesign it; it's a shared, largely solved problem.
- The promise-no-act deferral detector (`deferred` / `tracked` / Korean equivalents) already exists and is wired into v2's idle gate — already covered, no work needed there.
- fablize's own `PostToolUse` failure detector is prone to false positives on Edit calls touching error-handling code (regex matches `error:`/`failed` in file content) — observed live this session, worth knowing before treating fablize as a model to copy blindly.

---

*Written 2026-07-29, end of session, on explicit request. No uncommitted local state beyond what's already on `main`.*
