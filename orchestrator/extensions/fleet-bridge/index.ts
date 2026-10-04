/**
 * fleet-bridge — loaded into every subharness pi.
 *
 * This is the artifact that turns N independent containerised TUIs into a fleet
 * (PLAN.md §2.2). It owns one Unix socket to the host daemon, bind-mounted at
 * /fleet/run/bus.sock, and translates in both directions:
 *
 *   pi lifecycle  -> bus   agent_settled / message_end usage / session_start / shutdown
 *   bus -> pi            inbound messages injected into the LIVE conversation
 *
 * Delivery policy (PLAN.md §3.4):
 *   - idle            -> sendMessage with triggerTurn, so a new turn starts
 *   - streaming       -> deliverAs "steer" for steering traffic, else "followUp"
 *   - human composing -> suppressed; an operator keystroke always wins (§6.2)
 *
 * Contract notes:
 *   - Nothing is started in the factory. Some pi invocations load extensions without starting a
 *     session, so the socket opens on session_start and teardown is idempotent
 *     (pi docs/extensions.md).
 *   - This file is deliberately SELF-CONTAINED: it is bind-mounted or baked into a container
 *     where only pi's own jiti aliases resolve. Importing from the orchestrator's src/ would
 *     break that.
 *   - Imports resolve through pi's jiti aliases (loader.ts:100-123), which map
 *     @earendil-works/pi-ai and @earendil-works/pi-coding-agent regardless of file location.
 */

import { createConnection, type Socket } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = 1;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_PENDING = 200;
const MAX_BODY_CHARS = 8000;
/** Above this many hops a message is dropped rather than relayed (§6.4 loop guard). */
const MAX_HOPS = 4;

interface InboundRecord {
	v?: number;
	id?: string;
	kind?: string;
	type?: string;
	payload?: unknown;
	[key: string]: unknown;
}

interface InboxItem {
	id: string;
	seq: number;
	from: string;
	kind: string;
	body: string;
	subject?: string;
	artifacts: string[];
	requiresAck: boolean;
	replyTo?: string;
	postedAt: string;
	hops: number;
}

interface InstanceSummary {
	id: string;
	role: string;
	model: string | null;
	state: string;
	currentTaskId: string | null;
	connected: boolean;
}

interface TaskSummary {
	id: string;
	title: string;
	status: string;
	priority: number;
	assignee: string | null;
}

interface AssistantUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
	totalTokens?: number;
}

interface FleetStatusDetails {
	ok: boolean;
	instances?: InstanceSummary[];
	tasks?: TaskSummary[];
	usageTotals?: { input: number; output: number; cost: number };
	turns?: number;
}

interface PostDetails {
	ok: boolean;
	id?: string;
	to?: string;
}

interface AskDetails {
	ok: boolean;
	to?: string;
	payload?: unknown;
}

interface AnswerDetails {
	ok: boolean;
	to?: string;
}

interface TaskOpDetails {
	ok: boolean;
	task?: TaskSummary;
}

interface ReviewDetails {
	ok: boolean;
	verdict?: string;
}

interface HelpDetails {
	ok: boolean;
}

