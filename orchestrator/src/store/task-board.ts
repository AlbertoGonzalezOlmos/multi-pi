/**
 * TaskBoard — status transitions, dependency graph, leases.
 *
 * Pure functions over an injected store so the transition matrix is testable without any
 * process, container or git repo. Only the daemon mutates tasks; clients request transitions
 * (PLAN.md §3.3).
 */

import { randomUUID } from "node:crypto";
import type { TaskBudget, TaskSpent, TaskStatus } from "../bus/protocol.ts";
import type { Task, TaskHistoryEntry } from "./types.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

/**
 * Allowed transitions. Anything not listed is rejected by assertTransition.
 *
 * `done` is not terminal for code tasks: it hands off to the merge lane (PLAN.md §3.8), which
 * may return the task to `blocked` on conflict.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
	proposed: ["queued", "cancelled"],
	queued: ["assigned", "cancelled", "proposed"],
	assigned: ["in_progress", "queued", "blocked", "cancelled"],
	in_progress: ["blocked", "in_review", "done", "cancelled"],
	blocked: ["queued", "assigned", "in_progress", "cancelled"],
	in_review: ["changes_requested", "done", "in_progress", "blocked"],
	changes_requested: ["in_progress", "blocked", "cancelled"],
	// The merge lane may block a done task on conflict, or revert it later.
	done: ["blocked", "cancelled"],
	cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
	if (from === to) return;
	if (!canTransition(from, to)) {
		throw new Error(`illegal task transition ${from} -> ${to}`);
	}
}

export const EMPTY_SPENT: TaskSpent = { tokens: 0, costUsd: 0, wallMs: 0, turns: 0 };

/**
 * Statuses whose lease represents work actively in hand. Anything else is waiting on someone or
 * something else, and reaping it would destroy that handoff.
 */
const REAPABLE_STATUSES: readonly TaskStatus[] = ["assigned", "in_progress"];

export interface CreateTaskInput {
	title: string;
	body: string;
	createdBy: string;
	labels?: string[];
	priority?: number;
	dependsOn?: string[];
	budget?: TaskBudget;
	assignee?: string;
}

export class DependencyCycleError extends Error {
	readonly cycle: string[];

	constructor(cycle: string[]) {
		super(`dependency cycle: ${cycle.join(" -> ")}`);
		this.name = "DependencyCycleError";
		this.cycle = cycle;
	}
}

export class TaskBoard {
	private readonly store: WorkspaceStore;

	constructor(store: WorkspaceStore) {
		this.store = store;
	}

	/**
	 * Create a task. Rejects unknown dependencies and any dependency cycle at write time, so a
	 * bad DAG can never enter the store and wedge the scheduler later.
	 */
	create(input: CreateTaskInput): Task {
		const id = `task_${randomUUID().slice(0, 8)}`;
		const dependsOn = [...new Set(input.dependsOn ?? [])];
		for (const dependency of dependsOn) {
			if (!this.store.readTask(dependency)) throw new Error(`unknown dependency: ${dependency}`);
		}
		const now = new Date().toISOString();
		const task: Task = {
			id,
			title: input.title,
			body: input.body,
			createdBy: input.createdBy,
			status: dependsOn.length > 0 ? "proposed" : (input.assignee ? "assigned" : "queued"),
			assignee: input.assignee,
			priority: input.priority ?? 100,
			dependsOn,
			blocks: [],
			labels: input.labels ?? [],
			artifacts: [],
			reviews: [],
			budget: input.budget,
			spent: { ...EMPTY_SPENT },
			history: [],
			seq: this.store.nextSequence(),
			createdAt: now,
			updatedAt: now,
		};
		// Would adding this edge create a cycle?
		const cycle = findCycleWithEdge(this.store.listTasks(), task);
		if (cycle) throw new DependencyCycleError(cycle);

		this.store.writeTask(task);
		for (const dependency of dependsOn) this.recomputeBlocks(dependency);
		this.store.appendLedger({ kind: "task.created", taskId: id, title: task.title, by: input.createdBy });
		return task;
	}

	get(taskId: string): Task | undefined {
		return this.store.readTask(taskId);
	}

	require(taskId: string): Task {
		const task = this.store.readTask(taskId);
		if (!task) throw new Error(`unknown task: ${taskId}`);
		return task;
	}

	list(): Task[] {
		return this.store.listTasks();
	}

	/** Tasks whose dependencies are all done, ordered by priority then age. */
	ready(): Task[] {
		return this.list().filter(
			(task) =>
				(task.status === "queued" || task.status === "proposed") &&
				this.dependenciesSatisfied(task),
		);
	}

	dependenciesSatisfied(task: Task): boolean {
		return task.dependsOn.every((id) => this.store.readTask(id)?.status === "done");
	}

