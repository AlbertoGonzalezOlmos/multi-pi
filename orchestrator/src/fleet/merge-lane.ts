/**
 * MergeLane — the only component allowed to touch the base branch.
 *
 * Auto-merge is the only irreversible action in the system (PLAN.md §3.8, §6.11), so it is:
 *
 *   serialised    one merge in flight, behind an advisory lock. This gives the base branch a
 *                 total order, which is what makes revert and audit tractable.
 *   host-side     runs in the daemon, never in a container. No model can integrate code, because
 *                 no container is given the base checkout as writable — not even the parent's.
 *   evidence-gated eight preconditions re-checked AT MERGE TIME, not at queue time, because the
 *                 base moves while a task is being reviewed.
 *   revertable    --no-ff, so one task == one merge commit == one `git revert -m 1`.
 *   conflict-safe never auto-resolves. Abort, block, and hand a repair task to the original
 *                 author. A model guessing at a semantic conflict produces a merge that LOOKS
 *                 clean, which is strictly worse than a visible conflict.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TaskBoard } from "../store/task-board.ts";
import type { MergePhase, Task } from "../store/types.ts";
import type { WorkspaceStore } from "../store/workspace-store.ts";
import {
	abortUnfinishedOperation,
	changedFiles,
	currentBranch,
	dirtyPaths,
	git,
	hasUnfinishedOperation,
	headSha,
	isClean,
} from "./worktree.ts";

export interface MergeLaneOptions {
	store: WorkspaceStore;
	board: TaskBoard;
	/** Host path of the base checkout (the integration target). */
	baseDir: string;
	target: string;
	/** Host path of <fleet>/worktrees. */
	worktreesDir: string;
	auto: boolean;
	requireVerifyLabel?: string;
	/** Called when a merge needs human attention (conflict, held). */
	onEscalate?: (reason: string, taskId: string) => void;
}

export interface MergeAttempt {
	taskId: string;
	outcome: "merged" | "conflict" | "held" | "skipped" | "error";
	mergeSha?: string;
	preMergeSha?: string;
	reason?: string;
	conflictingFiles?: string[];
	durationMs: number;
}

const LOCK_STALE_MS = 5 * 60_000;

export class MergeLane {
	private readonly store: WorkspaceStore;
	private readonly board: TaskBoard;
	private readonly baseDir: string;
	private readonly target: string;
	private readonly worktreesDir: string;
	private readonly requireVerifyLabel?: string;
	private readonly onEscalate?: (reason: string, taskId: string) => void;
	private auto: boolean;
	private running = false;
	private held = false;

	constructor(options: MergeLaneOptions) {
		this.store = options.store;
		this.board = options.board;
		this.baseDir = options.baseDir;
		this.target = options.target;
		this.worktreesDir = options.worktreesDir;
		this.auto = options.auto;
		this.requireVerifyLabel = options.requireVerifyLabel;
		this.onEscalate = options.onEscalate;
	}

	get mergesHeld(): boolean {
		return this.held;
	}

	setAuto(auto: boolean): void {
		this.auto = auto;
	}

	hold(by: string): void {
		this.held = true;
		this.store.writeDecision("merge.hold", by, "merge lane paused");
	}

	resume(by: string): void {
		this.held = false;
		this.store.writeDecision("merge.resume", by, "merge lane resumed");
	}

	private get lockPath(): string {
		return join(this.store.paths.run, "merge.lock");
	}

	/**
	 * Advisory lock. proper-lockfile is not a dependency here, so we use an O_EXCL lock file with
	 * a pid and timestamp, and treat anything older than LOCK_STALE_MS as abandoned — the same
	 * stale-window idea pi uses for its own locks (auth-storage.ts:114-155).
	 */
	private acquireLock(): boolean {
		mkdirSync(dirname(this.lockPath), { recursive: true });
		if (existsSync(this.lockPath)) {
			let age = Number.POSITIVE_INFINITY;
			try {
				const parsed = JSON.parse(readFileSync(this.lockPath, "utf8")) as { at?: string };
				if (parsed.at) age = Date.now() - new Date(parsed.at).getTime();
			} catch {
				age = Number.POSITIVE_INFINITY;
			}
			if (age < LOCK_STALE_MS) return false;
			rmSync(this.lockPath, { force: true });
		}
		try {
			writeFileSync(this.lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, {
				flag: "wx",
				mode: 0o600,
			});
			return true;
		} catch {
			return false;
		}
	}

