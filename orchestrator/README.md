# multi-pi orchestrator (`multy`)

A parent harness that runs **3–5 long-lived pi instances**, each in its own container with its own
terminal, settings and model, coordinating through a shared workspace: mutual reviews, priorities,
task distribution, and auto-merge of approved work.

Design, evidence and the full plan live in [`../PLAN.md`](../PLAN.md). This file is how to run it.

## Why the shape it has

Two findings from instrumenting pi, not from reading it:

- **pi needs a real PTY on stdin *and* stdout**, or it silently degrades to print mode
  (`pi/packages/coding-agent/src/main.ts:112-123`). So "each subharness has its own terminal" is
  not cosmetic — it is what makes the TUI exist.
- **pi handles SIGHUP by shutting down gracefully**
  (`…/src/modes/interactive/interactive-mode.ts:4314-4352`). When the only client of a
  `podman attach` PTY goes away, pi exits within ~2 s. So each container runs an **inner tmux** that
  owns pi's PTY permanently; humans attach and detach without pi noticing. Verified: still alive
  20 s after the host tmux server is killed outright.

Control does not go through the terminal. A **bridge extension** loaded into each pi connects out
over a Unix socket bind-mounted from the host, so inbound fleet traffic is injected into the live
conversation with `pi.sendMessage()` and outbound facts come from `agent_settled` / `message_end`.
The terminal plane is for humans: observation, focus, and manual intervention.

```
host tmux window                      presentation only — killing it changes nothing
  └─ podman exec -it <c> tmux attach -t pi
       └─ container's inner tmux      owns pi's PTY, never dies
            └─ pi --tui-mode regular  real interactive TUI
                 └─ fleet-bridge  ⇄  /fleet/run/bus.sock  ⇄  multy daemon (host)
                                          │
                                     <fleet>/workspace/   shared, durable, source of truth
                                     (also bind-mounted into every container)
```

## Requirements

- podman ≥ 4, rootless working (`podman info` succeeds; `/etc/subuid` + `/etc/subgid` present)
- tmux ≥ 3.2 on the host — it need not be on `PATH`; `multy` searches the usual brew locations
- Node ≥ 22.19 (runs the TypeScript directly, no build step)
- Provider API keys as environment variables

## Quick start

```bash
cd orchestrator
npm install

# 1. build the subharness image (bakes pi 1.0.0, fd, rg, tmux, the model catalog, C.UTF-8)
node --no-warnings src/cli/main.ts image

# 2. create a fleet against the repo you want worked on
node --no-warnings src/cli/main.ts init --root /path/to/repo/.fleet --project /path/to/repo

# 3. start the daemon (bus, heartbeats, lease reaping, budgets, review routing, merge lane)
node --no-warnings src/cli/main.ts daemon --root /path/to/repo/.fleet

# 4. in another shell: spawn instances and watch
node --no-warnings src/cli/main.ts spawn parent     --root /path/to/repo/.fleet
node --no-warnings src/cli/main.ts spawn implementer --root /path/to/repo/.fleet
node --no-warnings src/cli/main.ts spawn reviewer   --root /path/to/repo/.fleet
node --no-warnings src/cli/main.ts status --root /path/to/repo/.fleet
node --no-warnings src/cli/main.ts tiled  --root /path/to/repo/.fleet   # all panes at once
```

Set `MULTY_FLEET_ROOT` to skip repeating `--root`. `npm run multy -- <cmd>` works too.

## Commands

