# multi-pi — Parent Orchestrator over N Containerised Pi Subharnesses

Status: **plan v2, all architecture-critical spikes executed and passed.** No production code
written yet.
Scope: a harness in `/home/pentacosiarca/Documents/code/multi-pi/` that spawns **3–5 long-lived
role instances**, each a real `pi` running **in its own container with its own terminal,
settings and model**, coordinated by a parent harness through a shared information space
(mutual reviews, priorities, task distribution).

Operator decisions incorporated (2026-10-03):
1. tmux — **install it** (done: 3.7c).
2. Each subharness is a **subenvironment/container that installs pi**.
3. **Credentials shared** across subharnesses.
4. **3–5 long-lived role instances** (not 10–30 ephemeral ones).

Second round, also incorporated (§7 records them):
5. Bridge extension — **bind-mount in development, bake for release**, one profile flag.
6. **Auto-merge** approved work — no operator gate. This makes merging the only irreversible
   action in the system, so it gets a dedicated protocol (§3.8) and its own hard-problem entry
   (§6.11).
7. Parent authority — **confirmed judgement-only**; invariants stay in code (§2.5).
8. **Single host only** — the bus is a Unix socket, full stop. No TCP transport, no network
   workspace, no remote backend.
9. Image size is not a constraint — keep the `node:22-slim` base.

Claims below are either verified against `pi/` at commit `a276dabe5` (file:line given) or
**measured on this machine in the spikes recorded in §1.10**. Assumptions are labelled.

---

## 1. What the codebase study and spikes established

### 1.1 Pi's four interfaces, and the gap that shapes this project

`packages/coding-agent/src/main.ts:112-123`:

```ts
if (parsed.mode === "rpc")  return "rpc";
if (parsed.mode === "json") return "json";
if (parsed.print || !stdinIsTTY || !stdoutIsTTY) return "print";
return "interactive";
```

| Mode | Real terminal? | Structured control? | Notes |
|---|---|---|---|
| `interactive` | Yes, full TUI | No — keystrokes only | `main.ts:955` builds `InteractiveMode` |
| `print` | No | No | one-shot, final text to stdout |
| `json` | No | Read-only | JSONL events, then exit |
| `rpc` | No | Yes — full | JSONL commands in, events out |

Two hard consequences:

- **A real PTY on stdin *and* stdout is mandatory for interactive mode.** If either is a pipe, pi
  *silently* degrades to print mode. "Each subharness spins its own terminal" is therefore not
  cosmetic — it is what makes the TUI exist at all. Verified in Spike 1 (§1.10).
- **No single mode gives both a live terminal and structured control.** §2.2 is entirely about
  resolving that.

### 1.2 RPC control surface (complete, and exported)

`src/modes/rpc/rpc-types.ts:20-74` defines `RpcCommand`; responses at `:116-244`.

- Prompting: `prompt` (+ `streamingBehavior: "steer"|"followUp"`), `steer`, `follow_up`,
  `abort`, `clear_queue`, `new_session {parentSession}` (lineage).
- Model: `set_model {provider, modelId}`, `cycle_model`, `get_available_models`,
  `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels`.
- Introspection: `get_state` → `RpcSessionState` (`isStreaming`, `isCompacting`, `sessionId`,
  `sessionFile`, `messageCount`, `pendingMessageCount`, `model`, `thinkingLevel`),
  `get_messages`, `get_entries {since}` (durable cursor), `get_tree`,
  `get_last_assistant_text`, `get_session_stats`, `get_commands`.
- Session: `switch_session`, `fork`, `clone`, `get_fork_messages`, `set_session_name`,
  `export_html`. Compaction/retry: `compact`, `set_auto_compaction`, `set_auto_retry`,
  `abort_retry`. Queue modes: `set_steering_mode`, `set_follow_up_mode`. Shell: `bash`,
  `abort_bash`.

Server side: `src/modes/rpc/rpc-mode.ts` (dispatch `handleCommand` `:386-717`, event forwarding
with backpressure `:340-364`, signals/shutdown `:366-382, :726-748`, stdin loop `:750-818`).

`RpcClient` is exported (`src/index.ts:419`), options `{cliPath, cwd, env, provider, model,
args}` (`rpc-client.ts:28-41`), spawning `node [cliPath, "--mode","rpc", …]` with per-child
`cwd`/`env` (`:94-98`).

**Completion semantics — the single most important protocol fact.** A successful `prompt`
response only means accepted (`data.disposition`: `started`/`handled`). `agent_end` ends one
low-level run, but retries, overflow recovery, compaction, steering and follow-ups can continue
after it. **`agent_settled` is the only "pi will not continue on its own" signal**
(`docs/rpc.md`, `rpc-mode.ts:355-360`). If a prompt is `handled`, no `agent_settled` follows for
it at all.

**`RpcClient` must not be used as-is for a fleet.** Verified defects:

| # | Issue | Reference |
|---|---|---|
| 1 | Per-command timeout hardcoded at **30 s**, not configurable; `bash`, `compact`, `switch_session`, `abort`, `export_html` can legitimately exceed it | `rpc-client.ts:580-583` |
| 2 | `promptAndWait`/`collectEvents` default to **60 s** and **buffer every event in memory**, including all `text_delta`s | `rpc-client.ts:491, :513` |
| 3 | `stderr` accumulates **unboundedly** and every error embeds the whole buffer; all children interleave into the parent's stderr | `rpc-client.ts:100-104` |
| 4 | **No `onExit` hook**; a crashed child surfaces only as rejected requests; `exitError` is sticky | `rpc-client.ts:523-617` |
| 5 | `stop()` is SIGTERM then **SIGKILL after 1 s**, which can truncate the child's own `dispose()` + `flushRawStdout()`. Orderly path is **closing stdin** | `rpc-client.ts:150-162`, `rpc-mode.ts:750-818` |
| 6 | `start()`'s fixed **100 ms sleep is not a readiness guarantee** | `rpc-client.ts:133` |
| 7 | Command handling is **async and concurrent** (`void handleInputLine(line)`) — no ordering guarantee; always send an `id` | `rpc-mode.ts:808-809` |
| 8 | **Backpressure is bidirectional.** The child awaits `waitForRawStdoutBackpressure()` after every response *and* every event. A parent that stops reading **stalls the child's agent loop** | `rpc-mode.ts:355-363`, `rpc-client.ts:597` |
| 9 | Type lies: `getAvailableModels()` declares `ModelInfo[]`, server returns `Model<any>[]`; `bash()` cannot pass `excludeFromContext` | `rpc-client.ts:279-283` vs `rpc-mode.ts:527, :538-541` |
| 10 | Extension UI requests **block the child** until answered/timed out; `editor` has **no timeout at all** | `rpc-mode.ts:264-280` |
| 11 | Project trust is **silently `false` in RPC mode**: `hasUI` is only true for interactive, and `resolveProjectTrusted` returns `false` without a UI | `main.ts:770`, `core/project-trust.ts:86-88` |

Framing: strict LF-delimited JSON. `src/modes/rpc/jsonl.ts:8-20` deliberately avoids Node
`readline`, which also splits on `U+2028`/`U+2029` — legal inside JSON strings.

**Given decision 4 (3–5 long-lived interactive instances), RPC is demoted to an optional
headless mode, not the default path.** It matters mainly for CI and for the test harness (§5).

### 1.3 Configuration isolation is one env var — whose name is derived

`src/config.ts:539-547`:

```ts
export const APP_NAME: string = piConfigName || "pi";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
export const ENV_AGENT_DIR   = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;
```

**Gotcha: the env var name is derived from the package's `piConfig.name`.** A white-label build
would use `TAU_CODING_AGENT_DIR`. Read `ENV_AGENT_DIR` from the target pi at runtime; never
hardcode the string.

`getAgentDir()` (`config.ts:566`) returns `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`.
Everything per-user hangs off it (`docs/configuration.md`):

```
<agent-dir>/settings.json  models.json  models-store.json  auth.json  trust.json
<agent-dir>/AGENTS.md  AGENTS.override.md  SYSTEM.md  APPEND_SYSTEM.md  keybindings.json
<agent-dir>/extensions/  skills/  prompts/  themes/  agents/  mcp.json  mcp-auth.json
<agent-dir>/npm/  git/  bin/  tmp/  crashes.json  pi-debug.log  mcp.log
<agent-dir>/sessions/--<cwd-with-/-and-:-as-dashes>--/<timestamp>_<session-id>.jsonl
```

Session dir precedence (`main.ts:687-692`): `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` >
`sessionDir` setting > `<agent-dir>/sessions` (`config.ts:610`).

Runtime model switching exists at every layer: CLI `--model provider/id:thinking`, RPC
`set_model`, SDK `session.setModel()`, extension `pi.setModel()` (`types.ts:1736`; returns
`false` when the provider has no credentials).

### 1.4 Concurrency hazards — measured, with mitigations

There is **no pid file, no singleton lock, no instance check** anywhere in `src/`. N pi processes
run concurrently fine. The hazards are all in shared files:

| Artifact | Reference | Hazard | Mitigation |
|---|---|---|---|
| `settings.json` + `.lock` | `settings-manager.ts:299, :331-360` | `proper-lockfile`, 10×20 ms sync retry **then throws** | private agent dir per instance |
| `auth.json` + lock | `auth-storage.ts:52, :96-155` | `withLock` **creates the dir (0700) and file (`{}`) even for reads**; OAuth refresh contends | shared read-only, or env keys (§1.9) |
| `trust.json` + `.lock` | `trust-manager.ts:213, :138-177` | `get()` **locks and creates `<agent-dir>/` on every lookup, even read-only** | pass `-a`: sets `parsed.projectTrustOverride`, short-circuiting both (`main.ts:741-747`) |
| `models.json` / `models-store.json` | `model-runtime.ts:220-224`, `models-store.ts:24, :52-59` | lock-backed + module-level shared read-state cache | private agent dir + `PI_OFFLINE=1`; catalog is **baked into the image** (§1.10) |
| `<agent-dir>/bin` (fd, rg) | `config.ts:600`, `utils/tools-manager.ts:10-18` | `TOOLS_DIR` captured **at module load**; pi **downloads fd/rg on demand** (`interactive-mode.ts:1073`); concurrent downloads race on `renameSync` | **bake into the image** — removes the race entirely |
| `<agent-dir>/npm`, `git`, `tmp/` | `package-manager.ts:2093, :2134, :2174, :232` | write-heavy shared cache; concurrent `pi install`/`update` races | **bake packages into the image**; never install at runtime |
| package dir | `main.ts:585-589` | `cleanupWindowsSelfUpdateQuarantine(getPackageDir())` + `cleanupManagedInstall()` run on **every** startup against the *shared install* | container-local install makes this per-instance and harmless |
| `pi-debug.log`, `mcp.log`, `crashes.json` | `config.ts:615`, `mcp/index.ts:351`, `crash-log.ts:21` | interleaved appends / read-modify-write | private agent dir |
| `sessions/` | §1.5 | two writers on one file is unsafe; `--continue`/`--resume` can pick up *another* instance's session | private session dir **and** explicit `--session-id` |
| version check / telemetry / catalog refresh / radius | `utils/version-check.ts:96-108`, `core/telemetry.ts:8-13`, `model-runtime.ts:239` | network on startup | `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0` baked into the image |

**The container answers most of this table by construction**: each instance gets its own
filesystem, its own package dir, its own caches, its own `/tmp`. What still needs care is
anything we deliberately *share* across containers — credentials, the workspace, and the bus
socket (§2.7).

**`PI_OFFLINE` quirk:** `model-runtime.ts:239` tests `process.env.PI_OFFLINE === undefined`, so
`PI_OFFLINE=0` **still disables** network there, unlike `isTruthyEnvFlag` in `main.ts:576`. Never
set `PI_OFFLINE=0` to mean online; unset it.

### 1.5 Session files: readable, but never writable by a second process

Format (`docs/session-format.md`): JSONL tree, entries `{type, id, parentId, timestamp}`, v3.
Path `<agent-dir>/sessions/--<cwd>--/<timestamp>_<session-id>.jsonl`
(`session-manager.ts:1080`). `<session-id>` is a UUID unless set via `--session-id` (letters,
numbers, `.`, `_`, `-`; must start and end alphanumeric).

- **No lock anywhere in `session-manager.ts`.** Writes are single `appendFileSync` of one JSON
  line (`:1187`) — O_APPEND below PIPE_BUF is effectively atomic on Linux;
  `parseSessionEntryLine` returns `null` on parse failure (`:616-625`) so a partial trailing line
  is just dropped.
- **`_rewriteFile()` (`:1124-1133`) truncates and rewrites everything** — on version migration
  (`:1090-1094`) and branch/label rewrites. A concurrent reader can see an empty/partial file.
- **Two writers on one file: NOT safe.** Each `SessionManager` keeps its own
  `fileEntries`/`byId`/`leafId` in memory (`:988-999`) and appends blindly — no re-read, no
  merge, no lock. Result: interleaved tree with two independent leaf chains.
- **`SessionManager.open()` (`:1766-1786`) loads once and never re-reads.** No built-in tail.
  `loadEntriesFromFile(path)` exists (`:627`) but is **not re-exported from the package index** —
  so the orchestrator must parse the JSONL itself (trivial: one object per line, skip lines that
  fail to parse, exactly as `parseSessionEntryLine` does). Prefer that; it keeps us independent
  of pi internals. `fs.watch` is used only for themes and the git footer provider — never
  sessions.
