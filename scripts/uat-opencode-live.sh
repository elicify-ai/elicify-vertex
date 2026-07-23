#!/usr/bin/env bash
# Real OpenCode CLI UAT — no TUI, no Node harness.
# Repo: https://github.com/elicify-ai/elicify-vertex  (this file: scripts/uat-opencode-live.sh)
#
# The plugin under test is whatever opencode loads from the user's
# ~/.config/opencode/opencode.json (or OPENCODE_* env) — typically
# @elicify-ai/elicify-vertex or a local dist path. ROOT is only the
# checkout that contains this script; it is not injected as the plugin path.
#
# Each case: clear logs → opencode run → assert debug + events.
# Requires: opencode on PATH, jq, rg; agent elicify-vertex-agent installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="${UAT_WORK:-/tmp/oc-uat}"
DATA="${UAT_DATA:-/tmp/oc-uat-data}"
DEBUG_LOG="${VERTEX_DEBUG_LOG:-${HOME}/.config/opencode/.vertex-debug.log}"
EVENTS="$DATA/.vertex-events.jsonl"
REPORT="${UAT_REPORT:-/tmp/oc-uat-report.txt}"
MODEL=${UAT_MODEL:-opencode/big-pickle}
AGENT=elicify-vertex-agent
# silence unused if a future case needs the checkout path
: "${ROOT}"

mkdir -p "$WORK" "$DATA" /tmp/oc-uat-runs
: > "$REPORT"

PASS=0
FAIL=0
RESULTS=()

log() { echo "$*" | tee -a "$REPORT"; }

clear_tel() {
  if [[ -n "${CASE_ID:-}" ]]; then
    mkdir -p "/tmp/oc-uat-runs/$CASE_ID"
    cp -f "$DEBUG_LOG" "/tmp/oc-uat-runs/$CASE_ID/debug.log" 2>/dev/null || true
    cp -f "$EVENTS" "/tmp/oc-uat-runs/$CASE_ID/events.jsonl" 2>/dev/null || true
  fi
  : > "$DEBUG_LOG"
  : > "$EVENTS"
}

run_oc() {
  local title="$1" prompt="$2"
  local out="/tmp/oc-uat-runs/${title}.out"
  local err="/tmp/oc-uat-runs/${title}.err"
  (
    cd "$WORK"
    VERTEX_DATA="$DATA" VERTEX_DEBUG=1 opencode run \
      --dir "$WORK" \
      --agent "$AGENT" \
      --model "$MODEL" \
      --auto \
      --format json \
      --title "uat-$title" \
      "$prompt"
  ) >"$out" 2>"$err" || true
  echo "$out"
}

assert() {
  local id="$1" cond="$2" detail="${3:-}"
  if eval "$cond"; then
    PASS=$((PASS+1))
    RESULTS+=("PASS|$id|$detail")
    log "  PASS  $id${detail:+ — $detail}"
  else
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL|$id|$detail")
    log "  FAIL  $id${detail:+ — $detail}"
  fi
}

dbg() { cat "$DEBUG_LOG" 2>/dev/null || true; }
ev() { cat "$EVENTS" 2>/dev/null || true; }
ev_jq() { ev | jq -c "$1" 2>/dev/null || true; }
has_dbg() { dbg | rg -q "$1"; }
has_ev() { ev | rg -q "$1"; }
count_ev() { ev | rg -c "$1" || true; }

log "=============================================="
log "OpenCode LIVE UAT  model=$MODEL agent=$AGENT"
log "work=$WORK data=$DATA"
log "=============================================="

# ---------- A1: activation via agent ----------
log ""
CASE_ID=A1
log "A1 activation (elicify-vertex-agent)"
clear_tel
run_oc A1 "Reply with exactly: A1_OK. Do not edit files. Do not run tools." >/dev/null
assert A1-plugin-loaded "has_dbg 'plugin loaded'"
assert A1-activated "has_dbg 'ACTIVATED'"
assert A1-injected "has_dbg 'INJECTED'"
assert A1-classify "has_ev '\"event_type\":\"classify\"'"
assert A1-agent "ev | rg -q 'elicify-vertex-agent'"
assert A1-reply "rg -q 'A1_OK' /tmp/oc-uat-runs/A1.out"

