/**
 * MergeLane tests against throwaway git repositories.
 *
 * This is the one component where a bug is irreversible (PLAN.md §6.11), so the matrix here is
 * deliberately the most thorough in the project: the happy path, every precondition that must
 * block a merge, the conflict path, and revert.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MergeLane } from "../src/fleet/merge-lane.ts";
import { TaskBoard } from "../src/store/task-board.ts";
import { WorkspaceStore } from "../src/store/workspace-store.ts";
import { createWorktree, hasUnfinishedOperation } from "../src/fleet/worktree.ts";
import type { InstanceRecord, Task } from "../src/store/types.ts";

interface Fixture {
	root: string;
	store: WorkspaceStore;
	board: TaskBoard;
	lane: MergeLane;
	baseDir: string;
	worktreesDir: string;
	escalations: string[];
	cleanup: () => void;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): string {
	git(cwd, "add", "-A");
	git(cwd, "commit", "-m", message, "--no-verify");
	return git(cwd, "rev-parse", "HEAD");
}

function write(cwd: string, relativePath: string, content: string): void {
	const full = join(cwd, relativePath);
	writeFileSync(full, content, { encoding: "utf8" });
}

function makeFixture(options: { auto?: boolean } = {}): Fixture {
	const root = mkdtempSync(join(tmpdir(), "multy-merge-"));
	const store = new WorkspaceStore(root);
	const board = new TaskBoard(store);
	const baseDir = join(root, "project");
	const worktreesDir = store.paths.worktrees;

	// A base repo with one commit on `main`, configured locally so it needs no global git config.
	execFileSync("git", ["init", "-q", "-b", "main", baseDir]);
	git(baseDir, "config", "user.email", "fleet@test.local");
	git(baseDir, "config", "user.name", "Fleet Test");
	git(baseDir, "config", "commit.gpgsign", "false");
	write(baseDir, "README.md", "# project\n");
	commit(baseDir, "initial");

	const escalations: string[] = [];
	const lane = new MergeLane({
		store,
		board,
		baseDir,
		target: "main",
		worktreesDir,
		auto: options.auto ?? true,
		onEscalate: (reason) => escalations.push(reason),
	});

	store.writeManifest({
		id: "fleet_test",
		createdAt: new Date().toISOString(),
		projectRoot: baseDir,
		piBinary: "pi",
		piVersion: "1.0.0",
		image: "test",
		tmuxBinary: "tmux",
		tmuxSocketName: "test",
		podmanBinary: "podman",
		bridgeSource: "bind",
		bridgeVersion: "0.1.0",
		merge: { auto: true, target: "main", strategy: "rebase-then-no-ff", onConflict: "block-and-repair" },
		defaultTarget: "main",
	});

	return {
		root,
		store,
		board,
		lane,
		baseDir,
		worktreesDir,
		escalations,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function makeInstance(fixture: Fixture, id: string, role: string, model: string): InstanceRecord {
	const instance: InstanceRecord = {
		id,
		role,
		profile: role,
		model,
		containerName: `multy-${id}`,
		agentDir: join(fixture.store.instanceDir(id), "agent"),
		workdir: join(fixture.worktreesDir, id),
		worktreeMode: "private",
		sessionId: id,
		state: "idle",
		token: `token_${id}`,
		createdAt: new Date().toISOString(),
		spent: { tokens: 0, costUsd: 0, wallMs: 0, turns: 0 },
	};
	fixture.store.writeInstance(instance);
	return instance;
}

/** Create a worktree with a real change committed on the author's fleet branch. */
async function authorChange(
	fixture: Fixture,
	instanceId: string,
	relativePath: string,
	content: string,
	commitMessage = "change",
): Promise<string> {
	const path = join(fixture.worktreesDir, instanceId);
	await createWorktree({ baseDir: fixture.baseDir, path, branch: `fleet/${instanceId}`, startPoint: "main" });
	git(path, "config", "user.email", "fleet@test.local");
	git(path, "config", "user.name", "Fleet Test");
	write(path, relativePath, content);
	return commit(path, commitMessage);
}

