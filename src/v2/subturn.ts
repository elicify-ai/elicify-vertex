/**
 * Vertex 2 — shared child-session ("subturn") infrastructure.
 *
 * Used by BOTH the verifier subturn (US-9, `src/v2/verifier.ts`) and the intake
 * classification subturn (US-5, `src/v2/story.ts`). This is the module the
 * review round's two CRITICAL findings (CRIT-001, CRIT-002) lived closest
 * to, so the three pieces below are the security-relevant surface:
 *
 *  - `SelfCreatedSessions` — FR-036: every session id this harness creates
 *    must be recognizable so all five harness hooks can return early for it
 *    (the plugin must be inert to its own child sessions, or the verifier/
 *    intake subturn would receive the harness's own activation cue and
 *    directive block on top of its "evidence-only" payload).
 *  - `probeCapability` / `buildDenyMap` — FR-030b (review CRIT-002):
 *    `SessionPromptData.body.tools` is a per-tool-*name* allow/deny map with
 *    no documented deny-all flag, so "tool-calling disabled" cannot be
 *    asserted from that field's mere presence. The capability is
 *    *constructed* (zero-tool registered agent + enumerated deny map) and
 *    then *verified* by reading the resolution back — the probe's refusal
 *    path is the control, not the deny map itself (spec Open Question 1).
 *    HANDOVER.md point 3 (user decision, 2026-07-29): this zero-tool posture
 *    is DELIBERATELY REVERSED for the verifier only — `probeCapability` now
 *    takes an optional `ProbePolicy` (an allowlist of tool names permitted
 *    to resolve true, plus the permission keys that must still provably
 *    deny), and `VERIFIER_PROBE_POLICY` grants the verifier read/grep/glob/list/
 *    bash so it can independently re-run a story's declared verifiers (a
 *    real 894-message field session ended 5/5 stories blocked with the
 *    verifier never able to rescue it). The intake subturn keeps the default
 *    zero-tool policy unchanged; `buildDenyMap` is likewise untouched, with
 *    `buildToolPolicyMap` added alongside it for allow-aware maps.
 *  - `probeCapabilityBounded` — CRITICAL fix (post-review): `probeCapability`
 *    and `buildDenyMap` are plain, un-timed `await`s on their own. Both
 *    `verifier.ts`'s `runVerifier` and `story.ts`'s `classifyMultiStory` issue
 *    them BEFORE starting the FR-030 5s budget clock that only ever wrapped
 *    the later `runSubturn` call — so a hanging `client.app.agents()` /
 *    `client.tool.ids()` blocked the caller indefinitely, violating FR-030's
 *    literal "`Promise.race` 5s total including the retry." This helper
 *    races the probe+deny-map pair (as one sequential unit) against a
 *    caller-supplied budget so both call sites can share one implementation
 *    of the fix instead of each re-deriving the race independently.
 *  - `runSubturn` — FR-030/FR-038: one `session.prompt` raced against a
 *    caller-supplied timeout, with `session.delete` in a `finally` block on
 *    every exit path so a harness-created child session is never left
 *    behind as a user-visible artifact.
 *
 * Registration of the zero-tool agent(s) into `config.agent` happens once,
 * at plugin construction, in wave-3 wiring (`src/v2/plugin.ts`) — this
 * module never registers anything itself, it only builds the deny map and
 * verifies what got registered.
 */

import type { Agent } from "@opencode-ai/sdk"

import type { EventLogger, OpencodeClient } from "./types.js"

// ---------------------------------------------------------------------------
// Response-shape normalization
//
// The installed SDK (`@opencode-ai/sdk` 1.18.4, `dist/gen/client/types.gen.d.ts`
// `RequestResult`) resolves client calls to `{ data, error, request, response }`
// by default (`responseStyle: "fields"`, `throwOnError: false`) — `data` is
// `undefined` and `error` carries the failure when the call did not succeed.
// v1's only client call site (`src/index.ts`'s `attemptGateContinuation`,
// `client.session.prompt(...)`) never unwraps this shape (it awaits and
// discards the resolved value, relying on rejection alone), so there is no
// existing in-repo precedent to follow. Rather than assume one specific
// shape — which would silently swallow a real host's `error` field, or
// crash against a plain stubbed value — every client-call result observed
// in this module is passed through `unwrap`, which accepts both the SDK's
// `{ data, error }` fields-style result (throwing on a populated `error`,
// per the SDK's documented failure shape) and a bare value (as v1's own
// test stubs already return, e.g. `vi.fn(async () => ({}))`).
// ---------------------------------------------------------------------------

