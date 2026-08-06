# Vertex 2 — Module Contracts (implementation-phase reference)

This document governs the **public surface** (exported types/classes/functions) of every
new v2 module so parallel dev agents produce compatible code without seeing each other's
work. It is a coordination aid, not a replacement for `docs/vertex2-spec.md` — for
behavior, edge cases, exact wording of log events, and acceptance criteria, the spec is
authoritative. Where this doc and the spec conflict, the spec wins and you should flag
the conflict in your final report rather than silently picking one.

> **Amended 2026-08-06 (backlog B-1, spec rev 4).** Two surfaces are **removed** from this
> contract: the whole of **§5 `src/v2/dosing.ts`** (the `standard`/`frontier` profile table,
> `resolveProfile`, `doseFor`, `dosingOverrides`, the `profile` event stamp and the
> `dosing:unknown-model` event), and `runVerifier`'s **`verifierModelOverride`** parameter
> with its fallback chain. The verifier runs on the session's model, always. Section numbers
> and identifiers are retained rather than renumbered — see `docs/vertex2-spec.md` §*Amendment
> — rev 4* for the measured evidence.

## Architecture decision: v1 stays untouched

`src/index.ts` (today's ~90KB file: `ElicifyVertexPlugin`, `EvidenceLedger`,
`DirectiveQueue`, `SessionGate`, `parseVerification`, `isMutatingBashCommand`,
`changedPathsFromTool`, `formatDirectives`, `formatGateContinuationText`, etc.) is
**frozen and must not be edited** by any v2 work. All 405 existing tests import from it
directly (`../src/index.js`) and must keep passing unmodified — this is the regression
floor (SC-008, SC-014).

Deviating from the spec's literal "index.ts becomes v2 wiring" text for regression
safety: all new v2 code lives under **`src/v2/`**:

```
src/v2/phase.ts
src/v2/composer.ts
src/v2/resolve.ts
src/v2/pin.ts
src/v2/story.ts
src/v2/artifacts.ts
src/v2/dosing.ts        (REMOVED 2026-08-06 — backlog B-1; see §5)
src/v2/verifier.ts
src/v2/subturn.ts
src/v2/plugin.ts        (wave 3 — wires the above into the v2 hook set)
```

