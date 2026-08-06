/**
 * The one-time GitHub-star ask — agent-driven, harness-recorded (B-6).
 *
 * THE BUG THIS EXISTS FOR, PART 1. Consent was written `"prompted"` at ARM
 * time, before the model had done anything. The consent file then said
 * "prompted" on a machine where the user had never been prompted — and because
 * the marker is machine-wide and durable, the ask could never happen again.
 *
 * PART 2. The fix for part 1 was a runtime loop: arm on a quiet turn, inject a
 * system directive, retry, and write `"gave-up"` after three failures. On
 * weaker models the ask was never made at all, so the loop only ever spent its
 * three injections and then permanently cancelled — via `gave-up` — an ask
 * nobody had made. Both `"prompted"` and `"gave-up"` record a MACHINE's
 * behaviour in a file that is supposed to record a USER's decision, so both
 * must read as NO RECORD AT ALL. Same reasoning, same branch.
 *
 * The loop is gone. The ask now lives in the agent prompt, gated by the
 * read-only `elicify_vertex_star_status` tool; the harness's only remaining
 * job is to OBSERVE a real `question` call about our repo and record `asked`.
 *
 * `starConsentPath()` honours `XDG_CONFIG_HOME`, so every test here runs
 * against its own throwaway config root and never touches the real machine.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { eventsPath } from "../../src/measurement.js"
import { ElicifyVertexPluginV2 } from "../../src/v2/plugin.js"
import { readStarConsent, recordStarAskIfOurs, starConsentPath, writeStarConsent } from "../../src/v2/wiring/tools.js"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

let configRoot: string
let previousXdg: string | undefined

beforeEach(() => {
  previousXdg = process.env.XDG_CONFIG_HOME
  configRoot = mkdtempSync(join(tmpdir(), "vertex-star-"))
  process.env.XDG_CONFIG_HOME = configRoot
})

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousXdg
  vi.useRealTimers()
})

interface Harness {
  hooks: Hooks
  sid: string
  /** Continuation texts sent to the parent session (no agent tag). */
  sent: () => string[]
  /** Run a system.transform, as the host does at the start of the next turn. */
  transform: () => Promise<string>
  /** Call the read-only status tool and return its `consent` value. */
  status: () => Promise<string>
  /** Session ids the HARNESS ITSELF created (subturn children). */
  created: () => string[]
}

/** A subagent that can do nothing at all — enough to satisfy the intake
 *  subturn's capability probe (src/v2/subturn.ts), which otherwise skips and
 *  no child session is ever created. Only the self-created-session test needs
 *  it, so it is opt-in: every other test here keeps the agent-less client it
 *  has always had. */
function denyAllAgent(name: string): unknown {
  return {
    name,
    mode: "subagent",
    builtIn: false,
    permission: { edit: "deny", write: "deny", bash: { "*": "deny" }, webfetch: "deny", task: "deny" },
    tools: { bash: false, edit: false, write: false, webfetch: false, read: false, task: false, "*": false },
    options: {},
  }
}

async function harness(opts: { subturnsPossible?: boolean } = {}): Promise<Harness> {
  const prompts: Array<{ body?: { agent?: string; parts?: Array<{ text?: string }> } }> = []
  const created: string[] = []
  let childCounter = 0
  const client = {
    session: {
      prompt: async (a: never) => {
        prompts.push(a as never)
        return { data: { info: {}, parts: [] }, error: undefined }
      },
      messages: async () => ({ data: [] }),
      create: async () => {
        childCounter += 1
        const id = `child-${childCounter}`
        created.push(id)
        return { data: { id } }
      },
      delete: async () => ({ data: {} }),
    },
    app: {
      agents: async () => ({
        data: opts.subturnsPossible ? [denyAllAgent("vertex-verifier"), denyAllAgent("vertex-intake")] : [],
      }),
    },
    tool: { ids: async () => ({ data: opts.subturnsPossible ? ["bash", "edit", "write", "webfetch", "read"] : [] }) },
  }
  const workDir = mkdtempSync(join(tmpdir(), "vertex-star-work-"))
  const hooks = await ElicifyVertexPluginV2(
    { client, directory: workDir, worktree: workDir } as unknown as PluginInput,
    undefined,
  )
  const sid = `star-${Math.random().toString(36).slice(2)}`
  const sent = (): string[] =>
    prompts.filter((p) => !p?.body?.agent).map((p) => String(p?.body?.parts?.[0]?.text ?? ""))

  const transform = async (): Promise<string> => {
    const out = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid, model: { providerID: "anthropic", id: "claude-opus-4" } } as never,
      out,
    )
    return out.system.join("\n")
  }
  const status = async (): Promise<string> => {
    const raw = await (
      hooks.tool as unknown as Record<string, { execute: (a: unknown, c: unknown) => Promise<string> }>
    ).elicify_vertex_star_status.execute({}, { sessionID: sid })
    return JSON.parse(raw).consent
  }
  return { hooks, sid, sent, transform, status, created: () => [...created] }
}