- **`PI_SESSION_FILE`, `PI_SESSION_ID`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` are
  injected into the LLM-visible shell env** (`docs/environment-variables.md`). A subharness can
  self-report its transcript path with zero API work.

Rule: **the parent reads subharness transcripts, never writes them.** Read-only polling is safe
and yields a complete record even when the bridge is wedged.

### 1.6 The extension API is the right place for the coordination bridge

`src/core/extensions/types.ts`. Everything needed exists:

- **Inject inbound traffic into a live conversation**: `pi.sendMessage({customType, content,
  display, details}, {triggerTurn, deliverAs: "steer"|"followUp"|"nextTurn"})` (`:1676`) and
  `pi.sendUserMessage(content, {deliverAs, expandPromptTemplates})` (`:1686`). `sendMessage` with
  a custom type is how a peer review arrives as *structured context* rather than a fake user
  turn. Precedent: `plan-mode/index.ts:325-333`, `examples/extensions/send-user-message.ts:26-70`,
  `git-merge-and-resolve.ts:112`, `reload-runtime.ts:30-35`.
- **Hidden injection + context pruning**: `before_agent_start` can return
  `{message: {customType, content, display: false}}` (`plan-mode/index.ts:201-247`), and the
  `context` event can **filter stale injected messages** before the request
  (`plan-mode/index.ts:177-199`). This pair is the defence against coordination traffic
  permanently inflating context.
- **Lifecycle**: `on("agent_start"|"agent_end"|"agent_before_settle"|"agent_settled"|"turn_start"|
  "turn_end"|"message_start"|"message_update"|"message_end"|"tool_execution_start"|
  "tool_execution_update"|"tool_execution_end"|"session_start"|"session_shutdown"|
  "ui_prompt_start"|"ui_prompt_end"|"input"|"tool_call"|"tool_result"|"user_bash")`
  (`:1590-1612`). `agent_before_settle` and `turn_end` are *actionable*: a handler can append
  entries and return `continue: true` for one more model request (`docs/extensions.md`) — the
  hook for "if the inbox is non-empty, keep going". Docs warn an unconditional continuation
  loops.
- **Tools**: `pi.registerTool()` (`:1619`), TypeBox params, `exposure`
  (`direct|model-only|codemode|deferred|hidden`), `outputSchema` + `structuredContent`,
  `ctx.executeTool()` nesting with `parentToolCallId` and usage roll-up.
- **TUI**: `ctx.ui.setWidget(key, lines|factory, {placement})` (`:188`), `setStatus` (`:166`),
  `setTitle` (`:213`), `setFooter`, `setHeader`, `notify`, `setWorkingMessage/Visible/Indicator`,
  `custom()` overlays, **`pasteToEditor(text)`** (`interactive-mode.ts:2617`), `setEditorText`,
  `getEditorText`, and **`onTerminalInput(handler)`** which runs *before* the focused component
  and may `{consume: true}` or rewrite `{data}` (`tui.ts:474, :932-941, :1052-1066`).
- **Durable non-context state**: `pi.appendEntry(customType, data)` (`:1692`), restored by
  scanning `ctx.sessionManager.getEntries()` on `session_start`
  (`plan-mode/index.ts:118-125, :336-390`), plus `registerEntryRenderer`/`registerMessageRenderer`.
- **Side-channel LLM calls that never touch the transcript**:
  `ctx.modelRegistry.complete(model, {systemPrompt, messages}, {signal, cacheRetention,
  sessionId: uuidv7()})` (`handoff.ts:131`). Ideal for parent-side fleet summarisation.
- Commands/shortcuts/flags: `:1628, :1631, :1640`; flags must be read lazily on `session_start`
  via `pi.getFlag()` because CLI flags are unavailable in the factory (`ssh.ts:115, :184`).
- Providers: `pi.registerProvider(name, config)` (`:1803`).

**Constraint** (`docs/extensions.md`): do not start sockets/timers/watchers in the factory — some
invocations load extensions without starting a session. Start on `session_start`, tear down
idempotently on `session_shutdown`.

**`pi.events` is strictly in-process** (`src/core/event-bus.ts:1-33`, a plain `EventEmitter`
created per extension runtime at `core/extensions/loader.ts:681`). It cannot cross process
boundaries — and therefore cannot cross containers. Our own bus is mandatory, not a convenience.

### 1.7 Prior art to reuse or learn from

**(a) `examples/extensions/subagent/`** — closest existing analogue.
- Agents are markdown + YAML frontmatter (`name`, `description`, `tools`, `model`) discovered
  from `<agent-dir>/agents/` and `.pi/agents/`, re-read on *every* invocation so they can be
  edited mid-session (`agents.ts:63-107`, `index.ts:489`).
- Dispatch (`index.ts:300-347`): `spawn(pi, ["--mode","json","-p","--no-session", "--model", m,
  "--thinking", t, "--tools", …, "--append-system-prompt", tmpFile, "Task: …"], {cwd, shell:
  false, stdio: ["ignore","pipe","pipe"]})`. Prompt file via `mkdtemp` + `mode: 0o600` +
  `withFileMutationQueue`, deleted in `finally` (`:239-247, :429-440`).
- `getPiInvocation()` (`:249-262`) correctly re-execs pi across source checkouts, npm installs,
  Node and compiled Bun. **Reuse the logic** (adapted: inside a container the answer is simply
  the image's `pi` on `PATH`).
- Caps: `MAX_PARALLEL_TASKS = 8`, `MAX_CONCURRENCY = 4` via `mapWithConcurrencyLimit`
  (`:33-34, :219-236`); `PER_TASK_OUTPUT_CAP = 50 KiB` model-visible with an explicit
  `[Output truncated: N bytes omitted…]` marker; full fidelity in `details`.
- Usage accumulated from `message_end` (`:1035-1045`): input/output/cacheRead/cacheWrite/
  `cost.total`/`totalTokens`/turns.
- Abort: SIGTERM → SIGKILL after 5 s (`:411-419`).
- **Limitations we must not inherit**: one-shot only, `stdin: "ignore"`, **no steering or
  follow-up injection**, no PTY so `hasUI` is false in the child, **no timeout**, **no env
  customisation**, and **no depth guard** — nothing stops a child loading the same extension and
  nesting forever.

**(b) `src/experimental/`** — a real multi-process session stack behind `PI_EXPERIMENTAL=1`
(`core/experimental.ts:1`), excluded from npm and standalone builds:
- `coordinator.ts` — detached Unix-socket **opaque message router** (`CoordinatorMessageSchema`:
  `server_registered`, `server_replaced`, `peer_connected`, `peer_disconnected`,
  `message {from, payload}`), `COORDINATOR_PROTOCOL_VERSION = 3`, with connection-replacement
  semantics.
- `process.ts` — `spawnInternalProcess(role, args, {entryUrl, env})`, `detached: true`, role via
  `__PI_INTERNAL_SPAWN` and **consumed (deleted)** so descendants don't inherit it.
- `server.ts`, `session-worker.ts`, `session-worker-manager.ts` — one worker **child process per
  session**, directory-locked with `proper-lockfile` (`session-worker.ts:517`), startup/shutdown/
  discovery/demand timeouts, attachment refcounting, worker retirement.
- `services/README.md` — chord-facet catalogue (`SessionDirectory`, `SessionManagement`,
  `AgentController`, `Transcript`, `Models`, `SlashCommands`, `PresentationUI`) with a separate
  client TUI (`client-tui.ts:748`). `examples/plugins/pi-example-plugin/` shows a **TUI facet
  remotely triggering an agent turn on a server-owned session worker**.

This targets *detached sessions with a thin remote presentation*, is explicitly experimental,
and is mid-migration to `pi-durable` — its own TODO records tree navigation, the next-run queue,
subagents and transcript paging as currently dropped. **Decision: do not build on it.** Steal
three things: the coordinator's opaque-router socket shape, `spawnInternalProcess`'s role-env
hygiene, and the per-session directory lock.

**(c) `.pi/skills/interactive-testing.md`** — the sanctioned recipe for driving interactive pi
from outside: `tmux new-session -d -s pi-test -x 80 -y 24`, `send-keys`, `capture-pane -p`,
`send-keys Escape`, `kill-session`. Pi *detects* tmux and probes `tmux show -gv extended-keys` /
`extended-keys-format` (`interactive-mode.ts:1168-1310`), warning that modified Enter breaks
without `set -g extended-keys on` + `extended-keys-format csi-u` (`docs/tmux.md`). **Spike 3
showed this warning fires inside our containers and must be configured away.**

**(d) `pi-subagents` v0.53.0** (`~/.pi/agent/npm/node_modules/pi-subagents`) — third-party
orchestration; also spawns `pi --mode json -p` (`src/runs/foreground/execution.ts:330`), so also
terminal-less. Worth copying conceptually: `src/intercom/intercom-bridge.ts` injects an
instruction block telling the child to use a `contact_supervisor` tool for
decisions/blockers/progress **instead of ending its turn with a question**, with
`PI_INTERCOM_SESSION_ID` for addressing. Its `project-panes.ts` delegates pane creation to an
external `herdr` binary, which is **not installed here**.

### 1.8 Testing lever: a scripted provider

`packages/ai/src/compat.ts:162` exports `registerFauxProvider(options)` →
`{api, models, getModel, state, setResponses, appendResponses, getPendingResponseCount,
unregister}`, and `pi.registerProvider(name, config)` (`types.ts:1803`) installs a provider into
a real pi process. `test/suite/harness.ts` shows in-repo usage; pi's `AGENTS.md` mandates the
faux provider for its own suite ("No real provider APIs, keys, or paid tokens").

**So we can spawn genuine containerised `pi` processes that cost nothing and reply
deterministically.** Every fleet behaviour — spawn, assign, review, deadlock, crash, budget —
becomes testable end-to-end without API keys.

### 1.9 Environment (measured on this machine)

| Thing | State | Consequence |
|---|---|---|
| **tmux** | **installed 3.7c** at `/home/linuxbrew/.linuxbrew/bin/tmux` via brew | works; private server via `-L` verified |
| **podman** | **4.9.3**, rootless, daemonless, fully functional | chosen container runtime |
| rootless prereqs | `/etc/subuid`+`/etc/subgid` present (100000:65536), `newuidmap`/`newgidmap` present, `unprivileged_userns_clone=1`, `max_user_namespaces=122251` | rootless containers work without sudo |
| podman storage | `overlay` driver, cgroup v2 with `memory`+`pids` controllers, graphRoot `~/.local/share/containers/storage`, ~1.9 TB free | per-container resource limits are enforceable |
| `bwrap` | present | fallback sandbox if podman were unavailable |
| `docker`, `nerdctl`, `systemd-nspawn`, `proot`, `lxc` | missing | not options |
| Node (host) | v22.22.0 | satisfies pi's `>=22.19.0` |
| **credentials** | `~/.pi/agent/auth.json` is **`{}` — empty**. Real credentials are **env-var API keys**: `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `MOONSHOT_API_KEY`, `QWEN_TOKEN_PLAN_API_KEY` (+ non-LLM `BRAVE_API_KEY`, `GH_TOKEN`, `HF_TOKEN`). **No `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`.** | sharing = forwarding env vars by name into each container; `auth.json` mounting is irrelevant |
| host pi settings | `defaultProvider: zai`, `defaultModel: glm-5.3`, `defaultThinkingLevel: high`, packages `pi-provider-kimi-code`, `pi-subagents` | profiles must use available providers; packages must be baked into the image |
| pi copies | `~/.pi/agent/bin/pi` **v1.0.0**; npm-global **v0.84.2**; `pi/` source **v1.0.0** | image pins its own — skew becomes a non-issue (§6.6) |
| `pi/node_modules` | **not installed** | only needed if we build from source; the image installs pi from npm |

**Verified available model families** (`pi --list-models` + `pi auth check` inside a container,
`PI_OFFLINE=1`):

| Provider | Models | `auth check` |
|---|---|---|
| `google` | 22 (gemini-3.8-flash, gemini-3.5-flash, gemini-3.1-pro-preview, gemini-2.5-pro, …) | **ready** |
| `zai` | 7 (glm-5.3 1M ctx, glm-5.3-flash, glm-5.2, glm-4.7) | **ready** |
| `deepseek` | 2 (deepseek-v4-pro 1M ctx, deepseek-flash) | **ready** |
| `moonshotai` / `-cn` | 8 (kimi-k3 1M ctx, kimi-k2.7-code, kimi-k2.6) | provider id is `moonshotai`; bare `moonshot` reports `not_ready` |

**Four distinct families with ready credentials** — enough for the cross-family review design in
§3.4, which is the main practical payoff of per-instance models.

### 1.10 Spike results (all executed; all passed)

**Spike 1 — TTY propagation into a container inside a tmux pane.**
`podman run --rm -it … node -e '…isTTY…'` launched from a tmux pane via `send-keys` returned:
```
RESULT {"stdin":true,"stdout":true,"term":"xterm","cols":120,"rows":40}
```
Baselines confirmed the gate is real: host with pipes → `false/false`; container with `-i` and a
pipe on our side → `false/false`. **Pane size (120×40) propagates exactly into the container.**
⇒ pi inside a container inside a tmux pane enters interactive mode. `TERM` arrives as plain
`xterm`; we override with `TERM=xterm-256color`.