	transition(
		taskId: string,
		to: TaskStatus,
		by: string,
		options: { note?: string; assignee?: string; skipTransitionCheck?: boolean } = {},
	): Task {
		const task = this.require(taskId);
		if (!options.skipTransitionCheck) assertTransition(task.status, to);
		const entry: TaskHistoryEntry = {
			at: new Date().toISOString(),
			by,
			from: task.status,
			to,
			note: options.note,
		};
		const next: Task = {
			...task,
			status: to,
			assignee: options.assignee ?? task.assignee,
			history: [...task.history, entry],
			seq: this.store.nextSequence(),
			updatedAt: entry.at,
		};
		// A completed or cancelled task frees everything waiting on it.
		if (to === "done" || to === "cancelled") {
			next.lease = undefined;
		}
		this.store.writeTask(next);
		for (const blocked of next.blocks) this.recomputeBlocks(blocked);
		this.store.appendLedger({
			kind: "task.transition",
			taskId,
			from: task.status,
			to,
			by,
			note: options.note,
		});
		return next;
	}

	setPriority(taskId: string, priority: number, by: string, reason?: string): Task {
		const task = this.require(taskId);
		const next: Task = {
			...task,
			priority,
			priorityReason: reason,
			seq: this.store.nextSequence(),
			updatedAt: new Date().toISOString(),
		};
		this.store.writeTask(next);
		this.store.writeDecision("priority.changed", by, `${taskId} -> ${priority}${reason ? ` (${reason})` : ""}`, {
			taskId,
			priority,
			reason,
		});
		return next;
	}

	/**
	 * Take a lease. Leases are what make crash recovery safe without consensus (PLAN.md §6.3):
	 * an expired lease means the holder is gone, so the task can be re-queued.
	 */
	claim(taskId: string, instanceId: string, leaseMs: number): Task {
		const task = this.require(taskId);
		const now = Date.now();
		const existing = task.lease;
		if (existing && existing.holder !== instanceId && new Date(existing.expiresAt).getTime() > now) {
			throw new Error(`task ${taskId} is leased by ${existing.holder} until ${existing.expiresAt}`);
		}
		if (!this.dependenciesSatisfied(task)) {
			throw new Error(`task ${taskId} has unsatisfied dependencies: ${task.dependsOn.join(", ")}`);
		}
		const next: Task = {
			...task,
			assignee: instanceId,
			lease: { holder: instanceId, expiresAt: new Date(now + leaseMs).toISOString() },
			seq: this.store.nextSequence(),
			updatedAt: new Date().toISOString(),
		};
		if (next.status === "queued" || next.status === "proposed") {
			next.status = "assigned";
			next.history = [
				...next.history,
				{ at: next.updatedAt, by: instanceId, from: task.status, to: "assigned", note: "claimed" },
			];
		}
		this.store.writeTask(next);
		this.store.appendLedger({ kind: "task.claimed", taskId, by: instanceId });
		return next;
	}

	renewLease(taskId: string, instanceId: string, leaseMs: number): Task | undefined {
		const task = this.store.readTask(taskId);
		if (!task || task.lease?.holder !== instanceId) return undefined;
		const next: Task = {
			...task,
			lease: { holder: instanceId, expiresAt: new Date(Date.now() + leaseMs).toISOString() },
			updatedAt: new Date().toISOString(),
		};
		this.store.writeTask(next);
		return next;
	}

	/**
	 * Reap expired leases so orphaned work returns to the queue.
	 *
	 * Only `assigned` and `in_progress` are reapable. A task in `in_review` is waiting on a
	 * *reviewer*, not on its lease holder, so reaping it would silently cancel the review handoff
	 * and put the task back in the queue while a reviewer is mid-read. Same for `blocked` (waiting
	 * on a human or a dependency) and the terminal states. Found by running the fleet: an
	 * `in_review` task was requeued 65 minutes later and the review was orphaned.
	 */
	reapExpiredLeases(): Task[] {
		const now = Date.now();
		const reaped: Task[] = [];
		for (const task of this.list()) {
			if (!task.lease) continue;
			if (new Date(task.lease.expiresAt).getTime() > now) continue;
			if (!REAPABLE_STATUSES.includes(task.status)) continue;
			const next: Task = {
				...task,
				lease: undefined,
				status: "queued",
				assignee: undefined,
				history: [
					...task.history,
					{
						at: new Date().toISOString(),
						by: "daemon",
						from: task.status,
						to: "queued" as TaskStatus,
						note: `lease expired (holder ${task.lease.holder})`,
					},
				],
				seq: this.store.nextSequence(),
				updatedAt: new Date().toISOString(),
			};
			this.store.writeTask(next);
			this.store.appendLedger({ kind: "task.lease_reaped", taskId: task.id, holder: task.lease.holder });
			reaped.push(next);
		}
		return reaped;
	}

