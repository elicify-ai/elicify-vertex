#!/usr/bin/env node
/**
 * elicify-vertex — host-faithful UAT harness (v2).
 *
 * Replaces the v1 harness that was deleted along with the v1 plugin. That one
 * loaded `dist/index.js` and drove `elicify_vertex_goal_*`; neither exists any
 * more, so it could not be repaired — only rewritten.
 *
 * WHAT THIS IS FOR. The unit suite stubs the plugin's collaborators. This
 * drives the REAL BUILT ARTEFACT — `dist/plugin.js`, exactly what npm ships —
 * through OpenCode-shaped hook calls, against a real temporary worktree, with
 * real files on disk. It is the layer that catches "the code is right but the
 * shipped thing is wrong": a stale build, a broken export, an entry point that
 * does not load, a subprocess writing over the TUI.
 *
 * WHAT IT IS NOT. It does not call a model. Every subturn (verifier, intake,
 * pause judge) is answered by a scripted stub, so scenarios are deterministic
 * and free. For a real provider, see `scripts/uat-opencode-live.sh`.
 *
 * ISOLATION. Each run gets its own worktree, `VERTEX_DATA`, and
 * `XDG_CONFIG_HOME`, so it never reads or writes the operator's real plans,
 * event log, or star-consent file.
 *
 *   node scripts/uat-harness.mjs           # all sections
 *   node scripts/uat-harness.mjs --only=C  # one section
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const DIST = process.env.VERTEX_UAT_DIST || join(ROOT, "dist/plugin.js")
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7)

// The pause judge waits 60s in production. UAT drives the real timer path, so
// it is shortened here — otherwise the feature would get no end-to-end cover.
const PAUSE_MS = 250
process.env.VERTEX_PAUSE_DELAY_MS = String(PAUSE_MS)

const uatRoot = mkdtempSync(join(tmpdir(), "vertex-uat-"))
const dataRoot = join(uatRoot, "data")
const configRoot = join(uatRoot, "config")
mkdirSync(dataRoot, { recursive: true })
mkdirSync(join(configRoot, "opencode"), { recursive: true })
process.env.VERTEX_DATA = dataRoot
process.env.XDG_CONFIG_HOME = configRoot

let passed = 0
const failures = []

function assert(id, ok, detail = "") {
  if (ok) {
    passed++
    console.log(`  PASS  ${id}${detail ? " — " + detail : ""}`)
  } else {
    failures.push(`${id}${detail ? " — " + detail : ""}`)
    console.log(`  FAIL  ${id}${detail ? " — " + detail : ""}`)
  }
}

function section(title) {
  if (ONLY && !title.startsWith(ONLY)) return false
  console.log(`\n${title}`)
  return true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function events() {
  const p = join(dataRoot, ".vertex-events.jsonl")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}
const eventTypes = () => events().map((e) => e.event_type)
const clearEvents = () => writeFileSync(join(dataRoot, ".vertex-events.jsonl"), "")

/**
 * A fresh worktree + a fresh plugin instance per scenario. Module state
 * (session maps, timers, the star sets) is per-instance, so scenarios must not
 * share one or they leak into each other.
 */
