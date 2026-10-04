/**
 * Spike 0.10 host side: the coordination bus, minimal form.
 *
 * Usage:
 *   node server.mjs start          # run the bus, log every record
 *   node server.mjs inject "text"  # inject a message into the live pi conversation
 *   node server.mjs ping
 *
 * The bus and the control CLI talk through a second socket (ctl.sock) so `inject`
 * can be issued from any shell while the daemon runs elsewhere.
 */

import { createConnection, createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { appendFileSync } from "node:fs";

const RUN = process.env.GATE_RUN ?? "/tmp/gate/run";
const BUS = `${RUN}/bus.sock`;
const CTL = `${RUN}/ctl.sock`;
const LOG = `${RUN}/bus.jsonl`;

function unlinkQuietly(path) {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {}
}

function log(record) {
	const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
	process.stdout.write(line);
	try {
		appendFileSync(LOG, line);
	} catch {}
}

if (process.argv[2] === "start") {
	unlinkQuietly(BUS);
	unlinkQuietly(CTL);

	const busClients = new Set();

	const bus = createServer((conn) => {
		busClients.add(conn);
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("data", (chunk) => {
			buffer += chunk;
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (!line.trim()) continue;
				let record;
				try {
					record = JSON.parse(line);
				} catch {
					log({ dir: "in", error: "bad json", line: line.slice(0, 200) });
					continue;
				}
				log({ dir: "in", ...record });
			}
		});
		conn.on("close", () => busClients.delete(conn));
		conn.on("error", () => busClients.delete(conn));
	});

	bus.listen(BUS, () => log({ event: "bus-listening", path: BUS }));

	// Control socket: lets `node server.mjs inject "..."` reach a live instance.
	const ctl = createServer((conn) => {
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("data", (chunk) => {
			buffer += chunk;
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (!line.trim()) continue;
				let request;
				try {
					request = JSON.parse(line);
				} catch {
					conn.end(`${JSON.stringify({ ok: false, error: "bad json" })}\n`);
					return;
				}
				const targets = [...busClients];
				for (const target of targets) {
					target.write(`${JSON.stringify({ v: 1, ...request })}\n`);
				}
				log({ event: "broadcast", ...request, targets: targets.length });
				conn.end(`${JSON.stringify({ ok: true, delivered: targets.length })}\n`);
			}
		});
		conn.on("error", () => {});
	});

	ctl.listen(CTL, () => log({ event: "ctl-listening", path: CTL }));

	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			bus.close();
			ctl.close();
			unlinkQuietly(BUS);
			unlinkQuietly(CTL);
			process.exit(0);
		});
	}
} else {
	const [command, ...rest] = process.argv.slice(2);
	const payload =
		command === "inject"
			? { type: "inject", text: rest.join(" ") }
			: command === "ping"
				? { type: "ping" }
				: null;
	if (!payload) {
		console.error(`usage: server.mjs start | inject "<text>" | ping`);
		process.exit(2);
	}
	const conn = createConnection(CTL);
	conn.setEncoding("utf8");
	conn.on("connect", () => conn.write(`${JSON.stringify(payload)}\n`));
	conn.on("data", (data) => {
		process.stdout.write(data);
		conn.end();
	});
	conn.on("error", (error) => {
		console.error(`ctl connect failed: ${error.message}`);
		process.exit(1);
	});
}
