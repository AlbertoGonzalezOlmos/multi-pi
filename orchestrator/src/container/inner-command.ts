/**
 * The in-container launch command.
 *
 * Topology (PLAN.md §2.3, corrected by Spike 7):
 *
 *   host tmux window
 *     └─ pane runs: podman exec -it <container> tmux attach -t pi
 *          └─ container's INNER tmux server holds pi's PTY permanently
 *               └─ pi, interactive, --tui-mode regular
 *
 * Why the inner tmux is not optional: pi installs a SIGHUP handler and shuts down gracefully
 * (pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4314-4352). When the only
 * client of a `podman attach` PTY goes away, pi receives SIGHUP and exits within ~2s. With an inner
 * tmux holding the PTY, attach clients come and go and pi never notices — which is what
 * "long-lived role instances" requires.
 *
 * Why LANG=C.UTF-8 is not optional: with LC_CTYPE=POSIX the inner tmux falls back to DEC Special
 * Graphics for line drawing, and pi's box borders render as runs of `q` when captured through the
 * outer tmux. Verified fixed by the locale alone.
 */

import { PI_BINARY_PATH } from "../fleet/pi-invocation.ts";

/** Name of the inner tmux session that holds pi. */
export const INNER_SESSION = "pi";

/** Extra env every container gets, beyond the profile's and pi's own. */
export const CONTAINER_BASE_ENV: Record<string, string> = {
	TERM: "xterm-256color",
	// See the module note: without a UTF-8 locale tmux draws borders with the ACS charset.
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
};

/** POSIX single-quote escaping. Exported because it is the security boundary for argv. */
export function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface InnerCommandInput {
	/** pi's argv (flags only; the entrypoint supplies the program). */
	piArgv: string[];
	cols: number;
	rows: number;
	/** Absolute path to pi inside the container. */
	piBinary?: string;
	session?: string;
}

/**
 * Build the `bash -c` payload that starts pi inside an inner tmux session and then blocks for as
 * long as that session lives.
 *
 * The wait loop matters: it makes the container's lifetime equal pi's lifetime, so
 * `podman inspect .State.Status` is a truthful liveness signal for the fleet manager. A container
 * that merely started tmux and exited would look dead while pi kept running.
 */
export function buildInnerCommand(input: InnerCommandInput): string {
	const session = input.session ?? INNER_SESSION;
	const pi = input.piBinary ?? PI_BINARY_PATH;
	const piCommand = [pi, ...input.piArgv].map(shellQuote).join(" ");
	const size = `-x ${Math.max(40, Math.trunc(input.cols))} -y ${Math.max(12, Math.trunc(input.rows))}`;
	// `-A` makes a restart reattach to an existing session instead of failing, which is what lets
	// `podman start` resume a stopped container without losing the conversation.
	return [
		`tmux new-session -A -d -s ${shellQuote(session)} ${size} ${shellQuote(piCommand)}`,
		`while tmux has-session -t ${shellQuote(session)} 2>/dev/null; do sleep 2; done`,
	].join("; ");
}

/** The command a host tmux pane runs to show a human this subharness's terminal. */
export function buildAttachCommand(podmanBinary: string, containerName: string, session = INNER_SESSION): string {
	return `${podmanBinary} exec -it ${shellQuote(containerName)} tmux attach -t ${shellQuote(session)}`;
}

/** A command that works from any shell, for the documented manual escape hatch. */
export function buildManualAttachCommand(containerName: string, session = INNER_SESSION): string {
	return buildAttachCommand("podman", containerName, session);
}
