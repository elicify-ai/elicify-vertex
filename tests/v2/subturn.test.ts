import { describe, expect, it, vi } from "vitest"

import {
  SelfCreatedSessions,
  JUDGE_PROBE_POLICY,
  buildDenyMap,
  buildToolPolicyMap,
  probeCapability,
  probeCapabilityBounded,
  runSubturn,
  type SubturnRequest,
} from "../../src/v2/subturn.js"
import type { OpencodeClient } from "../../src/v2/types.js"
import type { Agent } from "@opencode-ai/sdk"

// ---------------------------------------------------------------------------
// Shared fixtures
//
// Client-call results are stubbed in the SDK's actual default shape
// (`{ data, error }`, `dist/gen/client/types.gen.d.ts` `RequestResult`,
// `responseStyle: "fields"`) so these tests ground `probeCapability` /
// `buildDenyMap` / `runSubturn` against what a real host resolves to, not
// just a convenience shape. A couple of tests further down additionally
// exercise a bare-value stub to confirm the module tolerates that shape too
// (v1's own test stubs, e.g. `tests/hookLifecycle.test.ts`, already resolve
// `session.prompt` to a bare object with no `data`/`error` wrapper).
// ---------------------------------------------------------------------------

const TOOL_IDS = ["bash", "edit", "write", "webfetch", "read"]

function denyAllAgent(name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    name,
    mode: "subagent",
    builtIn: false,
    permission: {
      edit: "deny",
      bash: { "*": "deny" },
      webfetch: "deny",
    },
    tools: { bash: false, edit: false, write: false, webfetch: false, read: false, "*": false },
    options: {},
    ...overrides,
  } as unknown as Agent
}

interface StubOpts {
  agents?: Agent[]
  agentsImpl?: () => Promise<unknown>
  toolIds?: string[]
  toolIdsImpl?: () => Promise<unknown>
  sessionCreateImpl?: (args: unknown) => Promise<unknown>
  sessionPromptImpl?: (args: unknown) => Promise<unknown>
  sessionDeleteImpl?: (args: unknown) => Promise<unknown>
}

function makeClient(opts: StubOpts = {}) {
  const agentsFn =
    opts.agentsImpl ?? (async () => ({ data: opts.agents ?? [], error: undefined }))
  const toolIdsFn =
    opts.toolIdsImpl ?? (async () => ({ data: opts.toolIds ?? TOOL_IDS, error: undefined }))
  const createFn =
    opts.sessionCreateImpl ?? (async () => ({ data: { id: "child-1" }, error: undefined }))
  const promptFn =
    opts.sessionPromptImpl ??
    (async () => ({
      data: { info: {}, parts: [{ type: "text", text: '{"fit":"pass","notes":"ok"}' }] },
      error: undefined,
    }))
  const deleteFn = opts.sessionDeleteImpl ?? (async () => ({ data: {}, error: undefined }))

  const client = {
    app: { agents: vi.fn(agentsFn) },
    tool: { ids: vi.fn(toolIdsFn) },
    session: {
      create: vi.fn(createFn),
      prompt: vi.fn(promptFn),
      delete: vi.fn(deleteFn),
    },
  }
  return client as unknown as OpencodeClient & {
    app: { agents: ReturnType<typeof vi.fn> }
    tool: { ids: ReturnType<typeof vi.fn> }
    session: {
      create: ReturnType<typeof vi.fn>
      prompt: ReturnType<typeof vi.fn>
      delete: ReturnType<typeof vi.fn>
    }
  }
}

function baseRequest(overrides: Partial<SubturnRequest> = {}): SubturnRequest {
  return {
    parentSessionID: "parent-1",
    agent: "vertex-judge",
    system: "You are the judge.",
    parts: [{ type: "text", text: "evaluate" }],
    tools: {},
    timeoutMs: 5000,
    ...overrides,
  }
}

// ===========================================================================
// Test 44: judge_tools_denied_or_refused
// FR-030b / SC-017 / BDD "Judge subturn is refused when tools cannot be
// disabled"
// ===========================================================================