/** A task in `done` with one approving review from someone other than the author. */
function doneTaskWithApproval(fixture: Fixture, author: string, reviewer: string, title = "work"): Task {
	const task = fixture.board.create({ title, body: "body", createdBy: author, labels: ["code"], assignee: author });
	fixture.board.transition(task.id, "in_progress", author);
	fixture.board.transition(task.id, "in_review", author);
	const reviewId = `rev_${task.id}`;
	fixture.store.writeReview({
		id: reviewId,
		taskId: task.id,
		authorInstanceId: author,
		reviewerInstanceId: reviewer,
		reviewerModel: "google/gemini-3.5-flash",
		verdict: "approve",
		findings: "verified",
		requestedAt: new Date().toISOString(),
		submittedAt: new Date().toISOString(),
		seq: fixture.store.nextSequence(),
	});
	fixture.board.attachReview(task.id, reviewId);
	return fixture.board.transition(task.id, "done", reviewer);
}

// ---------------------------------------------------------------------------

test("happy path: approved work merges as one --no-ff commit", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		const task = doneTaskWithApproval(fixture, "impl", "reviewer");

		const attempts = await fixture.lane.drain();
		assert.equal(attempts.length, 1);
		assert.equal(attempts[0]?.outcome, "merged", JSON.stringify(attempts[0]));
		assert.ok(existsSync(join(fixture.baseDir, "feature.txt")), "the change reached the base checkout");
		assert.equal(readFileSync(join(fixture.baseDir, "feature.txt"), "utf8"), "hello\n");

		const merged = fixture.board.require(task.id);
		assert.equal(merged.merge?.state, "merged");
		assert.ok(merged.merge?.mergeSha);
		assert.ok(merged.merge?.preMergeSha);

		// --no-ff is not cosmetic: it is what makes one task == one revertable commit.
		const parents = git(fixture.baseDir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
		assert.equal(parents.length, 3, `expected a merge commit with two parents, got ${parents.length - 1}`);
		assert.match(git(fixture.baseDir, "log", "-1", "--format=%s"), new RegExp(`fleet\\(${task.id}\\)`));
	} finally {
		fixture.cleanup();
	}
});

test("revert undoes exactly one merge", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		const task = doneTaskWithApproval(fixture, "impl", "reviewer");
		await fixture.lane.drain();
		assert.ok(existsSync(join(fixture.baseDir, "feature.txt")));

		const result = await fixture.lane.revert(task.id, "operator");
		assert.equal(result.ok, true, result.reason);
		assert.ok(!existsSync(join(fixture.baseDir, "feature.txt")), "the file should be gone after revert");
		assert.equal(fixture.board.require(task.id).merge?.state, "reverted");
	} finally {
		fixture.cleanup();
	}
});

test("conflict: aborts cleanly, blocks the task, creates a repair task", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "impl2", "implementer", "deepseek/deepseek-v4-pro");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");

		// Two authors change the same line on separate branches; the first merge wins and the
		// second must conflict.
		await authorChange(fixture, "impl", "shared.txt", "from impl\n");
		await authorChange(fixture, "impl2", "shared.txt", "from impl2\n");

		const first = doneTaskWithApproval(fixture, "impl", "reviewer", "first");
		const second = doneTaskWithApproval(fixture, "impl2", "reviewer", "second");

		const attempts = await fixture.lane.drain();
		const outcomes = attempts.map((attempt) => attempt.outcome);
		assert.ok(outcomes.includes("merged"), `expected one merge, got ${JSON.stringify(outcomes)}`);
		assert.ok(outcomes.includes("conflict"), `expected one conflict, got ${JSON.stringify(outcomes)}`);

		const conflicted = attempts.find((attempt) => attempt.outcome === "conflict");
		const conflictedTask = fixture.board.require(conflicted?.taskId ?? "");
		assert.equal(conflictedTask.status, "blocked", "a conflicting task is blocked, never force-merged");
		assert.equal(conflictedTask.merge?.state, "conflict");

		// No half-state may survive: this is the property that makes a crash during merge safe.
		assert.equal(await hasUnfinishedOperation(fixture.baseDir), undefined);
		const authorWorktree = join(fixture.worktreesDir, conflictedTask.assignee ?? "");
		assert.equal(await hasUnfinishedOperation(authorWorktree), undefined);

		// The repair task goes back to the ORIGINAL AUTHOR, who owns the worktree and the context.
		const repair = fixture.board.list().find((task) => task.title.startsWith("Resolve merge conflict"));
		assert.ok(repair, "expected a repair task");
		assert.equal(repair?.assignee, conflictedTask.assignee);
		assert.ok(repair?.labels.includes("merge-conflict"));
		// Higher urgency than the task it repairs.
		assert.ok((repair?.priority ?? 999) < (conflictedTask.priority ?? 0));

		assert.ok(fixture.escalations.length > 0, "a conflict must be escalated");
		void first;
		void second;
	} finally {
		fixture.cleanup();
	}
});

