/**
 * ContainerBackend — podman rootless.
 *
 * Every incantation here was verified in PLAN.md §1.10:
 *   Spike 1  `run -it` inside a tmux pane gives the container process a real TTY on stdin AND
 *            stdout, with the pane size propagated exactly (pi's interactive gate, main.ts:112-123).
 *   Spike 4  `--userns=keep-id` makes container uid == host uid, so files created in bind mounts
 *            are owned by the host user rather than root.
 *   Spike 6  Option C: `run -dit` so PODMAN holds the PTY, and the pane attaches with
 *            `podman attach`. pi then survives `tmux kill-server` outright. Nested tmux
 *            (Option B) corrupted input with ~260 injected characters and is rejected.
 *
 * podman 4.9.3 quirks handled here:
 *   - `{{.HostConfig.Tty}}` does not exist; never inspect it.
 *   - `run -dit` from a non-TTY context prints a benign
 *     "The input device is not a TTY" warning to stderr. PTY allocation still succeeds.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { buildAttachCommand } from "./inner-command.ts";

export type ContainerState = "created" | "running" | "exited" | "missing" | "unknown";

export interface MountSpec {
	host: string;
	container: string;
	mode: "rw" | "ro";
}

export interface ContainerSpec {
	name: string;
	image: string;
	/** Container command. When `entrypoint` is set these are its ARGUMENTS, not argv[0]. */
	command: string[];
	/**
	 * Override the image entrypoint. Required for the pi image: node:22-slim inherits
	 * docker-entrypoint.sh, which prepends `node` to any first argument starting with "-", so
	 * passing pi's flags as the command would otherwise become `node -a ...`.
	 */
	entrypoint?: string;
	workdir?: string;
	env?: Record<string, string>;
	/** Env var NAMES forwarded from the daemon's own environment (credentials; never values). */
	envForward?: string[];
	mounts?: MountSpec[];
	userns?: string;
	limits?: { memory?: string; pids?: number; cpus?: string };
	network?: string;
	extraArgs?: string[];
}

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ContainerBackend {
	readonly kind: string;
	isAvailable(): Promise<boolean>;
	version(): Promise<string>;
	create(spec: ContainerSpec): Promise<string>;
	state(name: string): Promise<ContainerState>;
	/** The exact command a tmux pane should run to give a human this container's terminal. */
	attachCommand(name: string, detachKeys: string): string;	exec(name: string, argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>;
	logs(name: string, tail?: number): Promise<string>;
	stop(name: string, graceSeconds: number): Promise<void>;
	remove(name: string): Promise<void>;
	listByPrefix(prefix: string): Promise<string[]>;
	imageDigest(image: string): Promise<string | undefined>;
}

export interface PodmanBackendOptions {
	binary?: string;
	/** Extra global args, e.g. ["--storage-opt", ...] or a connection URI. */
	globalArgs?: string[];
	/** Default grace period for stop(), seconds. */
	defaultGraceSeconds?: number;
}

/** Run a command, collecting stdout/stderr. Never throws on a non-zero exit. */
function run(command: string, args: string[], options: SpawnOptions & { timeoutMs?: number } = {}): Promise<ExecResult> {
	const { timeoutMs, ...spawnOptions } = options;
	return new Promise((resolve) => {
		const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			resolve({ exitCode, stdout, stderr });
		};
		const timer =
			timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						child.kill("SIGKILL");
						finish(-1);
					}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			stderr += String(error.message);
			if (timer) clearTimeout(timer);
			finish(-1);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			finish(code ?? -1);
		});
	});
}

export class PodmanBackend implements ContainerBackend {
	readonly kind = "podman";
	private readonly binary: string;
	private readonly globalArgs: string[];
	private readonly defaultGraceSeconds: number;

	constructor(options: PodmanBackendOptions = {}) {
		this.binary = options.binary ?? "podman";
		this.globalArgs = options.globalArgs ?? [];
		this.defaultGraceSeconds = options.defaultGraceSeconds ?? 10;
	}

	private podman(args: string[], options?: { timeoutMs?: number }): Promise<ExecResult> {
		return run(this.binary, [...this.globalArgs, ...args], options);
	}

	async isAvailable(): Promise<boolean> {
		const result = await this.podman(["info", "--format", "{{.Version.Version}}"], { timeoutMs: 30_000 });
		return result.exitCode === 0;
	}

	async version(): Promise<string> {
		const result = await this.podman(["--version"], { timeoutMs: 15_000 });
		return result.exitCode === 0 ? result.stdout.trim() : "";
	}