	private releaseLock(): void {
		rmSync(this.lockPath, { force: true });
	}

	/**
	 * Tasks that are done and not yet merged, in priority then age order.
	 *
	 * `held` is retried, not terminal: a hold means "a human must act first" (dirty base, budget
	 * exhausted, brake applied), and once they do, the merge should proceed on its own. Excluding
	 * it would wedge the task forever. `conflict` IS excluded — that task is blocked with a repair
	 * task assigned, and retrying it automatically would loop.
	 */
	pending(): Task[] {
		return this.board
			.list()
			.filter(
				(task) =>
					task.status === "done" &&
					(task.merge === undefined ||
						task.merge.state === "pending" ||
						task.merge.state === "held" ||
						task.merge.state === "queued"),
			)
			.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
	}

	/** Drain the queue. Serialised: one merge at a time, always. */
	async drain(): Promise<MergeAttempt[]> {
		if (this.running) return [];
		this.running = true;
		const attempts: MergeAttempt[] = [];
		try {
			// Re-read the queue each pass because a conflict can unblock or block other tasks.
			for (let pass = 0; pass < 64; pass += 1) {
				const next = this.pending()[0];
				if (!next) break;
				attempts.push(await this.attempt(next));
			}
		} finally {
			this.running = false;
		}
		return attempts;
	}

	async attempt(task: Task): Promise<MergeAttempt> {
		const started = Date.now();
		const setPhase = (state: MergePhase, extra: Partial<NonNullable<Task["merge"]>> = {}): void => {
			this.board.setMergeState(task.id, {
				state,
				branch: `fleet/${task.assignee ?? task.id}`,
				attempts: (task.merge?.attempts ?? 0) + 1,
				updatedAt: new Date().toISOString(),
				...extra,
			});
		};

		if (!this.auto) {
			setPhase("pending");
			return { taskId: task.id, outcome: "skipped", reason: "merge.auto is false", durationMs: Date.now() - started };
		}
		if (this.held) {
			setPhase("held", { holdReason: "merge lane held by operator or parent" });
			return { taskId: task.id, outcome: "held", reason: "merge lane held", durationMs: Date.now() - started };
		}


		const gate = await this.checkPreconditions(task);
		if (!gate.ok) {
			if (gate.phase === "held") {
				// `held` tasks are retried every drain (the hold may have been lifted), so escalate
				// only on the EDGE into a new hold reason. Otherwise a dirty base would spam the
				// parent with an identical escalation every tick.
				const previous = task.merge;
				const isNewHold = previous?.state !== "held" || previous.holdReason !== gate.reason;
				setPhase("held", { holdReason: gate.reason });
				if (isNewHold) this.onEscalate?.(gate.reason, task.id);
				return { taskId: task.id, outcome: "held", reason: gate.reason, durationMs: Date.now() - started };
			}
			setPhase("pending");
			return { taskId: task.id, outcome: "skipped", reason: gate.reason, durationMs: Date.now() - started };
		}

		if (!this.acquireLock()) {
			return { taskId: task.id, outcome: "skipped", reason: "merge lock held", durationMs: Date.now() - started };
		}

		const branch = `fleet/${task.assignee ?? task.id}`;
		const worktree = join(this.worktreesDir, task.assignee ?? task.id);
		try {
			// Never proceed on top of a half-finished operation from a previous crash.
			const unfinished = await hasUnfinishedOperation(worktree);
			if (unfinished) await abortUnfinishedOperation(worktree);

			const preMergeSha = await headSha(this.baseDir);
			if (!preMergeSha) {
				setPhase("pending");
				return {
					taskId: task.id,
					outcome: "error",
					reason: "could not resolve base HEAD",
					durationMs: Date.now() - started,
				};
			}

			// Rebase first so conflicts surface before we touch the base.
			const rebase = await git(worktree, ["rebase", this.target], 180_000);
			if (rebase.code !== 0) {
				await abortUnfinishedOperation(worktree);
				return this.handleConflict(task, branch, rebase.stderr || rebase.stdout, started, setPhase);
			}

			const merge = await git(
				this.baseDir,
				["merge", "--no-ff", branch, "-m", `fleet(${task.id}): ${task.title}`],
				180_000,
			);
			if (merge.code !== 0) {
				await abortUnfinishedOperation(this.baseDir);
				return this.handleConflict(task, branch, merge.stderr || merge.stdout, started, setPhase);
			}

			const mergeSha = await headSha(this.baseDir);
			setPhase("merged", { preMergeSha, mergeSha: mergeSha ?? undefined });
			this.store.writeDecision(
				"merge.merged",
				"daemon",
				`${task.id} merged into ${this.target} as ${(mergeSha ?? "?").slice(0, 12)}`,
				{
					taskId: task.id,
					title: task.title,
					branch,
					preMergeSha,
					mergeSha,
					reviews: this.store.listReviews(task.id).map((review) => ({
						id: review.id,
						verdict: review.verdict,
						reviewer: review.reviewerInstanceId,
						model: review.reviewerModel,
					})),
				},
			);
			this.store.appendLedger({ kind: "merge.merged", taskId: task.id, mergeSha, preMergeSha, branch });
			return {
				taskId: task.id,
				outcome: "merged",
				mergeSha: mergeSha ?? undefined,
				preMergeSha,
				durationMs: Date.now() - started,
			};
		} catch (error) {
			await abortUnfinishedOperation(worktree).catch(() => {});
			await abortUnfinishedOperation(this.baseDir).catch(() => {});
			setPhase("pending");
			return {
				taskId: task.id,
				outcome: "error",
				reason: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - started,
			};
		} finally {
			this.releaseLock();
		}
	}

