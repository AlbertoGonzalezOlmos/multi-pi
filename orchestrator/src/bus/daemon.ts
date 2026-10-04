/**
 * CoordinationBus daemon.
 *
 * One Unix domain socket on the host, bind-mounted into every container at /fleet/run/bus.sock.
 * The store is the source of truth: every mutation is written to disk first and only then
 * broadcast (PLAN.md §2.7), so a bridge that misses an event reconstructs from its inbox on the
 * next `hello`.
 *
 * Security: the socket is shared by all containers, so it is a trust boundary between
 * subharnesses (PLAN.md §6.9). Every connection must present the per-instance token from
 * instance.json (mode 0600) before any request is served.
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { LineAccumulator, parseRecord, serializeRecord } from "./jsonl.ts";
import {
	type BusEvent,
	type BusRecord,
	type FleetSnapshot,
	type HelloPayload,
	type HelloResult,
	type InboxItem,
	type InstanceSummary,
	type MessagePostPayload,
	PROTOCOL_VERSION,
	type ServerEventType,
	type TaskCreatePayload,
	type TaskSummary,
	type TaskUpdatePayload,
	type UsageReportPayload,
	isRecord,
	asString,
	makeId,
} from "./protocol.ts";
import type { BusMessage, InstanceRecord, Review, Task } from "../store/types.ts";
import { TaskBoard } from "../store/task-board.ts";
import type { WorkspaceStore } from "../store/workspace-store.ts";

const DEFAULT_ASK_TIMEOUT_MS = 60_000;
const OPERATOR_INSTANCE_ID = "operator";
/** Lease window. Renewed by every `busy` heartbeat, so it only lapses if the holder goes quiet. */
const LEASE_MS = 10 * 60_000;
const MAX_ASK_TIMEOUT_MS = 600_000;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface BusDaemonOptions {
	store: WorkspaceStore;
	board: TaskBoard;
	socketPath: string;
	fleetId: string;
	/**
	 * Host-only operator token. It lives in <fleet>/run/operator.token (mode 0600) and is never
	 * mounted into a container, so presenting it proves the caller is a host process — i.e. the
	 * operator, not a subharness. Used by `multy post` and `multy inject`.
	 */
	operatorToken?: string;
	/** Notified whenever the daemon wants the fleet manager to act (merge, spawn, escalate). */
	onEvent?: (event: DaemonHook) => void;
}

export type DaemonHook =
	| { type: "task-ready" }
	| { type: "review-needed"; taskId: string }
	| { type: "escalation"; from: string; reason: string; taskId?: string }
	| { type: "instance-connected"; instanceId: string }
	| { type: "instance-disconnected"; instanceId: string };

interface Connection {
	socket: Socket;
	instanceId: string | null;
	accumulator: LineAccumulator;
	authenticated: boolean;
	writable: boolean;
	/** Pending synchronous peer.ask calls originating from this connection. */
	pendingAsks: Map<string, { timer: NodeJS.Timeout; resolve: (value: unknown) => void }>;
}

export class CoordinationBus {
	private readonly store: WorkspaceStore;
	private readonly board: TaskBoard;
	private readonly socketPath: string;
	private readonly fleetId: string;
	private readonly operatorToken: string | undefined;
	private readonly onEvent?: (event: DaemonHook) => void;
	private server: Server | null = null;
	private readonly connections = new Map<string, Connection>();
	private holdMerges = false;

	constructor(options: BusDaemonOptions) {
		this.store = options.store;
		this.board = options.board;
		this.socketPath = options.socketPath;
		this.fleetId = options.fleetId;
		this.operatorToken = options.operatorToken;
		this.onEvent = options.onEvent;
	}

	async start(): Promise<void> {
		if (this.server) return;
		if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
		const server = createServer((socket) => this.handleConnection(socket));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.server = server;
		this.store.appendLedger({ kind: "bus.started", path: this.socketPath });
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		for (const connection of this.connections.values()) {
			for (const ask of connection.pendingAsks.values()) clearTimeout(ask.timer);
			connection.socket.destroy();
		}
		this.connections.clear();
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (existsSync(this.socketPath)) {
			try {
				unlinkSync(this.socketPath);
			} catch {}
		}
		this.store.appendLedger({ kind: "bus.stopped" });
	}

	get connectedInstanceIds(): string[] {
		return [...this.connections.keys()];
	}