	addSpent(taskId: string, delta: Partial<TaskSpent>): Task | undefined {
		const task = this.store.readTask(taskId);
		if (!task) return undefined;
		const spent: TaskSpent = {
			tokens: task.spent.tokens + (delta.tokens ?? 0),
			costUsd: task.spent.costUsd + (delta.costUsd ?? 0),
			wallMs: task.spent.wallMs + (delta.wallMs ?? 0),
			turns: task.spent.turns + (delta.turns ?? 0),
		};
		const next: Task = { ...task, spent, updatedAt: new Date().toISOString() };
		this.store.writeTask(next);
		return next;
	}

	/** Budget exceeded? Checked by the daemon, never by the model (PLAN.md §5.2). */
	budgetExceeded(task: Task): { exceeded: boolean; reason?: string } {
		const budget = task.budget;
		if (!budget) return { exceeded: false };
		if (budget.tokens !== undefined && task.spent.tokens >= budget.tokens) {
			return { exceeded: true, reason: `tokens ${task.spent.tokens} >= ${budget.tokens}` };
		}
		if (budget.costUsd !== undefined && task.spent.costUsd >= budget.costUsd) {
			return { exceeded: true, reason: `cost ${task.spent.costUsd.toFixed(4)} >= ${budget.costUsd}` };
		}
		if (budget.wallMs !== undefined && task.spent.wallMs >= budget.wallMs) {
			return { exceeded: true, reason: `wall ${task.spent.wallMs}ms >= ${budget.wallMs}ms` };
		}
		if (budget.maxTurns !== undefined && task.spent.turns >= budget.maxTurns) {
			return { exceeded: true, reason: `turns ${task.spent.turns} >= ${budget.maxTurns}` };
		}
		return { exceeded: false };
	}

	/** Fraction of the tightest budget dimension consumed, for the dashboard. */
	budgetUsage(task: Task): number {
		const budget = task.budget;
		if (!budget) return 0;
		const ratios: number[] = [];
		if (budget.tokens) ratios.push(task.spent.tokens / budget.tokens);
		if (budget.costUsd) ratios.push(task.spent.costUsd / budget.costUsd);
		if (budget.wallMs) ratios.push(task.spent.wallMs / budget.wallMs);
		if (budget.maxTurns) ratios.push(task.spent.turns / budget.maxTurns);
		return ratios.length > 0 ? Math.max(...ratios) : 0;
	}

	attachReview(taskId: string, reviewId: string): void {
		const task = this.require(taskId);
		if (task.reviews.includes(reviewId)) return;
		this.store.writeTask({
			...task,
			reviews: [...task.reviews, reviewId],
			updatedAt: new Date().toISOString(),
		});
	}

	attachArtifact(taskId: string, artifactId: string): void {
		const task = this.require(taskId);
		if (task.artifacts.includes(artifactId)) return;
		this.store.writeTask({
			...task,
			artifacts: [...task.artifacts, artifactId],
			updatedAt: new Date().toISOString(),
		});
	}

	setMergeState(taskId: string, merge: Task["merge"]): Task {
		const task = this.require(taskId);
		const next = { ...task, merge, updatedAt: new Date().toISOString() };
		this.store.writeTask(next);
		return next;
	}

	private recomputeBlocks(taskId: string): void {
		const tasks = this.list();
		for (const task of tasks) {
			const blocks = tasks.filter((other) => other.dependsOn.includes(task.id)).map((other) => other.id);
			const current = this.store.readTask(task.id);
			if (!current) continue;
			if (JSON.stringify(current.blocks) !== JSON.stringify(blocks)) {
				this.store.writeTask({ ...current, blocks });
			}
		}
	}
}

/**
 * Depth-first cycle detection including the candidate task's new edges.
 * Returns the cycle path, or undefined when the graph stays acyclic.
 */
export function findCycleWithEdge(existing: Task[], candidate: Task): string[] | undefined {
	const edges = new Map<string, string[]>();
	for (const task of existing) edges.set(task.id, task.dependsOn);
	edges.set(candidate.id, candidate.dependsOn);

	const visiting = new Set<string>();
	const done = new Set<string>();
	const path: string[] = [];

	const visit = (id: string): string[] | undefined => {
		if (visiting.has(id)) {
			const start = path.indexOf(id);
			return [...path.slice(start === -1 ? 0 : start), id];
		}
		if (done.has(id)) return undefined;
		visiting.add(id);
		path.push(id);
		for (const next of edges.get(id) ?? []) {
			const cycle = visit(next);
			if (cycle) return cycle;
		}
		path.pop();
		visiting.delete(id);
		done.add(id);
		return undefined;
	};

	for (const id of edges.keys()) {
		const cycle = visit(id);
		if (cycle) return cycle;
	}
	return undefined;
}
