#!/usr/bin/env bash
# elicify-vertex — full installer (skill + agent + plugin registration + star).
#
# All output goes to stderr (>&2) because npm suppresses postinstall
# stdout by default but always shows stderr.
#
# Usage:
#   bash scripts/install-skill.sh                    # install everything
#   SKILL_FORCE=1 bash scripts/install-skill.sh      # overwrite existing
#   VERTEX_NO_STAR=1 bash scripts/install-skill.sh   # skip star prompt
set -euo pipefail

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

# --- helper (all output to stderr so npm shows it) ------------------------
copy_file() {
  local src="$1" dest="$2"
  if [[ -f "$dest" ]] && [[ "$FORCE" != "1" ]]; then
    echo "  ✓ $dest (already exists)" >&2
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "  ✓ $dest" >&2
}

echo "" >&2
echo "  ╔══════════════════════════════════════════════════╗" >&2
echo "  ║          elicify-vertex installed!               ║" >&2
echo "  ║   Make any model work like a senior engineer      ║" >&2
echo "  ╚══════════════════════════════════════════════════╝" >&2
echo "" >&2

# --- install skill --------------------------------------------------------
if [[ -f "$SOURCE_SKILL" ]]; then
  echo "  Installing /vertex skill..." >&2
  copy_file "$SOURCE_SKILL" "$SKILL_DIR/SKILL.md"
else
  echo "  ⚠ SKILL.md not found at $SOURCE_SKILL" >&2
fi

# --- install agent (copy to both agent/ and agents/ for compatibility) ----
if [[ -f "$SOURCE_AGENT" ]]; then
  echo "" >&2
  echo "  Installing Elicify-Vertex-Agent..." >&2
  copy_file "$SOURCE_AGENT" "$CONFIG_ROOT/agent/elicify-vertex-agent.md"
  copy_file "$SOURCE_AGENT" "$CONFIG_ROOT/agents/elicify-vertex-agent.md"
else
  echo "  ⚠ Agent file not found at $SOURCE_AGENT" >&2
fi

# --- register plugin in opencode.json -------------------------------------
echo "" >&2
echo "  Registering plugin in opencode.json..." >&2
if [[ ! -f "$OPENCODE_JSON" ]]; then
  echo "  ⚠ opencode.json not found — add this manually:" >&2
  echo '    { "plugin": ["@elicify-ai/elicify-vertex"] }' >&2
else
  node -e "
const fs = require('fs');
const path = '$OPENCODE_JSON';
const pkg = '@elicify-ai/elicify-vertex';
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) {
  console.error('  ⚠ could not parse opencode.json — skipping');
  process.exit(0);
}
if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
if (cfg.plugin.includes(pkg)) {
  console.error('  ✓ already registered');
  process.exit(0);
}
cfg.plugin.push(pkg);
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.error('  ✓ registered @elicify-ai/elicify-vertex');
" 2>&1 || echo "  ⚠ could not update opencode.json — add \"@elicify-ai/elicify-vertex\" to plugin[] manually" >&2
fi

# --- GitHub star prompt ---------------------------------------------------
echo "" >&2
echo "  ─────────────────────────────────────────────────" >&2
echo "  Enjoying elicify-vertex? It's free and open source." >&2
echo "  A GitHub star helps other developers discover it." >&2
echo "  ─────────────────────────────────────────────────" >&2
echo "" >&2

if [[ "${VERTEX_NO_STAR:-0}" == "1" ]]; then
  echo "  (star prompt skipped — VERTEX_NO_STAR=1)" >&2
elif [[ ! -t 0 ]]; then
  # Non-interactive (npm postinstall pipes input) — try to star silently
  # if gh is available and authenticated.
  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    if gh api --method PUT /user/starred/elicify-ai/elicify-vertex 2>/dev/null; then
      echo "  ⭐ Starred! Thank you for supporting elicify-vertex." >&2
    else
      echo "  Star us: https://github.com/elicify-ai/elicify-vertex" >&2
    fi
  else
    echo "  Star us: https://github.com/elicify-ai/elicify-vertex" >&2
  fi
elif command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  # Interactive + gh available — prompt and star on yes
  printf "  Star elicify-ai/elicify-vertex on GitHub? [Y/n] " >&2
  read -r response 2>/dev/null || response="y"
  response="${response:-y}"
  case "$(echo "$response" | tr '[:upper:]' '[:lower:]')" in
    y|yes)
      if gh api --method PUT /user/starred/elicify-ai/elicify-vertex 2>/dev/null; then
        echo "  ⭐ Starred! Thank you for supporting elicify-vertex." >&2
      else
        echo "  Could not star automatically. Star manually:" >&2
        echo "  https://github.com/elicify-ai/elicify-vertex" >&2
      fi
      ;;
    *)
      echo "  No problem! You can star later: https://github.com/elicify-ai/elicify-vertex" >&2
      ;;
  esac
else
  # No gh CLI — just show the link
  echo "  Star us: https://github.com/elicify-ai/elicify-vertex" >&2
fi

echo "" >&2
echo "  ✓ Done! Restart opencode to activate." >&2
echo "  Agent: Elicify-Vertex-Agent  |  Skill: /vertex" >&2
echo "" >&2