	setHoldMerges(hold: boolean, by: string): void {
		this.holdMerges = hold;
		this.store.writeDecision("merge.hold", by, hold ? "merges paused" : "merges resumed");
		this.broadcast("merge.state", { holdMerges: hold });
	}

	get mergesHeld(): boolean {
		return this.holdMerges;
	}

	/** Deliver an inbound message to one instance (or broadcast), persisting to its inbox first. */
	postMessage(input: {
		from: string;
		to: string;
		kind: BusMessage["kind"];
		body: string;
		subject?: string;
		artifacts?: string[];
		requiresAck?: boolean;
		replyTo?: string;
		hops?: number;
	}): BusMessage {
		const body = input.body.length > MAX_BODY_BYTES ? `${input.body.slice(0, MAX_BODY_BYTES)}\n[truncated]` : input.body;
		const seq = this.store.nextSequence();
		const message: BusMessage = {
			id: makeId("msg"),
			seq,
			from: input.from,
			to: input.to,
			kind: input.kind,
			subject: input.subject,
			body,
			artifacts: input.artifacts ?? [],
			requiresAck: input.requiresAck ?? false,
			ackedBy: [],
			replyTo: input.replyTo,
			postedAt: new Date().toISOString(),
			hops: input.hops ?? 0,
		};
		this.store.writeMessage(message);
		for (const recipient of this.resolveRecipients(message.to, message.from)) {
			this.store.inboxPut(recipient, message);
			this.sendEvent(recipient, "message.inbound", toInboxItem(message));
		}
		this.store.appendLedger({
			kind: "message.posted",
			from: message.from,
			to: message.to,
			messageKind: message.kind,
			subject: message.subject,
			seq,
		});
		return message;
	}

	private resolveRecipients(to: string, from: string): string[] {
		if (to === "broadcast") {
			return this.store.listInstances().map((instance) => instance.id).filter((id) => id !== from);
		}
		if (to.startsWith("role:")) {
			const role = to.slice("role:".length);
			return this.store
				.listInstances()
				.filter((instance) => instance.role === role && instance.id !== from)
				.map((instance) => instance.id);
		}
		return [to];
	}

	private snapshot(): FleetSnapshot {
		const instances: InstanceSummary[] = this.store.listInstances().map((instance) => ({
			id: instance.id,
			role: instance.role,
			model: instance.model,
			state: this.connections.has(instance.id) ? instance.state : "stopped",
			currentTaskId: instance.currentTaskId ?? null,
			connected: this.connections.has(instance.id),
		}));
		const openTasks: TaskSummary[] = this.board
			.list()
			.filter((task) => task.status !== "done" && task.status !== "cancelled")
			.map((task) => ({
				id: task.id,
				title: task.title,
				status: task.status,
				priority: task.priority,
				assignee: task.assignee ?? null,
			}));
		return { instances, openTasks, holdMerges: this.holdMerges };
	}

