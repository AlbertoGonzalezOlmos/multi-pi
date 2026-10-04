/**
 * In-container pi invocation: argv and environment.
 *
 * Every choice here is grounded in a verified pi behaviour (PLAN.md §1.3, §1.4, §2.8):
 *
 *   PI_CODING_AGENT_DIR   the env var name is DERIVED from the package's piConfig.name
 *                         (pi/src/config.ts:546), so it is computed rather than hardcoded.
 *   -a                    mandatory, not optional. It sets parsed.projectTrustOverride, which
 *                         short-circuits trustStore.get() entirely (main.ts:741-747). Without it
 *                         trust.json is locked and its directory created on every lookup, and in
 *                         RPC mode trust silently resolves to false (main.ts:770).
 *   --tui-mode regular    keeps pi on the main screen so scrollback survives and no mouse capture
 *                         is enabled (tui-renderer.ts:9-51).
 *   --session-id          makes recovery deterministic: a restarted container resumes the same
 *                         conversation rather than starting a new one.
 *   PI_OFFLINE=1          no catalog refresh, no fd/rg download, no radius/bug upload. Note pi's
 *                         model-runtime tests `PI_OFFLINE === undefined`, so PI_OFFLINE=0 would
 *                         still disable network — never set it to 0 to mean "online".
 *   PI_TUI_WRITE_LOG      records every byte pi writes to the terminal (tui/terminal.ts:143-160),
 *                         which is a far better observation channel than scraping capture-pane.
 */

import type { Profile } from "../profile/loader.ts";

/** APP_NAME in the pi build we pin. Override if pi is rebranded (config.ts:539-547). */
export const PI_APP_NAME = "PI";

/**
 * Absolute path to pi inside the container image. Always passed as `--entrypoint`, because pi's
 * flags are the container command and node:22-slim's inherited docker-entrypoint.sh prepends
 * `node` to an argv[0] starting with "-".
 */
export const PI_BINARY_PATH = "/usr/local/bin/pi";

export function agentDirEnvName(appName: string = PI_APP_NAME): string {
	return `${appName.toUpperCase()}_CODING_AGENT_DIR`;
}

export function sessionDirEnvName(appName: string = PI_APP_NAME): string {
	return `${appName.toUpperCase()}_CODING_AGENT_SESSION_DIR`;
}

export interface InvocationPaths {
	/** In-container path of the private agent dir. */
	agentDir: string;
	/** In-container path of the working directory. */
	workdir: string;
	/** In-container path of the bridge extension entry. */
	bridgeEntry: string;
	/** In-container path of the shared workspace. */
	workspace: string;
	/** In-container path of the bus socket. */
	busSocket: string;
	/** In-container path for PI_TUI_WRITE_LOG. */
	tuiLog: string;
}

export const DEFAULT_PATHS: InvocationPaths = {
	agentDir: "/agent",
	workdir: "/work",
	bridgeEntry: "/agent/extensions/fleet-bridge/index.ts",
	workspace: "/fleet/workspace",
	busSocket: "/fleet/run/bus.sock",
	tuiLog: "/agent/tui-bytes.log",
};

export interface InvocationInput {
	instanceId: string;
	role: string;
	token: string;
	profile: Profile;
	paths?: Partial<InvocationPaths>;
	appName?: string;
	piVersion?: string;
	bridgeSource: "bind" | "bake";
	bridgeVersion: string;
	depth?: number;
	extraArgs?: string[];
	/** Run one prompt and exit instead of staying interactive. Used by tests and --print spawns. */
	oneShot?: { prompt: string; mode?: "print" | "json" };
}

export interface PiInvocation {
	argv: string[];
	/** Literal KEY=VALUE pairs safe to persist and log. */
	env: Record<string, string>;
	/** Credential variable NAMES forwarded from the daemon env; values are never written down. */
	envForward: string[];
}

export function buildPiInvocation(input: InvocationInput): PiInvocation {
	const paths: InvocationPaths = { ...DEFAULT_PATHS, ...(input.paths ?? {}) };
	const appName = input.appName ?? PI_APP_NAME;
	const model = input.profile.model;

	const argv: string[] = [];

	// Trust: always auto-approve. See the header note — this is load-bearing.
	argv.push("-a");

	if (input.oneShot) {
		if (input.oneShot.mode === "json") argv.push("--mode", "json");
		argv.push("-p");
	} else {
		argv.push("--tui-mode", "regular");
	}

	// Model: pi accepts "provider/id:thinking" as one pattern (docs/cli.md).
	argv.push("--model", model.thinking ? `${model.id}:${model.thinking}` : model.id);

	argv.push("--session-id", input.instanceId);
	argv.push("--name", `${input.role}:${input.instanceId}`);

	if (input.profile.tools && input.profile.tools.length > 0) {
		argv.push("--tools", input.profile.tools.join(","));
	}

	// The bridge is what makes this instance part of a fleet; always load it.
	argv.push("-e", paths.bridgeEntry);

	if (input.profile.context?.skills) {
		for (const skill of input.profile.context.skills) argv.push("--skill", skill);
	}

	if (input.extraArgs) argv.push(...input.extraArgs);
	if (input.profile.terminal && !input.oneShot) {
		// Reserved for future per-profile pi flags; sizes are set on the tmux window instead,
		// because with a real PTY the ioctl wins and COLUMNS/LINES are only fallbacks
		// (tui/terminal.ts:500-506).
	}

	if (input.oneShot) argv.push("--", input.oneShot.prompt);

	const env: Record<string, string> = {
		[agentDirEnvName(appName)]: paths.agentDir,
		[sessionDirEnvName(appName)]: `${paths.agentDir}/sessions`,
		TERM: "xterm-256color",
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		PI_TUI_WRITE_LOG: paths.tuiLog,
		FLEET_INSTANCE_ID: input.instanceId,
		FLEET_INSTANCE_TOKEN: input.token,
		FLEET_ROLE: input.role,
		FLEET_BUS_SOCKET: paths.busSocket,
		FLEET_WORKSPACE: paths.workspace,
		FLEET_BRIDGE_SOURCE: input.bridgeSource,
		FLEET_BRIDGE_VERSION: input.bridgeVersion,
		FLEET_PI_VERSION: input.piVersion ?? "unknown",
		// Nesting guard: the subagent example has none, so a child can load the same extension
		// and nest forever (PLAN.md §6.7).
		FLEET_DEPTH: String(input.depth ?? 0),
	};
	// Escaped for a human reading `multy logs`: the token is secret, so mask it in anything we
	// persist. The real value is passed through the container spec, not this map's consumers.
	const envForward = [...new Set(input.profile.container?.env ?? [])];

	return { argv, env, envForward };
}

/** Redact the instance token so it never lands in a log or a rendered command line. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		out[key] = key === "FLEET_INSTANCE_TOKEN" ? "[redacted]" : value;
	}
	return out;
}

/**
 * Render the full in-container command for diagnostics. Credential variables appear as bare
 * names, never as values.
 */
export function renderCommand(invocation: PiInvocation): string {
	const parts = ["pi", ...invocation.argv.map(quoteArg)];
	for (const name of invocation.envForward) parts.push(`# env ${name}=<forwarded>`);
	return parts.join(" ");
}

function quoteArg(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./:-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}
