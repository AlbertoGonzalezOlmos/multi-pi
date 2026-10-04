/**
 * Coordination bus protocol.
 *
 * Transport is a Unix domain socket bind-mounted into every container at /fleet/run/bus.sock
 * (verified: a container client completes a round trip against a host server). Single host by
 * decision, so there is no transport abstraction and no TLS; the per-instance token in `hello`
 * is the only authentication.
 *
 * Framing is LF-delimited JSON (see ./jsonl.ts).
 *
 * Design notes borrowed from pi's own experimental coordinator
 * (pi/packages/coding-agent/src/experimental/coordinator.ts): the router keeps payloads opaque,
 * peers are a registry with connect/disconnect events, and the protocol is versioned so a stale
 * bridge is rejected at handshake rather than mis-decoding later.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface BusRequest {
	v: typeof PROTOCOL_VERSION;
	id: string;
	from: string;
	kind: "req";
	type: ClientRequestType;
	payload: unknown;
}

export interface BusResponseOk {
	v: typeof PROTOCOL_VERSION;
	id: string;
	from: string;
	kind: "res";
	ok: true;
	payload: unknown;
}

export interface BusResponseError {
	v: typeof PROTOCOL_VERSION;
	id: string;
	from: string;
	kind: "res";
	ok: false;
	error: string;
	retryable?: boolean;
}

export interface BusEvent<T extends ServerEventType = ServerEventType> {
	v: typeof PROTOCOL_VERSION;
	id: string;
	from: string;
	kind: "evt";
	type: T;
	payload: unknown;
}

export type BusRecord = BusRequest | BusResponseOk | BusResponseError | BusEvent;

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

export interface HelloPayload {
	token: string;
	role: string;
	pid: number;
	piVersion: string;
	bridgeVersion: string;
	/** Where the bridge came from; the daemon refuses a fleet that mixes the two. */
	bridgeSource: "bind" | "bake";
	sessionFile: string | null;
	sessionId: string | null;
	model: string | null;
	provider: string | null;
	capabilities: string[];
}

export interface HelloResult {
	instanceId: string;
	fleetId: string;
	sequence: number;
	/** Messages that were queued while this bridge was disconnected. */
	inbox: InboxItem[];
	fleetSnapshot: FleetSnapshot;
}

export interface FleetSnapshot {
	instances: InstanceSummary[];
	openTasks: TaskSummary[];
	holdMerges: boolean;
}

export interface InstanceSummary {
	id: string;
	role: string;
	model: string | null;
	state: InstanceState;
	currentTaskId: string | null;
	connected: boolean;
}

export interface TaskSummary {
	id: string;
	title: string;
	status: TaskStatus;
	priority: number;
	assignee: string | null;
}

export type InstanceState = "starting" | "idle" | "busy" | "unresponsive" | "stopped" | "crashed";

// ---------------------------------------------------------------------------
// Client -> daemon requests
// ---------------------------------------------------------------------------

export type ClientRequestType =
	| "hello"
	| "state.get"
	| "peer.list"
	| "peer.ask"
	| "task.create"
	| "task.list"
	| "task.claim"
	| "task.update"
	| "message.post"
	| "message.ack"
	| "review.request"
	| "review.submit"
	| "artifact.put"
	| "artifact.get"
	| "usage.report"
	| "help.request"
	| "shutdown.request";

export interface PeerAskPayload {
	to: string;
	question: string;
	timeoutMs: number;
}

export interface TaskCreatePayload {
	title: string;
	body: string;
	labels: string[];
	priority?: number;
	dependsOn?: string[];
	suggestedRole?: string;
	budget?: TaskBudget;
}

export interface TaskUpdatePayload {
	taskId: string;
	status?: TaskStatus;
	note?: string;
	blockedReason?: string;
	spent?: Partial<TaskSpent>;
}

export interface MessagePostPayload {
	to: string;
	kind: MessageKind;
	body: string;
	subject?: string;
	artifacts?: string[];
	requiresAck?: boolean;
	replyTo?: string;
}

export interface ReviewSubmitPayload {
	reviewId: string;
	verdict: ReviewVerdict;
	findings: string;
	artifactId?: string;
}

export interface UsageReportPayload {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	contextTokens?: number;
	turns?: number;
	taskId?: string;
}

export interface HelpRequestPayload {
	reason: string;
	taskId?: string;
	blocked?: boolean;
}

// ---------------------------------------------------------------------------
// Daemon -> client events
// ---------------------------------------------------------------------------

export type ServerEventType =
	| "hello.ok"
	| "message.inbound"
	| "message.answer"
	| "task.assigned"
	| "task.changed"
	| "review.inbound"
	| "review.verdict"
	| "priority.changed"
	| "peer.joined"
	| "peer.left"
	| "peer.ask"
	| "budget.warning"
	| "budget.exceeded"
	| "merge.state"
	| "parent.steering"
	| "fleet.snapshot";

export interface InboxItem {
	id: string;
	seq: number;
	from: string;
	kind: MessageKind;
	body: string;
	subject?: string;
	artifacts: string[];
	requiresAck: boolean;
	replyTo?: string;
	postedAt: string;
	hops: number;
}

// ---------------------------------------------------------------------------
// Shared domain vocabulary (mirrors src/store/types.ts)
// ---------------------------------------------------------------------------

export type TaskStatus =
	| "proposed"
	| "queued"
	| "assigned"
	| "in_progress"
	| "blocked"
	| "in_review"
	| "changes_requested"
	| "done"
	| "cancelled";

export type MessageKind = "info" | "question" | "answer" | "handoff" | "escalation" | "steering" | "verdict";

export type ReviewVerdict = "approve" | "request_changes" | "escalate";

export interface TaskBudget {
	tokens?: number;
	costUsd?: number;
	wallMs?: number;
	maxTurns?: number;
}

export interface TaskSpent {
	tokens: number;
	costUsd: number;
	wallMs: number;
	turns: number;
}

// ---------------------------------------------------------------------------
// Runtime guards — the daemon validates at the boundary rather than trusting types
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function isBusRecord(value: unknown): value is BusRecord {
	if (!isRecord(value)) return false;
	if (value.v !== PROTOCOL_VERSION) return false;
	const kind = value.kind;
	return kind === "req" || kind === "res" || kind === "evt";
}

export function makeId(prefix: string): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `${prefix}_${hex}`;
}
