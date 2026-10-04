/**
 * TmuxBackend — the terminal plane.
 *
 * Runs a PRIVATE tmux server (`tmux -L multy-<uid>`) so we never fight the operator's own
 * sessions. One window per subharness; each window's pane runs the container backend's
 * attachCommand, so pi itself lives in the container and podman holds its PTY (PLAN.md §2.3,
 * verified in Spike 6 Option C).
 *
 * tmux is presentation only: killing it must never kill a subharness. Verified — after
 * `tmux kill-server` the containers were still running with pi alive.
 *
 * Configuration pi explicitly checks for (pi/packages/coding-agent/src/modes/interactive/
 * interactive-mode.ts:1168-1310): `extended-keys on` + `extended-keys-format csi-u`. Without
 * them pi warns that modified Enter keys may not work.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface PaneSpec {
	window: string;
	command: string;
	cols: number;
	rows: number;
	title?: string;
	pipeToFile?: string;
}

export interface WindowInfo {
	name: string;
	active: boolean;
	paneTitle: string;
	paneDead: boolean;
}

export interface TmuxBackendOptions {
	binary?: string;
	socketName: string;
	/** Extra search locations when tmux is not on PATH (it is not, on this machine). */
	searchPaths?: string[];
}

const DEFAULT_SEARCH_PATHS = [
	"/home/linuxbrew/.linuxbrew/bin/tmux",
	"/opt/homebrew/bin/tmux",
	"/usr/local/bin/tmux",
	"/usr/bin/tmux",
];

