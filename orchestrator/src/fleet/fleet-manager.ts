/**
 * FleetManager — instance lifecycle.
 *
 * Spawning is a pure function of (profile, fleet root) so it can be replayed after a crash:
 * provision the agent dir, create the worktree, start the container with podman holding the PTY,
 * then open a tmux window whose pane runs `podman attach`.
 *
 * The daemon does not need a control socket: state lives in instance.json files and the daemon
 * reconciles against them periodically. That keeps `multy spawn` working whether or not the
 * daemon is up, and makes daemon restarts safe (PLAN.md §5.4).
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { PodmanBackend, type ContainerBackend } from "../container/podman-backend.ts";
import { TmuxBackend } from "../terminal/tmux-backend.ts";
import { loadProfilesFromDir, renderTitle, type Profile } from "../profile/loader.ts";
import { provisionInstance } from "../profile/provision.ts";
import { WorkspaceStore } from "../store/workspace-store.ts";
import type { FleetManifest, InstanceRecord } from "../store/types.ts";
import { buildPiInvocation, DEFAULT_PATHS, PI_BINARY_PATH, redactEnv } from "./pi-invocation.ts";
import { buildInnerCommand, CONTAINER_BASE_ENV } from "../container/inner-command.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";

export const CONTAINER_PREFIX = "multy-";

/** How long to watch a freshly started container before declaring that pi came up. */
const STARTUP_VERIFY_MS = 12_000;

export interface FleetManagerOptions {
	root: string;
	/**
	 * Share the caller's store. Two WorkspaceStore instances over one fleet root would each keep
	 * their own sequence counter and hand out duplicate sequence numbers.
	 */
	store?: WorkspaceStore;
	container?: ContainerBackend;
	tmux?: TmuxBackend;
	image?: string;
}

export interface SpawnOptions {
	instanceId?: string;
	/** Overrides the profile's model id. */
	model?: string;
	/** Extra pi argv, e.g. ["-p", "--mode", "json"] is handled separately via oneShot. */
	extraArgs?: string[];
	oneShot?: { prompt: string; mode?: "print" | "json" };
	/** Do not open a tmux window (used for headless/test spawns). */
	noWindow?: boolean;
}

export interface SpawnResult {
	instance: InstanceRecord;
	containerName: string;
	windowName: string;
	attachCommand: string;
	command: string[];
	env: Record<string, string>;
	/** Set when the container is running but no tmux pane could be opened. */
	windowError?: string;
}

export class FleetManager {
	readonly store: WorkspaceStore;
	readonly root: string;
	private readonly container: PodmanBackend | ContainerBackend;
	private readonly tmux: TmuxBackend;
	private readonly imageOverride?: string;

	constructor(options: FleetManagerOptions) {
		this.root = options.root;
		this.store = options.store ?? new WorkspaceStore(options.root);
		this.container = options.container ?? new PodmanBackend();
		this.tmux =
			options.tmux ??
			new TmuxBackend({ socketName: `multy-${process.getuid?.() ?? 0}` });
		this.imageOverride = options.image;
	}

	get manifest(): FleetManifest | undefined {
		return this.store.readManifest();
	}

	profiles(): Map<string, Profile> {
		return loadProfilesFromDir(this.store.paths.profiles);
	}

	profile(name: string): Profile {
		const profile = this.profiles().get(name);
		if (!profile) {
			throw new Error(
				`unknown profile "${name}". Available: ${[...this.profiles().keys()].join(", ") || "(none — run multy init)"}`,
			);
		}
		return profile;
	}

	image(): string {
		return this.imageOverride ?? this.manifest?.image ?? "localhost/multy-pi:latest";
	}