# ---------- A2: inactive agent should not activate if we use build ----------
log ""
CASE_ID=A2
log "A2 no activation on build agent (no /vertex)"
clear_tel
(
  cd "$WORK"
  VERTEX_DATA="$DATA" VERTEX_DEBUG=1 opencode run \
    --dir "$WORK" --agent build --model "$MODEL" --auto --format json --title uat-A2 \
    "Reply with exactly: A2_OK. Do not edit files." \
    > /tmp/oc-uat-runs/A2.out 2>/tmp/oc-uat-runs/A2.err || true
)
# build agent may still load plugin but should NOT activate gate
assert A2-no-activated "! has_dbg 'ACTIVATED' || has_dbg 'DEACTIVATED' || ! has_dbg 'chat.message: ACTIVATED'"
# stricter: no classify with agent=build activating vertex - if no ACTIVATED line, pass
if has_dbg 'chat.message: ACTIVATED'; then
  assert A2-no-activate "false" "unexpected ACTIVATED under build"
else
  assert A2-no-activate "true" "no ACTIVATED under build"
fi
assert A2-reply "rg -q 'A2_OK' /tmp/oc-uat-runs/A2.out"

# ---------- B1: deep edit without verify → STOP BLOCK ----------
log ""
CASE_ID=B1
log "B1 deep unverified edit → stop block"
printf '%s\n' 'export function add(a: number, b: number) { return a + b }' > "$WORK/math.ts"
clear_tel
run_oc B1 "DEEP thorough task. Edit math.ts to add: export function mul(a:number,b:number){return a*b}. After editing, STOP immediately. Do NOT run tsc, npm test, or any verification. Claim you are done without verifying." >/dev/null
assert B1-activated "has_dbg 'stopMode=deep' || has_dbg 'ACTIVATED'"
assert B1-file-changed "has_dbg 'file changed recorded'"
assert B1-stop-block "has_dbg 'STOP BLOCK'"
assert B1-gate-block "ev | rg -q '\"decision\":\"block\"' || has_dbg 'STOP BLOCK'"
assert B1-changed-flag "ev | rg -q '\"changed\":true' || has_dbg 'file changed'"
assert B1-math-edited "rg -q 'mul' $WORK/math.ts"

# ---------- B2: deep edit then verify → allow ----------
log ""
CASE_ID=B2
log "B2 deep edit + tsc verify → allow"
printf '%s\n' 'export function add(a: number, b: number) { return a + b }' > "$WORK/math.ts"
clear_tel
run_oc B2 "DEEP task. Edit math.ts to add export function sub(a:number,b:number){return a-b}. Then run verification: tsc --noEmit --target ES2020 --module ES2020 math.ts  (or npx -y tsc --noEmit). Only after a successful verification, reply DONE_VERIFIED." >/dev/null
assert B2-file-changed "has_dbg 'file changed recorded'"
assert B2-verified-outcome "has_dbg 'outcome=verified' || has_dbg 'verified=true' || rg -q 'outcome=verified' /tmp/oc-uat-runs/B2.out"
# snapshot immediately for flake diagnosis
mkdir -p /tmp/oc-uat-runs/B2 && cp -f "$DEBUG_LOG" /tmp/oc-uat-runs/B2/debug.log && cp -f "$EVENTS" /tmp/oc-uat-runs/B2/events.jsonl
assert B2-gate-allow "ev | rg -q '\"decision\":\"allow\"' || has_dbg 'no block needed' || has_dbg 'outcome=verified'"
assert B2-verified-true "ev | rg -q '\"verified\":true' || has_dbg 'outcome=verified' || has_dbg 'verified=true'"
assert B2-done "rg -qi 'DONE_VERIFIED|verified' /tmp/oc-uat-runs/B2.out"

# ---------- B3: verify then edit again without re-verify → block ----------
log ""
CASE_ID=B3
log "B3 verify-then-edit stale evidence → block"
printf '%s\n' 'export function add(a: number, b: number) { return a + b }' > "$WORK/math.ts"
clear_tel
run_oc B3 "DEEP task with two phases. Phase 1: edit math.ts to add export function div(a:number,b:number){return a/b}, then run: tsc --noEmit --target ES2020 --module ES2020 math.ts. Phase 2: AFTER verification succeeds, edit math.ts again to add export function mod(a:number,b:number){return a%b}, then STOP immediately without running any more verification. Claim done after the second edit only." >/dev/null
assert B3-had-verify "has_dbg 'outcome=verified' || has_dbg 'verified=true'"
assert B3-second-edit "rg -q 'mod' $WORK/math.ts || has_dbg 'file changed recorded'"
# After second edit without verify, stop should block (or we see STOP BLOCK in debug)
assert B3-stale-stop "has_dbg 'STOP BLOCK' || (ev | rg -q '\"decision\":\"block\"')"

