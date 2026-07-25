/**
 * Wave-3 wiring — the `config` hook body: registers the two FR-030b
 * zero-tool subagents (`vertex-judge`, `vertex-intake`), the `/elicify-vertex`
 * activation command, and the `/elicify-vertex-plan-*` slash commands.
 *
 * The `tools` field on both agents is a static wildcard-only deny map
 * (`{"*": false}`) — NOT built via `subturn.ts`'s `buildDenyMap`, which
 * calls `client.tool.ids()` (a real HTTP round trip back to the host).
 * `config` fires while the host is still bootstrapping the plugin set —
 * live-host testing showed this round trip deadlocks: the host can't finish
 * bootstrapping until `config` returns, and `config` was waiting on a host
 * call that only resolves after bootstrapping finishes. This is safe: the
 * code's own established design already treats this map as "best-effort
 * registration data, never treated as proof that tools are disabled" — the
 * FR-030b capability PROBE (`judge.ts`/`story.ts`'s `classifyMultiStory`,
 * each calling `probeCapability` before every real subturn, long after the
 * host is fully up) is the actual control of record. Removing the config-time
 * network call doesn't weaken that control, it just stops config-time
 * registration from depending on a call that can't safely be made yet.
 */
import type { OpencodeClient } from "../types.js"
import { planSlashCommands } from "./tools.js"

const AGENT_PERMISSION = { edit: "deny" as const, bash: "deny" as const, webfetch: "deny" as const }

/** @deprecated kept only so nothing importing this symbol breaks; no longer called from `applyV2Config` — see module header. */
export async function buildAgentDenyMap(_client: OpencodeClient): Promise<Record<string, boolean>> {
  return { "*": false }
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

  // Static wildcard-only deny map — see module header for why this must not
  // call the host (client.tool.ids()) at config time.
  const deny: Record<string, boolean> = { "*": false }

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
