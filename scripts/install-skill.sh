#!/usr/bin/env bash
# elicify-vertex — full installer (skill + agent + plugin registration).
#
# Usage:
#   bash scripts/install-skill.sh                    # install everything
#   SKILL_FORCE=1 bash scripts/install-skill.sh      # overwrite existing
set -uo pipefail

# --- output helper: try /dev/tty, then stderr. Never crash. ---------------
# In a real terminal, /dev/tty bypasses npm's output capture.
# In CI/headless, falls back to stderr. The /dev/tty errors in test
# environments are cosmetic and don't affect functionality.
say() {
  { echo "$1" >/dev/tty; } 2>/dev/null && return 0
  { echo "$1" >&2; } 2>/dev/null && return 0
  return 0
}

# --- resolve source files -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Symlink-resolved form, used only to test whether we are running from inside
# opencode's plugin cache. `pwd` above is logical; a prefix test needs physical.
PACKAGE_ROOT_REAL="$(cd "$PACKAGE_ROOT" && pwd -P)"
SOURCE_SKILL="$PACKAGE_ROOT/skills/vertex/SKILL.md"
SOURCE_AGENT="$PACKAGE_ROOT/agents/elicify-vertex-agent.md"

# --- resolve config root --------------------------------------------------
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
SKILL_DIR="${SKILL_TARGET_DIR:-$CONFIG_ROOT/skills/vertex}"
OPENCODE_JSON="$CONFIG_ROOT/opencode.json"
FORCE="${SKILL_FORCE:-0}"

# --- helper ---------------------------------------------------------------
# Always overwrite: these are this package's OWN files (the agent definition
# and skill, derived from the repo source). An upgrade that changes them MUST
# propagate to the installed copy — the previous "skip if exists unless
# SKILL_FORCE=1" rule left stale agent definitions in place after a redesign.
# (SKILL_FORCE is now a no-op, retained for backward compatibility of the env
# var.) User customizations belong in a differently-named file.
copy_file() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  say "  ✓ $dest"
}

# --- evict every previously resolved copy ---------------------------------
# opencode does NOT load the package npm just installed. It resolves plugins
# into its own cache, one directory per SPEC, and pins each one. From the
# single config line `"@elicify-ai/elicify-vertex"` it creates BOTH
# `<scope>/elicify-vertex` and `<scope>/elicify-vertex@latest` — verified on a
# real machine, where the two held DIFFERENT builds (0.14.1 and 0.14.0) and an
# unrelated plugin showed the same pair. So a stale build stays loadable after
# an upgrade, and two copies can be live at once.
#
# THE SCOPE DIRECTORY IS THE UNIT, not a guessed entry name. Any suffix
# opencode invents — `@latest`, a pinned `@0.14.1`, anything future — sits
# inside `@elicify-ai/`, so sweeping the scope covers all of them by
# construction. Nothing outside that directory is ever touched.
#
# WHY THIS IS GUARDED (the regression that brought the bug back a second time).
# This script is the package's `postinstall`. When opencode populates its cache
# it runs npm, and npm runs OUR postinstall from inside the entry it is
# building — measured cwd:
#   .../packages/@elicify-ai/elicify-vertex@latest/node_modules/@elicify-ai/elicify-vertex
# An unguarded sweep therefore deletes the in-flight install, its sibling entry
# and the scope itself, mid-write. opencode then re-resolves onto the wreckage,
# which is exactly how two entries pinned to two different versions appear. The
# eviction was not missing a suffix; it was firing at a moment when the only
# copy present was the new one.
CACHE_ROOTS=(
  "${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages"
  "$HOME/Library/Caches/opencode/packages"
)

# Which build is in an entry? opencode's own `<entry>/package.json` is a
# synthetic manifest — `{"dependencies":{...}}`, no `version` key — so reading
# `.version` from it yields nothing. The real manifest is one level in, under
# node_modules; the dependency pin is the fallback.
cached_pin() {
  command -v node >/dev/null 2>&1 || return 0
  node -e '
const fs = require("fs");
const pkg = "@elicify-ai/elicify-vertex";
const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch (e) { return null } };
const entry = process.argv[1];
const inner = rd(entry + "/node_modules/" + pkg + "/package.json");
if (inner && inner.version) { process.stdout.write(String(inner.version)); }
else {
  const outer = rd(entry + "/package.json");
  const v = outer && outer.dependencies && outer.dependencies[pkg];
  if (v) process.stdout.write(String(v));
}
' "$1" 2>/dev/null || true
}