async function scenario({ subturn, files } = {}) {
  const work = mkdtempSync(join(uatRoot, "work-"))
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "uat", scripts: { test: "echo ok" } }, null, 2))
  for (const [name, body] of Object.entries(files ?? {})) {
    mkdirSync(dirname(join(work, name)), { recursive: true })
    writeFileSync(join(work, name), body)
  }

  const prompts = []
  const client = {
    session: {
      prompt: async (args) => {
        prompts.push(args)
        const agent = args?.body?.agent
        if (agent && subturn) {
          const text = subturn(agent, args)
          if (text !== undefined) return { data: { info: {}, parts: [{ type: "text", text }] }, error: undefined }
        }
        return { data: { info: {}, parts: [] }, error: undefined }
      },
      messages: async () => ({ data: [] }),
      create: async () => ({ data: { id: `child-${Math.random().toString(36).slice(2)}` } }),
      delete: async () => ({ data: {} }),
    },
    app: {
      agents: async () => ({
        data: [
          {
            name: "vertex-verifier",
            mode: "subagent",
            permission: {
              "*": "deny",
              read: "allow",
              grep: "allow",
              glob: "allow",
              list: "allow",
              bash: "allow",
              edit: "deny",
              write: "deny",
              webfetch: "deny",
              task: "deny",
            },
            tools: { bash: true, read: true, glob: true, grep: true, list: true, edit: false, write: false, "*": false },
            options: {},
          },
        ],
      }),
    },
    tool: { ids: async () => ({ data: ["bash", "read", "glob", "grep", "list"] }) },
  }

  const mod = await import(pathToFileURL(DIST).href + `?t=${Date.now()}-${Math.random()}`)
  const entry = mod.default?.server ?? mod.server ?? mod.default
  const hooks = await entry({ client, directory: work, worktree: work, project: { id: "uat" } }, undefined)

  const sid = `uat-${Math.random().toString(36).slice(2)}`
  const api = {
    hooks,
    sid,
    work,
    prompts,
    /** Continuations sent to the parent session (no agent tag). */
    sent: () => prompts.filter((p) => !p?.body?.agent).map((p) => String(p?.body?.parts?.[0]?.text ?? "")),
    /** Subturn prompts, by agent. */
    subturns: (agent) => prompts.filter((p) => p?.body?.agent === agent),
    say: async (text, model = { providerID: "anthropic", modelID: "claude-opus-4" }) => {
      const out = { message: { id: `m${Math.random()}` }, parts: [{ type: "text", text }] }
      await hooks["chat.message"]({ sessionID: sid, agent: "elicify-vertex-agent", model }, out)
      return out
    },
    assistant: async (text) =>
      hooks["experimental.text.complete"]({ sessionID: sid, messageID: `a${Math.random()}`, partID: "p" }, { text }),
    tool: async (tool, args, output = "ok") =>
      hooks["tool.execute.after"]({ tool, sessionID: sid, callID: `c${Math.random()}`, args }, { title: tool, output, metadata: {} }),
    idle: async () => hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } }),
    system: async () => {
      const out = { system: [] }
      await hooks["experimental.chat.system.transform"]({ sessionID: sid, model: { providerID: "anthropic", id: "claude-opus-4" } }, out)
      return out.system.join("\n")
    },
  }
  return api
}

// ===========================================================================
console.log(`elicify-vertex UAT — dist=${DIST}`)
console.log(`worktree root=${uatRoot}`)
console.log(`VERTEX_DATA=${dataRoot}  XDG_CONFIG_HOME=${configRoot}`)

// --- A. The shipped artefact loads and registers ---------------------------
if (section("A. Shipped artefact")) {
  const s = await scenario()
  assert("A1-hooks", typeof s.hooks["chat.message"] === "function" && typeof s.hooks.event === "function")
  assert("A2-tools", Object.keys(s.hooks.tool ?? {}).length === 7, `${Object.keys(s.hooks.tool ?? {}).length} tools`)
  const cfg = { agent: {}, command: {} }
  await s.hooks.config?.(cfg)
  const agents = Object.keys(cfg.agent)
  assert("A3-verifier-agent", agents.includes("vertex-verifier"), agents.join(","))
  assert("A4-no-legacy-judge-agent", !agents.includes("vertex-judge"), agents.join(","))
}

// --- B. Activation and the two stop modes ----------------------------------
if (section("B. Activation and stop modes")) {
  const s = await scenario()
  const out = await s.say("/elicify-vertex\n\nbuild the reporting dashboard")
  assert("B1-activation-cue", out.parts.length > 1, `${out.parts.length} parts`)
  const cue = out.parts.map((p) => p.text ?? "").join(" ")
  assert("B2-mode-normal-not-quick", cue.includes("stopMode=normal"), cue.trim().slice(0, 60))

  const deep = await scenario()
  const dOut = await deep.say("/elicify-vertex\n\ndeploy the auth migration to production")
  assert("B3-mode-deep-on-risk", dOut.parts.map((p) => p.text ?? "").join(" ").includes("stopMode=deep"))

  const greeting = await scenario()
  const gOut = await greeting.say("/elicify-vertex\n\nhi")
  assert(
    "B4-greeting-is-normal-not-suppressed",
    gOut.parts.map((p) => p.text ?? "").join(" ").includes("stopMode=normal"),
  )
}

