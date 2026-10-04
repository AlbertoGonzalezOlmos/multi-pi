/**
 * Profile loading and validation.
 *
 * A profile is a declarative description of one kind of subharness (PLAN.md §3.5), deliberately
 * close to pi's own agent frontmatter (pi/packages/coding-agent/examples/extensions/subagent/
 * agents.ts) so pi users find it familiar, extended with what a persistent containerised
 * terminal instance needs.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type WorktreeMode = "none" | "private" | "shared-readonly";
export type TerminalBackendKind = "tmux+podman-attach" | "headless-rpc" | "none";

export interface ModelSpec {
	id: string;
	thinking?: string;
	fallbacks?: string[];
}

export interface ContainerSpec {
	image?: string;
	userns?: string;
	/** Credential env var names forwarded by NAME only — never written to disk. */
	env?: string[];
	limits?: { memory?: string; pids?: number; cpus?: string };
	extraArgs?: string[];
}

export interface TerminalSpec {
	backend?: TerminalBackendKind;
	size?: { cols: number; rows: number };
	detachKeys?: string;
	title?: string;
}

export interface CoordinationSpec {
	autoReview?: boolean;
	autoClaim?: boolean;
	wipLimit?: number;
	heartbeatSeconds?: number;
	maxDepth?: number;
}

export interface BudgetSpec {
	tokens?: number;
	costUsd?: number;
	wallMinutes?: number;
	maxTurns?: number;
}

export interface BridgeSpec {
	/** bind: mount from <fleet>/image/bridge; bake: use the copy built into the image. */
	source?: "bind" | "bake";
}

export interface Profile {
	name: string;
	description?: string;
	role?: string;
	model: ModelSpec;
	tools?: string[];
	/** Merged verbatim into the instance's settings.json. */
	settings?: Record<string, unknown>;
	context?: { agentsMd?: string; appendSystem?: string; skills?: string[] };
	container?: ContainerSpec;
	isolation?: { worktree?: WorktreeMode; agentDir?: "private" };
	terminal?: TerminalSpec;
	budget?: BudgetSpec;
	coordination?: CoordinationSpec;
	bridge?: BridgeSpec;
	/** File the profile was loaded from, for diagnostics. */
	sourcePath?: string;
}

/** Sensible defaults so a minimal profile (name + model) is usable. */
export const PROFILE_DEFAULTS = {
	isolation: { worktree: "private" as WorktreeMode, agentDir: "private" as const },
	terminal: {
		backend: "tmux+podman-attach" as TerminalBackendKind,
		size: { cols: 130, rows: 42 },
		// Not podman's default ctrl-p ctrl-q: ctrl-q is pi's follow-up chord on Windows/WSL.
		detachKeys: "ctrl-\\",
		title: "{role} · {model} · {task}",
	},
	container: { userns: "keep-id", env: [] as string[] },
	coordination: { wipLimit: 1, heartbeatSeconds: 20, maxDepth: 1, autoReview: false, autoClaim: false },
	bridge: { source: "bind" as const },
	budget: {} as BudgetSpec,
};

export class ProfileError extends Error {
	readonly sourcePath?: string;

	constructor(message: string, sourcePath?: string) {
		super(sourcePath ? `${sourcePath}: ${message}` : message);
		this.name = "ProfileError";
		this.sourcePath = sourcePath;
	}
}

export function parseProfile(text: string, sourcePath?: string): Profile {
	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (error) {
		throw new ProfileError(`invalid YAML: ${(error as Error).message}`, sourcePath);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new ProfileError("profile must be a mapping", sourcePath);
	}
	const source = raw as Record<string, unknown>;
	const name = source.name;
	if (typeof name !== "string" || name.trim().length === 0) {
		throw new ProfileError("`name` is required and must be a non-empty string", sourcePath);
	}
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
		throw new ProfileError(
			`name "${name}" must match ^[a-z0-9][a-z0-9._-]{0,63}$ (used as a container and directory name)`,
			sourcePath,
		);
	}
	const model = source.model;
	if (typeof model !== "object" || model === null || typeof (model as Record<string, unknown>).id !== "string") {
		throw new ProfileError("`model.id` is required, for example model: { id: zai/glm-5.3-flash }", sourcePath);
	}
	const profile = mergeDefaults(source as unknown as Profile);
	profile.sourcePath = sourcePath;
	validate(profile);
	return profile;
}

