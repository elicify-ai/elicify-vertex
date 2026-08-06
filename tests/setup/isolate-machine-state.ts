/**
 * Keep the test suite off the developer's real machine.
 *
 * THE BUG THIS EXISTS FOR. `npm test` was writing to the operator's actual
 * `~/.config/opencode`: a `.vertex-events.jsonl` full of events from `/tmp`
 * fixture sessions, and a `.elicify-vertex-consent` reading
 * `{"state":"gave-up","attempts":4}`. That marker was TERMINAL — running the
 * test suite silently burned the machine's one-shot GitHub-star ask, and no
 * amount of uninstalling would bring it back, because the file looked like a
 * real user decision. (B-6 has since deleted the `gave-up` state and made
 * `readStarState()` read any leftover marker as no record, so that particular
 * damage is now self-healing. This isolation still stands on its own: the
 * suite must not write to the operator's config root at all.)
 *
 * It happened because the two roots resolve differently. `starConsentPath()`
 * honours `XDG_CONFIG_HOME`, so tests that set it (starPrompt.test.ts) were
 * safe; `defaultDataRoot()` in `src/measurement.ts` hardcodes
 * `homedir()/.config/opencode` and honours only `VERTEX_DATA`. A test had to
 * set BOTH to be contained, and most set neither.
 *
 * Rather than audit every file forever, both are redirected here, once, before
 * any test module is imported. Individual tests may still override them for
 * their own fixtures — `beforeEach`/`afterEach` in those files runs later and
 * wins, which is fine: they point somewhere disposable too.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "vertex-test-home-"))

// `VERTEX_DATA` covers the event log and the receipt signing key.
process.env.VERTEX_DATA = join(sandbox, "data")
// `XDG_CONFIG_HOME` covers the star-consent marker. The harness appends
// `opencode` itself, so this is the parent, not the config dir.
process.env.XDG_CONFIG_HOME = join(sandbox, "config")