	/**
	 * Conflicts are a normal event in a multi-writer fleet, not an error. Abort so no half-state
	 * survives, block the task, and hand a repair task back to the ORIGINAL AUTHOR — they own the
	 * worktree and the context. Then release the lane so unrelated work keeps flowing.
	 */
	private handleConflict(
		task: Task,
		branch: string,
		detail: string,
		started: number,
		setPhase: (state: MergePhase, extra?: Partial<NonNullable<Task["merge"]>>) => void,
	): MergeAttempt {
		const conflictingFiles = parseConflictFiles(detail);
		setPhase("conflict", { branch, holdReason: "merge conflict" });
		this.board.transition(task.id, "blocked", "daemon", {
			note: `merge conflict on ${branch}: ${conflictingFiles.slice(0, 5).join(", ") || "see ledger"}`,
			skipTransitionCheck: false,
		});
		const repair = this.board.create({
			title: `Resolve merge conflict for ${task.id}`,
			body: [
				`The merge lane could not integrate \`${branch}\` into \`${this.target}\`.`,
				"",
				`Original task: ${task.id} — ${task.title}`,
				"",
				conflictingFiles.length > 0 ? `Conflicting paths:\n${conflictingFiles.map((f) => `- ${f}`).join("\n")}` : "",
				"",
				"Rebase your worktree onto the target, resolve the conflicts deliberately, and mark this task done.",
				"Do not force-push and do not reset the base branch.",
				"",
				"<details><summary>git output</summary>",
				"",
				"```",
				detail.slice(0, 4000),
				"```",
				"</details>",
			]
				.filter((line) => line !== "")
				.join("\n"),
			createdBy: "daemon",
			labels: ["repair", "merge-conflict"],
			priority: Math.max(1, task.priority - 10),
			assignee: task.assignee,
		});
		this.store.writeDecision("merge.conflict", "daemon", `${task.id} conflicted; repair task ${repair.id}`, {
			taskId: task.id,
			branch,
			conflictingFiles,
			repairTaskId: repair.id,
		});
		this.store.appendLedger({ kind: "merge.conflict", taskId: task.id, branch, conflictingFiles, repairTaskId: repair.id });
		this.onEscalate?.(`merge conflict on ${task.id}; repair task ${repair.id} assigned to ${task.assignee ?? "nobody"}`, task.id);
		return {
			taskId: task.id,
			outcome: "conflict",
			reason: "merge conflict",
			conflictingFiles,
			durationMs: Date.now() - started,
		};
	}