function mergeDefaults(source: Profile): Profile {
	return {
		...source,
		isolation: { ...PROFILE_DEFAULTS.isolation, ...(source.isolation ?? {}) },
		terminal: { ...PROFILE_DEFAULTS.terminal, ...(source.terminal ?? {}) },
		container: { ...PROFILE_DEFAULTS.container, ...(source.container ?? {}) },
		coordination: { ...PROFILE_DEFAULTS.coordination, ...(source.coordination ?? {}) },
		bridge: { ...PROFILE_DEFAULTS.bridge, ...(source.bridge ?? {}) },
		budget: { ...PROFILE_DEFAULTS.budget, ...(source.budget ?? {}) },
	};
}

function validate(profile: Profile): void {
	const where = profile.sourcePath;
	const worktree = profile.isolation?.worktree;
	if (worktree && !["none", "private", "shared-readonly"].includes(worktree)) {
		throw new ProfileError(`isolation.worktree must be none|private|shared-readonly, got "${worktree}"`, where);
	}
	const backend = profile.terminal?.backend;
	if (backend && !["tmux+podman-attach", "headless-rpc", "none"].includes(backend)) {
		throw new ProfileError(`terminal.backend must be tmux+podman-attach|headless-rpc|none, got "${backend}"`, where);
	}
	const bridgeSource = profile.bridge?.source;
	if (bridgeSource && !["bind", "bake"].includes(bridgeSource)) {
		throw new ProfileError(`bridge.source must be bind|bake, got "${bridgeSource}"`, where);
	}
	const size = profile.terminal?.size;
	if (size) {
		if (!Number.isInteger(size.cols) || size.cols < 40 || size.cols > 400) {
			throw new ProfileError(`terminal.size.cols must be an integer in 40..400, got ${size.cols}`, where);
		}
		if (!Number.isInteger(size.rows) || size.rows < 12 || size.rows > 200) {
			throw new ProfileError(`terminal.size.rows must be an integer in 12..200, got ${size.rows}`, where);
		}
	}
	const budget = profile.budget ?? {};
	for (const key of ["tokens", "costUsd", "wallMinutes", "maxTurns"] as const) {
		const value = budget[key];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
			throw new ProfileError(`budget.${key} must be a positive number, got ${String(value)}`, where);
		}
	}
	const limits = profile.container?.limits;
	if (limits?.pids !== undefined && (!Number.isInteger(limits.pids) || limits.pids < 16)) {
		throw new ProfileError(`container.limits.pids must be an integer >= 16, got ${String(limits.pids)}`, where);
	}
	// Credential env names are forwarded by name only; reject anything that looks like a value
	// so a secret can never be persisted into a profile file.
	for (const entry of profile.container?.env ?? []) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)) {
			throw new ProfileError(
				`container.env entries must be bare variable NAMES (values are forwarded from the host env, never stored), got "${entry}"`,
				where,
			);
		}
	}
}

export function loadProfile(path: string): Profile {
	if (!existsSync(path)) throw new ProfileError(`profile not found: ${path}`, path);
	return parseProfile(readFileSync(path, "utf8"), path);
}

export function loadProfilesFromDir(dir: string): Map<string, Profile> {
	const profiles = new Map<string, Profile>();
	if (!existsSync(dir)) return profiles;
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
		const profile = loadProfile(join(dir, name));
		const existing = profiles.get(profile.name);
		if (existing) {
			throw new ProfileError(
				`duplicate profile name "${profile.name}" (also defined in ${existing.sourcePath})`,
				profile.sourcePath,
			);
		}
		profiles.set(profile.name, profile);
	}
	return profiles;
}

/** Expand `{role}` / `{model}` / `{task}` placeholders in a terminal title template. */
export function renderTitle(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
