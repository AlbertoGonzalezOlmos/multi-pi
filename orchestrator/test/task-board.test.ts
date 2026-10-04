/**
 * TaskBoard tests: transitions, dependency cycles, leases, budgets.
 *
 * Pure store logic — no processes, containers or git. This is the layer that must be
 * deterministic and race-free, because the parent model is deliberately not allowed to own it
 * (PLAN.md §2.5).
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskBoard, canTransition, assertTransition, DependencyCycleError, findCycleWithEdge } from "../src/store/task-board.ts";
import { reviewQuorumMet } from "../src/bus/daemon.ts";
import { WorkspaceStore } from "../src/store/workspace-store.ts";
import type { TaskStatus } from "../src/bus/protocol.ts";

function makeBoard(): { board: TaskBoard; store: WorkspaceStore; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "multy-board-"));
	const store = new WorkspaceStore(dir);
	return { board: new TaskBoard(store), store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("atomic writes leave no temp files behind", () => {
	const { store, cleanup } = makeBoard();
	try {
		store.writeTask({
			id: "task_x",
			title: "t",
			body: "b",
			createdBy: "test",
			status: "queued",
			priority: 1,
			dependsOn: [],
			blocks: [],
			labels: [],
			artifacts: [],
			reviews: [],
			spent: { tokens: 0, costUsd: 0, wallMs: 0, turns: 0 },
			history: [],
			seq: 1,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		const files = readdirSync(store.paths.tasks);
		assert.deepEqual(files, ["task_x.json"], "only the final document should exist");
	} finally {
		cleanup();
	}
});

test("sequence numbers are strictly monotonic", () => {
	const { store, cleanup } = makeBoard();
	try {
		const seen = new Set<number>();
		for (let index = 0; index < 50; index += 1) {
			const value = store.nextSequence();
			assert.ok(!seen.has(value), `duplicate sequence ${value}`);
			seen.add(value);
		}
		assert.equal(Math.max(...seen) - Math.min(...seen), 49);
	} finally {
		cleanup();
	}
});

test("sequence survives a store reopen", () => {
	const dir = mkdtempSync(join(tmpdir(), "multy-seq-"));
	try {
		const first = new WorkspaceStore(dir);
		const before = first.nextSequence();
		const second = new WorkspaceStore(dir);
		const after = second.nextSequence();
		assert.ok(after > before, `expected ${after} > ${before}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("create rejects an unknown dependency", () => {
	const { board, cleanup } = makeBoard();
	try {
		assert.throws(
			() => board.create({ title: "t", body: "b", createdBy: "test", dependsOn: ["task_nope"] }),
			/unknown dependency/,
		);
	} finally {
		cleanup();
	}
});

test("a dependency chain is allowed; only a back-edge is a cycle", () => {
	const { board, cleanup } = makeBoard();
	try {
		const a = board.create({ title: "a", body: "b", createdBy: "test" });
		const b = board.create({ title: "b", body: "b", createdBy: "test", dependsOn: [a.id] });
		// a <- b <- c is a chain and must be accepted.
		const c = board.create({ title: "c", body: "b", createdBy: "test", dependsOn: [b.id] });
		assert.deepEqual(c.dependsOn, [b.id]);
		// blocks[] is the derived inverse, so a now knows b waits on it.
		assert.ok(board.require(a.id).blocks.includes(b.id));
	} finally {
		cleanup();
	}
});

test("a task listing an existing dependency cannot depend on itself", () => {
	const { board, cleanup } = makeBoard();
	try {
		const a = board.create({ title: "a", body: "b", createdBy: "test" });
		// create() generates the id internally, so a self-edge is not expressible; the guard is
		// exercised directly through findCycleWithEdge (tested above). What IS expressible, and
		// must be rejected, is depending on a task that does not exist.
		assert.throws(
			() => board.create({ title: "bad", body: "b", createdBy: "test", dependsOn: [a.id, "task_missing"] }),
			/unknown dependency: task_missing/,
		);
		// Duplicate dependencies are de-duplicated rather than stored twice.
		const duplicated = board.create({ title: "dup", body: "b", createdBy: "test", dependsOn: [a.id, a.id] });
		assert.deepEqual(duplicated.dependsOn, [a.id]);
	} finally {
		cleanup();
	}
});

test("findCycleWithEdge detects a direct self-dependency", () => {
	const candidate = {
		id: "task_a",
		dependsOn: ["task_a"],
	} as never;
	const cycle = findCycleWithEdge([], candidate);
	assert.ok(cycle, "expected a cycle");
	assert.ok(cycle?.includes("task_a"));
});

test("findCycleWithEdge detects a two-node cycle", () => {
	const existing = [{ id: "task_a", dependsOn: ["task_b"] }] as never;
	const candidate = { id: "task_b", dependsOn: ["task_a"] } as never;
	const cycle = findCycleWithEdge(existing, candidate);
	assert.ok(cycle, "expected a cycle");
	assert.equal(cycle?.length, 3, "cycle path repeats the entry node");
});

test("findCycleWithEdge returns undefined for a plain chain", () => {
	const existing = [
		{ id: "task_a", dependsOn: [] },
		{ id: "task_b", dependsOn: ["task_a"] },
	] as never;
	assert.equal(findCycleWithEdge(existing, { id: "task_c", dependsOn: ["task_b"] } as never), undefined);
});

test("legal and illegal transitions", () => {
	assert.ok(canTransition("queued", "assigned"));
	assert.ok(canTransition("in_progress", "in_review"));
	assert.ok(canTransition("in_review", "changes_requested"));
	// done is NOT terminal: the merge lane may block it on conflict (§3.8).
	assert.ok(canTransition("done", "blocked"));
	assert.ok(!canTransition("queued", "done"), "cannot skip straight to done");
	assert.ok(!canTransition("cancelled", "queued"), "cancelled is terminal");
	assert.ok(!canTransition("proposed", "in_review"));
	assertThrowsTransition("queued", "done");
	assertThrowsTransition("cancelled", "queued");
});

function assertThrowsTransition(from: TaskStatus, to: TaskStatus): void {
	assert.throws(() => assertTransition(from, to), /illegal task transition/);
}

test("transition records history and updates seq", () => {
	const { board, cleanup } = makeBoard();
	try {
		const task = board.create({ title: "t", body: "b", createdBy: "test" });
		const next = board.transition(task.id, "assigned", "impl", { note: "picked up" });
		assert.equal(next.status, "assigned");
		assert.equal(next.history.length, 1);
		assert.equal(next.history[0]?.note, "picked up");
		assert.ok(next.seq > task.seq);
	} finally {
		cleanup();
	}
});

test("ready() only returns tasks whose dependencies are done", () => {
	const { board, cleanup } = makeBoard();
	try {
		const first = board.create({ title: "first", body: "b", createdBy: "test" });
		board.create({ title: "second", body: "b", createdBy: "test", dependsOn: [first.id] });
		const readyNow = board.ready().map((task) => task.title);
		assert.deepEqual(readyNow, ["first"]);
		board.transition(first.id, "assigned", "impl");
		board.transition(first.id, "in_progress", "impl");
		board.transition(first.id, "done", "impl");
		assert.deepEqual(board.ready().map((task) => task.title), ["second"]);
	} finally {
		cleanup();
	}
});

test("claim takes a lease and blocks a second claimant", () => {
	const { board, cleanup } = makeBoard();
	try {
		const task = board.create({ title: "t", body: "b", createdBy: "test" });
		const claimed = board.claim(task.id, "impl", 60_000);
		assert.equal(claimed.assignee, "impl");
		assert.equal(claimed.status, "assigned");
		assert.ok(claimed.lease);
		assert.throws(() => board.claim(task.id, "impl2", 60_000), /leased by impl/);
		// The same holder may re-claim idempotently.
		assert.equal(board.claim(task.id, "impl", 60_000).assignee, "impl");
	} finally {
		cleanup();
	}
});

test("an expired lease can be taken over", () => {
	const { board, cleanup } = makeBoard();
	try {
		const task = board.create({ title: "t", body: "b", createdBy: "test" });
		board.claim(task.id, "impl", -1);
		assert.equal(board.claim(task.id, "impl2", 60_000).assignee, "impl2");
	} finally {
		cleanup();
	}
});

test("reapExpiredLeases requeues orphaned work", () => {
	const { board, cleanup } = makeBoard();
	try {
		const task = board.create({ title: "t", body: "b", createdBy: "test" });
		board.claim(task.id, "impl", -1);
		board.transition(task.id, "in_progress", "impl");
		const reaped = board.reapExpiredLeases();
		assert.equal(reaped.length, 1);
		assert.equal(reaped[0]?.status, "queued");
		assert.equal(reaped[0]?.assignee, undefined);
		assert.equal(reaped[0]?.lease, undefined);
	} finally {
		cleanup();
	}
});

test("REGRESSION: a task in_review is NOT reaped when its lease expires", () => {
	// Found by running the fleet: the implementer moved its task to in_review, the 10-minute lease
	// lapsed while the reviewer was reading, and the reaper put the task back in the queue —
	// silently orphaning the review that the daemon had already routed.
	const { board, store, cleanup } = makeBoard();
	try {
		const task = board.create({ title: "t", body: "b", createdBy: "impl" });
		board.claim(task.id, "impl", -1);
		board.transition(task.id, "in_progress", "impl");
		board.transition(task.id, "in_review", "impl");

		const reaped = board.reapExpiredLeases();
		assert.deepEqual(reaped, [], "in_review is waiting on a reviewer, not on its lease holder");
		const after = board.require(task.id);
		assert.equal(after.status, "in_review");
		assert.equal(after.assignee, "impl", "the author must stay recorded so request_changes routes back");

		// The same holds for blocked, and for the terminal states.
		for (const status of ["blocked", "done", "cancelled"] as const) {
			const other = board.create({ title: `t-${status}`, body: "b", createdBy: "impl" });
			board.claim(other.id, "impl", -1);
			store.writeTask({ ...board.require(other.id), status });
			assert.deepEqual(board.reapExpiredLeases(), [], `${status} must not be reaped`);
			assert.equal(board.require(other.id).status, status);
		}

		// And an actively-held task IS still reaped, or crash recovery stops working.
		const live = board.create({ title: "live", body: "b", createdBy: "impl" });
		board.claim(live.id, "impl", -1);
		board.transition(live.id, "in_progress", "impl");
		assert.equal(board.reapExpiredLeases().length, 1);
	} finally {
		cleanup();
	}
});

test("budget accounting and overrun detection", () => {
	const { board, cleanup } = makeBoard();
	try {
		const task = board.create({
			title: "t",
			body: "b",
			createdBy: "test",
			budget: { tokens: 1000, costUsd: 1, maxTurns: 5 },
		});
		board.addSpent(task.id, { tokens: 500, costUsd: 0.25, turns: 2 });
		const half = board.require(task.id);
		assert.equal(board.budgetExceeded(half).exceeded, false);
		assert.equal(board.budgetUsage(half), 0.5);
		board.addSpent(task.id, { tokens: 600, costUsd: 0.1, turns: 1 });
		const over = board.require(task.id);
		const result = board.budgetExceeded(over);
		assert.equal(result.exceeded, true);
		assert.match(result.reason ?? "", /tokens/);
		assert.ok(board.budgetUsage(over) >= 1);
	} finally {
		cleanup();
	}
});

test("priority changes are recorded as decisions", () => {
	const { board, store, cleanup } = makeBoard();
	try {
		const task = board.create({ title: "t", body: "b", createdBy: "test", priority: 100 });
		board.setPriority(task.id, 5, "parent", "blocks three other tasks");
		assert.equal(board.require(task.id).priority, 5);
		assert.equal(board.require(task.id).priorityReason, "blocks three other tasks");
		assert.ok(readdirSync(store.paths.decisions).some((name) => name.includes("dec_")));
	} finally {
		cleanup();
	}
});

test("inbox put/list/remove round-trips per instance", () => {
	const { store, cleanup } = makeBoard();
	try {
		const message = {
			id: "msg_1",
			seq: store.nextSequence(),
			from: "a",
			to: "b",
			kind: "info" as const,
			body: "hello",
			artifacts: [],
			requiresAck: true,
			ackedBy: [],
			postedAt: new Date().toISOString(),
			hops: 0,
		};
		store.inboxPut("b", message);
		assert.equal(store.inboxList("b").length, 1);
		assert.equal(store.inboxList("a").length, 0, "inbox is per recipient");
		assert.equal(store.inboxRemove("b", "msg_1"), true);
		assert.equal(store.inboxList("b").length, 0);
		assert.equal(store.inboxRemove("b", "msg_1"), false, "second ack is a no-op");
	} finally {
		cleanup();
	}
});

test("messages are ordered by sequence regardless of filename sort", () => {
	const { store, cleanup } = makeBoard();
	try {
		for (const body of ["first", "second", "third"]) {
			store.writeMessage({
				id: `msg_${body}`,
				seq: store.nextSequence(),
				from: "a",
				to: "b",
				kind: "info",
				body,
				artifacts: [],
				requiresAck: false,
				ackedBy: [],
				postedAt: new Date().toISOString(),
				hops: 0,
			});
		}
		assert.deepEqual(store.listMessages().map((message) => message.body), ["first", "second", "third"]);
		assert.deepEqual(store.listMessages(1).map((message) => message.body), ["second", "third"]);
	} finally {
		cleanup();
	}
});

test("a torn trailing ledger line is dropped, not fatal", () => {
	const { store, cleanup } = makeBoard();
	try {
		store.appendLedger({ kind: "a" });
		store.appendLedger({ kind: "b" });
		appendFileSync(store.paths.ledger, '{"kind":"torn');
		const entries = store.readLedger();
		assert.deepEqual(entries.map((entry) => entry.kind), ["a", "b"]);
	} finally {
		cleanup();
	}
});

test("DependencyCycleError carries the cycle path", () => {
	const error = new DependencyCycleError(["a", "b", "a"]);
	assert.equal(error.name, "DependencyCycleError");
	assert.deepEqual(error.cycle, ["a", "b", "a"]);
	assert.match(error.message, /a -> b -> a/);
});

// ---------------------------------------------------------------------------
// Review quorum routing (src/bus/daemon.ts reviewQuorumMet)
//
// This is the step that moves a task from in_review to done so the merge lane can see it.
// Found missing by running the fleet: a review was approved and nothing happened for ten minutes.
// ---------------------------------------------------------------------------

test("reviewQuorumMet routing rules", () => {
	const review = (verdict: string | undefined, reviewer = "reviewer") =>
		({ id: `r_${reviewer}_${verdict}`, verdict, reviewerInstanceId: reviewer }) as never;

	// No reviews at all.
	assert.equal(reviewQuorumMet([], "impl").met, false);

	// Still pending.
	assert.equal(reviewQuorumMet([review("approve"), review(undefined, "r2")], "impl").met, false);

	// A single change request blocks even alongside an approval.
	const blocked = reviewQuorumMet([review("approve"), review("request_changes", "r2")], "impl");
	assert.equal(blocked.met, false);
	assert.match(blocked.reason, /requested changes/);

	// Escalation blocks and is routed to the parent instead.
	assert.equal(reviewQuorumMet([review("escalate", "r2")], "impl").met, false);

	// Self-approval does not count, by creator or by current assignee.
	assert.equal(reviewQuorumMet([review("approve", "impl")], "impl").met, false);
	assert.equal(reviewQuorumMet([review("approve", "impl")], "someone-else", "impl").met, false);

	// A genuine cross-instance approval passes.
	const ok = reviewQuorumMet([review("approve", "reviewer")], "impl");
	assert.equal(ok.met, true);
	assert.match(ok.reason, /reviewer/);

	// Two approvals still pass, and the reason names both.
	const two = reviewQuorumMet([review("approve", "r1"), review("approve", "r2")], "impl");
	assert.equal(two.met, true);
	assert.match(two.reason, /r1, r2/);
});
