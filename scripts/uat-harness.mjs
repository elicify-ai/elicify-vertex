#!/usr/bin/env node
/**
 * Host-faithful UAT harness for elicify-vertex.
 * Loads the real plugin entrypoint and drives OpenCode-shaped hooks
 * (chat.message, tool.execute.after, text.complete, session.idle, etc.),
 * then asserts measurement events + debug log + behavioral outcomes.
 *
 * Usage:
 *   node scripts/uat-harness.mjs
 *   VERTEX_UAT_DIST=/path/to/dist/index.js node scripts/uat-harness.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

const ROOT = resolve(import.meta.dirname, "..")
const DIST = process.env.VERTEX_UAT_DIST || join(ROOT, "dist/index.js")
const uatRoot = mkdtempSync(join(tmpdir(), "vertex-uat-"))
const worktree = join(uatRoot, "work")
const dataRoot = join(uatRoot, "data")
const debugLog = join(dataRoot, ".vertex-debug.log")
mkdirSync(worktree, { recursive: true })
mkdirSync(dataRoot, { recursive: true })
writeFileSync(join(worktree, "scratch.ts"), "export const n = 1\n")

process.env.VERTEX_DATA = dataRoot
process.env.VERTEX_DEBUG = "1"
process.env.HOME = uatRoot // so debug log lands under uatRoot/.config/opencode if plugin uses HOME
// Plugin debug path: ${HOME}/.config/opencode/.vertex-debug.log
mkdirSync(join(uatRoot, ".config/opencode"), { recursive: true })

const results = []
let failed = 0

function pass(id, detail = "") {
  results.push({ id, ok: true, detail })
  console.log(`  PASS  ${id}${detail ? " — " + detail : ""}`)
}
function fail(id, detail) {
  failed++
  results.push({ id, ok: false, detail })
  console.log(`  FAIL  ${id} — ${detail}`)
}
function assert(id, cond, detail) {
  if (cond) pass(id, typeof detail === "string" ? detail : "")
  else fail(id, detail || "assertion failed")
}

function readEvents() {
  const p = join(dataRoot, ".vertex-events.jsonl")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function eventsOf(type, sessionID) {
  return readEvents().filter(
    (e) => e.event_type === type && (!sessionID || e.session_id === sessionID),
  )
}

function debugText() {
  const p = join(uatRoot, ".config/opencode/.vertex-debug.log")
  return existsSync(p) ? readFileSync(p, "utf8") : ""
}

function clearLogs() {
  writeFileSync(join(dataRoot, ".vertex-events.jsonl"), "")
  writeFileSync(join(uatRoot, ".config/opencode/.vertex-debug.log"), "")
}

async function loadPlugin(promptImpl) {
  const mod = await import(pathToFileURL(DIST).href + `?t=${Date.now()}`)
  const prompt = promptImpl || (async () => ({}))
  const entry = mod.default?.server || mod.server || mod.default
  const hooks = await entry(
    {
      client: { session: { prompt } },
      directory: worktree,
      worktree,
      project: { id: "uat" },
    },
    { maxStopBlocks: 3 },
  )
  return { hooks, prompt, mod, entry }
}

async function activate(hooks, sid, text, agent = "elicify-vertex-agent") {
  await hooks["chat.message"](
    { sessionID: sid, agent },
    { message: {}, parts: [{ type: "text", text }] },
  )
}

async function complete(hooks, sid, text) {
  await hooks["experimental.text.complete"](
    { sessionID: sid, messageID: "m", partID: "p" },
    { text },
  )
}

async function bash(hooks, sid, command, output, exit = 0) {
  const out = { title: "bash", output, metadata: { exit } }
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID: sid, callID: `c-${Math.random()}`, args: { command } },
    out,
  )
  return out
}

async function edit(hooks, sid, filePath = join(worktree, "scratch.ts")) {
  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: sid, callID: `e-${Math.random()}`, args: { filePath } },
    { title: "edit", output: "ok", metadata: {} },
  )
}

async function idle(hooks, sid) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } })
}

async function systemInject(hooks, sid) {
  const out = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: sid, model: {} }, out)
  return out.system.join("\n")
}

// ---------------------------------------------------------------------------
console.log(`\nUAT harness — dist=${DIST}`)
console.log(`worktree=${worktree}`)
console.log(`VERTEX_DATA=${dataRoot}\n`)

const { default: plugin, holdoutArm } = await import(pathToFileURL(join(ROOT, "dist/measurement.js")).href).catch(() => ({}))
// holdoutArm is in measurement - import properly
const meas = await import(pathToFileURL(join(ROOT, "dist/measurement.js")).href)

// ===== A. Activation =====
console.log("A. Activation")
{
  clearLogs()
  const { hooks } = await loadPlugin()
  const sid = "uat-a1"
  await hooks["chat.message"](
    { sessionID: sid, agent: "build" },
    { message: {}, parts: [{ type: "text", text: "hello without trigger" }] },
  )
  const inj = await systemInject(hooks, sid)
  assert("A1-inactive-no-inject", !inj.includes("vertex-directives"), "no inject without activation")

  clearLogs()
  const sid2 = "uat-a2"
  await hooks["command.execute.before"](
    { command: "vertex", sessionID: sid2, arguments: "" },
    { parts: [] },
  )
  await hooks["chat.message"](
    { sessionID: sid2, agent: "build" },
    { message: {}, parts: [{ type: "text", text: "Activate the elicify-vertex verification harness." }] },
  )
  const inj2 = await systemInject(hooks, sid2)
  assert("A2-slash-vertex-activates", inj2.includes("vertex-directives") && inj2.includes("vertex:contract"), "slash activates")
  assert("A2-classify-event", eventsOf("classify", sid2).length >= 1, `classify count=${eventsOf("classify", sid2).length}`)
  assert("A2-debug-activated", debugText().includes("ACTIVATED"), "debug shows ACTIVATED")

  clearLogs()
  const sid3 = "uat-a3"
  await activate(hooks, sid3, "deep implement something")
  const inj3 = await systemInject(hooks, sid3)
  assert("A3-agent-activates", inj3.includes("vertex:contract"), "agent activates")
  assert("A3-deep-guidance", inj3.includes("verification-required") || inj3.includes("deep"), "deep guidance present")

  clearLogs()
  const sid4 = "uat-a4"
  await hooks["chat.message"](
    { sessionID: sid4, agent: "build" },
    { message: {}, parts: [{ type: "text", text: "is the /vertex plugin working?" }] },
  )
  const inj4 = await systemInject(hooks, sid4)
  assert("A4-mid-sentence-no-activate", !inj4.includes("vertex-directives"), "mid-sentence does not activate")
}

// ===== B. Stop gate =====
console.log("\nB. Stop gate (deep + mutation + verify)")
{
  clearLogs()
  let prompts = 0
  const { hooks } = await loadPlugin(async () => {
    prompts++
    return {}
  })
  const sid = "uat-b-stop"
  await activate(hooks, sid, "deep implement the plan end-to-end")
  await edit(hooks, sid)
  await complete(hooks, sid, "All done.")
  await idle(hooks, sid)
  assert("B1-unverified-edit-blocks", prompts >= 1, `prompts=${prompts}`)
  const blocks = eventsOf("gate_fire", sid).filter((e) => e.payload?.decision === "block")
  assert("B1-gate-fire-block", blocks.length >= 1, JSON.stringify(blocks.slice(-1)))
  assert("B1-changed-unverified", blocks.some((e) => e.payload.changed && e.payload.verified === false), "changed+!verified")

  // B2: verify then allow
  clearLogs()
  prompts = 0
  const sid2 = "uat-b-verify"
  await activate(hooks, sid2, "deep implement the plan")
  await edit(hooks, sid2)
  const out = await bash(hooks, sid2, "npm test 2>&1", "12 passed\n", 0)
  assert("B2-redirect-verified-receipt", !!out.metadata.vertexVerificationReceiptId, "receipt id present")
  await complete(hooks, sid2, "Verified and complete.")
  await idle(hooks, sid2)
  assert("B2-verified-allows", prompts === 0, `prompts=${prompts}`)

  // B3: verify then edit again → block
  clearLogs()
  prompts = 0
  const sid3 = "uat-b-stale"
  await activate(hooks, sid3, "deep implement the plan")
  await edit(hooks, sid3)
  await bash(hooks, sid3, "npm test", "10 passed", 0)
  await edit(hooks, sid3) // post-verify mutation
  await complete(hooks, sid3, "Done.")
  await idle(hooks, sid3)
  assert("B3-verify-then-edit-blocks", prompts >= 1, `prompts=${prompts}`)
}

// ===== C. Promise-no-act =====
console.log("\nC. Promise-no-act")
{
  clearLogs()
  let prompts = 0
  const { hooks } = await loadPlugin(async () => {
    prompts++
    return {}
  })

  const sid = "uat-c1"
  await activate(hooks, sid, "fix the parser") // normal — stop won't hard-block; promise may
  await edit(hooks, sid)
  await complete(hooks, sid, "TODO: I will finish the remaining tests later.")
  await idle(hooks, sid)
  assert("C1-todo-later-blocks", prompts >= 1, `prompts=${prompts}`)

  clearLogs()
  prompts = 0
  const sid2 = "uat-c2"
  await activate(hooks, sid2, "fix the parser")
  await edit(hooks, sid2)
  await bash(hooks, sid2, "npm test", "5 passed", 0)
  await complete(hooks, sid2, "I tracked down the root cause. See you later!")
  await idle(hooks, sid2)
  assert("C2-fp-no-block", prompts === 0, `prompts=${prompts}`)

  clearLogs()
  prompts = 0
  const sid3 = "uat-c3"
  await activate(hooks, sid3, "fix the parser")
  await edit(hooks, sid3)
  await complete(hooks, sid3, "Would you like me to continue with the remaining work?")
  await idle(hooks, sid3)
  assert("C3-ask-user-exempt", prompts === 0, `prompts=${prompts}`)

  clearLogs()
  prompts = 0
  const sid4 = "uat-c4"
  await activate(hooks, sid4, "fix the parser")
  await edit(hooks, sid4)
  await complete(hooks, sid4, "TODO remaining.\nOK?")
  await idle(hooks, sid4)
  assert("C4-bare-ok-still-blocks", prompts >= 1, `prompts=${prompts}`)
}

// ===== D. Mutation matrix =====
console.log("\nD. Mutation observation")
{
  const { hooks, mod } = await loadPlugin()
  const cases = [
    ["edit", true],
    ["python -c 'open(\"f\",\"w\").write(\"x\")'", true],
    ["node -e 'require(\"fs\").writeFileSync(\"f\",\"x\")'", true],
    ["git commit -m x", true],
    ["echo hi > out.txt", true],
    ["ls -la", false],
    ["npm test 2>&1", false],
  ]
  for (const [cmd, want] of cases) {
    if (cmd === "edit") {
      assert("D-edit", mod.changedPathsFromTool("edit", { filePath: "a.ts" }).length > 0)
      continue
    }
    const got = mod.isMutatingBashCommand(cmd)
    assert(`D-mut:${cmd.slice(0, 40)}`, got === want, `got=${got} want=${want}`)
  }
}

// ===== E. Verification recognition =====
console.log("\nE. Verification recognition")
{
  const { mod } = await loadPlugin()
  const pv = mod.parseVerification
  const cases = [
    ["npm test", "10 passed", 0, "verified"],
    ["npm test 2>&1", "10 passed", 0, "verified"],
    ["npx -y tsc --noEmit", "", 0, "verified"],
    ["npx --yes vitest run", "3 passed", 0, "verified"],
    ["echo pytest", "success", 0, "not-verification"],
    ["npm run dev", "ready", 0, "not-verification"],
    ["pytest || true", "", 0, "ambiguous"],
    ["pytest", "2 failed", 0, "failed"],
  ]
  for (const [cmd, out, exit, want] of cases) {
    const got = pv(cmd, out, exit).outcome
    assert(`E:${cmd.slice(0, 28)}`, got === want, `got=${got} want=${want}`)
  }
}

// ===== F. Fail-open honesty =====
console.log("\nF. Fail-open honesty")
{
  clearLogs()
  const { hooks } = await loadPlugin(undefined) // no prompt client — loadPlugin always provides one
  // Custom load without prompt
  const mod = await import(pathToFileURL(DIST).href + `?t=${Date.now()}-f`)
  const entry2 = mod.default?.server || mod.server || mod.default
  const hooks2 = await entry2(
    { client: {}, directory: worktree, worktree, project: {} },
    { maxStopBlocks: 3 },
  )
  const sid = "uat-f1"
  await activate(hooks2, sid, "deep implement the plan")
  await edit(hooks2, sid)
  await complete(hooks2, sid, "Done.")
  await idle(hooks2, sid)
  const fires = eventsOf("gate_fire", sid)
  const last = fires[fires.length - 1]
  assert(
    "F1-missing-prompt-allow-would-block",
    last?.payload?.decision === "allow" && last?.payload?.would_block === true,
    JSON.stringify(last?.payload),
  )
  assert(
    "F1-not-fake-block",
    !fires.some((e) => e.payload?.decision === "block"),
    "must not claim block without prompt",
  )
}

// ===== G. Goals + receipts =====
console.log("\nG. Goals engine + receipts")
{
  clearLogs()
  const { hooks } = await loadPlugin()
  const sid = "uat-g1"
  const ctx = { sessionID: sid, worktree, directory: worktree }
  await activate(hooks, sid, "deep implement multi-story plan")
  // mint receipt BEFORE goal create (H4)
  const out = await bash(hooks, sid, "npm test", "20 passed", 0)
  const receiptId = out.metadata.vertexVerificationReceiptId
  assert("G1-receipt-without-goal-tool", typeof receiptId === "string" && receiptId.startsWith("vrf_"), String(receiptId))

  await hooks.tool.vertex_goal_create.execute(
    { brief: "uat plan", stories: [{ title: "work", objective: "do it" }], replace: true },
    ctx,
  )
  await hooks.tool.vertex_goal_next.execute({}, ctx)
  await hooks.tool.vertex_goal_checkpoint.execute(
    { id: "G001", status: "complete", evidence: "implemented in uat" },
    ctx,
  )
  await hooks.tool.vertex_goal_next.execute({}, ctx)
  // need fresh receipt after final story start
  const out2 = await bash(hooks, sid, "npm test", "20 passed", 0)
  const rid2 = out2.metadata.vertexVerificationReceiptId
  const done = await hooks.tool.vertex_goal_checkpoint.execute(
    { id: "G002", status: "complete", evidence: "suite green", verificationReceiptId: rid2 },
    ctx,
  )
  const plan = JSON.parse(done)
  assert("G2-plan-complete", plan.status === "complete", plan.status)
  assert("G2-goals-on-disk", existsSync(join(worktree, ".elicify-vertex/goals.json")))

  // stale receipt after edit
  clearLogs()
  const sid2 = "uat-g-stale"
  const ctx2 = { sessionID: sid2, worktree, directory: worktree }
  await activate(hooks, sid2, "deep implement")
  await hooks.tool.vertex_goal_create.execute(
    { brief: "stale", stories: [{ title: "w", objective: "w" }], replace: true },
    ctx2,
  )
  await hooks.tool.vertex_goal_next.execute({}, ctx2)
  await hooks.tool.vertex_goal_checkpoint.execute(
    { id: "G001", status: "complete", evidence: "w" },
    ctx2,
  )
  await hooks.tool.vertex_goal_next.execute({}, ctx2)
  const o3 = await bash(hooks, sid2, "npm test", "1 passed", 0)
  const rid3 = o3.metadata.vertexVerificationReceiptId
  await edit(hooks, sid2)
  let threw = false
  try {
    await hooks.tool.vertex_goal_checkpoint.execute(
      { id: "G002", status: "complete", evidence: "stale", verificationReceiptId: rid3 },
      ctx2,
    )
  } catch (e) {
    threw = /not observed/i.test(String(e.message || e))
  }
  assert("G3-stale-receipt-rejected", threw, "expected not-observed throw")
}

// ===== H. Docs-only / review =====
console.log("\nH. Docs-only + review routing")
{
  clearLogs()
  let prompts = 0
  const { hooks, mod } = await loadPlugin(async () => {
    prompts++
    return {}
  })
  assert("H-docs-code-kind", mod.classifyFileKind("docs/api/handler.ts") === "code")
  assert("H-readme-docs", mod.classifyFileKind("README.md") === "docs")

  const sid = "uat-h-docs"
  await activate(hooks, sid, "deep thorough documentation pass")
  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: sid, callID: "d", args: { filePath: join(worktree, "README.md") } },
    { title: "e", output: "ok", metadata: {} },
  )
  await complete(hooks, sid, "Docs updated.")
  await idle(hooks, sid)
  assert("H-docs-only-no-stop", prompts === 0, `prompts=${prompts}`)

  clearLogs()
  const sid2 = "uat-h-review"
  await activate(hooks, sid2, "review this code for correctness and find security flaws")
  const inj = await systemInject(hooks, sid2)
  assert("H-review-recall", inj.includes("vertex:review-recall") && inj.includes("low-confidence"), "review inject")
}

// ===== I. Cap warn + holdout =====
console.log("\nI. Cap warn + holdout")
{
  clearLogs()
  let prompts = 0
  const mod = await import(pathToFileURL(DIST).href + `?t=${Date.now()}-i`)
  const entryI = mod.default?.server || mod.server || mod.default
  const hooks = await entryI(
    {
      client: { session: { prompt: async () => { prompts++; return {} } } },
      directory: worktree,
      worktree,
      project: {},
    },
    { maxStopBlocks: 1 },
  )
  const sid = "uat-cap"
  await activate(hooks, sid, "deep implement the plan")
  await edit(hooks, sid)
  await complete(hooks, sid, "Done.")
  await idle(hooks, sid)
  assert("I1-first-block", prompts === 1, `prompts=${prompts}`)
  await complete(hooks, sid, "Still done.")
  await idle(hooks, sid)
  assert("I1-second-warn-no-reprompt", prompts === 1, `prompts=${prompts}`)
  const warns = eventsOf("gate_fire", sid).filter((e) => e.payload?.decision === "warn")
  assert("I1-warn-event", warns.length >= 1, JSON.stringify(warns.slice(-1)))

  // Holdout
  clearLogs()
  prompts = 0
  process.env.VERTEX_HOLDOUT = "1"
  const off = Array.from({ length: 8000 }, (_, i) => `hold-${i}`).find((s) => meas.holdoutArm(s) === "off")
  const hooks2 = await entryI(
    {
      client: { session: { prompt: async () => { prompts++; return {} } } },
      directory: worktree,
      worktree,
      project: {},
    },
    { maxStopBlocks: 3 },
  )
  await activate(hooks2, off, "deep implement the plan")
  await edit(hooks2, off)
  await complete(hooks2, off, "Done.")
  await idle(hooks2, off)
  delete process.env.VERTEX_HOLDOUT
  assert("I2-holdout-no-prompt", prompts === 0, `prompts=${prompts}`)
  const allows = eventsOf("gate_fire", off).filter(
    (e) => e.payload?.decision === "allow" && e.payload?.would_block === true,
  )
  assert("I2-holdout-would-block", allows.length >= 1, JSON.stringify(allows.slice(-1)))
  assert("I2-holdout-suppress-event", eventsOf("holdout_suppress", off).length >= 1)

  // Cap path must also enqueue stop-warning for the next system.transform
  clearLogs()
  prompts = 0
  const hooksCap = await entryI(
    {
      client: { session: { prompt: async () => { prompts++; return {} } } },
      directory: worktree,
      worktree,
      project: {},
    },
    { maxStopBlocks: 1 },
  )
  const sidCap = "uat-cap-warn-inject"
  await activate(hooksCap, sidCap, "deep implement the plan")
  await edit(hooksCap, sidCap)
  await complete(hooksCap, sidCap, "Done.")
  await idle(hooksCap, sidCap)
  await complete(hooksCap, sidCap, "Still done.")
  await idle(hooksCap, sidCap)
  const injWarn = await systemInject(hooksCap, sidCap)
  assert("I3-stop-warning-inject", injWarn.includes("vertex:stop-warning"), injWarn.slice(0, 200))
}

// ===== J. Tool-failure + repeat-failure inject =====
console.log("\nJ. Tool-failure + repeat-failure inject")
{
  clearLogs()
  const { hooks } = await loadPlugin()
  const sid = "uat-j-fail"
  await activate(hooks, sid, "fix the failing test")
  await bash(hooks, sid, "npm test", "Error: expected true\n1 failed", 1)
  const inj = await systemInject(hooks, sid)
  assert("J1-tool-failure-inject", inj.includes("vertex:tool-failure"), inj.slice(0, 240))
  assert("J1-debug-failure", debugText().includes("failure recorded"), "debug mentions failure")

  clearLogs()
  const sid2 = "uat-j-repeat"
  await activate(hooks, sid2, "fix the flaky test")
  // Same exit + first error line → same signature → repeat on 2nd
  await bash(hooks, sid2, "npm test", "Error: boom\nFAIL", 1)
  await bash(hooks, sid2, "npm test", "Error: boom\nFAIL again", 1)
  const inj2 = await systemInject(hooks, sid2)
  assert("J2-repeat-failure-inject", inj2.includes("vertex:repeat-failure"), inj2.slice(0, 240))
  assert(
    "J2-recovery-repeat-event",
    eventsOf("recovery_repeat", sid2).length >= 1,
    JSON.stringify(eventsOf("recovery_repeat", sid2).slice(-1)),
  )
  assert("J2-debug-repeat", debugText().includes("REPEAT FAILURE"), "debug mentions repeat")

  // Non-zero non-verifier still queues tool-failure (any bash exit != 0)
  clearLogs()
  const sid3 = "uat-j-any-bash"
  await activate(hooks, sid3, "run a command")
  await bash(hooks, sid3, "false", "failed", 1)
  const inj3 = await systemInject(hooks, sid3)
  assert("J3-any-bash-nonzero-failure", inj3.includes("vertex:tool-failure"), inj3.slice(0, 200))
}

// ===== K. Signal-routed injects (investigation / grounding / ledger / normal) =====
console.log("\nK. Signal-routed procedure + ledger inject")
{
  clearLogs()
  const { hooks } = await loadPlugin()

  const sidDbg = "uat-k-debug"
  await activate(hooks, sidDbg, "debug why the authentication test is failing")
  const injDbg = await systemInject(hooks, sidDbg)
  assert("K1-investigation-inject", injDbg.includes("vertex:investigation"), "investigation present")
  assert(
    "K1-classify-debugging",
    eventsOf("classify", sidDbg).some((e) => e.payload?.mode === "debugging"),
    JSON.stringify(eventsOf("classify", sidDbg).slice(-1)),
  )
  assert("K1-debug-mode", debugText().includes("mode=debugging"), "debug log mode=debugging")

  clearLogs()
  const sidRen = "uat-k-render"
  await activate(hooks, sidRen, "build an HTML dashboard and render the chart")
  const injRen = await systemInject(hooks, sidRen)
  assert("K2-grounding-inject", injRen.includes("vertex:grounding"), "grounding present")
  assert(
    "K2-classify-render",
    eventsOf("classify", sidRen).some((e) => e.payload?.mode === "render"),
    JSON.stringify(eventsOf("classify", sidRen).slice(-1)),
  )

  clearLogs()
  const sidLed = "uat-k-ledger"
  await activate(hooks, sidLed, "deep implement the plan")
  await edit(hooks, sidLed)
  await bash(hooks, sidLed, "npm test", "3 failed", 1)
  const injLed = await systemInject(hooks, sidLed)
  assert("K3-ledger-inject", injLed.includes("vertex:ledger"), "ledger summary injected")
  assert("K3-ledger-files", /files changed:\s*yes/i.test(injLed), injLed.slice(0, 300))

  clearLogs()
  const sidNorm = "uat-k-normal"
  await activate(hooks, sidNorm, "fix the parser bug")
  const injNorm = await systemInject(hooks, sidNorm)
  assert(
    "K4-normal-advisory",
    injNorm.includes("vertex:verification-advisory"),
    "normal mode advisory",
  )
  assert("K4-no-required", !injNorm.includes("vertex:verification-required"), "not deep required")
}

// ===== L. Queue lifecycle (H5) =====
console.log("\nL. Queue lifecycle (messages.transform / compaction / isolation)")
{
  clearLogs()
  const { hooks } = await loadPlugin()
  await activate(hooks, "uat-l-s1", "fix one")
  await activate(hooks, "uat-l-s2", "fix two")
  hooks.enqueue("uat-l-s1", { id: "only-s1", text: "private to s1" })
  hooks.enqueue("uat-l-s2", { id: "only-s2", text: "private to s2" })
  const i1 = await systemInject(hooks, "uat-l-s1")
  const i2 = await systemInject(hooks, "uat-l-s2")
  assert("L1-session-isolation-s1", i1.includes("only-s1") && !i1.includes("only-s2"), "s1 only")
  assert("L1-session-isolation-s2", i2.includes("only-s2") && !i2.includes("only-s1"), "s2 only")

  // messages.transform must not drain
  hooks.enqueue("uat-l-msg", { id: "keep-me", text: "must survive messages.transform" })
  await activate(hooks, "uat-l-msg", "fix msg")
  if (typeof hooks["experimental.chat.messages.transform"] === "function") {
    await hooks["experimental.chat.messages.transform"](
      {},
      { messages: [{ info: { id: "m", sessionID: "uat-l-msg", role: "user" }, parts: [] }] },
    )
  }
  const afterMsg = await systemInject(hooks, "uat-l-msg")
  assert("L2-messages-no-drain", afterMsg.includes("keep-me"), afterMsg.slice(0, 200))

  // compaction holds queue until session.compacted
  await activate(hooks, "uat-l-cmp", "fix compact")
  hooks.enqueue("uat-l-cmp", { id: "after-compaction", text: "deliver after compaction" })
  await hooks["experimental.session.compacting"]({ sessionID: "uat-l-cmp" }, { context: [] })
  const during = await systemInject(hooks, "uat-l-cmp")
  assert("L3-compaction-holds", !during.includes("after-compaction"), "held during compact")
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "uat-l-cmp" } } })
  const afterCmp = await systemInject(hooks, "uat-l-cmp")
  assert("L3-compaction-releases", afterCmp.includes("after-compaction"), "released after compacted")

  // failed compaction: next chat.message releases
  await activate(hooks, "uat-l-cmp2", "fix compact2")
  hooks.enqueue("uat-l-cmp2", { id: "after-failed-compaction", text: "still deliver this" })
  await hooks["experimental.session.compacting"]({ sessionID: "uat-l-cmp2" }, { context: [] })
  const during2 = await systemInject(hooks, "uat-l-cmp2")
  assert("L4-failed-cmp-holds", !during2.includes("after-failed-compaction"), "held")
  await activate(hooks, "uat-l-cmp2", "continue after failed compaction")
  const resumed = await systemInject(hooks, "uat-l-cmp2")
  assert("L4-failed-cmp-releases", resumed.includes("after-failed-compaction"), "released on next message")
}

// ===== M. file.edited host event =====
console.log("\nM. file.edited host mutation")
{
  clearLogs()
  let prompts = 0
  const { hooks } = await loadPlugin(async () => {
    prompts++
    return {}
  })
  const sid = "uat-m-file"
  await activate(hooks, sid, "deep implement the plan")
  await hooks.event({
    event: { type: "file.edited", properties: { file: join(worktree, "scratch.ts") } },
  })
  await complete(hooks, sid, "Done via host edit.")
  await idle(hooks, sid)
  assert("M1-file-edited-blocks", prompts >= 1, `prompts=${prompts}`)
  assert("M1-debug-changed", debugText().includes("file changed") || prompts >= 1, "mutation observed")

  // multi-active: no attribution to innocent session
  clearLogs()
  prompts = 0
  await activate(hooks, "uat-m-editor", "deep implement the plan")
  await activate(hooks, "uat-m-innocent", "deep review the plan")
  await hooks.event({
    event: { type: "file.edited", properties: { file: join(worktree, "other.ts") } },
  })
  await complete(hooks, "uat-m-innocent", "Review complete.")
  await idle(hooks, "uat-m-innocent")
  assert("M2-multi-active-no-attr", prompts === 0, `prompts=${prompts}`)
}

// ===== N. Promise-no-act cap warn =====
console.log("\nN. Promise-no-act cap → warn inject")
{
  clearLogs()
  let prompts = 0
  const mod = await import(pathToFileURL(DIST).href + `?t=${Date.now()}-n`)
  const entryN = mod.default?.server || mod.server || mod.default
  const hooks = await entryN(
    {
      client: { session: { prompt: async () => { prompts++; return {} } } },
      directory: worktree,
      worktree,
      project: {},
    },
    { maxStopBlocks: 1 },
  )
  const sid = "uat-n-promise-cap"
  // normal mode: stop won't hard-block; promise will
  await activate(hooks, sid, "fix the parser")
  await edit(hooks, sid)
  await complete(hooks, sid, "TODO: I will finish the remaining tests later.")
  await idle(hooks, sid)
  assert("N1-promise-first-block", prompts === 1, `prompts=${prompts}`)
  await complete(hooks, sid, "TODO: still deferred for later.")
  await idle(hooks, sid)
  assert("N1-promise-cap-no-reprompt", prompts === 1, `prompts=${prompts}`)
  const warns = eventsOf("gate_fire", sid).filter((e) => e.payload?.decision === "warn")
  assert("N1-promise-warn-event", warns.length >= 1, JSON.stringify(warns.slice(-1)))
  const inj = await systemInject(hooks, sid)
  assert("N1-promise-warn-inject", inj.includes("vertex:promise-no-act-warn"), inj.slice(0, 240))
}

// ===== O. session.prompt throw fail-open =====
console.log("\nO. session.prompt throw fail-open")
{
  clearLogs()
  const mod = await import(pathToFileURL(DIST).href + `?t=${Date.now()}-o`)
  const entryO = mod.default?.server || mod.server || mod.default
  const hooks = await entryO(
    {
      client: {
        session: {
          prompt: async () => {
            throw new Error("prompt boom")
          },
        },
      },
      directory: worktree,
      worktree,
      project: {},
    },
    { maxStopBlocks: 3 },
  )
  const sid = "uat-o-throw"
  await activate(hooks, sid, "deep implement the plan")
  await edit(hooks, sid)
  await complete(hooks, sid, "Done.")
  await idle(hooks, sid)
  const fires = eventsOf("gate_fire", sid)
  const last = fires[fires.length - 1]
  assert(
    "O1-throw-allow-would-block",
    last?.payload?.decision === "allow" && last?.payload?.would_block === true,
    JSON.stringify(last?.payload),
  )
  assert(
    "O1-throw-reason",
    last?.payload?.reason === "session.prompt failed" || /prompt/i.test(String(last?.payload?.reason || "")),
    JSON.stringify(last?.payload),
  )
  assert("O1-not-fake-block", !fires.some((e) => e.payload?.decision === "block"), "no block claim")
  const inj = await systemInject(hooks, sid)
  assert("O1-queue-survives", inj.includes("vertex:stop-block"), "queue kept for transform")
}

// ===== P. /dev/null probe does not poison docs-only =====
console.log("\nP. /dev/null non-mutation + docs-only")
{
  clearLogs()
  let prompts = 0
  const { hooks, mod } = await loadPlugin(async () => {
    prompts++
    return {}
  })
  assert(
    "P1-devnull-not-mutating",
    mod.isMutatingBashCommand("cat ~/.config/.elicify-vertex-consent 2>/dev/null") === false,
  )
  assert("P1-real-redirect-mutating", mod.isMutatingBashCommand("echo x > out.txt") === true)

  const sid = "uat-p-docs"
  await activate(hooks, sid, "deep thorough documentation pass")
  await bash(hooks, sid, "cat ~/.config/.elicify-vertex-consent 2>/dev/null", "yes\n", 0)
  await hooks["tool.execute.after"](
    { tool: "edit", sessionID: sid, callID: "d", args: { filePath: join(worktree, "NOTES.md") } },
    { title: "e", output: "ok", metadata: {} },
  )
  await complete(hooks, sid, "Docs only.")
  await idle(hooks, sid)
  assert("P2-docs-after-devnull-no-stop", prompts === 0, `prompts=${prompts}`)
}

// ===== Summary =====
console.log("\n" + "=".repeat(60))
const passed = results.filter((r) => r.ok).length
const total = results.length
console.log(`UAT RESULT: ${passed}/${total} passed, ${failed} failed`)
console.log(`Artifacts: ${uatRoot}`)
console.log(`Events:    ${join(dataRoot, ".vertex-events.jsonl")}`)
console.log(`Debug:     ${join(uatRoot, ".config/opencode/.vertex-debug.log")}`)

// Coverage checklist of inject IDs exercised this run
const injectIds = [
  "vertex:contract",
  "vertex:verification-required",
  "vertex:verification-advisory",
  "vertex:investigation",
  "vertex:grounding",
  "vertex:review-recall",
  "vertex:ledger",
  "vertex:tool-failure",
  "vertex:repeat-failure",
  "vertex:stop-block",
  "vertex:stop-warning",
  "vertex:promise-no-act",
  "vertex:promise-no-act-warn",
]
const eventTypes = ["classify", "gate_fire", "holdout_suppress", "recovery_repeat"]
console.log("\nInject ID coverage (harness scenarios):")
for (const id of injectIds) console.log(`  - ${id}`)
console.log("Event types covered:")
for (const t of eventTypes) console.log(`  - ${t}`)
console.log("Note: measurement 'outcome' is a builder only (not emitted by plugin hot path).")

if (failed > 0) {
  console.log("\nFailures:")
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.id}: ${r.detail}`)
  process.exitCode = 1
} else {
  console.log("\nAll UAT scenarios passed.")
  // keep artifacts for inspection unless VERTEX_UAT_KEEP=0
  if (process.env.VERTEX_UAT_KEEP === "0") rmSync(uatRoot, { recursive: true, force: true })
}
