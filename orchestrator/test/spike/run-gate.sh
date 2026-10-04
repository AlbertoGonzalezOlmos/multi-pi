#!/usr/bin/env bash
# Spike 0.10 — THE GATE.
# Proves an extension inside a containerised INTERACTIVE pi can connect to a host Unix
# socket, publish lifecycle events, expose a tool, and have an inbound message injected
# into the live conversation (visible in the attached tmux pane and acted on by the model).
set -uo pipefail
export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH

GATE=/tmp/gate
C=multy-gate
SRV=multy-gate
IMAGE=localhost/multy-pi:spike
MODEL="${MODEL:-zai/glm-5.3-flash}"

cleanup() {
  tmux -L "$SRV" kill-server 2>/dev/null
  podman rm -f "$C" >/dev/null 2>&1
  [[ -n "${BUSPID:-}" ]] && kill "$BUSPID" 2>/dev/null
}
trap cleanup EXIT

rm -rf "$GATE/run" "$GATE/agent" "$GATE/work"
mkdir -p "$GATE/run" "$GATE/agent" "$GATE/work"

echo "### 1. start the bus on the host"
node "$GATE/server.mjs" start > "$GATE/run/bus-stdout.log" 2>&1 &
BUSPID=$!
sleep 1.5
[[ -S "$GATE/run/bus.sock" ]] && echo "bus.sock present" || { echo "FATAL: no bus.sock"; exit 1; }

echo
echo "### 2. start container: interactive pi + bridge extension, podman holds the PTY"
podman run -dit --name "$C" --userns=keep-id \
  -e TERM=xterm-256color \
  -e ZAI_API_KEY -e DEEPSEEK_API_KEY -e GEMINI_API_KEY \
  -e PI_CODING_AGENT_DIR=/agent \
  -e PI_TUI_WRITE_LOG=/agent/tui-bytes.log \
  -e PI_OFFLINE=1 -e PI_SKIP_VERSION_CHECK=1 -e PI_TELEMETRY=0 \
  -e FLEET_BUS_SOCKET=/fleet/run/bus.sock \
  -e FLEET_INSTANCE_ID=gate-worker \
  -e FLEET_ROLE=worker \
  -v "$GATE/agent:/agent" -v "$GATE/work:/work" \
  -v "$GATE/run:/fleet/run" -v "$GATE/bridge.ts:/gate/bridge.ts:ro" \
  -w /work "$IMAGE" \
  pi --tui-mode regular -a --model "$MODEL" --session-id gate-worker -e /gate/bridge.ts 2>&1 | tail -2
sleep 12
echo "container: $(podman inspect -f '{{.State.Status}}' $C)"

echo
echo "### 3. did the bridge connect and say hello?"
grep -o '"evt":"session_start"[^}]*' "$GATE/run/bus.jsonl" 2>/dev/null | head -2
grep -c '"type":"hello"' "$GATE/run/bus.jsonl" 2>/dev/null | sed 's/^/hello records: /'

echo
echo "### 4. attach a host tmux window"
tmux -L "$SRV" new-session -d -s gate -x 130 -y 42
tmux -L "$SRV" send-keys -t gate "podman attach --detach-keys=ctrl-q $C" Enter
sleep 8
echo "--- pane ---"
tmux -L "$SRV" capture-pane -t gate -p | grep -v '^$' | head -10

echo
echo "### 5. human types a first prompt"
tmux -L "$SRV" send-keys -t gate "Say exactly: STARTED" Enter
for i in $(seq 1 40); do grep -q '"evt":"agent_settled"' "$GATE/run/bus.jsonl" 2>/dev/null && break; sleep 1; done
echo "agent_settled seen: $(grep -c '"evt":"agent_settled"' "$GATE/run/bus.jsonl" 2>/dev/null)"
echo "--- pane after first prompt ---"
tmux -L "$SRV" capture-pane -t gate -p | grep -v '^$' | tail -6

echo
echo "### 6. *** THE GATE *** inject a message from the HOST into the live conversation"
# The question deliberately does NOT contain its answer, so grepping the pane for the
# answer token cannot match the injected text itself (no false positive).
BEFORE=$(grep -c '"evt":"agent_settled"' "$GATE/run/bus.jsonl" 2>/dev/null)
node "$GATE/server.mjs" inject "Compute 21 multiplied by 2. Reply with only the resulting number, no other characters."
for i in $(seq 1 60); do
  NOW=$(grep -c '"evt":"agent_settled"' "$GATE/run/bus.jsonl" 2>/dev/null)
  [[ "$NOW" -gt "$BEFORE" ]] && break
  sleep 1
done
sleep 2
PANE=$(tmux -L "$SRV" capture-pane -t gate -p)
echo "--- pane after injection ---"
echo "$PANE" | grep -v '^$' | tail -12
echo
SETTLED_AFTER=$(grep -c '"evt":"agent_settled"' "$GATE/run/bus.jsonl" 2>/dev/null)
ACKED=$(grep -c '"type":"message.ack"' "$GATE/run/bus.jsonl" 2>/dev/null)
echo "agent_settled before=$BEFORE after=$SETTLED_AFTER ; message.ack records=$ACKED"
# 42 is the answer; it cannot appear unless the model actually computed it.
if echo "$PANE" | grep -q "42" && [[ "$SETTLED_AFTER" -gt "$BEFORE" ]]; then
  echo ">>> GATE RESULT: PASS - host injection reached the model, a new turn ran, and it answered 42"
elif [[ "$SETTLED_AFTER" -gt "$BEFORE" ]]; then
  echo ">>> GATE RESULT: PARTIAL - injection triggered a new turn, but no '42' in the visible pane"
else
  echo ">>> GATE RESULT: FAIL - injection did not trigger a model turn"
fi

echo
echo "### 7. usage events reached the bus?"
grep -c '"type":"usage.report"' "$GATE/run/bus.jsonl" 2>/dev/null | sed 's/^/usage.report records: /'
grep -o '"type":"usage.report"[^}]*' "$GATE/run/bus.jsonl" 2>/dev/null | tail -1

echo
echo "### 8. bus record summary"
grep -o '"type":"[a-z._]*"' "$GATE/run/bus.jsonl" 2>/dev/null | sort | uniq -c | sort -rn | head -10
echo "--- any extension errors in the container? ---"
grep -iE "error|failed|cannot|exception" "$GATE/agent/tui-bytes.log" 2>/dev/null | head -3 || echo "(none in byte log)"