	/**
	 * The eight preconditions from PLAN.md §3.8, re-checked at merge time.
	 * `phase: "held"` means a human must act; otherwise the task simply waits.
	 */
	async checkPreconditions(task: Task): Promise<{ ok: true } | { ok: false; reason: string; phase?: "held" }> {
		// 1. status is done (caller guarantees, re-check because the store may have moved).
		const fresh = this.store.readTask(task.id);
		if (!fresh || fresh.status !== "done") return { ok: false, reason: `task status is ${fresh?.status ?? "missing"}, not done` };

		// 2. every review approves; no outstanding change request.
		const reviews = this.store.listReviews(task.id);
		if (reviews.length === 0) {
			// A task with no review requirement (e.g. a spike or a repair task) may merge unreviewed
			// only when it carries no code label; otherwise it must be reviewed.
			if (fresh.labels.includes("code") || fresh.labels.length === 0) {
				return { ok: false, reason: "no reviews recorded; a code task needs at least one approval" };
			}
		}
		for (const review of reviews) {
			if (review.verdict === "request_changes") {
				return { ok: false, reason: `review ${review.id} requested changes` };
			}
			if (review.verdict === undefined) return { ok: false, reason: `review ${review.id} has no verdict yet` };
			if (review.verdict === "escalate") return { ok: false, reason: `review ${review.id} escalated`, phase: "held" };
		}
		const approvals = reviews.filter((review) => review.verdict === "approve");
		if (reviews.length > 0 && approvals.length === 0) return { ok: false, reason: "no approving review" };
		// The author may not be the only approver.
		if (approvals.length > 0 && approvals.every((review) => review.reviewerInstanceId === fresh.createdBy)) {
			return { ok: false, reason: "the only approval came from the task author" };
		}

		// 3. dependencies done AND merged — merge order respects the DAG, not just execution order.
		//    A dependency that is `done` but has NO merge record has not been processed by the lane
		//    yet, so it must block: otherwise a child could land on the base branch before its
		//    parent and the branch history would contradict the task DAG. Tasks with nothing to
		//    integrate are marked `not_applicable` explicitly rather than left undefined.
		for (const dependency of fresh.dependsOn) {
			const parent = this.store.readTask(dependency);
			if (!parent) return { ok: false, reason: `unknown dependency ${dependency}` };
			if (parent.status === "cancelled") continue;
			if (parent.status !== "done") return { ok: false, reason: `dependency ${dependency} is ${parent.status}` };
			const state = parent.merge?.state;
			if (state === "merged" || state === "not_applicable") continue;
			if (state === "reverted") {
				return { ok: false, reason: `dependency ${dependency} was reverted`, phase: "held" };
			}
			return {
				ok: false,
				reason: `dependency ${dependency} is not merged yet (${state ?? "awaiting merge lane"})`,
			};
		}

		// 4. verification label, when the fleet defines one.
		if (this.requireVerifyLabel && fresh.labels.includes(this.requireVerifyLabel)) {
			const verified = this.board
				.list()
				.some(
					(other) =>
						other.id !== fresh.id &&
						other.labels.includes(this.requireVerifyLabel as string) &&
						other.status === "done" &&
						other.merge?.state === "merged",
				);
			if (!verified && fresh.merge?.state !== "merged") {
				return { ok: false, reason: `no merged verification task for label "${this.requireVerifyLabel}"` };
			}
		}

		// 5. author's worktree clean and everything committed on the fleet branch.
		const worktree = join(this.worktreesDir, fresh.assignee ?? fresh.id);
		if (!existsSync(worktree)) return { ok: false, reason: `worktree missing: ${worktree}`, phase: "held" };
		if (!(await isClean(worktree))) {
			const dirty = await dirtyPaths(worktree);
			return {
				ok: false,
				reason: `author worktree has uncommitted changes: ${dirty.slice(0, 5).join(", ")}`,
			};
		}
		const branch = await currentBranch(worktree);
		if (!branch || !branch.startsWith("fleet/")) {
			return { ok: false, reason: `worktree is on "${branch ?? "?"}", expected a fleet/* branch`, phase: "held" };
		}

		// 6. THE OPERATOR PROTECTION. If a human has uncommitted changes in the base checkout that
		//    intersect what this merge touches, hold rather than merge. This is the specific
		//    failure pi's AGENTS.md warns about.
		const baseDirty = await dirtyPaths(this.baseDir);
		if (baseDirty.length > 0) {
			const touched = await changedFiles(this.baseDir, this.target, branch);
			const intersect = baseDirty.filter((path) => touched.includes(path));
			if (intersect.length > 0) {
				return {
					ok: false,
					phase: "held",
					reason: `base-dirty:${intersect.slice(0, 5).join(",")} — the operator has uncommitted changes in files this merge touches`,
				};
			}
		}

		// 7. budget not exceeded.
		const budget = this.board.budgetExceeded(fresh);
		if (budget.exceeded) return { ok: false, reason: `budget exceeded: ${budget.reason}`, phase: "held" };

		// 8. no operator/parent brake.
		if (this.held) return { ok: false, reason: "merge lane held", phase: "held" };

		return { ok: true };
	}

