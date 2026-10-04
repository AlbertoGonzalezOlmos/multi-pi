/**
 * Durable domain types for the shared workspace.
 *
 * The workspace is the source of truth (PLAN.md §2.7): plain files under <fleet>/workspace,
 * bind-mounted read-write into every container at /fleet/workspace. A subharness can inspect
 * all of it with its ordinary read/grep/ls tools, and the fleet can be reconstructed from it
 * after a daemon restart.
 */

import type { MessageKind, ReviewVerdict, TaskBudget, TaskSpent, TaskStatus } from "../bus/protocol.ts";

export interface Task {
	id: string;
	title: string;
	body: string;
	createdBy: string;
	assignee?: string;
	status: TaskStatus;
	/** Lower is more urgent. */
	priority: number;
	priorityReason?: string;
	dependsOn: string[];
	blocks: string[];
	labels: string[];
	artifacts: string[];
	reviews: string[];
	lease?: TaskLease;
	budget?: TaskBudget;
	spent: TaskSpent;
	merge?: MergeState;
	history: TaskHistoryEntry[];
	seq: number;
	createdAt: string;
	updatedAt: string;
}

export interface TaskLease {
	holder: string;
	expiresAt: string;
}

export interface TaskHistoryEntry {
	at: string;
	by: string;
	from: TaskStatus;
	to: TaskStatus;
	note?: string;
}

export type MergePhase = "pending" | "queued" | "held" | "merged" | "conflict" | "reverted" | "not_applicable";

export interface MergeState {
	state: MergePhase;
	branch: string;
	preMergeSha?: string;
	mergeSha?: string;
	holdReason?: string;
	attempts: number;
	updatedAt?: string;
}

export interface BusMessage {
	id: string;
	seq: number;
	from: string;
	to: string;
	kind: MessageKind;
	subject?: string;
	body: string;
	artifacts: string[];
	requiresAck: boolean;
	ackedBy: string[];
	replyTo?: string;
	postedAt: string;
	hops: number;
}

export interface Review {
	id: string;
	taskId: string;
	authorInstanceId: string;
	reviewerInstanceId?: string;
	/** Recorded so we can later measure whether cross-family review catches more. */
	reviewerModel?: string;
	verdict?: ReviewVerdict;
	findings?: string;
	artifactId?: string;
	requestedAt: string;
	submittedAt?: string;
	seq: number;
}

export interface ArtifactManifest {
	id: string;
	createdBy: string;
	createdAt: string;
	taskId?: string;
	kind: string;
	files: ArtifactFile[];
	note?: string;
}

export interface ArtifactFile {
	path: string;
	bytes: number;
	sha256?: string;
}

export interface Decision {
	id: string;
	seq: number;
	at: string;
	by: string;
	kind: string;
	summary: string;
	detail?: unknown;
}

export interface LedgerEntry {
	at: string;
	kind: string;
	instanceId?: string;
	taskId?: string;
	[key: string]: unknown;
}

export interface InstanceRecord {
	id: string;
	role: string;
	profile: string;
	model: string;
	containerName: string;
	paneTarget?: string;
	agentDir: string;
	workdir: string;
	worktreeMode: "none" | "private" | "shared-readonly";
	sessionId: string;
	pid?: number;
	state: "starting" | "idle" | "busy" | "unresponsive" | "stopped" | "crashed";
	lastHeartbeatAt?: string;
	lastActivityAt?: string;
	currentTaskId?: string;
	token: string;
	createdAt: string;
	budget?: TaskBudget;
	spent: TaskSpent;
	mergeState?: MergePhase;
}

export interface FleetManifest {
	id: string;
	createdAt: string;
	projectRoot: string;
	piBinary: string;
	piVersion: string;
	image: string;
	imageDigest?: string;
	tmuxBinary: string;
	tmuxSocketName: string;
	podmanBinary: string;
	bridgeSource: "bind" | "bake";
	bridgeVersion: string;
	merge: MergeConfig;
	defaultTarget: string;
}

export interface MergeConfig {
	auto: boolean;
	target: string;
	strategy: "rebase-then-no-ff";
	onConflict: "block-and-repair";
	requireVerifyLabel?: string;
}