interface FieldsStyleResult {
  data?: unknown
  error?: unknown
}

function isFieldsStyleResult(value: unknown): value is FieldsStyleResult {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("data" in value || "error" in value)
  )
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Normalize a resolved client-call result to its payload, throwing if the
 * SDK's fields-style result carries a populated `error`. Accepts a bare
 * value unchanged (see header comment).
 */
function unwrap<T>(result: unknown): T {
  if (isFieldsStyleResult(result)) {
    if (result.error !== undefined) {
      throw new Error(describeError(result.error))
    }
    return result.data as T
  }
  return result as T
}

// ---------------------------------------------------------------------------
// SelfCreatedSessions — FR-036
// ---------------------------------------------------------------------------

/**
 * Process-lifetime registry of every session id the harness itself created
 * (verifier/intake children). Generalises v1's narrower `gateContinuationSessions`
 * set (`src/index.ts`, consumed once per continuation) into a durable
 * membership check every harness hook consults for its whole lifetime.
 *
 * FR-036 also requires recognizing "a session ... whose parentID resolves to
 * a session already in it" — i.e. not just direct children, but a
 * grandchild the host might create off an already-recorded child. This
 * class does not itself hold a reference to the OpenCode client (module
 * contract: "resolveParent lets the caller supply a lookup ... without this
 * class owning client access"), so `isSelfCreated` takes the parent-lookup
 * function as a parameter and walks the parent chain (bounded by a
 * visited-set to tolerate any accidental cycle) rather than only checking
 * one hop — a strict superset of the single-hop wording that still holds if
 * the host ever chains subagents more than one level deep.
 */
export class SelfCreatedSessions {
  private readonly ids = new Set<string>()

  record(sessionID: string, parentID: string | null): void {
    this.ids.add(sessionID)
    // parentID is accepted per the contract (mirrors "keyed also by
    // parentID") but membership is resolved via the caller-supplied
    // resolveParent lookup in isSelfCreated, not stored separately here —
    // storing our own parent index would risk drifting from whatever the
    // OpenCode host considers a session's parent at check time.
    void parentID
  }