test("precondition: unreviewed code task does not merge", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		const task = fixture.board.create({
			title: "no review",
			body: "b",
			createdBy: "impl",
			labels: ["code"],
			assignee: "impl",
		});
		fixture.board.transition(task.id, "in_progress", "impl");
		const done = fixture.board.transition(task.id, "done", "impl");
		const attempts = await fixture.lane.drain();
		assert.equal(attempts[0]?.outcome, "skipped");
		assert.match(attempts[0]?.reason ?? "", /no reviews recorded/);
		assert.ok(existsSync(join(fixture.worktreesDir, "impl", "feature.txt")));
		assert.ok(!existsSync(join(fixture.baseDir, "feature.txt")), "must not reach the base branch");
		void done;
	} finally {
		fixture.cleanup();
	}
});

test("precondition: the author approving their own work does not count", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		const task = fixture.board.create({ title: "self-approved", body: "b", createdBy: "impl", labels: ["code"], assignee: "impl" });
		fixture.board.transition(task.id, "in_progress", "impl");
		fixture.board.transition(task.id, "in_review", "impl");
		const reviewId = `rev_${task.id}`;
		fixture.store.writeReview({
			id: reviewId,
			taskId: task.id,
			authorInstanceId: "impl",
			reviewerInstanceId: "impl",
			verdict: "approve",
			requestedAt: new Date().toISOString(),
			submittedAt: new Date().toISOString(),
			seq: fixture.store.nextSequence(),
		});
		fixture.board.attachReview(task.id, reviewId);
		fixture.board.transition(task.id, "done", "impl");
		const attempts = await fixture.lane.drain();
		assert.equal(attempts[0]?.outcome, "skipped");
		assert.match(attempts[0]?.reason ?? "", /only approval came from the task author/);
		assert.ok(!existsSync(join(fixture.baseDir, "feature.txt")));
	} finally {
		fixture.cleanup();
	}
});

test("precondition: an outstanding request_changes blocks the merge", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		const task = fixture.board.create({ title: "changes requested", body: "b", createdBy: "impl", labels: ["code"], assignee: "impl" });
		fixture.board.transition(task.id, "in_progress", "impl");
		fixture.board.transition(task.id, "in_review", "impl");
		const reviewId = `rev_${task.id}`;
		fixture.store.writeReview({
			id: reviewId,
			taskId: task.id,
			authorInstanceId: "impl",
			reviewerInstanceId: "reviewer",
			verdict: "request_changes",
			findings: "no tests",
			requestedAt: new Date().toISOString(),
			submittedAt: new Date().toISOString(),
			seq: fixture.store.nextSequence(),
		});
		fixture.board.attachReview(task.id, reviewId);
		// Force the status to done without the transition check, to prove the lane itself gates it.
		fixture.store.writeTask({ ...fixture.board.require(task.id), status: "done" });
		const attempts = await fixture.lane.drain();
		assert.equal(attempts[0]?.outcome, "skipped");
		assert.match(attempts[0]?.reason ?? "", /requested changes/);
		assert.ok(!existsSync(join(fixture.baseDir, "feature.txt")));
	} finally {
		fixture.cleanup();
	}
});

