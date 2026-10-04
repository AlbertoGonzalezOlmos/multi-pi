/**
 * WorkspaceStore — the durable source of truth.
 *
 * Every bus mutation is written here first and only then broadcast (PLAN.md §2.7), so a
 * subharness that misses an event can always reconstruct state from disk.
 *
 * Write discipline:
 *   - JSON documents: write to a sibling temp file, fsync, then rename. A reader therefore
 *     never observes a partial document, and a crash leaves the previous version intact.
 *   - Sequence numbers are allocated from one counter file, also written atomically.
 *   - The ledger is append-only JSONL. Single-line O_APPEND writes below PIPE_BUF are atomic
 *     on Linux, which is the same property pi relies on for its session files
 *     (pi/packages/coding-agent/src/core/session-manager.ts:1187).
 */

import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
	ArtifactManifest,
	BusMessage,
	Decision,
	FleetManifest,
	InstanceRecord,
	LedgerEntry,
	Review,
	Task,
} from "./types.ts";

const SEQ_FILE = "sequence.json";

export interface WorkspacePaths {
	root: string;
	state: string;
	profiles: string;
	roles: string;
	prompts: string;
	instances: string;
	worktrees: string;
	workspace: string;
	tasks: string;
	messages: string;
	reviews: string;
	artifacts: string;
	decisions: string;
	ledger: string;
	run: string;
	image: string;
	bridge: string;
}

export function workspacePaths(root: string): WorkspacePaths {
	return {
		root,
		state: join(root, "fleet.json"),
		profiles: join(root, "profiles"),
		roles: join(root, "roles"),
		prompts: join(root, "prompts"),
		instances: join(root, "instances"),
		worktrees: join(root, "worktrees"),
		workspace: join(root, "workspace"),
		tasks: join(root, "workspace", "tasks"),
		messages: join(root, "workspace", "messages"),
		reviews: join(root, "workspace", "reviews"),
		artifacts: join(root, "workspace", "artifacts"),
		decisions: join(root, "workspace", "decisions"),
		ledger: join(root, "workspace", "ledger.jsonl"),
		run: join(root, "run"),
		image: join(root, "image"),
		bridge: join(root, "image", "bridge"),
	};
}