`src/plugin.ts` (today's thin host entry) becomes the switch: reads `VERTEX_V2` env /
`engine` option, defaults to `src/v2/plugin.ts`'s export, and returns today's
`ElicifyVertexPlugin` from `src/index.ts` unchanged when `VERTEX_V2=0` /
`engine: "v1"` (FR-037). **You are not responsible for this switch** unless you are the
wave-3 wiring agent — everyone else just implements their module under `src/v2/`.

Test files for v2 go under **`tests/v2/*.test.ts`** (vitest picks up
`tests/**/*.test.ts` per `vitest.config.ts` — no config change needed). Do not touch
existing files under `tests/*.test.ts`.

## Reused v1 primitives (import, do not reimplement)

From `src/index.ts` (read-only imports — these are frozen, exercise them, don't modify):
- `parseVerification` — verifier output classification (US-3's resolver wraps this, doesn't replace it)
- `isMutatingBashCommand`, `changedPathsFromTool` — mutation/path detection
- `formatDirectives` — envelope formatting used by the composer's final render step

From `src/redaction.ts`:
- `redactSecrets(text: string): string`
- `redactForDisk(payload: unknown): unknown`

From `src/goals.ts` (pattern reference only — story.ts/pin.ts reimplement the pattern for
their own schema, they do not import goals.ts's classes):
- atomic write: `wx` temp file + rename, mode `0600`
- lock file with 30s staleness reclaim
- archive-on-replace (`archive/<name>.<timestamp>.json`, byte-identical, never deleted)

## Logging convention

Every module that emits measurement events takes an injected logger, never imports
`measurement.ts` directly (keeps modules testable without a real event sink):

```ts
type EventLogger = (eventType: string, payload: Record<string, unknown>) => void
```

The wave-3 wiring agent supplies the real logger (backed by the extended
`measurement.ts`). Your unit tests pass a `vi.fn()` and assert on calls.

---

## 1. `src/v2/phase.ts` — FR-001, FR-002

```ts
export type Phase = "intake" | "execute" | "elevate" | "close"

export interface PhaseTransitionEvent {
  sessionID: string
  storyId: string | null
  from: Phase
  to: Phase
  trigger: string   // e.g. "T1", "T3", "T7" — matches the FR-001 transition table row id
  ts: string         // ISO-8601
}

export class PhaseEngine {
  constructor(logger: EventLogger)

  /** T1: session activated + first user message. */
  activate(sessionID: string): void

  /** T2/T9: new user message. Resets phase to intake for every story under this session. Does NOT touch pins — that's pin.ts's job, called separately by wiring. */
  onUserMessage(sessionID: string): void

  /** T3 (intake->execute) and T6 (elevate->execute). storyId null when no active plan. */
  onMutation(sessionID: string, storyId: string | null): void

  /** T4/T5. coversFinalStory: true when no plan is active OR the passing verifier covers the plan's final story. */
  onVerifierOutcome(sessionID: string, storyId: string | null, opts: { success: boolean; coversFinalStory: boolean }): void

  /** T8: non-final story checkpoints complete; rebinds phase to execute for the next story. */
  onStoryAdvance(sessionID: string, fromStoryId: string, toStoryId: string): void

  /** T7. Returns true iff the session transitioned to close. */
  onIdle(sessionID: string, storyId: string | null, opts: { criteriaAllEvidenced: boolean; hasPins: boolean; unverifiedChangesExist: boolean }): boolean

  getPhase(sessionID: string, storyId?: string | null): Phase
  getTransitionLog(sessionID: string): readonly PhaseTransitionEvent[]
  reset(sessionID: string): void
}
```

Own tests 1, 2, 3 (unit) and the phase-only slice of 49 (per-story scoping —
`onMutation`/`onVerifierOutcome`/`onStoryAdvance` all take `storyId`, test that two
stories under one session have independent phases).

---

## 2. `src/v2/pin.ts` — FR-013, FR-013a

```ts
export interface Criterion {
  id: string              // "C1", "C2", ... stable per session
  text: string             // redacted before storage
  evidence: { receiptId: string } | { waiver: true; sourceMessageId: string } | null
}

export interface PinsFileEntry { criteria: Criterion[]; updatedAt: string }
export type PinsFile = Record<string /* sessionID */, PinsFileEntry>

export class PinStore {
  constructor(opts: { stateDir: string; logger: EventLogger })

  /** Pins new criteria (caps at 10, extras dropped + logs criteria:truncated). Replaces any prior pin set for the session (last CRITERIA block wins — caller passes the full new list). Persists (see disk-fallback behavior below). */
  pin(sessionID: string, criteriaTexts: string[]): Criterion[]

  get(sessionID: string): readonly Criterion[]

  attachEvidence(sessionID: string, criterionId: string, evidence: Criterion["evidence"]): void

  /** Explicit disk sync point — call after pin()/attachEvidence(). Swallows fs errors internally per FR-013's fallback state machine (memory fallback, pins:disk-fallback-memory / pins:disk-recovered / pins:disk-unavailable after 3 consecutive failures, then stop retrying for the session). Never throws. */
  persist(sessionID: string): void

  /** Hydrate from disk — used on session.compacted re-injection and cold start. */
  load(sessionID: string): void

  /** Drop entries >7 days old or belonging to an unknown session with no plan; delete the file when the last entry is dropped. Call from wiring on a cadence you choose (e.g. once per write) — document your choice in your final report. */
  gc(knownSessionIds: ReadonlySet<string>): void
}
```

Reuse the v1 lock pattern from `src/goals.ts` but implement your own — `pins.json` is
written under **the same directory lock** `story.ts` will use for `plan.json`
(`lockPath` derived from the state directory, not the plan file, 30s staleness). Since
wave 1 runs before `story.ts` exists, **export a standalone lock helper** other v2
modules can reuse:

```ts
/** Acquire the shared `.elicify-vertex/` directory lock. Reclaims a lock file older than 30s. Throws if held by a live writer. */
export function acquireStateLock(stateDir: string): { release(): void }
```

`story.ts` (wave 2) will import `acquireStateLock` from `pin.ts` rather than
reimplementing it — mention this in your final report so wave 2 knows it exists.

Own test 40 and the pins-lock portion of test 37 (concurrent write: second writer
sees the lock and throws; stale lock >30s is reclaimed; no partial file left).

---

## 3. `src/v2/artifacts.ts` — FR-012, FR-023, FR-024, FR-025, FR-026

```ts
export interface CriteriaBlock { criteria: string[]; truncated: boolean }
/** Fence-aware, case-insensitive `CRITERIA:` key, last-block-wins within the text. Returns null if no block found. */
export function parseCriteriaBlock(text: string): CriteriaBlock | null

export interface ExpectArtifact { text: string; declared: "low" | "med" | "high" | null }
/** Fence-aware, case-insensitive `EXPECT [confidence]:` single-line grammar. A standalone `CONFIDENCE:` line is NOT parsed (F-09 — retired grammar). Invalid confidence enum -> declared: null, text still captured. Empty/absent -> null. */
export function parseExpectArtifact(text: string): ExpectArtifact | null

export interface VerifierOutcomeSummary {
  success: boolean
  failureClass: string | null   // from a small versioned taxonomy you define (e.g. "assertion", "type-error", "timeout", "unknown")
  summaryLine: string            // one line, human-readable, no secrets (caller redacts before this if needed)
}

export interface CalibrationEvent { declared: "low" | "med" | "high" | null; observed: "pass" | "fail" }

/** FR-024/025/026: fail-open when expect is null (no comparison). Returns calibration always when expect is non-null; mismatch true only when expect predicted pass and outcome failed (or vice versa — see BDD "EXPECT mismatch"). */
export function compareExpectation(expect: ExpectArtifact | null, outcome: VerifierOutcomeSummary): { mismatch: boolean; calibration: CalibrationEvent | null }
```

Own tests 10, 11 and Dataset: Artifact parsing (all 11 rows, including the `6b`
`CONFIDENCE:`-alone row and the fence-false-positive row 11).

---

## 4. `src/v2/resolve.ts` — FR-008, FR-009, FR-010

```ts
export interface ResolutionResult {
  command: string | null      // null only for the "generic category list" degrade case
  rationale: "story" | "basename" | "fallback:package-script" | "none"
  matchedPaths: string[]       // paths this command actually covers (for the display cap / +N more logic — that's composer's job, not yours; just return the full list)
}

export interface Manifest { scripts: Record<string, string>; workspaceRoot?: string }

export interface ResolveContext {
  changedPaths: string[]        // already filtered to inside the worktree by the caller (row 10: outside-worktree paths never reach you)
  storyVerifiers: readonly string[] | null
}

export interface ResolveDeps {
  /** Cached per-turn by the caller — you may call this more than once per resolveVerifier call, caller is responsible for the cache, not you. */
  readManifest(): Manifest | null
  /** Optional bounded (<=250ms) fallback the caller may inject for ambiguous cases; omit in unit tests (fixture-driven, no real fs/subprocess). Never call this yourself without a caller-supplied cap — see FR-009. */
  fallbackProbe?: (globs: string[]) => string[]
}

/** Pure/injectable — no real fs or subprocess access inside this function. Tier order: story verifiers -> basename convention (*.test.*/*.spec.*) via manifest -> package-manifest scripts (nearest manifest wins in a monorepo, row 9) -> generic category list (rationale "none"). */
export function resolveVerifier(ctx: ResolveContext, deps: ResolveDeps): ResolutionResult
```

Own tests 8, 9 and Dataset: Narrowest-verifier resolution (all 10 rows, including the
monorepo nearest-manifest row 9 and the outside-worktree exclusion row 10).

---

## 5. ~~`src/v2/dosing.ts` — FR-028, FR-029~~ — **MODULE REMOVED (2026-08-06, backlog B-1)**

> **This module no longer exists.** The section number is kept so §6…§12 do not renumber and
> existing "see §5" references still land somewhere.
>
> Deleted exports — **do not reintroduce, and do not import**: `Profile`
> (`"standard" | "frontier"`), `DosingResolution`, `resolveProfile`, `DirectiveFamily`,
> `Dose`, `doseFor`, and `measurement.ts`'s `DosingProfile` type and the `profile` field on
> every event record. The `dosingOverrides` plugin option is deleted with them.
>
> **Replacement contract, in full:** the composer renders every directive family at its full
> form for every model. There is no model→behaviour mapping, so there is no module. See
> `docs/vertex2-spec.md` **FR-028R** (which replaces FR-028 and FR-029).
>
> **Why** (spec rev 4, and `docs/BACKLOG.md` B-1): the table had exactly two rows and
> `resolveProfile`'s match required `id === key || id.endsWith("/" + key)`. In the measured
> session of 2026-08-06 the live model id was `minimax-coding-plan/MiniMax-M3` and the key
> was `minimax/MiniMax-M3` — different provider segment, so the suffix match failed **138
> times**, each one logging `dosing:unknown-model`. The unmapped fallback is
> `{profile: "standard"}`, which is exactly what the matched row would have returned. Total
> observable effect: 138 log lines and one wrong `unknown: true` flag. Adding a
> `minimax-coding-plan/…` row was explicitly rejected — it keeps the machinery and buys
> nothing.
>
> ~~Own tests 16, 17 and Dataset: Dosing profiles (all 5 rows).~~ All removed.

---

## 6. `src/v2/composer.ts` — FR-003 through FR-007

```ts
export type Priority = "correction" | "phase-guidance" | "enrichment"

export interface Finding {
  family: string             // matches an FR-004 cap-table key when applicable
  priority: Priority
  observation: string         // real observed state — actual paths/commands, not a template
  diagnosis: string
  prescription: string
  example?: string
  instanceId: string          // caller-generated, unique per finding instance (for FR-034 compliance join)
}

export interface RenderResult {
  text: string | null          // null when nothing was injected this invocation (Dataset row 6: "empty -> silence")
  renderedFamilies: string[]
  dropped: Array<{ family: string; reason: "budget" | "per-turn-cap" | "cooldown" }>
}

export class InjectionComposer {
  constructor(opts: {
    logger: EventLogger
    /** Per-family per-turn cap table — default to the FR-004 table below if the caller passes none. */
    familyCaps?: Record<string, number>
    /** Per-family cooldownTurns — default 1 for every family not listed. */
    cooldowns?: Record<string, number>
  })

  /** Call once per chat.message (new user message). Increments the session's turn index; per-turn caps and pending-cooldown countdowns are keyed off this index, not wall clock. */
  newTurn(sessionID: string): void

  /**
   * One call = one experimental.chat.system.transform invocation. Enforces:
   *  - max 2 rendered directives THIS CALL (budget is per invocation, not per turn — FR-004)
   *  - priority order correction > phase-guidance > enrichment when trimming to the budget
   *  - each family's per-turn cap (FR-004 table) — a family that already spent its cap this turn is excluded from `findings` before budget trimming even runs
   *  - cooldownTurns suppression (FR-005) — a family rendered at turn T is excluded until turn T + cooldownTurns
   *  - decay (FR-006) — if `priorCompliance(finding.family)` is true (caller-supplied, from FR-034 join), render the one-line decay form instead of the full O-D-P-E grammar
   * Findings you drop for cap/cooldown/budget reasons are logged (`budget:dropped` etc. — exact event names are yours to define consistently, document them in your final report) and are NEVER carried into a later call — the caller must re-detect and re-pass them if still true.
   */
  render(sessionID: string, findings: readonly Finding[], opts: { priorCompliance: (family: string) => boolean }): RenderResult

  /** Called by wiring when FR-034 detects a compliance match. Feeds the next render()'s decay decision for that family/turn. */
  recordCompliance(sessionID: string, family: string, instanceId: string): void
}

export const DEFAULT_FAMILY_CAPS: Record<string, number> = {
  "intake-scaffold": 1, "plan-proposal": 1, "pre-commitment": 1,
  "scope-watchdog": 1, "anomaly-interrupt": 1, "repeat-failure": 1 /* per signature, caller keys the family string per-signature */,
  "verify-gap": 3, "elevate": 1, "pinned-criteria-reinject": 1,
}
```

Own tests 4, 5, 6, 7, 48 and Dataset: Composer budget/cooldown/decay (all 11 rows —
row 10/11 need FR-034 equivalence, which lives in `measurement.ts`/wiring, not here;
for your unit tests, stub `priorCompliance` directly rather than implementing
equivalence matching yourself).

---

## 7. `src/v2/subturn.ts` — FR-030b infra, FR-036, FR-038

This is shared infrastructure for **both** the verifier subturn (US-9) and the intake
classification subturn (US-5) — highest-leverage module to get right since two other
modules depend on it.

```ts
/** Process-lifetime registry of every session id the harness created (verifier/intake children), keyed also by parentID so a grandchild (if the host ever creates one) is still recognized. */
export class SelfCreatedSessions {
  record(sessionID: string, parentID: string | null): void
  isSelfCreated(sessionID: string, resolveParent: (id: string) => string | null): boolean
  // resolveParent lets the caller supply a lookup (from the OpenCode client) without this class owning client access
}

export interface CapabilityProbeResult { ok: boolean; reason?: string }

/**
 * FR-030b, run once per process per agent name. Registers nothing itself (the config
 * hook registration happens in wiring/plugin.ts, once, at plugin construction) — this
 * function only VERIFIES: reads back `client.app.agents()`, requires the named agent
 * exists, resolves zero tools to `true`, and has edit/bash/webfetch = "deny". On any
 * failure (agent absent, a tool resolves true, the call throws, or client.tool.ids()
 * was unavailable when the deny map was built) return {ok: false, reason}.
 */
export async function probeCapability(client: OpencodeClient, agentName: string): Promise<CapabilityProbeResult>

/** Builds the deny map from client.tool.ids() + a wildcard entry. Called once at plugin construction, cached by the caller. */
export async function buildDenyMap(client: OpencodeClient): Promise<Record<string, boolean>>

export interface SubturnRequest {
  parentSessionID: string
  agent: string                                    // "vertex-verifier" | "vertex-intake" — never opts.activeAgent
  model?: { providerID: string; modelID: string }   // omit to use host default for that agent
  system: string
  parts: Array<{ type: "text"; text: string }>
  tools: Record<string, boolean>                     // the deny map
  timeoutMs: number                                   // 5000 total including any caller-side retry
}

export type SubturnResult = { ok: true; text: string } | { ok: false; reason: string }

/**
 * session.create({parentID}) -> record in SelfCreatedSessions -> session.prompt raced
 * against timeoutMs -> session.delete in a finally block on EVERY exit path (success,
 * malformed, timeout, throw). A session.delete rejection logs subturn:cleanup-failed
 * via the injected logger and does NOT change the returned SubturnResult.
 */
export async function runSubturn(client: OpencodeClient, selfCreated: SelfCreatedSessions, logger: EventLogger, req: SubturnRequest): Promise<SubturnResult>
```

`OpencodeClient` — import the real type from `@opencode-ai/plugin`/`@opencode-ai/sdk`
(already a project dependency, check `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
for the exact shape of `session.create`, `session.prompt`, `session.delete`,
`tool.ids`, `app.agents` — the spec's Integration Boundaries section cites exact line
numbers in that file, use them). In your unit tests, stub the client (`vi.fn()` per
method) — do not spin up a real host.

Own test 44 (probe + refusal — assert exact deny map + `agent: "vertex-verifier"` on
success path, zero `session.create`/`session.prompt` calls + one `verifier:unsupported`
on probe failure) and test 47 (cleanup on all four exit paths, stub client).

**Note for wave-3 wiring**: `self_created_session_is_inert` (test 43) needs the REAL
hook set driven over a simulated child session, not a stub client — that test cannot
be written against this module alone and belongs to wave 3/4.

---

## 8. `src/v2/verifier.ts` — FR-030, FR-030a, FR-031, FR-032

Depends on `subturn.ts` (wave 1) — if wave 1 hasn't landed when you start, work from
this contract and integrate against the real file once it exists; do not block.

```ts
export interface VerifierPayload { criteria: string[]; diffSummary: string; verifierSummaries: string[] }

/**
 * FR-031: redactSecrets (src/redaction.ts) then the strict scan on EACH of the three
 * fields, applied to the reassembled field (not per-chunk). Strict scan = the
 * SECRET_PATTERNS already in src/redaction.ts, PLUS a Shannon-entropy rule: any
 * whitespace-delimited token >=32 chars with entropy >=4.0 bits/char is a secret. A
 * field that trips the scan has the offending hunk (diff) or line (criteria/verifier)
 * removed; if that empties the field, omit the field key entirely and log
 * verifier:field-dropped. Never include chat narrative — the caller passes you exactly
 * the three raw fields, nothing else, so there is no narrative to exclude here, but
 * assert this in your tests via the NARRATIVE_CANARY dataset row.
 */
export function buildVerifierPayload(raw: { criteria: string[]; diffSummary: string; verifierSummaries: string[] }, logger: EventLogger): VerifierPayload

export interface VerifierVerdict { fit: "pass" | "concern"; notes: string }

/**
 * Uses subturn.ts's probeCapability + runSubturn. The model is ALWAYS sessionModel —
 * the judge runs on the same model as the worker (FR-030a, rewritten 2026-08-06).
 * Exactly one model is attempted; there is no override parameter and no fallback
 * chain. Returns null on any failure (probe fail, timeout, malformed JSON, thrown
 * error) — caller logs verifier:unavailable/verifier:malformed/verifier:unsupported
 * based on which; you just return null and let the caller decide which reason (or
 * return a discriminated reason string alongside null — your call, document it in
 * your final report since wave 3 wiring needs to know exactly what you return).
 *
 * REMOVED 2026-08-06 (backlog B-1, review OBS-001): the `verifierModelOverride`
 * parameter and the "tried first if present, falling back to sessionModel on failure"
 * behaviour. The option was never set in any observed session, so the attempt list was
 * always [sessionModel] and the second entry was unreachable. Do not reintroduce the
 * parameter; `pauseJudge.ts` must not carry one either.
 */
export async function runVerifier(
  client: OpencodeClient,
  deps: { selfCreated: SelfCreatedSessions; logger: EventLogger },
  opts: { parentSessionID: string; sessionModel: { providerID: string; modelID: string }; payload: VerifierPayload }
): Promise<VerifierVerdict | null>
```

Own tests 18, 39 and Dataset: Verifier payload hygiene (all 9 rows — this is the module
most worth over-testing given CRIT-001/CRIT-002/MAJ-009 were the three critical/major
findings closest to this area in the fresh review).

---

## 9. `src/v2/story.ts` — FR-017–FR-022, FR-018/018a/018b, FR-021, FR-027 (story-side)

The biggest module. Wave 2 — depends on `pin.ts`'s `acquireStateLock` (wave 1),
`phase.ts` types (wave 1), `resolve.ts` (wave 1, for binding verifiers), `subturn.ts`
(wave 1, for the classification subturn). By the time you start, wave 1 is on disk —
read the real files, not just this contract.

```ts
export interface AcceptanceItem { id: string; text: string; evidence: { receiptId: string } | { waiver: true; sourceMessageId: string } | null }
export interface StoryV2 {
  id: string; text: string
  acceptanceItems: AcceptanceItem[]
  scopeGlobs: string[]
  verifiers: string[]
  assumptions: string[]
  rejectedAlternatives: string[]
  amendments: Array<{ reason: string; ts: string }>
  status: "pending" | "active" | "complete" | "blocked"
}
export interface PlanV2 { schemaVersion: 2; stories: StoryV2[]; finalStoryId: string; createdAt: string }

export class StoryEngine {
  constructor(opts: { stateDir: string; logger: EventLogger })

  /** FR-022: detect schemaVersion 1 goals.json, move (never copy+delete separately — atomic rename) to archive/goals.<ISO8601>.json byte-identical, never delete anything under archive/. Returns true if an archive happened. */
  archiveV1IfPresent(): boolean

  proposePlan(sessionID: string, stories: Array<{ text: string; acceptanceItems: string[] }>): { proposalText: string }
  createPlan(sessionID: string, confirmed: Array<{ text: string; acceptanceItems: string[]; scopeGlobs: string[]; verifiers: string[] }>): PlanV2
  getActiveStory(sessionID: string): StoryV2 | null
  getPlan(sessionID: string): PlanV2 | null

  /** FR-021: returns a Finding-shaped object (family "scope-watchdog") or null when the mutation is in scope. At most one per turn is the composer's job (per-turn cap table), not yours — always return a finding when out of scope, let the composer decide whether to render it. */
  checkScope(sessionID: string, mutatedPath: string): { family: "scope-watchdog"; offer: "fold" | "amend" | "revert"; scopeGlobsMatchedZero: boolean } | null

  /** FR-019/020: throws (with the criterion/item id in the message) when status="complete" and any acceptance item lacks valid evidence. A waiver is valid ONLY when evidence.waiver.sourceMessageId resolves to a real user message the caller attests to (caller passes waiver evidence already validated — you just enforce "some evidence exists", the user-message provenance check happens in wiring where message history is available). Final story additionally requires the receipt to be an OBSERVED receipt from this session's VerificationReceiptStore-equivalent (caller injects a `isValidReceipt(id): boolean` predicate). */
  checkpoint(sessionID: string, storyId: string, status: "complete" | "failed" | "blocked", opts: { isValidReceipt?: (receiptId: string) => boolean }): void

  // --- Intake classification (FR-018/018a/018b) ---
}

export const TRIVIAL_ASK_RE: RegExp   // exact pattern from FR-018a — copy verbatim from the spec, plus the Korean equivalents mentioned there
export const SEQUENCING_WORDS: RegExp  // exact pattern from FR-018, English + Korean
export const IMPERATIVE_VERBS: RegExp  // exact pattern from FR-018, English + Korean

/** Heuristic fallback only — used when the subturn fails/times out, per FR-018. */
export function classifyMultiStoryHeuristic(askText: string): boolean

export interface ClassifyResult { multiStory: boolean; source: "subturn" | "heuristic" | "skipped" }

/**
 * FR-018/018a/018b: skip (source "skipped", no client call) when askText matches
 * TRIVIAL_ASK_RE. Otherwise issue the classification subturn via subturn.ts's
 * runSubturn (agent "vertex-intake"); on failure/timeout within the 5s total budget,
 * fall back to classifyMultiStoryHeuristic and source "heuristic". Caller (wiring) is
 * responsible for the once-per-task and VERTEX_INTAKE_SUBTURN_MAX-per-session caps —
 * this function does one classification attempt per call, full stop; do not
 * self-throttle inside this module (the caps need session-lifetime state that lives
 * in wiring's ledger, not here) but DO respect the 5s total budget internally.
 */
export function classifyMultiStory(
  client: OpencodeClient,
  deps: { selfCreated: SelfCreatedSessions; logger: EventLogger },
  opts: { parentSessionID: string; sessionModel: { providerID: string; modelID: string }; askText: string }
): Promise<ClassifyResult>
```

Own tests 12, 13, 14, 15, 38 and Dataset: Checkpoint evidence validation (6 rows) +
Dataset: Intake pre-filter and classification heuristics (14 rows, stub the subturn
client for rows that would otherwise make a real call).

---

## measurement.ts extension — FR-033, FR-033a, FR-034, FR-035

**Extend, do not replace** `src/measurement.ts` (existing `logEvent`-style functions +
holdout-arm hashing stay; you're adding new event-type writers alongside them). New
exports (exact names your choice, but list them clearly in your final report so wave 3
wiring can call them):

- One writer per new event type: `directive_rendered`, `directive_complied`,
  `calibration`, `phase_transition`, `resolution:none`,
  ~~`dosing:unknown-model`~~ (**REMOVED** 2026-08-06 — backlog B-1),
  `gate:multi-session-advisory`, `pins:disk-fallback-memory` / `pins:disk-recovered` /
  `pins:disk-unavailable`, `intake:classify-skipped` / `-fallback` / `-capped` /
  `-unsupported`, `subturn:cleanup-failed`, `verifier:unavailable` / `verifier:malformed` /
  `verifier:unsupported` / `verifier:field-dropped`, `criteria:re-pinned` /
  `criteria:truncated`, `expect:absent`.
- Every writer accepts `{ sessionID, model, ...payload }` and stamps `model` (or
  `"unknown"`) on every record (FR-033 — this must hold even for event types that
  existed before v2). The model id is stamped **verbatim**: no suffix normalisation, no
  provider rewriting. **REMOVED 2026-08-06 (backlog B-1)**: the ~~`profile`~~ parameter,
  the `DosingProfile` type and the "defaulting to `standard` when v1's engine path is
  active" rule. Normalising the model id for a lookup is exactly what failed silently 138
  times; recording it raw is what made the failure visible.
- **FR-034**: `directive_complied` join — implement the verifier-equivalence check here
  (same resolver tier + same target path set, after stripping
  `IGNORED_VERIFIER_FLAGS = {--reporter=*, --reporters=*, -v, --verbose, --silent,
  --no-color, --color, --bail, --run, --watch=false}`). Expose it as a standalone
  function `verifiersEquivalent(rendered: string, observed: string, resolve: typeof resolveVerifier): boolean`
  so `composer.ts`'s caller (wiring) can call it without a circular import into
  `resolve.ts`.
- **FR-033a**: rotate the sink at 32MB to `events.<timestamp>.jsonl`; delete rotated
  files older than 30 days. Implement as a check-before-write in the existing append
  path.
- **FR-035**: extend the existing holdout-arm hashing (already keyed by session id) to
  also key by directive family, so a family can be independently in the `off` arm.

Own test 42 (property test over every FR-033 event type — use `fast-check` if already
a devDependency, else hand-roll a table-driven equivalent covering the same ground;
check `package.json` first) plus groundwork for tests 30/31 (full integration lands in
wave 4).

---

## Self-validation checklist (every wave-1/2 agent, before returning)

1. `npx tsc -p tsconfig.tests.json --noEmit` — zero errors touching your new files.
2. `npx vitest run tests/v2/<your-file>.test.ts` — your new tests pass.
3. `npx vitest run` (full suite) — **zero regressions** in the existing 405 tests. If
   this fails and the failure is not obviously caused by your change, say so explicitly
   in your final report rather than guessing.
4. Report: exported symbol list (in case it drifted from this contract — flag every
   deviation explicitly, don't let it be discovered later), which spec FRs/tests you
   covered, and any open question you couldn't resolve from the spec text.