test("precondition: THE OPERATOR PROTECTION — dirty base intersecting the merge holds", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "shared.txt", "from impl\n");
		doneTaskWithApproval(fixture, "impl", "reviewer");

		// A human edits the same path in the base checkout and leaves it uncommitted.
		write(fixture.baseDir, "shared.txt", "human work in progress\n");

		const attempts = await fixture.lane.drain();
		assert.equal(attempts[0]?.outcome, "held", JSON.stringify(attempts[0]));
		assert.match(attempts[0]?.reason ?? "", /^base-dirty:shared\.txt/);
		// The human's edit must be untouched — this is the whole point of the precondition.
		assert.equal(readFileSync(join(fixture.baseDir, "shared.txt"), "utf8"), "human work in progress\n");
		assert.ok(fixture.escalations.length > 0, "a held merge must be escalated to a human");
	} finally {
		fixture.cleanup();
	}
});

test("precondition: a dirty base that does NOT intersect still merges", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		doneTaskWithApproval(fixture, "impl", "reviewer");
		// Uncommitted human work in an unrelated file must not stall the fleet.
		write(fixture.baseDir, "notes.txt", "unrelated scratch\n");
		const attempts = await fixture.lane.drain();
		assert.equal(attempts[0]?.outcome, "merged", attempts[0]?.reason);
		assert.ok(existsSync(join(fixture.baseDir, "feature.txt")));
		assert.ok(existsSync(join(fixture.baseDir, "notes.txt")), "the human's scratch file is untouched");
	} finally {
		fixture.cleanup();
	}
});

test("precondition: uncommitted author work is not merged", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "committed\n");
		const task = doneTaskWithApproval(fixture, "impl", "reviewer");
		// Leave a second, uncommitted edit behind.
		write(join(fixture.worktreesDir, "impl"), "feature.txt", "committed\nuncommitted\n");
		const attempts = await fixture.lane.drain();
		assert.equal(attempts[0]?.outcome, "skipped");
		assert.match(attempts[0]?.reason ?? "", /uncommitted changes/);
		void task;
	} finally {
		fixture.cleanup();
	}
});

test("precondition: a dependency must be MERGED, not merely done", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "a.txt", "a\n");

		const parent = fixture.board.create({ title: "parent", body: "b", createdBy: "impl", labels: ["code"], assignee: "impl" });
		const child = fixture.board.create({
			title: "child",
			body: "b",
			createdBy: "impl",
			labels: ["code"],
			assignee: "impl",
			dependsOn: [parent.id],
		});
		const approve = (taskId: string): void => {
			const reviewId = `rev_${taskId}`;
			fixture.store.writeReview({
				id: reviewId,
				taskId,
				authorInstanceId: "impl",
				reviewerInstanceId: "reviewer",
				verdict: "approve",
				requestedAt: new Date().toISOString(),
				submittedAt: new Date().toISOString(),
				seq: fixture.store.nextSequence(),
			});
			fixture.board.attachReview(taskId, reviewId);
		};
		approve(child.id);
		fixture.store.writeTask({ ...fixture.board.require(child.id), status: "done" });

		// Parent still in flight: the child must be refused even though it is approved and done.
		fixture.board.transition(parent.id, "in_progress", "impl");
		let gate = await fixture.lane.checkPreconditions(fixture.board.require(child.id));
		assert.equal(gate.ok, false);
		assert.match("reason" in gate ? (gate.reason ?? "") : "", /dependency .* is in_progress/);

		// Parent done but NOT yet merged: still refused. This is the ordering property that keeps
		// the base branch history consistent with the task DAG.
		fixture.board.transition(parent.id, "done", "impl");
		gate = await fixture.lane.checkPreconditions(fixture.board.require(child.id));
		assert.equal(gate.ok, false);
		assert.match("reason" in gate ? (gate.reason ?? "") : "", /not merged yet/);

		// Once the parent's merge is recorded, the child passes.
		approve(parent.id);
		fixture.board.setMergeState(parent.id, {
			state: "merged",
			branch: "fleet/impl",
			mergeSha: git(fixture.baseDir, "rev-parse", "HEAD"),
			attempts: 1,
		});
		gate = await fixture.lane.checkPreconditions(fixture.board.require(child.id));
		assert.equal(gate.ok, true, "reason" in gate ? gate.reason : "");
	} finally {
		fixture.cleanup();
	}
});