export default function (pi: ExtensionAPI) {
	const socketPath = process.env.FLEET_BUS_SOCKET ?? "/fleet/run/bus.sock";
	const instanceId = process.env.FLEET_INSTANCE_ID ?? "unknown";
	const instanceToken = process.env.FLEET_INSTANCE_TOKEN ?? "";
	const role = process.env.FLEET_ROLE ?? "worker";

	let socket: Socket | null = null;
	let connected = false;
	let disposed = false;
	let reconnectAttempts = 0;
	let reconnectTimer: NodeJS.Timeout | null = null;
	let pendingOut: string[] = [];
	let buffer = "";

	// ctx.ui owns the widget/status surface, and only exists after a session starts. Captured on
	// session_start, which is the pattern examples/extensions/event-bus.ts uses.
	let ctx: ExtensionContext | null = null;
	let busy = false;
	let humanComposing = false;
	let settledCount = 0;
	let turns = 0;
	let usageTotals = { input: 0, output: 0, cost: 0 };
	let lastSummary = "";
	/** Messages received while a run was active, delivered at the next boundary. */
	let deferred: InboxItem[] = [];
	let currentTaskId: string | null = null;

	// -- transport ----------------------------------------------------------

	function send(record: Record<string, unknown>): boolean {
		const line = `${JSON.stringify({ v: PROTOCOL_VERSION, from: instanceId, ...record })}\n`;
		if (connected && socket && !socket.destroyed) {
			socket.write(line);
			return true;
		}
		if (pendingOut.length < MAX_PENDING) pendingOut.push(line);
		return false;
	}

	function request(type: string, payload: unknown): Promise<unknown> {
		const id = `req_${Math.random().toString(36).slice(2, 10)}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				waiters.delete(id);
				resolve({ ok: false, error: "timeout" });
			}, 30_000);
			waiters.set(id, {
				timer,
				resolve: (value: unknown) => {
					clearTimeout(timer);
					resolve(value);
				},
			});
			const sent = send({ id, kind: "req", type, payload });
			if (!sent) {
				const waiter = waiters.get(id);
				waiters.delete(id);
				if (waiter) {
					clearTimeout(waiter.timer);
					waiter.resolve({ ok: false, error: "not connected" });
				}
			}
		});
	}

	const waiters = new Map<string, { timer: NodeJS.Timeout; resolve: (value: unknown) => void }>();

	function connect(): void {
		if (disposed || connected || reconnectTimer) return;
		const sock = createConnection(socketPath);
		socket = sock;
		buffer = "";
		sock.setEncoding("utf8");

		sock.on("connect", () => {
			connected = true;
			reconnectAttempts = 0;
			// Split on "\n" only: U+2028/U+2029 are legal inside JSON strings and Node's
			// readline would treat them as record boundaries (pi's jsonl.ts:8-20 makes the
			// same choice for the same reason).
			send({
				id: `hello_${Date.now()}`,
				kind: "req",
				type: "hello",
				payload: {
					token: instanceToken,
					role,
					pid: process.pid,
					piVersion: process.env.FLEET_PI_VERSION ?? "unknown",
					bridgeVersion: BRIDGE_VERSION,
					bridgeSource: process.env.FLEET_BRIDGE_SOURCE ?? "bind",
					sessionFile: process.env.PI_SESSION_FILE ?? null,
					sessionId: process.env.PI_SESSION_ID ?? null,
					model: ctx?.model?.id ?? null,
					provider: ctx?.model?.provider ?? null,
					capabilities: ["post", "ask", "task", "review", "usage"],
				},
			});
			const queued = pendingOut;
			pendingOut = [];
			for (const line of queued) sock.write(line);
			send({ kind: "req", id: `hb0_${Date.now()}`, type: "heartbeat", payload: { busy } });
			refresh();
		});

		sock.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.trim()) handleLine(line);
			}
		});

		const onFailure = (): void => {
			connected = false;
			refresh();
			if (disposed) return;
			const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
			reconnectAttempts += 1;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				connect();
			}, delay);
		};
		sock.on("error", onFailure);
		sock.on("close", onFailure);
	}

	function handleLine(line: string): void {
		let record: InboundRecord;
		try {
			record = JSON.parse(line) as InboundRecord;
		} catch {
			return;
		}
		if (record.kind === "res" && typeof record.id === "string") {
			const waiter = waiters.get(record.id);
			if (waiter) {
				waiters.delete(record.id);
				waiter.resolve(record);
			}
			// The hello response carries the resynchronised inbox.
			if (record.ok && isRecord(record.payload) && Array.isArray(record.payload.inbox)) {
				deliverInbox(record.payload.inbox as InboxItem[]);
			}
			return;
		}
		if (record.kind !== "evt") return;
		switch (record.type) {
			case "message.inbound": {
				if (isRecord(record.payload)) deliverOne(record.payload as unknown as InboxItem);
				break;
			}
			case "peer.ask": {
				if (isRecord(record.payload)) void handlePeerAsk(record.payload as Record<string, unknown>);
				break;
			}
			case "task.assigned":
			case "task.changed":
			case "priority.changed":
			case "peer.joined":
			case "peer.left":
			case "fleet.snapshot":
			case "merge.state":
				refresh();
				break;
			case "budget.warning":
			case "budget.exceeded": {
				const text = isRecord(record.payload) ? String(record.payload.reason ?? record.type) : String(record.type);
				notify(`fleet budget: ${text}`);
				break;
			}
			case "parent.steering": {
				if (isRecord(record.payload)) {
					const text = String(record.payload.body ?? "");
					if (text) inject(text, { steering: true, from: "parent" });
				}
				break;
			}
			default:
				break;
		}
	}

	// -- inbound delivery ---------------------------------------------------

	function deliverInbox(items: InboxItem[]): void {
		for (const item of items) deliverOne(item);
	}

	function deliverOne(item: InboxItem): void {
		if (!item || typeof item.body !== "string") return;
		if (item.hops > MAX_HOPS) return;
		// Never inject while the human is composing: an operator keystroke always wins (§6.2).
		if (humanComposing || busy) {
			if (deferred.length < MAX_PENDING) deferred.push(item);
			refresh();
			return;
		}
		const header = `[fleet:${item.kind} from ${item.from}${item.subject ? ` re ${item.subject}` : ""}]`;
		inject(`${header}\n\n${item.body}`, { steering: item.kind === "steering", from: item.from });
		void request("message.ack", { messageId: item.id });
	}

	function inject(text: string, options: { steering: boolean; from: string }): void {
		pi.sendMessage(
			{
				customType: "fleet.message",
				content: text,
				display: true,
				details: { from: options.from, steering: options.steering },
			},
			{ triggerTurn: true, deliverAs: options.steering ? "steer" : "followUp" },
		);
		refresh();
	}

	/** Drain anything deferred once the run finishes and the editor is free. */
	function flushDeferred(): void {
		if (busy || humanComposing || deferred.length === 0) return;
		const batch = deferred;
		deferred = [];
		for (const item of batch) deliverOne(item);
	}

	async function handlePeerAsk(payload: Record<string, unknown>): Promise<void> {
		const askId = String(payload.askId ?? "");
		const from = String(payload.from ?? "peer");
		const question = String(payload.question ?? "");
		const hops = Number(payload.hops ?? 0);
		// Surface the question to the model rather than answering silently: only this instance's
		// own model has the context to answer it.
		inject(
			`[fleet:question from ${from}]\n\n${question}\n\nAnswer by calling fleet_answer with askId "${askId}".`,
			{ steering: false, from },
		);
		pendingAnswers.set(askId, { from, hops });
	}

	const pendingAnswers = new Map<string, { from: string; hops: number }>();

	// -- ui -----------------------------------------------------------------

	function notify(text: string): void {
		ctx?.ui.notify(text, "info");
	}

	function modelLabel(): string {
		const model = ctx?.model;
		return model ? `${model.provider}/${model.id}` : (process.env.PI_MODEL ?? "?");
	}

	function refresh(): void {
		if (!ctx) return;
		const inbox = deferred.length;
		const link = connected ? "online" : "offline";
		const model = modelLabel();
		const cost = usageTotals.cost > 0 ? ` $${usageTotals.cost.toFixed(4)}` : "";
		lastSummary = `fleet ${instanceId} · ${role} · ${model} · ${link}${currentTaskId ? ` · ${currentTaskId}` : ""} · ↑${usageTotals.input} ↓${usageTotals.output}${cost} · settled ${settledCount}${inbox > 0 ? ` · inbox ${inbox}` : ""}`;
		ctx.ui.setWidget("fleet", [lastSummary]);
		ctx.ui.setStatus("fleet", connected ? `fleet:${instanceId} ●` : `fleet:${instanceId} ○`);
	}

	// -- tools --------------------------------------------------------------

	pi.registerTool(
		defineTool({
			name: "fleet_status",
			label: "Fleet status",
			description:
				"Show the fleet: which instances are connected, what they are working on, the open task board, and your own usage so far.",
			parameters: Type.Object({}),
			async execute(): Promise<AgentToolResult<FleetStatusDetails>> {
				const response = (await request("state.get", {})) as {
					ok?: boolean;
					payload?: { snapshot?: { instances?: InstanceSummary[]; openTasks?: TaskSummary[]; holdMerges?: boolean } };
					error?: string;
				};
				if (!response.ok || !response.payload) {
					return {
						content: [{ type: "text", text: `Fleet coordinator unavailable: ${response.error ?? "no response"}` }],
						details: { ok: false },
						isError: true,
					};
				}
				const snapshot = response.payload.snapshot ?? {};
				const instances = snapshot.instances ?? [];
				const tasks = snapshot.openTasks ?? [];
				const lines: string[] = [];
				lines.push(`You are ${instanceId} (${role}), model ${process.env.PI_MODEL ?? "?"}.`);
				lines.push(`Merges ${snapshot.holdMerges ? "HELD" : "auto"}.`);
				lines.push("");
				lines.push("Instances:");
				for (const instance of instances) {
					lines.push(
						`  ${instance.connected ? "●" : "○"} ${instance.id} [${instance.role}] ${instance.model ?? "?"} ${instance.state}${instance.currentTaskId ? ` -> ${instance.currentTaskId}` : ""}`,
					);
				}
				lines.push("");
				lines.push(tasks.length > 0 ? "Open tasks:" : "Open tasks: none");
				for (const task of tasks.slice(0, 25)) {
					lines.push(`  p${task.priority} ${task.id} [${task.status}] ${task.title}${task.assignee ? ` -> ${task.assignee}` : ""}`);
				}
				if (tasks.length > 25) lines.push(`  ... ${tasks.length - 25} more`);
				lines.push("");
				lines.push(
					`Your usage: ${turns} turns, ↑${usageTotals.input} ↓${usageTotals.output}, $${usageTotals.cost.toFixed(4)}.`,
				);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { ok: true, instances, tasks, usageTotals, turns },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "fleet_post",
			label: "Fleet post",
			description:
				"Post a message to another instance. `to` accepts an instance id, \"parent\", \"broadcast\", or \"role:<name>\". Use kind \"question\" when you need an answer, \"info\" for a status update, \"handoff\" when passing work on.",
			parameters: Type.Object({
				to: Type.String({ description: "Recipient: instance id, parent, broadcast, or role:<name>" }),
				body: Type.String({ description: "Message body in markdown. Keep it under 4000 characters." }),
				kind: Type.Optional(
					Type.String({
						description: "info | question | answer | handoff | escalation | steering",
						default: "info",
					}),
				),
				subject: Type.Optional(Type.String({ description: "Usually a task id" })),
				requires_ack: Type.Optional(Type.Boolean({ description: "Ask the recipient to acknowledge" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<PostDetails>> {
				const body =
					params.body.length > MAX_BODY_CHARS
						? `${params.body.slice(0, MAX_BODY_CHARS)}\n[truncated]`
						: params.body;
				const response = (await request("message.post", {
					to: params.to,
					body,
					kind: params.kind ?? "info",
					subject: params.subject,
					requiresAck: params.requires_ack ?? false,
				})) as { ok?: boolean; payload?: { id?: string }; error?: string };
				if (!response.ok) {
					return {
						content: [{ type: "text", text: `Post failed: ${response.error ?? "unknown"}` }],
						details: { ok: false },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Posted to ${params.to} as ${response.payload?.id ?? "?"}.` }],
					details: { ok: true, id: response.payload?.id, to: params.to },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "fleet_ask",
			label: "Fleet ask",
			description:
				"Ask another instance a question and WAIT for its answer. Times out and escalates to the parent rather than blocking forever. Use sparingly; prefer fleet_post for anything that is not blocking you right now.",
			parameters: Type.Object({
				to: Type.String({ description: "Instance id, or parent" }),
				question: Type.String({ description: "The question" }),
				timeout_seconds: Type.Optional(Type.Number({ description: "Default 60, maximum 600" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<AskDetails>> {
				const timeoutMs = Math.min(Math.max(params.timeout_seconds ?? 60, 5), 600) * 1000;
				const response = (await request("peer.ask", {
					to: params.to,
					question: params.question,
					timeoutMs,
				})) as { ok?: boolean; payload?: unknown; error?: string };
				if (!response.ok) {
					return {
						content: [{ type: "text", text: `No answer from ${params.to}: ${response.error ?? "unknown"}` }],
						details: { ok: false, to: params.to },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `${params.to} answered:\n\n${JSON.stringify(response.payload, null, 2)}` }],
					details: { ok: true, to: params.to, payload: response.payload },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "fleet_answer",
			label: "Fleet answer",
			description: "Reply to a peer question that was delivered to you. Provide the askId from that question.",
			parameters: Type.Object({
				ask_id: Type.String({ description: "The askId from the incoming question" }),
				answer: Type.String({ description: "Your answer" }),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<AnswerDetails>> {
				const pending = pendingAnswers.get(params.ask_id);
				if (!pending) {
					return {
						content: [{ type: "text", text: `No pending question with askId ${params.ask_id}.` }],
						details: { ok: false },
						isError: true,
					};
				}
				pendingAnswers.delete(params.ask_id);
				send({
					id: params.ask_id,
					kind: "res",
					ok: true,
					payload: { answer: params.answer, from: instanceId },
				});
				return {
					content: [{ type: "text", text: `Answer delivered to ${pending.from}.` }],
					details: { ok: true, to: pending.from },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "task_claim",
			label: "Claim task",
			description: "Claim an open task from the board and take a lease on it. Fails if another instance holds a live lease or if dependencies are unsatisfied.",
			parameters: Type.Object({
				task_id: Type.String({ description: "Task id from fleet_status" }),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<TaskOpDetails>> {
				const response = (await request("task.claim", { taskId: params.task_id })) as {
					ok?: boolean;
					payload?: { task?: TaskSummary };
					error?: string;
				};
				if (!response.ok) {
					return {
						content: [{ type: "text", text: `Claim failed: ${response.error ?? "unknown"}` }],
						details: { ok: false },
						isError: true,
					};
				}
				currentTaskId = params.task_id;
				refresh();
				return {
					content: [{ type: "text", text: `Claimed ${params.task_id}. Mark it in_progress with task_update when you begin.` }],
					details: { ok: true, task: response.payload?.task },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "task_update",
			label: "Update task",
			description:
				"Move a task you own to a new status. Use in_progress when you start, in_review when the work is ready for a peer to review, blocked when you cannot proceed.",
			parameters: Type.Object({
				task_id: Type.String({ description: "Task id" }),
				status: Type.String({
					description: "in_progress | blocked | in_review | done | cancelled",
				}),
				note: Type.Optional(Type.String({ description: "Short note recorded in the task history" })),
				blocked_reason: Type.Optional(Type.String({ description: "Why you are blocked" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<TaskOpDetails>> {
				const response = (await request("task.update", {
					taskId: params.task_id,
					status: params.status,
					note: params.note,
					blockedReason: params.blocked_reason,
				})) as { ok?: boolean; payload?: { task?: TaskSummary }; error?: string };
				if (!response.ok) {
					return {
						content: [{ type: "text", text: `Update failed: ${response.error ?? "unknown"}` }],
						details: { ok: false },
						isError: true,
					};
				}
				if (params.status === "done" || params.status === "cancelled") currentTaskId = null;
				refresh();
				return {
					content: [{ type: "text", text: `${params.task_id} -> ${params.status}.` }],
					details: { ok: true, task: response.payload?.task },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "review_submit",
			label: "Submit review",
			description:
				"Submit a review verdict. Cite evidence as file:line. approve means you would ship this; request_changes must list concrete findings; escalate means you cannot judge it.",
			parameters: Type.Object({
				review_id: Type.String({ description: "The review id from the incoming review request" }),
				verdict: Type.String({ description: "approve | request_changes | escalate" }),
				findings: Type.String({ description: "Markdown findings with file:line evidence" }),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<ReviewDetails>> {
				const response = (await request("review.submit", {
					reviewId: params.review_id,
					verdict: params.verdict,
					findings: params.findings,
				})) as { ok?: boolean; error?: string };
				if (!response.ok) {
					return {
						content: [{ type: "text", text: `Review submission failed: ${response.error ?? "unknown"}` }],
						details: { ok: false },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Verdict ${params.verdict} recorded for ${params.review_id}.` }],
					details: { ok: true, verdict: params.verdict },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "help_request",
			label: "Ask parent for help",
			description:
				"Escalate to the parent orchestrator when you are blocked, need a decision, or hit scope/product ambiguity. Always available. Do NOT use this for routine completion reports.",
			parameters: Type.Object({
				reason: Type.String({ description: "What you need and why you cannot decide it yourself" }),
				task_id: Type.Optional(Type.String({ description: "Related task id" })),
			}),
			async execute(_toolCallId, params): Promise<AgentToolResult<HelpDetails>> {
				const response = (await request("help.request", {
					reason: params.reason,
					taskId: params.task_id,
					blocked: true,
				})) as { ok?: boolean; error?: string };
				if (!response.ok) {
					return {
						content: [{ type: "text", text: `Escalation failed: ${response.error ?? "unknown"}` }],
						details: { ok: false },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: "Escalated to the parent orchestrator. Continue with other work while you wait." }],
					details: { ok: true },
				};
			},
		}),
	);

	pi.registerCommand("fleet", {
		description: "Show this instance's fleet state",
		handler: async (_args, commandCtx) => {
			ctx = commandCtx;
			commandCtx.ui.notify(lastSummary || "fleet: not yet initialised", "info");
		},
	});

	// -- lifecycle ----------------------------------------------------------

	pi.on("session_start", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		connect();
		refresh();
		heartbeatTimer = setInterval(() => {
			if (!connected) return;
			send({ id: `hb_${Date.now()}`, kind: "req", type: "heartbeat", payload: { busy } });
		}, HEARTBEAT_MS);
		// The hello response delivers anything queued while we were away.
	});

	let heartbeatTimer: NodeJS.Timeout | null = null;
	const HEARTBEAT_MS = Math.max(Number(process.env.FLEET_HEARTBEAT_SECONDS ?? 20), 5) * 1000;

	pi.on("ui_prompt_start", async () => {
		humanComposing = true;
	});

	pi.on("ui_prompt_end", async () => {
		humanComposing = false;
		flushDeferred();
	});

	pi.on("agent_start", async () => {
		busy = true;
		refresh();
	});

	// agent_end is NOT completion: retries, compaction and queued work can follow it.
	// agent_settled is the only signal that pi will not continue on its own (docs/rpc.md).
	pi.on("model_select", async () => {
		refresh();
		send({
			id: `model_${Date.now()}`,
			kind: "req",
			type: "heartbeat",
			payload: { busy, model: ctx?.model?.id ?? null, provider: ctx?.model?.provider ?? null },
		});
	});

	pi.on("agent_settled", async () => {
		busy = false;
		settledCount += 1;
		refresh();
		send({ id: `set_${Date.now()}`, kind: "req", type: "heartbeat", payload: { busy: false, settled: settledCount } });
		flushDeferred();
	});

	pi.on("turn_start", async () => {
		turns += 1;
	});

	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; usage?: AssistantUsage };
		if (message?.role !== "assistant" || !message.usage) return;
		const usage = message.usage;
		usageTotals = {
			input: usageTotals.input + (usage.input ?? 0),
			output: usageTotals.output + (usage.output ?? 0),
			cost: usageTotals.cost + (usage.cost?.total ?? 0),
		};
		refresh();
		send({
			id: `use_${Date.now()}`,
			kind: "req",
			type: "usage.report",
			payload: {
				input: usage.input ?? 0,
				output: usage.output ?? 0,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				cost: usage.cost?.total ?? 0,
				contextTokens: usage.totalTokens ?? 0,
				turns: 1,
				taskId: currentTaskId ?? undefined,
			},
		});
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = null;
		send({ id: `bye_${Date.now()}`, kind: "req", type: "heartbeat", payload: { busy: false, leaving: true } });
		connected = false;
		socket?.destroy();
		socket = null;
		ctx = null;
	});
}

const BRIDGE_VERSION = "0.1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