export function resolveTmuxBinary(explicit?: string, searchPaths: string[] = DEFAULT_SEARCH_PATHS): string | undefined {
	if (explicit) return existsSync(explicit) ? explicit : undefined;
	for (const candidate of searchPaths) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function run(binary: string, args: string[], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let settled = false;
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			resolve({ code, out });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(-1);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			out += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			out += chunk;
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

export class TmuxBackend {
	readonly kind = "tmux";
	readonly socketName: string;
	private readonly binary: string | undefined;
	private readonly searchPaths: string[];
	private serverReady = false;

	constructor(options: TmuxBackendOptions) {
		this.socketName = options.socketName;
		this.searchPaths = options.searchPaths ?? DEFAULT_SEARCH_PATHS;
		this.binary = resolveTmuxBinary(options.binary, this.searchPaths);
	}

	get binaryPath(): string | undefined {
		return this.binary;
	}

	async isAvailable(): Promise<boolean> {
		return this.binary !== undefined;
	}

	requireBinary(): string {
		if (!this.binary) {
			throw new Error(
				`tmux not found. Searched PATH and: ${this.searchPaths.join(", ")}. Install it (brew install tmux) or set terminal.binary.`,
			);
		}
		return this.binary;
	}

	private tmux(args: string[], timeoutMs?: number): Promise<{ code: number; out: string }> {
		return run(this.requireBinary(), ["-L", this.socketName, ...args], timeoutMs);
	}

	async version(): Promise<string> {
		const result = await this.tmux(["-V"]);
		return result.code === 0 ? result.out.trim() : "";
	}

	/** Start the private server if needed and apply fleet-wide options once. */
	async ensureServer(): Promise<void> {
		if (this.serverReady) return;
		const listed = await this.tmux(["list-sessions", "-F", "#{session_name}"]);
		if (listed.code !== 0) {
			const created = await this.tmux([
				"new-session",
				"-d",
				"-s",
				"fleet",
				"-x",
				"130",
				"-y",
				"42",
				"sleep infinity",
			]);
			if (created.code !== 0) throw new Error(`failed to start tmux server: ${created.out.trim()}`);
		}
		// pi probes these and warns when they are missing (docs/tmux.md).
		for (const [option, value] of [
			["extended-keys", "on"],
			["extended-keys-format", "csi-u"],
			["mouse", "on"],
			["history-limit", "50000"],
			["allow-rename", "on"],
			["status-left", "[multi-pi] "],
		] as const) {
			await this.tmux(["set", "-g", option, value]);
		}
		this.serverReady = true;
	}

	async openWindow(spec: PaneSpec): Promise<void> {
		await this.ensureServer();
		// tmux's new-window takes no -x/-y (only new-session does), so create the window and then
		// size it. window-size must be "manual" or tmux resizes the window to fit whatever client
		// attaches, which would change pi's column count out from under it.
		const args = ["new-window", "-d", "-n", spec.window, "-t", "fleet", spec.command];
		const result = await this.tmux(args, 30_000);
		if (result.code !== 0) throw new Error(`tmux new-window failed for ${spec.window}: ${result.out.trim()}`);
		await this.setWindowOption(spec.window, "automatic-rename", "off");
		await this.setWindowOption(spec.window, "window-size", "manual");
		await this.resize(spec.window, spec.cols, spec.rows);
		if (spec.pipeToFile) {
			// Redundant terminal record alongside PI_TUI_WRITE_LOG (PLAN.md §2.8).
			await this.tmux(["pipe-pane", "-t", target(spec.window), "-o", `cat >> ${spec.pipeToFile}`]);
		}
	}

	async listWindows(): Promise<WindowInfo[]> {
		const result = await this.tmux([
			"list-windows",
			"-t",
			"fleet",
			"-F",
			"#{window_name}\t#{window_active}\t#{pane_title}\t#{pane_dead}",
		]);
		if (result.code !== 0) return [];
		return result.out
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => {
				const [name = "", active = "", paneTitle = "", paneDead = ""] = line.split("\t");
				return {
					name,
					active: active === "1",
					paneTitle,
					paneDead: paneDead === "1",
				};
			});
	}

	async capture(window: string, scrollback = false): Promise<string> {
		const args = ["capture-pane", "-p", "-t", target(window)];
		if (scrollback) args.push("-S", "-");
		const result = await this.tmux(args, 20_000);
		return result.code === 0 ? result.out : "";
	}

	async sendKeys(window: string, keys: string, enter = true): Promise<void> {
		await this.tmux(["send-keys", "-t", target(window), keys]);
		if (enter) await this.tmux(["send-keys", "-t", target(window), "Enter"]);
	}

	async focus(window: string): Promise<void> {
		await this.tmux(["select-window", "-t", target(window)]);
	}

	async resize(window: string, cols: number, rows: number): Promise<void> {
		// Best effort: a window that cannot be resized is still usable, it just renders narrower.
		await this.tmux(["resize-window", "-t", target(window), "-x", String(cols), "-y", String(rows)]);
	}

	async setWindowOption(window: string, option: string, value: string): Promise<void> {
		await this.tmux(["set-window-option", "-t", target(window), option, value]);
	}

	async closeWindow(window: string): Promise<void> {
		await this.tmux(["kill-window", "-t", target(window)]);
	}

	async tiled(): Promise<void> {
		await this.tmux(["select-layout", "-t", "fleet", "tiled"]);
	}

	/** Split the fleet session into panes, one per window, for watching everything at once. */
	async buildTiledSession(windows: string[], cols: number, rows: number): Promise<string> {
		await this.ensureServer();
		const sessionName = "tiled";
		await this.tmux(["kill-session", "-t", sessionName]);
		const created = await this.tmux([
			"new-session",
			"-d",
			"-s",
			sessionName,
			"-x",
			String(cols),
			"-y",
			String(rows),
			"sleep infinity",
		]);
		if (created.code !== 0) throw new Error(`failed to create tiled session: ${created.out.trim()}`);
		for (const window of windows) {
			const info = await this.tmux(["list-windows", "-t", sessionName, "-F", "#{window_index}"]);
			const indices = info.out.split("\n").filter((line) => line.trim());
			const isFirst = indices.length <= 1;
			const command = `tmux -L ${this.socketName} attach -t ${shellQuote(`fleet:${window}`)}`;
			if (isFirst) {
				await this.tmux(["send-keys", "-t", `${sessionName}:0`, command, "Enter"]);
			} else {
				await this.tmux(["split-window", "-t", sessionName, command]);
				await this.tmux(["select-layout", "-t", sessionName, "tiled"]);
			}
		}
		await this.tmux(["select-layout", "-t", sessionName, "tiled"]);
		return sessionName;
	}

	async killServer(): Promise<void> {
		await this.tmux(["kill-server"]);
		this.serverReady = false;
	}

	/**
	 * Command an operator can paste into ANY terminal to attach to the whole fleet.
	 * This is the documented manual escape hatch (PLAN.md Phase 6.3).
	 */
	manualAttachCommand(): string {
		return `${this.binary ?? "tmux"} -L ${this.socketName} attach -t fleet`;
	}
}

function target(window: string): string {
	return `fleet:${window}`;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}
