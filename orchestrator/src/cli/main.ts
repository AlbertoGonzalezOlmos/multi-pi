#!/usr/bin/env node
/**
 * multy — the operator's entry point.
 *
 * Deliberately thin: all logic lives in src/. Every command works whether or not the daemon is
 * running, because state is files under the fleet root and the daemon reconciles against them.
 */

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { startDaemon } from "../fleet/daemon-runner.ts";
import { FleetManager } from "../fleet/fleet-manager.ts";
import { MergeLane } from "../fleet/merge-lane.ts";
import { TaskBoard } from "../store/task-board.ts";
import { WorkspaceStore } from "../store/workspace-store.ts";
import { TmuxBackend } from "../terminal/tmux-backend.ts";
import { PodmanBackend } from "../container/podman-backend.ts";
import { PACKAGE_ROOT } from "../fleet/fleet-manager.ts";
import { renderCommand, redactEnv } from "../fleet/pi-invocation.ts";
const USAGE = `multy — orchestrator for containerised pi subharnesses

usage:
  multy init [--root DIR] [--project DIR] [--image REF] [--bridge bind|bake]
  multy daemon [--root DIR] [--tick MS]
  multy spawn PROFILE [--id ID] [--model M] [--root DIR] [--no-window] [--print "PROMPT"]
  multy status [--root DIR] [--json] [--watch]
  multy tasks [--root DIR] [--json]
  multy logs ID [--source container|pane|tui|bridge] [--tail N] [--root DIR]
  multy capture ID [--scrollback] [--root DIR]
  multy stop ID [--remove] [--root DIR]
  multy stop-all [--remove] [--root DIR]
  multy attach [--root DIR]        print the manual attach command
  multy tiled [--root DIR]         open one window with every instance side by side
  multy post TO "BODY" [--kind K] [--root DIR]
  multy inject TO "TEXT" [--root DIR]     push text into a live pi conversation
  multy image [--tag REF] [--root DIR]     build the subharness image
  multy merges [--root DIR] [--json]
  multy revert TASK_ID [--root DIR]
  multy hold | resume [--root DIR]
  multy doctor [--root DIR]
  multy ledger [--tail N] [--root DIR]
`;

interface Parsed {
	command: string;
	positionals: string[];
	flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
	const flags = new Map<string, string | true>();
	const positionals: string[] = [];
	let command = "";
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] as string;
		if (token.startsWith("--")) {
			const name = token.slice(2);
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) {
				flags.set(name, true);
			} else {
				flags.set(name, next);
				index += 1;
			}
		} else if (!command) {
			command = token;
		} else {
			positionals.push(token);
		}
	}
	return { command, positionals, flags };
}