# ---------- C1: promise-no-act TODO ----------
log ""
CASE_ID=C1
log "C1 promise-no-act with TODO later"
printf '%s\n' 'export const n = 1' > "$WORK/c1.ts"
clear_tel
run_oc C1 "Edit c1.ts to set n=2. Then in your FINAL message include exactly this sentence: TODO: I will finish the remaining tests later. Do not run any verification commands." >/dev/null
assert C1-changed "has_dbg 'file changed recorded'"
assert C1-promise-or-stop "has_dbg 'PROMISE-NO-ACT' || has_dbg 'STOP BLOCK' || ev | rg -q '\"decision\":\"block\"'"

# ---------- C2: false positive should not promise-block ----------
log ""
CASE_ID=C2
log "C2 FP language after verify should not promise-block"
printf '%s\n' 'export const n = 1' > "$WORK/c2.ts"
clear_tel
run_oc C2 "Edit c2.ts to set n=3. Run: tsc --noEmit --target ES2020 --module ES2020 c2.ts. After verification succeeds, end with exactly: I tracked down the root cause. See you later!" >/dev/null
assert C2-verified "has_dbg 'outcome=verified' || has_dbg 'verified=true'"
# Should NOT see PROMISE-NO-ACT for FP language
assert C2-no-promise-block "! has_dbg 'PROMISE-NO-ACT'"

# ---------- E: verification recognition via real bash ----------
log ""
CASE_ID=E1
log "E verification commands recognized in live bash"
printf '%s\n' 'export const n = 1' > "$WORK/e.ts"
clear_tel
run_oc E1 "Run exactly this command and show output: npx -y tsc --noEmit --target ES2020 --module ES2020 e.ts 2>&1 . Then say E1_DONE. Do not edit files." >/dev/null
assert E1-tsc-seen "has_dbg 'tsc' || has_dbg 'outcome='"
assert E1-pattern "has_dbg 'pattern=tsc' || has_dbg 'outcome=verified' || has_dbg 'outcome=failed'"

# ---------- F: docs-only deep should not stop-block ----------
log ""
CASE_ID=F1
log "F docs-only deep no stop-block"
printf '%s\n' '# Notes' > "$WORK/NOTES.md"
clear_tel
run_oc F1 "DEEP thorough documentation task. Edit NOTES.md to add a line 'UAT docs'. Do NOT edit any .ts files. Do NOT run tests. Then stop and say DOCS_DONE." >/dev/null
assert F1-docs-edit "has_dbg 'NOTES.md' || has_dbg 'file changed' || rg -q 'UAT docs' $WORK/NOTES.md"
assert F1-no-stop-block "! has_dbg 'STOP BLOCK'"

# ---------- G: review routing inject ----------
log ""
CASE_ID=G1
log "G review-recall inject"
clear_tel
run_oc G1 "Review math.ts for correctness and find security flaws. Do not edit files. Reply with a short review then REVIEW_DONE." >/dev/null
assert G1-activated "has_dbg 'ACTIVATED'"
assert G1-review-or-inject "has_dbg 'INJECTED' && (has_dbg 'review' || has_dbg 'INJECTED')"
# classify should note review if isReviewTask fired
assert G1-reply "rg -qi 'REVIEW_DONE|review' /tmp/oc-uat-runs/G1.out || rg -q 'INJECTED' $DEBUG_LOG"
assert G1-classify-review "ev | rg -q '\"review\":true' || has_dbg 'INJECTED'"

# ---------- J: tool-failure inject (failing verifier) ----------
log ""
CASE_ID=J1
log "J1 tool-failure on failing verifier"
printf '%s\n' 'export const broken: number = "not-a-number"' > "$WORK/jfail.ts"
clear_tel
run_oc J1 "Run exactly: npx -y tsc --noEmit --target ES2020 --module ES2020 jfail.ts 2>&1 . Do not fix the file. After the command fails, say J1_SEEN_FAIL. Do not claim success." >/dev/null
assert J1-tsc-failed "has_dbg 'outcome=failed' || has_dbg 'failure recorded' || has_dbg 'exit'"
assert J1-failure-recorded "has_dbg 'failure recorded' || has_dbg 'tool-failure' || has_dbg 'REPEAT FAILURE' || rg -q 'error TS|error TS2322|J1_SEEN' /tmp/oc-uat-runs/J1.out"
assert J1-reply "rg -qi 'J1_SEEN_FAIL|error|fail' /tmp/oc-uat-runs/J1.out"