async function userTurn(h: Harness, text: string): Promise<void> {
  await h.hooks["chat.message"]!(
    { sessionID: h.sid, agent: "elicify-vertex-agent", model: { providerID: "anthropic", modelID: "claude-opus-4" } } as never,
    { message: { id: `m${Math.random()}` } as never, parts: [{ type: "text", text } as never] },
  )
}

async function idle(h: Harness): Promise<void> {
  await h.hooks.event!({ event: { type: "session.idle", properties: { sessionID: h.sid } } as never })
  await h.transform()
}

/** The model calls the `question` tool — `args` decides whether it is OUR ask.
 *  Drives BOTH hooks, in host order: dispatch, then completion. */
async function questionTool(h: Harness, args: Record<string, unknown>): Promise<void> {
  await questionDispatched(h, args)
  await h.hooks["tool.execute.after"]!(
    { tool: "question", sessionID: h.sid, callID: `c${Math.random()}`, args } as never,
    { title: "question", output: "answered", metadata: {} } as never,
  )
}

/** The question is PUT TO THE USER and nothing more — `tool.execute.before`
 *  only. This is what a question the user escapes or rejects looks like: the
 *  host never resolves `execute`, so `tool.execute.after` never fires. */
async function questionDispatched(h: Harness, args: Record<string, unknown>): Promise<void> {
  await h.hooks["tool.execute.before"]!(
    { tool: "question", sessionID: h.sid, callID: `c${Math.random()}` } as never,
    { args } as never,
  )
}

/** Completion only, with no dispatch — the pre-existing observation point, kept
 *  as its own path so a regression in either hook is attributable. */
async function questionCompletedOnly(h: Harness, args: Record<string, unknown>): Promise<void> {
  await h.hooks["tool.execute.after"]!(
    { tool: "question", sessionID: h.sid, callID: `c${Math.random()}`, args } as never,
    { title: "question", output: "answered", metadata: {} } as never,
  )
}

const OUR_ASK = { questions: [{ question: "Would you like to star elicify-ai/elicify-vertex on GitHub?" }] }
const OTHER_ASK = { questions: [{ question: "Which 3 games should the portal ship?" }] }
/** Mentions "star" but is not our ask — a bare substring check burned the one-shot on these. */
const STAR_WORD_ASKS = [
  { questions: [{ question: "Which star rating should the widget default to?" }] },
  { questions: [{ question: "Should I use a star schema for the warehouse?" }] },
]

function plant(contents: string): void {
  mkdirSync(dirname(starConsentPath()), { recursive: true })
  writeFileSync(starConsentPath(), contents)
}

// ---------------------------------------------------------------------------
// THE PHRASING GAP. `asked` is the ONLY thing that stops the agent raising the
// question again, and it used to be written only when the serialised `question`
// args contained the literal `elicify-ai/elicify-vertex` — while the prompt
// never told the model to write the slug at all. Seven plausible phrasings of
// the prompt's own instruction were probed against the old matcher and FIVE
// recorded nothing, so those users were asked EVERY SESSION FOREVER: strictly
// worse than the bounded 3-attempt loop B-6 removed, on exactly the weaker
// models B-6 was written for.
//
// The fix is both ends — a matcher on the repo NAME plus a star/GitHub topic
// word, and a prompt line telling the model to include the slug (asserted in
// tests/agent-prompt.test.ts, which also holds the config-template drift
// guard). Neither is reliable alone: the prompt is advice, the matcher is code.
// ---------------------------------------------------------------------------
const PROMPT_PHRASINGS = [
  "Would you like to star the elicify-vertex repo on GitHub?",
  "Star elicify-vertex on GitHub?",
  "May I star the elicify-vertex repository?",
  "Would you like to star elicify-ai/elicify-vertex on GitHub?",
  "Do you want to give elicify-vertex a ⭐ on GitHub?",
  "Should I star this project (elicify-vertex) for you?",
  "Before we start: star the elicify-vertex repo?",
]