  isSelfCreated(sessionID: string, resolveParent: (id: string) => string | null): boolean {
    const visited = new Set<string>()
    let current: string | null = sessionID
    while (current !== null && !visited.has(current)) {
      if (this.ids.has(current)) return true
      visited.add(current)
      current = resolveParent(current)
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Capability probe — FR-030b (review CRIT-002)
// ---------------------------------------------------------------------------

export interface CapabilityProbeResult {
  ok: boolean
  reason?: string
}

/**
 * HANDOVER.md point 3 (user decision, 2026-07-29): the probe's capability
 * contract is now parameterized per agent. The DEFAULT (no policy supplied)
 * reproduces the original FR-030b zero-tool behavior exactly — zero enabled
 * tools, edit/bash/webfetch provably denied — so the intake subturn is
 * unaffected. A supplied policy relaxes it in exactly two dimensions, both
 * still verified by reading the host's resolution back (the probe remains
 * the control of record; the maps are not).
 */
export interface ProbePolicy {
  /** Tool names allowed to resolve true. Default [] (zero-tool, today's behavior). */
  allowTools?: string[]
  /** Permission keys that must be provably "deny". Default ["edit","bash","webfetch"] (today's behavior). */
  denyPermissions?: string[]
}

/**
 * The verifier's policy under the HANDOVER.md point-3 reversal: read-only
 * inspection tools (read/grep/glob/list) plus bash — bash so the verifier can
 * independently re-run a story's declared verifier commands rather than
 * trusting the transcript (the field session's core failure: claims were
 * real but unverifiable by the harness). Still hard-denied: edit and write
 * (the verifier must never modify the work it audits), webfetch (no network),
 * and task (no sub-subagents — the verifier is a leaf).
 */
export const VERIFIER_PROBE_POLICY: ProbePolicy = {
  allowTools: ["read", "grep", "glob", "list", "bash"],
  denyPermissions: ["edit", "write", "webfetch", "task"],
}

/**
 * Builds the deny map from `client.tool.ids()` (`GET /experimental/tool/ids`,
 * `types.gen.d.ts:1705`/`1215` — returns `Array<string>`) plus a `"*": false`
 * wildcard entry for hosts that honour one. Called once at plugin
 * construction; the caller (wave-3 wiring) caches the result and uses it
 * both to populate `config.agent["vertex-verifier"].tools` / `["vertex-intake"]`
 * at registration and as the `tools` value on every `session.prompt` call.
 *
 * Enumeration failure (the SDK throws, or the fields-style result carries an
 * `error`) is NOT swallowed here — it propagates so the caller can treat
 * "deny map could not be built" as an immediate `verifier:unsupported` /
 * `intake:unsupported` condition without ever registering an agent whose
 * tools resolution is unknown. This is also why `probeCapability` below
 * does not re-call `client.tool.ids()` itself: if the deny map was built
 * incomplete because tool enumeration failed, the resulting agent
 * registration would resolve at least one un-enumerated tool to `true`,
 * which `probeCapability`'s "zero tools resolve to true" check already
 * catches on read-back — the two functions compose to cover FR-030b step 4's
 * full failure list without duplicating the tool.ids() call.
 */
export async function buildDenyMap(client: OpencodeClient): Promise<Record<string, boolean>> {
  const ids = unwrap<string[]>(await client.tool.ids())
  if (!Array.isArray(ids)) {
    throw new Error("client.tool.ids() did not return an array")
  }
  const denyMap: Record<string, boolean> = {}
  for (const id of ids) {
    denyMap[id] = false
  }
  denyMap["*"] = false
  return denyMap
}

/**
 * HANDOVER.md point 3: the allow-aware counterpart of `buildDenyMap`, used
 * for the verifier's subturn `tools` field and registration. Every enumerated
 * tool id maps to false EXCEPT the allowlisted names, which map to true;
 * `"*": false` is kept so a host that honours the wildcard still denies
 * anything un-enumerated. An allowlisted name the host did not enumerate is
 * still named true (harmless on a host lacking that tool; keeps the map
 * self-describing against `KNOWN_TOOL_NAMES`-style static maps). Same
 * failure contract as `buildDenyMap`: enumeration failure propagates, never
 * a silently partial map.
 */
export async function buildToolPolicyMap(client: OpencodeClient, allowTools: string[]): Promise<Record<string, boolean>> {
  const ids = unwrap<string[]>(await client.tool.ids())
  if (!Array.isArray(ids)) {
    throw new Error("client.tool.ids() did not return an array")
  }
  const allow = new Set(allowTools)
  const map: Record<string, boolean> = {}
  for (const id of ids) {
    map[id] = allow.has(id)
  }
  for (const name of allowTools) {
    if (!(name in map)) map[name] = true
  }
  map["*"] = false
  return map
}

const DENY_REQUIRED_PERMISSIONS = ["edit", "bash", "webfetch"] as const

/**
 * Live-host correction (post-review, confirmed via `opencode debug agent
 * <name>` against a running host): `Agent.permission` does NOT resolve to
 * the flat `{edit, bash: {[cmd]: ...}, webfetch, ...}` shape documented in
 * the bundled `@opencode-ai/sdk` `types.gen.d.ts` (`Agent.permission`,
 * ~L1407). The live host instead resolves it to a flat ARRAY of merged rule
 * objects — `Array<{ permission: string; action: "allow"|"ask"|"deny";
 * pattern: string }>` — one entry per (permission-category, pattern) rule
 * across every config layer (global defaults, project config, this agent's
 * own `AGENT_PERMISSION` registration), e.g.
 * `{ permission: "edit", action: "deny", pattern: "*" }`. Indexing this
 * array with `permission["edit"]` (the old flat-object assumption) reads
 * `undefined` for every key — the exact "permission.edit is undefined,
 * expected deny" failure reason observed in real intake/verifier probe events.
 *
 * This function accepts BOTH shapes defensively (the array shape is what a
 * live host actually returns today; the flat-object shape stays supported
 * in case a future/other host version matches the documented SDK type) — it
 * is intentionally not narrowed to "array only".
 *
 * Array-shape evaluation: collect every rule whose `permission` field
 * equals `key` (generic `permission: "*"` catch-all rules do NOT count —
 * only rules naming `key` specifically). Denied requires at least one such
 * rule AND every one of them has `action === "deny"`. This does not attempt
 * full glob/pattern precedence resolution (e.g. a `pattern`-scoped
 * exception overriding a `pattern: "*"` rule) — for `edit`/`bash`/
 * `webfetch` specifically, this repo's own registration
 * (`wiring/config.ts`'s `AGENT_PERMISSION`) only ever emits a single
 * `pattern: "*"` rule per key, so "every named-key rule is deny" is exactly
 * as strict as full precedence resolution would be for the shapes this
 * function is actually asked to verify; requiring ALL (not "any") is the
 * fail-closed choice if a host ever surfaces more than one.
 */
function permissionDenied(permission: unknown, key: string): { denied: boolean; detail: string } {
  if (Array.isArray(permission)) {
    const rules = permission.filter(
      (rule): rule is { permission: string; action: string; pattern?: string } =>
        !!rule && typeof rule === "object" && (rule as { permission?: unknown }).permission === key,
    )
    if (rules.length === 0) {
      return { denied: false, detail: `no rule for permission "${key}" is present` }
    }
    const notDenied = rules.find((rule) => rule.action !== "deny")
    if (notDenied) {
      return { denied: false, detail: `rule ${JSON.stringify(notDenied)} is not "deny"` }
    }
    return { denied: true, detail: "" }
  }

  if (permission && typeof permission === "object") {
    const value = (permission as Record<string, unknown>)[key]
    if (value === "deny") return { denied: true, detail: "" }
    if (value && typeof value === "object") {
      // bash-shaped: {[command]: "ask"|"allow"|"deny"}
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length === 0) {
        return { denied: false, detail: `"${key}" resolved to no entries (cannot confirm deny-all)` }
      }
      const notDenied = entries.find(([, v]) => v !== "deny")
      if (notDenied) {
        return { denied: false, detail: `"${key}[${notDenied[0]}]" is "${String(notDenied[1])}"` }
      }
      return { denied: true, detail: "" }
    }
    return { denied: false, detail: `"${key}" is "${String(value)}"` }
  }

  return { denied: false, detail: "permission block has neither array nor object shape" }
}

/**
 * FR-030b step 4: run once per process per agent name, AFTER registration
 * (which happens in wave-3 wiring, not here). Reads back the resolved
 * agents via `client.app.agents()` (`GET /agent`, `types.gen.d.ts:1399-1428`
 * — each `Agent` carries a resolved `tools: {[id]: boolean}` map and a
 * `permission` block, see `permissionDenied` above for its real live-host
 * shape) and requires:
 *  - the named agent exists,
 *  - NO tool outside `policy.allowTools` resolves to `true` (default policy:
 *    empty allowlist, i.e. the original "zero tools resolve to true" check).
 *    Enabled ALLOWLISTED tools are fine, and their absence is NOT an error —
 *    host differences (a build without `list`, say) degrade gracefully; the
 *    probe guards against unexpected capability, not missing capability.
 *  - every key in `policy.denyPermissions` (default edit/bash/webfetch) is
 *    provably denied per `permissionDenied` above.
 *
 * Registers nothing itself. Any failure — agent absent, a non-allowlisted
 * tool resolving `true`, a deny-permission not provably `"deny"`,
 * `client.app.agents()` throwing, or the fields-style result carrying an
 * `error` — returns `{ ok: false, reason }` with a specific, non-generic
 * reason string (SC-017 / FR-030b: callers log this reason verbatim under
 * `verifier:unsupported` / `intake:unsupported`).
 */
export async function probeCapability(
  client: OpencodeClient,
  agentName: string,
  policy?: ProbePolicy,
): Promise<CapabilityProbeResult> {
  const allowTools = new Set(policy?.allowTools ?? [])
  const denyPermissions = policy?.denyPermissions ?? DENY_REQUIRED_PERMISSIONS

  let agents: Agent[]
  try {
    agents = unwrap<Agent[]>(await client.app.agents())
  } catch (err) {
    return { ok: false, reason: `client.app.agents() failed: ${describeError(err)}` }
  }
  if (!Array.isArray(agents)) {
    return { ok: false, reason: "client.app.agents() did not return an array" }
  }

  const agent = agents.find((a) => a && a.name === agentName)
  if (!agent) {
    return {
      ok: false,
      reason: `agent "${agentName}" is not present in client.app.agents()`,
    }
  }

  const tools = agent.tools ?? {}
  const enabledTool = Object.entries(tools).find(([name, enabled]) => enabled === true && !allowTools.has(name))
  if (enabledTool) {
    // Default-policy message preserved verbatim (intake's wording, and the
    // string existing failure logs/tests match on); the allowlist variant
    // names both the offending tool and the policy it violated.
    return {
      ok: false,
      reason:
        allowTools.size === 0
          ? `agent "${agentName}" resolves tool "${enabledTool[0]}" to true (expected zero enabled tools)`
          : `agent "${agentName}" resolves tool "${enabledTool[0]}" to true outside the allowlist [${[...allowTools].join(", ")}]`,
    }
  }

  const permission: unknown = agent.permission
  if (!permission) {
    return { ok: false, reason: `agent "${agentName}" has no resolved permission block` }
  }

  for (const key of denyPermissions) {
    const result = permissionDenied(permission, key)
    if (!result.denied) {
      return {
        ok: false,
        reason: `agent "${agentName}" permission.${key} is not provably "deny" (${result.detail})`,
      }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// probeCapabilityBounded — CRITICAL fix: probeCapability + buildDenyMap
// raced against a caller-supplied budget (see module header note).
// ---------------------------------------------------------------------------

export type CapabilityProbeBoundedResult =
  | { ok: true; tools: Record<string, boolean> }
  | { ok: false; cause: "probe" | "deny-map" | "timeout"; reason: string }

const CAPABILITY_PROBE_BOUNDED_TIMEOUT_MESSAGE = "vertex:capability-probe-timeout"

/**
 * Shared by `verifier.ts` (`runVerifier`) and `story.ts` (`classifyMultiStory`):
 * both callers run `probeCapability` then, on success, `buildDenyMap` before
 * ever issuing a subturn, and both are meant to share ONE 5s-total budget
 * with the subturn attempt(s) that follow (FR-030). Runs the two calls as
 * one sequential unit (a passing probe is useless without the deny map that
 * hands the subturn its `tools` value) raced against `budgetMs` — the caller
 * starts its own budget clock BEFORE calling this and passes the full
 * remaining budget in, so elapsed probe/deny-map time is deducted from what
 * is left for the subturn attempt(s).
 *
 * Never rejects. Resolves `{ ok: true, tools }` (the `buildDenyMap` result,
 * or — when a `policy` is supplied (HANDOVER.md point 3) — the allow-aware
 * `buildToolPolicyMap` result for that policy's allowlist) on success, or
 * `{ ok: false, cause, reason }` on failure:
 *  - `cause: "probe"` — `probeCapability` returned `{ ok: false }` (or,
 *    defensively, threw — not documented to, but not assumed to hold
 *    forever either).
 *  - `cause: "deny-map"` — the probe passed but the map build (`buildDenyMap`
 *    / `buildToolPolicyMap`) threw/rejected (its own documented failure
 *    mode).
 *  - `cause: "timeout"` — `budgetMs` elapsed before either step settled.
 *    Callers MUST treat this the same as `cause: "probe"` (e.g. verifier.ts's
 *    `verifier:unsupported` path) — a probe that cannot be confirmed in time is
 *    exactly as unusable as one actively refused.
 */
export async function probeCapabilityBounded(
  client: OpencodeClient,
  agentName: string,
  budgetMs: number,
  policy?: ProbePolicy,
): Promise<CapabilityProbeBoundedResult> {
  const work = (async (): Promise<CapabilityProbeBoundedResult> => {
    let probe: CapabilityProbeResult
    try {
      probe = await probeCapability(client, agentName, policy)
    } catch (err) {
      return { ok: false, cause: "probe", reason: `probeCapability threw: ${describeError(err)}` }
    }
    if (!probe.ok) {
      return { ok: false, cause: "probe", reason: probe.reason ?? "capability probe failed" }
    }
    try {
      const tools = policy ? await buildToolPolicyMap(client, policy.allowTools ?? []) : await buildDenyMap(client)
      return { ok: true, tools }
    } catch (err) {
      return { ok: false, cause: "deny-map", reason: describeError(err) }
    }
  })()

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(CAPABILITY_PROBE_BOUNDED_TIMEOUT_MESSAGE)), budgetMs)
    })
    return await Promise.race([work, timeoutPromise])
  } catch (err) {
    if (err instanceof Error && err.message === CAPABILITY_PROBE_BOUNDED_TIMEOUT_MESSAGE) {
      return { ok: false, cause: "timeout", reason: "capability probe (probe + deny map) timed out" }
    }
    // `work` never rejects (both awaits inside it are individually
    // try/caught above) — this branch is unreachable in practice, kept only
    // as a defensive fallback should that internal contract ever change.
    return { ok: false, cause: "probe", reason: `capability probe failed unexpectedly: ${describeError(err)}` }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

// ---------------------------------------------------------------------------
// runSubturn — FR-030, FR-038
// ---------------------------------------------------------------------------

export interface SubturnRequest {
  parentSessionID: string
  /** "vertex-verifier" | "vertex-intake" — never `opts.activeAgent` (FR-036). */
  agent: string
  /** Omit to use the host's configured default model for that agent. */
  model?: { providerID: string; modelID: string }
  system: string
  parts: Array<{ type: "text"; text: string }>
  /** The tool map from `buildDenyMap` (zero-tool agents) or `buildToolPolicyMap` (verifier, HANDOVER.md point 3). */
  tools: Record<string, boolean>
  /** Total budget for THIS attempt, including no further retry inside this call — the caller owns any retry-and-resubmit policy (FR-030a). */
  timeoutMs: number
}

export type SubturnResult =
  | { ok: true; text: string; observedToolCall?: boolean }
  | { ok: false; reason: string; observedToolCall?: boolean }

/**
 * FR-014 (code review MAJ-004): did the child session make at least one tool
 * call before answering?
 *
 * This MUST be read inside `runSubturn`, because its `finally` AWAITS
 * `deleteChildSession` before returning — by the time a caller sees the
 * result the session is gone, so a caller-side read always degrades to
 * "cannot tell" and the tool-call floor never fires against a real host.
 * That is exactly the defect the code review found: the passing test only
 * worked because its stub kept serving parts after `session.delete`.
 *
 * Returns `undefined` (not `false`) when the parts cannot be read, so the
 * caller can distinguish "the verifier did not look" from "we could not tell"
 * and fail open on the latter.
 */
/** CR-14: cap on the observed-tool-call read (see its call site). */
const OBSERVED_READ_TIMEOUT_MS = 5_000

/** Resolve to `undefined` rather than hang. Never rejects. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let handle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        handle = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

async function readObservedToolCall(client: OpencodeClient, childID: string): Promise<boolean | undefined> {
  try {
    const raw = await client.session.messages({ path: { id: childID } } as never)
    const list = isFieldsStyleResult(raw) ? raw.data : raw
    if (!Array.isArray(list)) return undefined
    let sawAnyPart = false
    for (const entry of list as Array<{ parts?: Array<{ type?: string }> }>) {
      for (const part of entry.parts ?? []) {
        sawAnyPart = true
        if (part?.type === "tool") return true
      }
    }
    return sawAnyPart ? false : undefined
  } catch {
    return undefined
  }
}

const SUBTURN_TIMEOUT_MESSAGE = "vertex:subturn-timeout"
/** Internal-only title for harness-created child sessions; not part of the public contract. */
const SUBTURN_SESSION_TITLE = "elicify-vertex subturn"

type CreateChildResult = { ok: true; sessionID: string } | { ok: false; reason: string }

async function createChildSession(
  client: OpencodeClient,
  parentSessionID: string,
): Promise<CreateChildResult> {
  try {
    const session = unwrap<{ id?: string } | undefined>(
      await client.session.create({
        body: { parentID: parentSessionID, title: SUBTURN_SESSION_TITLE },
      }),
    )
    if (!session || typeof session.id !== "string" || session.id.length === 0) {
      return { ok: false, reason: "session.create returned no session id" }
    }
    return { ok: true, sessionID: session.id }
  } catch (err) {
    return { ok: false, reason: `session.create failed: ${describeError(err)}` }
  }
}

function extractText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null
  const parts = (response as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return null
  const texts: string[] = []
  for (const part of parts) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      texts.push((part as { text: string }).text)
    }
  }
  if (texts.length === 0) return null
  return texts.join("\n")
}