	private handleConnection(socket: Socket): void {
		const connection: Connection = {
			socket,
			instanceId: null,
			accumulator: new LineAccumulator(),
			authenticated: false,
			writable: true,
			pendingAsks: new Map(),
		};
		// Backpressure: stop reading while the kernel buffer is full rather than buffering
		// unboundedly in our own heap. This is the failure mode RpcClient gets wrong
		// (PLAN.md §1.2 item 8).
		socket.on("drain", () => {
			connection.writable = true;
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of connection.accumulator.push(chunk)) this.handleLine(connection, line);
		});
		socket.on("error", () => this.dropConnection(connection));
		socket.on("close", () => this.dropConnection(connection));
	}

	private dropConnection(connection: Connection): void {
		for (const ask of connection.pendingAsks.values()) clearTimeout(ask.timer);
		connection.pendingAsks.clear();
		const instanceId = connection.instanceId;
		if (!instanceId) return;
		if (this.connections.get(instanceId) !== connection) return;
		this.connections.delete(instanceId);
		const instance = this.store.readInstance(instanceId);
		if (instance) {
			this.store.writeInstance({ ...instance, state: "stopped", pid: undefined });
		}
		this.store.appendLedger({ kind: "instance.disconnected", instanceId });
		this.broadcast("peer.left", { instanceId });
		this.onEvent?.({ type: "instance-disconnected", instanceId });
	}

	private write(connection: Connection, record: BusRecord): void {
		if (connection.socket.destroyed) return;
		const ok = connection.socket.write(serializeRecord(record));
		if (!ok) connection.writable = false;
	}

	private sendEvent(instanceId: string, type: ServerEventType, payload: unknown): void {
		const connection = this.connections.get(instanceId);
		if (!connection) return;
		this.write(connection, {
			v: PROTOCOL_VERSION,
			id: makeId("evt"),
			from: "daemon",
			kind: "evt",
			type,
			payload,
		} as BusEvent);
	}

	broadcast(type: ServerEventType, payload: unknown): void {
		for (const instanceId of this.connections.keys()) this.sendEvent(instanceId, type, payload);
	}

	private reply(connection: Connection, id: string, ok: true, payload: unknown): void;
	private reply(connection: Connection, id: string, ok: false, error: string, retryable?: boolean): void;
	private reply(connection: Connection, id: string, ok: boolean, payloadOrError: unknown, retryable?: boolean): void {
		this.write(connection, {
			v: PROTOCOL_VERSION,
			id,
			from: "daemon",
			kind: "res",
			ok,
			...(ok ? { payload: payloadOrError } : { error: String(payloadOrError), retryable }),
		} as BusRecord);
	}

	private handleLine(connection: Connection, line: string): void {
		const record = parseRecord<Record<string, unknown>>(line);
		if (!isRecord(record)) {
			this.reply(connection, "", false, "malformed JSON record");
			return;
		}
		if (record.v !== PROTOCOL_VERSION) {
			this.reply(connection, String(record.id ?? ""), false, `unsupported protocol version: ${String(record.v)}`);
			connection.socket.destroy();
			return;
		}
		if (record.kind === "res") {
			// A response to a peer.ask we forwarded.
			const id = String(record.id ?? "");
			this.resolveAsk(connection, id, record);
			return;
		}
		if (record.kind !== "req") return;
		const id = String(record.id ?? "");
		const type = String(record.type ?? "");
		if (!connection.authenticated && type !== "hello") {
			this.reply(connection, id, false, "not authenticated: send hello first");
			return;
		}
		void this.dispatch(connection, id, type, record.payload).catch((error: unknown) => {
			this.reply(connection, id, false, error instanceof Error ? error.message : String(error));
		});
	}

	private resolveAsk(connection: Connection, id: string, record: Record<string, unknown>): void {
		// peer.ask responses are correlated by the asking connection, so route through the map
		// the asker installed. The daemon keeps no cross-connection promise table.
		for (const other of this.connections.values()) {
			const pending = other.pendingAsks.get(id);
			if (!pending) continue;
			other.pendingAsks.delete(id);
			clearTimeout(pending.timer);
			pending.resolve(record);
			return;
		}
		void connection;
	}

	private async dispatch(
		connection: Connection,
		id: string,
		type: string,
		payload: unknown,
	): Promise<void> {
		const instanceId = connection.instanceId ?? "anonymous";
		switch (type) {
			case "hello": {
				const result = this.handleHello(connection, id, payload);
				if (result) this.onEvent?.({ type: "instance-connected", instanceId: result.instanceId });
				return;
			}
			case "heartbeat": {
				this.touchInstance(instanceId, payload);
				this.reply(connection, id, true, { ok: true });
				return;
			}
			case "state.get": {
				this.reply(connection, id, true, {
					fleetId: this.fleetId,
					sequence: this.store.sequence,
					snapshot: this.snapshot(),
				});
				return;
			}
			case "peer.list": {
				this.reply(connection, id, true, { peers: this.snapshot().instances });
				return;
			}
			case "task.list": {
				const tasks = this.board.list().map(summarizeTask);
				this.reply(connection, id, true, { tasks });
				return;
			}
			case "task.create": {
				const task = this.handleTaskCreate(instanceId, payload);
				this.broadcast("task.changed", { task: summarizeTask(task), reason: "created" });
				this.onEvent?.({ type: "task-ready" });
				this.reply(connection, id, true, { task: summarizeTask(task) });
				return;
			}
			case "task.claim": {
				const requested = payload as { taskId?: string };
				const task = this.board.claim(String(requested?.taskId ?? ""), instanceId, LEASE_MS);
				this.setInstanceTask(instanceId, task.id);
				this.broadcast("task.changed", { task: summarizeTask(task), reason: "claimed" });
				this.reply(connection, id, true, { task: summarizeTask(task) });
				return;
			}
			case "task.update": {
				const task = this.handleTaskUpdate(instanceId, payload);
				this.broadcast("task.changed", { task: summarizeTask(task), reason: "updated" });
				if (task.status === "in_review") this.onEvent?.({ type: "review-needed", taskId: task.id });
				if (task.status === "done") this.onEvent?.({ type: "task-ready" });
				this.reply(connection, id, true, { task: summarizeTask(task) });
				return;
			}
			case "message.post": {
				const message = this.handleMessagePost(instanceId, payload);
				this.reply(connection, id, true, { id: message.id, seq: message.seq });
				return;
			}
			case "message.ack": {
				const requested = payload as { messageId?: string };
				const acked = this.acknowledge(instanceId, String(requested?.messageId ?? ""));
				this.reply(connection, id, true, { acked });
				return;
			}
			case "review.request": {
				const review = this.handleReviewRequest(instanceId, payload);
				this.onEvent?.({ type: "review-needed", taskId: review.taskId });
				this.reply(connection, id, true, { reviewId: review.id });
				return;
			}
			case "review.submit": {
				const review = this.handleReviewSubmit(instanceId, payload);
				this.broadcast("review.verdict", {
					reviewId: review.id,
					taskId: review.taskId,
					verdict: review.verdict,
				});
				this.onEvent?.({ type: "task-ready" });
				this.reply(connection, id, true, { reviewId: review.id, verdict: review.verdict });
				return;
			}
			case "usage.report": {
				this.handleUsageReport(instanceId, payload);
				this.reply(connection, id, true, { ok: true });
				return;
			}
			case "help.request": {
				const request = payload as { reason?: string; taskId?: string; blocked?: boolean };
				const reason = String(request?.reason ?? "unspecified");
				this.postMessage({
					from: instanceId,
					to: "parent",
					kind: "escalation",
					body: reason,
					subject: request?.taskId,
					requiresAck: true,
				});
				this.onEvent?.({ type: "escalation", from: instanceId, reason, taskId: request?.taskId });
				this.reply(connection, id, true, { escalatedTo: "parent" });
				return;
			}
			case "peer.ask": {
				await this.handlePeerAsk(connection, id, payload);
				return;
			}
			case "shutdown.request": {
				this.store.appendLedger({ kind: "shutdown.requested", by: instanceId });
				this.reply(connection, id, true, { accepted: true });
				return;
			}
			default:
				this.reply(connection, id, false, `unknown request type: ${type}`);
		}
	}

	private handleHello(connection: Connection, id: string, payload: unknown): HelloResult | null {
		if (!isRecord(payload)) {
			this.reply(connection, id, false, "hello payload must be an object");
			return null;
		}
		const hello = payload as unknown as HelloPayload;
		const token = String(hello.token ?? "");
		// Operator path: a host process presenting the operator token is registered as the
		// pseudo-instance "operator". It has no instance.json, no container and no budget.
		if (this.operatorToken && token === this.operatorToken) {
			return this.completeHello(connection, id, hello, OPERATOR_INSTANCE_ID);
		}
		// The token is the instance's secret; instance.json is mode 0600 on the host and is NOT
		// mounted into the container, so only the daemon can read it.
		const claimed = this.findInstanceByToken(token);
		if (!claimed) {
			this.reply(connection, id, false, "invalid instance token");
			connection.socket.destroy();
			return null;
		}
		return this.completeHello(connection, id, hello, claimed.id);
	}

	private completeHello(
		connection: Connection,
		id: string,
		hello: HelloPayload,
		instanceId: string,
	): HelloResult | null {
		const existing = this.connections.get(instanceId);
		if (existing && existing !== connection) {
			// Replacement semantics, as in pi's experimental coordinator: the newer connection wins
			// and the older one is closed rather than both being registered.
			existing.socket.destroy();
			this.connections.delete(instanceId);
		}
		connection.instanceId = instanceId;
		connection.authenticated = true;
		this.connections.set(instanceId, connection);

		const claimed = this.store.readInstance(instanceId);
		if (claimed) {
			this.store.writeInstance({
				...claimed,
				pid: hello.pid,
				state: "idle",
				model: hello.model ? `${hello.provider ?? "?"}/${hello.model}` : claimed.model,
				lastHeartbeatAt: new Date().toISOString(),
				lastActivityAt: new Date().toISOString(),
			});
		}

		const inbox = this.store.inboxList(instanceId).map(toInboxItem);
		const result: HelloResult = {
			instanceId,
			fleetId: this.fleetId,
			sequence: this.store.sequence,
			inbox,
			fleetSnapshot: this.snapshot(),
		};
		this.reply(connection, id, true, result);
		this.broadcast("peer.joined", { instanceId, role: claimed?.role ?? hello.role });
		this.store.appendLedger({
			kind: "instance.connected",
			instanceId,
			role: claimed?.role ?? hello.role,
			piVersion: hello.piVersion,
			bridgeSource: hello.bridgeSource,
			bridgeVersion: hello.bridgeVersion,
			inboxDelivered: inbox.length,
		});
		return result;
	}

	private findInstanceByToken(token: string): InstanceRecord | undefined {
		if (!token) return undefined;
		return this.store.listInstances().find((instance) => instance.token === token);
	}

	private touchInstance(instanceId: string, payload: unknown): void {
		const instance = this.store.readInstance(instanceId);
		if (!instance) return;
		const extra = isRecord(payload) ? payload : {};
		const state = extra.busy === true ? "busy" : extra.busy === false ? "idle" : instance.state;
		// pi allows /model at runtime, so the bridge re-reports it; keep the fleet view accurate.
		const model = asString(extra.model);
		const provider = asString(extra.provider);
		const nextModel = model && provider ? `${provider}/${model}` : instance.model;
		const changedModel = nextModel !== instance.model;
		this.store.writeInstance({
			...instance,
			state,
			model: nextModel,
			lastHeartbeatAt: new Date().toISOString(),
		});
		// A live heartbeat is proof the holder is still there, so renew the lease on whatever it is
		// working on. Without this, any task that runs longer than the lease window gets reaped out
		// from under an agent that is doing exactly what it was asked to do.
		if (state === "busy" && instance.currentTaskId) {
			this.board.renewLease(instance.currentTaskId, instanceId, LEASE_MS);
		}
		if (changedModel) {
			this.store.appendLedger({ kind: "instance.model_changed", instanceId, from: instance.model, to: nextModel });
			this.broadcast("fleet.snapshot", this.snapshot());
		}
	}

	private setInstanceTask(instanceId: string, taskId: string | null): void {
		const instance = this.store.readInstance(instanceId);
		if (!instance) return;
		this.store.writeInstance({ ...instance, currentTaskId: taskId ?? undefined });
	}

	private handleTaskCreate(instanceId: string, payload: unknown): Task {
		if (!isRecord(payload)) throw new Error("task.create payload must be an object");
		const input = payload as unknown as TaskCreatePayload;
		if (!input.title || !input.body) throw new Error("task.create requires title and body");
		return this.board.create({
			title: input.title,
			body: input.body,
			createdBy: instanceId,
			labels: input.labels ?? [],
			priority: input.priority,
			dependsOn: input.dependsOn,
			budget: input.budget,
		});
	}

	private handleTaskUpdate(instanceId: string, payload: unknown): Task {
		if (!isRecord(payload)) throw new Error("task.update payload must be an object");
		const input = payload as unknown as TaskUpdatePayload;
		const task = this.board.require(input.taskId);
		if (input.status) {
			if (input.status === "in_progress") this.setInstanceTask(instanceId, task.id);
			if (input.status === "done" || input.status === "cancelled") this.setInstanceTask(instanceId, null);
			return this.board.transition(task.id, input.status, instanceId, { note: input.note });
		}
		if (input.blockedReason) {
			return this.board.transition(task.id, "blocked", instanceId, { note: input.blockedReason });
		}
		return task;
	}

	private handleMessagePost(instanceId: string, payload: unknown): BusMessage {
		if (!isRecord(payload)) throw new Error("message.post payload must be an object");
		const input = payload as unknown as MessagePostPayload;
		if (!input.to || !input.body) throw new Error("message.post requires to and body");
		return this.postMessage({
			from: instanceId,
			to: input.to,
			kind: input.kind ?? "info",
			body: input.body,
			subject: input.subject,
			artifacts: input.artifacts,
			requiresAck: input.requiresAck,
			replyTo: input.replyTo,
		});
	}

	private acknowledge(instanceId: string, messageId: string): boolean {
		const message = this.store.readMessage(messageId);
		if (!message) return false;
		if (!message.ackedBy.includes(instanceId)) {
			this.store.writeMessage({ ...message, ackedBy: [...message.ackedBy, instanceId] });
		}
		this.store.inboxRemove(instanceId, messageId);
		this.store.appendLedger({ kind: "message.acked", messageId, by: instanceId });
		return true;
	}

	private handleReviewRequest(instanceId: string, payload: unknown): Review {
		if (!isRecord(payload)) throw new Error("review.request payload must be an object");
		const input = payload as { taskId?: string; reviewer?: string };
		const task = this.board.require(String(input.taskId ?? ""));
		const review: Review = {
			id: makeId("rev"),
			taskId: task.id,
			authorInstanceId: instanceId,
			reviewerInstanceId: input.reviewer,
			requestedAt: new Date().toISOString(),
			seq: this.store.nextSequence(),
		};
		this.store.writeReview(review);
		this.board.attachReview(task.id, review.id);
		this.store.appendLedger({ kind: "review.requested", reviewId: review.id, taskId: task.id, by: instanceId });
		if (input.reviewer) {
			this.store.inboxPut(input.reviewer, {
				id: review.id,
				seq: review.seq,
				from: instanceId,
				to: input.reviewer,
				kind: "verdict",
				body: `Review requested for task ${task.id}: ${task.title}`,
				artifacts: task.artifacts,
				requiresAck: true,
				ackedBy: [],
				postedAt: review.requestedAt,
				hops: 0,
			});
			this.sendEvent(input.reviewer, "review.inbound", { reviewId: review.id, taskId: task.id });
		}
		return review;
	}

	private handleReviewSubmit(instanceId: string, payload: unknown): Review {
		if (!isRecord(payload)) throw new Error("review.submit payload must be an object");
		const input = payload as { reviewId?: string; verdict?: Review["verdict"]; findings?: string; artifactId?: string };
		const existing = this.store.readReview(String(input.reviewId ?? ""));
		if (!existing) throw new Error(`unknown review: ${String(input.reviewId)}`);
		const verdict = input.verdict;
		if (verdict !== "approve" && verdict !== "request_changes" && verdict !== "escalate") {
			throw new Error(`verdict must be approve|request_changes|escalate, got ${String(verdict)}`);
		}
		const instance = this.store.readInstance(instanceId);
		const review: Review = {
			...existing,
			reviewerInstanceId: instanceId,
			reviewerModel: instance?.model,
			verdict,
			findings: input.findings,
			artifactId: input.artifactId,
			submittedAt: new Date().toISOString(),
		};
		this.store.writeReview(review);
		this.store.appendLedger({
			kind: "review.submitted",
			reviewId: review.id,
			taskId: review.taskId,
			verdict,
			by: instanceId,
			reviewerModel: review.reviewerModel,
		});
		// Notify the author so the change request reaches them even if they are mid-run.
		this.postMessage({
			from: instanceId,
			to: review.authorInstanceId,
			kind: "verdict",
			body: `Review verdict for ${review.taskId}: ${verdict}\n\n${input.findings ?? ""}`,
			subject: review.taskId,
			requiresAck: true,
		});
		// Advance the task now that a verdict is in. Without this the merge lane never sees the
		// task, because it only drains tasks in `done` (PLAN.md §3.4: approve -> quorum met ->
		// task done -> MergeLane). Found by running the fleet: a review was approved and nothing
		// happened for the next ten minutes.
		this.applyReviewOutcome(review.taskId, verdict, instanceId);
		return review;
	}

	/**
	 * Decide what a verdict does to the task.
	 *
	 * `approve` moves it to `done` only when the quorum is satisfied: every requested review has a
	 * verdict, at least one approves, none requested changes or escalated, and the approval did not
	 * come solely from the author. The merge lane re-checks all of this at merge time (§3.8), so
	 * this is the routing decision, not the safety gate.
	 */
	private applyReviewOutcome(taskId: string, verdict: Review["verdict"], by: string): void {
		const task = this.store.readTask(taskId);
		if (!task) return;
		if (verdict === "request_changes") {
			if (task.status === "in_review") {
				this.board.transition(taskId, "changes_requested", by, { note: `review requested changes` });
				this.broadcast("task.changed", { task: summarizeTask(this.store.readTask(taskId) as Task), reason: "changes_requested" });
			}
			return;
		}
		if (verdict === "escalate") {
			this.postMessage({
				from: by,
				to: "parent",
				kind: "escalation",
				body: `A reviewer escalated ${taskId} instead of judging it. Decide whether it should merge.`,
				subject: taskId,
				requiresAck: true,
			});
			return;
		}
		if (verdict !== "approve") return;
		const outcome = reviewQuorumMet(this.store.listReviews(taskId), task.createdBy, task.assignee);
		if (!outcome.met) {
			this.store.appendLedger({ kind: "review.quorum_unmet", taskId, reason: outcome.reason });
			return;
		}
		if (task.status !== "in_review") return;
		const done = this.board.transition(taskId, "done", "daemon", { note: `review quorum met: ${outcome.reason}` });
		this.broadcast("task.changed", { task: summarizeTask(done), reason: "approved" });
		this.store.writeDecision("review.approved", "daemon", `${taskId} approved by ${by}; marked done`, {
			taskId,
			reviewer: by,
			reason: outcome.reason,
		});
		// The merge lane drains on the next tick, and immediately here so the operator sees movement.
		this.onEvent?.({ type: "task-ready" });
	}

	private handleUsageReport(instanceId: string, payload: unknown): void {
		if (!isRecord(payload)) return;
		const usage = payload as unknown as UsageReportPayload;
		const instance = this.store.readInstance(instanceId);
		const cost = usage.cost ?? 0;
		const tokens = (usage.input ?? 0) + (usage.output ?? 0);
		if (instance) {
			this.store.writeInstance({
				...instance,
				lastActivityAt: new Date().toISOString(),
				spent: {
					tokens: instance.spent.tokens + tokens,
					costUsd: instance.spent.costUsd + cost,
					wallMs: instance.spent.wallMs,
					turns: instance.spent.turns + (usage.turns ?? 1),
				},
			});
		}
		if (usage.taskId) {
			this.board.addSpent(usage.taskId, { tokens, costUsd: cost, turns: usage.turns ?? 1 });
		}
		this.store.appendLedger({
			kind: "usage",
			instanceId,
			taskId: usage.taskId,
			input: usage.input,
			output: usage.output,
			cost,
			contextTokens: usage.contextTokens,
		});
	}

	/**
	 * The only synchronous peer-to-peer path. It always has a hard timeout that converts into an
	 * escalation rather than blocking forever — a subharness waiting on a busy peer is the classic
	 * fleet deadlock (PLAN.md §3.2, §6.4).
	 */
	private async handlePeerAsk(connection: Connection, id: string, payload: unknown): Promise<void> {
		if (!isRecord(payload)) {
			this.reply(connection, id, false, "peer.ask payload must be an object");
			return;
		}
		const ask = payload as { to?: string; question?: string; timeoutMs?: number; hops?: number };
		const to = String(ask.to ?? "");
		const hops = Number(ask.hops ?? 0);
		if (hops >= 4) {
			this.reply(connection, id, false, "peer.ask hop limit reached; use help.request to escalate");
			return;
		}
		const target = this.connections.get(to);
		if (!target) {
			// Nobody to ask: escalate to the parent instead of failing silently.
			this.postMessage({
				from: connection.instanceId ?? "unknown",
				to: "parent",
				kind: "escalation",
				body: `peer.ask for "${to}" could not be delivered (not connected). Question: ${String(ask.question ?? "")}`,
				requiresAck: false,
			});
			this.reply(connection, id, false, `peer "${to}" is not connected; escalated to parent`, true);
			return;
		}
		const timeoutMs = Math.min(Math.max(Number(ask.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS), 1000), MAX_ASK_TIMEOUT_MS);
		const askId = makeId("ask");
		const answer = await new Promise<unknown>((resolve) => {
			const timer = setTimeout(() => {
				connection.pendingAsks.delete(askId);
				resolve(undefined);
			}, timeoutMs);
			connection.pendingAsks.set(askId, { timer, resolve });
			this.write(target, {
				v: PROTOCOL_VERSION,
				id: askId,
				from: "daemon",
				kind: "evt",
				type: "peer.ask",
				payload: {
					askId,
					from: connection.instanceId,
					question: ask.question,
					hops: hops + 1,
					timeoutMs,
				},
			} as BusEvent);
		});
		if (answer === undefined) {
			this.postMessage({
				from: connection.instanceId ?? "unknown",
				to: "parent",
				kind: "escalation",
				body: `peer.ask to "${to}" timed out after ${timeoutMs}ms. Question: ${String(ask.question ?? "")}`,
			});
			this.reply(connection, id, false, `peer "${to}" did not answer within ${timeoutMs}ms; escalated to parent`, true);
			return;
		}
		this.reply(connection, id, true, answer);
	}

	/**
	 * Re-evaluate tasks sitting in `in_review` whose reviews are all in.
	 *
	 * Called from the daemon tick so the handoff survives a daemon restart mid-review: without it,
	 * a verdict recorded while the daemon was down would leave the task parked in `in_review`
	 * forever and the merge lane would never see it.
	 */
	reconcileReviews(): string[] {
		const advanced: string[] = [];
		for (const task of this.board.list()) {
			if (task.status !== "in_review") continue;
			const reviews = this.store.listReviews(task.id);
			if (reviews.length === 0) continue;
			const outcome = reviewQuorumMet(reviews, task.createdBy, task.assignee);
			if (!outcome.met) continue;
			const done = this.board.transition(task.id, "done", "daemon", { note: `review quorum met: ${outcome.reason}` });
			this.broadcast("task.changed", { task: summarizeTask(done), reason: "approved" });
			this.store.writeDecision("review.approved", "daemon", `${task.id} approved; marked done (reconciled)`, {
				taskId: task.id,
				reason: outcome.reason,
			});
			advanced.push(task.id);
		}
		if (advanced.length > 0) this.onEvent?.({ type: "task-ready" });
		return advanced;
	}

	// -- daemon-side helpers used by the fleet manager -----------------------

	/** Push a message that came from the daemon/parent rather than from a peer. */
	daemonPost(to: string, kind: BusMessage["kind"], body: string, subject?: string): BusMessage {
		return this.postMessage({ from: "daemon", to, kind, body, subject, requiresAck: false });
	}

	pendingInboxCount(instanceId: string): number {
		return this.store.inboxList(instanceId).length;
	}

	taskSummaries(): TaskSummary[] {
		return this.board.list().map(summarizeTask);
	}

	socketExists(): boolean {
		return existsSync(this.socketPath);
	}

	static socketPathFor(fleetRoot: string): string {
		return join(fleetRoot, "run", "bus.sock");
	}
}

