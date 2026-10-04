/**
 * Instance provisioning: turn a profile into a concrete, isolated agent directory.
 *
 * pi reads everything per-user from PI_CODING_AGENT_DIR (pi/src/config.ts:566, docs/configuration.md),
 * so a private agent dir per instance gives us isolated settings, sessions, trust, caches,
 * extensions and logs in one move.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Profile } from "./loader.ts";
import { chmodSync } from "node:fs";

export interface ProvisionInput {
	instanceId: string;
	role: string;
	profile: Profile;
	/** Host path of <fleet>/instances/<id>/agent. Bind-mounted at /agent. */
	agentDir: string;
	/** Host dir holding the bridge extension source. */
	bridgeSourceDir: string;
	bridgeSource: "bind" | "bake";
	/** Host dir holding shared roles/ and prompts/ referenced by the profile. */
	resourcesDir: string;
}

export interface ProvisionResult {
	agentDir: string;
	settingsPath: string;
	written: string[];
}

/**
 * Default settings every instance gets before the profile's own `settings` block is merged on top.
 *
 *   tuiMode regular              main-screen rendering; scrollback survives, no mouse capture
 *   showTerminalProgress true    OSC 9;4 busy/idle on the wire (off by default in pi)
 *   defaultProjectTrust always   belt-and-braces behind `-a`
 *   quietStartup "header"        keeps the version line, drops the resource listing
 */
export const BASE_SETTINGS: Record<string, unknown> = {
	tuiMode: "regular",
	quietStartup: "header",
	defaultProjectTrust: "always",
	terminal: { showTerminalProgress: true },
	compaction: { enabled: true },
	retry: { enabled: true, maxRetries: 3 },
};

export function mergeSettings(profile: Profile): Record<string, unknown> {
	return deepMerge(BASE_SETTINGS, profile.settings ?? {});
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = out[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			out[key] = deepMerge(existing, value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeText(path: string, content: string, mode = 0o644): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, { encoding: "utf8", mode });
}

function resolveResource(resourcesDir: string, reference: string): string | undefined {
	const candidate = reference.startsWith("/") ? reference : join(resourcesDir, reference);
	return existsSync(candidate) ? candidate : undefined;
}

export function provisionInstance(input: ProvisionInput): ProvisionResult {
	const { agentDir, profile } = input;
	const written: string[] = [];

	// A fresh agent dir avoids inheriting anything from a previous run of the same instance id.
	if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });

	// settings.json
	const settingsPath = join(agentDir, "settings.json");
	writeText(settingsPath, `${JSON.stringify(mergeSettings(profile), null, "\t")}\n`);
	written.push(settingsPath);

	// The model is set through settings so a restart without --model still lands on it.
	const [provider, ...rest] = profile.model.id.split("/");
	if (provider && rest.length > 0) {
		const withDefaults = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		withDefaults.defaultProvider = provider;
		withDefaults.defaultModel = rest.join("/");
		if (profile.model.thinking) withDefaults.defaultThinkingLevel = profile.model.thinking;
		writeText(settingsPath, `${JSON.stringify(withDefaults, null, "\t")}\n`);
	}

	// Role card -> AGENTS.md. pi loads this as user-level context (docs/configuration.md).
	const agentsDir = join(agentDir, "AGENTS.md");
	const roleSource = profile.context?.agentsMd ? resolveResource(input.resourcesDir, profile.context.agentsMd) : undefined;
	const coordination = profile.context?.appendSystem
		? resolveResource(input.resourcesDir, profile.context.appendSystem)
		: undefined;
	writeText(
		agentsDir,
		[
			`# Role: ${input.role} (instance ${input.instanceId})`,
			"",
			profile.description ?? "",
			"",
			roleSource ? readFileSync(roleSource, "utf8") : "",
		]
			.join("\n")
			.trim(),
	);
	written.push(agentsDir);

	// Coordination protocol -> APPEND_SYSTEM.md, so it augments rather than replaces pi's prompt.
	if (coordination) {
		const appendPath = join(agentDir, "APPEND_SYSTEM.md");
		writeText(appendPath, readFileSync(coordination, "utf8"));
		written.push(appendPath);
	}

	// Sessions live inside the agent dir by default; make it explicit so --continue can never
	// pick up another instance's session (PLAN.md §1.4).
	mkdirSync(join(agentDir, "sessions"), { recursive: true });

	// Skills and themes referenced by the profile.
	for (const skill of profile.context?.skills ?? []) {
		const source = resolveResource(input.resourcesDir, skill);
		if (!source) continue;
		const target = join(agentDir, "skills", skill.split("/").pop() ?? "skill.md");
		mkdirSync(dirname(target), { recursive: true });
		cpSync(source, target, { recursive: true });
		written.push(target);
	}

	// The bridge extension. In `bind` mode it is mounted fresh from the host on every start, so
	// editing it needs no rebuild; in `bake` mode the image's copy is authoritative and we must
	// NOT shadow it with a host copy.
	if (input.bridgeSource === "bind") {
		const target = join(agentDir, "extensions", "fleet-bridge");
		mkdirSync(dirname(target), { recursive: true });
		if (existsSync(input.bridgeSourceDir)) {
			cpSync(input.bridgeSourceDir, target, { recursive: true });
			written.push(target);
		}
	} else {
		// Record which source is in use so the daemon can refuse a mixed fleet.
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
	}
	writeText(join(agentDir, "BRIDGE_SOURCE"), `${input.bridgeSource}\n`);

	// The agent dir holds the instance token's neighbours and session transcripts.
	chmodSync(agentDir, 0o700);

	return { agentDir, settingsPath, written };
}

/** Write the per-instance token file the daemon reads for bus authentication. */
export function writeTokenFile(instanceDir: string, token: string): string {
	const path = join(instanceDir, "token");
	writeText(path, `${token}\n`, 0o600);
	chmodSync(path, 0o600);
	return path;
}

/**
 * Symlink a shared credential store into the instance agent dir.
 *
 * Not used by default on this machine: auth.json is empty and credentials are env vars forwarded
 * by NAME. Kept for deployments that do use auth.json. pi's AuthStorage serialises writes with
 * proper-lockfile (auth-storage.ts:114-155), so concurrent readers are safe but contended.
 */
export function linkSharedAuth(agentDir: string, hostAuthJson: string): boolean {
	if (!existsSync(hostAuthJson)) return false;
	const target = join(agentDir, "auth.json");
	try {
		symlinkSync(hostAuthJson, target);
		return true;
	} catch {
		return false;
	}
}