| Command | Purpose |
|---|---|
| `init` | create the fleet root, seed profiles/roles/prompts, write the manifest and operator token |
| `image` | build the subharness image |
| `daemon` | run the bus and the supervision loop |
| `spawn PROFILE [--id ID] [--model M] [--no-window] [--print "…"]` | start an instance |
| `status [--json]` | fleet table: role, model, state, task, tokens, cost, inbox |
| `tasks [--json]` | the board |
| `attach` | print the tmux and per-container attach commands |
| `tiled` | one window with every instance side by side |
| `capture ID [--scrollback]` | dump a pane |
| `logs ID [--source container\|pane\|tui\|bridge]` | logs; `tui` is pi's exact byte stream |
| `inject ID "TEXT"` | push text into a live pi conversation |
| `post TO "BODY" [--kind K]` | post to an instance, a role, `parent`, or `broadcast` |
| `merges` / `revert TASK_ID` / `hold` / `resume` | the merge lane and its emergency brake |
| `stop ID [--remove]` / `stop-all [--remove]` | stop instances |
| `ledger [--tail N]` | the append-only audit trail |
| `doctor` | preflight: podman, tmux, image digest, credentials, bridge-source consistency |

## Profiles

`profiles/*.yaml`. The four shipped profiles use four different model families, which is what makes
cross-family review the default rather than an aspiration:

| Profile | Model | `/work` |
|---|---|---|
| `parent` | `zai/glm-5.3` (1M ctx — it accumulates the most) | base, **read-only** |
| `implementer` | `moonshotai/kimi-k2.7-code` | private worktree, rw |
| `reviewer` | `google/gemini-3.5-flash` | base, **read-only** |
| `tester` | `zai/glm-5.3-flash` | private worktree, rw |

**No container gets the base checkout writable — including the parent's.** Merging happens on the
host in the daemon, so no model can integrate code by running `git merge` through its `bash` tool.
That mount configuration is the enforcement; the role text forbidding destructive git commands is
belt-and-braces.

Credentials are declared as bare **variable names** (`container.env: [ZAI_API_KEY, …]`) and
forwarded from the daemon's environment at `podman run`. A profile containing `KEY=value` is
rejected, so no secret can be persisted to disk by accident.

## Auto-merge

Approved work merges without an operator gate, so it is the only irreversible action here and gets
the most machinery (`src/fleet/merge-lane.ts`, PLAN.md §3.8):

- **serialised** behind one advisory lock, so base-branch history has a total order
- **host-side**, never in a container
- **eight preconditions re-checked at merge time**, including: quorum approval, no
  `request_changes`, dependencies *merged* (not merely done), the author's worktree clean, and —
  the operator protection — no human uncommitted changes intersecting the merge's file set, which
  holds and escalates rather than merging
- **`--no-ff`**, so one task == one merge commit == one `git revert -m 1`
- **never resolves conflicts**: abort, block, and hand a repair task back to the original author

The author approving their own work does not count. `multy hold` is the emergency brake;
`multy revert <task-id>` undoes exactly one merge.

If auto-merge proves too aggressive, `merge.auto: false` in the manifest restores the operator gate
with no code change — the lane is built either way.

## Layout

```
src/bus/        jsonl framing · protocol · daemon
src/store/      workspace store (source of truth) · task board
src/profile/    loader + validation · agent-dir provisioning
src/container/  podman backend · inner-tmux command builder
src/terminal/   tmux backend (private server)
src/fleet/      pi invocation · worktrees · fleet manager · merge lane · daemon runner
src/cli/        multy
extensions/fleet-bridge/   loaded into every subharness pi
image/          Containerfile · tmux.conf
profiles/ roles/ prompts/  seeded into the fleet root by `multy init`
```

`<fleet>/` holds everything at runtime: `instances/<id>/agent` (private `PI_CODING_AGENT_DIR`),
`worktrees/<id>`, `workspace/` (shared, mounted into every container), `run/bus.sock`,
`run/operator.token`.

## Tests

```bash
npm test                     # 70 unit tests: framing, store, task board, merge lane, profiles
npm run typecheck
bash test/spike/run-gate.sh  # the architecture gate: injection into a live containerised pi
```

The merge-lane tests run against throwaway git repos and cover the happy path, every blocking
precondition, the conflict path (asserting **no half-merged state survives**), revert, hold/resume,
and stale-lock reclamation.

## Known gaps

See PLAN.md §9 "Not yet built". The largest: the parent-side `fleet-orchestrator` extension (fleet
dashboard and orchestration tools) and the faux-provider test image that would make fleet tests
token-free. Review routing and the merge lane already work without them.