function toInboxItem(message: BusMessage): InboxItem {
	return {
		id: message.id,
		seq: message.seq,
		from: message.from,
		kind: message.kind,
		body: message.body,
		subject: message.subject,
		artifacts: message.artifacts,
		requiresAck: message.requiresAck,
		replyTo: message.replyTo,
		postedAt: message.postedAt,
		hops: message.hops,
	};
}

function summarizeTask(task: Task): TaskSummary & { labels: string[]; assignee: string | null; mergeState?: string } {
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		priority: task.priority,
		assignee: task.assignee ?? null,
		labels: task.labels,
		mergeState: task.merge?.state,
	};
}

/**
 * Is the review quorum satisfied for this task?
 *
 * Pure and exported so the routing rule is testable without a socket, a container or a repo.
 * The merge lane independently re-checks its own version of this at merge time (§3.8); this one
 * only decides whether to move the task to `done`.
 */
export function reviewQuorumMet(
	reviews: Review[],
	author: string,
	assignee?: string,
): { met: boolean; reason: string } {
	if (reviews.length === 0) return { met: false, reason: "no reviews" };
	const pending = reviews.filter((review) => review.verdict === undefined);
	if (pending.length > 0) return { met: false, reason: `${pending.length} review(s) still pending` };
	const changes = reviews.filter((review) => review.verdict === "request_changes");
	if (changes.length > 0) return { met: false, reason: `${changes.length} review(s) requested changes` };
	const escalated = reviews.filter((review) => review.verdict === "escalate");
	if (escalated.length > 0) return { met: false, reason: `${escalated.length} review(s) escalated` };
	const approvals = reviews.filter((review) => review.verdict === "approve");
	if (approvals.length === 0) return { met: false, reason: "no approving review" };
	// Self-approval does not count. Both the creator and the current assignee are treated as the
	// author, because a task can be reassigned after it was filed.
	const selfApproved = approvals.every(
		(review) => review.reviewerInstanceId === author || review.reviewerInstanceId === assignee,
	);
	if (selfApproved) return { met: false, reason: "only the author approved" };
	return { met: true, reason: `${approvals.length} approval(s) from ${approvals.map((review) => review.reviewerInstanceId).join(", ")}` };
}

export { REQUEST_TIMEOUT_MS };