	/**
	 * Undo one merge. Well-defined precisely because merges are serialised and --no-ff: there is
	 * exactly one commit to revert and no ambiguity about what it contained.
	 */
	async revert(taskId: string, by: string): Promise<{ ok: boolean; reason?: string; revertSha?: string }> {
		const task = this.store.readTask(taskId);
		const mergeSha = task?.merge?.mergeSha;
		if (!task || !mergeSha) return { ok: false, reason: `no recorded merge commit for ${taskId}` };
		if (!this.acquireLock()) return { ok: false, reason: "merge lock held; try again shortly" };
		try {
			const before = await headSha(this.baseDir);
			const result = await git(this.baseDir, ["revert", "--no-edit", "-m", "1", mergeSha], 180_000);
			if (result.code !== 0) {
				await abortUnfinishedOperation(this.baseDir);
				return { ok: false, reason: `git revert failed: ${result.stderr.trim() || result.stdout.trim()}` };
			}
			const after = await headSha(this.baseDir);
			this.board.setMergeState(taskId, {
				state: "reverted",
				branch: task.merge?.branch ?? `fleet/${task.assignee ?? taskId}`,
				preMergeSha: task.merge?.preMergeSha,
				mergeSha,
				attempts: (task.merge?.attempts ?? 0) + 1,
				updatedAt: new Date().toISOString(),
			});
			this.store.writeDecision("merge.reverted", by, `${taskId} reverted (${mergeSha.slice(0, 12)})`, {
				taskId,
				mergeSha,
				before,
				after,
			});
			this.store.appendLedger({ kind: "merge.reverted", taskId, mergeSha, by, revertSha: after });
			// Anything that depended on the reverted task is no longer satisfied.
			for (const dependent of this.board.list()) {
				if (!dependent.dependsOn.includes(taskId)) continue;
				if (dependent.status === "done" || dependent.status === "cancelled") continue;
				this.board.transition(dependent.id, "blocked", "daemon", {
					note: `dependency ${taskId} was reverted`,
				});
			}
			return { ok: true, revertSha: after ?? undefined };
		} finally {
			this.releaseLock();
		}
	}
}

function parseConflictFiles(detail: string): string[] {
	const files = new Set<string>();
	for (const match of detail.matchAll(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/gm)) {
		const file = match[1]?.trim();
		if (file) files.add(file);
	}
	for (const match of detail.matchAll(/^Auto-merging (.+)$/gm)) {
		const file = match[1]?.trim();
		if (file) files.add(file);
	}
	return [...files];
}
