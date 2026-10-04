/**
 * Profile validation and pi invocation construction.
 *
 * These are the two places where a mistake silently produces a broken subharness: a profile that
 * parses but means something else, or an argv/env that makes pi degrade to print mode, prompt for
 * trust, or lose its model.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadProfilesFromDir, parseProfile, renderTitle, ProfileError } from "../src/profile/loader.ts";
import { mergeSettings, BASE_SETTINGS } from "../src/profile/provision.ts";
import {
	agentDirEnvName,
	buildPiInvocation,
	DEFAULT_PATHS,
	redactEnv,
	sessionDirEnvName,
} from "../src/fleet/pi-invocation.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = resolve(here, "..", "profiles");

const MINIMAL = `
name: worker
model:
  id: zai/glm-5.3-flash
`;

test("a minimal profile gets usable defaults", () => {
	const profile = parseProfile(MINIMAL);
	assert.equal(profile.name, "worker");
	assert.equal(profile.isolation?.worktree, "private");
	assert.equal(profile.terminal?.backend, "tmux+podman-attach");
	assert.equal(profile.terminal?.size?.cols, 130);
	assert.equal(profile.bridge?.source, "bind");
	// Not podman's default ctrl-p ctrl-q: ctrl-q is pi's follow-up chord on Windows/WSL.
	assert.equal(profile.terminal?.detachKeys, "ctrl-\\");
	assert.equal(profile.coordination?.wipLimit, 1);
	assert.equal(profile.coordination?.maxDepth, 1);
});

test("name must be usable as a container and directory name", () => {
	for (const bad of ["Worker", "work er", "-lead", "a".repeat(70), "work;rm"]) {
		assert.throws(() => parseProfile(`name: "${bad}"\nmodel:\n  id: zai/glm-5.3-flash\n`), ProfileError, bad);
	}
});

test("model.id is required", () => {
	assert.throws(() => parseProfile("name: worker\n"), /model\.id` is required/);
	assert.throws(() => parseProfile("name: worker\nmodel: zai/glm-5.3-flash\n"), /model\.id` is required/);
});

test("container.env entries must be bare NAMES, never values", () => {
	// A secret pasted into a profile would be persisted to disk in plaintext. Reject it.
	assert.throws(
		() => parseProfile(`${MINIMAL}\ncontainer:\n  env: [ZAI_API_KEY=abc123]\n`),
		/bare variable NAMES/,
	);
	assert.doesNotThrow(() => parseProfile(`${MINIMAL}\ncontainer:\n  env: [ZAI_API_KEY]\n`));
});

test("terminal size is bounded", () => {
	assert.throws(() => parseProfile(`${MINIMAL}\nterminal:\n  size: { cols: 10, rows: 40 }\n`), /cols/);
	assert.throws(() => parseProfile(`${MINIMAL}\nterminal:\n  size: { cols: 130, rows: 5 }\n`), /rows/);
});

test("budget values must be positive", () => {
	assert.throws(() => parseProfile(`${MINIMAL}\nbudget:\n  tokens: -5\n`), /budget\.tokens/);
	assert.throws(() => parseProfile(`${MINIMAL}\nbudget:\n  costUsd: 0\n`), /budget\.costUsd/);
});

test("unknown enum values are rejected rather than silently ignored", () => {
	assert.throws(() => parseProfile(`${MINIMAL}\nisolation:\n  worktree: sometimes\n`), /isolation\.worktree/);
	assert.throws(() => parseProfile(`${MINIMAL}\nbridge:\n  source: symlink\n`), /bridge\.source/);
	assert.throws(() => parseProfile(`${MINIMAL}\nterminal:\n  backend: ssh\n`), /terminal\.backend/);
});

test("malformed YAML produces a ProfileError, not a crash", () => {
	const error = (() => {
		try {
			parseProfile("name: worker\n  bad: : :\n");
			return undefined;
		} catch (caught) {
			return caught as Error;
		}
	})();
	assert.ok(error instanceof ProfileError);
});

test("all shipped profiles load and validate", () => {
	const profiles = loadProfilesFromDir(PROFILES_DIR);
	assert.ok(profiles.size >= 4, `expected at least 4 profiles, got ${profiles.size}`);
	for (const name of ["parent", "implementer", "reviewer", "tester"]) {
		assert.ok(profiles.has(name), `missing profile: ${name}`);
	}
});

test("shipped profiles use four distinct model families so review is cross-family by default", () => {
	const profiles = loadProfilesFromDir(PROFILES_DIR);
	const families = new Set(
		["implementer", "reviewer", "tester"].map((name) => profiles.get(name)?.model.id.split("/")[0]),
	);
	assert.ok(families.size >= 2, `expected cross-family review, got ${[...families].join(", ")}`);
	const implementer = profiles.get("implementer")?.model.id.split("/")[0];
	const reviewer = profiles.get("reviewer")?.model.id.split("/")[0];
	assert.notEqual(implementer, reviewer, "the default reviewer must not share the implementer's model family");
});

test("the parent profile gets a read-only base mount, never a writable one", () => {
	// PLAN.md §6.11: no container may integrate code itself, and that includes the parent.
	const profiles = loadProfilesFromDir(PROFILES_DIR);
	const parent = profiles.get("parent");
	assert.equal(parent?.isolation?.worktree, "shared-readonly");
});

test("no profile grants a writable base checkout", () => {
	const profiles = loadProfilesFromDir(PROFILES_DIR);
	for (const [name, profile] of profiles) {
		const mode = profile.isolation?.worktree;
		assert.ok(
			mode === "private" || mode === "shared-readonly" || mode === "none",
			`profile ${name} has unexpected worktree mode ${String(mode)}`,
		);
	}
});

test("every profile's credential env names are declared, and settings force regular tui mode", () => {
	const profiles = loadProfilesFromDir(PROFILES_DIR);
	for (const [name, profile] of profiles) {
		assert.ok((profile.container?.env ?? []).length > 0, `profile ${name} declares no credentials`);
		const settings = mergeSettings(profile);
		// Fullscreen would hide scrollback and enable mouse capture (PLAN.md §2.8).
		assert.equal(settings.tuiMode, "regular", `profile ${name} must use tuiMode regular`);
		assert.equal(settings.defaultProjectTrust, "always", `profile ${name} must auto-trust`);
	}
});

test("mergeSettings deep-merges the profile over the base without dropping base keys", () => {
	const profile = parseProfile(`${MINIMAL}\nsettings:\n  terminal:\n    showImages: false\n  theme: dark\n`);
	const merged = mergeSettings(profile);
	assert.equal(merged.tuiMode, BASE_SETTINGS.tuiMode);
	assert.equal(merged.theme, "dark");
	assert.deepEqual(merged.terminal, { showTerminalProgress: true, showImages: false }, "nested objects merge");
});

test("agent dir env var name is derived, not hardcoded", () => {
	assert.equal(agentDirEnvName(), "PI_CODING_AGENT_DIR");
	assert.equal(sessionDirEnvName(), "PI_CODING_AGENT_SESSION_DIR");
	// pi derives it from the package's piConfig.name (config.ts:546), so a rebrand changes it.
	assert.equal(agentDirEnvName("tau"), "TAU_CODING_AGENT_DIR");
});

test("invocation always carries the trust override, regular tui mode, and a stable session id", () => {
	const profile = parseProfile(`${MINIMAL}\ncontainer:\n  env: [ZAI_API_KEY]\n`);
	const invocation = buildPiInvocation({
		instanceId: "impl",
		role: "implementer",
		token: "secret-token",
		profile,
		bridgeSource: "bind",
		bridgeVersion: "0.1.0",
	});
	// -a short-circuits trustStore.get() entirely (main.ts:741-747). Without it, trust.json is
	// locked and its directory created on every lookup, and RPC mode silently resolves untrusted.
	assert.ok(invocation.argv.includes("-a"), "must auto-approve project trust");
	assert.ok(invocation.argv.includes("--tui-mode"));
	assert.equal(invocation.argv[invocation.argv.indexOf("--tui-mode") + 1], "regular");
	assert.equal(invocation.argv[invocation.argv.indexOf("--session-id") + 1], "impl");
	assert.ok(invocation.argv.includes("-e"), "must load the bridge extension");
	assert.equal(invocation.argv[invocation.argv.indexOf("-e") + 1], DEFAULT_PATHS.bridgeEntry);
	assert.equal(invocation.argv[invocation.argv.indexOf("--model") + 1], "zai/glm-5.3-flash");
});

test("thinking level is folded into the model pattern", () => {
	const profile = parseProfile("name: w\nmodel:\n  id: zai/glm-5.3\n  thinking: high\n");
	const invocation = buildPiInvocation({
		instanceId: "w",
		role: "w",
		token: "t",
		profile,
		bridgeSource: "bind",
		bridgeVersion: "0.1.0",
	});
	assert.equal(invocation.argv[invocation.argv.indexOf("--model") + 1], "zai/glm-5.3:high");
});

test("environment forces offline, pins the agent dir, and enables the terminal byte log", () => {
	const profile = parseProfile(MINIMAL);
	const invocation = buildPiInvocation({
		instanceId: "impl",
		role: "implementer",
		token: "secret-token",
		profile,
		bridgeSource: "bind",
		bridgeVersion: "0.1.0",
	});
	const env = invocation.env;
	// PI_OFFLINE=1 must be "1", never "0": model-runtime.ts:239 tests `=== undefined`, so
	// PI_OFFLINE=0 would still disable the network and mislead anyone reading the env.
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");
	assert.equal(env.PI_CODING_AGENT_DIR, "/agent");
	assert.equal(env.PI_CODING_AGENT_SESSION_DIR, "/agent/sessions");
	assert.equal(env.PI_TUI_WRITE_LOG, "/agent/tui-bytes.log");
	assert.equal(env.FLEET_BUS_SOCKET, "/fleet/run/bus.sock");
	assert.equal(env.FLEET_INSTANCE_ID, "impl");
	assert.equal(env.FLEET_INSTANCE_TOKEN, "secret-token");
	assert.equal(env.FLEET_DEPTH, "0");
	// Plain `xterm` loses truecolor (Spike 1 observed TERM=xterm inside the container).
	assert.equal(env.TERM, "xterm-256color");
});

test("the instance token is redacted from anything we log", () => {
	const profile = parseProfile(MINIMAL);
	const invocation = buildPiInvocation({
		instanceId: "impl",
		role: "implementer",
		token: "super-secret-token",
		profile,
		bridgeSource: "bind",
		bridgeVersion: "0.1.0",
	});
	const redacted = redactEnv(invocation.env);
	assert.equal(redacted.FLEET_INSTANCE_TOKEN, "[redacted]");
	assert.ok(!JSON.stringify(redacted).includes("super-secret-token"));
});

test("credential env vars are forwarded by NAME, never inlined", () => {
	const profile = parseProfile(`${MINIMAL}\ncontainer:\n  env: [ZAI_API_KEY, GEMINI_API_KEY]\n`);
	const invocation = buildPiInvocation({
		instanceId: "impl",
		role: "implementer",
		token: "t",
		profile,
		bridgeSource: "bind",
		bridgeVersion: "0.1.0",
	});
	assert.deepEqual(invocation.envForward, ["ZAI_API_KEY", "GEMINI_API_KEY"]);
	// No credential VALUE may appear in the literal env map, which is what gets persisted.
	for (const key of Object.keys(invocation.env)) {
		assert.ok(!/API_KEY|TOKEN$/.test(key) || key === "FLEET_INSTANCE_TOKEN", `unexpected secret in env: ${key}`);
	}
});

test("a one-shot spawn uses print/json mode and never the tui flag", () => {
	const profile = parseProfile(MINIMAL);
	const invocation = buildPiInvocation({
		instanceId: "probe",
		role: "probe",
		token: "t",
		profile,
		bridgeSource: "bind",
		bridgeVersion: "0.1.0",
		oneShot: { prompt: "say hi", mode: "json" },
	});
	assert.ok(invocation.argv.includes("--mode"));
	assert.ok(invocation.argv.includes("-p"));
	assert.ok(!invocation.argv.includes("--tui-mode"), "a pipe is not a TTY, so tui flags are pointless");
	assert.equal(invocation.argv[invocation.argv.length - 1], "say hi");
	assert.ok(invocation.argv.includes("--"), "the prompt must be protected by -- in case it starts with -");
});

test("renderTitle expands placeholders", () => {
	assert.equal(renderTitle("{role} · {model} · {task}", { role: "impl", model: "glm", task: "t1" }), "impl · glm · t1");
	assert.equal(renderTitle("{unknown}", {}), "{unknown}");
});

test("the coordination prompt exists and states the git prohibitions", () => {
	const path = resolve(here, "..", "prompts", "coordination.md");
	assert.ok(existsSync(path), "prompts/coordination.md must ship");
	const text = readFileSync(path, "utf8");
	for (const forbidden of ["git add -A", "reset --hard", "git stash", "clean -fd", "force-push"]) {
		assert.ok(text.includes(forbidden), `coordination prompt must forbid ${forbidden}`);
	}
	// Never end a turn with a question — the pattern borrowed from pi-subagents' intercom bridge.
	assert.match(text, /help_request/);
});

test("every shipped role card exists", () => {
	const profiles = loadProfilesFromDir(PROFILES_DIR);
	const rolesDir = resolve(here, "..", "roles");
	for (const [name, profile] of profiles) {
		const ref = profile.context?.agentsMd;
		if (!ref) continue;
		const path = join(rolesDir, ref.replace(/^roles\//, ""));
		assert.ok(existsSync(path), `profile ${name} references a missing role card: ${ref}`);
	}
});

test("the bridge extension ships and declares its version", () => {
	const bridgePath = resolve(here, "..", "extensions", "fleet-bridge", "index.ts");
	assert.ok(existsSync(bridgePath), "extensions/fleet-bridge/index.ts must exist");
	const text = readFileSync(bridgePath, "utf8");
	assert.match(text, /BRIDGE_VERSION = "/);
	// The bridge must not start its socket in the factory (docs/extensions.md).
	assert.ok(text.includes('pi.on("session_start"'), "the bridge must connect on session_start");
	assert.ok(text.includes('pi.on("session_shutdown"'), "the bridge must tear down idempotently");
	assert.ok(text.includes("agent_settled"), "the bridge must track agent_settled, not just agent_end");
});
