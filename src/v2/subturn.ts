/**
 * Vertex 2 — shared child-session ("subturn") infrastructure.
 *
 * Used by BOTH the judge subturn (US-9, `src/v2/judge.ts`) and the intake
 * classification subturn (US-5, `src/v2/story.ts`). This is the module the
 * review round's two CRITICAL findings (CRIT-001, CRIT-002) lived closest
 * to, so the three pieces below are the security-relevant surface:
 *
 *  - `SelfCreatedSessions` — FR-036: every session id this harness creates
 *    must be recognizable so all five harness hooks can return early for it
 *    (the plugin must be inert to its own child sessions, or the judge/
 *    intake subturn would receive the harness's own activation cue and
 *    directive block on top of its "evidence-only" payload).
 *  - `probeCapability` / `buildDenyMap` — FR-030b (review CRIT-002):
 *    `SessionPromptData.body.tools` is a per-tool-*name* allow/deny map with
 *    no documented deny-all flag, so "tool-calling disabled" cannot be
 *    asserted from that field's mere presence. The capability is
 *    *constructed* (zero-tool registered agent + enumerated deny map) and
 *    then *verified* by reading the resolution back — the probe's refusal
 *    path is the control, not the deny map itself (spec Open Question 1).
 *  - `probeCapabilityBounded` — CRITICAL fix (post-review): `probeCapability`
 *    and `buildDenyMap` are plain, un-timed `await`s on their own. Both
 *    `judge.ts`'s `runJudge` and `story.ts`'s `classifyMultiStory` issue
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
 * (judge/intake children). Generalises v1's narrower `gateContinuationSessions`
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
 * Builds the deny map from `client.tool.ids()` (`GET /experimental/tool/ids`,
 * `types.gen.d.ts:1705`/`1215` — returns `Array<string>`) plus a `"*": false`
 * wildcard entry for hosts that honour one. Called once at plugin
 * construction; the caller (wave-3 wiring) caches the result and uses it
 * both to populate `config.agent["vertex-judge"].tools` / `["vertex-intake"]`
 * at registration and as the `tools` value on every `session.prompt` call.
 *
 * Enumeration failure (the SDK throws, or the fields-style result carries an
 * `error`) is NOT swallowed here — it propagates so the caller can treat
 * "deny map could not be built" as an immediate `judge:unsupported` /
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

const DENY_REQUIRED_PERMISSIONS = ["edit", "webfetch"] as const

/**
 * FR-030b step 4: run once per process per agent name, AFTER registration
 * (which happens in wave-3 wiring, not here). Reads back the resolved
 * agents via `client.app.agents()` (`GET /agent`, `types.gen.d.ts:1399-1428`
 * — each `Agent` carries a resolved `tools: {[id]: boolean}` map and a
 * `permission` block) and requires:
 *  - the named agent exists,
 *  - it resolves ZERO tools to `true`,
 *  - `permission.edit` and `permission.webfetch` are exactly `"deny"`,
 *  - `permission.bash` (resolved on `Agent`, unlike the raw `AgentConfig`
 *    input, ALWAYS as a `{[command]: "ask"|"allow"|"deny"}` map rather than
 *    a bare string — `types.gen.d.ts:1407-1415`) has at least one entry and
 *    every entry is `"deny"`. An empty bash permission map is treated as a
 *    failure (fail-closed): a live host was not exercised in this spec's
 *    authoring session (Open Question 1), so an empty/unproven map must not
 *    be read as "no bash access."
 *
 * Registers nothing itself. Any failure — agent absent, a tool resolving
 * `true`, a permission not `"deny"`, `client.app.agents()` throwing, or the
 * fields-style result carrying an `error` — returns `{ ok: false, reason }`
 * with a specific, non-generic reason string (SC-017 / FR-030b: callers log
 * this reason verbatim under `judge:unsupported` / `intake:unsupported`).
 */