// --- C. Pause judge --------------------------------------------------------
if (section("C. Pause judge (real timer path)")) {
  // C1: awaiting-user -> silence. This is the live misfire that motivated it.
  clearEvents()
  const quiet = await scenario({ subturn: () => '{"verdict":"awaiting-user"}' })
  await quiet.say("/elicify-vertex\n\nbuild the gaming portal")
  await quiet.assistant("Green-light this and I'll create the plan and start.")
  await quiet.idle()
  await sleep(PAUSE_MS + 400)
  assert("C1-awaiting-user-silent", quiet.sent().filter((t) => t.includes("part-way through work")).length === 0)
  assert("C2-verdict-logged", eventTypes().includes("pause:verdict"), eventTypes().slice(-4).join(","))

  // C2: stopped-mid-work -> exactly one nudge.
  const stalled = await scenario({ subturn: () => '{"verdict":"stopped-mid-work"}' })
  await stalled.say("/elicify-vertex\n\nbuild the gaming portal")
  await stalled.assistant("Let me lay out the plan and execute.")
  await stalled.idle()
  await sleep(PAUSE_MS + 400)
  const nudges = stalled.sent().filter((t) => t.includes("part-way through work"))
  assert("C3-stopped-mid-work-nudges", nudges.length === 1, `${nudges.length} nudges`)
  assert("C4-no-harness-marker", !nudges.some((t) => /\[vertex/.test(t)))

  // C3: activity cancels the pending judgement.
  const busy = await scenario({ subturn: () => '{"verdict":"stopped-mid-work"}' })
  await busy.say("/elicify-vertex\n\nbuild it")
  await busy.assistant("Let me lay out the plan and execute.")
  await busy.idle()
  await busy.tool("edit", { filePath: join(busy.work, "src.ts") })
  await sleep(PAUSE_MS + 400)
  assert("C5-activity-cancels", busy.sent().filter((t) => t.includes("part-way through work")).length === 0)

  // C4: an unreadable verdict is silence, not a licence to nudge.
  const garbled = await scenario({ subturn: () => "probably waiting? hard to say" })
  await garbled.say("/elicify-vertex\n\nbuild it")
  await garbled.assistant("Let me lay out the plan and execute.")
  await garbled.idle()
  await sleep(PAUSE_MS + 400)
  assert("C6-unreadable-verdict-silent", garbled.sent().filter((t) => t.includes("part-way through work")).length === 0)
}

// --- D. Star ask -----------------------------------------------------------
if (section("D. One-time star ask")) {
  const consentPath = join(configRoot, "opencode", ".elicify-vertex-consent")
  if (existsSync(consentPath)) rmSync(consentPath)

  const s = await scenario()
  await s.say("/elicify-vertex\n\nbuild it")
  assert("D1-not-in-system-prompt", !(await s.system()).includes("star elicify-ai/elicify-vertex"))
  assert("D2-nothing-burned-at-arm", !existsSync(consentPath))

  await s.idle()
  await sleep(PAUSE_MS + 400)
  const asks = s.sent().filter((t) => t.includes("star elicify-ai/elicify-vertex"))
  assert("D3-asked-on-quiet-turn", asks.length === 1, `${asks.length} asks`)
  assert("D4-still-not-burned", !existsSync(consentPath))

  // An unrelated question must not count as the ask.
  await s.tool("question", { questions: [{ question: "Which games?" }] })
  assert("D5-unrelated-question-ignored", !existsSync(consentPath))

  // The real ask closes the loop.
  await s.tool("question", { questions: [{ question: "Would you like to star elicify-ai/elicify-vertex on GitHub?" }] })
  assert("D6-observed-ask-recorded", existsSync(consentPath) && readFileSync(consentPath, "utf8").trim() === "asked")
}

// --- E. Verifier audit -----------------------------------------------------
if (section("E. Verifier audit")) {
  clearEvents()
  const s = await scenario({
    subturn: (agent) =>
      agent === "vertex-verifier"
        ? '{"stories":[{"storyId":"S1","pass":false,"summary":"not delivered","items":[{"itemId":"A1","met":false,"note":"no sources cited"}]}]}'
        : undefined,
  })
  await s.say("/elicify-vertex\n\nbuild the research portal")
  await s.hooks.tool.elicify_vertex_plan_create.execute(
    {
      stories: [
        { text: "Ship it", acceptanceItems: ["x.md cites sources"], scopeGlobs: [], verifiers: ["test -f x.md"], tasks: [{ text: "write it" }] },
      ],
    },
    { sessionID: s.sid },
  )
  await s.tool("edit", { filePath: join(s.work, "x.md") })
  await s.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: s.sid })
  await s.idle()

  assert("E1-verifier-ran", s.subturns("vertex-verifier").length > 0)
  assert("E2-audit-logged", eventTypes().includes("story:verifier-audit"), eventTypes().slice(-5).join(","))
  const plan = JSON.parse(await s.hooks.tool.elicify_vertex_plan_status.execute({}, { sessionID: s.sid }))
  assert("E3-story-reverted", plan.stories?.[0]?.status === "active", plan.stories?.[0]?.status)
  assert("E4-no-legacy-judge-field", !("judge" in (plan.stories?.[0] ?? {})))
}

