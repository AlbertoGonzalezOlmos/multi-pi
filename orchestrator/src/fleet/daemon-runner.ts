/**
 * The multy daemon: bus + reconcile loop + lease reaper + merge lane.
 *
 * Responsibilities that must fire even while the parent model is thinking (PLAN.md §2.5):
 *   - heartbeats and stall detection
 *   - lease reaping, so orphaned work returns to the queue
 *   - budget enforcement, in code rather than in the model
 *   - container reconciliation, so a crashed instance is noticed
 *   - draining the merge lane
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoordinationBus, type DaemonHook } from "../bus/daemon.ts";
import { TaskBoard } from "../store/task-board.ts";
import { WorkspaceStore } from "../store/workspace-store.ts";
import { FleetManager } from "./fleet-manager.ts";
import { MergeLane } from "./merge-lane.ts";
import type { InstanceRecord } from "../store/types.ts";

export interface DaemonOptions {
	root: string;
	/**
	 * Share one store with the caller. Two WorkspaceStore instances would each keep their own
	 * sequence counter and hand out duplicate sequence numbers, so the daemon and the CLI must
	 * never both construct one for the same fleet root in the same process.
	 */
	store?: WorkspaceStore;
	/** How often to reconcile containers, reap leases and drain merges. */
	tickMs?: number;
	/** An instance is unresponsive after this many missed heartbeats. */
	heartbeatTimeoutMs?: number;
	/** Warn at this fraction of a budget, escalate at 1.0. */
	budgetWarnFraction?: number;
	onLog?: (line: string) => void;
}