describe("test 44: judge_tools_denied_or_refused", () => {
  describe("happy path — probe passes, deny map is exact, agent field is exact", () => {
    it("buildDenyMap enumerates client.tool.ids() to false plus a wildcard entry", async () => {
      const client = makeClient()
      const denyMap = await buildDenyMap(client)
      expect(denyMap).toEqual({
        bash: false,
        edit: false,
        write: false,
        webfetch: false,
        read: false,
        "*": false,
      })
    })

    it("probeCapability passes when the resolved agent has zero enabled tools and full deny permissions", async () => {
      const client = makeClient({ agents: [denyAllAgent("vertex-judge")] })
      const result = await probeCapability(client, "vertex-judge")
      expect(result).toEqual({ ok: true })
    })

    it("runSubturn sends the EXACT deny map and agent: \"vertex-judge\" on session.prompt", async () => {
      const client = makeClient({ agents: [denyAllAgent("vertex-judge")] })
      const selfCreated = new SelfCreatedSessions()
      const logger = vi.fn()
      const denyMap = await buildDenyMap(client)
      const probe = await probeCapability(client, "vertex-judge")
      expect(probe.ok).toBe(true)

      const result = await runSubturn(
        client,
        selfCreated,
        logger,
        baseRequest({ agent: "vertex-judge", tools: denyMap }),
      )

      expect(result).toEqual({ ok: true, text: '{"fit":"pass","notes":"ok"}' })
      expect(client.session.prompt).toHaveBeenCalledTimes(1)
      const promptArgs = client.session.prompt.mock.calls[0][0]
      expect(promptArgs.body.agent).toBe("vertex-judge")
      expect(promptArgs.body.tools).toEqual({
        bash: false,
        edit: false,
        write: false,
        webfetch: false,
        read: false,
        "*": false,
      })
      // agent is never opts.activeAgent — sanity-checked by literal equality
      // above; also confirm it is not left undefined/empty.
      expect(promptArgs.body.agent).not.toBe("")
    })

    it("omits model from the prompt body when SubturnRequest.model is not supplied", async () => {
      const client = makeClient({ agents: [denyAllAgent("vertex-judge")] })
      const selfCreated = new SelfCreatedSessions()
      await runSubturn(client, selfCreated, vi.fn(), baseRequest())
      const promptArgs = client.session.prompt.mock.calls[0][0]
      expect(promptArgs.body).not.toHaveProperty("model")
    })

    it("passes model through verbatim when SubturnRequest.model is supplied", async () => {
      const client = makeClient({ agents: [denyAllAgent("vertex-judge")] })
      const selfCreated = new SelfCreatedSessions()
      await runSubturn(
        client,
        selfCreated,
        vi.fn(),
        baseRequest({ model: { providerID: "minimax", modelID: "MiniMax-M3" } }),
      )
      const promptArgs = client.session.prompt.mock.calls[0][0]
      expect(promptArgs.body.model).toEqual({ providerID: "minimax", modelID: "MiniMax-M3" })
    })
  })

  describe("probe-failure path — zero session.create/session.prompt calls, exactly one probe failure result", () => {
    it("agent absent from client.app.agents()", async () => {
      const client = makeClient({ agents: [denyAllAgent("some-other-agent")] })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/not present/i)
      expect(client.session.create).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
    })

    it("a tool resolves to true", async () => {
      const client = makeClient({
        agents: [denyAllAgent("vertex-judge", { tools: { bash: true, edit: false } })],
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/bash.*true|true.*bash/i)
      expect(client.session.create).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
    })

    it("permission.edit is not deny", async () => {
      const client = makeClient({
        agents: [
          denyAllAgent("vertex-judge", {
            permission: { edit: "ask", bash: { "*": "deny" }, webfetch: "deny" },
          }),
        ],
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/permission\.edit/)
      expect(client.session.create).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
    })

    it("permission.webfetch is not deny", async () => {
      const client = makeClient({
        agents: [
          denyAllAgent("vertex-judge", {
            permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "allow" },
          }),
        ],
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/permission\.webfetch/)
    })

    it("permission.bash has an entry that is not deny", async () => {
      const client = makeClient({
        agents: [
          denyAllAgent("vertex-judge", {
            permission: { edit: "deny", bash: { "*": "deny", "rm -rf": "allow" }, webfetch: "deny" },
          }),
        ],
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/permission\.bash/)
    })

    it("permission.bash resolves to no entries at all (fail-closed, cannot confirm deny-all)", async () => {
      const client = makeClient({
        agents: [denyAllAgent("vertex-judge", { permission: { edit: "deny", bash: {}, webfetch: "deny" } })],
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/permission\.bash/)
    })

    it("permission resolves as a live-host array-of-rules (not the documented flat object) — passes when edit/bash/webfetch are each denied", async () => {
      const client = makeClient({
        agents: [
          denyAllAgent("vertex-judge", {
            permission: [
              { permission: "*", action: "allow", pattern: "*" },
              { permission: "doom_loop", action: "ask", pattern: "*" },
              { permission: "edit", action: "deny", pattern: "*" },
              { permission: "bash", action: "deny", pattern: "*" },
              { permission: "webfetch", action: "deny", pattern: "*" },
            ] as unknown as Agent["permission"],
          }),
        ],
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result).toEqual({ ok: true })
    })

    it("array-of-rules permission: a generic permission:'*' allow rule does not count as an edit/bash/webfetch-specific deny", async () => {
      const client = makeClient({
        agents: [
          denyAllAgent("vertex-judge", {
            permission: [{ permission: "*", action: "allow", pattern: "*" }] as unknown as Agent["permission"],
          }),
        ],
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/permission\.edit/)
    })

    it("array-of-rules permission: an edit rule that resolves to 'allow' is not read as denied even alongside a deny rule", async () => {
      const client = makeClient({
        agents: [
          denyAllAgent("vertex-judge", {
            permission: [
              { permission: "edit", action: "deny", pattern: "*" },
              { permission: "edit", action: "allow", pattern: "*.md" },
              { permission: "bash", action: "deny", pattern: "*" },
              { permission: "webfetch", action: "deny", pattern: "*" },
            ] as unknown as Agent["permission"],
          }),
        ],
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/permission\.edit/)
    })

    it("client.app.agents() throws", async () => {
      const client = makeClient({
        agentsImpl: async () => {
          throw new Error("host unreachable")
        },
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/host unreachable/)
      expect(client.session.create).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
    })

    it("client.app.agents() resolves with a populated .error field (fields-style failure)", async () => {
      const client = makeClient({
        agentsImpl: async () => ({ data: undefined, error: "unauthorized" }),
      })
      const result = await probeCapability(client, "vertex-judge")
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/unauthorized/)
    })

    it("client.tool.ids() unavailable surfaces as a thrown/rejected buildDenyMap, not a silently partial map", async () => {
      const client = makeClient({
        toolIdsImpl: async () => {
          throw new Error("tool ids endpoint unavailable")
        },
      })
      await expect(buildDenyMap(client)).rejects.toThrow(/tool ids endpoint unavailable/)
    })

    it("end-to-end caller pattern: a failed probe must produce exactly one failure result and never reach runSubturn", async () => {
      const client = makeClient({ agents: [] }) // agent never registered
      const probeResults = []
      probeResults.push(await probeCapability(client, "vertex-judge"))
      // Caller (judge.ts, wave 2) short-circuits here — runSubturn is never
      // invoked when the probe fails. This test asserts that discipline at
      // the subturn.ts boundary: nothing on the client was touched beyond
      // app.agents().
      expect(probeResults).toHaveLength(1)
      expect(probeResults[0].ok).toBe(false)
      expect(client.session.create).not.toHaveBeenCalled()
      expect(client.session.prompt).not.toHaveBeenCalled()
      expect(client.tool.ids).not.toHaveBeenCalled()
    })
  })

  it("probeCapability and buildDenyMap tolerate a bare-value stub (no data/error wrapper)", async () => {
    const client = {
      app: { agents: vi.fn(async () => [denyAllAgent("vertex-judge")]) },
      tool: { ids: vi.fn(async () => TOOL_IDS) },
      session: { create: vi.fn(), prompt: vi.fn(), delete: vi.fn() },
    } as unknown as OpencodeClient
    const probe = await probeCapability(client, "vertex-judge")
    expect(probe).toEqual({ ok: true })
    const denyMap = await buildDenyMap(client)
    expect(denyMap["*"]).toBe(false)
    expect(denyMap.bash).toBe(false)
  })
})

// ===========================================================================
// probeCapabilityBounded — CRITICAL fix (post-review): probeCapability +
// buildDenyMap raced against a caller-supplied budget so a hanging
// client.app.agents()/client.tool.ids() cannot block the FR-030 5s total
// budget indefinitely. Shared by judge.ts's runJudge and (once its owner
// adopts it) story.ts's classifyMultiStory.
// ===========================================================================

describe("probeCapabilityBounded", () => {
  it("resolves ok:true with the deny map when the probe passes within budget", async () => {
    const client = makeClient({ agents: [denyAllAgent("vertex-judge")] })
    const result = await probeCapabilityBounded(client, "vertex-judge", 5000)
    expect(result).toEqual({
      ok: true,
      tools: { bash: false, edit: false, write: false, webfetch: false, read: false, "*": false },
    })
  })

  it("resolves ok:false cause:'probe' when probeCapability fails, and never calls buildDenyMap/tool.ids", async () => {
    const client = makeClient({ agents: [] }) // agent never registered
    const result = await probeCapabilityBounded(client, "vertex-judge", 5000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cause).toBe("probe")
      expect(result.reason).toMatch(/not present/i)
    }
    expect(client.tool.ids).not.toHaveBeenCalled()
  })

  it("resolves ok:false cause:'deny-map' when buildDenyMap throws after a passing probe", async () => {
    const client = makeClient({
      agents: [denyAllAgent("vertex-judge")],
      toolIdsImpl: async () => {
        throw new Error("tool ids endpoint unavailable")
      },
    })
    const result = await probeCapabilityBounded(client, "vertex-judge", 5000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cause).toBe("deny-map")
      expect(result.reason).toMatch(/tool ids endpoint unavailable/)
    }
  })

  it("resolves ok:false cause:'timeout' when the probe hangs past budgetMs, never rejecting", async () => {
    const client = makeClient({
      agentsImpl: () => new Promise(() => {}), // never resolves
    })
    const result = await probeCapabilityBounded(client, "vertex-judge", 25)
    expect(result).toEqual({ ok: false, cause: "timeout", reason: expect.any(String) })
  })

  it("resolves ok:false cause:'timeout' when the deny-map build hangs past budgetMs", async () => {
    const client = makeClient({
      agents: [denyAllAgent("vertex-judge")],
      toolIdsImpl: () => new Promise(() => {}), // never resolves
    })
    const result = await probeCapabilityBounded(client, "vertex-judge", 25)
    expect(result).toEqual({ ok: false, cause: "timeout", reason: expect.any(String) })
  })

  it("a passing probe well within budget does not spuriously report a timeout", async () => {
    const client = makeClient({ agents: [denyAllAgent("vertex-judge")] })
    const result = await probeCapabilityBounded(client, "vertex-judge", 5000)
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// ProbePolicy / JUDGE_PROBE_POLICY / buildToolPolicyMap — HANDOVER.md point 3
// (user decision, 2026-07-29): the judge's zero-tool posture is deliberately
// reversed — read/grep/glob/list/bash allowed, edit/write/webfetch/task still
// provably denied. The DEFAULT policy (no policy argument) must reproduce the
// original zero-tool behavior exactly so intake is unaffected.
// ===========================================================================

/** The judge's resolved shape under config.ts's JUDGE_PERMISSION +
 * buildJudgeToolsMap: allowlisted tools true, everything else false, with
 * explicit deny rules for edit/write/webfetch/task. */
/**
 * The bundled SDK types `Agent.permission` as a narrow object that has no
 * `write`/`task` keys, but the LIVE host resolves and honours both (see
 * `subturn.ts`'s `permissionDenied`, which accepts the real array shape as
 * well). Tests must be able to express the shapes the host actually returns,
 * so the override bag is deliberately loose here rather than `Partial<Agent>`.
 */
function judgePolicyAgent(name: string, overrides: Record<string, unknown> = {}): Agent {
  return {
    name,
    mode: "subagent",
    builtIn: false,
    permission: { edit: "deny", write: "deny", webfetch: "deny", task: "deny" },
    tools: {
      read: true,
      grep: true,
      glob: true,
      list: true,
      bash: true,
      edit: false,
      write: false,
      webfetch: false,
      task: false,
      "*": false,
    },
    options: {},
    ...overrides,
  } as unknown as Agent
}

describe("ProbePolicy (HANDOVER.md point 3)", () => {
  it("default-policy equivalence: an explicit zero-tool policy behaves identically to no policy", async () => {
    const client = makeClient({ agents: [denyAllAgent("vertex-intake")] })
    const noPolicy = await probeCapability(client, "vertex-intake")
    const explicitDefault = await probeCapability(client, "vertex-intake", {
      allowTools: [],
      denyPermissions: ["edit", "bash", "webfetch"],
    })
    expect(noPolicy).toEqual({ ok: true })
    expect(explicitDefault).toEqual({ ok: true })

    // And both reject the same violation with the same naming reason.
    const violated = makeClient({ agents: [denyAllAgent("vertex-intake", { tools: { bash: true, edit: false } })] })
    const noPolicyFail = await probeCapability(violated, "vertex-intake")
    const explicitDefaultFail = await probeCapability(violated, "vertex-intake", { allowTools: [], denyPermissions: ["edit", "bash", "webfetch"] })
    expect(noPolicyFail.ok).toBe(false)
    expect(explicitDefaultFail).toEqual(noPolicyFail)
  })

  it("JUDGE_PROBE_POLICY: allowlisted tools resolving true is OK (their absence is also not an error)", async () => {
    const client = makeClient({ agents: [judgePolicyAgent("vertex-judge")] })
    const result = await probeCapability(client, "vertex-judge", JUDGE_PROBE_POLICY)
    expect(result).toEqual({ ok: true })

    // A host without `list` (missing capability, not unexpected capability)
    // degrades gracefully — still ok.
    const withoutList = judgePolicyAgent("vertex-judge")
    delete (withoutList.tools as Record<string, boolean>).list
    const client2 = makeClient({ agents: [withoutList] })
    const result2 = await probeCapability(client2, "vertex-judge", JUDGE_PROBE_POLICY)
    expect(result2).toEqual({ ok: true })
  })

  it("JUDGE_PROBE_POLICY: a NON-allowlisted tool resolving true fails with a naming reason", async () => {
    const client = makeClient({
      agents: [judgePolicyAgent("vertex-judge", { tools: { webfetch: true, read: true } })],
    })
    const result = await probeCapability(client, "vertex-judge", JUDGE_PROBE_POLICY)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/webfetch/)
    expect(result.reason).toMatch(/outside the allowlist/)
  })

  it("JUDGE_PROBE_POLICY: each denyPermission key missing or not-deny fails with a naming reason", async () => {
    // edit not deny
    let client = makeClient({
      agents: [judgePolicyAgent("vertex-judge", { permission: { edit: "ask", write: "deny", webfetch: "deny", task: "deny" } })],
    })
    let result = await probeCapability(client, "vertex-judge", JUDGE_PROBE_POLICY)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/permission\.edit/)

    // write rule entirely absent (cannot confirm deny)
    client = makeClient({
      agents: [judgePolicyAgent("vertex-judge", { permission: { edit: "deny", webfetch: "deny", task: "deny" } })],
    })
    result = await probeCapability(client, "vertex-judge", JUDGE_PROBE_POLICY)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/permission\.write/)

    // webfetch allowed
    client = makeClient({
      agents: [judgePolicyAgent("vertex-judge", { permission: { edit: "deny", write: "deny", webfetch: "allow", task: "deny" } })],
    })
    result = await probeCapability(client, "vertex-judge", JUDGE_PROBE_POLICY)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/permission\.webfetch/)

    // task not deny (no sub-subagents — the judge is a leaf)
    client = makeClient({
      agents: [judgePolicyAgent("vertex-judge", { permission: { edit: "deny", write: "deny", webfetch: "deny", task: "allow" } })],
    })
    result = await probeCapability(client, "vertex-judge", JUDGE_PROBE_POLICY)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/permission\.task/)
  })

  it("buildToolPolicyMap: enumerated ids all false EXCEPT allowlisted names true, plus a wildcard false", async () => {
    const client = makeClient() // TOOL_IDS = bash, edit, write, webfetch, read
    const map = await buildToolPolicyMap(client, ["read", "bash"])
    expect(map).toEqual({
      bash: true,
      read: true,
      edit: false,
      write: false,
      webfetch: false,
      "*": false,
    })
  })

  it("buildToolPolicyMap: an allowlisted name the host did not enumerate is still named true (and JUDGE_PROBE_POLICY's full allowlist round-trips)", async () => {
    const client = makeClient() // TOOL_IDS lacks grep/glob/list
    const map = await buildToolPolicyMap(client, JUDGE_PROBE_POLICY.allowTools!)
    expect(map.read).toBe(true)
    expect(map.bash).toBe(true)
    expect(map.grep).toBe(true)
    expect(map.glob).toBe(true)
    expect(map.list).toBe(true)
    expect(map.edit).toBe(false)
    expect(map["*"]).toBe(false)
  })

  it("buildToolPolicyMap: enumeration failure propagates, never a silently partial map", async () => {
    const client = makeClient({
      toolIdsImpl: async () => {
        throw new Error("tool ids endpoint unavailable")
      },
    })
    await expect(buildToolPolicyMap(client, ["read"])).rejects.toThrow(/tool ids endpoint unavailable/)
  })

  it("probeCapabilityBounded with a policy returns the allow-aware map (not a pure deny map)", async () => {
    const client = makeClient({ agents: [judgePolicyAgent("vertex-judge")] })
    const result = await probeCapabilityBounded(client, "vertex-judge", 5000, JUDGE_PROBE_POLICY)
    expect(result).toEqual({
      ok: true,
      tools: {
        bash: true,
        read: true,
        grep: true,
        glob: true,
        list: true,
        edit: false,
        write: false,
        webfetch: false,
        "*": false,
      },
    })
  })

  it("probeCapabilityBounded with a policy still refuses a non-allowlisted enabled tool before any map build", async () => {
    const client = makeClient({
      agents: [judgePolicyAgent("vertex-judge", { tools: { edit: true, read: true } })],
    })
    const result = await probeCapabilityBounded(client, "vertex-judge", 5000, JUDGE_PROBE_POLICY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cause).toBe("probe")
      expect(result.reason).toMatch(/edit/)
    }
    expect(client.tool.ids).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Test 47: subturn_session_cleanup
// FR-038 / SC-016 / BDD "Subturn child session is deleted on every path"
// ===========================================================================

describe("test 47: subturn_session_cleanup", () => {
  it("success path: session.delete called exactly once, result carries the text", async () => {
    const client = makeClient()
    const selfCreated = new SelfCreatedSessions()
    const logger = vi.fn()
    const result = await runSubturn(client, selfCreated, logger, baseRequest())
    expect(result).toEqual({ ok: true, text: '{"fit":"pass","notes":"ok"}' })
    expect(client.session.delete).toHaveBeenCalledTimes(1)
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: "child-1" } })
    expect(logger).not.toHaveBeenCalled()
  })

  it("malformed response path: session.delete called exactly once, result is ok:false", async () => {
    const client = makeClient({
      sessionPromptImpl: async () => ({
        data: { info: {}, parts: [{ type: "tool", output: "not text" }] },
        error: undefined,
      }),
    })
    const selfCreated = new SelfCreatedSessions()
    const logger = vi.fn()
    const result = await runSubturn(client, selfCreated, logger, baseRequest())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/malformed/i)
    expect(client.session.delete).toHaveBeenCalledTimes(1)
    expect(logger).not.toHaveBeenCalled()
  })

  it("hang-past-timeout path: session.delete called exactly once, result is ok:false", async () => {
    const client = makeClient({
      sessionPromptImpl: () => new Promise(() => {}), // never resolves
    })
    const selfCreated = new SelfCreatedSessions()
    const logger = vi.fn()
    const result = await runSubturn(client, selfCreated, logger, baseRequest({ timeoutMs: 25 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("timeout")
    expect(client.session.delete).toHaveBeenCalledTimes(1)
    expect(logger).not.toHaveBeenCalled()
  })

  it("thrown-error path: session.delete called exactly once, result is ok:false", async () => {
    const client = makeClient({
      sessionPromptImpl: async () => {
        throw new Error("provider rejected the request")
      },
    })
    const selfCreated = new SelfCreatedSessions()
    const logger = vi.fn()
    const result = await runSubturn(client, selfCreated, logger, baseRequest())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/provider rejected the request/)
    expect(client.session.delete).toHaveBeenCalledTimes(1)
    expect(logger).not.toHaveBeenCalled()
  })

  it("a rejecting session.delete logs subturn:cleanup-failed WITHOUT changing the caller's (success) result", async () => {
    const client = makeClient({
      sessionDeleteImpl: async () => {
        throw new Error("delete endpoint down")
      },
    })
    const selfCreated = new SelfCreatedSessions()
    const logger = vi.fn()
    const result = await runSubturn(client, selfCreated, logger, baseRequest())
    expect(result).toEqual({ ok: true, text: '{"fit":"pass","notes":"ok"}' })
    expect(client.session.delete).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("subturn:cleanup-failed", {
      sessionID: "child-1",
      reason: "delete endpoint down",
    })
  })

  it("a fields-style session.delete .error also logs subturn:cleanup-failed WITHOUT changing a thrown-path result", async () => {
    const client = makeClient({
      sessionPromptImpl: async () => {
        throw new Error("boom")
      },
      sessionDeleteImpl: async () => ({ data: undefined, error: "already gone" }),
    })
    const selfCreated = new SelfCreatedSessions()
    const logger = vi.fn()
    const result = await runSubturn(client, selfCreated, logger, baseRequest())
    expect(result).toEqual({ ok: false, reason: "subturn failed: boom" })
    expect(client.session.delete).toHaveBeenCalledTimes(1)
    expect(logger).toHaveBeenCalledWith("subturn:cleanup-failed", {
      sessionID: "child-1",
      reason: "already gone",
    })
  })

  it("session.delete is called exactly once across all four scripted outcomes in a single sweep", async () => {
    const scripted: Array<{ label: string; opts: StubOpts }> = [
      { label: "success", opts: {} },
      {
        label: "malformed",
        opts: { sessionPromptImpl: async () => ({ data: { info: {}, parts: [] }, error: undefined }) },
      },
      { label: "timeout", opts: { sessionPromptImpl: () => new Promise(() => {}) } },
      {
        label: "throw",
        opts: {
          sessionPromptImpl: async () => {
            throw new Error("nope")
          },
        },
      },
    ]

    for (const { opts } of scripted) {
      const client = makeClient(opts)
      const selfCreated = new SelfCreatedSessions()
      const logger = vi.fn()
      await runSubturn(client, selfCreated, logger, baseRequest({ timeoutMs: 25 }))
      expect(client.session.delete).toHaveBeenCalledTimes(1)
    }
  })
})

// ===========================================================================
// SelfCreatedSessions — FR-036 (unit-level; the integration-level
// "self_created_session_is_inert" test 43 belongs to wave 3/4 per the module
// contract's note, since it needs the real hook set, not this class alone)
// ===========================================================================

describe("SelfCreatedSessions", () => {
  it("recognizes a directly recorded session id", () => {
    const s = new SelfCreatedSessions()
    s.record("child-1", "parent-1")
    expect(s.isSelfCreated("child-1", () => null)).toBe(true)
  })

  it("does not recognize an unrelated session id", () => {
    const s = new SelfCreatedSessions()
    s.record("child-1", "parent-1")
    expect(s.isSelfCreated("some-other-session", () => null)).toBe(false)
  })

  it("recognizes a session whose parentID resolves to an already-recorded self-created session (FR-036 grandchild clause)", () => {
    const s = new SelfCreatedSessions()
    s.record("child-1", "parent-1")
    const resolveParent = (id: string) => (id === "grandchild-1" ? "child-1" : null)
    expect(s.isSelfCreated("grandchild-1", resolveParent)).toBe(true)
  })

  it("does not infinite-loop on a cyclical resolveParent and returns false when no ancestor is self-created", () => {
    const s = new SelfCreatedSessions()
    const resolveParent = (id: string) => (id === "a" ? "b" : "a") // a -> b -> a -> ...
    expect(s.isSelfCreated("a", resolveParent)).toBe(false)
  })

  it("runSubturn records the created child session immediately after session.create", async () => {
    const client = makeClient({ sessionCreateImpl: async () => ({ data: { id: "judge-child-9" }, error: undefined }) })
    const selfCreated = new SelfCreatedSessions()
    await runSubturn(client, selfCreated, vi.fn(), baseRequest())
    expect(selfCreated.isSelfCreated("judge-child-9", () => null)).toBe(true)
  })
})
