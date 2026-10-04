#!/usr/bin/env bash
# End-to-end smoke: init a fleet, run the daemon, spawn containerised interactive pi instances,
# and verify they join the bus, render in tmux, and can be driven from the host.
set -uo pipefail
export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH

# End-to-end fleet smoke test. Requires podman (rootless, working) and tmux on the host, and
# spends real tokens: it drives two live models. Not part of `npm test`.
#
# Verifies the properties that the unit tests cannot: a containerised interactive pi renders in a
# host tmux window, its bridge joins the bus, a prompt typed through the pane reaches the model,
# an operator injection from the host enters the LIVE conversation, a message is delivered across
# instances, and the instances survive the host tmux server being killed outright.
ORCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E=${MULTY_E2E_DIR:-/tmp/multy-e2e}
FLEET="$E2E/.fleet"
LEDGER="$FLEET/workspace/ledger.jsonl"
MULTY="node --no-warnings $ORCH/src/cli/main.ts"
SOCK="multy-$(id -u)"

count() { grep -o "$1" "$LEDGER" 2>/dev/null | wc -l | tr -d ' '; }
waitfor() { # waitfor <pattern-in-capture> <instance> <seconds>
  for _ in $(seq 1 "$3"); do
    if $MULTY capture "$2" --root "$FLEET" 2>/dev/null | grep -q "$1"; then return 0; fi
    sleep 2
  done
  return 1
}

cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null
  $MULTY stop-all --remove --root "$FLEET" >/dev/null 2>&1
  podman rm -f multy-e2e-impl multy-e2e-reviewer >/dev/null 2>&1
  tmux -L "$SOCK" kill-server 2>/dev/null
}
trap cleanup EXIT

rm -rf "$E2E"; mkdir -p "$E2E/project"; cd "$E2E/project"
git init -q -b main .
git config user.email e2e@test.local; git config user.name E2E; git config commit.gpgsign false
echo "# e2e project" > README.md
git add README.md && git commit -qm initial

echo "### 1. init + doctor"
$MULTY init --root "$FLEET" --project "$E2E/project" --image localhost/multy-pi:latest 2>&1 | tail -8
$MULTY doctor --root "$FLEET" 2>&1 | tail -3

echo
echo "### 2. daemon"
$MULTY daemon --root "$FLEET" --tick 3000 > "$E2E/daemon.log" 2>&1 &
DAEMON_PID=$!
sleep 3
tail -2 "$E2E/daemon.log"

echo
echo "### 3. spawn implementer + reviewer"
$MULTY spawn implementer --root "$FLEET" --id e2e-impl 2>&1 | tail -8
$MULTY spawn reviewer --root "$FLEET" --id e2e-reviewer 2>&1 | tail -4

echo
echo "### 4. wait for both to join the bus"
for _ in $(seq 1 45); do
  J=$(count 'instance.connected'); [[ "${J:-0}" -ge 2 ]] && break; sleep 2
done
echo "instances connected: $(count 'instance.connected')"
grep -o '"instanceId":"[^"]*","role":"[^"]*"' "$LEDGER" 2>/dev/null | sort -u | head -5

echo
echo "### 5. containers + tmux windows"
podman ps --format '{{.Names}} {{.Status}}' | grep multy || echo "(none)"
tmux -L "$SOCK" list-windows -t fleet -F '#{window_name} | #{window_active} | dead=#{pane_dead}' 2>&1 | head -5

echo
echo "### 6. status"
$MULTY status --root "$FLEET" 2>&1 | head -8

echo
echo "### 7. implementer pane"
$MULTY capture e2e-impl --root "$FLEET" 2>&1 | grep -v '^$' | tail -10

echo
echo "### 8. drive a prompt through the pane and make it call fleet_status"
tmux -L "$SOCK" send-keys -t "fleet:implementer:e2e-impl" "Call the fleet_status tool, then reply with exactly: E2E-ALIVE" Enter
if waitfor "E2E-ALIVE" e2e-impl 45; then echo "MODEL REPLIED"; else echo "NO REPLY WITHIN 90s"; fi
$MULTY capture e2e-impl --root "$FLEET" 2>&1 | grep -v '^$' | tail -14

echo
echo "### 9. usage reached the bus?"
echo "usage records: $(count '"kind":"usage"')"

echo
echo "### 10. operator injection from the host into the live conversation"
$MULTY inject e2e-impl "Reply with exactly: HOST-INJECT-OK" --root "$FLEET" 2>&1 | tail -1
if waitfor "HOST-INJECT-OK" e2e-impl 45; then echo "INJECTION DELIVERED AND ANSWERED"; else echo "INJECTION NOT ANSWERED"; fi
$MULTY capture e2e-impl --root "$FLEET" 2>&1 | grep -v '^$' | tail -8

echo
echo "### 11. cross-instance post: host -> reviewer"
$MULTY post e2e-reviewer "Confirm receipt by replying with exactly: REVIEWER-SEES-IT" --root "$FLEET" 2>&1 | tail -1
if waitfor "REVIEWER-SEES-IT" e2e-reviewer 45; then echo "REVIEWER RECEIVED"; else echo "REVIEWER DID NOT RECEIVE"; fi
$MULTY capture e2e-reviewer --root "$FLEET" 2>&1 | grep -v '^$' | tail -8

echo
echo "### 12. ledger summary"
grep -o '"kind":"[a-z._]*"' "$LEDGER" | sort | uniq -c | sort -rn | head -12

echo
echo "### 13. daemon log"
tail -6 "$E2E/daemon.log"

echo
echo "### 14. teardown check: stop the tmux server only, containers must survive"
tmux -L "$SOCK" kill-server 2>/dev/null
sleep 3
podman ps --format '{{.Names}} {{.Status}}' | grep multy || echo "FATAL: containers died with tmux"