	buildArgs(spec: ContainerSpec, interactive: boolean): string[] {
		const args: string[] = ["run"];
		args.push(interactive ? "-dit" : "-di");
		args.push("--name", spec.name);
		if (spec.entrypoint) args.push("--entrypoint", spec.entrypoint);
		if (spec.userns) args.push(`--userns=${spec.userns}`);
		if (spec.workdir) args.push("-w", spec.workdir);
		for (const [key, value] of Object.entries(spec.env ?? {})) args.push("-e", `${key}=${value}`);
		// Forward by NAME: podman copies the value from our own environment, so credential
		// material is never written to a file or to a command line we log.
		for (const name of spec.envForward ?? []) args.push("-e", name);
		for (const mount of spec.mounts ?? []) args.push("-v", `${mount.host}:${mount.container}:${mount.mode}`);
		const limits = spec.limits ?? {};
		if (limits.memory) args.push("--memory", limits.memory);
		if (limits.pids) args.push("--pids-limit", String(limits.pids));
		if (limits.cpus) args.push("--cpus", String(limits.cpus));
		if (spec.network) args.push("--network", spec.network);
		if (spec.extraArgs) args.push(...spec.extraArgs);
		args.push(spec.image, ...spec.command);
		return args;
	}

	async create(spec: ContainerSpec): Promise<string> {
		await this.remove(spec.name);
		const result = await this.podman(this.buildArgs(spec, true), { timeoutMs: 120_000 });
		if (result.exitCode !== 0) {
			throw new Error(
				`podman run failed for ${spec.name} (exit ${result.exitCode}): ${filterBenignTtyWarning(result.stderr).trim()}`,
			);
		}
		return spec.name;
	}

	async state(name: string): Promise<ContainerState> {
		const result = await this.podman(["inspect", "-f", "{{.State.Status}}", name], { timeoutMs: 20_000 });
		if (result.exitCode !== 0) {
			return /no such object|not found|no such/i.test(result.stderr) ? "missing" : "unknown";
		}
		const raw = result.stdout.trim();
		if (raw === "running") return "running";
		if (raw === "created") return "created";
		if (raw === "exited" || raw === "stopped") return "exited";
		return "unknown";
	}

	attachCommand(name: string, _detachKeys: string): string {
		// The pane runs `podman exec -it ... tmux attach`, NOT `podman attach`: the inner tmux owns
		// pi's PTY, so this client can die without pi ever seeing a SIGHUP.
		return buildAttachCommand(this.binary, name);
	}

	async exec(
		name: string,
		argv: string[],
		opts: { timeoutMs?: number; env?: Record<string, string> } = {},
	): Promise<ExecResult> {
		const args = ["exec"];
		for (const [key, value] of Object.entries(opts.env ?? {})) args.push("-e", `${key}=${value}`);
		args.push(name, ...argv);
		return this.podman(args, { timeoutMs: opts.timeoutMs ?? 60_000 });
	}

	async logs(name: string, tail = 400): Promise<string> {
		const result = await this.podman(["logs", "--tail", String(tail), name], { timeoutMs: 30_000 });
		return `${result.stdout}${result.stderr}`;
	}

	async stop(name: string, graceSeconds = this.defaultGraceSeconds): Promise<void> {
		// SIGTERM first: pi shuts down gracefully and persists the session
		// (pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:4314-4352).
		await this.podman(["stop", "-t", String(graceSeconds), name], {
			timeoutMs: (graceSeconds + 20) * 1000,
		});
	}

	async remove(name: string): Promise<void> {
		await this.podman(["rm", "-f", name], { timeoutMs: 60_000 });
	}

	async listByPrefix(prefix: string): Promise<string[]> {
		const result = await this.podman(["ps", "-a", "--format", "{{.Names}}"], { timeoutMs: 30_000 });
		if (result.exitCode !== 0) return [];
		return result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((name) => name.startsWith(prefix));
	}

	async imageDigest(image: string): Promise<string | undefined> {
		const result = await this.podman(["inspect", "-f", "{{.Digest}}", image], { timeoutMs: 30_000 });
		return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
	}

	async buildImage(containerfile: string, contextDir: string, tag: string): Promise<string> {
		const result = await this.podman(["build", "-f", containerfile, "-t", tag, contextDir], {
			timeoutMs: 1_800_000,
		});
		if (result.exitCode !== 0) {
			throw new Error(`podman build failed (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`);
		}
		const digest = await this.imageDigest(tag);
		return digest ?? tag;
	}
}

/** podman warns about a missing TTY when `run -dit` is issued from a non-TTY context; it is benign. */
export function filterBenignTtyWarning(stderr: string): string {
	return stderr
		.split("\n")
		.filter((line) => !/The input device is not a TTY/.test(line))
		.join("\n");
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export { shellQuote };