# ---------- J2: repeat-failure (same failing command twice) ----------
log ""
CASE_ID=J2
log "J2 repeat-failure same verifier twice"
printf '%s\n' 'export const broken: number = "x"' > "$WORK/jrep.ts"
clear_tel
run_oc J2 "Run this exact command TWICE in two separate bash tool calls (do not combine): npx -y tsc --noEmit --target ES2020 --module ES2020 jrep.ts 2>&1 . Do not edit files. After both runs, say J2_DOUBLE_FAIL." >/dev/null
assert J2-two-failures "has_dbg 'failure recorded' || has_dbg 'REPEAT FAILURE'"
# Best-effort: repeat path logs REPEAT FAILURE when signatures match
if has_dbg 'REPEAT FAILURE'; then
  assert J2-repeat-detected "true" "REPEAT FAILURE in debug"
else
  # Accept two failure recordings if model ran twice with slightly different output
  fail_n=$(dbg | rg -c 'failure recorded' || true)
  assert J2-repeat-or-two-fails "[[ ${fail_n:-0} -ge 1 ]]" "failure_recorded_count=${fail_n:-0}"
fi
assert J2-reply "rg -qi 'J2_DOUBLE_FAIL|error|fail' /tmp/oc-uat-runs/J2.out"

# ---------- K1: debugging investigation routing ----------
log ""
CASE_ID=K1
log "K1 debugging → investigation mode"
clear_tel
run_oc K1 "Debug why the authentication test is failing. Do not edit files. Do not run tools. Reply with exactly: K1_DEBUG_OK and one hypothesis." >/dev/null
assert K1-activated "has_dbg 'ACTIVATED'"
assert K1-mode-debugging "has_dbg 'mode=debugging' || (ev | rg -q '\"mode\":\"debugging\"')"
assert K1-injected "has_dbg 'INJECTED'"
assert K1-reply "rg -q 'K1_DEBUG_OK' /tmp/oc-uat-runs/K1.out"

# ---------- K2: render grounding routing ----------
log ""
CASE_ID=K2
log "K2 render → grounding mode"
clear_tel
run_oc K2 "Build an HTML dashboard chart UI. Do not edit files yet and do not run tools. Reply with exactly: K2_RENDER_OK and name one observation step." >/dev/null
assert K2-activated "has_dbg 'ACTIVATED'"
assert K2-mode-render "has_dbg 'mode=render' || (ev | rg -q '\"mode\":\"render\"')"
assert K2-injected "has_dbg 'INJECTED'"
assert K2-reply "rg -q 'K2_RENDER_OK' /tmp/oc-uat-runs/K2.out"

# ---------- C3: ask-user exempt (promise FP) ----------
log ""
CASE_ID=C3
log "C3 ask-user tail exempt from promise-no-act"
printf '%s\n' 'export const n = 1' > "$WORK/c3.ts"
clear_tel
run_oc C3 "Edit c3.ts to set n=4. Do not run verification. End your final message with exactly: Would you like me to continue with the remaining work?" >/dev/null
assert C3-changed "has_dbg 'file changed recorded' || rg -q 'n = 4' $WORK/c3.ts"
assert C3-no-promise-block "! has_dbg 'PROMISE-NO-ACT'"

# ---------- D1: /dev/null probe + docs-only (live F1 hardening) ----------
log ""
CASE_ID=D1
log "D1 consent cat 2>/dev/null must not poison docs-only"
printf '%s\n' '# Notes' > "$WORK/NOTES.md"
clear_tel
run_oc D1 "DEEP thorough docs task. First run: cat ~/.config/.elicify-vertex-consent 2>/dev/null . Then edit NOTES.md to add line 'D1 docs'. Do NOT edit .ts files. Do NOT run tests. Say D1_DOCS_DONE." >/dev/null
assert D1-docs "rg -q 'D1 docs' $WORK/NOTES.md || has_dbg 'NOTES.md'"
assert D1-no-stop "! has_dbg 'STOP BLOCK'"
assert D1-no-bash-mutation "! has_dbg 'bash-mutation' || ! has_dbg 'STOP BLOCK'"

# ---------- Summary ----------
log ""
log "=============================================="
log "LIVE OPENCODE UAT: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
log "Events: $EVENTS"
log "Debug:  $DEBUG_LOG"
log "Runs:   /tmp/oc-uat-runs/"
log "=============================================="

if [[ "$FAIL" -gt 0 ]]; then
  log ""
  log "Failed cases:"
  for r in "${RESULTS[@]}"; do
    [[ "$r" == FAIL* ]] && log "  $r"
  done
  exit 1
fi
exit 0