async function promptChildSession(
  client: OpencodeClient,
  childID: string,
  req: SubturnRequest,
): Promise<SubturnResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(SUBTURN_TIMEOUT_MESSAGE)), req.timeoutMs)
    })
    const raw = await Promise.race([
      client.session.prompt({
        path: { id: childID },
        body: {
          ...(req.model ? { model: req.model } : {}),
          agent: req.agent,
          system: req.system,
          tools: req.tools,
          parts: req.parts,
        },
      }),
      timeoutPromise,
    ])
    const unwrapped = unwrap<unknown>(raw)
    const text = extractText(unwrapped)
    if (text === null) {
      return { ok: false, reason: "malformed subturn response: no text part found" }
    }
    return { ok: true, text }
  } catch (err) {
    if (err instanceof Error && err.message === SUBTURN_TIMEOUT_MESSAGE) {
      return { ok: false, reason: "timeout" }
    }
    return { ok: false, reason: `subturn failed: ${describeError(err)}` }
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

async function deleteChildSession(
  client: OpencodeClient,
  childID: string,
  logger: EventLogger,
): Promise<void> {
  try {
    unwrap<unknown>(await client.session.delete({ path: { id: childID } }))
  } catch (err) {
    // FR-038: a deletion failure is logged and MUST NOT affect the caller's
    // SubturnResult — this function's return type is void, so there is
    // nothing for a caller to observe here besides the log event.
    logger("subturn:cleanup-failed", { sessionID: childID, reason: describeError(err) })
  }
}

/**
 * `session.create({parentID})` -> immediately record the child in
 * `selfCreated` -> `session.prompt` raced against `req.timeoutMs` ->
 * `session.delete` in a `finally` block on EVERY exit path (success,
 * malformed response, timeout, thrown error). A `session.delete` rejection
 * is logged via `subturn:cleanup-failed` and never changes the returned
 * `SubturnResult` (FR-038).
 *
 * Does NOT call `probeCapability` — that is the caller's (verifier.ts /
 * story.ts) responsibility to run first and decide whether to call this
 * function at all (module contract test 44: a failed probe must produce
 * zero `session.create`/`session.prompt` calls, which requires the caller
 * to short-circuit before ever reaching `runSubturn`).
 */
export async function runSubturn(
  client: OpencodeClient,
  selfCreated: SelfCreatedSessions,
  logger: EventLogger,
  req: SubturnRequest,
): Promise<SubturnResult> {
  const created = await createChildSession(client, req.parentSessionID)
  if (!created.ok) {
    return created
  }
  const childID = created.sessionID
  selfCreated.record(childID, req.parentSessionID)

  try {
    const result = await promptChildSession(client, childID, req)
    // FR-014: read the tool-call fact BEFORE the `finally` deletes the child.
    // CR-14 (round 5): this await sits on the `session.idle` path and had no
    // bound of its own — a host whose `session.messages` hangs stalled the
    // whole idle handler. The FR-014 floor already treats `undefined` as
    // "could not tell" and fails open, so a timeout degrades to exactly the
    // pre-existing unreadable-session behaviour.
    const observedToolCall = await withTimeout(readObservedToolCall(client, childID), OBSERVED_READ_TIMEOUT_MS)
    return observedToolCall === undefined ? result : { ...result, observedToolCall }
  } finally {
    await deleteChildSession(client, childID, logger)
  }
}
