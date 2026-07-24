import { describe, expect, it, vi } from "vitest"

import { ElicifyVertexPlugin, isMutatingBashCommand } from "../src/index.js"
import * as measurement from "../src/measurement.js"

// ===========================================================================
// Regression tests for the 6 reviewer-surfaced bugs in detection, the
// verification parser, and the in-flight guard.
// Every test in this file is wired to fail on the PRE-FIX code and pass once
// the corresponding fix lands.
// ===========================================================================

function pluginInput(prompt: ReturnType<typeof vi.fn>) {
  return {
    client: { session: { prompt } },
    directory: "/work",
    worktree: "/work",
  } as any
}

async function activate(
  hooks: Awaited<ReturnType<typeof ElicifyVertexPlugin>>,
  sessionID: string,
  text: string,
) {
  await hooks["chat.message"]!({ sessionID, agent: "elicify-vertex-agent" } as any, {
    message: {} as any,
    parts: [{ type: "text", text } as any],
  })
}

async function completeText(
  hooks: Awaited<ReturnType<typeof ElicifyVertexPlugin>>,
  sessionID: string,
  text: string,
) {
  await hooks["experimental.text.complete"]!({
    sessionID,
    messageID: `msg-${sessionID}`,
    partID: `part-${sessionID}`,
  }, { text })
}

// ---------------------------------------------------------------------------
// Fix 1: re-anchor MUTATING_BASH_RE per segment
//
// Pre-fix symptom: MUTATING_BASH_RE only anchors the FIRST alternative to `^`.
// Subsequent alternatives (`\bgit ...`, `\bcurl ...`, `\bwget ...`) match
// ANYWHERE in the segment, so quoted substrings like `python script.py
// "git add x"` false-positive on the embedded `git add`.
// ---------------------------------------------------------------------------

