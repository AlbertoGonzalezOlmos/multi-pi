# multi-pi

Forum of harnesses to coordinate work.

A parent orchestrator that runs several **independent [pi](https://pi.dev) instances**, each in its
own container with its own terminal, settings and model, and coordinates them through a shared
workspace: mutual reviews, priorities, task distribution, and auto-merge of approved work.

```
host tmux window                      presentation only — killing it changes nothing
  └─ podman exec -it <c> tmux attach -t pi
       └─ container's inner tmux      owns pi's PTY, never dies
            └─ pi --tui-mode regular  real interactive TUI, own model, own agent dir
                 └─ fleet-bridge  ⇄  /fleet/run/bus.sock  ⇄  multy daemon (host)
                                          │
                                     <fleet>/workspace/   shared, durable, source of truth
```

Control does not go through the terminal. A **bridge extension** loaded into each pi connects out
over a Unix socket bind-mounted from the host, so inbound fleet traffic is injected into the live
conversation with `pi.sendMessage()` and outbound facts come from `agent_settled` / `message_end`.
The terminal plane exists for humans: observation, focus, and manual intervention.

## Read these

| Document | Contents |
|---|---|
| [`PLAN.md`](PLAN.md) | The full design: codebase study with file:line evidence, seven executed spikes, architecture decisions and rejected alternatives, data model and protocols, phased plan, and the eight bugs found by running it |
| [`orchestrator/README.md`](orchestrator/README.md) | How to run it: quick start, commands, profiles, the auto-merge protocol |

## Status

Working vertical slice. `orchestrator/` is a standalone TypeScript package run directly by Node 22
(no build step). 84 unit tests pass, `tsc --noEmit` is clean, and a live end-to-end smoke test
(`orchestrator/test/e2e/fleet-e2e.sh`) verifies two containerised instances joining the bus,
answering a prompt typed through the pane, receiving a host injection into the live conversation,
receiving a cross-instance message, and surviving the host tmux server being killed.

Not yet built: the parent-side orchestrator extension (fleet dashboard and orchestration tools),
the faux-provider test image that would make fleet tests token-free, and `multy recover`.
See [`PLAN.md` §9](PLAN.md#9-implementation-status).

## Requirements

podman ≥ 4 (rootless working), tmux ≥ 3.2 on the host, Node ≥ 22.19, and provider API keys as
environment variables.

## Layout

```
PLAN.md              design, evidence, and implementation status
orchestrator/        the multy package: daemon, CLI, bus, store, container/terminal backends
pi/                  vendored upstream pi checkout — its own repo, read-only, git-ignored
```

## License

Apache-2.0. pi itself is MIT and remains the property of its authors; `pi/` is a vendored checkout
used as reference and as the source of the containerised binary.
