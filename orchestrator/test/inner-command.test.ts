/**
 * The in-container launch command.
 *
 * Two properties matter enough to test: the shell quoting (a task title or a path with a quote in
 * it must not break the wrapper or inject a command), and the wait loop (without it the container
 * reports "exited" while pi is still running, and the fleet manager's liveness signal becomes a
 * lie).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
	buildAttachCommand,
	buildInnerCommand,
	CONTAINER_BASE_ENV,
	INNER_SESSION,
	shellQuote,
} from "../src/container/inner-command.ts";
import { PI_BINARY_PATH } from "../src/fleet/pi-invocation.ts";

test("the wrapper starts pi inside a tmux session and then blocks on it", () => {
	const command = buildInnerCommand({ piArgv: ["-a", "--tui-mode", "regular"], cols: 130, rows: 42 });
	assert.match(command, /^tmux new-session -A -d -s pi /);
	// -A makes a container restart reattach rather than fail, so `podman start` resumes.
	assert.match(command, /new-session -A -d/);
	assert.match(command, /-x 130 -y 42/);
	// The wait loop is what makes container state a truthful liveness signal.
	assert.match(command, /while tmux has-session -t pi 2>\/dev\/null; do sleep 2; done$/);
	assert.match(command, /\/usr\/local\/bin\/pi/);
});

test("pi's argv is embedded as a single quoted tmux shell-command", () => {
	const command = buildInnerCommand({
		piArgv: ["-a", "--model", "zai/glm-5.3-flash:high", "--session-id", "impl"],
		cols: 130,
		rows: 42,
	});
	assert.ok(command.includes("'/usr/local/bin/pi -a --model zai/glm-5.3-flash:high --session-id impl'"));
});

test("shellQuote survives a real shell round trip, including a hostile quote", async () => {
	// This is the security boundary for argv: session names and task titles reach the container's
	// PID 1 command line. Test it by actually running the quoted form through bash rather than by
	// asserting on the escape sequence's shape.
	const cases = [
		"plain",
		"with space",
		"evil'; rm -rf / #",
		`back\`tick`,
		'$(command)',
		"quote'inside",
		"multi'quote'arg",
		"tab\there",
	];
	for (const value of cases) {
		const printed = execFileSync("bash", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
		assert.equal(printed, value, `shell round trip changed ${JSON.stringify(value)}`);
	}
});

test("a single quote in an argument cannot break out of the wrapper", () => {
	// The wrapper double-quotes: once for pi's argv, once for the tmux shell-command. A stray
	// quote must survive both layers as literal text.
	const command = buildInnerCommand({ piArgv: ["-a", "--name", "evil'; rm -rf / #"], cols: 130, rows: 42 });
	assert.ok(command.includes("'\\''"), "expected the standard single-quote escape");
	// Every single quote must be balanced once the escapes are removed, or the wrapper is broken.
	const unescaped = command.replace(/'\\''/g, "");
	assert.equal((unescaped.match(/'/g) ?? []).length % 2, 0, "unbalanced quoting");
	// And the whole pi command must still be one quoted unit handed to tmux, correctly closed
	// before the wait loop begins. Observed tail: ... rm -rf / #'\'''; while tmux has-session ...
	assert.match(command, /-x 130 -y 42 '\/usr\/local\/bin\/pi /);
	assert.match(command, /#'\\'''; while tmux has-session -t pi/);
});

test("args needing no quoting are left bare so the command stays readable", () => {
	const command = buildInnerCommand({ piArgv: ["-a", "--model", "zai/glm-5.3"], cols: 100, rows: 30 });
	assert.ok(command.includes("/usr/local/bin/pi -a --model zai/glm-5.3"));
});

test("absurd sizes are clamped rather than passed to tmux", () => {
	const command = buildInnerCommand({ piArgv: ["-a"], cols: 5, rows: 2 });
	assert.match(command, /-x 40 -y 12/);
});

test("fractional sizes are truncated, not rounded up into a tmux error", () => {
	const command = buildInnerCommand({ piArgv: ["-a"], cols: 130.9, rows: 42.7 });
	assert.match(command, /-x 130 -y 42/);
});

test("the session name is configurable and consistently quoted", () => {
	const command = buildInnerCommand({ piArgv: ["-a"], cols: 100, rows: 30, session: "worker 1" });
	assert.match(command, /new-session -A -d -s 'worker 1'/);
	assert.match(command, /has-session -t 'worker 1'/);
});

test("the pi binary path is configurable", () => {
	const command = buildInnerCommand({ piArgv: ["-a"], cols: 100, rows: 30, piBinary: "/opt/pi" });
	assert.match(command, /^tmux new-session .* '\/opt\/pi -a'/);
});

test("the attach command uses podman exec into the inner tmux, never podman attach", () => {
	const attach = buildAttachCommand("podman", "multy-impl");
	assert.equal(attach, "podman exec -it multy-impl tmux attach -t pi");
	// `podman attach` would tie pi's lifetime to the attach client's PTY (Spike 7a).
	assert.ok(!attach.includes("podman attach"));
});

test("the attach command quotes an unusual container name", () => {
	const attach = buildAttachCommand("podman", "my container");
	assert.equal(attach, "podman exec -it 'my container' tmux attach -t pi");
});

test("the base env carries the UTF-8 locale that stops tmux drawing borders as 'q'", () => {
	// Spike 7b: with LC_CTYPE=POSIX the inner tmux uses DEC Special Graphics, where q IS the
	// horizontal-line character, so every border pi draws renders as a run of q's.
	assert.equal(CONTAINER_BASE_ENV.LANG, "C.UTF-8");
	assert.equal(CONTAINER_BASE_ENV.LC_ALL, "C.UTF-8");
	// Plain xterm loses truecolor (Spike 1 observed TERM=xterm inside the container).
	assert.equal(CONTAINER_BASE_ENV.TERM, "xterm-256color");
});

test("the inner session name is a single shared constant", () => {
	assert.equal(INNER_SESSION, "pi");
	assert.equal(buildAttachCommand("podman", "c").split("attach -t ")[1], INNER_SESSION);
	assert.match(buildInnerCommand({ piArgv: [], cols: 100, rows: 30 }), /-s pi /);
});

test("the pinned pi path matches what the image installs", () => {
	// npm's global prefix in node:22-slim is /usr/local, so the bin symlink is /usr/local/bin/pi.
	// Verified in the image; if this ever changes, every container fails with "executable not found".
	assert.equal(PI_BINARY_PATH, "/usr/local/bin/pi");
});