describe("Fix 1: MUTATING_BASH_RE is anchored per segment", () => {
  it("does not flag `git add` inside a quoted Python argument", () => {
    // Pre-fix: regex matches `git add` substring anywhere → returns true (FP).
    expect(isMutatingBashCommand(`python script.py "git add x"`)).toBe(false)
  })

  it("does not flag `git commit` inside a quoted bash argument", () => {
    expect(isMutatingBashCommand(`echo "now run git commit -m y"`)).toBe(false)
  })

  it("does not flag `git commit` inside single quotes", () => {
    expect(isMutatingBashCommand(`echo 'git commit -m y'`)).toBe(false)
  })

  it("still flags a true `git commit` at segment head", () => {
    // Anchoring must not regress the genuine mutation.
    expect(isMutatingBashCommand("cat x; git commit -m y")).toBe(true)
  })

  it("still flags a true `rm` at segment head", () => {
    expect(isMutatingBashCommand("echo x; rm f")).toBe(true)
  })

  it("flags `--write` / `--fix` in-segment (separate from head mutators)", () => {
    // `--write`/`--fix` flags can appear mid-segment (e.g. `npm version --write`).
    // Per-segment anchoring must not hide them.
    expect(isMutatingBashCommand("npm version --write")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fix 2: per-segment regex reset (no global state leaks)
//
// Pre-fix symptom: PYTHON_INLINE_HEREDOC_RE_G and SHELL_FILE_REDIRECT_RE are
// /g regexes whose lastIndex is reset before use. Switching to
// String.prototype.matchAll removes any possibility of a state leak and makes
// the loops easier to read. These tests pin the new behavior.
// ---------------------------------------------------------------------------

describe("Fix 2: matchAll replaces manual lastIndex bookkeeping", () => {
  it("pythonIsMutation returns consistent results across many calls", () => {
    const heredoc = `python3 <<PY\nopen('f','w').write('x')\nPY`
    const safe = `python3 <<PY\nprint('x')\nPY`
    // Interleave 50 times; if state leaked, one of these would flip.
    for (let i = 0; i < 50; i += 1) {
      expect(isMutatingBashCommand(heredoc)).toBe(true)
      expect(isMutatingBashCommand(safe)).toBe(false)
    }
  })

  it("redirect detector handles repeated calls without state leak", () => {
    const redirect = "echo x > /tmp/file"
    const safe = "ls /tmp"
    for (let i = 0; i < 50; i += 1) {
      expect(isMutatingBashCommand(redirect)).toBe(true)
      expect(isMutatingBashCommand(safe)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Fix 4: maxStopBlocks validation at init
//
// Pre-fix symptom: maxStopBlocks: 0 or negative silently disables the stop
// gate (because `blocks >= opts.maxStopBlocks` is always true after the first
// increment). Reject with a RangeError so the plugin can never be loaded
// in a "broken gate" configuration.
// ---------------------------------------------------------------------------

describe("Fix 4: maxStopBlocks must be a positive integer", () => {
  it("rejects maxStopBlocks: 0 with a RangeError", async () => {
    await expect(
      ElicifyVertexPlugin(pluginInput(vi.fn(async () => ({}))), { maxStopBlocks: 0 }),
    ).rejects.toThrowError(RangeError)
  })

  it("rejects maxStopBlocks: -1 with a RangeError", async () => {
    await expect(
      ElicifyVertexPlugin(pluginInput(vi.fn(async () => ({}))), { maxStopBlocks: -1 }),
    ).rejects.toThrowError(RangeError)
  })

  it("rejects a non-integer maxStopBlocks with a RangeError", async () => {
    await expect(
      ElicifyVertexPlugin(pluginInput(vi.fn(async () => ({}))), { maxStopBlocks: 2.5 }),
    ).rejects.toThrowError(RangeError)
  })

  it("rejects NaN / Infinity with a RangeError", async () => {
    await expect(
      ElicifyVertexPlugin(pluginInput(vi.fn(async () => ({}))), { maxStopBlocks: Number.NaN }),
    ).rejects.toThrowError(RangeError)
    await expect(
      ElicifyVertexPlugin(pluginInput(vi.fn(async () => ({}))), { maxStopBlocks: Number.POSITIVE_INFINITY }),
    ).rejects.toThrowError(RangeError)
  })

  it("accepts a positive integer (default 3 and override 5)", async () => {
    await expect(
      ElicifyVertexPlugin(pluginInput(vi.fn(async () => ({}))), undefined),
    ).resolves.toBeDefined()
    await expect(
      ElicifyVertexPlugin(pluginInput(vi.fn(async () => ({}))), { maxStopBlocks: 5 }),
    ).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Fix 3: in-flight guard TTL (30s)
//
// Pre-fix symptom: if session.prompt never resolves (network stall, hung
// server), gateContinuationSessions stays set forever and the gate is
// silently disabled for the rest of the session. Wrap the prompt in
// Promise.race with a 30s timer: on timeout, clear the flag, log gate_fire
// with reason "continuation timeout", and leave the directive queue intact.
// ---------------------------------------------------------------------------

describe("Fix 3: in-flight guard has a 30s TTL", () => {
  it("on prompt timeout: clears flag, logs gate_fire with reason `continuation timeout`, queue intact", async () => {
    vi.useFakeTimers()
    const fires: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(measurement, "logGateFire").mockImplementation((_sid, payload) => {
      fires.push(payload as Record<string, unknown>)
    })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      // Prompt never resolves.
      const neverResolves = new Promise<unknown>(() => {})
      const prompt = vi.fn(() => neverResolves)
      const hooks = await ElicifyVertexPlugin(pluginInput(prompt), { maxStopBlocks: 3 })
      const sessionID = "continue-timeout"
      await activate(hooks, sessionID, "deep implement the plan")
      await hooks["tool.execute.after"]!({
        tool: "edit",
        sessionID,
        callID: "edit",
        args: { filePath: "src/index.ts" },
      }, { title: "edit", output: "ok", metadata: {} })
      await completeText(hooks, sessionID, "Done.")
      expect(prompt).toHaveBeenCalledTimes(0)

      // Kick off idle: it queues a stop-block directive, then calls prompt
      // which is raced against a 30s timeout.
      const idlePromise = hooks.event!({
        event: { type: "session.idle", properties: { sessionID } } as any,
      })

      // Advance past the 30s threshold so the timeout wins the race.
      await vi.advanceTimersByTimeAsync(31_000)
      await idlePromise

      // 1) gate_fire logged with reason "continuation timeout".
      const timeoutFire = fires.find((f) => f.reason === "continuation timeout")
      expect(timeoutFire).toBeDefined()
      expect(timeoutFire?.decision).toBe("allow")
      expect(timeoutFire?.would_block).toBe(true)

      // 2) The prompt was called exactly once (we did not re-prompt under the
      // in-flight flag).
      expect(prompt).toHaveBeenCalledTimes(1)

      // 3) Queue survived the timeout (stop-block directive still pending).
      const sys = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as any }, sys)
      expect(sys.system.join("\n")).toContain("vertex:stop-block")
    } finally {
      spy.mockRestore()
      errSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it("on successful prompt (under TTL): logs gate_fire as block and keeps flag set", async () => {
    vi.useFakeTimers()
    const fires: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(measurement, "logGateFire").mockImplementation((_sid, payload) => {
      fires.push(payload as Record<string, unknown>)
    })
    try {
      const prompt = vi.fn(async () => ({}))
      const hooks = await ElicifyVertexPlugin(pluginInput(prompt), { maxStopBlocks: 3 })
      const sessionID = "continue-success"
      await activate(hooks, sessionID, "deep implement the plan")
      await hooks["tool.execute.after"]!({
        tool: "edit",
        sessionID,
        callID: "edit",
        args: { filePath: "src/index.ts" },
      }, { title: "edit", output: "ok", metadata: {} })
      await completeText(hooks, sessionID, "Done.")
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })

      expect(prompt).toHaveBeenCalledTimes(1)
      const blockFire = fires.find((f) => f.decision === "block")
      expect(blockFire).toBeDefined()
      // No "continuation timeout" reason on a fast-resolving prompt.
      expect(fires.some((f) => f.reason === "continuation timeout")).toBe(false)
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Fix 6: quote-aware bashSegments
//
// Pre-fix symptom: the splitter does a regex split on `;`, `|`, `&&`, `||`
// without quote awareness, so `python -c "pytest; echo done"` is split into
// two segments and a quoted `;` becomes a real separator. Quoted strings must
// suppress separators inside them.
// ---------------------------------------------------------------------------

describe("Fix 6: quote-aware bashSegments", () => {
  it("does not treat a quoted `;` as a real separator (false positive on `rm f` inside python -c)", () => {
    // Pre-fix: regex split on `;` turns the trailing `rm f"` into a second
    // segment whose head matches `^rm\b` → flagged as a mutation. The `rm`
    // is just text inside a Python string, not a real shell command.
    expect(isMutatingBashCommand(`python -c "x; rm f"`)).toBe(false)
  })

  it("keeps `python -c \"pytest; echo done\"` as one segment (no spurious mutation)", () => {
    // Same shape: a stray `;` inside a quoted Python argument must not split.
    expect(isMutatingBashCommand(`python -c "pytest; echo done"`)).toBe(false)
  })

  it("still detects rm at the end of a quote-containing command", () => {
    // `echo "a | b" | rm x` has one quoted pipe inside the echo's argument;
    // the outer `|` is still a real separator, so rm is a real mutator.
    expect(isMutatingBashCommand(`echo "a | b" | rm x`)).toBe(true)
  })

  it("does not split on `;` inside single quotes either", () => {
    expect(isMutatingBashCommand(`python -c 'x; rm f'`)).toBe(false)
  })

  it("splits multiple statements outside quotes as before", () => {
    // Sanity: the splitter must still produce multiple segments so the
    // segment-start mutator rule still catches `rm`.
    expect(isMutatingBashCommand(`echo a; rm f`)).toBe(true)
    expect(isMutatingBashCommand(`echo a && rm f`)).toBe(true)
    expect(isMutatingBashCommand(`echo a || rm f`)).toBe(true)
  })
})