/** Names the repo but is not the ask — the widening must not swallow these. */
const REPO_WORK_ASKS = [
  { questions: [{ question: "Should I refactor elicify-vertex's gate module or leave it?" }] },
  { questions: [{ question: "Which elicify-vertex directive family should own this?" }] },
]

// ---------------------------------------------------------------------------
// THE OVER-CORRECTION. The widening above deliberately avoided the words
// `star` and `github`, which is exactly why it caught none of this: the widened
// rule was "repo name ANYWHERE in the args, plus the SUBSTRING star or github
// ANYWHERE in the args", and every row below satisfied it while being ordinary
// work on this repo. `start`, `restart` and `getting-started` all contain
// `star`; a repo that lives on GitHub says `github` in release chores, Actions
// runs and `.github/` paths constantly.
//
// One match spends a MACHINE-WIDE, permanent one-shot — for every project on
// that machine, not just this one — and the only recovery is deleting
// `~/.config/opencode/.elicify-vertex-consent` by hand.
//
// MUTATION PROOFS, one per rule (each kills a different subset, which is why
// all three rules are needed):
//  - substring instead of `\bstar(ring)?\b`  -> the start/restart/getting-started rows go RED
//  - `github` restored as a topic word       -> the Actions/release/picker rows go RED
//  - repo+topic merely somewhere in the args -> the picker and the two path rows go RED
//  - the "star as a noun modifier" check gone -> the star-badge row goes RED
// ---------------------------------------------------------------------------
const REPO_WORK_FALSE_POSITIVES: Array<[string, Record<string, unknown>]> = [
  ["start (the substring trap)", { questions: [{ question: "Should I start the elicify-vertex dev server?" }] }],
  ["restart", { questions: [{ question: "elicify-vertex is stale — should I restart opencode?" }] }],
  [
    "getting-started, with a repo path in a sibling arg",
    {
      questions: [{ question: "Where should the getting-started section go?" }],
      filePath: "/home/dev/elicify-vertex/README.md",
    },
  ],
  ["a star BADGE (star as a noun)", { questions: [{ question: "Should I add a star badge to the elicify-vertex README?" }] }],
  [
    "a GitHub Actions run",
    { questions: [{ question: "The GitHub Actions run for elicify-vertex is failing — rerun?" }] },
  ],
  ["a release chore", { questions: [{ question: "Publish elicify-vertex 0.13.5 and push the tag to GitHub?" }] }],
  [
    "a repo picker that lists ours",
    {
      questions: [
        {
          question: "Which repo should I open on GitHub?",
          options: ["elicify-ai/elicify-vertex", "elicify-ai/elicify-devpods"],
        },
      ],
    },
  ],
  [
    "a repo picker that offers to star one of several",
    {
      questions: [
        {
          question: "Which of these repos should I star for you?",
          options: ["elicify-ai/elicify-vertex", "sindresorhus/ky"],
        },
      ],
    },
  ],
  [
    "a workflow path under the repo, next to the word github",
    {
      questions: [{ question: "Which GitHub workflow should I fix?" }],
      filePath: "/home/dev/elicify-vertex/.github/workflows/ci.yml",
    },
  ],
  ["how many stars (a count, not the ask)", { questions: [{ question: "How many stars does elicify-vertex have?" }] }],
]