function flagString(parsed: Parsed, name: string): string | undefined {
	const value = parsed.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

function flagBool(parsed: Parsed, name: string): boolean {
	return parsed.flags.has(name);
}

function resolveRoot(parsed: Parsed): string {
	const explicit = flagString(parsed, "root");
	if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
	const env = process.env.MULTY_FLEET_ROOT;
	if (env) return isAbsolute(env) ? env : resolve(process.cwd(), env);
	return resolve(process.cwd(), ".fleet");
}

function managerFor(root: string): FleetManager {
	return new FleetManager({ root });
}

function requireManifest(root: string): void {
	if (!existsSync(join(root, "fleet.json"))) {
		console.error(`no fleet at ${root}. Run: multy init --root ${root}`);
		process.exit(2);
	}
}

function out(text: string): void {
	process.stdout.write(`${text}\n`);
}

// ---------------------------------------------------------------------------

async function commandInit(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	const projectRoot = resolve(flagString(parsed, "project") ?? process.cwd());
	const image = flagString(parsed, "image") ?? "localhost/multy-pi:latest";
	const bridgeSource = flagString(parsed, "bridge") === "bake" ? "bake" : "bind";
	const manager = managerFor(root);
	const manifest = await manager.init({ projectRoot, image, bridgeSource });
	out(`fleet ${manifest.id}`);
	out(`  root      ${root}`);
	out(`  project   ${manifest.projectRoot}`);
	out(`  image     ${manifest.image}${manifest.imageDigest ? ` @ ${manifest.imageDigest.slice(0, 19)}` : ""}`);
	out(`  tmux      ${manifest.tmuxBinary} -L ${manifest.tmuxSocketName}`);
	out(`  bridge    ${manifest.bridgeSource} v${manifest.bridgeVersion}`);
	const problems = await manager.doctor();
	if (problems.length > 0) {
		out("");
		out("doctor:");
		for (const problem of problems) out(`  ! ${problem}`);
	}
	return 0;
}

async function commandDaemon(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const tickMs = Number(flagString(parsed, "tick") ?? 5000);
	out(`multy daemon · root ${root} · tick ${tickMs}ms`);
	const handle = await startDaemon({
		root,
		tickMs,
		onLog: (line) => out(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
	});
	out(`bus socket: ${join(handle.store.paths.run, "bus.sock")}`);
	out("press ctrl+c to stop");
	const shutdown = async (): Promise<void> => {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		await handle.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await new Promise<void>(() => {});
	return 0;
}

async function commandSpawn(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const profileName = parsed.positionals[0];
	if (!profileName) {
		console.error("usage: multy spawn PROFILE [--id ID] [--model M] [--print PROMPT]");
		return 2;
	}
	const manager = managerFor(root);
	const prompt = flagString(parsed, "print");
	const result = await manager.spawn(profileName, {
		instanceId: flagString(parsed, "id"),
		model: flagString(parsed, "model"),
		noWindow: flagBool(parsed, "no-window"),
		oneShot: prompt ? { prompt, mode: "json" } : undefined,
	});
	out(`spawned ${result.instance.id}`);
	out(`  role       ${result.instance.role}`);
	out(`  model      ${result.instance.model}`);
	out(`  container  ${result.containerName}`);
	out(`  worktree   ${result.instance.worktreeMode} -> ${result.instance.workdir}`);
	out(`  window     ${result.instance.paneTarget ?? "(none)"}`);
	if (result.windowError) out(`  window!!   ${result.windowError}`);
	out(`  attach     ${result.attachCommand}`);
	out(`  pi         ${renderCommand({ argv: result.command, env: redactEnv(result.env), envForward: [] })}`);
	return 0;
}

async function commandStatus(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const store = new WorkspaceStore(root);
	const manager = managerFor(root);
	await manager.reconcile();
	const asJson = flagBool(parsed, "json");
	const instances = store.listInstances();
	if (asJson) {
		out(JSON.stringify({ instances, tasks: new TaskBoard(store).list() }, null, 2));
		return 0;
	}
	if (instances.length === 0) {
		out("no instances. Try: multy spawn implementer");
		return 0;
	}
	out(
		pad("INSTANCE", 16) +
			pad("ROLE", 12) +
			pad("MODEL", 28) +
			pad("STATE", 13) +
			pad("TASK", 14) +
			pad("TOKENS", 10) +
			pad("COST", 9) +
			"INBOX",
	);
	for (const instance of instances) {
		const budget = instance.budget;
		const budgetPct =
			budget?.tokens && instance.spent.tokens > 0 ? ` ${Math.round((instance.spent.tokens / budget.tokens) * 100)}%` : "";
		out(
			pad(instance.id, 16) +
				pad(instance.role, 12) +
				pad(instance.model, 28) +
				pad(instance.state, 13) +
				pad(instance.currentTaskId ?? "-", 14) +
				pad(formatTokens(instance.spent.tokens), 10) +
				pad(`$${instance.spent.costUsd.toFixed(4)}`, 9) +
				`${store.inboxList(instance.id).length}${budgetPct}`,
		);
	}
	const board = new TaskBoard(store);
	const open = board.list().filter((task) => task.status !== "done" && task.status !== "cancelled");
	out("");
	out(`open tasks: ${open.length} · total: ${board.list().length}`);
	return 0;
}

async function commandTasks(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const board = new TaskBoard(new WorkspaceStore(root));
	const tasks = board.list();
	if (flagBool(parsed, "json")) {
		out(JSON.stringify(tasks, null, 2));
		return 0;
	}
	if (tasks.length === 0) {
		out("no tasks");
		return 0;
	}
	for (const task of tasks) {
		const merge = task.merge ? ` merge:${task.merge.state}` : "";
		out(
			`p${String(task.priority).padEnd(4)} ${task.id}  [${task.status}]${merge}  ${task.title}` +
				`${task.assignee ? ` -> ${task.assignee}` : ""}`,
		);
	}
	return 0;
}

async function commandLogs(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	const id = parsed.positionals[0];
	if (!id) {
		console.error("usage: multy logs ID [--source container|pane|tui|bridge]");
		return 2;
	}
	const source = (flagString(parsed, "source") ?? "container") as "container" | "pane" | "tui" | "bridge";
	const tail = Number(flagString(parsed, "tail") ?? 200);
	out(await managerFor(root).logs(id, source, tail));
	return 0;
}

async function commandCapture(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	const id = parsed.positionals[0];
	if (!id) {
		console.error("usage: multy capture ID [--scrollback]");
		return 2;
	}
	out(await managerFor(root).capture(id, flagBool(parsed, "scrollback")));
	return 0;
}

async function commandStop(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const manager = managerFor(root);
	const id = parsed.positionals[0];
	if (!id) {
		console.error("usage: multy stop ID [--remove]");
		return 2;
	}
	await manager.stop(id, { remove: flagBool(parsed, "remove") });
	out(`stopped ${id}`);
	return 0;
}

async function commandStopAll(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const manager = managerFor(root);
	const store = manager.store;
	for (const instance of store.listInstances()) {
		await manager.stop(instance.id, { remove: flagBool(parsed, "remove") });
		out(`stopped ${instance.id}`);
	}
	return 0;
}

async function commandAttach(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const store = new WorkspaceStore(root);
	const manifest = store.readManifest();
	if (!manifest) return 2;
	out(`tmux -L ${manifest.tmuxSocketName} attach -t fleet`);
	out("");
	out("per-instance attach commands (usable from any terminal):");
	for (const instance of store.listInstances()) {
		out(`  ${instance.id}: podman exec -it ${instance.containerName} tmux attach -t pi`);
	}
	return 0;
}

async function commandTiled(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const store = new WorkspaceStore(root);
	const manifest = store.readManifest();
	if (!manifest) return 2;
	const tmux = new TmuxBackend({ socketName: manifest.tmuxSocketName, binary: manifest.tmuxBinary });
	const windows = store.listInstances().filter((instance) => instance.paneTarget).map((instance) => instance.paneTarget as string);
	if (windows.length === 0) {
		out("no windows to tile");
		return 0;
	}
	const session = await tmux.buildTiledSession(windows, 200, 60);
	out(`tiled session ready. Attach with:`);
	out(`  tmux -L ${manifest.tmuxSocketName} attach -t ${session}`);
	return 0;
}

async function commandPost(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const to = parsed.positionals[0];
	const body = parsed.positionals.slice(1).join(" ");
	if (!to || !body) {
		console.error('usage: multy post TO "BODY" [--kind info|question|steering|...]');
		return 2;
	}
	const store = new WorkspaceStore(root);
	const socketPath = join(store.paths.run, "bus.sock");
	const manager = managerFor(root);
	const message = await postViaSocket(
		socketPath,
		manager.operatorToken(),
		{
			type: "message.post",
			payload: { to, body, kind: flagString(parsed, "kind") ?? "info", requiresAck: false },
			from: "operator",
		},
	);
	out(JSON.stringify(message));
	return 0;
}

async function commandInject(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const to = parsed.positionals[0];
	const text = parsed.positionals.slice(1).join(" ");
	if (!to || !text) {
		console.error('usage: multy inject TO "TEXT"');
		return 2;
	}
	const store = new WorkspaceStore(root);
	const socketPath = join(store.paths.run, "bus.sock");
	const response = await postViaSocket(socketPath, managerFor(root).operatorToken(), {
		type: "message.post",
		payload: { to, body: text, kind: "steering", requiresAck: false },
		from: "operator",
	});
	out(JSON.stringify(response));
	return 0;
}

async function commandMerges(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const store = new WorkspaceStore(root);
	const board = new TaskBoard(store);
	const tasks = board.list().filter((task) => task.merge !== undefined);
	if (flagBool(parsed, "json")) {
		out(JSON.stringify(tasks.map((task) => ({ id: task.id, title: task.title, merge: task.merge })), null, 2));
		return 0;
	}
	if (tasks.length === 0) {
		out("no merge activity yet");
		return 0;
	}
	for (const task of tasks) {
		const merge = task.merge;
		if (!merge) continue;
		out(
			`${task.id}  ${merge.state.padEnd(12)} ${(merge.mergeSha ?? "").slice(0, 12).padEnd(13)} ${task.title}` +
				`${merge.holdReason ? `  (${merge.holdReason})` : ""}`,
		);
	}
	return 0;
}

async function commandRevert(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const taskId = parsed.positionals[0];
	if (!taskId) {
		console.error("usage: multy revert TASK_ID");
		return 2;
	}
	const store = new WorkspaceStore(root);
	const manifest = store.readManifest();
	if (!manifest) return 2;
	const lane = new MergeLane({
		store,
		board: new TaskBoard(store),
		baseDir: manifest.projectRoot,
		target: manifest.merge.target,
		worktreesDir: store.paths.worktrees,
		auto: manifest.merge.auto,
	});
	const result = await lane.revert(taskId, "operator");
	out(result.ok ? `reverted ${taskId} -> ${result.revertSha?.slice(0, 12)}` : `revert failed: ${result.reason}`);
	return result.ok ? 0 : 1;
}

async function commandHoldResume(parsed: Parsed, hold: boolean): Promise<number> {
	const root = resolveRoot(parsed);
	requireManifest(root);
	const store = new WorkspaceStore(root);
	const manifest = store.readManifest();
	if (!manifest) return 2;
	const lane = new MergeLane({
		store,
		board: new TaskBoard(store),
		baseDir: manifest.projectRoot,
		target: manifest.merge.target,
		worktreesDir: store.paths.worktrees,
		auto: manifest.merge.auto,
	});
	if (hold) lane.hold("operator");
	else lane.resume("operator");
	out(`merges ${hold ? "HELD" : "resumed"}`);
	return 0;
}

async function commandImage(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	const manager = managerFor(root);
	const tag = flagString(parsed, "tag") ?? "localhost/multy-pi:latest";
	const contextDir = resolve(flagString(parsed, "context") ?? join(PACKAGE_ROOT, "image"));
	out(`building ${tag} from ${contextDir}/Containerfile`);
	const podman = new PodmanBackend();
	const digest = await podman.buildImage(join(contextDir, "Containerfile"), contextDir, tag);
	out(`built ${tag} @ ${digest.slice(0, 19)}`);
	const manifest = manager.manifest;
	if (manifest) {
		manager.store.writeManifest({ ...manifest, image: tag, imageDigest: digest });
		out("manifest updated");
	}
	return 0;
}

async function commandDoctor(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	const manager = managerFor(root);
	const problems = await manager.doctor();
	const manifest = manager.manifest;
	if (manifest) {
		out(`fleet        ${manifest.id}`);
		out(`image        ${manifest.image}${manifest.imageDigest ? ` @ ${manifest.imageDigest.slice(0, 19)}` : ""}`);
		out(`tmux         ${manifest.tmuxBinary} -L ${manifest.tmuxSocketName}`);
		out(`bridge       ${manifest.bridgeSource} v${manifest.bridgeVersion}`);
		out(`merge        auto=${manifest.merge.auto} target=${manifest.merge.target} strategy=${manifest.merge.strategy}`);
		out(`profiles     ${manager.profiles().size}`);
		out(`instances    ${manager.store.listInstances().length}`);
	}
	if (problems.length === 0) {
		out("");
		out("doctor: no problems found");
		return 0;
	}
	out("");
	out("doctor:");
	for (const problem of problems) out(`  ! ${problem}`);
	return 1;
}

async function commandLedger(parsed: Parsed): Promise<number> {
	const root = resolveRoot(parsed);
	const store = new WorkspaceStore(root);
	const tail = Number(flagString(parsed, "tail") ?? 40);
	for (const entry of store.readLedger(tail)) out(JSON.stringify(entry));
	return 0;
}

// ---------------------------------------------------------------------------

/**
 * Send one request to a running daemon's bus socket. Used by the operator-facing post/inject
 * commands so they do not need to bind the socket themselves.
 *
 * Authenticates with the host-only operator token (never mounted into a container), so the daemon
 * registers us as the pseudo-instance "operator".
 */
async function postViaSocket(
	socketPath: string,
	operatorToken: string | undefined,
	request: { type: string; payload: unknown; from: string },
	timeoutMs = 15_000,
): Promise<unknown> {
	if (!existsSync(socketPath)) throw new Error(`bus socket not found at ${socketPath}; is \`multy daemon\` running?`);
	return new Promise((resolvePromise, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let helloAcked = false;
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("timed out waiting for the daemon"));
		}, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({
					v: 1,
					id: `cli_hello_${Date.now()}`,
					from: request.from,
					kind: "req",
					type: "hello",
					payload: {
						token: operatorToken ?? "",
						role: "operator",
						pid: process.pid,
						piVersion: "cli",
						bridgeVersion: "cli",
						bridgeSource: "bind",
						sessionFile: null,
						sessionId: null,
						model: null,
						provider: null,
						capabilities: ["operator"],
					},
				})}\n`,
			);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				let record: { kind?: string; ok?: boolean; error?: string };
				try {
					record = JSON.parse(line) as typeof record;
				} catch {
					continue;
				}
				if (!helloAcked) {
					helloAcked = true;
					if (record.kind === "res" && record.ok !== true) {
						clearTimeout(timer);
						socket.destroy();
						reject(new Error(`operator authentication failed: ${record.error ?? "unknown"}`));
						return;
					}
					socket.write(
						`${JSON.stringify({
							v: 1,
							id: `cli_${Date.now()}`,
							from: request.from,
							kind: "req",
							type: request.type,
							payload: request.payload,
						})}\n`,
					);
					continue;
				}
				clearTimeout(timer);
				socket.end();
				try {
					resolvePromise(JSON.parse(line));
				} catch {
					resolvePromise({ raw: line });
				}
				return;
			}
		});
		socket.on("error", (error: Error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function pad(text: string, width: number): string {
	const value = text.length > width - 1 ? `${text.slice(0, width - 2)}…` : text;
	return value + " ".repeat(Math.max(0, width - value.length));
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.command === "" || flagBool(parsed, "help") || parsed.command === "help") {
		out(USAGE);
		return parsed.command === "" ? 2 : 0;
	}
	switch (parsed.command) {
		case "init":
			return commandInit(parsed);
		case "daemon":
			return commandDaemon(parsed);
		case "spawn":
			return commandSpawn(parsed);
		case "status":
		case "list":
			return commandStatus(parsed);
		case "tasks":
			return commandTasks(parsed);
		case "logs":
			return commandLogs(parsed);
		case "capture":
			return commandCapture(parsed);
		case "stop":
			return commandStop(parsed);
		case "stop-all":
			return commandStopAll(parsed);
		case "attach":
			return commandAttach(parsed);
		case "tiled":
			return commandTiled(parsed);
		case "post":
			return commandPost(parsed);
		case "inject":
			return commandInject(parsed);
		case "merges":
			return commandMerges(parsed);
		case "revert":
			return commandRevert(parsed);
		case "hold":
			return commandHoldResume(parsed, true);
		case "resume":
			return commandHoldResume(parsed, false);
		case "image":
			return commandImage(parsed);
		case "doctor":
			return commandDoctor(parsed);
		case "ledger":
			return commandLedger(parsed);
		default:
			console.error(`unknown command: ${parsed.command}\n`);
			out(USAGE);
			return 2;
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	},
);