export interface DaemonHandle {
	stop(): Promise<void>;
	bus: CoordinationBus;
	store: WorkspaceStore;
	board: TaskBoard;
	manager: FleetManager;
	mergeLane: MergeLane;
}

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90_000;
const DEFAULT_BUDGET_WARN = 0.8;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
	const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
	const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
	const budgetWarnFraction = options.budgetWarnFraction ?? DEFAULT_BUDGET_WARN;
	const log = options.onLog ?? (() => {});

	const store = options.store ?? new WorkspaceStore(options.root);
	const manager = new FleetManager({ root: options.root, store });
	const board = new TaskBoard(store);
	const manifest = store.readManifest();
	if (!manifest) throw new Error(`no fleet manifest at ${join(options.root, "fleet.json")}; run \`multy init\``);

	const mergeLane = new MergeLane({
		store,
		board,
		baseDir: manifest.projectRoot,
		target: manifest.merge.target,
		worktreesDir: store.paths.worktrees,
		auto: manifest.merge.auto,
		requireVerifyLabel: manifest.merge.requireVerifyLabel,
		onEscalate: (reason, taskId) => {
			log(`merge escalation ${taskId}: ${reason}`);
			bus.daemonPost("parent", "escalation", `Merge lane: ${reason}`, taskId);
		},
	});

	const bus = new CoordinationBus({
		store,
		board,
		socketPath: join(store.paths.run, "bus.sock"),
		fleetId: manifest.id,
		operatorToken: manager.operatorToken(),
		onEvent: (event: DaemonHook) => {
			switch (event.type) {
				case "instance-connected":
					log(`instance connected: ${event.instanceId}`);
					break;
				case "instance-disconnected":
					log(`instance disconnected: ${event.instanceId}`);
					break;
				case "review-needed":
					void routeReview(event.taskId);
					break;
				case "escalation":
					log(`escalation from ${event.from}: ${event.reason}`);
					break;
				case "task-ready":
					void mergeLane.drain().then(reportAttempts);
					break;
				default:
					break;
			}
		},
	});

	await bus.start();
	log(`bus listening on ${join(store.paths.run, "bus.sock")}`);

	/**
	 * Pick reviewers for a task in review. Excludes the author and, where the fleet allows it,
	 * prefers a different model FAMILY — that is the concrete payoff of per-instance models
	 * (PLAN.md §3.4).
	 */
	async function routeReview(taskId: string): Promise<void> {
		const task = board.get(taskId);
		if (!task) return;
		const open = store.listReviews(taskId).filter((review) => review.verdict === undefined);
		if (open.length > 0) return;
		const instances = store.listInstances().filter((instance) => instance.state !== "stopped" && instance.state !== "crashed");
		const author = task.assignee ?? task.createdBy;
		const candidates = instances.filter((instance) => instance.id !== author && instance.role !== "parent");
		if (candidates.length === 0) {
			bus.daemonPost("parent", "escalation", `No eligible reviewer for ${taskId} (author ${author}).`, taskId);
			return;
		}
		const authorFamily = modelFamily(instances.find((instance) => instance.id === author)?.model);
		const crossFamily = candidates.filter((instance) => modelFamily(instance.model) !== authorFamily);
		const chosen = (crossFamily.length > 0 ? crossFamily : candidates)[0];
		if (!chosen) return;
		const reviewId = `rev_${taskId.slice(5)}_${chosen.id}`;
		store.writeReview({
			id: reviewId,
			taskId,
			authorInstanceId: author,
			reviewerInstanceId: chosen.id,
			reviewerModel: chosen.model,
			requestedAt: new Date().toISOString(),
			seq: store.nextSequence(),
		});
		board.attachReview(taskId, reviewId);
		bus.daemonPost(
			chosen.id,
			"verdict",
			[
				`Review requested for task ${taskId}: ${task.title}`,
				"",
				task.body.slice(0, 4000),
				"",
				`Author: ${author} (${authorFamily ?? "?"}). You are on ${chosen.model}.`,
				`Submit your verdict with review_submit using review_id "${reviewId}".`,
				"Cite evidence as file:line. Do not edit code.",
			].join("\n"),
			taskId,
		);
		store.writeDecision("review.routed", "daemon", `${taskId} -> ${chosen.id} (${chosen.model})`, {
			taskId,
			reviewer: chosen.id,
			reviewerModel: chosen.model,
			authorFamily,
			crossFamily: crossFamily.length > 0,
			reviewId,
		});
		log(`review ${taskId} routed to ${chosen.id} (${chosen.model})`);
	}

	function reportAttempts(attempts: Awaited<ReturnType<MergeLane["drain"]>>): void {
		for (const attempt of attempts) {
			if (attempt.outcome === "skipped") continue;
			log(`merge ${attempt.outcome}: ${attempt.taskId}${attempt.reason ? ` (${attempt.reason})` : ""}`);
		}
	}

	let stopped = false;
	const timer = setInterval(() => {
		void tick();
	}, tickMs);

	async function tick(): Promise<void> {
		if (stopped) return;
		try {
			// 1. Container reality vs recorded state.
			const reconciled = await manager.reconcile();
			for (const change of reconciled.changed) log(`reconcile ${change}`);

			// 2. Heartbeats: distinguish a wedged process from a model that is thinking.
			const now = Date.now();
			for (const instance of store.listInstances()) {
				if (instance.state === "stopped" || instance.state === "crashed") continue;
				const last = instance.lastHeartbeatAt ? new Date(instance.lastHeartbeatAt).getTime() : now;
				if (now - last < heartbeatTimeoutMs) continue;
				const connected = bus.connectedInstanceIds.includes(instance.id);
				if (connected) continue;
				store.writeInstance({ ...instance, state: "unresponsive" });
				store.appendLedger({ kind: "instance.unresponsive", instanceId: instance.id, silentMs: now - last });
				log(`instance unresponsive: ${instance.id} (silent ${Math.round((now - last) / 1000)}s)`);
				bus.daemonPost(
					"parent",
					"escalation",
					`Instance ${instance.id} (${instance.role}, ${instance.model}) has been silent for ${Math.round((now - last) / 1000)}s and is not connected to the bus.`,
					instance.currentTaskId,
				);
			}

			// 3. Lease reaping, so orphaned work returns to the queue.
			const reaped = board.reapExpiredLeases();
			for (const task of reaped) log(`lease reaped: ${task.id}`);

			// 3b. Advance any task whose review quorum was met while we were not looking (a daemon
			// restart, or a verdict recorded before this reconcile existed).
			for (const taskId of bus.reconcileReviews()) log(`review quorum met, ${taskId} -> done`);

			// 4. Budgets, enforced here rather than by the model.
			for (const instance of store.listInstances()) {
				checkBudget(instance);
			}

			// 5. Drain the merge lane.
			reportAttempts(await mergeLane.drain());
		} catch (error) {
			log(`tick error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function checkBudget(instance: InstanceRecord): void {
		const budget = instance.budget;
		if (!budget) return;
		const ratios: number[] = [];
		if (budget.tokens) ratios.push(instance.spent.tokens / budget.tokens);
		if (budget.costUsd) ratios.push(instance.spent.costUsd / budget.costUsd);
		if (budget.wallMs) ratios.push(instance.spent.wallMs / budget.wallMs);
		if (budget.maxTurns) ratios.push(instance.spent.turns / budget.maxTurns);
		if (ratios.length === 0) return;
		const usage = Math.max(...ratios);
		const markerPath = join(store.instanceDir(instance.id), "budget-warned");
		if (usage >= 1) {
			store.appendLedger({ kind: "budget.exceeded", instanceId: instance.id, usage });
			bus.daemonPost(
				instance.id,
				"steering",
				`Budget exhausted (${Math.round(usage * 100)}%). Stop after the current step, summarise what you have, and mark your task blocked if it is unfinished.`,
			);
			bus.daemonPost("parent", "escalation", `Instance ${instance.id} exceeded its budget (${Math.round(usage * 100)}%).`);
			log(`budget exceeded: ${instance.id} (${Math.round(usage * 100)}%)`);
		} else if (usage >= budgetWarnFraction && !existsSync(markerPath)) {
			writeMarker(markerPath);
			store.appendLedger({ kind: "budget.warning", instanceId: instance.id, usage });
			bus.daemonPost(
				instance.id,
				"info",
				`Budget at ${Math.round(usage * 100)}%. Prefer wrapping up over starting new work.`,
			);
			log(`budget warning: ${instance.id} (${Math.round(usage * 100)}%)`);
		}
	}

	function writeMarker(path: string): void {
		try {
			writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
		} catch {}
	}

	return {
		bus,
		store,
		board,
		manager,
		mergeLane,
		async stop() {
			stopped = true;
			clearInterval(timer);
			await bus.stop();
			log("daemon stopped");
		},
	};
}

/** Model family is the provider segment of "provider/id". */
export function modelFamily(model: string | undefined | null): string | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : model;
}