describe("the ask is recorded whatever wording the model chooses", () => {
  // MUTATION PROOF: restore the old rule (require the full `STAR_REPO` slug)
  // -> five of these seven record nothing and go RED.
  it.each(PROMPT_PHRASINGS)("records the ask for: %s", async (question) => {
    const h = await harness()
    await questionTool(h, { questions: [{ question }] })
    expect(readStarConsent(), "an ask the harness cannot see is an ask repeated forever").toBe("asked")
    expect(await h.status()).toBe("asked")
  })

  // MUTATION PROOF: widen the matcher to a bare "star"/"github" substring
  // (drop the repo-name requirement) -> every one of these goes RED.
  it.each([...STAR_WORD_ASKS, ...REPO_WORK_ASKS, OTHER_ASK])("still ignores a non-ask: %j", async (args) => {
    const h = await harness()
    await questionTool(h, args)
    expect(readStarConsent(), "only OUR ask may spend the one-shot").toBeNull()
  })

  // ORDINARY WORK ON THIS REPO MUST NOT BURN THE ONE-SHOT.
  it.each(REPO_WORK_FALSE_POSITIVES)("does not spend the one-shot on %s", async (_label, args) => {
    const h = await harness()
    await questionTool(h, args)
    expect(readStarConsent(), "a false burn kills the ask for EVERY project on this machine, forever").toBeNull()
    expect(await h.status()).toBe("none")
  })

  // The same corpus at the DISPATCH hook, which is the one that writes for a
  // question the user never answers — a false positive there is unanswerable.
  it.each(REPO_WORK_FALSE_POSITIVES)("does not spend the one-shot on %s at dispatch either", async (_label, args) => {
    const h = await harness()
    await questionDispatched(h, args)
    expect(readStarConsent()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// THE REJECTED QUESTION. `tool.execute.after` runs only once `execute`
// RESOLVES, so a question the user escapes or rejects reaches it never — and
// under after-only observation that user is asked again next session, and the
// next, with no bound. The ask is therefore recorded at DISPATCH as well: the
// moment the question is put in front of the user is the event the marker is
// meant to record, not the moment they get around to answering it.
// ---------------------------------------------------------------------------
describe("a question the user escapes or rejects still spends the one-shot", () => {
  // MUTATION PROOF: delete the `question` branch from `tool.execute.before`
  // -> nothing is recorded and this goes RED.
  it("records `asked` on dispatch, with no completion hook ever firing", async () => {
    const h = await harness()
    await questionDispatched(h, OUR_ASK)
    expect(readStarConsent(), "the user saw the ask; escaping it is not a reason to re-ask forever").toBe("asked")
    expect(await h.status()).toBe("asked")
  })

  it("does not record a dispatched question that is not our ask", async () => {
    const h = await harness()
    for (const args of STAR_WORD_ASKS) await questionDispatched(h, args)
    await questionDispatched(h, OTHER_ASK)
    expect(readStarConsent()).toBeNull()
  })

  // The completion hook remains a backstop in its own right, so a host that
  // supplies args on only one of the two hooks is still covered.
  it("records `asked` on completion alone as well", async () => {
    const h = await harness()
    await questionCompletedOnly(h, OUR_ASK)
    expect(readStarConsent()).toBe("asked")
  })

  it("writes once, not twice, when both hooks fire for the same question", async () => {
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("asked")
    expect(JSON.parse(readFileSync(starConsentPath(), "utf8"))).toEqual({ state: "asked" })
  })

  it("never downgrades an existing decision, from either hook", async () => {
    plant(JSON.stringify({ state: "yes" }))
    const h = await harness()
    await questionDispatched(h, OUR_ASK)
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("yes")
  })
})

// ---------------------------------------------------------------------------
// JUNK IS NOT A DECISION. The marker used to pass any bare word through
// verbatim, so `banana` / `null` / `[]` became `{"consent":"banana"}` — outside
// the documented union, and per the prompt's "anything else = never raise it
// again", a permanent cancellation authored by a corrupt byte. The comparison
// was also case-sensitive, so `GAVE-UP` dodged the legacy denylist and was
// honoured as terminal.
// ---------------------------------------------------------------------------
describe("only the documented union counts as a record", () => {
  // MUTATION PROOF: restore the `prompted`/`gave-up` denylist in place of the
  // allowlist -> every row here reads as terminal and goes RED.
  it.each([
    "banana",
    "null",
    "[]",
    "{}",
    "GAVE-UP",
    "PROMPTED",
    "Gave-Up",
    '{"state":"banana"}',
    '{"state":null}',
    '{"state":[]}',
    '{"state":"GAVE-UP"}',
    '{"state":42}',
    "not json at all { oops",
  ])("reads %s as no record at all", async (contents) => {
    plant(contents)
    expect(readStarConsent(), "junk must never read as a terminal decision").toBeNull()

    const h = await harness()
    expect(await h.status()).toBe("none")
  })

  // Guard the guard: normalising case must not throw away real decisions.
  //
  // The two JSON rows with padded VALUES are the only ones that pin
  // `normalizeStarConsent`'s `.trim()`. The bare-word row does not:
  // `readStarState` trims the whole file before it ever looks at the word, so
  // `"  declined  "` survives with or without the normaliser's own trim. A
  // padded value INSIDE the JSON reaches the normaliser untouched — a
  // hand-edited or pretty-printed marker is exactly where that whitespace
  // comes from, and dropping the trim turns the user's recorded decision into
  // "no record at all".
  //
  // MUTATION PROOF: `raw.toLowerCase()` without `.trim()` -> both padded JSON
  // rows read as null and go RED.
  it.each([
    ['{"state":"YES"}', "yes"],
    ['{"state":"Declined"}', "declined"],
    ["ASKED", "asked"],
    ["  declined  ", "declined"],
    ['{"state":"  declined  "}', "declined"],
    ['{"state":"\\n\\tYES "}', "yes"],
  ])("still honours %s as %s", async (contents, expected) => {
    plant(contents)
    expect(readStarConsent()).toBe(expected)

    const h = await harness()
    expect(await h.status()).toBe(expected)
  })
})

describe("elicify_vertex_star_status — the read-only check the agent prompt calls", () => {
  it('reports "none" on a machine that was never asked', async () => {
    const h = await harness()
    expect(await h.status()).toBe("none")
  })

  it("stars NOTHING and records NOTHING — calling it must leave no trace", async () => {
    const h = await harness()
    expect(await h.status()).toBe("none")
    expect(await h.status()).toBe("none")
    expect(existsSync(starConsentPath()), "the status check must never write consent").toBe(false)
  })

  it.each(["asked", "yes", "declined"])('reports a real recorded decision: %s', async (state) => {
    plant(JSON.stringify({ state }))
    const h = await harness()
    expect(await h.status()).toBe(state)
  })

  // Deliberately NOT by calling `elicify_vertex_star` — that runs a real `gh`
  // subprocess against the live GitHub account of whoever runs the suite.
  it('stops reporting "none" once an ask has been observed', async () => {
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(await h.status()).toBe("asked")
  })
})

// ---------------------------------------------------------------------------
// The two markers that are NOT user decisions. Both must read as no record.
// ---------------------------------------------------------------------------
describe("legacy markers are NO RECORD — the machines the defects were measured on", () => {
  // MAJ-007: the arm-time build wrote "prompted" before the model had done
  // anything. Honouring it leaves the fix inert on exactly those machines.
  it("ignores a legacy bare 'prompted' marker and asks anyway", async () => {
    plant("prompted")
    expect(readStarConsent(), "legacy arm-time burn is not a real ask").toBeNull()

    const h = await harness()
    expect(await h.status(), "an arm-time marker must not suppress the ask").toBe("none")
  })

  // B-6: the twin. `gave-up` recorded that a MODEL failed to follow an
  // instruction the user never saw — terminal, machine-wide, and produced by
  // nobody's decision. Same branch, same reasoning as "prompted".
  it("ignores a legacy bare 'gave-up' marker and asks anyway", async () => {
    plant("gave-up")
    expect(readStarConsent(), "a model's failure is not a user decision").toBeNull()

    const h = await harness()
    expect(await h.status(), "a gave-up marker must not suppress the ask").toBe("none")
  })

  // The JSON shape the retry loop actually wrote to disk, `attempts` and all.
  it("ignores a legacy JSON gave-up record, attempts field included", async () => {
    plant(JSON.stringify({ state: "gave-up", attempts: 4 }))
    expect(readStarConsent(), "a model's failure is not a user decision").toBeNull()

    const h = await harness()
    expect(await h.status(), "a gave-up record must not suppress the ask").toBe("none")
  })

  it("ignores a legacy JSON prompted record", async () => {
    plant(JSON.stringify({ state: "prompted", attempts: 2 }))
    expect(readStarConsent()).toBeNull()

    const h = await harness()
    expect(await h.status()).toBe("none")
  })

  // Guard the guard: the legacy branch must not swallow real decisions.
  it("still honours a real decision carrying a stale attempts field", async () => {
    plant(JSON.stringify({ state: "declined", attempts: 3 }))
    expect(readStarConsent()).toBe("declined")

    const h = await harness()
    expect(await h.status()).toBe("declined")
  })
})

describe("the one-shot is spent only on an OBSERVED ask", () => {
  it("writes nothing across an ordinary session", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    expect(existsSync(starConsentPath()), "an ordinary session must not burn the one-shot").toBe(false)
  })

  // The exact live failure: the model used its one question call for something
  // else. That must NOT count, and must not burn the one-shot.
  it("does not count an unrelated question call", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await questionTool(h, OTHER_ASK)
    expect(readStarConsent()).toBeNull()
    expect(await h.status()).toBe("none")
  })

  it.each(STAR_WORD_ASKS)("does not count a question that merely says 'star': %j", async (args) => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await questionTool(h, args)
    expect(readStarConsent(), "only OUR ask may spend the one-shot").toBeNull()
  })

  // WITHOUT the harness arming anything. There is no arm step any more, so the
  // observation must fire on the agent's own initiative or nothing ever writes
  // `asked` and the agent re-asks every single session.
  it("records `asked` on the agent's own question, with no arming step at all", async () => {
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("asked")
    expect(await h.status()).toBe("asked")
  })

  it("persists a readable record with a known state and no attempts field", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await questionTool(h, OUR_ASK)
    const record = JSON.parse(readFileSync(starConsentPath(), "utf8"))
    expect(record).toEqual({ state: "asked" })
  })

  it("does not overwrite an existing decision when the question is asked again", async () => {
    plant(JSON.stringify({ state: "yes" }))
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("yes")
  })
})

// ---------------------------------------------------------------------------
// A RECORD THAT DID NOT PERSIST IS NOT A RECORD. `writeStarConsent` swallows
// every write error (it runs inside a hook and must not throw into the host),
// and `recordStarAskIfOurs` used to `return true` regardless — so on an
// unwritable config root the harness logged `star:asked` TWICE (once per
// observation point) for a marker that was never written. The event log said
// the one-shot was spent; the disk said nothing had happened.
// ---------------------------------------------------------------------------
describe("the ask is only reported as recorded when it actually persisted", () => {
  /** Point XDG_CONFIG_HOME under a FILE: `mkdirSync` then fails with ENOTDIR
   *  for every user, including root — a chmod-based read-only directory does
   *  not hold when the suite runs as root. */
  function blockTheConfigRoot(): void {
    const root = mkdtempSync(join(tmpdir(), "vertex-star-blocked-"))
    const blocker = join(root, "not-a-directory")
    writeFileSync(blocker, "")
    process.env.XDG_CONFIG_HOME = join(blocker, "config")
  }

  function starAskedEvents(): unknown[] {
    const path = eventsPath()
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event_type?: string })
      .filter((event) => event.event_type === "star:asked")
  }

  let previousData: string | undefined
  beforeEach(() => {
    previousData = process.env.VERTEX_DATA
    process.env.VERTEX_DATA = mkdtempSync(join(tmpdir(), "vertex-star-events-"))
  })
  afterEach(() => {
    if (previousData === undefined) delete process.env.VERTEX_DATA
    else process.env.VERTEX_DATA = previousData
  })

  // MUTATION PROOF: `writeStarConsent("asked"); return true` (the old body)
  // -> this returns true for a marker that does not exist and goes RED.
  it("recordStarAskIfOurs returns false when the write cannot land", () => {
    blockTheConfigRoot()
    expect(writeStarConsent("asked"), "the write cannot possibly have succeeded").toBe(false)
    expect(recordStarAskIfOurs(OUR_ASK), "reporting a record that is not on disk is the bug").toBe(false)
    expect(existsSync(starConsentPath())).toBe(false)
  })

  // MUTATION PROOF: same revert -> TWO `star:asked` events are logged (one per
  // observation point) with nothing on disk, and this goes RED.
  it("logs no star:asked at all when nothing could be written", async () => {
    blockTheConfigRoot()
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(existsSync(starConsentPath())).toBe(false)
    expect(starAskedEvents(), "an event for a record that does not exist").toHaveLength(0)
    expect(await h.status()).toBe("none")
  })

  // Guard the guard, and the idempotency of the two observation points: a
  // writable root logs exactly ONE event across dispatch + completion.
  it("logs exactly one star:asked when the record does land", async () => {
    const h = await harness()
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("asked")
    expect(starAskedEvents()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The harness's OWN subturn sessions are not the user. `tool.execute.before`
// returns early for a self-created session before it ever reaches the star
// branch; `tool.execute.after` recorded ABOVE its `isSelf` check, so the two
// observation points disagreed about whose `question` counts. Moot only while
// subturns are zero-tool — the marker is machine-wide and permanent, so the
// site that can spend it must not be the lenient one.
// ---------------------------------------------------------------------------
describe("a question inside the harness's own subturn never spends the one-shot", () => {
  // MUTATION PROOF: move the star block back above `if (isSelf(sid)) return`
  // in `tool.execute.after` -> the child session's question records `asked`
  // and this goes RED.
  it("ignores our star ask when it comes from a self-created child session", async () => {
    const h = await harness({ subturnsPossible: true })
    // A deep ask makes the plugin run its own intake-classification subturn,
    // which is what registers a genuinely self-created session id — a stub id
    // would prove nothing about `isSelf`.
    await userTurn(h, "/elicify-vertex\n\nrefactor the auth database migration end to end")
    const childSID = h.created()[0]
    expect(childSID, "no subturn child was created — this test would be vacuous").toBeTruthy()

    await h.hooks["tool.execute.after"]!(
      { tool: "question", sessionID: childSID, callID: "c-child", args: OUR_ASK } as never,
      { title: "question", output: "answered", metadata: {} } as never,
    )
    await h.hooks["tool.execute.before"]!(
      { tool: "question", sessionID: childSID, callID: "c-child-2" } as never,
      { args: OUR_ASK } as never,
    )

    expect(readStarConsent(), "the user never saw a question the harness asked itself").toBeNull()
  })

  // The parent session is unaffected — the guard must not swallow real asks.
  it("still records the same ask from the parent session", async () => {
    const h = await harness({ subturnsPossible: true })
    await userTurn(h, "/elicify-vertex\n\nrefactor the auth database migration end to end")
    await questionTool(h, OUR_ASK)
    expect(readStarConsent()).toBe("asked")
  })
})

// ---------------------------------------------------------------------------
// B-6: the runtime nagging loop is GONE. These are the regression tests that
// keep it from growing back.
// ---------------------------------------------------------------------------
describe("no runtime nagging", () => {
  it("never injects a star directive into the system prompt", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    expect(await h.transform()).not.toContain("elicify-ai/elicify-vertex")
    await idle(h)
    expect(await h.transform()).not.toContain("elicify-ai/elicify-vertex")
  })

  it("never injects a star directive however many quiet turns pass", async () => {
    const h = await harness()
    for (let i = 0; i < 6; i++) {
      await userTurn(h, "carry on")
      await idle(h)
      expect(await h.transform()).not.toContain("elicify-ai/elicify-vertex")
    }
  })

  it("is NEVER sent as a continuation", async () => {
    const h = await harness()
    await userTurn(h, "/elicify-vertex\n\nbuild the thing")
    await idle(h)
    expect(h.sent().filter((t) => t.includes("star elicify-ai"))).toHaveLength(0)
  })

  it("never writes a terminal state on its own — only no-file or an observed ask", async () => {
    const h = await harness()
    for (let i = 0; i < 6; i++) {
      await userTurn(h, "carry on")
      await idle(h)
    }
    expect(readStarConsent(), "nothing may give up on the user's behalf").toBeNull()
    expect(await h.status()).toBe("none")
  })
})