// --- F. No subprocess output reaches the terminal --------------------------
if (section("F. TUI safety")) {
  // The verifier payload shells out to `git diff --stat`. Outside a repo git
  // prints its whole usage page to stderr, and Node inherits a child's stderr
  // by default — which lands on the terminal, past the TUI's renderer.
  const probe = `
    process.env.VERTEX_DATA=${JSON.stringify(dataRoot)}
    process.env.XDG_CONFIG_HOME=${JSON.stringify(configRoot)}
    const mod = await import(${JSON.stringify(pathToFileURL(DIST).href)})
    // The verifier agent MUST be registered, or the capability probe refuses,
    // the payload is never built, \`git diff --stat\` never runs, and this
    // assertion passes without exercising anything (it did, twice).
    const client = { session:{
        prompt:async(a)=>({data:{info:{},parts:[{type:'text',text: a?.body?.agent ? '{\"stories\":[]}' : ''}]}}),
        messages:async()=>({data:[]}), create:async()=>({data:{id:'c'}}), delete:async()=>({data:{}}) },
      app:{agents:async()=>({data:[{ name:'vertex-verifier', mode:'subagent',
        permission:{'*':'deny',read:'allow',grep:'allow',glob:'allow',list:'allow',bash:'allow',edit:'deny',write:'deny',webfetch:'deny',task:'deny'},
        tools:{bash:true,read:true,glob:true,grep:true,list:true,edit:false,write:false,'*':false}, options:{} }]})},
      tool:{ids:async()=>({data:['bash','read','glob','grep','list']})} }
    const entry = mod.default?.server ?? mod.server ?? mod.default
    const hooks = await entry({ client, directory:${JSON.stringify(uatRoot)}, worktree:${JSON.stringify(uatRoot)} }, undefined)
    const sid='tui-probe'
    await hooks['chat.message']({sessionID:sid,agent:'elicify-vertex-agent',model:{providerID:'anthropic',modelID:'claude-opus-4'}},
      {message:{id:'m1'},parts:[{type:'text',text:'/elicify-vertex build it'}]})
    // A PLAN is required: \`git diff --stat\` runs only while building the
    // verifier payload, so without a completed story the probe never reaches
    // the subprocess and would pass vacuously (it did, until this was fixed).
    await hooks.tool.elicify_vertex_plan_create.execute(
      { stories:[{ text:'Ship', acceptanceItems:['A1'], scopeGlobs:[], verifiers:[], tasks:[{text:'do'}] }] },
      { sessionID: sid })
    await hooks['tool.execute.after']({tool:'edit',sessionID:sid,callID:'c1',args:{filePath:'a.ts'}},{title:'edit',output:'ok',metadata:{}})
    await hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId:'S1.T1', status:'complete' }, { sessionID: sid })
    await hooks.event({event:{type:'session.idle',properties:{sessionID:sid}}})
  `
  // `spawnSync`, not `execFileSync`: the latter only surfaces stderr on the
  // THROW path, and the harness fails open so the child exits 0 — which meant
  // this assertion discarded the very output it exists to detect and passed
  // with the guard removed. Caught by mutating the build and finding the test
  // still green.
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stderr = String(run.stderr ?? "")
  assert("F1-no-stderr-flood", stderr.length === 0, `${stderr.length} bytes: ${stderr.slice(0, 80)}`)
}

// --- G. Fail-open ----------------------------------------------------------
if (section("G. Fail-open")) {
  const hostile = await scenario({
    subturn: () => {
      throw new Error("provider exploded")
    },
  })
  let threw = null
  try {
    await hostile.say("/elicify-vertex\n\nbuild it")
    await hostile.assistant("Let me lay out the plan and execute.")
    await hostile.idle()
    await sleep(PAUSE_MS + 400)
  } catch (err) {
    threw = err
  }
  assert("G1-no-throw-into-host", threw === null, threw ? String(threw.message) : "")
  assert("G2-silent-on-failure", hostile.sent().filter((t) => t.includes("part-way through work")).length === 0)
}

// ===========================================================================
console.log("")
if (failures.length === 0) {
  console.log(`All UAT scenarios passed. (${passed} assertions)`)
  rmSync(uatRoot, { recursive: true, force: true })
  process.exit(0)
}
console.log(`${failures.length} FAILED of ${passed + failures.length}:`)
for (const f of failures) console.log(`  - ${f}`)
console.log(`\nArtefacts left for inspection: ${uatRoot}`)
process.exit(1)