# `if`/`for` blocks and explicit `return 0`, never `cond && cmd`: a false `&&`
# is the statement's exit status and aborts the script under `set -e`. This
# helper is shared verbatim with uninstall.sh, which does run under `set -e`.
evict_cached_copies() {
  local root scope entry name pin
  for root in "${CACHE_ROOTS[@]}"; do
    scope="$root/@elicify-ai"
    if [[ ! -d "$scope" ]]; then continue; fi
    for entry in "$scope"/*; do
      if [[ ! -e "$entry" ]]; then continue; fi   # unmatched glob
      name="$(basename "$entry")"
      pin="$(cached_pin "$entry")"
      rm -rf "$entry"
      if [[ -n "$pin" ]]; then
        say "  ✓ evicted cached copy @elicify-ai/$name ($pin)"
      else
        say "  ✓ evicted cached copy @elicify-ai/$name"
      fi
      EVICTED=1
    done
    # Sweep the scope itself: catches dot-entries the glob skipped, and leaves
    # no empty shell behind. Still strictly inside `@elicify-ai/`.
    rm -rf "$scope"
  done
  return 0
}

# Running from inside the cache means opencode is installing us RIGHT NOW.
running_from_plugin_cache() {
  local root real_root
  for root in "${CACHE_ROOTS[@]}"; do
    if [[ ! -d "$root" ]]; then continue; fi
    real_root="$(cd "$root" && pwd -P)" || continue
    case "$PACKAGE_ROOT_REAL/" in
      "$real_root"/*) return 0 ;;
    esac
  done
  return 1
}

EVICTED=0
if running_from_plugin_cache; then
  say ""
  say "  ⏭ opencode is resolving this plugin now — leaving its cache alone"
else
  evict_cached_copies
  if [[ "$EVICTED" == "1" ]]; then
    say "  ✓ opencode's plugin cache cleared — the next start re-resolves this build"
  fi
fi

say ""
say "  ╔══════════════════════════════════════════════════╗"
say "  ║          elicify-vertex installed!               ║"
say "  ║   Make any model work like a senior engineer      ║"
say "  ╚══════════════════════════════════════════════════╝"
say ""

# --- install skill --------------------------------------------------------
if [[ -f "$SOURCE_SKILL" ]]; then
  say "  Installing /elicify-vertex skill..."
  copy_file "$SOURCE_SKILL" "$SKILL_DIR/SKILL.md"
else
  say "  ⚠ SKILL.md not found at $SOURCE_SKILL"
fi

# --- install agent (copy to both agent/ and agents/ for compatibility) ----
if [[ -f "$SOURCE_AGENT" ]]; then
  say ""
  say "  Installing Elicify-Vertex-Agent..."
  copy_file "$SOURCE_AGENT" "$CONFIG_ROOT/agent/elicify-vertex-agent.md"
  copy_file "$SOURCE_AGENT" "$CONFIG_ROOT/agents/elicify-vertex-agent.md"
else
  say "  ⚠ Agent file not found at $SOURCE_AGENT"
fi

# --- register plugin in opencode.json -------------------------------------
say ""
say "  Registering plugin in opencode.json..."
if [[ ! -f "$OPENCODE_JSON" ]]; then
  say "  ⚠ opencode.json not found — add this manually:"
  say '    { "plugin": ["@elicify-ai/elicify-vertex"] }'
else
  node -e "
const fs = require('fs');
const path = '$OPENCODE_JSON';
const pkg = '@elicify-ai/elicify-vertex';
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {
  process.exit(0);
}
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (cfg.plugin.includes(pkg)) { process.exit(0); }
cfg.plugin.push(pkg);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
" 2>/dev/null || true
  say "  ✓ done"
fi

# --- register slash commands in opencode.json (fallback for palette visibility) ---
say ""
say "  Registering slash commands in opencode.json..."
node "$SCRIPT_DIR/register-commands.mjs" 2>/dev/null || true
say "  ✓ done"

# --- GitHub star link -----------------------------------------------------
say ""
say "  ─────────────────────────────────────────────────"
say "  Enjoying elicify-vertex? It's free and open source."
say "  A GitHub star helps other developers discover it."
say "  ─────────────────────────────────────────────────"
say "  ⭐ https://github.com/elicify-ai/elicify-vertex"
say ""
say "  ✓ Done! Restart opencode to activate."
say "  Command: /elicify-vertex  |  Agent: Elicify-Vertex-Agent"
say ""

exit 0
