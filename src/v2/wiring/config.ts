/**
 * Wave-3 wiring — the `config` hook body: registers the two FR-030b
 * zero-tool subagents (`vertex-judge`, `vertex-intake`), the `/elicify-vertex`
 * activation command, and the `/elicify-vertex-plan-*` slash commands.
 *
 * Zero-tool enforcement is carried ENTIRELY by `AGENT_PERMISSION` below
 * (specifically its `"*": "deny"` wildcard), NOT by the `tools` deny map.
 * Live-host testing (opencode 1.18.4, via `opencode debug agent` against
 * throwaway probe agents registered four different ways) established the
 * host's actual behaviour, which contradicts the bundled SDK's `AgentConfig`
 * type:
 *
 *   - `tools: {name: false}` on a plugin-registered agent is IGNORED. An
 *     agent registered with ONLY a tools-deny map resolves every tool to
 *     `true` — including `bash`, `edit`, `write` and `webfetch`. Two earlier
 *     versions of this file got this wrong in different ways (first a bare
 *     `{"*": false}`, then an enumerated `KNOWN_TOOL_NAMES` list); neither
 *     denied anything, because the field itself is not consulted.
 *   - `permission: {"*": "deny"}` DOES resolve the agent to zero enabled
 *     tools, and is what actually delivers FR-030b.
 *
 * The `tools` deny map is still passed (harmless, and correct per the
 * documented type should a host ever honour it) but must never be relied on
 * as the control. It is deliberately NOT built via `subturn.ts`'s
 * `buildDenyMap`, which calls `client.tool.ids()` — a real HTTP round trip
 * back to the host. `config` fires while the host is still bootstrapping the
 * plugin set, and live testing showed that round trip deadlocks: the host
 * can't finish bootstrapping until `config` returns, and `config` was
 * waiting on a call that only resolves after bootstrapping finishes.
 *
 * The FR-030b capability PROBE (`judge.ts` / `story.ts`'s
 * `classifyMultiStory`, each calling `probeCapability` before every real
 * subturn, long after the host is fully up) remains the control of record:
 * it reads the resolution back and refuses (`judge:unsupported` /
 * `intake:unsupported`) if anything is still enabled — so a host that
 * honours neither mechanism degrades to "judge disabled", never to "judge
 * running with unaudited capability".
 */
import type { OpencodeClient } from "../types.js"
import { planSlashCommands } from "./tools.js"

/**
 * FR-030b zero-tool enforcement. The `"*": "deny"` wildcard is the load-bearing
 * entry and MUST NOT be removed: live-host testing (opencode 1.18.4,
 * `opencode debug agent`) established that
 *   - the `tools: {name: false}` map is IGNORED entirely for agent registration —
 *     an agent registered with only a tools-deny map resolves EVERY tool to
 *     `true`, including `bash`, `edit`, `write` and `webfetch`;
 *   - `permission: {"*": "deny"}` DOES resolve the agent to zero enabled tools.
 * The explicit `edit`/`bash`/`webfetch` entries are kept alongside the wildcard
 * because `probeCapability` (subturn.ts) requires a rule *naming* each of those
 * three to prove denial — the wildcard alone satisfies the zero-tool check but
 * emits no per-permission rule for the probe to read back.
 */
const AGENT_PERMISSION = {
  "*": "deny" as const,
  edit: "deny" as const,
  bash: "deny" as const,
  webfetch: "deny" as const,
}

/**
 * Every opencode core built-in tool name observed on a live host
 * (`bash`, `edit`, `write`, `read`, `glob`, `grep`, `task`, `todowrite`,
 * `skill`, `question`, `webfetch`, `invalid`) plus a few documented
 * built-ins not observed in that specific run but known to exist in other
 * opencode configurations (MCP resource helpers, patch/multi-edit), plus
 * this plugin's own `elicify_vertex_plan_*` tool names. Extra entries for
 * tools that don't exist on a given host are harmless no-ops.
 */
const KNOWN_TOOL_NAMES = [
  "bash",
  "edit",
  "write",
  "read",
  "glob",
  "grep",
  "task",
  "todowrite",
  "skill",
  "question",
  "webfetch",
  "invalid",
  "patch",
  "multiedit",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "elicify_vertex_plan_create",
  "elicify_vertex_plan_next",
  "elicify_vertex_plan_checkpoint",
  "elicify_vertex_plan_status",
  "elicify_vertex_plan_clear",
]

function buildStaticDenyMap(): Record<string, boolean> {
  const deny: Record<string, boolean> = { "*": false }
  for (const name of KNOWN_TOOL_NAMES) deny[name] = false
  return deny
}

/** @deprecated kept only so nothing importing this symbol breaks; no longer called from `applyV2Config` — see module header. */
export async function buildAgentDenyMap(_client: OpencodeClient): Promise<Record<string, boolean>> {
  return buildStaticDenyMap()
}

export interface V2ConfigHookInput {
  agent?: Record<string, unknown>
  command?: Record<string, { description: string; template: string; agent?: string }>
}

const ACTIVATE_TEMPLATE = `Activate the elicify-vertex 2 verification harness for this session.

Follow observed evidence over intent: ground every "done" claim in a tool result from this turn, run the narrowest relevant verifier after changing files, and state gaps explicitly rather than assuming success.

For multi-step work, confirm a story plan first (elicify_vertex_plan_create) and checkpoint each story with evidence (elicify_vertex_plan_checkpoint).`

export async function applyV2Config(
  cfgInput: V2ConfigHookInput,
  _client: OpencodeClient,
  activateCommandName: string,
): Promise<Record<string, boolean>> {
  cfgInput.command = cfgInput.command ?? {}
  if (!cfgInput.command[activateCommandName]) {
    cfgInput.command[activateCommandName] = {
      description: "Activate the elicify-vertex 2 verification harness for this session.",
      template: ACTIVATE_TEMPLATE,
    }
  }
  for (const [name, command] of Object.entries(planSlashCommands())) {
    cfgInput.command[name] ??= command
  }

  // Static, hardcoded-tool-name deny map — see module header for why this
  // must not call the host (client.tool.ids()) at config time.
  const deny: Record<string, boolean> = buildStaticDenyMap()

  cfgInput.agent = cfgInput.agent ?? {}
  cfgInput.agent["vertex-judge"] ??= {
    mode: "subagent",
    description: "elicify-vertex internal judge subturn — zero-tool, evidence-only, never gates a checkpoint.",
    tools: deny,
    permission: AGENT_PERMISSION,
    maxSteps: 1,
  }
  cfgInput.agent["vertex-intake"] ??= {
    mode: "subagent",
    description: "elicify-vertex internal intake multi-story classification subturn — zero-tool.",
    tools: deny,
    permission: AGENT_PERMISSION,
    maxSteps: 1,
  }

  return deny
}
