#!/usr/bin/env bash
# elicify-vertex — full installer (skill + agent + plugin registration + star).
#
# Output goes to /dev/tty (bypasses npm's lifecycle script suppression).
# Falls back to stderr if /dev/tty is unavailable (CI, Docker, etc.).
#
# Usage:
#   bash scripts/install-skill.sh                    # install everything
#   SKILL_FORCE=1 bash scripts/install-skill.sh      # overwrite existing
#   VERTEX_NO_STAR=1 bash scripts/install-skill.sh   # skip star prompt
set -euo pipefail

# --- output helper: try /dev/tty (bypasses npm capture), fall back to stderr
if { exec 3>/dev/tty; } 2>/dev/null; then
  OUT="/dev/fd/3"
else
  OUT="/dev/stderr"
fi

say() { echo "$1" >"$OUT"; }

# --- resolve source files -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SKILL="$PACKAGE_ROOT/skills/vertex/SKILL.md"
SOURCE_AGENT="$PACKAGE_ROOT/agents/elicify-vertex-agent.md"

# --- resolve config root --------------------------------------------------
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
SKILL_DIR="${SKILL_TARGET_DIR:-$CONFIG_ROOT/skills/vertex}"
OPENCODE_JSON="$CONFIG_ROOT/opencode.json"
FORCE="${SKILL_FORCE:-0}"

# --- helper ---------------------------------------------------------------
copy_file() {
  local src="$1" dest="$2"
  if [[ -f "$dest" ]] && [[ "$FORCE" != "1" ]]; then
    say "  ✓ $dest (already exists)"
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  say "  ✓ $dest"
}

say ""
say "  ╔══════════════════════════════════════════════════╗"
say "  ║          elicify-vertex installed!               ║"
say "  ║   Make any model work like a senior engineer      ║"
say "  ╚══════════════════════════════════════════════════╝"
say ""

# --- install skill --------------------------------------------------------
if [[ -f "$SOURCE_SKILL" ]]; then
  say "  Installing /vertex skill..."
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
const tty = '$OUT';
const msg = (s) => fs.appendFileSync(tty, s + '\n');
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {
  msg('  ⚠ could not parse opencode.json — skipping');
  process.exit(0);
}
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (cfg.plugin.includes(pkg)) {
  msg('  ✓ already registered');
  process.exit(0);
}
cfg.plugin.push(pkg);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
msg('  ✓ registered @elicify-ai/elicify-vertex');
" 2>&1 || say "  ⚠ could not update opencode.json"
fi

# --- GitHub star (prompted AFTER npm finishes, explicit consent) -----------
say ""
say "  ─────────────────────────────────────────────────"
say "  Enjoying elicify-vertex? It's free and open source."
say "  A GitHub star helps other developers discover it."
say "  ─────────────────────────────────────────────────"

# Unset GH_TOKEN so gh uses stored credentials
unset GH_TOKEN 2>/dev/null || true

CONSENT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/.elicify-vertex-consent"

if [[ "${VERTEX_NO_STAR:-0}" == "1" ]]; then
  say "  (skipped — VERTEX_NO_STAR=1)"
elif ! command -v gh &>/dev/null || ! gh auth status &>/dev/null 2>&1; then
  say "  ⭐ Star us: https://github.com/elicify-ai/elicify-vertex"
elif [[ -f "$CONSENT_FILE" ]]; then
  # Consent already recorded
  if [[ "$(cat "$CONSENT_FILE" 2>/dev/null)" == "yes" ]]; then
    gh api --method PUT /user/starred/elicify-ai/elicify-vertex 2>/dev/null && \
      say "  ⭐ Starred! Thank you." || \
      say "  Star us: https://github.com/elicify-ai/elicify-vertex"
  fi
  # If "no", stay silent — we already asked
else
  # First install — fork a background prompt that runs AFTER npm exits.
  # postinstall must not block; the subshell waits for npm to finish, then
  # asks interactively when the terminal is free.
  (
    sleep 1
    printf "\n  ─────────────────────────────────────────────────\n" >/dev/tty
    printf "  Would you like to star elicify-ai/elicify-vertex on GitHub?\n" >/dev/tty
    printf "  It helps other developers discover it. [Y/n] " >/dev/tty
    ans=""
    read -r ans </dev/tty 2>/dev/null || ans="n"
    case "$ans" in
      ""|[Yy]|[Yy][Ee][Ss])
        if gh api --method PUT /user/starred/elicify-ai/elicify-vertex 2>/dev/null; then
          echo "yes" > "$CONSENT_FILE" 2>/dev/null
          printf "  ⭐ Starred! Thank you for supporting elicify-vertex.\n" >/dev/tty
        else
          printf "  Could not star — visit https://github.com/elicify-ai/elicify-vertex\n" >/dev/tty
        fi
        ;;
      *)
        echo "no" > "$CONSENT_FILE" 2>/dev/null
        printf "  No problem! You can star later: https://github.com/elicify-ai/elicify-vertex\n" >/dev/tty
        ;;
    esac
    printf "\n" >/dev/tty
  ) &
  disown 2>/dev/null || true
fi

say ""
say "  ✓ Done! Restart opencode to activate."
say "  Agent: Elicify-Vertex-Agent  |  Skill: /vertex"
say ""
