#!/usr/bin/env node
/**
 * Regenerate `ACTIVATE_TEMPLATE` in `src/v2/wiring/config.ts` from the shared
 * BEHAVIOR block in `agents/elicify-vertex-agent.md`.
 *
 * The agent file is the single source for behaviour; the slash path differs
 * only by its identity preamble. `tests/agent-prompt.test.ts` fails when the
 * two drift — this script is the remedy. Run it after editing the agent prompt:
 *
 *     node scripts/sync-activate-template.mjs
 *
 * `config.ts` holds a literal rather than reading the markdown at runtime,
 * because the config hook must not do filesystem IO (see that file's header).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const AGENT = join(ROOT, "agents", "elicify-vertex-agent.md")
const CONFIG = join(ROOT, "src", "v2", "wiring", "config.ts")

const PREAMBLE = `Work under the elicify-vertex verification discipline for the rest of this session.

This changes how you work, not who you are — keep your own identity and voice. Everything below is the same contract the elicify-vertex-agent runs under; the two are kept byte-identical on purpose, so activating by slash command is never a weaker mode than activating by agent.

`

const agent = readFileSync(AGENT, "utf8")
const body = agent.split("<!-- BEHAVIOR:BEGIN -->")[1]?.split("<!-- BEHAVIOR:END -->")[0]?.trim()
if (!body) {
  console.error(`[sync] no BEHAVIOR block in ${AGENT}`)
  process.exit(1)
}

const source = readFileSync(CONFIG, "utf8")
const OPEN = "const ACTIVATE_TEMPLATE = `"
const start = source.indexOf(OPEN)
if (start < 0) {
  console.error(`[sync] ACTIVATE_TEMPLATE not found in ${CONFIG}`)
  process.exit(1)
}
// The template ends at the first backtick that closes it — find it from the
// last section rather than scanning, so an embedded escaped backtick cannot
// truncate the replacement halfway through.
const end = source.indexOf("`\n", source.indexOf("</uncertainty>", start))
if (end < 0) {
  console.error("[sync] could not find the end of ACTIVATE_TEMPLATE")
  process.exit(1)
}

const escaped = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
writeFileSync(CONFIG, source.slice(0, start) + OPEN + PREAMBLE + escaped + "`" + source.slice(end + 1), "utf8")
console.log(`[sync] ${body.split("\n").length} lines of shared body -> ${CONFIG}`)