/** Write JSON atomically: temp file, fsync, rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirnameOf(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o644 });
	const handle = openSync(temp, "r");
	try {
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
	renameSync(temp, path);
}

function dirnameOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "." : path.slice(0, index);
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function listJsonFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(dir, name))
		.sort();
}

export class WorkspaceStore {
	readonly paths: WorkspacePaths;
	#sequence: number;

	constructor(root: string) {
		this.paths = workspacePaths(root);
		for (const dir of [
			this.paths.profiles,
			this.paths.roles,
			this.paths.prompts,
			this.paths.instances,
			this.paths.worktrees,
			this.paths.tasks,
			this.paths.messages,
			this.paths.reviews,
			this.paths.artifacts,
			this.paths.decisions,
			this.paths.run,
			this.paths.image,
			this.paths.bridge,
		]) {
			mkdirSync(dir, { recursive: true });
		}
		// run/ holds the bus socket and must not be group/other accessible.
		chmodSync(this.paths.run, 0o700);
		this.#sequence = readJson<{ next: number }>(join(this.paths.workspace, SEQ_FILE))?.next ?? 1;
	}

	get sequence(): number {
		return this.#sequence;
	}

	/** Allocate one globally ordered sequence number. Persisted so ordering survives restarts. */
	nextSequence(): number {
		const value = this.#sequence++;
		writeJsonAtomic(join(this.paths.workspace, SEQ_FILE), { next: this.#sequence });
		return value;
	}

	// -- fleet manifest -----------------------------------------------------

	readManifest(): FleetManifest | undefined {
		return readJson<FleetManifest>(this.paths.state);
	}

	writeManifest(manifest: FleetManifest): void {
		writeJsonAtomic(this.paths.state, manifest);
	}

	// -- instances ----------------------------------------------------------

	instancePath(instanceId: string): string {
		return join(this.paths.instances, instanceId, "instance.json");
	}

	instanceDir(instanceId: string): string {
		return join(this.paths.instances, instanceId);
	}

	writeInstance(instance: InstanceRecord): void {
		mkdirSync(this.instanceDir(instance.id), { recursive: true, mode: 0o700 });
		writeJsonAtomic(this.instancePath(instance.id), instance);
		// The token authenticates this instance to the bus; keep it unreadable to others.
		chmodSync(this.instancePath(instance.id), 0o600);
	}

	readInstance(instanceId: string): InstanceRecord | undefined {
		return readJson<InstanceRecord>(this.instancePath(instanceId));
	}

	listInstances(): InstanceRecord[] {
		if (!existsSync(this.paths.instances)) return [];
		const out: InstanceRecord[] = [];
		for (const name of readdirSync(this.paths.instances).sort()) {
			const instance = readJson<InstanceRecord>(join(this.paths.instances, name, "instance.json"));
			if (instance) out.push(instance);
		}
		return out;
	}

	// -- tasks --------------------------------------------------------------

	taskPath(taskId: string): string {
		return join(this.paths.tasks, `${taskId}.json`);
	}

	writeTask(task: Task): void {
		writeJsonAtomic(this.taskPath(task.id), task);
	}

	readTask(taskId: string): Task | undefined {
		return readJson<Task>(this.taskPath(taskId));
	}

	listTasks(): Task[] {
		const out: Task[] = [];
		for (const path of listJsonFiles(this.paths.tasks)) {
			const task = readJson<Task>(path);
			if (task) out.push(task);
		}
		return out.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
	}

	// -- messages -----------------------------------------------------------

	messageFileName(seq: number, id: string): string {
		return `${String(seq).padStart(10, "0")}-${id}.json`;
	}

	writeMessage(message: BusMessage): void {
		writeJsonAtomic(join(this.paths.messages, this.messageFileName(message.seq, message.id)), message);
	}

	readMessage(messageId: string): BusMessage | undefined {
		for (const path of listJsonFiles(this.paths.messages)) {
			if (basename(path).endsWith(`-${messageId}.json`)) return readJson<BusMessage>(path);
		}
		return undefined;
	}

	listMessages(sinceSeq = 0): BusMessage[] {
		const out: BusMessage[] = [];
		for (const path of listJsonFiles(this.paths.messages)) {
			const message = readJson<BusMessage>(path);
			if (message && message.seq > sinceSeq) out.push(message);
		}
		return out.sort((a, b) => a.seq - b.seq);
	}

	/**
	 * Per-instance durable inbox. A message stays here until explicitly acked, so a bridge
	 * restart (or a container restart) redelivers exactly the unacked set.
	 */
	inboxDir(instanceId: string): string {
		return join(this.paths.instances, instanceId, "inbox");
	}

	inboxPut(instanceId: string, message: BusMessage): void {
		const dir = this.inboxDir(instanceId);
		mkdirSync(dir, { recursive: true });
		writeJsonAtomic(join(dir, `${String(message.seq).padStart(10, "0")}-${message.id}.json`), message);
	}

	inboxList(instanceId: string): BusMessage[] {
		const out: BusMessage[] = [];
		for (const path of listJsonFiles(this.inboxDir(instanceId))) {
			const message = readJson<BusMessage>(path);
			if (message) out.push(message);
		}
		return out.sort((a, b) => a.seq - b.seq);
	}

	inboxRemove(instanceId: string, messageId: string): boolean {
		const dir = this.inboxDir(instanceId);
		if (!existsSync(dir)) return false;
		for (const name of readdirSync(dir)) {
			if (name.endsWith(`-${messageId}.json`)) {
				rmSync(join(dir, name), { force: true });
				return true;
			}
		}
		return false;
	}

	// -- reviews ------------------------------------------------------------

	writeReview(review: Review): void {
		writeJsonAtomic(join(this.paths.reviews, `${review.id}.json`), review);
	}

	readReview(reviewId: string): Review | undefined {
		return readJson<Review>(join(this.paths.reviews, `${reviewId}.json`));
	}

	listReviews(taskId?: string): Review[] {
		const out: Review[] = [];
		for (const path of listJsonFiles(this.paths.reviews)) {
			const review = readJson<Review>(path);
			if (review && (taskId === undefined || review.taskId === taskId)) out.push(review);
		}
		return out.sort((a, b) => a.seq - b.seq);
	}

	// -- artifacts ----------------------------------------------------------

	artifactDir(artifactId: string): string {
		return join(this.paths.artifacts, artifactId);
	}

	writeArtifactManifest(manifest: ArtifactManifest): void {
		mkdirSync(this.artifactDir(manifest.id), { recursive: true });
		writeJsonAtomic(join(this.artifactDir(manifest.id), "manifest.json"), manifest);
	}

	readArtifactManifest(artifactId: string): ArtifactManifest | undefined {
		return readJson<ArtifactManifest>(join(this.artifactDir(artifactId), "manifest.json"));
	}

	// -- decisions ----------------------------------------------------------

	writeDecision(kind: string, by: string, summary: string, detail?: unknown): Decision {
		const seq = this.nextSequence();
		const decision: Decision = {
			id: `dec_${randomUUID().slice(0, 8)}`,
			seq,
			at: new Date().toISOString(),
			by,
			kind,
			summary,
			detail,
		};
		writeJsonAtomic(
			join(this.paths.decisions, `${String(seq).padStart(10, "0")}-${decision.id}.json`),
			decision,
		);
		this.appendLedger({ at: decision.at, kind: `decision.${kind}`, by, summary });
		return decision;
	}

	// -- ledger -------------------------------------------------------------

	appendLedger(entry: Omit<LedgerEntry, "at"> & { at?: string }): void {
		const line = `${JSON.stringify({ at: entry.at ?? new Date().toISOString(), ...entry })}\n`;
		appendFileSync(this.paths.ledger, line, { encoding: "utf8" });
	}

	readLedger(limit = 200): LedgerEntry[] {
		if (!existsSync(this.paths.ledger)) return [];
		const lines = readFileSync(this.paths.ledger, "utf8").split("\n").filter((line) => line.trim());
		const out: LedgerEntry[] = [];
		for (const line of lines.slice(-limit)) {
			try {
				out.push(JSON.parse(line) as LedgerEntry);
			} catch {
				// A torn trailing line is dropped, matching pi's own session reader behaviour.
			}
		}
		return out;
	}
}

export function sha256Of(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
