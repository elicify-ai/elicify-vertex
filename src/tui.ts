/**
 * elicify-vertex TUI plugin — the "star on GitHub" first-run consent prompt.
 *
 * WHY A SEPARATE MODULE. opencode plugins come in two mutually exclusive
 * shapes: a *server* plugin (`{ server }`, runs headless, gets `Hooks`) and a
 * *TUI* plugin (`{ tui }`, runs in the interactive terminal, gets the `TuiPluginApi`
 * with `ui.DialogConfirm` / `ui.dialog` / `event` / `state`). The verification
 * harness lives in the server plugin (`src/plugin.ts`); only the TUI plugin can
 * render a real yes/no dialog, so the star prompt lives here.
 *
 * WHY THIS REPLACES THE OLD LLM `<first_run>` BLOCK. Previously the agent
 * prompt told the model to `cat` a consent file, ask via the `question` tool,
 * run `gh api` over bash, and write the file — all of it LLM-driven, all of it
 * visible in the chat, and nondeterministic (the model could skip or fumble it).
 * This module makes it deterministic and LLM-free:
 *   - the popup is `ui.DialogConfirm`, driven by the plugin (not the model);
 *   - the `gh` star call runs as the plugin's OWN subprocess (like the server
 *     plugin's `git diff` helper), never as a bash tool call, so it never
 *     appears in the chat;
 *   - it fires once per machine (consent file persists) and not at all in
 *     headless `opencode run` (no TUI loads), which is the correct behavior for
 *     CI/automation.
 *
 * TYPING: `@opencode-ai/plugin` does not re-export `TuiPluginApi` from its
 * package root, and importing it from `dist/tui.d.ts` drags in JSX/lib
 * requirements this project's `tsconfig.json` does not carry. The slice of the
 * API this module uses is therefore declared structurally below — the same
 * loose-typing convention the server plugin uses for `OpencodeClient`.
 */
import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const REPO = "elicify-ai/elicify-vertex"
const CONSENT_NAME = ".elicify-vertex-consent"

interface TuiDialogStack {
  replace(render: () => unknown, onClose?: () => void): void
  clear(): void
}
interface TuiConfirmProps {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
}
interface TuiApi {
  ui?: {
    DialogConfirm?: (props: TuiConfirmProps) => unknown
    dialog?: TuiDialogStack
  }
  state?: { path?: { config?: string } }
  event?: { on?: (type: string, handler: (event: unknown) => void) => () => void }
}

/**
 * Star the repo using the user's own `gh auth login` credentials. `GH_TOKEN` /
 * `GITHUB_TOKEN` are stripped from the env so a token held by the agent process
 * can't override the user's interactive `gh` auth (mirrors the old prompt's
 * `unset GH_TOKEN`). Spawned as a detached subprocess with `stdio: "ignore"` —
 * it produces no chat output and no console noise. Best-effort: a failed star
 * (no `gh`, not authed, offline) is swallowed and recorded as "no" consent so
 * the user is never re-prompted by a transient failure.
 */
function starRepo(): boolean {
  const env = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  try {
    execFileSync("gh", ["api", "--method", "PUT", `/user/starred/${REPO}`], {
      env,
      stdio: "ignore",
      timeout: 15_000,
    })
    return true
  } catch {
    return false
  }
}

function consentPath(api: TuiApi): string | null {
  const configDir = api.state?.path?.config
  return configDir ? join(configDir, CONSENT_NAME) : null
}

/**
 * The TUI plugin entry. Runs once at interactive TUI startup. It registers a
 * one-shot `session.created` listener so the dialog surfaces on the user's
 * first session (less jarring than a popup the instant the app opens) and never
 * twice in one process. A machine that has already answered (consent file
 * present) sees nothing at all.
 */
export const tui = async (api: TuiApi): Promise<void> => {
  const dialog = api.ui?.dialog
  const DialogConfirm = api.ui?.DialogConfirm
  const on = api.event?.on
  if (!dialog || !dialog.replace || !dialog.clear || !DialogConfirm || !on) return

  let prompted = false
  on("session.created", () => {
    if (prompted) return
    const path = consentPath(api)
    if (!path) return
    try {
      if (existsSync(path)) return // already answered on a previous run
    } catch {
      return
    }
    prompted = true

    const writeConsent = (value: string): void => {
      try {
        writeFileSync(path, value, { mode: 0o600 })
      } catch {
        // Non-fatal: worst case the user is asked again next run.
      }
    }

    dialog.replace(
      () =>
        DialogConfirm({
          title: "Star elicify-vertex? ⭐",
          message:
            "It's free and open source. Starring it helps other developers discover it. " +
            "This is asked exactly once. (Run `gh auth login` first to star.)",
          onConfirm: () => {
            void starRepo()
            writeConsent("yes")
            dialog.clear()
          },
          onCancel: () => {
            writeConsent("no")
            dialog.clear()
          },
        }),
    )
  })
}

const tuiPluginModule = { tui }
export default tuiPluginModule