export async function probeCapability(
  client: OpencodeClient,
  agentName: string,
): Promise<CapabilityProbeResult> {
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
  const enabledTool = Object.entries(tools).find(([, enabled]) => enabled === true)
  if (enabledTool) {
    return {
      ok: false,
      reason: `agent "${agentName}" resolves tool "${enabledTool[0]}" to true (expected zero enabled tools)`,
    }
  }

  const permission = agent.permission
  if (!permission) {
    return { ok: false, reason: `agent "${agentName}" has no resolved permission block` }
  }

  for (const key of DENY_REQUIRED_PERMISSIONS) {
    const value = permission[key]
    if (value !== "deny") {
      return {
        ok: false,
        reason: `agent "${agentName}" permission.${key} is "${String(value)}", expected "deny"`,
      }
    }
  }

  const bash = permission.bash
  const bashEntries = bash && typeof bash === "object" ? Object.entries(bash) : []
  if (bashEntries.length === 0) {
    return {
      ok: false,
      reason: `agent "${agentName}" permission.bash resolved to no entries (cannot confirm deny-all)`,
    }
  }
  const notDenied = bashEntries.find(([, value]) => value !== "deny")
  if (notDenied) {
    return {
      ok: false,
      reason: `agent "${agentName}" permission.bash["${notDenied[0]}"] is "${String(notDenied[1])}", expected "deny"`,
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
 * Shared by `judge.ts` (`runJudge`) and `story.ts` (`classifyMultiStory`):
 * both callers run `probeCapability` then, on success, `buildDenyMap` before
 * ever issuing a subturn, and both are meant to share ONE 5s-total budget
 * with the subturn attempt(s) that follow (FR-030). Runs the two calls as
 * one sequential unit (a passing probe is useless without the deny map that
 * hands the subturn its `tools` value) raced against `budgetMs` — the caller
 * starts its own budget clock BEFORE calling this and passes the full
 * remaining budget in, so elapsed probe/deny-map time is deducted from what
 * is left for the subturn attempt(s).
 *
 * Never rejects. Resolves `{ ok: true, tools }` (the `buildDenyMap` result)
 * on success, or `{ ok: false, cause, reason }` on failure:
 *  - `cause: "probe"` — `probeCapability` returned `{ ok: false }` (or,
 *    defensively, threw — not documented to, but not assumed to hold
 *    forever either).
 *  - `cause: "deny-map"` — the probe passed but `buildDenyMap` threw/
 *    rejected (its own documented failure mode).
 *  - `cause: "timeout"` — `budgetMs` elapsed before either step settled.
 *    Callers MUST treat this the same as `cause: "probe"` (e.g. judge.ts's
 *    `judge:unsupported` path) — a probe that cannot be confirmed in time is
 *    exactly as unusable as one actively refused.
 */
export async function probeCapabilityBounded(
  client: OpencodeClient,
  agentName: string,
  budgetMs: number,
): Promise<CapabilityProbeBoundedResult> {
  const work = (async (): Promise<CapabilityProbeBoundedResult> => {
    let probe: CapabilityProbeResult
    try {
      probe = await probeCapability(client, agentName)
    } catch (err) {
      return { ok: false, cause: "probe", reason: `probeCapability threw: ${describeError(err)}` }
    }
    if (!probe.ok) {
      return { ok: false, cause: "probe", reason: probe.reason ?? "capability probe failed" }
    }
    try {
      const tools = await buildDenyMap(client)
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
  /** "vertex-judge" | "vertex-intake" — never `opts.activeAgent` (FR-036). */
  agent: string
  /** Omit to use the host's configured default model for that agent. */
  model?: { providerID: string; modelID: string }
  system: string
  parts: Array<{ type: "text"; text: string }>
  /** The deny map from `buildDenyMap`. */
  tools: Record<string, boolean>
  /** Total budget for THIS attempt, including no further retry inside this call — the caller owns any retry-and-resubmit policy (FR-030a). */
  timeoutMs: number
}

export type SubturnResult = { ok: true; text: string } | { ok: false; reason: string }

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
 * Does NOT call `probeCapability` — that is the caller's (judge.ts /
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
    return await promptChildSession(client, childID, req)
  } finally {
    await deleteChildSession(client, childID, logger)
  }
}
