# Requirement: two-stage idle completion gate

Status: **OPEN — not implemented.** Raised 2026-07-28 from a live session.

## The requirement

When the model goes idle, the harness runs **deterministic validation first**.

1. **Deterministic stage.** Check the objective, machine-checkable facts — chief
   among them: *does the plan have stories that are not complete?*
   - **On failure**, inject a real chat message into the session that tells the
     model to continue. That message must be **constructive**: it names what is
     still open and what would close it, not merely "finish the job".
   - **On pass**, proceed to stage 2.
2. **Judge stage.** Only once every deterministic marker is satisfied does the
   LLM judge perform final validation of fit.

The ordering is the point. The judge is expensive, advisory and fallible; it must
not be asked "is this done?" while a machine can already answer "no, S2–S6 are
untouched". Equally, a deterministic pass is not sufficient on its own — that is
what the judge is for.

## What is implemented today

`handleSessionIdle` (`src/v2/wiring/gate.ts`) checks exactly three things:

1. `handlePromiseNoAct` — deferral language in the last assistant message
2. `handleCriteriaReplay` — pinned criteria carrying no valid evidence
3. `handleZeroCriteriaFallback` → `shouldBlockStop` — changed files with no
   verification

**Plan story completion is not a gate condition.** `getPlan()` appears in the
gate only inside `appendJudgeCloseOut`, where it decides whether the FINAL story
is complete and therefore whether the judge may run. The plan is read to
*permit* the judge, never to *demand* completion.

So stage 1 as specified does not exist, and stage 2 is gated on a condition
stage 1 was supposed to enforce.

## Evidence — the session that exposed it

Session `ses_0668b2422ffe…`, `/home/dev/vertextest`, 517 messages.

```
S1  active     Scaffold: Vite + React 19 + TypeScript + Tailwind v4 + shadcn
S2  pending    Sources management page
S3  pending    Tools + search page
S4  pending    Governance + audit page
S5  pending    Skills + approvals page
S6  pending    End-to-end UAT via Playwright        <- finalStoryId
```

Not one story was ever checkpointed. The session closed silently: at the moment
of idle there were no pinned criteria and no unverified changed files, so all
three existing checks passed and nothing consulted the plan. The judge then
never ran — correctly, per stage 2's own rule, because the final story was not
complete.

Event counts for that session (1,993 total) show the upstream cause of the
stories never becoming checkpointable:

| event | count |
|---|---|
| `verify:ambiguous-exit` | 28 |
| `verify:relevance-gap` | 4 |
| `per-turn-cap:dropped` | 1,313 |
| `directive_rendered` | 30 |
| `intake:unsupported` | 1 |

Note this is TWO independent defects. The 28 chained verifiers are fixed on the
current build. **The gate gap is not**: even with receipts minting perfectly, an
abandoned plan would still close silently, because no check looks at it.

## Acceptance criteria

- **AC-1** On idle with a plan present and any story not `complete`, a
  continuation is dispatched as a real `role:"user"` chat message.
- **AC-2** That message names, specifically: which stories are incomplete, their
  status, and for the active story what evidence would close it (its declared
  verifiers, and which acceptance items lack evidence). A generic "keep going"
  does not satisfy this.
- **AC-3** The judge does **not** run while any deterministic marker is
  unsatisfied.
- **AC-4** When every story is complete, the judge runs exactly as today.
- **AC-5** Blocking respects the existing `maxCriteriaBlocks` cap and the
  holdout/visibility rules, so it cannot trap a session in a loop.
- **AC-6** Mutation-verified: removing the story-completion check must turn a
  named test red, and a discrimination test must prove a fully-complete plan is
  NOT blocked.

## Open design questions

1. **Cap behaviour.** Should an abandoned plan block indefinitely, or
   warn-then-allow after `maxCriteriaBlocks` like the other gates? (Existing
   gates warn-then-allow — v1 parity.)
2. **Scope.** Does this apply when a plan exists but the user has explicitly
   moved on (e.g. a new unrelated request)? The scope watchdog may already have
   an opinion worth reusing.
3. **Wording ownership.** The constructive text belongs in
   `src/v2/wiring/findings.ts` alongside the other findings, so it is composed
   and capped like every other directive rather than hand-built at the gate.
