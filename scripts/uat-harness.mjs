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
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
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
 * A fresh worktree + a fresh plugin instance per scenario.
 *
 * Note what this does NOT isolate: `dist/plugin.js` is a thin re-export, so
 * `?t=` re-instantiates only the shim — everything under `dist/v2/**`,
 * including gate.ts's module-level `pauseTimers` / `pauseEpochs` /
 * `pauseInFlight` / `continuationTicket`, is shared for the whole run.
 * Isolation actually comes from the random session id, which is why every
 * scenario must use its own.
 */
async function scenario({ subturn, files, echoContinuations = false } = {}) {
  const work = mkdtempSync(join(uatRoot, "work-"))
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "uat", scripts: { test: "echo ok" } }, null, 2))
  for (const [name, body] of Object.entries(files ?? {})) {
    mkdirSync(dirname(join(work, name)), { recursive: true })
    writeFileSync(join(work, name), body)
  }

  const prompts = []
  const echoed = new Set()
  let api = null
  const client = {
    session: {
      prompt: async (args) => {
        prompts.push(args)
        const agent = args?.body?.agent
        if (agent && subturn) {
          const text = subturn(agent, args)
          if (text !== undefined) return { data: { info: {}, parts: [{ type: "text", text }] }, error: undefined }
        }
        // Host-faithful echo: a continuation comes back as a chat.message
        // BEFORE this promise settles.
        if (!agent && echoContinuations && api) {
          const text = String(args?.body?.parts?.[0]?.text ?? "")
          if (text && !echoed.has(text)) {
            echoed.add(text)
            await api.say(text)
          }
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
  api = {
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
  // 9. Two tools were added in the same round by separate workstreams, and
  // BOTH branches independently wrote `8` — so git merged them without a
  // conflict on the number itself. The real count is 6 plan tools + star +
  // star_status + scope_amend.
  //   B-6: `elicify_vertex_star_status` — read-only consent check.
  //   B-2: `elicify_vertex_scope_amend` — makes the scope-watchdog directive's
  //        "fold / amend / revert" offer actionable, and its compliance
  //        measurable at all.
  assert("A2-tools", Object.keys(s.hooks.tool ?? {}).length === 9, `${Object.keys(s.hooks.tool ?? {}).length} tools`)
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
  // C1/C2: awaiting-user -> silence. This is the live misfire that motivated it.
  clearEvents()
  const quiet = await scenario({ subturn: () => '{"verdict":"awaiting-user"}' })
  await quiet.say("/elicify-vertex\n\nbuild the gaming portal")
  await quiet.assistant("Green-light this and I'll create the plan and start.")
  await quiet.idle()
  await sleep(PAUSE_MS + 400)
  assert("C1-awaiting-user-silent", quiet.sent().filter((t) => t.includes("part-way through work")).length === 0)
  assert("C2-verdict-logged", eventTypes().includes("pause:verdict"), eventTypes().slice(-4).join(","))

  // C3/C4: stopped-mid-work -> exactly one nudge, no marker.
  const stalled = await scenario({ subturn: () => '{"verdict":"stopped-mid-work"}' })
  await stalled.say("/elicify-vertex\n\nbuild the gaming portal")
  await stalled.assistant("Let me lay out the plan and execute.")
  await stalled.idle()
  await sleep(PAUSE_MS + 400)
  const nudges = stalled.sent().filter((t) => t.includes("part-way through work"))
  assert("C3-stopped-mid-work-nudges", nudges.length === 1, `${nudges.length} nudges`)
  assert("C4-no-harness-marker", !nudges.some((t) => /\[vertex/.test(t)))

  // C5: activity cancels the pending judgement.
  const busy = await scenario({ subturn: () => '{"verdict":"stopped-mid-work"}' })
  await busy.say("/elicify-vertex\n\nbuild it")
  await busy.assistant("Let me lay out the plan and execute.")
  await busy.idle()
  await busy.tool("edit", { filePath: join(busy.work, "src.ts") })
  await sleep(PAUSE_MS + 400)
  assert("C5-activity-cancels", busy.sent().filter((t) => t.includes("part-way through work")).length === 0)

  // C6: an unreadable verdict is silence, not a licence to nudge.
  const garbled = await scenario({ subturn: () => "probably waiting? hard to say" })
  await garbled.say("/elicify-vertex\n\nbuild it")
  await garbled.assistant("Let me lay out the plan and execute.")
  await garbled.idle()
  await sleep(PAUSE_MS + 400)
  assert("C6-unreadable-verdict-silent", garbled.sent().filter((t) => t.includes("part-way through work")).length === 0)
}

// --- D. Star ask -----------------------------------------------------------
// B-6: the runtime arm/inject/retry loop is DELETED. The ask lives in the agent
// prompt, gated by the read-only `elicify_vertex_star_status` tool; the harness
// only OBSERVES a real `question` call about our repo and records `asked`.
if (section("D. One-time star ask")) {
  const consentPath = join(configRoot, "opencode", ".elicify-vertex-consent")
  if (existsSync(consentPath)) rmSync(consentPath)

  const consentState = () => {
    if (!existsSync(consentPath)) return null
    const raw = readFileSync(consentPath, "utf8").trim()
    try {
      return JSON.parse(raw).state ?? null
    } catch {
      return raw || null
    }
  }

  const s = await scenario()
  const statusOf = async (sc) =>
    JSON.parse(await sc.hooks.tool.elicify_vertex_star_status.execute({}, { sessionID: sc.sid })).consent

  await s.say("/elicify-vertex\n\nbuild it")
  assert("D1-status-none-on-a-fresh-machine", (await statusOf(s)) === "none")
  assert("D2-status-check-writes-nothing", !existsSync(consentPath))

  await s.idle()
  await sleep(PAUSE_MS + 400)
  // No injection, ever — the loop that used to arm one here is gone.
  assert(
    "D3-no-injection-on-a-quiet-turn",
    !(await s.system()).includes("elicify-ai/elicify-vertex"),
    "the deleted nagging loop is back",
  )
  assert(
    "D3b-never-a-continuation",
    s.sent().filter((t) => t.includes("star elicify-ai")).length === 0,
    "leaked into chat",
  )
  assert("D4-still-not-burned", consentState() === null, String(consentState()))

  // A question mentioning "star" but not OUR repo must not count — a bare
  // substring check burned the one-shot on exactly this shape.
  await s.tool("question", { questions: [{ question: "Which star rating should the widget default to?" }] })
  assert("D5-star-word-question-ignored", consentState() === null, String(consentState()))

  // The agent's real ask, on its own initiative, is what spends the one-shot.
  await s.tool("question", { questions: [{ question: "Would you like to star elicify-ai/elicify-vertex on GitHub?" }] })
  assert("D6-observed-ask-recorded", consentState() === "asked", String(consentState()))
  assert("D6b-status-reflects-it", (await statusOf(s)) === "asked")
  assert(
    "D6c-no-attempts-field",
    !Object.hasOwn(JSON.parse(readFileSync(consentPath, "utf8")), "attempts"),
    readFileSync(consentPath, "utf8"),
  )

  // MAJ-007 + B-6: neither legacy marker is a user decision. `prompted` was
  // written at ARM time; `gave-up` recorded that a MODEL ignored an instruction
  // the user never saw. Both must read as NO RECORD, in the same branch.
  for (const [id, contents] of [
    ["D7-legacy-prompted-ignored", "prompted"],
    ["D7b-legacy-gave-up-ignored", "gave-up"],
    ["D7c-legacy-gave-up-json-ignored", JSON.stringify({ state: "gave-up", attempts: 4 })],
  ]) {
    writeFileSync(consentPath, contents)
    const legacy = await scenario()
    await legacy.say("/elicify-vertex\n\nbuild it")
    assert(id, (await statusOf(legacy)) === "none", `${contents} suppressed the ask`)
  }

  // Guard the guard: a REAL decision carrying a stale attempts field survives.
  writeFileSync(consentPath, JSON.stringify({ state: "declined", attempts: 3 }))
  const decided = await scenario()
  await decided.say("/elicify-vertex\n\nbuild it")
  assert("D7d-real-decision-honoured", (await statusOf(decided)) === "declined")
  rmSync(consentPath, { force: true })
}

// --- H. Intake scaffold ----------------------------------------------------
if (section("H. Intake scaffold")) {
  // MAJ-004: suppressing the scaffold by ask text silenced deep, risk-flagged
  // work. It must render for anything that looks like work, whichever route
  // activated the session.
  for (const [id, ask] of [
    ["H1", "describe a plan to migrate the database and then do it"],
    ["H2", "read the spec and implement the whole payment flow"],
  ]) {
    const s2 = await scenario()
    await s2.say(`/elicify-vertex\n\n${ask}`)
    const sys = await s2.system()
    assert(`${id}-scaffold-on-work`, sys.includes("acceptance") || sys.includes("criteria"), ask.slice(0, 40))
  }
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

// --- I. A verdict must not outlive the code it judged ----------------------
if (section("I. Verdict staleness")) {
  // The live failure, replayed against the shipped build: the verifier failed
  // a story at 06:43:46, the model fixed it at 06:44:46, and the harness
  // re-litigated the dead verdict until the session was abandoned. Both of the
  // verifier's claims were false by then; the worker was right.
  let audits = 0
  const s = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      audits++
      // UNSUBSTANTIATED, so the verdict is bounded and the story stays
      // `complete` with an `unapplied` stamp — the exact live shape. A
      // substantiated failure would revert the story to `active`, which is a
      // different (and already correct) path owned by plan-incomplete.
      return '{"stories":[{"storyId":"S1","pass":false,"summary":"nope","items":[]}]}'
    },
  })
  await s.say("/elicify-vertex\n\nbuild the research portal")
  await s.hooks.tool.elicify_vertex_plan_create.execute(
    { stories: [{ text: "Ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] }] },
    { sessionID: s.sid },
  )
  await s.tool("edit", { filePath: join(s.work, "x.md") })
  await s.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: s.sid })
  await s.idle()
  const afterFirst = audits
  assert("I1-first-audit-ran", afterFirst > 0, `${afterFirst} audits`)

  // The model fixes it — an edit ONLY, no re-checkpoint. That is the live
  // case, and the one the old test missed: `completedAt` does not move, so
  // `verifiedAt < completedAt` stays false and the dead verdict looked
  // current. (Re-checkpointing here would move `completedAt` and trigger the
  // OLD path, which is how the first version of this scenario passed even
  // with staleness disabled.)
  await s.tool("edit", { filePath: join(s.work, "x.md") })
  await s.idle()
  assert("I2-edit-earns-a-fresh-audit", audits > afterFirst, `${audits} audits total`)
}

// --- J. Staleness must not become the loop it replaced ---------------------
if (section("J. Staleness is bounded")) {
  // Section I's fix, applied unconditionally, put the audit loop straight
  // back: every edit retired the verdict again, and because the bounded-stamp
  // path returns before the cap is consulted, `maxStoryReaudits` never
  // engaged. Measured on the shipped build at 5 verifier subturns over 5
  // edit+idle rounds. A re-audit earned by staleness spends cap budget like
  // any other.
  let audits = 0
  const s = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      audits++
      return '{"stories":[{"storyId":"S1","pass":false,"summary":"nope","items":[]}]}'
    },
  })
  await s.say("/elicify-vertex\n\nbuild the research portal")
  await s.hooks.tool.elicify_vertex_plan_create.execute(
    { stories: [{ text: "Ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] }] },
    { sessionID: s.sid },
  )
  await s.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: s.sid })
  for (let i = 0; i < 5; i++) {
    await s.idle()
    await s.tool("edit", { filePath: join(s.work, `e${i}.ts`) })
  }
  assert("J1-reaudits-are-capped", audits <= 3, `${audits} verifier subturns over 5 edit+idle rounds`)

  // A CLEAN PASS IS TERMINAL. gate.ts states the invariant outright — "it
  // cannot re-fire on a later idle" — and retiring passed verdicts broke it:
  // 3 settled-plan close-outs for 2 post-settlement edits. The user-visible
  // symptom is the harness repeating "report what was delivered" after every
  // save, which is the standoff this whole change exists to end.
  let closeouts = 0
  const p2 = await scenario({
    subturn: (agent) =>
      agent === "vertex-verifier"
        ? '{"stories":[{"storyId":"S1","pass":true,"summary":"ok","items":[{"itemId":"A1","met":true,"note":"seen"}]}]}'
        : undefined,
  })
  await p2.say("/elicify-vertex\n\nbuild the research portal")
  await p2.hooks.tool.elicify_vertex_plan_create.execute(
    { stories: [{ text: "Ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] }] },
    { sessionID: p2.sid },
  )
  await p2.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: p2.sid })
  await p2.idle()
  closeouts = p2.sent().filter((t) => t.includes("Report what was delivered")).length
  assert("J2-closeout-fires-once-on-settling", closeouts === 1, `${closeouts} close-outs`)

  for (let i = 0; i < 2; i++) {
    await p2.tool("edit", { filePath: join(p2.work, `after${i}.ts`) })
    await p2.idle()
  }
  const after = p2.sent().filter((t) => t.includes("Report what was delivered")).length
  assert("J3-closeout-does-not-re-fire", after === 1, `${after} close-outs after 2 post-settlement edits`)

  // MAJ-006. `handleVerifierAudit` has two returns that predate the cap: the
  // verifier did not run, and it answered about the wrong stories. Neither
  // reaches a bump, so once staleness could re-select a story every idle, an
  // unavailable verifier bought one subturn per idle forever with the counter
  // stuck. Measured at 6 extra subturns over 6 rounds. The cap must charge the
  // ROUND, not the verdict.
  let calls = 0
  const p3 = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      calls++
      // First call is a real (unsubstantiated) verdict, so the story gets a
      // stamp and stays complete. After that the verifier goes bad.
      return calls === 1 ? '{"stories":[{"storyId":"S1","pass":false,"summary":"nope","items":[]}]}' : "not json at all"
    },
  })
  await p3.say("/elicify-vertex\n\nbuild the research portal")
  await p3.hooks.tool.elicify_vertex_plan_create.execute(
    { stories: [{ text: "Ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] }] },
    { sessionID: p3.sid },
  )
  await p3.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: p3.sid })
  for (let i = 0; i < 6; i++) {
    await p3.idle()
    await p3.tool("edit", { filePath: join(p3.work, `bad${i}.ts`) })
  }
  assert("J4-broken-verifier-is-still-capped", calls <= 4, `${calls} verifier subturns over 6 edit+idle rounds`)
}

// --- L. An answerless audit round still bounds the story -------------------
if (section("L. Answerless audit rounds")) {
  // J4 CANNOT SEE THIS CLASS. Its first verifier call returns a real (if
  // unsubstantiated) verdict, so the story gets a stamp on round 1 and every
  // later round is bounded by the STALENESS cap — the counter has a verdict to
  // read. Take that first stamp away and the bound disappeared entirely: the
  // selector re-picks on `!story.verifier`, and the only reader of
  // `storyReaudits` needs a verdict to exist. Measured on the unfixed build at
  // cap 3: 8 subturns over 8 rounds, `storyReaudits` at 7-8, no stamp, and —
  // the part that matters — NOT ONE WORD to the user about work that was never
  // verified.
  // EXACT COUNTS, NOT CEILINGS (sign-off review). Every count below used to be
  // `<= 3`, which is also satisfied by the verifier never running at all —
  // i.e. by the over-correction this section now guards against as well. And
  // the "told once" assertions were vacuous: the scenarios ended with the plan
  // untouched after the cap bound, so nothing ever ATTEMPTED a second
  // escalation and disabling the once-guard still measured 1. Each of them now
  // writes the plan again (via the model-facing `plan_reopen`) and keeps
  // idling, which is what the guard is for.
  const planStories = async (s) => JSON.parse(await s.hooks.tool.elicify_vertex_plan_status.execute({}, { sessionID: s.sid })).stories
  const escalations = (s) => s.sent().filter((t) => t.includes("did not pass") && t.includes("audit"))
  /** The bookkeeping stamp's full shape — a refusal must never read as a pass. */
  const isAnswerlessStamp = (v) => v?.unapplied === "unverified" && v?.pass === false && Array.isArray(v?.items) && v.items.length === 0
  /** Write the plan again without resolving anything, then idle. The guard's
   * key used to be `plan.revision`, so any plan write re-opened it. */
  const rewritePlanAndIdle = async (s, storyId, rounds) => {
    await s.hooks.tool.elicify_vertex_plan_reopen.execute({ storyId, reason: "another go" }, { sessionID: s.sid })
    for (let i = 0; i < rounds; i++) await s.idle()
  }

  // L1-L3: the verifier is broken from the FIRST call, so no round ever stamps.
  let l1calls = 0
  const l1 = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      l1calls++
      return "not a verdict at all"
    },
  })
  await l1.say("/elicify-vertex\n\nbuild the research portal")
  await l1.hooks.tool.elicify_vertex_plan_create.execute(
    { stories: [{ text: "Ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] }] },
    { sessionID: l1.sid },
  )
  await l1.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: l1.sid })
  for (let i = 0; i < 8; i++) {
    await l1.idle()
    await l1.tool("edit", { filePath: join(l1.work, `broken${i}.ts`) })
  }
  assert("L1-verdictless-rounds-are-capped", l1calls === 3, `${l1calls} verifier subturns over 8 edit+idle rounds (cap 3)`)
  assert(
    "L2-verdictless-round-stamps-the-story",
    isAnswerlessStamp((await planStories(l1))?.[0]?.verifier),
    JSON.stringify((await planStories(l1))?.[0]?.verifier ?? null),
  )
  // The harness must SPEAK — once. Silence about unverified work is the worse
  // half of this defect: the storm at least told the user something. The
  // re-open below is the non-vacuous half: it re-audits the story, bounds it
  // again and writes the plan twice more, which is exactly what used to mint a
  // fresh key for the once-guard and repeat the identical sentence.
  assert("L3-user-is-told-exactly-once", escalations(l1).length === 1, `${escalations(l1).length} escalations`)
  await rewritePlanAndIdle(l1, "S1", 3)
  assert(
    "L3b-a-plan-write-does-not-buy-a-second-escalation",
    escalations(l1).length === 1,
    `${escalations(l1).length} escalations after re-opening and re-auditing the same story`,
  )

  // L4-L5: a PARTIAL answer. The verdict names S1 and never mentions S2, on
  // every round. The old code only handled the all-or-nothing case, so S2 was
  // stamped by nothing and re-audited forever (measured: 8 subturns,
  // `storyReaudits.S2 = 7`, stamp `undefined`).
  let l4calls = 0
  const l4 = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      l4calls++
      return '{"stories":[{"storyId":"S1","pass":true,"summary":"ok","items":[{"itemId":"A1","met":true,"note":"seen"}]}]}'
    },
  })
  await l4.say("/elicify-vertex\n\nbuild the research portal")
  await l4.hooks.tool.elicify_vertex_plan_create.execute(
    {
      stories: [
        { text: "Research", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] },
        { text: "Chart", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "draw" }] },
      ],
    },
    { sessionID: l4.sid },
  )
  await l4.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: l4.sid })
  await l4.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S2.T1", status: "complete" }, { sessionID: l4.sid })
  for (let i = 0; i < 8; i++) {
    await l4.idle()
    await l4.tool("edit", { filePath: join(l4.work, `partial${i}.ts`) })
  }
  assert("L4-unanswered-story-is-capped", l4calls === 3, `${l4calls} verifier subturns over 8 edit+idle rounds (cap 3)`)
  assert(
    "L5-unanswered-story-is-named-once",
    escalations(l4).length === 1 && escalations(l4)[0].includes("S2"),
    `${escalations(l4).length} escalations: ${escalations(l4)[0]?.slice(0, 90) ?? ""}`,
  )
  // The answered story keeps its real verdict; the unanswered one is stamped
  // as never judged. Silence must not read as a pass anywhere.
  assert(
    "L5b-the-two-stories-are-stamped-differently",
    (await planStories(l4))?.[0]?.verifier?.unapplied === undefined &&
      (await planStories(l4))?.[0]?.verifier?.pass === true &&
      isAnswerlessStamp((await planStories(l4))?.[1]?.verifier),
    JSON.stringify((await planStories(l4))?.map((s) => s.verifier ?? null) ?? null).slice(0, 220),
  )

  // L6-L8: `insufficient-evidence` — B-3 (d)'s refusal, decided BEFORE any
  // subturn. This is the loop that produced no verifier call at all, so a
  // subturn count could never see it; the symptom was a harness that had
  // simply stopped speaking.
  //
  // Reaching it against the SHIPPED build takes some care, and the shape is
  // worth recording: the real `diffSummary` provider never returns empty text
  // (its floor is the literal "no changed paths recorded"), so the only way
  // the payload loses that field is the FR-031 raw-field safety cap — 100k
  // chars, documented as existing for "a pathological or DoS-shaped input".
  // One absurdly long changed path is exactly that input. The stub host serves
  // no transcript either (`session.messages` returns nothing, the audited
  // live shape), so both evidence fields are gone and the verifier refuses.
  let l6calls = 0
  const l6 = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      l6calls++
      return '{"stories":[{"storyId":"S1","pass":true,"summary":"never reached","items":[{"itemId":"A1","met":true,"note":"x"}]}]}'
    },
  })
  await l6.say("/elicify-vertex\n\nbuild the research portal")
  await l6.hooks.tool.elicify_vertex_plan_create.execute(
    { stories: [{ text: "Ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] }] },
    { sessionID: l6.sid },
  )
  await l6.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: l6.sid })
  // BEFORE the first idle, not after it: a single round with real evidence
  // stamps a clean pass, which is terminal, and the refusal path is never
  // reached again. (Written the other way round first — L6 measured 1 subturn
  // and a `pass:true` stamp, which is the correct behaviour for a round that
  // HAD evidence, and proves nothing about the one that does not.)
  const oversized = join(l6.work, `${"d".repeat(120_000)}.ts`)
  await l6.tool("edit", { filePath: oversized })
  for (let i = 0; i < 8; i++) {
    await l6.idle()
    await l6.tool("edit", { filePath: oversized })
  }
  assert(
    "L6-refusal-costs-no-subturn",
    l6calls === 0 && eventTypes().includes("verifier:insufficient-evidence"),
    `${l6calls} subturns; insufficient-evidence logged=${eventTypes().includes("verifier:insufficient-evidence")}`,
  )
  assert(
    "L7-unjudgeable-story-is-stamped",
    isAnswerlessStamp((await planStories(l6))?.[0]?.verifier),
    JSON.stringify((await planStories(l6))?.[0]?.verifier ?? null),
  )
  assert(
    "L8-cannot-verify-is-not-never-speak-again",
    escalations(l6).length === 1,
    `${escalations(l6).length} escalations — 0 means the harness went silent about unverified work`,
  )
  await rewritePlanAndIdle(l6, "S1", 3)
  assert(
    "L8b-still-once-after-the-plan-is-written-again",
    escalations(l6).length === 1,
    `${escalations(l6).length} escalations after re-opening the same unverifiable story`,
  )

  // ==========================================================================
  // L9-L11: THE BOUND MUST NOT BE A LIFE SENTENCE.
  //
  // The first cut of L1-L8 over-corrected: a bounded story's only route back
  // into the audit set was a file edit landing after the stamp, and at plan end
  // nothing edits files. One verifier blip therefore froze a story `unverified`
  // for the rest of the run — measured at 1 subturn against a cap of 3, with a
  // healthy verifier standing right there and never being asked.
  // ==========================================================================
  let l9calls = 0
  const l9 = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      l9calls++
      // Broken on the FIRST call only. Every later call is a clean, fully
      // substantiated pass.
      return l9calls === 1
        ? "not a verdict at all"
        : '{"stories":[{"storyId":"S1","pass":true,"summary":"delivered","items":[{"itemId":"A1","met":true,"note":"read it"}]}]}'
    },
  })
  await l9.say("/elicify-vertex\n\nbuild the research portal")
  await l9.hooks.tool.elicify_vertex_plan_create.execute(
    { stories: [{ text: "Ship", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] }] },
    { sessionID: l9.sid },
  )
  await l9.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: l9.sid })
  // NO EDITS ANYWHERE IN THIS LOOP. That is the whole point: the model has
  // finished, the plan is claimed, and only the harness is still running.
  for (let i = 0; i < 6; i++) await l9.idle()
  assert(
    "L9-a-recovered-verifier-is-consulted-without-an-edit",
    (await planStories(l9))?.[0]?.verifier?.unapplied === undefined && (await planStories(l9))?.[0]?.verifier?.pass === true,
    JSON.stringify((await planStories(l9))?.[0]?.verifier ?? null).slice(0, 200),
  )
  assert(
    "L9b-the-retry-stops-at-the-verdict-and-says-nothing-false",
    l9calls === 2 && escalations(l9).length === 0,
    `${l9calls} subturns (1 blip + 1 recovery), ${escalations(l9).length} escalations`,
  )

  // L10: a DEFERRED story — named from round 2, not round 1 — must be re-asked
  // rather than stamped and escalated after a single round.
  let l10calls = 0
  const l10 = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      l10calls++
      const s1 = '{"storyId":"S1","pass":true,"summary":"delivered","items":[{"itemId":"A1","met":true,"note":"read it"}]}'
      const s2 = '{"storyId":"S2","pass":true,"summary":"renders","items":[{"itemId":"A1","met":true,"note":"opened it"}]}'
      return l10calls === 1 ? `{"stories":[${s1}]}` : `{"stories":[${s1},${s2}]}`
    },
  })
  await l10.say("/elicify-vertex\n\nbuild the research portal")
  await l10.hooks.tool.elicify_vertex_plan_create.execute(
    {
      stories: [
        { text: "Research", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] },
        { text: "Chart", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "draw" }] },
      ],
    },
    { sessionID: l10.sid },
  )
  await l10.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: l10.sid })
  await l10.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S2.T1", status: "complete" }, { sessionID: l10.sid })
  for (let i = 0; i < 6; i++) await l10.idle()
  assert(
    "L10-a-deferred-story-is-re-asked-not-condemned",
    (await planStories(l10))?.[1]?.verifier?.unapplied === undefined &&
      (await planStories(l10))?.[1]?.verifier?.pass === true &&
      escalations(l10).length === 0,
    `S2=${JSON.stringify((await planStories(l10))?.[1]?.verifier ?? null).slice(0, 140)}, ${escalations(l10).length} escalations`,
  )

  // L11: the close-out's `unapplied === undefined` clause. Deleting it survived
  // the entire unit suite AND every UAT assertion — and it is what stops a
  // bounding stamp (which keeps `pass` as the verifier SAID it) from satisfying
  // "the verifier independently verified every story of the plan".
  let l11calls = 0
  const l11 = await scenario({
    subturn: (agent) => {
      if (agent !== "vertex-verifier") return undefined
      l11calls++
      // Round 1: a `pass:true` for S1 that judged only 1 of its 2 declared
      // acceptance items — unsubstantiated, so it is BOUNDED with pass:true.
      // Round 2: a clean, complete pass for S2, which settles the plan.
      return l11calls === 1
        ? '{"stories":[{"storyId":"S1","pass":true,"summary":"looks done","items":[{"itemId":"A1","met":true,"note":"cited"}]}]}'
        : '{"stories":[{"storyId":"S2","pass":true,"summary":"renders","items":[{"itemId":"A1","met":true,"note":"opened it"}]}]}'
    },
  })
  await l11.say("/elicify-vertex\n\nbuild the research portal")
  await l11.hooks.tool.elicify_vertex_plan_create.execute(
    {
      stories: [
        { text: "Research", acceptanceItems: ["A1", "A2"], scopeGlobs: [], verifiers: [], tasks: [{ text: "do" }] },
        { text: "Chart", acceptanceItems: ["A1"], scopeGlobs: [], verifiers: [], tasks: [{ text: "draw" }] },
      ],
    },
    { sessionID: l11.sid },
  )
  await l11.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S1.T1", status: "complete" }, { sessionID: l11.sid })
  await l11.idle()
  await l11.hooks.tool.elicify_vertex_plan_checkpoint.execute({ taskId: "S2.T1", status: "complete" }, { sessionID: l11.sid })
  await l11.idle()
  await l11.idle()
  assert(
    "L11-a-bounded-pass-cannot-close-the-plan-as-audited",
    !l11.sent().some((t) => t.includes("independently verified")),
    `S1=${JSON.stringify((await planStories(l11))?.[0]?.verifier ?? null).slice(0, 150)}`,
  )
  assert(
    "L11b-and-the-unverified-story-is-named-instead",
    escalations(l11).length === 1 && escalations(l11)[0].includes("S1"),
    `${escalations(l11).length} escalations: ${escalations(l11)[0]?.slice(0, 90) ?? ""}`,
  )
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
  // BOTH pipes: the section is "no subprocess output reaches the terminal",
  // and stdout reaches it just as readily as stderr.
  const stderr = String(run.stderr ?? "") + String(run.stdout ?? "")
  assert("F1-no-stderr-flood", stderr.length === 0, `${stderr.length} bytes: ${stderr.slice(0, 80)}`)
  // POSITIVE CONTROL. F1 passed twice against a broken build because the probe
  // never reached the subprocess. Prove the path is live: the same git call,
  // unguarded, in the same directory, must flood.
  const control = spawnSync(process.execPath, ["-e",
    `const {execFileSync}=require('node:child_process');try{execFileSync('git',['diff','--stat'],{cwd:${JSON.stringify(uatRoot)},encoding:'utf8',timeout:5000})}catch(e){}`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  assert(
    "F2-control-path-is-live",
    String(control.stderr ?? "").length > 1000,
    `${String(control.stderr ?? "").length} bytes — if 0, F1 proves nothing`,
  )
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

// --- K. Uninstall leaves no machine-wide state behind ----------------------
if (section("K. Uninstall is complete")) {
  // Measured on a real machine: after `scripts/uninstall.sh` reported
  // "Nothing to remove — elicify-vertex was not installed", two consent files
  // (a legacy plain-text `yes` and a `{"state":"yes","attempts":2}`) and
  // 1.65 MB of `.vertex-events.jsonl` were still on disk. The script removed
  // what the INSTALLER wrote and nothing the HARNESS writes at runtime.
  //
  // A stale consent marker is not inert: `yes` is terminal, so the star ask
  // can never fire again there, and a reinstall inherits a decision the user
  // may never have made.
  const root = mkdtempSync(join(tmpdir(), "vertex-uninst-"))
  const cfg = join(root, "cfg")
  const data = join(root, "data")
  const fakeHome = join(root, "home")
  mkdirSync(join(cfg, "opencode"), { recursive: true })
  mkdirSync(data, { recursive: true })
  mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true })

  const planted = [
    // Legacy location AND format — one directory above the opencode root.
    [join(cfg, ".elicify-vertex-consent"), "yes"],
    [join(cfg, "opencode", ".elicify-vertex-consent"), '{"state":"yes","attempts":2}'],
    [join(cfg, "opencode", ".vertex-events.jsonl"), '{"e":1}'],
    // Rotated history: removing only the live file left tens of MB behind.
    [join(cfg, "opencode", ".vertex-events.2026-07-25T12-00-00-000Z.jsonl"), '{"e":0}'],
    [join(cfg, "opencode", "receipt-signing.key"), "KEY"],
    // `starConsentPath()` honours XDG_CONFIG_HOME but `defaultDataRoot()` does
    // not, so with XDG set the log lives in a DIFFERENT root than the consent.
    [join(data, ".vertex-events.jsonl"), '{"e":9}'],
  ]
  for (const [f, body] of planted) writeFileSync(f, body)
  // The plugin is NOT registered — the exact case that printed "not installed"
  // and then removed nothing.
  writeFileSync(join(cfg, "opencode", "opencode.json"), '{"plugin":["@other/thing"]}\n')

  const run = spawnSync("bash", [join(ROOT, "scripts", "uninstall.sh")], {
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: cfg, VERTEX_DATA: data, HOME: fakeHome },
  })
  assert("K1-uninstaller-exits-clean", run.status === 0, `exit ${run.status}: ${run.stderr?.slice(0, 200)}`)

  const survivors = planted.map(([f]) => f).filter((f) => existsSync(f))
  assert(
    "K2-no-state-survives-uninstall",
    survivors.length === 0,
    `${survivors.length} left: ${survivors.map((f) => f.replace(root, "")).join(", ")}`,
  )
  // Truthful summary: reporting "not installed" while deleting six files is
  // how the gap stayed invisible.
  assert(
    "K3-summary-is-truthful",
    !run.stdout.includes("Nothing to remove"),
    `stdout said "Nothing to remove" while state existed`,
  )
  rmSync(root, { recursive: true, force: true })
}