test("merge.auto=false never integrates anything", async () => {
	const fixture = makeFixture({ auto: false });
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		doneTaskWithApproval(fixture, "impl", "reviewer");
		const attempts = await fixture.lane.drain();
		assert.equal(attempts[0]?.outcome, "skipped");
		assert.match(attempts[0]?.reason ?? "", /merge\.auto is false/);
		assert.ok(!existsSync(join(fixture.baseDir, "feature.txt")));
	} finally {
		fixture.cleanup();
	}
});

test("hold() and resume() act as the emergency brake", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		doneTaskWithApproval(fixture, "impl", "reviewer");

		fixture.lane.hold("operator");
		const held = await fixture.lane.drain();
		assert.equal(held[0]?.outcome, "held");
		assert.ok(!existsSync(join(fixture.baseDir, "feature.txt")));

		fixture.lane.resume("operator");
		const resumed = await fixture.lane.drain();
		assert.equal(resumed[0]?.outcome, "merged", resumed[0]?.reason);
	} finally {
		fixture.cleanup();
	}
});

test("every merge writes an auditable decision naming the approving reviews and models", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		const task = doneTaskWithApproval(fixture, "impl", "reviewer");
		await fixture.lane.drain();
		const decisions = readdirSync(fixture.store.paths.decisions)
			.map((name) => JSON.parse(readFileSync(join(fixture.store.paths.decisions, name), "utf8")) as Record<string, unknown>)
			.filter((decision) => decision.kind === "merge.merged");
		assert.equal(decisions.length, 1);
		const detail = decisions[0]?.detail as { taskId: string; reviews: Array<{ verdict?: string; model?: string }> };
		assert.equal(detail.taskId, task.id);
		assert.equal(detail.reviews[0]?.verdict, "approve");
		assert.equal(detail.reviews[0]?.model, "google/gemini-3.5-flash");
	} finally {
		fixture.cleanup();
	}
});

test("a stale merge lock is reclaimed, a fresh one is respected", async () => {
	const fixture = makeFixture();
	try {
		makeInstance(fixture, "impl", "implementer", "moonshotai/kimi-k2.7-code");
		makeInstance(fixture, "reviewer", "reviewer", "google/gemini-3.5-flash");
		await authorChange(fixture, "impl", "feature.txt", "hello\n");
		doneTaskWithApproval(fixture, "impl", "reviewer");

		const lockPath = join(fixture.store.paths.run, "merge.lock");
		// A lock written just now looks live, so the lane must back off.
		writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
		const blocked = await fixture.lane.drain();
		assert.equal(blocked[0]?.outcome, "skipped");
		assert.match(blocked[0]?.reason ?? "", /merge lock held/);

		// A lock from ten minutes ago is abandoned (daemon crashed mid-merge) and must be reclaimed,
		// otherwise the fleet wedges forever.
		writeFileSync(
			lockPath,
			`${JSON.stringify({ pid: 999999, at: new Date(Date.now() - 10 * 60_000).toISOString() })}\n`,
		);
		const reclaimed = await fixture.lane.drain();
		assert.equal(reclaimed[0]?.outcome, "merged", reclaimed[0]?.reason);
		assert.ok(!existsSync(lockPath), "the lock is released after the merge");
	} finally {
		fixture.cleanup();
	}
});