**Spike 2 — image build.** `Containerfile` from `node:22-slim` + `git ripgrep fd-find
ca-certificates curl procps` (with `ln -sf /usr/bin/fdfind /usr/local/bin/fd`) +
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0` +
`ENV PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0` built in **36 s**, image **683 MB**.
Layers are shared, so N containers cost little extra disk. Baking fd/rg and the model catalog in
**eliminates the download races in §1.4**.

**Spike 3 — Unix socket crosses the container boundary.** Host `net.createServer()` on
`/tmp/spike-bus/bus.sock`, bind-mounted at `/bus`; a container client connected and completed a
request/response round trip:
```
GOT {"v":1,"kind":"res","ok":true,"echo":"{\"v\":1,\"kind\":\"req\",\"type\":\"hello\",…}","hostPid":78552}
```
⇒ **the coordination bus needs no TCP fallback.** A bind-mounted socket dir is sufficient.

**Spike 4 — `--userns=keep-id` ownership.** Container reported `uid=1000(node)`; a file it
created in a bind mount appeared on the host as `pentacosiarca:pentacosiarca 644`.
⇒ **no root-owned droppings in the repo or workspace.** Use `--userns=keep-id` always.

**Spike 5 — credential sharing by env name.** `podman run --rm -e ZAI_API_KEY -e
DEEPSEEK_API_KEY -e GEMINI_API_KEY -e MOONSHOT_API_KEY …` (name only, **no value → forwarded from
the host env, nothing written to disk**) then `pi --list-models` under `PI_OFFLINE=1` listed 39
models across the four families, and `pi auth check --provider zai|deepseek|google` returned
`ready`. ⇒ decision 3 is satisfiable with zero secret material on disk.

**Spike 6 — full interactive round trip, and the terminal-topology decision.**
Three topologies were tested for "each subharness has its own terminal":

| Option | Mechanism | Input fidelity | Verdict |
|---|---|---|---|
| A | host tmux pane runs `podman run -it … pi` | clean | rejected: pi dies with the pane |
| B | container detached running **its own tmux** with pi inside; host pane runs `podman exec -it <c> tmux attach` | **see Spike 7** | **chosen, after Spike 7 fixed it** |
| C | container started `podman run -dit … pi` so *podman* holds the PTY; host pane runs `podman attach` | clean | **rejected by Spike 7** |

Option C appeared to pass and was recorded as chosen. It looked like this:
- pi reached interactive mode (byte log shows pi's own startup queries `\x1b[?2031h`, OSC 10/11,
  OSC 4 palette probes, `\x1b[c` DA1).
- A prompt typed through the attached pane produced a real model reply with live usage stats.
- `tmux kill-server` followed by a check **4 seconds later** still showed the container `running`.

**That last observation was wrong, and Spike 7 corrected it.** The 4-second check was simply too
early, and the follow-up re-attach showing a blank pane was pi already dead — not "waiting for a
redraw", as was assumed at the time.

**Spike 7 — SIGHUP kills pi when the attach client dies; and the `qqqq` was a locale bug.**

Two independent findings, both from instrumenting the failure rather than reasoning about it.

*7a. Detach survival.* With a real `multy spawn` (bridge, session, worktree), killing the host
tmux server exited the container **within 2 seconds**. A bisect across four spec variants was
**non-deterministic** — two *identical* specs gave opposite results — which proved it was a race,
not a configuration difference. The mechanism: pi installs a SIGHUP handler that shuts down
gracefully (`interactive-mode.ts:4314-4352`); when the sole client of a `podman attach` PTY goes
away, SIGHUP reaches pi and it exits cleanly. `--sig-proxy=false` and alternative detach keys were
both tested and **neither helps**, because the signal comes from PTY teardown, not from podman's
proxy. Isolating it: an inner tmux holding pi's PTY survives `tmux kill-server` at t+3s, t+8s and
**t+20s** with pi still running, and history is intact on re-attach. **Inner tmux is therefore
mandatory, not optional** — it is the only mechanism that satisfies "long-lived instances".

*7b. The `qqqq…` corruption was never corruption.* Spike 6 rejected Option B for injecting ~260
`q` characters into pi's editor. The real cause: the image is Debian bookworm with **tmux 3.3a**,
and the container had **no `LANG`**, so `LC_CTYPE=POSIX`. With no UTF-8 locale tmux falls back to
**DEC Special Graphics** line drawing, in which `q` *is* the horizontal-line character. The outer
tmux capture does not apply the charset shift, so the literal `q`s show. The same fallback explains
the degraded glyphs seen alongside it: `▀▀█`→`___`, `•`→`_`, `↑1.5k`→`_1.5k`. Confirmed by
capturing the *inner* pane directly, which was always clean.

The fix is one env var. With `LANG=C.UTF-8` (`C.utf8` is already present in `node:22-slim`):

```
CORRUPTION: none        ▀▀█  v1.0.0        glm-5.3-flash • high        ↑1.5k ↓6 $0.000
ROUND TRIP: OK
after tmux kill:  t+3s running  t+8s running  t+20s running   (pi still alive)
HISTORY ACROSS RE-ATTACH: OK
```

Also learned: `extended-keys-format` is **invalid in tmux 3.3a** (it needs ≥3.5). The image's inner
tmux must set only `extended-keys on` — exactly the split pi's own `docs/tmux.md` documents — while
the host tmux (3.7c via brew) can set both.

**Corrected decision: Option B**, inner tmux per container, host pane runs
`podman exec -it <c> tmux attach -t pi`, with `LANG=C.UTF-8` in the image.

Minor observations carried forward: podman prints a benign `The input device is not a TTY` warning
when `run -dit` is issued from a non-TTY context; `podman inspect -f '{{.HostConfig.Tty}}'` does not
exist in podman 4.9.3; and `node:22-slim` inherits `docker-entrypoint.sh`, which prepends `node` to
any first argument starting with `-` — so passing pi's *flags* as the container command yields
`node -a …` and pi dies with `node: bad option: -a`. The orchestrator therefore always sets
`--entrypoint` explicitly. (An empty `ENTRYPOINT []` is *not* the fix: podman then consumes the
first run argument as the entrypoint.)

---

## 2. Target architecture

### 2.1 Overview

```
 HOST
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  multy daemon + CLI (plain Node/TS)                                          │
 │   FleetManager · ContainerBackend · TmuxBackend · WorkspaceStore             │
 │   CoordinationBus (unix socket) · PolicyEngine · BudgetKeeper                │
 │                                                                              │
 │  tmux server  (tmux -L multy-<uid>)          <fleet>/workspace/  ← SHARED    │
 │   ├ window 0: parent   ┐                      ├── tasks/    ├── messages/    │
 │   ├ window 1: impl     │ each pane runs       ├── reviews/  ├── artifacts/   │
 │   ├ window 2: reviewer │ podman exec -it <c>  ├── decisions/└── ledger.jsonl │
 │   └ window 3: tester   ┘ tmux attach -t pi            ▲ bind-mounted RW      │
 │                                                       │ into EVERY container │
 │   <fleet>/run/bus.sock  ◀─────────────────────────────┼──────────────────    │
 └───────────┬──────────────────────────────────────────────────────────────────┘
             │ podman run -dit --userns=keep-id  (inner tmux holds pi's PTY)
   ┌─────────┴──────────┬────────────────────┬────────────────────┐
   │ container: parent  │ container: impl    │ container: reviewer│ …3–5 total
   │  inner tmux + pi   │  inner tmux + pi   │  inner tmux + pi   │
   │  AGENT_DIR=/agent  │  AGENT_DIR=/agent  │  AGENT_DIR=/agent  │  (private vols)
   │  model glm-5.3     │  model kimi-k3     │  model gemini-3.5  │  (per-instance)
   │  +orchestrator ext │  +bridge ext       │  +bridge ext       │
   │  /work = worktree  │  /work = worktree  │  /work = base (ro) │
   │  /fleet/run  (bus) │  /fleet/run  (bus) │  /fleet/run  (bus) │
   │  /fleet/workspace  │  /fleet/workspace  │  /fleet/workspace  │
   │  env: *_API_KEY    │  env: *_API_KEY    │  env: *_API_KEY    │  (shared creds)
   └────────────────────┴────────────────────┴────────────────────┘
```

Three planes, deliberately separated:

- **Control plane** — `CoordinationBus`: one Unix socket on the host, bind-mounted into every
  container at `/fleet/run/bus.sock` (Spike 3). Every pi process, parent included, loads a
  bridge extension that connects to it. Carries structured facts: identity, task state,
  messages, reviews, artifacts, usage, busy/idle.
- **Data plane** — `<fleet>/workspace/`, bind-mounted read-write into every container at
  `/fleet/workspace`. Plain files: auditable, git-diffable, survives everything, and **directly
  readable by each subharness's own `read`/`grep`/`bash` tools with no special API access.**
  This is the "common place where subharnesses exchange information" the user asked for, and
  mounting it makes it literally common.
- **Terminal plane** — host tmux, one window per subharness, each pane running
  `podman exec -it … tmux attach`. Observation, focus, manual intervention, emergency input.
  **Never the primary
  control channel.**

### 2.2 Decision: how a subharness gets a terminal, control, and isolation at once

Rejected:
- **tmux `send-keys` + `capture-pane` scraping as the control channel.** Pi does differential
  rendering, collapses tool output, wraps markdown, redraws on resize, and renders the working
  indicator *inside the editor's top border* (`custom-editor.ts:6-71`,
  `interactive-mode.ts:638-643`). Pixel-scraping is lossy and breaks on every theme/version
  change; it cannot express steer-vs-follow-up, cannot read usage, and cannot reliably tell idle
  from thinking. There is also **no public API to synthesise a submit (Enter)** from an
  extension. Spike 6 Option B gave a concrete example of terminal-level corruption.
- **RPC children plus a renderer we write.** Means reimplementing pi's TUI (chat viewport,
  editor, autocomplete, markdown, images, overlays — `src/modes/interactive/`, ~15 files) and
  discarding the real terminal the user asked for. Kept only as an optional headless mode for CI.

**Chosen:** interactive pi, in a container, with an **inner tmux holding its PTY** so attach
clients come and go without pi seeing a SIGHUP, surfaced through a host tmux window running
`podman exec -it <c> tmux attach -t pi`, with an in-process **bridge extension** owning a socket to
the bus. That yields: a real terminal for humans; `sendUserMessage`/`sendMessage` for inbound
traffic; `agent_settled`/`turn_end`/`message_end` for outbound facts; `registerTool` so each
subharness's *own model* participates in coordination; `setWidget`/`setStatus`/`setTitle` for
in-pane fleet state; `onTerminalInput` to detect and yield to human keystrokes; OS-level namespace
isolation for free; and — the reason the inner tmux is mandatory — a subharness that outlives its
observer (Spike 7a).

Consequence stated plainly: **the bridge extension is the single most important artifact in this
project.** It is what turns 3–5 independent containerised TUIs into a system.

### 2.3 Decision: container runtime and topology

**Runtime: podman 4.9.3, rootless, daemonless.** Chosen because it is installed and verified
working (§1.9), needs no daemon and no sudo, supports `--userns=keep-id` for clean bind-mount
ownership (Spike 4), and exposes cgroup v2 `memory`/`pids` controllers for real per-instance
resource ceilings. `bwrap` is the documented fallback if podman ever disappears; the
`ContainerBackend` interface (§2.4) keeps that swappable.

**Topology: Option B** (corrected by Spike 7). One **long-lived container per role instance**.
Inside it, tmux holds pi's PTY permanently; the human attaches with
`podman exec -it <container> tmux attach -t pi` and may vanish at any time.

```
host tmux window (presentation only)
  └─ pane: podman exec -it <c> tmux attach -t pi
       └─ container's inner tmux server  ← owns pi's PTY, never dies
            └─ pi --tui-mode regular -a --model … --session-id <id>
                 └─ fleet-bridge extension ⇄ /fleet/run/bus.sock
```

Corollaries:
- **The inner tmux is load-bearing, not redundant.** Without it, closing the attach client
delivers SIGHUP and pi exits gracefully within ~2 s (Spike 7a). `--sig-proxy=false` and alternate
detach keys do not help — the signal comes from PTY teardown, not from podman.
- **`LANG=C.UTF-8` is load-bearing.** Without a UTF-8 locale the inner tmux (3.3a) falls back to
DEC Special Graphics and pi's borders render as runs of `q` (Spike 7b). Baked into the image.
- **Version split between the two tmux layers.** Image tmux is **3.3a** (Debian bookworm): set
`extended-keys on` only, since `extended-keys-format` needs ≥3.5 and errors out. Host tmux is
**3.7c** (brew): set both. pi's `docs/tmux.md` documents exactly this split.
- **Inner prefix is `C-f`**, not the default `C-b`, so a prefix keystroke reaches one multiplexer
and not both. Inner `status off` and `mouse off`: pi draws its own footer and handles the mouse.
- **The container's lifetime equals pi's lifetime.** The wrapper blocks on
`while tmux has-session -t pi; do sleep 2; done`, so `podman inspect .State.Status` is a truthful
liveness signal for the fleet manager rather than a report about the launcher.
- **Container restart ≠ session loss.** pi persists under `/agent/sessions`, and
`tmux new-session -A` reattaches rather than failing, so `podman start` resumes. Instance identity
is the session id (`--session-id <instance-id>`), which makes recovery deterministic (§5.3).
- **Host tmux layout is presentation only.** Killing it must never kill a subharness — now
verified at t+20 s (Spike 7a), not just t+4 s.

### 2.4 Decision: backend interfaces

```ts
interface ContainerBackend {
  readonly kind: "podman" | "bwrap" | "none";
  isAvailable(): Promise<boolean>;
  ensureImage(spec: ImageSpec): Promise<string>;        // build/pull, returns image ref+digest
  create(spec: InstanceSpec): Promise<ContainerHandle>; // podman create/run -dit
  start(id: string): Promise<void>;
  attachCommand(id: string): string;                    // what the tmux pane runs
  exec(id: string, argv: string[], opts?: ExecOpts): Promise<ExecResult>;   // for probes/doctor
  stats(id: string): Promise<{ cpu: number; memBytes: number; pids: number }>;
  stop(id: string, graceMs: number): Promise<void>;     // SIGTERM -> grace -> SIGKILL
  remove(id: string): Promise<void>;
  state(id: string): Promise<"created"|"running"|"exited"|"missing">;
}

interface TmuxBackend {
  readonly kind: "tmux";
  isAvailable(): Promise<boolean>;
  ensureServer(): Promise<void>;                        // tmux -L multy-<uid>, extended-keys on
  openWindow(spec: PaneSpec): Promise<PaneHandle>;      // {id, kill, focus, resize, capture, sendKeys, pipe, title}
  list(): Promise<PaneInfo[]>;
  layout(plan: "tiled" | "tabs" | "single"): Promise<void>;
}
```

`attachCommand()` returning a *string* is deliberate: the pane runs it, so the human can also
copy-paste it into any terminal and attach manually. That is a real operational escape hatch.

### 2.5 Decision: what the parent harness is

The parent is **itself a containerised pi instance** (tmux window 0) with an `orchestrator`
extension. Rationale: the user asked for an *agentic* parent that decides priorities and
distribution. Being a pi instance gives it tools, memory, a transcript, compaction and a
human-visible terminal for free, and the operator intervenes by typing in window 0. It runs in a
container too, so it cannot accidentally touch host paths the subharnesses can't.

But **not everything is delegated to the parent model**:

| Concern | Owner | Why |
|---|---|---|
| What to work on next, splitting work, judging quality | Parent model (LLM) via orchestrator tools | Judgement |
| Task queue integrity, claim/lease, transitions, dedupe | `multy` daemon (code) | Must be deterministic and race-free |
| Review routing, quorum, and **executing merges** | `PolicyEngine` + `MergeLane` (code) — **not** overridable by the parent | Deterministic, auditable, and the only irreversible path (§3.8) |
| Emergency brake on merging, reverting a merge | Parent model (`hold_merges`, `revert_merge`) | Judgement, but only to *stop* or *undo*, never to authorise |
| Budgets, timeouts, heartbeat, restart, crash detection | `BudgetKeeper`/`FleetManager` (code) | Must fire while the parent model is thinking |
| Container/tmux lifecycle | `FleetManager` (code) | Never model-driven |
| Cross-harness transport, persistence, indexing | `CoordinationBus`/`WorkspaceStore` (code) | Infrastructure |
| Presenting fleet state to the operator | Orchestrator extension TUI | UX |

The parent model calls tools; the daemon enforces invariants. A stuck model must never wedge the
fleet, and a wedged fleet must never need a model to recover.

### 2.6 Decision: isolation boundaries per subharness

Five, because they fail independently:

1. **Kernel namespace** (new, per decision 2) — its own mount/pid/net/user namespace, its own
   `/tmp`, its own pi install, its own caches. `--userns=keep-id` so bind-mount files are owned
   by the host user (Spike 4). Optional `--memory`/`--pids-limit`/`--cpus` from the profile.
2. **Config** — private `PI_CODING_AGENT_DIR=/agent` on a per-instance volume/bind mount: own
   `settings.json` (model, thinking, tools, `tuiMode: regular`, theme,
   `defaultProjectTrust: always`), own `sessions/`, `trust.json`, caches. Credentials shared by
   env (§2.7).
3. **Filesystem writes** — private **git worktree** bind-mounted at `/work` for writers
   (`git worktree add <fleet>/worktrees/<id> -b fleet/<id>`). Pi's own `AGENTS.md` states the
   reason bluntly: multiple pi sessions in one cwd stomp on each other, and `git add -A` /
   `reset --hard` / `stash` / `clean -fd` destroy a peer's work. **Non-writers — reviewer, scout,
   and the parent — get the base tree mounted `:ro`,** so no container can integrate code itself;
   only the host-side `MergeLane` can (§3.8, §6.11).
4. **Process** — own pid namespace; stop = SIGTERM → grace → SIGKILL to the container
   (podman handles the group).
5. **Budget** — own token/cost/wall/turn ceilings enforced by the daemon, not the model.

### 2.7 Decision: what is shared, and how

Per decision 3, credentials are shared. Verified mechanism (Spike 5): **forward env vars by name
only** — `podman run -e ZAI_API_KEY` with no value makes podman copy it from the daemon's
environment. Nothing is written to disk, no `--env-file` with secrets, and `auth.json` stays
irrelevant (it is empty here anyway).

Shared surface, complete list — everything else is private:

| Shared thing | Mechanism | Mode |
|---|---|---|
| Provider API keys | `-e NAME` forwarding | in-memory only |
| `<fleet>/workspace/` (tasks, messages, reviews, artifacts, decisions, ledger) | bind mount at `/fleet/workspace` | **rw** |
| `<fleet>/run/bus.sock` | bind mount at `/fleet/run` | rw (socket only) |
| Base git checkout (read-only roles) | bind mount at `/work` | **ro** |
| The pi image | shared image layers | ro |

Deliberately **not** shared: agent dirs, sessions, worktrees for writers, `/tmp`, pi install,
caches, logs.

Rule for the data plane: **every bus mutation is written to the store first, then broadcast.** A
subharness that misses a broadcast can always reconstruct from `/fleet/workspace`. The bus is a
latency optimisation and a delivery mechanism, never the source of truth.

### 2.8 Decision: terminal settings for automatable subharnesses

From `tui-renderer.ts:9-51`, `tui-alt-screen.ts:340-380`, `tui-main-screen.ts:8-75`, and Spikes 6–7:

- **`tuiMode: "regular"`, not `fullscreen`.** Regular renders differentially into the *main*
  screen, leaves scrollback to the terminal, never enters the alt screen (`\x1b[?1049h`), and
  does not capture the mouse. `capture-pane -S -` then reaches real history. Fullscreen output
  exists only on the alt screen, so scrollback is unavailable, and it enables SGR mouse capture —
  downgraded to button-motion under tmux but still consumed (`tui-alt-screen.ts:366-377`). Set
  via `"tuiMode": "regular"` in the instance `settings.json` (`settings-manager.ts:184,
  :1349-1351`) or `--tui-mode regular` (`args.ts:216-230`). Verified in Spike 6.
- **`TERM=xterm-256color`** — podman/tmux hand pi plain `xterm` by default (Spike 1), which loses
  truecolor.
- **`LANG=C.UTF-8` and `LC_ALL=C.UTF-8` are mandatory** (Spike 7b). With `LC_CTYPE=POSIX` the inner
  tmux falls back to DEC Special Graphics, where `q` is the horizontal-line character, so every
  border pi draws appears as a run of `q`s. The same fallback degrades `▀▀█`→`___`, `•`→`_` and
  `↑1.5k`→`_1.5k`. `C.utf8` already exists in `node:22-slim`, so this costs nothing.
- **Two tmux versions, two configurations.** Image tmux is 3.3a: `extended-keys on` only, because
  `extended-keys-format` is invalid before 3.5 and the inner tmux will refuse to start cleanly.
  Host tmux is 3.7c: both options. Inner prefix `C-f` (not `C-b`) so a prefix reaches one
  multiplexer; inner `status off` and `mouse off` so pi's own footer and mouse handling are not
  duplicated or fought over.
- **`PI_TUI_WRITE_LOG=/agent/tui-bytes.log`** — `ProcessTerminal.write()` appends every byte pi
  writes (`terminal.ts:143-160, :488-497`): a complete, exact, mode-independent terminal record,
  strictly better than polling `capture-pane`. Verified (7 994 bytes for one short session).
  Rotate by size — it records spinner repaints too (§6.8).
- **Host tmux**: private server `tmux -L multy-<uid>`; `set -g extended-keys on`,
  `extended-keys-format csi-u`, `mouse on`, `history-limit 50000`. Pi probes these and warns when
  they are missing (`interactive-mode.ts:1168-1310`).
- **Size**: create the tmux window at the profile's size (`-x W -y H`); with a real PTY the ioctl
  wins and `COLUMNS`/`LINES` are only fallbacks (`terminal.ts:500-506`). Pi adapts via the
  `resize` event on `process.stdout` (`terminal.ts:187`) and self-sends `SIGWINCH` at startup
  (`refreshTerminalDimensions`, `terminal.ts:45-55`). Spike 1 confirmed 120×40 propagated exactly.
- **Identity**: pi sets the OSC 0 title to `π - <session> - <cwd>` (`interactive-mode.ts:1120-1128`,
  `terminal.ts:527-530`); tmux exposes it as `#{pane_title}`. We also `--name`/`set_session_name`
  so the title carries the role.
- **`terminal.showTerminalProgress: true`** if we want OSC 9;4 busy/idle on the wire
  (`\x1b]9;4;3\x07` indeterminate, 1000 ms keepalive; `\x1b]9;4;0\x07` clear) toggled on
  `turn_start`/`agent_end`/`compaction_*` (`terminal.ts:532-547`, `interactive-mode.ts:3375-3379,
  :3596-3637`). **Off by default** (`settings-manager.ts:61, :1336`).
- **If we ever send keys**: `ctrl+j` is the robust newline (plain LF, no extended-keys needed);
  plain `Enter` (`\r`) submits; `alt+enter` queues a follow-up. Never send `shift+enter` without
  extended-keys — it arrives as `\r` and submits prematurely. Interrupt = `escape`; clear =
  `ctrl+c` (twice exits); exit = `ctrl+d` with an empty editor. **Escape-timeout gotcha**:
  `resolveEscapeTimeoutMs()` (`terminal.ts:120-135`) defaults to **10 ms** (100 ms over SSH),
  overridable via `PI_TUI_ESC_TIMEOUT`; after `send-keys Escape`, wait longer than that or the
  sequence may be reassembled as Alt+key. **SIGTERM shuts interactive pi down gracefully** with
  the session persisted (`interactive-mode.ts:4314-4352`), so SIGTERM is the correct stop path.

---

## 3. Data model and protocols

### 3.1 Layout

```
Host:
<fleet>/                             default <project>/.fleet/   (git-ignored)
├── fleet.json                       manifest: id, created, image ref+digest, podman/tmux paths
├── state.json                       atomic snapshot: instances, tasks, sequence numbers
├── image/Containerfile              the subharness image (§3.6)
├── profiles/{parent,implementer,reviewer,tester}.yaml
├── roles/*.md                       injected AGENTS.md role cards
├── prompts/coordination.md          injected APPEND_SYSTEM.md
├── instances/<instance-id>/
│   ├── agent/                       → container /agent   (PI_CODING_AGENT_DIR)
│   │   ├── settings.json  models.json  trust.json
│   │   ├── extensions/fleet-bridge/ (symlink or copy of the shared bridge)
│   │   ├── AGENTS.md  APPEND_SYSTEM.md  skills/  themes/
│   │   ├── sessions/…               pi's own transcripts
│   │   └── tui-bytes.log            PI_TUI_WRITE_LOG
│   ├── instance.json                id, role, profile, model, container, pane, worktree, budgets, token (0600)
│   ├── container.log  bridge.log
│   └── inbox/                       durable unacked queue (§3.4)
├── worktrees/<instance-id>/         → container /work (writers)
├── workspace/                       → container /fleet/workspace  (rw, ALL instances)
│   ├── tasks/<task-id>.json         one file per task, atomic rename writes
│   ├── messages/<seq>-<id>.json     append-only, globally sequenced
│   ├── reviews/<review-id>.json
│   ├── artifacts/<artifact-id>/     files handed between harnesses + manifest.json
│   ├── decisions/<seq>-<id>.json    priority/scope decisions, who and why
│   └── ledger.jsonl                 append-only: usage, cost, transitions, errors
└── run/                             → container /fleet/run
    ├── bus.sock  daemon.pid  daemon.lock   (proper-lockfile)
    ├── merge.lock                     repo-level advisory lock, §3.8
    └── tmux/                        private tmux server socket + logs

Inside every container:
/            the baked pi image (pi 1.0.0, fd, rg, git, model catalog, PI_OFFLINE=1)
/agent       private per-instance agent dir
/work        private worktree (rw) or base checkout (ro)
/fleet/workspace   SHARED information space (rw)
/fleet/run         SHARED bus socket (rw)
```

Every JSON write is tmpfile + `fsync` + `rename`. `messages/` and `decisions/` are named by a
zero-padded global sequence so ordering is recoverable from filenames alone. Because
`workspace/` is mounted into every container, **a subharness can inspect the entire shared state
with its ordinary `read`/`grep`/`ls` tools** — no API needed, and it degrades gracefully if the
bus is down.

### 3.2 Bus protocol

Framing: LF-delimited JSON, one object per line, split on `\n` **only** — reuse the discipline of
`src/modes/rpc/jsonl.ts:8-20` and add a regression test with `U+2028`/`U+2029` inside a JSON
string.

```ts
type BusEnvelope =
  | { v: 1; id: string; from: string; kind: "req"; type: string; payload: unknown }
  | { v: 1; id: string; from: string; kind: "res"; ok: true;  payload: unknown }
  | { v: 1; id: string; from: string; kind: "res"; ok: false; error: string; retryable?: boolean }
  | { v: 1; id: string; from: string; kind: "evt"; type: string; payload: unknown };
```

Handshake: client sends `hello {instanceId, token, role, pid, sessionFile, piVersion,
capabilities[]}`; daemon answers `res {instanceId, fleetState, sequence, inbox[]}` — **reconnect
always resynchronises from the store**, so a bridge restart loses nothing. Tokens are per-instance
random strings in `instance.json` (`0600`, `mkdtemp` discipline per `subagent/index.ts:239-247`)
passed into the container via env, so neither a rogue host process nor a compromised sibling
container can impersonate a subharness.

Note the socket is `srwxrwxr-x` on the host and shared by all containers: **the bus is a trust
boundary between subharnesses.** Token auth is what stops instance A from posting as instance B.
If stronger isolation is ever needed, give each instance its own socket file — the protocol is
unchanged.

Client → daemon: `task.claim`, `task.update`, `task.create`, `task.list`, `message.post`,
`message.ack`, `review.submit`, `review.request`, `artifact.put`, `artifact.get`,
`decision.propose`, `usage.report`, `state.get`, `peer.list`, `peer.ask`, `help.request`,
`shutdown.request`.

Daemon → client: `task.assigned`, `task.changed`, `message.inbound`, `review.inbound`,
`review.verdict`, `priority.changed`, `peer.joined`, `peer.left`, `budget.warning`,
`budget.exceeded`, `parent.steering`, `fleet.snapshot`.

`peer.ask` is the only synchronous peer-to-peer path and has a hard timeout that converts into an
escalation; everything else is post-and-deliver. A subharness blocked on a busy peer is the
classic fleet deadlock.

Learned from `coordinator.ts`: model peers as a registry with `peer_connected`/`peer_disconnected`/
`message {from, payload}`, keep the payload opaque to the router, and version the protocol so a
stale bridge is rejected at handshake rather than mis-decoding later. `hello.piVersion` exists for
exactly this.

### 3.3 Task board

```ts
interface Task {
  id: string;
  title: string;
  body: string;                       // markdown brief
  createdBy: string;                  // instance id or "operator"
  assignee?: string;
  status: "proposed" | "queued" | "assigned" | "in_progress" | "blocked"
        | "in_review" | "changes_requested" | "done" | "cancelled";
  priority: number;                   // lower = more urgent
  priorityReason?: string;
  dependsOn: string[];                // blocks assignment until all done
  blocks: string[];                   // derived inverse, maintained by the store
  labels: string[];                   // "code" | "docs" | "spike" | "review" | …
  artifacts: string[];
  reviews: string[];
  lease?: { holder: string; expiresAt: string };
  budget?: { tokens?: number; costUsd?: number; wallMs?: number };
  spent?: { tokens: number; costUsd: number; wallMs: number; turns: number };
  history: Array<{ at: string; by: string; from: string; to: string; note?: string }>;
  merge?: {                              // §3.8 — set only for tasks that integrate code
    state: "pending" | "queued" | "held" | "merged" | "conflict" | "reverted" | "not_applicable";
    branch: string;                      // fleet/<instance-id>
    preMergeSha?: string;                // target branch tip before the merge
    mergeSha?: string;                   // the --no-ff merge commit
    holdReason?: string;                 // e.g. "base-dirty:src/foo.ts"
    attempts: number;
  };
  seq: number;
}
```

All transitions go through one `assertTransition` function so they are testable in isolation.
Only the daemon mutates tasks; clients request transitions. `dependsOn` cycles are rejected at
write time (topological check).

Because the board is just files under `/fleet/workspace/tasks/`, **the parent model can read the
whole board with its own `read`/`grep` tools** and cross-check what the orchestrator extension
tells it. That redundancy is intentional.

### 3.4 Messages and reviews

```ts
interface BusMessage {
  id: string; seq: number;
  from: string; to: string | "broadcast" | "role:<name>" | "parent";
  kind: "info" | "question" | "answer" | "handoff" | "escalation" | "steering" | "verdict";
  subject?: string;                   // usually a task id
  body: string;                       // markdown, capped (default 32 KiB, spill to artifact)
  artifacts: string[];
  requiresAck: boolean;
  replyTo?: string;
  postedAt: string;
  hops: number;                       // §6.4 loop guard
}
```

Delivery: daemon writes `workspace/messages/`, appends to the target's `inbox/`, pushes
`message.inbound`. The bridge decides *how* it enters the conversation:

- target **idle** → `pi.sendMessage({customType: "fleet.message", content, display},
  {triggerTurn: true})`, or `pi.sendUserMessage(...)` for operator-style steering;
- target **streaming** → `deliverAs: "steer"` for `kind: "steering"`, else `"followUp"`;
- target **at a boundary** → `turn_end`/`agent_before_settle` drains the inbox and returns
  `continue: true` once, so a queued review lands as fresh context instead of an interruption;
- **human composing** → suppress injection between `ui_prompt_start` and `ui_prompt_end`, and use
  `ctx.ui.onTerminalInput` to detect live keystrokes (§6.2);
- **context hygiene** → inject as a hidden custom message via `before_agent_start` and prune stale
  ones with the `context` event, following `plan-mode/index.ts:177-247`.

Acks are explicit (`message.ack`); unacked messages survive bridge restarts via the inbox.

Review lifecycle:

```
task → in_review ──(review.request, quorum=N, reviewers by PolicyEngine)──▶
  reviewer claims ─▶ writes findings artifact ─▶ review.submit {verdict}
    approve           → quorum met? → task done → MergeLane (§3.8) → merged | conflict | held
    request_changes   → task changes_requested → back to assignee with findings
    escalate          → parent decides
```

With decision 6, `done` is **not** terminal for code tasks: it hands off to the merge lane, which
is the only component allowed to touch the base branch.

Reviewers **exclude the author** and, per §1.9, we have four ready credential families
(google/gemini, zai/glm, deepseek, moonshotai/kimi) — so `PolicyEngine` can require the reviewer
to be on a **different model family** from the author. That is the concrete payoff of
per-instance models, and it is achievable with the credentials actually present on this machine.

### 3.5 Profiles (per-instance settings)

Declarative, deliberately close to `examples/extensions/subagent/agents.ts` frontmatter so pi
users find it familiar, extended with what a *persistent containerised terminal* instance needs.
Model ids below are real and verified available (§1.9).

```yaml
# profiles/reviewer.yaml
name: reviewer
description: Reads diffs and reports findings with evidence; never edits code.
model:
  id: google/gemini-3.5-flash         # verified `auth check` == ready
  thinking: high
  fallbacks: [deepseek/deepseek-flash, zai/glm-5.3-flash]
tools: [read, grep, find, ls]
settings:                                   # merged into /agent/settings.json
  defaultTools: [read, grep, find, ls]
  tuiMode: regular                          # §2.8 — automatable, keeps scrollback
  terminal: { showTerminalProgress: true }  # §2.8 — machine-readable busy/idle
  quietStartup: "header"
  defaultProjectTrust: always
  compaction: { enabled: true, keepRecentTokens: 20000 }
context:
  agentsMd: roles/reviewer.md               # → /agent/AGENTS.md
  appendSystem: prompts/coordination.md     # → /agent/APPEND_SYSTEM.md
  skills: [skills/review-checklist.md]
container:
  image: multy-pi:1.0.0                     # §3.6
  userns: keep-id                           # Spike 4 — clean bind-mount ownership
  env: [ZAI_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, MOONSHOT_API_KEY]  # forward by NAME
  mounts:
    workspace: rw                           # /fleet/workspace
    bus: rw                                 # /fleet/run
  limits: { memory: "4g", pids: 512, cpus: "2" }
isolation:
  worktree: shared-readonly   # none | private | shared-readonly
  agentDir: private
bridge:
  source: bind                # decision 5 — bind | bake
  # bind: mount <fleet>/image/bridge/ → /agent/extensions/fleet-bridge (instant iteration)
  # bake: use the copy built into the image (release; bridge version == image digest)
merge:                        # decision 6 — fleet-level, not per-profile
  auto: true
  target: main                # branch checked out at `multy init` is the default
  strategy: rebase-then-no-ff
  onConflict: block-and-repair   # never auto-resolve (§3.8)
  requireVerifyLabel: test       # a task with this label must be done+merged first
terminal:
  backend: tmux+podman-exec    # §2.3 Option B — inner tmux holds the PTY
  size: { cols: 130, rows: 42 }
  detachKeys: "ctrl-\\"
  title: "reviewer · {model} · {task}"
budget:
  tokens: 400000
  costUsd: 3
  wallMinutes: 30
  maxTurns: 40
coordination:
  autoReview: true             # may claim unassigned review tasks
  wipLimit: 1
  heartbeatSeconds: 20
  maxDepth: 1                  # §6.7 — nesting guard the subagent example lacks
```

Suggested default fleet for decision 4 (3–5 long-lived roles, cross-family reviews):

| Instance | Role | Model | `/work` mount | Tools |
|---|---|---|---|---|
| `parent` | orchestrator | `zai/glm-5.3` (1M ctx — it accumulates the most context) | base, **ro** | full |
| `impl` | implementer | `moonshotai/kimi-k2.7-code` | private worktree, rw | full |
| `reviewer` | reviewer | `google/gemini-3.5-flash` | base, **ro** | read/grep/find/ls |
| `impl2` | implementer | `deepseek/deepseek-v4-pro` | private worktree, rw | full |
| `tester` *(optional 5th)* | test/verify | `zai/glm-5.3-flash` | private worktree, rw | full |

Four different families across author/reviewer roles, all with `ready` credentials.

**No container — including the parent's — gets the base checkout as writable.** The parent may
have full tools, but it can only ever *read* the integration target. Merging happens on the host in
the daemon (§3.8), so a confused or compromised parent model cannot integrate code by running
`git merge` through its own `bash` tool. Writers get rw on *their own worktree only*, which is a
host directory the lane rebases and merges from; they never see the base as writable. This is what
makes "auto-merge is code-owned" an enforced property rather than an instruction.

`multy` materialises a profile into an instance: create the agent dir, write
`settings.json`/`AGENTS.md`/`APPEND_SYSTEM.md`, link skills/themes/bridge, resolve env-var
credentials, write `instance.json` `0600` with the bus token, create the worktree, create the
container, open the tmux window.

### 3.6 The subharness image

Baked once, reused by every instance (Spike 2: 36 s to build, 683 MB, layers shared):

```dockerfile
FROM docker.io/library/node:22-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      git ripgrep fd-find ca-certificates curl procps openssh-client tmux \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd
ARG PI_VERSION=1.0.0
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} && npm cache clean --force
RUN pi --list-models >/dev/null 2>&1 || true     # warm the catalog so PI_OFFLINE=1 still lists models
COPY tmux.conf /etc/tmux.conf                    # inner tmux: prefix C-f, extended-keys, status off
ENV PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
    TERM=xterm-256color LANG=C.UTF-8 LC_ALL=C.UTF-8 PI_CODING_AGENT_DIR=/agent
WORKDIR /work
CMD ["pi"]
```

Three of these lines are load-bearing and were each learned the hard way:

- **`tmux`** — the inner tmux is what keeps pi alive across detach (Spike 7a).
- **`LANG`/`LC_ALL`** — without a UTF-8 locale every border renders as `q` (Spike 7b).
- **No `ENTRYPOINT`** — `node:22-slim` inherits `docker-entrypoint.sh`, which prepends `node` to an
  argv[0] starting with `-`, so pi's flags would become `node -a …` and pi dies with
  `node: bad option: -a`. The orchestrator passes `--entrypoint` explicitly instead. Setting
  `ENTRYPOINT []` is *not* the fix: podman then consumes the first run argument as the entrypoint.
  Both failures were observed, not predicted.

Baking matters for three verified reasons: it removes the fd/rg download race
(`tools-manager.ts:10-18`), removes the package-install race (`package-manager.ts:2093+`), and
makes the model catalog available offline so `PI_OFFLINE=1` is safe. `multy doctor` compares the
running image digest against `fleet.json` and refuses to mix versions.

Note `fd-find` on Debian installs as `fdfind` — the symlink is required or pi's `find` tool
silently falls back.

### 3.7 Bridge tool surface (what a subharness's model can call)

Registered by `fleet-bridge`, `exposure: "direct"` unless noted:

| Tool | Purpose |
|---|---|
| `fleet_status` | Who is alive, what they're doing, board summary, my remaining budget |
| `fleet_inbox` | Read/ack pending messages and reviews (paged, capped) |
| `fleet_post` | Message a peer / role / parent / broadcast |
| `fleet_ask` | Synchronous question, hard timeout, escalates on timeout |
| `task_claim` / `task_update` / `task_create` | Board interaction |
| `review_submit` | Structured verdict + findings artifact |
| `artifact_put` / `artifact_get` | Move files/large text between harnesses |
| `report_progress` | Cheap heartbeat + narrative; feeds the parent's view |
| `help_request` | Escalate a blocker to the parent (never rate-limited to zero) |

Slash commands for the human in that pane: `/fleet`, `/inbox`, `/tasks`, `/peer <id>`, `/detach`,
`/handoff`.

Output discipline (`docs/extensions.md:135-148`): model-facing `content` is capped and summarised
with an explicit truncation marker; full fidelity goes in `details`; declare `outputSchema` +
`structuredContent` so codemode scripts can consume results; include nested LLM `usage` so session
totals stay accurate. Reuse pi's exported `truncateHead`, `truncateLine`, `DEFAULT_MAX_BYTES`,
`formatSize`, and follow the subagent example's 50 KiB / last-10-items conventions.

---

### 3.8 Merge lane (auto-merge protocol)

Decision 6 removes the operator gate, so merging becomes **the only irreversible action in the
system**. Everything else is a file in `/fleet/workspace` or a container that can be recreated.
It therefore gets its own component, `MergeLane`, with these properties.

**Serialised and code-owned.** One merge in flight at a time, behind a repo-level advisory lock
(`proper-lockfile` on `<fleet>/run/merge.lock`). No model — parent or subharness — ever runs the
merge. The parent gets an emergency brake (`hold_merges`/`resume_merges`) and an undo
(`revert_merge`), but cannot authorise or execute.

**Preconditions, re-checked atomically at merge time** (not when queued, because the base moves):

1. `task.status === "done"`, reached through quorum-approved reviews.
2. Every review in `task.reviews` is `approve`; no outstanding `changes_requested`.
3. All `dependsOn` tasks are `done` **and merged** — merge order respects the DAG, not just
   execution order. A task whose dependency is merged-but-later-reverted is re-opened.
4. If the fleet defines a verification label (`merge.requireVerifyLabel`, default `test`), a task
   carrying it must be `done` and merged for the same change set.
5. The author's worktree is clean: `git status --porcelain` empty, everything committed on
   `fleet/<instance-id>`.
6. **The base checkout has no human uncommitted changes intersecting the merge's file set.**
   Computed as `git status --porcelain` on the base ∩ `git diff --name-only target...branch`.
   Non-empty ⇒ `held` with `holdReason: "base-dirty:<paths>"`, escalated to the operator. This is
   what stops the fleet from stomping on a human editing the same repo — the exact failure pi's own
   `AGENTS.md` warns about.
7. Task budget not exceeded.
8. No `hold_merges` brake active.

**Mechanics** (`strategy: rebase-then-no-ff`). Run by the **daemon on the host**, not inside a
container: worktrees and the base checkout are host directories that containers merely see via bind
mount, so the merge lane needs no container cooperation and cannot be influenced by a subharness.

```bash
git -C <worktree> rebase <target>            # surface conflicts BEFORE the merge
git -C <base> merge --no-ff fleet/<id> -m "fleet(<task-id>): <title>"
```

- `--no-ff` is not cosmetic: it makes **each fleet merge a single revertable commit**, so
  `git revert -m 1 <mergeSha>` undoes exactly one task and nothing else.
- Record `preMergeSha` (target tip before) and `mergeSha` (the merge commit) on the task, in the
  ledger, and in a `decisions/` entry naming every approving review and reviewer model.
- **Never** `--force`, never `reset --hard`, never rebase a commit that is already merged, never
  touch a branch outside `fleet/*`. These are the same prohibitions pi's `AGENTS.md` places on
  agents; the difference is that here they are enforced by the code path rather than by
  instruction.

**On conflict — never auto-resolve.** Resolving a semantic conflict is how fleets silently ship
broken code, and a model that guesses wrong here produces a merge that *looks* clean.

```bash
git rebase --abort   # or: git merge --abort   — leave no half-state, ever
```

Then: `task.merge.state = "conflict"`, `task.status = "blocked"` with reason `merge-conflict`;
create a repair task `resolve-conflict:<task-id>` assigned to the **original author** (they own the
worktree and the context); notify parent and operator; **release the lane** so unrelated tasks keep
flowing. Conflicts are a normal event in a multi-writer fleet, not an error.

**Rollback.** `multy revert <task-id>` (or the parent's `revert_merge`) runs
`git revert -m 1 <mergeSha>` on the target and records it. Because merges are serialised and
`--no-ff`, revert is always well-defined — there is no ambiguity about what to undo.

**Why serialise rather than merge concurrently.** With 2–3 writers branching from one base,
concurrent merges would need real three-way conflict orchestration and would make `preMergeSha`
meaningless. A single lane costs throughput we do not need (decision 4: 3–5 instances) and buys a
total order over the base branch's history, which is what makes revert and audit tractable.

---

## 4. Implementation plan

Sequencing rule: each phase ends in something runnable and demoable. **Phase 0 is already
substantially done** — its spikes were executed and are recorded in §1.10; what remains is
turning them into committed, repeatable code.

### Phase 0 — Foundations (spikes done; ~0.5 day remaining)

- [x] **0.1** Install tmux → **3.7c via brew**. Note it is at
      `/home/linuxbrew/.linuxbrew/bin/tmux` and **not on `PATH`**: `multy` must resolve it
      (config override → `PATH` → known brew/linuxbrew locations) rather than assume.
- [x] **0.2 Spike 1** — TTY propagation into a container in a tmux pane. **Passed.**
- [x] **0.3 Spike 2** — image build with pi 1.0.0. **Passed** (36 s, 683 MB).
- [x] **0.4 Spike 3** — Unix socket across the container boundary. **Passed.**
- [x] **0.5 Spike 4** — `--userns=keep-id` bind-mount ownership. **Passed.**
- [x] **0.6 Spike 5** — credential sharing by env name, offline model listing, `auth check`.
      **Passed** (4 families ready).
- [x] **0.7 Spike 6** — terminal topology A/B/C, full interactive round trip, detach survival,
      re-attach. **Option C chosen.**
- [ ] **0.8** Turn the spikes into `orchestrator/test/spike/` scripts so they are repeatable
      regression checks, and write `orchestrator/docs/spikes.md` recording §1.10 verbatim.
- [ ] **0.9 Scaffold `orchestrator/`** as its own npm package (TypeScript, ESM, `typebox`, biome
      config copied from `pi/biome.json`, vitest). Depend only on the *published*
      `@earendil-works/pi-coding-agent` types where useful; never import `pi/packages/*/src`. If
      we ship as a pi package, host-provided deps (`pi-ai`, `pi-agent-core`, `pi-coding-agent`,
      `pi-tui`, `typebox`) go in `peerDependencies` as `"*"` and **must not** appear in
      `dependencies` (duplicate-class hazard, `docs/packages.md:93-99`).
- [ ] **0.10 Remaining unknown — the bridge itself.** Spike 6 proved the *terminal* half. The
      *coordination* half (an extension inside a containerised interactive pi connecting out over
      the bind-mounted socket, and `pi.sendMessage()` visibly injecting into the live TUI) is
      still unproven and is the one assumption whose failure would change the architecture. Do
      this first in Phase 3, or pull it forward.

**Exit criteria:** §1.10 committed as repeatable scripts; `orchestrator/` builds and lints clean.

### Phase 1 — Workspace store and instance provisioning (1–2 days)

Goal: `multy init` + `multy spawn --profile X` produces a correctly isolated instance, before
there is a bus or a terminal.

- [ ] **1.1** `src/store/workspace-store.ts` — layout creation (§3.1), atomic write
      (tmp+fsync+rename), global sequence allocation, `ledger.jsonl` append, readers/indexers for
      tasks/messages/reviews/artifacts. Unit-test atomicity and sequence monotonicity.
- [ ] **1.2** `src/store/task-board.ts` — `Task` CRUD, `assertTransition` (§3.3), dependency graph
      with cycle rejection, priority ordering, lease fields. Pure functions over an injected store.
- [ ] **1.3** `src/profile/loader.ts` — YAML profile schema (typebox), validation, defaults,
      resolution, profile→`settings.json` materialisation, and a `profile doctor` reporting which
      pi flag/setting each field maps to. Validate `model.id` against the container's
      `pi --list-models` output and `auth check` so a bad profile fails at spawn time, not at
      first prompt.
- [ ] **1.4** `src/profile/provision.ts` — create `<instance>/agent/`, write
      `settings.json`/`AGENTS.md`/`APPEND_SYSTEM.md`, link skills/themes, resolve env-var
      credentials **by name** (never writing values to disk), write `instance.json` `0600` with the
      bus token. Install the bridge per `bridge.source` (decision 5): `bind` → mount
      `<fleet>/image/bridge/` at `/agent/extensions/fleet-bridge`; `bake` → leave the image copy in
      place and record its version. Reject a fleet that mixes the two (§3.5).
- [ ] **1.5** `src/fleet/pi-invocation.ts` — build the in-container argv: `-e <bridge>`, `--model`,
      `--thinking`, `--tools`, `--tui-mode regular`, `--session-id <instance-id>`,
      `--name <role>`, `-a`; plus env per §1.4/§2.8. **Read `ENV_AGENT_DIR`/`ENV_SESSION_DIR` from
      the target pi rather than hardcoding `PI_CODING_AGENT_DIR`** (§1.3). Port
      `getPiInvocation()`'s spirit (`subagent/index.ts:249-262`) — inside a container the answer is
      simply the image's `pi`.
- [ ] **1.6** `src/fleet/worktree.ts` — `git worktree add/remove/list`, branch `fleet/<id>`,
      dirty-base detection, refusal to create a worktree when uncommitted changes would be carried
      in. Read-only roles mount the base `:ro` instead.
- [ ] **1.7** `src/cli/` — `multy init|spawn|list|kill|logs|status`, human and `--json` output.

**Exit criteria:** `multy init && multy spawn --profile reviewer --print "list your tools and
model"` produces a one-shot containerised pi run in a private agent dir and private worktree, on
the profiled model, leaving a correct `instance.json` + `ledger.jsonl` trail. Verified with the
faux provider (§5), not a paid model.

### Phase 2 — Container and terminal backends (1–2 days)

Goal: 3–5 live containers, each attached to its own tmux window, surviving detach.

- [ ] **2.1** `src/container/backend.ts` + `src/container/podman-backend.ts` — implement the
      §2.4 interface. Verified incantations to encode:
      - create/start: `podman run -dit --name <id> --userns=keep-id -e TERM=xterm-256color
        -e <KEY>… -e PI_CODING_AGENT_DIR=/agent -e PI_TUI_WRITE_LOG=/agent/tui-bytes.log
        -e FLEET_* -v <agent>:/agent -v <work>:/work -v <workspace>:/fleet/workspace
        -v <run>:/fleet/run --memory --pids-limit --cpus -w /work <image> pi …`
      - container command: `--entrypoint /bin/bash` with
        `-c 'tmux new-session -A -d -s pi -x W -y H "<pi argv>"; while tmux has-session -t pi; do sleep 2; done'`
        (`src/container/inner-command.ts`, a pure function so the quoting is unit-testable)
      - attach command for the pane: `podman exec -it <id> tmux attach -t pi`
      - probes: `podman exec <id> …`; state via `podman inspect -f '{{.State.Status}}'`;
        **`{{.HostConfig.Tty}}` does not exist in podman 4.9.3** — don't use it.
      - stop: `podman stop -t <grace>` (SIGTERM → grace → SIGKILL); pi handles SIGTERM gracefully
        and persists the session (`interactive-mode.ts:4314-4352`).
      - suppress/benignly handle podman's `The input device is not a TTY` warning when issuing
        `run -dit` from a non-TTY context (Spike 6).
- [ ] **2.2** `src/container/bwrap-backend.ts` — optional fallback; keep the interface honest.
- [ ] **2.3** `src/terminal/tmux-backend.ts` — **private server** `tmux -L multy-<uid>` so we never
      fight the operator's sessions. Resolve the tmux binary (§0.1). Window per instance named
      `<role>:<id>`, created at the profile size (`-x W -y H`) *before* attaching. Set
      `extended-keys on`, `extended-keys-format csi-u`, `mouse on`, `history-limit 50000`,
      `status-left` carrying fleet identity. `capture` via `capture-pane -p [-e] [-S -]`;
      `pipe-pane -o 'cat >> <instance>/pane.log'` as a redundant record alongside
      `PI_TUI_WRITE_LOG`. Read `#{pane_title}`.
      **Re-attach nudge:** after attaching, the pane can be briefly blank until pi's next render —
      wait for the first byte rather than declaring failure. (In Spike 6 this was misread as a
      cosmetic delay when it was actually pi already dead; see Spike 7a.)
- [ ] **2.4** `src/terminal/headless.ts` — optional: `pi --mode rpc` in a container driven by **our
      own thin client**, not `RpcClient` (must fix §1.2 items 1–11: configurable timeouts, no
      unbounded buffering, capped per-child stderr, explicit `onExit`, orderly shutdown by
      **closing stdin**, readiness by handshake, `id` correlation, guaranteed stdout draining,
      auto-answer/auto-cancel `extension_ui_request`, never issue `editor`, `-a` always). Used for
      CI and scale tests, not the default path.
- [ ] **2.5** `src/fleet/fleet-manager.ts` — spawn/supervise/stop; container state polling;
      `waitExit`; SIGTERM → grace → SIGKILL; restart policy with backoff; **max 5 instances** per
      decision 4; concurrent-spawn limiter (repo precedent `MAX_CONCURRENCY = 4`);
      **depth guard** via a `FLEET_DEPTH` env var so nested spawning cannot run away (the subagent
      example has none).
- [ ] **2.6** `multy attach [--all]`, `multy logs <id> [--pane|--tui|--container|--bridge]`,
      `multy focus <id>`, `multy tiled`, `multy doctor`.

**Exit criteria:** `multy spawn --fleet default` brings up 4 containers on 4 different model
families in 4 tmux windows; `multy tiled` shows all four; **killing the host tmux server leaves
all four pi processes running**, and `multy attach` re-attaches cleanly with no input corruption;
a prompt typed into any pane produces a model reply; `multy logs <id> --tui` replays exact bytes.

### Phase 3 — Coordination bus and bridge extension (2–3 days)

- [ ] **3.0 Do the deferred Spike 0.10 first**, before building anything else here.
- [ ] **3.1** `src/bus/protocol.ts` — envelope + all request/event types (§3.2) in typebox, with
      generated TS types shared by daemon and extension so they cannot drift.
- [ ] **3.2** `src/bus/jsonl.ts` — LF-only splitter + the `U+2028`/`U+2029` regression test.
- [ ] **3.3** `src/bus/daemon.ts` — Unix socket server on `run/bus.sock` (dir `0700`),
      `proper-lockfile` on `run/daemon.lock`, token auth from `instance.json`, per-connection
      backpressure, per-request timeout, `hello` resynchronisation, graceful drain on SIGTERM,
      protocol-version rejection.
- [ ] **3.4** `src/bus/client.ts` — reconnect with exponential backoff + jitter, request
      correlation by id, event subscription, offline queue for posts made while disconnected.
      Must tolerate the socket appearing *after* pi starts (container start ordering).
- [ ] **3.5** `extensions/fleet-bridge/` — **the important one** (directory extension with
      `index.ts`, per §1.7(a)):
      - `session_start`: connect to `/fleet/run/bus.sock`, `hello`, publish identity (read
        `PI_SESSION_FILE`/`PI_MODEL`/`PI_PROVIDER`/`PI_REASONING_LEVEL` from env — free, §1.5),
        drain inbox, start heartbeat, install the fleet widget. **Nothing started in the factory**
        (`docs/extensions.md`).
      - Lifecycle → bus: `agent_start`/`agent_end`/`agent_settled` (busy/idle), `message_end`
        (assistant text + usage → `usage.report` + ledger, accumulation per
        `subagent/index.ts:1035-1045`), `tool_execution_end` (capped activity feed),
        `session_shutdown` (idempotent teardown).
      - Bus → conversation: inbox drain per §3.4; boundary delivery via `turn_end`/
        `agent_before_settle` returning `continue: true` **with a loop guard**; hidden injection
        via `before_agent_start` + `context`-event pruning per `plan-mode/index.ts:177-247`.
      - Tools and commands per §3.7.
      - UI: `setWidget("fleet", …)` above the editor (`role · model · task · inbox(n) · budget`),
        `setStatus` one-liner, `setTitle`. All guarded by `ctx.mode === "tui"`, with `ctx.hasUI`
        for RPC forwarding.
      - Renderers: `registerMessageRenderer("fleet.message")`,
        `registerEntryRenderer("fleet.state")` so injected traffic is visually distinct from
        operator typing.
      - State: `pi.appendEntry("fleet.state", …)` + restore by scanning
        `ctx.sessionManager.getEntries()` on `session_start`.
      - Depth guard: refuse to coordinate beyond `FLEET_DEPTH`.
      - The bridge source is chosen by `bridge.source` (decision 5): **`bind`** mounts
        `<fleet>/image/bridge/` → `/agent/extensions/fleet-bridge` for instant iteration;
        **`bake`** uses the copy built into the image, so the bridge version is pinned to the
        image digest. `hello` reports which one and its version, and the daemon **refuses a
        fleet that mixes the two** — a half-migrated fleet debugging phantom behaviour is a bad
        place to spend an afternoon.
- [ ] **3.6** `extensions/fleet-orchestrator/` — parent side: attaches to the daemon, exposes fleet
      tools to the parent model (`spawn_harness`, `assign_task`, `set_priority`, `broadcast`,
      `request_review`, `watch`, `capture_pane`, `read_transcript`, `steer`, `kill_harness`,
      `merge_status`, `hold_merges`, `resume_merges`, `revert_merge`), renders a fleet dashboard
      widget. Note the deliberate asymmetry from decision 6/7: the parent can **inspect, pause and
      undo** merges but cannot authorise or execute them (§3.8). `read_transcript` **polls the
      session
      JSONL read-only** with our own line parser (§1.5), tracking the last seen `id` — complete,
      cheap, and works even if the bridge is wedged. Parent-side summarisation uses
      `ctx.modelRegistry.complete(…, {cacheRetention, sessionId: uuidv7()})` so digests never
      pollute the parent's transcript (`handoff.ts:131`).
- [ ] **3.7** `src/fleet/usage.ts` — per-instance and per-task token/cost aggregation into the
      ledger, surfaced by `multy status`. Cross-check against pi's own footer accounting, which
      Spike 6 showed live (`↑696 ↓7 R768 CH52.5% $0.000`).

**Exit criteria:** with the faux provider, instance A posts to instance B; B's model sees it as a
`fleet.message` (not a user turn), acts, and replies; both appear in `/fleet/workspace/messages/`
in sequence order; killing and restarting B's bridge (or its whole container) redelivers the
unacked message exactly once; the parent dashboard shows both live with correct models and usage.

### Phase 4 — Reviews, priorities, task distribution (2–3 days)

- [ ] **4.1** `src/policy/policy-engine.ts` — pluggable, config-driven:
      - *Assignment*: match task `labels`/required capabilities to profile capabilities; respect
        `wipLimit`, `dependsOn`, lease availability, remaining budget; prefer idle instances; never
        assign a review to the task's author.
      - *Priority*: creator base + recency + dependency depth (a blocked task's predecessors gain
        urgency) + explicit parent overrides recorded in `decisions/`.
      - *Review*: quorum size, reviewer selection (**exclude author, require a different model
        family** — feasible per §1.9, prefer idle), verdict aggregation, `request_changes` routing.
      - *Escalation*: what goes to the parent model vs what code answers.
- [ ] **4.2** Review flow end-to-end (§3.4). Store `reviews/<id>.json` with findings, evidence
      pointers (file:line) and the reviewer's **model**, so we can later measure whether
      cross-family review actually catches more.
- [ ] **4.3** `roles/*.md` + `prompts/coordination.md` — the injected context that makes agents
      behave. Model on `pi-subagents`' intercom instruction (§1.7(d)) and on `pi/AGENTS.md`'s
      git-safety rules, adapted: the coordination protocol; when to use `fleet_ask` vs
      `help_request` vs simply finishing a turn (**never end a turn with a question to the
      parent**); the ban on `git add -A`/`reset --hard`/`stash`/`clean -fd` in shared trees; the
      fact that `/fleet/workspace` is *shared and visible to peers* — so write artifacts there
      deliberately; and the requirement to `artifact_put` large outputs instead of pasting them
      into messages.
- [ ] **4.4** Parent workflow tools: `plan_and_distribute` (parent proposes a task DAG, daemon
      validates and enqueues), `rebalance` (reassign on stall), `summarize_fleet`.
- [ ] **4.5** Deadlock and starvation guards: `dependsOn` cycle detection,
      everyone-waiting-on-everyone detection, max time in `in_review`, and the rule that
      `fleet_ask` always times out into an escalation.
- [ ] **4.6** `src/fleet/merge-lane.ts` — implement §3.8 exactly: the advisory lock, the eight
      preconditions re-checked atomically at merge time, rebase-then-`--no-ff`,
      `preMergeSha`/`mergeSha` capture, the abort-and-repair conflict path, the `held` state for a
      dirty base, and `revert`. Unit-test the precondition matrix and the conflict path against
      throwaway git repos — **this is the one component where a bug is irreversible**, so it gets
      the most test attention in the project.
- [ ] **4.7** `multy merges [--watch]` and `multy revert <task-id>`; surface the merge queue and
      any `held`/`conflict` tasks in `multy status` and on the parent's dashboard widget.

**Exit criteria:** given a two-task DAG (implement, then review), the fleet completes it with no
operator input: `impl` (kimi) implements in its worktree, requests review, `reviewer` (gemini — a
different family) reads the diff from the worktree, submits `request_changes` with file:line
evidence, `impl` addresses it, `reviewer` approves, and **the merge lane integrates it into
`target` as one `--no-ff` commit with no human involvement**. `multy revert <task-id>` undoes
exactly that commit. A deliberately conflicting second task takes the abort-and-repair path,
leaves no half-merged state, releases the lane, and produces a repair task assigned to its author.
A dirty base checkout produces `held`, not a merge. All transitions in the ledger; all messages in
`/fleet/workspace/messages/`.

### Phase 5 — Reliability, budgets, observability (1–2 days)

- [ ] **5.1** Heartbeats and stall detection: bridge pings every N seconds and on every lifecycle
      event; daemon marks `unresponsive` after 3 misses; distinguish *model thinking* (streaming,
      fine) from *process wedged* using container state, `tui-bytes.log` mtime, and OSC 9;4 before
      intervening.
- [ ] **5.2** Budget enforcement **in the daemon**: token/cost/wall/turn ceilings per instance and
      per task; `budget.warning` at 80%; `budget.exceeded` → steering message, then graceful stop
      (`podman stop -t <grace>`, never SIGKILL first, so the session flushes). Plus
      container-level `--memory`/`--pids-limit`/`--cpus` as a hard backstop.
- [ ] **5.3** Crash handling: detect container exit, classify (OOM / signal / pi error / provider
      auth), capture last pane lines + `container.log` into `instance.json`, restart with backoff,
      **resume by `--session-id <instance-id>`** so the conversation continues (§2.3), reassign
      orphaned leased tasks, notify the parent.
- [ ] **5.4** Recovery after daemon restart: rebuild in-memory state from `workspace/` (store is
      source of truth, §2.7), re-handshake every live bridge, resume leases. Recovery after *host*
      reboot: containers are gone but agent dirs and sessions persist, so `multy recover` can
      recreate containers and resume sessions.
- [ ] **5.5** **Merge-lane crash recovery** (the delicate one): the daemon can die *between* the
      git merge and the ledger write. On startup, reconcile by reading the base branch's actual
      history — a `--no-ff` commit whose message carries `fleet(<task-id>)` is authoritative,
      because the merge message is written from the task id. Any task recorded as `queued`/`held`
      whose commit exists is marked `merged`; any stale `merge.lock` older than the process is
      cleared. Also verify no half-finished rebase or merge is left in a worktree
      (`git status` / `.git/rebase-merge`) and abort it. **Never guess: if git state and the ledger
      disagree irreconcilably, hold all merges and escalate.**
- [ ] **5.6** `multy status [--watch]` (instance, role, model, state, task, tokens, cost, budget %,
      last activity, merge queue), `multy ledger --tail`, `multy report` → markdown run summary.
- [ ] **5.7** Log hygiene: rotate and cap `container.log`, `bridge.log`, `pane.log`,
      `tui-bytes.log` (the last grows fastest — it records every byte pi writes). `multy doctor`
      checks: tmux resolvable and ≥3.2; podman rootless working (`podman info`); subuid/subgid
      present; image digest matches `fleet.json`; bridge source consistent across the fleet;
      socket and agent-dir perms; worktree health and no in-progress rebase/merge; **env-var
      credentials present for every profile's provider**; fd/rg baked in; `merge.target` exists and
      the base checkout state; sequence sanity.

### Phase 6 — Packaging, docs, polish (1–2 days)

- [ ] **6.1** Ship as a **pi package** (`docs/packages.md`): `pi install npm:multi-pi` gives an
      operator the orchestrator extension inside their existing pi, plus the `multy` CLI. Manifest
      `"pi": { "extensions": ["./index.ts"] }`; host packages in `peerDependencies` only.
- [ ] **6.2** Docs: `README.md` (30-second start), `docs/architecture.md` (§2 kept honest against
      the code), `docs/profiles.md`, `docs/coordination-protocol.md`, `docs/operations.md`
      (debugging a wedged fleet), `docs/spikes.md` (§1.10).
- [ ] **6.3** Operator UX: default `tiled` layout, keybindings for focus/next-pane, `/fleet` in the
      parent pane, clear visual distinction between operator-typed and fleet-injected messages,
      and a documented manual escape hatch (copy the `attachCommand` string, attach from anywhere).
- [ ] **6.4** Example fleet: `examples/four-role-review/` — the §3.5 table, with a scripted
      faux-provider run reproducing the Phase 4 exit criteria deterministically.

---

## 5. Testing strategy

Testing without paid tokens is a hard requirement (pi's `AGENTS.md` mandates it).

1. **Unit** (vitest, no processes): store atomicity and sequencing, `assertTransition`,
   dependency-cycle rejection, profile validation and materialisation, JSONL splitter (including
   `U+2028`/`U+2029`), budget arithmetic, usage aggregation, policy selection, argv/env
   construction for the container spec.
2. **Component** (real containers, fake models): a `test/faux/` extension calling
   `registerFauxProvider()` (`packages/ai/src/compat.ts:162`) driven from a script file named by
   env (`FLEET_TEST_SCRIPT`), installed via `pi.registerProvider()`. Bake it into a
   `multy-pi:test` image variant. Each scripted subharness then behaves deterministically: emit
   text, call `fleet_post`, call `review_submit`, go idle. **Full end-to-end fleet tests in real
   containers at zero token cost.**
3. **Terminal** tests: the §1.10 spikes as repeatable scripts — private tmux at a fixed size,
   `podman run -dit` + inner tmux + `podman exec -it … tmux attach`, `send-keys`, `capture-pane -p`,
   plus assertions against
   `PI_TUI_WRITE_LOG` bytes (exact, unlike capture-pane). Include the **input-corruption
   regression** from Spike 6 Option B: assert no `q{10,}` runs appear after attach. Mark
   `skip-if-no-tmux` / `skip-if-no-podman` so CI without them still runs everything else.
4. **Chaos**: kill a bridge mid-run; `podman kill` a subharness mid-tool-call; kill the daemon
   while messages are in flight; **kill the daemon between a merge and its ledger write (§5.5)**;
   kill the host tmux server (must be a no-op for the fleet — verified); fill the disk on an
   artifact write; two instances claiming the same task simultaneously; a `fleet_ask` loop between
   two peers; a session-file `_rewriteFile()` racing a parent transcript poll; a container
   exceeding `--memory`; **a merge conflicting mid-rebase**. Each must converge to a correct store
   state with no lost or duplicated messages and, for the merge cases, **no half-merged git
   state**.
5. **Scale smoke**: N=8 concurrent containers (repo precedent `MAX_PARALLEL_TASKS = 8`, above our
   normal 3–5) with the faux provider; assert startup time, RSS, and podman storage stay sane.
6. **One real-model acceptance run**, manually, at the end of Phase 4 only — never in CI. Use the
   cheapest ready models (`zai/glm-5.3-flash`, `deepseek/deepseek-flash`).

`pi/` stays read-only. Tests import the published package, never `pi/packages/*/src`.

---

## 6. Known hard problems and how we handle them

### 6.1 Concurrent writes to one repo
Private git worktrees per writer, bind-mounted at `/work` (§2.6). Reviewers, scouts **and the
parent** mount the base tree `:ro` — enforced by the kernel, not by instruction. Integration is
funnelled through the single serialised host-side `MergeLane` (§3.8), so exactly one actor ever
touches the base branch and its history has a total order. Injected role context additionally
forbids the destructive git commands pi's own `AGENTS.md` forbids — but that is belt-and-braces;
the mount modes are the actual guarantee.

### 6.2 Injected messages vs the operator typing in the same pane
Distinct rendering (`registerMessageRenderer("fleet.message")`); delivery mode depends on stream
state (§3.4); injection suppressed between `ui_prompt_start` and `ui_prompt_end`; and
`ctx.ui.onTerminalInput` (runs before the focused component, can `{consume: true}`,
`tui.ts:1052-1066`) gives a precise signal that a human is at the keyboard. **An operator
keystroke always wins.** Note the inner tmux session is a shared view — if the operator is
attached, the daemon must not also `send-keys` into that pane, and two humans attaching at once
will see each other's cursor. `tmux list-clients` inside the container tells us whether anyone is
watching, which is worth surfacing in `multy status`.

### 6.3 Leases and orphaned work
Every assignment carries `lease {holder, expiresAt}`; the daemon reaps expired leases and
re-queues. This makes crash recovery (§5.3) and daemon restart (§5.4) safe without distributed
consensus. Same idea as `session-worker.ts:517`'s directory lock.

### 6.4 Infinite agent-to-agent chatter
Per-conversation rate limits, a `hops` counter on `fleet_post`/`fleet_ask` (dropped beyond N),
`peer.ask` hard timeouts that convert to escalations, and a global conversation budget the parent
can see and cut. Loops are the most likely way this system burns money.

### 6.5 Context blowup in the parent
The parent sees digests, not transcripts: `summarize_fleet`, capped tool outputs with pointers to
artifacts, on-demand `read_transcript`, and side-channel `modelRegistry.complete()` so digests
don't enter the parent's own context. Injected fleet traffic is pruned with the `context` event
(`plan-mode/index.ts:177-199`). Pi's compaction stays enabled but is not the primary defence.
The parent profile uses a 1M-context model (`zai/glm-5.3`) precisely because it accumulates the
most.

### 6.6 Pi version skew
Solved by construction: **pi is baked into the image** (§3.6), so every instance runs the identical
pinned version regardless of the three copies on the host (§1.9). `fleet.json` records the image
digest; `multy doctor` and the `hello` handshake (`piVersion`) refuse mismatches.

### 6.7 Runaway nesting
The subagent example has **no depth guard** — a child can load the same extension and nest forever.
We pass `FLEET_DEPTH` into the container env and the bridge refuses to coordinate or spawn beyond
the profile's `maxDepth`. Containers make this cheaper to enforce too: don't mount
`/fleet/run` into an instance that shouldn't spawn.

### 6.8 Terminal-record growth
`PI_TUI_WRITE_LOG` records every byte pi writes, including spinner repaints (Spike 6: ~8 KB for
one trivial exchange). Rotate by size and treat it as debug-grade; the ledger and the session
JSONL remain the durable record.

### 6.9 Bus socket as a cross-container trust boundary
The socket is world-readable/writable inside every container (`srwxrwxr-x` on the host, Spike 3).
Token auth in `hello` is what prevents instance A posting as instance B. If a role must be denied
fleet access entirely, **don't mount `/fleet/run` into its container** — a capability enforced by
the kernel rather than by the protocol.

### 6.10 tmux/podman not on PATH
tmux is at `/home/linuxbrew/.linuxbrew/bin/tmux`, not on `PATH` (§0.1). `multy` resolves both
binaries through an explicit search (config override → `PATH` → known locations) and `multy doctor`
reports what it found. Never assume `tmux` or `podman` resolve.

### 6.11 Auto-merge is the only irreversible action
Decision 6 removed the human gate, so a bad merge lands on the base branch with nobody watching.
Four layers, in order of importance:

1. **It cannot be reached without evidence.** Eight preconditions re-checked *at merge time*
   (§3.8), including quorum approval and the dirty-base intersection check that protects the
   operator's own uncommitted work.
2. **It is always a single revertable commit.** `--no-ff` plus a serialised lane means
   `git revert -m 1 <mergeSha>` undoes exactly one task. `preMergeSha` is recorded so the prior
   state is always named.
3. **It never resolves conflicts.** Abort, block, and hand a repair task back to the author. A
   model guessing at a semantic conflict produces a merge that *looks* clean — strictly worse than
   a visible conflict.
4. **It can be stopped and inspected.** `hold_merges` is the parent's emergency brake and
   `multy merges` is the audit trail; every merge writes a `decisions/` entry naming the approving
   reviews *and the reviewer models*, so "why did this land?" is always answerable.

One structural protection worth calling out: the lane runs **on the host** (§3.8), and **no
container is given the base checkout as writable** — not even the parent's (§3.5). Reviewers get it
`:ro`; writers only ever see their own worktree at `/work`. So no model can integrate code by
running `git merge` through its `bash` tool, however confused or compromised it becomes. A
subharness can only *ask*; the lane decides. This is what makes "auto-merge is code-owned" an
enforced property rather than an instruction, and it is the reason decision 6 is safe to accept.

Residual risk stated honestly: review quality is the real gate now. A quorum of approving reviewers
that all share a blind spot will auto-merge a bad change. Two mitigations — the cross-model-family
requirement (§3.4) and the `test` verification label (§3.8 precondition 4) — reduce but do not
eliminate it. If that proves too aggressive in practice, `merge.auto: false` restores the operator
gate with a one-line profile change and no code change; the lane is built either way.

---

## 7. Decisions record

All questions are resolved. Recorded here so the reasoning survives.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | Terminal backend | **Install tmux** — done, 3.7c via brew | §1.9, §2.8, Phase 2.3 |
| 2 | Subharness environment | **Container that installs pi** — podman rootless, image bakes pi 1.0.0 | §2.3, §3.6 |
| 3 | Credentials | **Shared** — forwarded as env vars *by name*, nothing on disk | §2.7, Spike 5 |
| 4 | Fleet size | **3–5 long-lived role instances** — tmux+attach is the default; RPC is CI-only | §2.3, §3.5 |
| 5 | Bridge mounting | **bind-mount in dev, bake for release**, one profile flag; mixed fleets rejected | §3.5, Phase 1.4 |
| 6 | Merge policy | **Auto-merge**, no operator gate | §3.8, §6.11, Phase 4.6 |
| 7 | Parent authority | **Judgement-only**; invariants in code. Parent may pause/undo merges, never authorise them | §2.5, §3.8 |
| 8 | Cross-machine | **Single host only** — Unix socket bus, no TCP transport, no remote backend | §3.2, §2.4 |
| 9 | Image size | **Not a constraint** — keep `node:22-slim` (683 MB) | §3.6 |

Two consequences worth naming explicitly:

- **Decision 8 simplifies more than it forecloses.** With single-host settled, the bus protocol
  needs no transport abstraction, no TLS, no authentication beyond the per-instance token, and no
  networked workspace consistency story. `ContainerBackend` keeps `bwrap` as a *local* fallback
  only. Nothing in the protocol is transport-specific by accident, but we no longer pay for
  generality we will not use.
- **Decisions 6 and 7 interact.** Auto-merge with a judgement-only parent means the merge path is
  entirely code — the model can stop it or undo it, never drive it. That is deliberate: the one
  irreversible operation is the one operation we do not want depending on an LLM's mood.

Still to settle during implementation, none blocking:

- Exact quorum size per review class (start at 1 reviewer for small changes, 2 for anything
  touching shared code).
- Whether `tester` is a standing 5th role or spun up per change set.
- Rotation policy for `tui-bytes.log` (size threshold; §6.8).

---

## 8. Suggested first commit

Phase 0 remainder plus the one deferred spike, in this order:

1. `orchestrator/` package scaffold (package.json, tsconfig, biome, vitest) — no logic.
2. `orchestrator/docs/spikes.md` recording §1.10, and `orchestrator/test/spike/` holding the six
   spikes as repeatable scripts (tty, image, socket, keep-id, credentials, topology-C).
3. `orchestrator/src/store/workspace-store.ts` + tests (Phase 1.1) — no external dependencies and
   no unknowns, so it is safe to build before anything else.
4. **Spike 0.10**: the minimal `fleet-bridge` — an extension that connects to a bind-mounted Unix
   socket from inside a containerised *interactive* pi and injects one `pi.sendMessage()` that
   visibly appears in the attached tmux pane.

Item 4 is the gate. Everything else in this plan is engineering; item 4 is the only remaining
assumption whose failure would force a different architecture — specifically, a fallback to
headless RPC containers (§2.4) with either no human-visible terminal or a renderer we write
ourselves.

After the gate passes, the next risk-ordered step is **Phase 4.6 (`merge-lane.ts`)**, not because
it is early in the sequence but because it is the only component where a bug is irreversible
(§6.11). It is worth building its test matrix against throwaway git repos before the fleet around
it exists.

---

## 9. Implementation status

Built and verified. `orchestrator/` is a standalone TypeScript package run directly by Node 22
(type stripping, no build step).

### Verified working end to end

Two containerised instances (implementer on `moonshotai/kimi-k2.7-code`, reviewer on
`google/gemini-3.5-flash`) were spawned against a throwaway git repo with a live daemon, and all of
the following were observed, not inferred:

| Capability | Evidence |
|---|---|
| Containerised interactive pi in a host tmux window | pane shows pi's real TUI, `▀▀█ v1.0.0`, spinner, footer |
| Private agent dir per instance | `PI_CODING_AGENT_DIR=/agent`, separate sessions/settings |
| Private worktree for writers, `:ro` base for reviewers | impl at `/work` rw; reviewer at `/work (main)` ro |
| Bridge connects out over the bind-mounted socket | 2 × `instance.connected` in the ledger |
| Fleet widget renders in pi's TUI | `fleet e2e-impl · implementer · moonshotai/kimi-k2.7-code · online · ↑695 ↓109 $0.0029 · settled 2` |
| Footer status renders | `fleet:e2e-impl ●` |
| Human prompt typed through the pane works | model replied and called tools |
| **Host → live conversation injection** | `multy inject` produced `HOST-INJECT-OK` from the model |
| **Cross-instance delivery** | reviewer rendered `[fleet:info from operator]` |
| Usage/cost accounting | `usage` records in the ledger, matching pi's own footer |
| Message acks | 2 × `message.acked` |
| **Instances survive the host tmux server being killed** | both containers still `Up` after `tmux kill-server` |
| Operator auth distinct from instance auth | host-only `run/operator.token`, never mounted |

### Components

| Path | Status |
|---|---|
| `src/bus/jsonl.ts` | done — LF-only framing, `LineAccumulator` |
| `src/bus/protocol.ts` | done — envelope, handshake, request/event vocabulary, guards |
| `src/bus/daemon.ts` | done — socket server, token auth, connection replacement, inbox, `peer.ask` with hard timeout, usage, reviews |
| `src/store/workspace-store.ts` | done — atomic writes, sequence allocation, ledger, per-instance inbox |
| `src/store/task-board.ts` | done — transition matrix, cycle rejection, leases, reaping, budgets |
| `src/profile/loader.ts` | done — YAML schema, validation, secret-in-profile rejection |
| `src/profile/provision.ts` | done — agent-dir materialisation, settings merge |
| `src/container/podman-backend.ts` | done — verified incantations, podman 4.9.3 quirks handled |
| `src/container/inner-command.ts` | done — inner-tmux wrapper as a pure, unit-tested function |
| `src/terminal/tmux-backend.ts` | done — private server, version-correct options, capture/send-keys/tiled |
| `src/fleet/pi-invocation.ts` | done — argv/env construction, token redaction |
| `src/fleet/worktree.ts` | done — worktrees, dirty detection, unfinished-operation recovery |
| `src/fleet/fleet-manager.ts` | done — init/seed/spawn/stop/reconcile/doctor, startup verification |
| `src/fleet/merge-lane.ts` | done — all eight preconditions, rebase-then-`--no-ff`, conflict repair, revert |
| `src/fleet/daemon-runner.ts` | done — tick loop: reconcile, heartbeats, lease reaping, budgets, merge drain, review routing |
| `src/cli/main.ts` | done — 20 commands |
| `extensions/fleet-bridge/index.ts` | done — 8 tools, lifecycle→bus, inbox delivery, widget/status |
| `image/Containerfile`, `image/tmux.conf` | done |
| `profiles/{parent,implementer,reviewer,tester}.yaml`, `roles/*.md`, `prompts/coordination.md` | done |
| **84 unit tests** | passing; `tsc --noEmit` clean |
| `test/e2e/fleet-e2e.sh` | done — the 14-step live smoke test above, saved as a repo artifact |
| `test/spike/` | done — the architecture gate (bridge injection into a live containerised pi) |

### Bugs found by testing, not by review

Each of these was a real defect that reasoning did not catch:

1. **`node:22-slim`'s entrypoint mangles pi's flags.** `pi -a …` became `node pi -a …` and then
   `node -a …`. Fixed with an explicit `--entrypoint`; `ENTRYPOINT []` made it worse.
2. **Missing `LANG` rendered every border as `q`.** Misdiagnosed in Spike 6 as nested-tmux
   corruption, which wrongly disqualified the correct topology.
3. **A `held` merge was never retried** — `pending()` excluded it, so a task the lane held would
   wedge forever. Fixed, and escalation is now edge-triggered so a persistent hold does not spam
   the parent every tick.
4. **A dependency that was `done` but had no merge record passed the gate**, so a child could land
   on the base branch before its parent. Now `merge === undefined` blocks.
5. **A tmux failure aborted `spawn` after the container was already running**, orphaning it with no
   `instance.json`. The instance is now recorded before the terminal plane is touched, and a window
   failure is a warning — consistent with "the terminal plane is presentation only".
6. **`tmux new-window` takes no `-x/-y`** (only `new-session` does). Sizes now go through
   `resize-window` with `window-size manual`, or tmux resizes the window to fit whatever client
   attaches and changes pi's column count underneath it.
7. **The bridge read `process.env.PI_MODEL`, which is always empty in the pi process** — those
   variables are injected only into `bash`/`powershell` tool commands. Now uses `ctx.model`, with a
   `model_select` handler so `/model` at runtime keeps the fleet view accurate.
8. **`fsync` vs `fsyncSync`** — the callback API takes two arguments, so the atomic write was not
   actually fsyncing.

Found later, by running a real four-instance fleet (§10) rather than by review:

9. **Git worktrees were unusable inside containers.** A worktree's `.git` is a *file* reading
   `gitdir: <absolute host path>/.git/worktrees/<id>`, and that path was not mounted, so every git
   command failed with "not a git repository" and the author could not commit its own work. Fixed by
   mounting the base repo's `.git` at the **identical absolute path** (`--userns=keep-id` already
   makes uids match). The implementer found this, correctly refused to rewrite the pointer or
   `git init` a replacement, and escalated — which is the role card working as intended.
   *Residual risk, stated plainly:* this gives a writer container the shared object database and
   refs, so a confused agent could in principle move a ref. That is inherent to git worktrees. What
   it does not give is a writable base working tree: reviewers and the parent still mount that
   `:ro` with no `.git` at all, and the merge lane re-checks every precondition host-side.
10. **The lease reaper requeued a task that was `in_review`.** The lease lapsed while the reviewer
    was reading, so the task went back to `queued` and the routed review was orphaned. Fixed: only
    `assigned` and `in_progress` are reapable — every other status is waiting on someone else — and
    a `busy` heartbeat now renews the lease, so long tasks are not reaped out from under an agent
    that is doing exactly what it was asked to do.
11. **Nothing moved `in_review` → `done` on approval**, so the merge lane (which only drains `done`
    tasks) never fired. §3.4 specified that step; it simply was not implemented. Fixed with a pure,
    tested `reviewQuorumMet()` plus `applyReviewOutcome()`, and a `reconcileReviews()` pass in the
    daemon tick so a verdict recorded while the daemon was down still lands.
12. **The CLI did not correlate responses by id.** It took the first record after `hello`, which is
    usually a broadcast event (`peer.joined`, `task.changed`), so it reported "failed" for work that
    had actually succeeded. This is the exact mistake §1.2 item 7 warns about for `RpcClient`,
    reproduced in my own client.

### Not yet built

- `extensions/fleet-orchestrator/` — the parent-side extension (fleet dashboard, `spawn_harness`,
  `assign_task`, `read_transcript`, `hold_merges`, `revert_merge`). The parent currently runs as an
  ordinary instance with the bridge only; the daemon's review routing and merge lane already work
  without it.
- `src/policy/policy-engine.ts` — assignment and priority policy. Review routing exists inline in
  `daemon-runner.ts`; extraction into a pluggable policy is pending.
- Headless `--mode rpc` backend (Phase 2.4) — deferred; with 3–5 long-lived interactive instances
  it is only needed for CI.
- The faux-provider test image (Phase 5.2), so the fleet tests still spend real tokens.
- `multy recover` after a host reboot, and merge-lane crash reconciliation (Phase 5.5).
- Packaging as a pi package (Phase 6.1).


---

## 10. First real fleet run

Executed against a scratch repository (`~/multy-demo/project`, a 30-line retry helper with a
deliberate defect) so the auto-merge lane could not touch anything real. Four instances, four model
families, all four requested models:

| Instance | Role | Model | `/work` |
|---|---|---|---|
| `parent` | orchestrator | `zai/glm-5.3` (GLM 5.3) | base, ro |
| `implementer` | implementer | `moonshotai/kimi-k3` (Kimi K3) | private worktree, rw |
| `reviewer` | reviewer | `qwen-token-plan/qwen3.8-max` (Qwen3.8-Max) | base, ro |
| `tester` | tester | `qwen-token-plan/deepseek-v4.1-flash` (DeepSeek V4.1) | private worktree, rw |

All four spawned, joined the bus, and rendered their own pi TUI in their own tmux window with the
correct model in the footer (`(moonshotai) kimi-k3 • high`, `(qwen-token-plan) qwen3.8-max • xhigh`,
…) and the fleet widget above the editor.

**The task:** make `retry()` honour its `AbortSignal`, and add tests.

**What happened, without operator intervention after seeding the task:**

1. `implementer` (Kimi K3) claimed it, moved it to `in_progress`, implemented the four abort
   behaviours, wrote tests, ran them (**7 pass, ~193 ms**), and committed on `fleet/implementer`
   with explicit paths.
2. The daemon routed the review to `reviewer` and recorded `crossFamily: true` in the decision —
   author on Moonshot, reviewer on Qwen.
3. `reviewer` (Qwen3.8-Max) did not merely read the diff. It copied the tree to `/tmp`, used
   `git -C /work show <sha>:src/retry.ts` to extract the pre-fix version, and ran **mutation
   testing**: with the fix reverted, 5 of 7 tests failed, proving the tests were not vacuous. It
   then filed a **blocking** finding — the `test` script was `node --test 'test/*.test.ts'`, whose
   quoted glob is not expanded by node and whose literal quotes break on `cmd.exe`, so it could
   false-green — and recommended `node --test` auto-discovery.
4. `implementer` addressed the findings in a second commit.
5. `reviewer` re-reviewed each round-1 finding one by one and **approved** (89.5k tokens of review).
6. The merge lane checked its preconditions and integrated the work as a `--no-ff` merge:

```
*   50d6db8 fleet(task_760141f3): retry(): honour the abort signal, and add tests
|\
| * 675520a fix: address review findings on retry() abort support
| * f100952 fix: honour AbortSignal in retry() and add node:test coverage
|/
* 3669ecd initial: retry helper with a known defect
```

Two parents, so `git revert -m 1 50d6db8` undoes exactly this task. **8 tests pass on `main`** after
the merge. Total spend: **$0.17** (implementer); the `qwen-token-plan` provider reports no cost, so
the reviewer's 89.5k tokens are plan-priced and show as $0.0000 — cost accounting is only as good as
the provider's reporting.

Also exercised, incidentally: the daemon was restarted mid-run and **all four bridges reconnected
and resynchronised from the store**, and the reconcile pass then completed the review→merge handoff
that had been missed.

### What this run proved and what it did not

Proved: per-instance models and terminals; bridge injection into a live conversation; cross-family
review routing; a review with enough independence to catch a real defect the author missed; the
eight-precondition merge lane; `--no-ff` revertability; bus reconnect resynchronisation; usage and
decision audit trails.

Not proved, and worth saying so:

- **The parent model never actually orchestrated.** It came up, read the workspace with its own
  tools when the implementer escalated, and idled. Priorities, assignment and the review handoff
  were all driven by the daemon and one operator command. The `fleet-orchestrator` extension is
  still unbuilt, so "the parent decides priorities" is unverified.
- **`tester` never ran.** No verification task was created, so `merge.requireVerifyLabel` was never
  exercised end to end.
- **One review round overwrote the previous one.** Round 2 reused review id
  `rev_<task>_<reviewer>`, so the store holds only the final verdict; round-1 findings survive only
  inside the reviewer's own prose. Review rounds should accumulate, not replace.
- **No conflict, revert, hold, or budget path was exercised live.** All four are unit-tested against
  throwaway repos, but not observed in a running fleet.