// --- M. opencode's plugin cache holds exactly one copy ---------------------
if (section("M. Plugin cache holds no duplicate")) {
  // THE DUPLICATE-INSTALL BUG, twice reported. opencode resolves plugins into
  // its own cache, one directory per SPEC, and a single config line
  // (`"@elicify-ai/elicify-vertex"`) yields SEVERAL entries. Observed on a real
  // machine: `elicify-vertex` pinned to 0.14.1 and `elicify-vertex@latest`
  // pinned to 0.14.0 — two different builds loadable at once. So the entry name
  // can never be guessed; the SCOPE DIRECTORY is the unit of eviction.
  const shapes = ["elicify-vertex", "elicify-vertex@latest", "elicify-vertex@0.14.1"]

  // Build a cache that looks like opencode's, plus a neighbour that must live.
  const plantCache = (cacheHome) => {
    const scope = join(cacheHome, "opencode", "packages", "@elicify-ai")
    for (const s of shapes) {
      const inner = join(scope, s, "node_modules", "@elicify-ai", "elicify-vertex")
      mkdirSync(inner, { recursive: true })
      // opencode's OUTER manifest carries no `version` key — only a dependency
      // pin. Reading `.version` off it is why a live incident could not be told
      // which build had run. The real manifest is the inner one.
      writeFileSync(join(scope, s, "package.json"), '{"dependencies":{"@elicify-ai/elicify-vertex":"0.14.0"}}')
      writeFileSync(join(inner, "package.json"), '{"name":"@elicify-ai/elicify-vertex","version":"0.14.0"}')
    }
    const neighbour = join(cacheHome, "opencode", "packages", "@prevalentware", "goal-plugin@latest")
    mkdirSync(neighbour, { recursive: true })
    return { scope, neighbour }
  }
  const survivors = (scope) => (existsSync(scope) ? readdirSync(scope) : [])

  // --- uninstall path ---
  {
    const root = mkdtempSync(join(tmpdir(), "vertex-cache-un-"))
    const cacheHome = join(root, "cache")
    const cfg = join(root, "cfg")
    const home = join(root, "home")
    mkdirSync(join(cfg, "opencode"), { recursive: true })
    mkdirSync(home, { recursive: true })
    const { scope, neighbour } = plantCache(cacheHome)

    const run = spawnSync("bash", [join(ROOT, "scripts", "uninstall.sh")], {
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome, XDG_CONFIG_HOME: cfg, HOME: home, VERTEX_DATA: join(root, "d") },
    })
    assert("M1-uninstall-exits-clean", run.status === 0, `exit ${run.status}`)
    const left = survivors(scope)
    assert("M2-uninstall-evicts-every-suffix", left.length === 0, `${left.length} left: ${left.join(", ")}`)
    // Blast radius: only OUR scope directory may be touched.
    assert("M3-uninstall-spares-other-scopes", existsSync(neighbour))
    rmSync(root, { recursive: true, force: true })
  }

  // --- install path: an upgrade must REPLACE, not accumulate ---
  {
    const root = mkdtempSync(join(tmpdir(), "vertex-cache-in-"))
    const cacheHome = join(root, "cache")
    const cfg = join(root, "cfg")
    const home = join(root, "home")
    mkdirSync(join(cfg, "opencode"), { recursive: true })
    mkdirSync(home, { recursive: true })
    const { scope, neighbour } = plantCache(cacheHome)

    const run = spawnSync("bash", [join(ROOT, "scripts", "install-skill.sh")], {
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome, XDG_CONFIG_HOME: cfg, HOME: home },
    })
    assert("M4-install-exits-clean", run.status === 0, `exit ${run.status}`)
    const left = survivors(scope)
    assert("M5-install-evicts-every-suffix", left.length === 0, `${left.length} left: ${left.join(", ")}`)
    assert("M6-install-spares-other-scopes", existsSync(neighbour))
    rmSync(root, { recursive: true, force: true })
  }

  // --- THE REGRESSION THAT BROUGHT THE BUG BACK ---
  // This script is the package's `postinstall`. When opencode populates its
  // cache it runs npm, and npm runs our postinstall FROM INSIDE the entry it is
  // building. An unguarded scope sweep then deletes the in-flight install, its
  // sibling entry, and the scope — mid-write. opencode re-resolves onto the
  // wreckage, which is how two entries pinned to two different versions appear.
  // Measured before the guard: "AFTER scope:" was empty and the in-flight
  // install was destroyed.
  {
    const root = mkdtempSync(join(tmpdir(), "vertex-cache-self-"))
    const cacheHome = join(root, "cache")
    const cfg = join(root, "cfg")
    const home = join(root, "home")
    mkdirSync(join(cfg, "opencode"), { recursive: true })
    mkdirSync(home, { recursive: true })
    const { scope } = plantCache(cacheHome)

    // Run the copy of the installer that lives inside the cache entry, exactly
    // as npm would during `opencode` plugin resolution.
    const inFlight = join(scope, "elicify-vertex@latest", "node_modules", "@elicify-ai", "elicify-vertex")
    mkdirSync(join(inFlight, "scripts"), { recursive: true })
    for (const f of ["install-skill.sh", "register-commands.mjs"]) {
      cpSync(join(ROOT, "scripts", f), join(inFlight, "scripts", f))
    }

    const run = spawnSync("bash", [join(inFlight, "scripts", "install-skill.sh")], {
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome, XDG_CONFIG_HOME: cfg, HOME: home },
    })
    assert("M7-postinstall-exits-clean", run.status === 0, `exit ${run.status}`)
    assert(
      "M8-postinstall-spares-the-inflight-install",
      existsSync(join(inFlight, "package.json")) || existsSync(join(inFlight, "scripts", "install-skill.sh")),
      "the installer deleted the very tree opencode was installing",
    )
    const left = survivors(scope)
    assert("M9-postinstall-leaves-cache-intact", left.length === shapes.length, `expected ${shapes.length}, found ${left.length}: ${left.join(", ")}`)
    rmSync(root, { recursive: true, force: true })
  }
}

// ===========================================================================
process.on("uncaughtException", (err) => {
  console.log(`\n  FAIL  harness crashed — ${err?.message ?? err}`)
  console.log(`Artefacts left for inspection: ${uatRoot}`)
  process.exit(1)
})

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
