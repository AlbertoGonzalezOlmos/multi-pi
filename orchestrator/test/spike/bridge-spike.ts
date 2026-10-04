/**
 * Spike 0.10 — minimal fleet bridge.
 *
 * Proves the architectural gate: an extension inside a CONTAINERISED INTERACTIVE pi can
 *   (a) connect out to a Unix socket bind-mounted from the host,
 *   (b) publish lifecycle facts (agent_settled, usage),
 *   (c) receive an inbound message and inject it into the LIVE conversation so the model
 *       acts on it, and a human watching the attached tmux pane sees it,
 *   (d) register a coordination tool the model can call.
 *
 * Nothing is started in the factory (docs/extensions.md): the socket opens on session_start
 * and closes idempotently on session_shutdown.
 */

import { createConnection, type Socket } from "node:net";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface BusLine {
	type?: string;
	text?: string;
	[key: string]: unknown;
}

const fleetPostTool = defineTool({
	name: "fleet_post",
	label: "Fleet post",
	description: "Post a short message to the fleet coordinator. Use this to report progress or ask for a decision.",
	parameters: Type.Object({
		body: Type.String({ description: "Message body, markdown, keep it under 2000 characters" }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const sent = publish({ type: "message.post", body: params.body });
		return {
			content: [
				{
					type: "text",
					text: sent
						? "Posted to the fleet coordinator."
						: "Coordinator socket is not connected; the message was dropped. Tell the user.",
				},
			],
			details: { body: params.body, sent },
		};
	},
});

export default function (pi: ExtensionAPI) {
	let socket: Socket | null = null;
	let connected = false;
	let disposed = false;
	let pending: string[] = [];
	let settledCount = 0;
	let lastUsage = "";
	// Widget/status live on ctx.ui, which only exists once a session has started.
	// Captured on session_start (the pattern examples/extensions/event-bus.ts uses).
	let sessionCtx: ExtensionContext | null = null;

	const socketPath = process.env.FLEET_BUS_SOCKET ?? "/fleet/run/bus.sock";
	const instanceId = process.env.FLEET_INSTANCE_ID ?? "unknown";

	function publish(record: Record<string, unknown>): boolean {
		const line = `${JSON.stringify({ v: 1, from: instanceId, ...record })}\n`;
		if (connected && socket && !socket.destroyed) {
			socket.write(line);
			return true;
		}
		if (pending.length < 100) pending.push(line);
		return false;
	}

	function connect(): void {
		if (disposed || connected) return;
		const sock = createConnection(socketPath);
		socket = sock;
		let buffer = "";

		sock.setEncoding("utf8");

		sock.on("connect", () => {
			connected = true;
			const queued = pending;
			pending = [];
			sock.write(
				`${JSON.stringify({
					v: 1,
					from: instanceId,
					type: "hello",
					role: process.env.FLEET_ROLE ?? "worker",
					pid: process.pid,
					piVersion: process.env.FLEET_PI_VERSION ?? "unknown",
					sessionFile: process.env.PI_SESSION_FILE ?? null,
				})}\n`,
			);
			for (const line of queued) sock.write(line);
			refreshWidget();
		});

		sock.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.trim()) handleInbound(line);
			}
		});

		sock.on("error", () => {
			connected = false;
			refreshWidget();
			if (!disposed) setTimeout(connect, 2000);
		});

		sock.on("close", () => {
			connected = false;
			refreshWidget();
			if (!disposed) setTimeout(connect, 2000);
		});
	}

	function handleInbound(line: string): void {
		let record: BusLine;
		try {
			record = JSON.parse(line) as BusLine;
		} catch {
			return;
		}
		if (record.type === "inject") {
			const text = typeof record.text === "string" ? record.text : "";
			if (!text) return;
			// The gate: make inbound fleet traffic enter the LIVE conversation.
			pi.sendMessage(
				{
					customType: "fleet.message",
					content: `[fleet message from the coordinator]\n\n${text}`,
					display: true,
				},
				{ triggerTurn: true },
			);
			publish({ type: "message.ack", injected: text.slice(0, 80) });
		} else if (record.type === "ping") {
			publish({ type: "pong" });
		}
	}

	function refreshWidget(): void {
		if (!sessionCtx) return;
		const text = `fleet: ${instanceId} · ${connected ? "connected" : "offline"} · settled ${settledCount}${lastUsage ? ` · ${lastUsage}` : ""}`;
		sessionCtx.ui.setWidget("fleet", [text]);
		sessionCtx.ui.setStatus("fleet", connected ? `fleet:${instanceId} ●` : `fleet:${instanceId} ○`);
	}

	pi.registerTool(fleetPostTool);

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		connect();
		refreshWidget();
		publish({
			type: "evt",
			evt: "session_start",
			model: process.env.PI_MODEL ?? null,
			provider: process.env.PI_PROVIDER ?? null,
			cwd: ctx.cwd,
			mode: ctx.mode,
		});
	});

	pi.on("agent_settled", async () => {
		settledCount += 1;
		refreshWidget();
		publish({ type: "evt", evt: "agent_settled", count: settledCount });
	});

	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } };
		if (message?.role !== "assistant") return;
		const usage = message.usage;
		if (!usage) return;
		lastUsage = `↑${usage.input ?? 0} ↓${usage.output ?? 0}`;
		refreshWidget();
		publish({
			type: "usage.report",
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cost: usage.cost?.total ?? 0,
		});
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		publish({ type: "evt", evt: "session_shutdown" });
		connected = false;
		socket?.destroy();
		socket = null;
		sessionCtx = null;
	});
}