	/** Create the fleet root, write the manifest, and seed profiles/roles/prompts. */
	async init(options: {
		projectRoot: string;
		image: string;
		piVersion?: string;
		bridgeSource?: "bind" | "bake";
		/** Where the shipped profiles/roles/prompts/bridge live; defaults to this package. */
		seedFrom?: string;
	}): Promise<FleetManifest> {
		mkdirSync(this.root, { recursive: true });
		const available = await this.container.isAvailable();
		if (!available) throw new Error("podman is not usable (`podman info` failed); install it or fix rootless setup");
		const tmuxOk = await this.tmux.isAvailable();
		if (!tmuxOk) throw new Error(`tmux not found (searched PATH and defaults); binary=${this.tmux.binaryPath ?? "none"}`);

		// Seed the fleet root from the package so a fleet is self-contained: provisionInstance
		// resolves roles/ and prompts/ relative to the fleet root, not to the package.
		const seedFrom = options.seedFrom ?? PACKAGE_ROOT;
		for (const dir of ["profiles", "roles", "prompts"] as const) {
			copyTreeIfMissing(join(seedFrom, dir), join(this.root, dir));
		}
		// The bridge is bind-mounted from <fleet>/image/bridge in dev mode, so it must exist there.
		copyTree(join(seedFrom, "extensions", "fleet-bridge"), this.store.paths.bridge);

		const manifest: FleetManifest = {
			id: `fleet_${randomUUID().slice(0, 8)}`,
			createdAt: new Date().toISOString(),
			projectRoot: options.projectRoot,
			piBinary: "pi",
			piVersion: options.piVersion ?? "1.0.0",
			image: options.image,
			imageDigest: await this.container.imageDigest(options.image),
			tmuxBinary: this.tmux.binaryPath ?? "tmux",
			tmuxSocketName: this.tmux.socketName,
			podmanBinary: "podman",
			bridgeSource: options.bridgeSource ?? "bind",
			bridgeVersion: BRIDGE_VERSION,
			merge: {
				auto: true,
				target: "main",
				strategy: "rebase-then-no-ff",
				onConflict: "block-and-repair",
			},
			defaultTarget: "main",
		};
		this.store.writeManifest(manifest);
		// Operator token: authenticates host-side CLI commands to the bus. It lives in <fleet>/run
		// with mode 0600 and is NEVER mounted into a container, so only host processes can present
		// it. That is the right trust boundary: an operator can steer the fleet, a subharness cannot
		// impersonate the operator.
		const operatorToken = randomUUID().replaceAll("-", "");
		const tokenPath = join(this.store.paths.run, "operator.token");
		writeFileSync(tokenPath, `${operatorToken}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(tokenPath, 0o600);
		this.store.appendLedger({ kind: "fleet.init", fleetId: manifest.id, image: manifest.image });
		return manifest;
	}

	/** Read the operator token, for host-side CLI commands only. */
	operatorToken(): string | undefined {
		const path = join(this.store.paths.run, "operator.token");
		if (!existsSync(path)) return undefined;
		return readFileSync(path, "utf8").trim();
	}

	instanceIdFor(role: string, explicit?: string): string {
		if (explicit) return explicit;
		const taken = new Set(this.store.listInstances().map((instance) => instance.id));
		if (!taken.has(role)) return role;
		for (let index = 2; index < 100; index += 1) {
			const candidate = `${role}${index}`;
			if (!taken.has(candidate)) return candidate;
		}
		return `${role}_${randomUUID().slice(0, 4)}`;
	}

	async spawn(profileName: string, options: SpawnOptions = {}): Promise<SpawnResult> {
		const manifest = this.manifest;
		if (!manifest) throw new Error("fleet is not initialised; run `multy init` first");
		const profile = this.profile(profileName);
		const role = profile.role ?? profile.name;
		const instanceId = this.instanceIdFor(role, options.instanceId);
		if (options.model) profile.model = { ...profile.model, id: options.model };

		const instanceDir = this.store.instanceDir(instanceId);
		const agentDir = join(instanceDir, "agent");
		mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
		const token = randomUUID().replaceAll("-", "");

		// 1. Provision the private agent dir (settings, role card, coordination prompt, bridge).
		provisionInstance({
			instanceId,
			role,
			profile,
			agentDir,
			bridgeSourceDir: this.store.paths.bridge,
			bridgeSource: profile.bridge?.source ?? manifest.bridgeSource,
			resourcesDir: this.root,
		});

		// 2. Filesystem isolation: private worktree for writers, base :ro for everyone else.
		const worktreeMode = profile.isolation?.worktree ?? "private";
		let hostWorkdir = manifest.projectRoot;
		if (worktreeMode === "private") {
			hostWorkdir = join(this.store.paths.worktrees, instanceId);
			const branch = `fleet/${instanceId}`;
			if (!existsSync(hostWorkdir)) {
				await createWorktree({
					baseDir: manifest.projectRoot,
					path: hostWorkdir,
					branch,
					startPoint: manifest.merge.target,
				});
			}
		}

		// 3. Build the pi invocation and container spec.
		const bridgeSource = profile.bridge?.source ?? manifest.bridgeSource;
		const invocation = buildPiInvocation({
			instanceId,
			role,
			token,
			profile,
			bridgeSource,
			bridgeVersion: BRIDGE_VERSION,
			piVersion: manifest.piVersion,
			depth: 0,
			extraArgs: options.extraArgs,
			oneShot: options.oneShot,
		});

		const containerName = `${CONTAINER_PREFIX}${instanceId}`;
		const mounts = [
			{ host: agentDir, container: DEFAULT_PATHS.agentDir, mode: "rw" as const },
			{ host: hostWorkdir, container: DEFAULT_PATHS.workdir, mode: worktreeMode === "shared-readonly" ? ("ro" as const) : ("rw" as const) },
			{ host: this.store.paths.workspace, container: DEFAULT_PATHS.workspace, mode: "rw" as const },
			{ host: this.store.paths.run, container: "/fleet/run", mode: "rw" as const },
		];
		// In bake mode the bridge comes from the image; in bind mode mount it live so edits need
		// no rebuild. The daemon refuses a fleet that mixes the two (§3.5).
		if (bridgeSource === "bind") {
			mounts.push({
				host: join(agentDir, "extensions", "fleet-bridge"),
				container: "/agent/extensions/fleet-bridge",
				mode: "ro",
			});
		}

		const container = this.container as PodmanBackend;
		const size = profile.terminal?.size ?? { cols: 130, rows: 42 };
		// pi runs inside an inner tmux session that owns its PTY, so attach clients can come and go
		// without pi seeing a SIGHUP. bash -c is the entrypoint; pi's argv is embedded in the
		// wrapper (see src/container/inner-command.ts for why this is not optional).
		const innerCommand = buildInnerCommand({ piArgv: invocation.argv, cols: size.cols, rows: size.rows });
		await container.create({
			name: containerName,
			image: this.image(),
			command: ["-c", innerCommand],
			entrypoint: "/bin/bash",
			workdir: DEFAULT_PATHS.workdir,
			env: { ...CONTAINER_BASE_ENV, ...invocation.env },
			envForward: invocation.envForward,
			mounts,
			userns: profile.container?.userns ?? "keep-id",
			limits: profile.container?.limits,
			extraArgs: profile.container?.extraArgs,
		});

		// Verify pi actually came up. Without this, a bad entrypoint or a missing credential shows
		// up ten seconds later as a bare "crashed" from the reconcile loop, with no clue why.
		const startupError = await this.verifyStartup(containerName);
		if (startupError) {
			await container.remove(containerName).catch(() => {});
			throw new Error(startupError);
		}

		// 4. Record the instance BEFORE touching the terminal plane. The container is the real
		// thing; the tmux window is presentation only (§2.3). If tmux fails we must not leave an
		// orphan container with no instance.json to describe it.
		const instance: InstanceRecord = {
			id: instanceId,
			role,
			profile: profileName,
			model: profile.model.id,
			containerName,
			paneTarget: undefined,
			agentDir,
			workdir: hostWorkdir,
			worktreeMode,
			sessionId: instanceId,
			state: "starting",
			token,
			createdAt: new Date().toISOString(),
			budget: profile.budget
				? {
						tokens: profile.budget.tokens,
						costUsd: profile.budget.costUsd,
						wallMs: profile.budget.wallMinutes === undefined ? undefined : profile.budget.wallMinutes * 60_000,
						maxTurns: profile.budget.maxTurns,
					}
				: undefined,
			spent: { tokens: 0, costUsd: 0, wallMs: 0, turns: 0 },
		};
		this.store.writeInstance(instance);

		// 5. The terminal plane: a host tmux window whose pane attaches to the container's inner
		// tmux. Presentation only — the instance is already running and coordinating without it.
		const windowName = `${role}:${instanceId}`;
		const attach = container.attachCommand(containerName, profile.terminal?.detachKeys ?? "ctrl-\\");
		let windowError: string | undefined;
		if (!options.noWindow && !options.oneShot) {
			try {
				await this.tmux.openWindow({
					window: windowName,
					command: attach,
					cols: size.cols,
					rows: size.rows,
					title: renderTitle(profile.terminal?.title ?? "{role} · {model}", {
						role,
						model: profile.model.id,
						task: "-",
						instance: instanceId,
					}),
					pipeToFile: join(instanceDir, "pane.log"),
				});
				instance.paneTarget = windowName;
				this.store.writeInstance(instance);
			} catch (error) {
				// Not fatal: the instance is running and coordinating, it just has no pane. The
				// operator can still attach by hand with the printed command.
				windowError = error instanceof Error ? error.message : String(error);
				this.store.appendLedger({ kind: "instance.window_failed", instanceId, error: windowError });
			}
		}

		// 6. The token stays in this 0600 file on the host and is NEVER mounted into the container
		// as a file — it reaches pi through the environment only.
		this.store.appendLedger({
			kind: "instance.spawned",
			instanceId,
			role,
			profile: profileName,
			model: profile.model.id,
			container: containerName,
			worktreeMode,
			window: instance.paneTarget ?? null,
			windowError: windowError ?? null,
			innerCommand,
			piArgv: invocation.argv,
			env: redactEnv({ ...CONTAINER_BASE_ENV, ...invocation.env }),
		});

		return {
			instance,
			containerName,
			windowName: instance.paneTarget ?? windowName,
			attachCommand: attach,
			command: invocation.argv,
			env: invocation.env,
			windowError,
		};
	}

	/**
	 * Watch a freshly started container briefly. Returns an error message if pi exited during
	 * startup, including the container log, which is where the actual reason lives.
	 */
	private async verifyStartup(containerName: string): Promise<string | undefined> {
		const deadline = Date.now() + STARTUP_VERIFY_MS;
		while (Date.now() < deadline) {
			const state = await this.container.state(containerName);
			if (state === "running") return undefined;
			if (state === "exited" || state === "missing") {
				const logs = (await this.container.logs(containerName, 40)).trim();
				return `pi exited during startup in ${containerName}. Container log:\n${logs || "(empty)"}`;
			}
			await sleep(400);
		}
		return undefined;
	}

	async state(instanceId: string): Promise<string> {
		const instance = this.store.readInstance(instanceId);
		if (!instance) return "missing";
		return this.container.state(instance.containerName);
	}

	async stop(instanceId: string, options: { remove?: boolean; graceSeconds?: number } = {}): Promise<void> {
		const instance = this.store.readInstance(instanceId);
		if (!instance) return;
		// SIGTERM first: pi shuts down gracefully and persists the session
		// (interactive-mode.ts:4314-4352), so --session-id can resume it later.
		await this.container.stop(instance.containerName, options.graceSeconds ?? 10);
		if (instance.paneTarget) await this.tmux.closeWindow(instance.paneTarget).catch(() => {});
		if (options.remove) {
			await this.container.remove(instance.containerName);
			if (instance.worktreeMode === "private") {
				const manifest = this.manifest;
				if (manifest) {
					await removeWorktree(manifest.projectRoot, instance.workdir).catch(() => {});
				}
			}
		}
		this.store.writeInstance({ ...instance, state: "stopped" });
		this.store.appendLedger({ kind: "instance.stopped", instanceId, removed: options.remove === true });
	}

	async logs(instanceId: string, source: "container" | "pane" | "tui" | "bridge" = "container", tail = 200): Promise<string> {
		const instance = this.store.readInstance(instanceId);
		if (!instance) return `(no such instance: ${instanceId})`;
		if (source === "container") return this.container.logs(instance.containerName, tail);
		const paths: Record<string, string> = {
			pane: join(this.store.instanceDir(instanceId), "pane.log"),
			tui: join(instance.agentDir, "tui-bytes.log"),
			bridge: join(this.store.instanceDir(instanceId), "bridge.log"),
		};
		const path = paths[source];
		if (!path || !existsSync(path)) return `(no ${source} log for ${instanceId})`;
		const text = readFileSync(path, "utf8");
		const lines = text.split("\n");
		return lines.slice(-tail).join("\n");
	}

	async capture(instanceId: string, scrollback = false): Promise<string> {
		const instance = this.store.readInstance(instanceId);
		if (!instance?.paneTarget) return `(no pane for ${instanceId})`;
		return this.tmux.capture(instance.paneTarget, scrollback);
	}

	/** Reconcile recorded instance state against container reality. */
	async reconcile(): Promise<{ changed: string[] }> {
		const changed: string[] = [];
		for (const instance of this.store.listInstances()) {
			if (instance.state === "stopped" || instance.state === "crashed") continue;
			const actual = await this.container.state(instance.containerName);
			const next =
				actual === "running"
					? instance.state === "starting"
						? "idle"
						: instance.state
					: actual === "exited"
						? "crashed"
						: actual === "missing"
							? "stopped"
							: instance.state;
			if (next !== instance.state) {
				this.store.writeInstance({ ...instance, state: next });
				this.store.appendLedger({ kind: "instance.state", instanceId: instance.id, from: instance.state, to: next });
				changed.push(`${instance.id}: ${instance.state} -> ${next}`);
			}
		}
		return { changed };
	}

	/** Preflight checks, surfaced by `multy doctor`. */
	async doctor(): Promise<string[]> {
		const problems: string[] = [];
		if (!(await this.container.isAvailable())) problems.push("podman is not usable (try: podman info)");
		if (!(await this.tmux.isAvailable())) {
			problems.push(`tmux not found; searched ${this.tmux.binaryPath ?? "PATH and default locations"}`);
		}
		const manifest = this.manifest;
		if (!manifest) {
			problems.push("no fleet manifest (run `multy init`)");
			return problems;
		}
		const digest = await this.container.imageDigest(manifest.image);
		if (!digest) problems.push(`image not present locally: ${manifest.image}`);
		else if (manifest.imageDigest && manifest.imageDigest !== digest) {
			problems.push(`image digest drifted: manifest ${manifest.imageDigest.slice(0, 19)} vs local ${digest.slice(0, 19)}`);
		}
		if (!existsSync(manifest.projectRoot)) problems.push(`project root missing: ${manifest.projectRoot}`);
		if (this.profiles().size === 0) problems.push(`no profiles in ${this.store.paths.profiles}`);
		// A mixed fleet is a debugging trap: one instance running an old bridge will misbehave in
		// ways that look like a protocol bug.
		const sources = new Set(
			this.store
				.listInstances()
				.map((instance) => {
					const marker = join(instance.agentDir, "BRIDGE_SOURCE");
					return existsSync(marker) ? readFileSync(marker, "utf8").trim() : "?";
				})
				.filter((value) => value !== "?"),
		);
		if (sources.size > 1) problems.push(`fleet mixes bridge sources: ${[...sources].join(", ")}`);
		// Credentials: profiles forward env vars by NAME, so verify each name is actually set here.
		for (const profile of this.profiles().values()) {
			for (const name of profile.container?.env ?? []) {
				if (!process.env[name]) problems.push(`profile "${profile.name}" needs env ${name}, which is not set`);
			}
		}
		return problems;
	}
}

/** Keep in sync with extensions/fleet-bridge/index.ts. */
export const BRIDGE_VERSION = "0.1.0";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Package root, i.e. the directory holding profiles/, roles/, prompts/ and extensions/. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function copyTree(source: string, target: string): void {
	if (!existsSync(source)) return;
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true });
}

/** Copy only the entries the target does not already have, so local edits survive re-init. */
function copyTreeIfMissing(source: string, target: string): void {
	if (!existsSync(source)) return;
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const destination = join(target, entry.name);
		if (existsSync(destination)) continue;
		cpSync(join(source, entry.name), destination, { recursive: entry.isDirectory() });
	}
}
