/**
 * The agent prompt and the `/elicify-vertex` slash template are ONE contract.
 *
 * `agents/elicify-vertex-agent.md` is the single source for behaviour;
 * `ACTIVATE_TEMPLATE` in `src/v2/wiring/config.ts` is a generated copy of that
 * file's BEHAVIOR block with an identity preamble in front, because the config
 * hook must not do filesystem IO. `scripts/sync-activate-template.mjs`
 * regenerates it and has always advertised THIS FILE as the thing that fails
 * when the two drift — but this file was deleted in 99c6090 and never replaced,
 * so from then on nothing compared them at all. A prompt edit that forgot the
 * sync step would have shipped a slash command running last month's contract,
 * silently, which is exactly the "activating by slash command is never a weaker
 * mode" promise the preamble makes to the user.
 *
 * Remedy when this file goes red: `node scripts/sync-activate-template.mjs`.
 */
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import type { OpencodeClient } from "../src/v2/types.js"
import { applyV2Config } from "../src/v2/wiring/config.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const AGENT_PATH = join(ROOT, "agents", "elicify-vertex-agent.md")
const SYNC_SCRIPT_PATH = join(ROOT, "scripts", "sync-activate-template.mjs")

const agentMarkdown = readFileSync(AGENT_PATH, "utf8")

/** The shared BEHAVIOR block, extracted exactly as the sync script does. */
function behaviorBody(): string {
  const body = agentMarkdown.split("<!-- BEHAVIOR:BEGIN -->")[1]?.split("<!-- BEHAVIOR:END -->")[0]?.trim()
  if (!body) throw new Error("no BEHAVIOR block in agents/elicify-vertex-agent.md")
  return body
}

/** `ACTIVATE_TEMPLATE` as the host receives it — read through the real config
 *  hook rather than by scraping the source literal, so what is compared is the
 *  string the user's session actually gets. */
async function activateTemplate(): Promise<string> {
  const cfgInput: { command?: Record<string, { description: string; template: string }> } = {}
  await applyV2Config(cfgInput as never, {} as OpencodeClient, "elicify-vertex")
  const command = cfgInput.command?.["elicify-vertex"]
  if (!command) throw new Error("applyV2Config registered no /elicify-vertex command")
  return command.template
}

describe("the slash template does not drift from the agent prompt", () => {
  it("has a BEHAVIOR block worth sharing", () => {
    const body = behaviorBody()
    expect(body.length).toBeGreaterThan(2000)
    expect(body.split("\n").length).toBeGreaterThan(100)
  })

  // THE DRIFT GUARD. The generated template is preamble + body verbatim, so
  // the body must be its exact tail.
  //
  // MUTATION PROOF: edit either side without running the sync script — change
  // a word in the agent markdown's BEHAVIOR block, or in `ACTIVATE_TEMPLATE` —
  // and this goes RED naming both files.
  it("ends with the agent file's BEHAVIOR block, byte for byte", async () => {
    const body = behaviorBody()
    const template = await activateTemplate()

    expect(
      template.endsWith(body),
      "ACTIVATE_TEMPLATE (src/v2/wiring/config.ts) has drifted from the BEHAVIOR block in " +
        "agents/elicify-vertex-agent.md — run: node scripts/sync-activate-template.mjs",
    ).toBe(true)
  })

  it("carries the identity preamble ahead of the shared body", async () => {
    const template = await activateTemplate()
    expect(template.startsWith("Work under the elicify-vertex verification discipline")).toBe(true)
    expect(template).toContain("keep your own identity and voice")
    // The preamble is the ONLY thing the slash path adds: everything after it
    // is the shared body, so nothing may live between the two.
    expect(template.indexOf(behaviorBody())).toBe(template.length - behaviorBody().length)
  })

  it("keeps the sync script pointing at this test", () => {
    const script = readFileSync(SYNC_SCRIPT_PATH, "utf8")
    expect(script, "the script names the enforcing test; that name must resolve to a real file").toContain(
      "tests/agent-prompt.test.ts",
    )
  })
})

// ---------------------------------------------------------------------------
// The star ask's PROMPT half (its code half is in tests/v2/starPrompt.test.ts).
//
// The harness records that the ask happened by matching the `question` tool's
// args, and `asked` is the only thing that stops the agent raising it again.
// The prompt therefore has to tell the model to name the repo — without that
// instruction, the observer is matching text nothing asked the model to write,
// which is how five of seven probed phrasings recorded nothing and left the
// user being asked every session.
// ---------------------------------------------------------------------------
describe("the star bullet tells the model to name the repo", () => {
  /**
   * THE BULLET, AND NOTHING AFTER IT.
   *
   * This used to split the body on `\n(?=- **)` and take the block containing
   * the star bullet. The star bullet is the LAST `- **` item in its section, so
   * that block ran on to the next `- **` bullet ANYWHERE in the file — 1429
   * characters spanning the end of `<how_you_work>`, all of `<grounding>`'s
   * prose and its numbered list. Every assertion below was then matched
   * against three sections of prompt instead of against the bullet, so a
   * phrase that moved out of the bullet into neighbouring text (or was never
   * in the bullet at all) still read as present.
   *
   * A markdown list item is its own `- ` line plus the INDENTED lines that
   * continue it, and that is the boundary used here. The extraction itself is
   * guarded by its own test below, because a silently-too-wide extractor is
   * how this guard stopped guarding the first time.
   */
  function starBullet(): string {
    const lines = behaviorBody().split("\n")
    const start = lines.findIndex((line) => line.startsWith("- **") && line.includes("Settle the star question"))
    if (start === -1) throw new Error("the star bullet is gone from the agent prompt")
    let end = start + 1
    while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1
    return lines.slice(start, end).join("\n")
  }

  // MUTATION PROOF: restore the `split(/\n(?=- \*\*)/)` extraction -> the
  // "bullet" is 1429 chars, carries `</how_you_work>` and `<grounding>`, and
  // all three assertions go RED.
  it("extracts the bullet itself, not every section after it", () => {
    const bullet = starBullet()

    expect(bullet.startsWith("- **Settle the star question")).toBe(true)
    expect(bullet, "the extraction ran out of the bullet and into the next section").not.toContain("</how_you_work>")
    expect(bullet).not.toContain("<grounding>")
    expect(bullet.length, "a bullet this long is not a bullet — the boundary has slipped").toBeLessThan(1000)
  })

  // MUTATION PROOF: delete the "write the slug verbatim" sentence from the
  // agent markdown (and re-sync) -> RED.
  it("requires the exact slug in the question text", () => {
    const bullet = starBullet()
    expect(bullet).toContain("elicify-ai/elicify-vertex")
    expect(bullet.toLowerCase()).toContain("verbatim")
    expect(bullet).toContain("question")
  })

  it("still gates the ask on the read-only status tool", () => {
    const bullet = starBullet()
    expect(bullet).toContain("elicify_vertex_star_status")
    expect(bullet).toContain("elicify_vertex_star")
    expect(bullet, "the model must never run gh itself").toMatch(/never run `gh`/)
  })

  it("reaches the slash-command path too", async () => {
    const template = await activateTemplate()
    expect(template).toContain("elicify-ai/elicify-vertex")
    expect(template.toLowerCase()).toContain("verbatim")
  })
})
