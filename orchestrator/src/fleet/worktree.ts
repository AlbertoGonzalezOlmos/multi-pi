/**
 * Git worktree management.
 *
 * Each writer gets a private worktree so concurrent subharnesses cannot stomp on each other.
 * Pi's own AGENTS.md states the reason bluntly: multiple pi sessions in one cwd destroy each
 * other's work, and `git add -A` / `reset --hard` / `stash` / `clean -fd` are unrecoverable.
 *
 * Non-writers (reviewer, scout) and the parent mount the base tree READ-ONLY, so no model can
 * integrate code by itself — only the host-side merge lane can (PLAN.md §6.11).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			resolve({ code, stdout, stderr });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(-1);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", () => {
			clearTimeout(timer);
			finish(-1);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish(code ?? -1);
		});
	});
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	return result.stdout.trim();
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (result.code !== 0) return undefined;
	const branch = result.stdout.trim();
	return branch === "HEAD" ? undefined : branch;
}

export async function headSha(cwd: string): Promise<string | undefined> {
	const result = await git(cwd, ["rev-parse", "HEAD"]);
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Paths with uncommitted changes, including untracked files. Empty means clean. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
	const result = await git(cwd, ["status", "--porcelain"]);
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => line.slice(3).trim().replace(/^"|"$/g, ""))
		// A rename shows as "old -> new"; we care about both sides.
		.flatMap((entry) => (entry.includes(" -> ") ? entry.split(" -> ") : [entry]));
}

export async function isClean(cwd: string): Promise<boolean> {
	return (await dirtyPaths(cwd)).length === 0;
}

/** Files changed on `branch` relative to `base`, used by the merge lane's dirty-base check. */
export async function changedFiles(cwd: string, base: string, branch: string): Promise<string[]> {
	const result = await git(cwd, ["diff", "--name-only", `${base}...${branch}`]);
	if (result.code !== 0) return [];
	return result.stdout.split("\n").filter((line) => line.trim().length > 0);
}

export interface WorktreeOptions {
	/** Host path of the main checkout. */
	baseDir: string;
	/** Host path where the new worktree is created. */
	path: string;
	branch: string;
	/** Branch to start from; defaults to the base checkout's current branch. */
	startPoint?: string;
}

export class WorktreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeError";
	}
}

/**
 * Create a private worktree. Refuses when the base has uncommitted changes, because a worktree
 * created from a dirty base silently carries no context about them and the operator loses track
 * of what is where.
 */
export async function createWorktree(options: WorktreeOptions): Promise<string> {
	const { baseDir, path, branch } = options;
	if (!(await isClean(baseDir))) {
		const dirty = await dirtyPaths(baseDir);
		throw new WorktreeError(
			`refusing to create worktree "${path}": base checkout ${baseDir} has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}). Commit or stash them first.`,
		);
	}
	const startPoint = options.startPoint ?? (await currentBranch(baseDir)) ?? "HEAD";
	const existing = await git(baseDir, ["rev-parse", "--verify", `refs/heads/${branch}`]);
	const args = existing.code === 0 ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, startPoint];
	const created = await git(baseDir, args, 120_000);
	if (created.code !== 0) {
		throw new WorktreeError(`git worktree add failed for ${path}: ${created.stderr.trim() || created.stdout.trim()}`);
	}
	return path;
}

export async function removeWorktree(baseDir: string, path: string, force = true): Promise<void> {
	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(path);
	await git(baseDir, args, 120_000);
	await git(baseDir, ["worktree", "prune"]);
}

export async function listWorktrees(baseDir: string): Promise<string[]> {
	const result = await git(baseDir, ["worktree", "list", "--porcelain"]);
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
}

/** True when a rebase or merge is half-finished in this worktree. */
export async function hasUnfinishedOperation(cwd: string): Promise<"rebase" | "merge" | undefined> {
	const gitDir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
	if (gitDir.code !== 0) return undefined;
	const root = gitDir.stdout.trim();
	if (existsSync(`${root}/rebase-merge`) || existsSync(`${root}/rebase-apply`)) return "rebase";
	if (existsSync(`${root}/MERGE_HEAD`)) return "merge";
	return undefined;
}

export async function abortUnfinishedOperation(cwd: string): Promise<void> {
	const pending = await hasUnfinishedOperation(cwd);
	if (pending === "rebase") await git(cwd, ["rebase", "--abort"]);
	else if (pending === "merge") await git(cwd, ["merge", "--abort"]);
}

export { gitOrThrow };
