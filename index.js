/**
 * Host half of the bundle.
 *
 * The update entry lives almost entirely in the browser UI: it drives the
 * market's public Update API v1 and the desktop product bridge
 * (`window.dshDesktop.updates`) that the Electron preload already exposes.
 *
 * The one thing the page cannot do by itself is restart the desktop app: the
 * preload exposes no quit/relaunch call, the shell's IPC has no restart
 * channel, and the market's own restart endpoint is disabled in the desktop
 * runtime (`restart.supported: false`, `managedBy: "desktop-host"`) because it
 * would only respawn the Host child and leave the Electron shell alive. So the
 * Host half owns exactly one route:
 *
 *   GET  /dsh-one-click-update/restart -> capability document (no side effect)
 *   POST /dsh-one-click-update/restart[?dryRun=1]
 *        -> write a tiny helper script, spawn it detached, answer 202. The
 *           helper waits for the response, asks the app to quit through
 *           AppleScript (macOS) / taskkill (Windows) / SIGTERM (other POSIX),
 *           waits for the app to actually be gone (on macOS by looking at
 *           every process under the bundle, because the pid this Host was
 *           handed may be a wrapper), then opens it again and checks that it
 *           came up. It never force-kills a quit the user refused (the shell's
 *           own quit confirmation still wins), it removes itself, and on macOS
 *           it appends every decision to `$(TMPDIR)/dsh-one-click-update-restart.log`
 *           so a failed relaunch can be read after the fact.
 *
 * The route only works when the Host was actually spawned by the desktop shell
 * (an IPC channel to the Electron main process exists); a plain `dsh web` Host
 * refuses and the page falls back to the market's restart endpoint.
 *
 * The Host half owns one more route, because the market's managed update is a
 * remove-then-install and the desktop app refuses to remove a bundle whose
 * loader entry is still live ("bundle-in-use"): the market cannot hot-update a
 * plugin that is currently mounted, no matter how often the button is clicked.
 *
 *   GET  /dsh-one-click-update/overlay -> capability document (no side effect)
 *   POST /dsh-one-click-update/overlay {name, version, force?}
 *        -> run the host's own package manager (`pnpm add <name>@<version>
 *           --save-exact`, the same invocation the desktop publishes on
 *           `profileContext`) over the running version, then answer 200 with
 *           `restartRequired: true`. Overlaying never unloads the plugin, so it
 *           does not trip the in-use guard; the update lands on disk and the
 *           app restart that the page already offers applies it.
 *
 *        `force: true` adds pnpm's `--config.minimum-release-age=0` to that one
 *        invocation, so a release still inside the profile's
 *        `minimumReleaseAge` window (the market calls it the maturity hold or
 *        "冷静期") installs now instead of waiting. It is per request, never a
 *        policy change: the profile's `pnpm-workspace.yaml` is untouched, and
 *        the next ordinary install waits again. The market's own `force: true`
 *        cannot do this on the desktop — it only reaches pnpm on hosts that run
 *        pnpm themselves (routes.js skips the override when `desktopHost`), and
 *        its desktop maturity gate refuses a held target before pnpm runs at
 *        all. This route talks to pnpm directly, which is why it can.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const PLUGIN_NAME = "dsh-one-click-update";
export const RESTART_PATH = "/dsh-one-click-update/restart";
export const OVERLAY_PATH = "/dsh-one-click-update/overlay";

/** How long the helper waits for the shell to exit before giving up (ms). */
const QUIT_WAIT_MS = 20_000;

/** How long the quit AppleEvent may take to come back before it is dropped (ms). */
const QUIT_ACK_MS = 15_000;

/** How long one open attempt gets to bring the app back before the next (ms). */
const REOPEN_WAIT_MS = 10_000;

/**
 * How long a freshly opened app must keep running before it counts as back. A
 * relaunch that fails the single-instance lock comes up and quits within a
 * second, so a short positive check is not enough (ms).
 */
const STABILITY_MS = 5_000;

/**
 * Quiet beat before the first open, so LaunchServices has forgotten the old
 * instance and its single-instance files are gone (ms).
 */
const REOPEN_SETTLE_MS = 2_000;

/** How long to wait inside one settle for the app's owner pid to really die (ms). */
const OWNER_WAIT_MS = 20_000;

/** How long one overlay install may take before it is abandoned (ms). */
const OVERLAY_TIMEOUT_MS = 300_000;

/**
 * pnpm's own switch for the fresh-release hold (`minimumReleaseAge`, 24h by
 * default). Passed on one command line, so the profile keeps its policy.
 */
export const RELEASE_AGE_OVERRIDE = "--config.minimum-release-age=0";

/* ------------------------------------------------------------------ */
/* Shell detection                                                     */
/* ------------------------------------------------------------------ */

/** `ps -o command= -p <pid>`, or "" when the platform has no usable ps. */
function parentCommand(pid) {
	try {
		return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"]
		}).trim();
	} catch (error) {
		return "";
	}
}

/**
 * True when this Host was spawned by the DSH desktop shell rather than by a
 * terminal `dsh` command. The shell spawns the Host with an IPC channel (so it
 * can send `shutdown` / `quit-inspection`), and its process runs the same
 * executable that runs this Host — the `dsh` CLI launcher also runs the Electron
 * binary, but its parent is a terminal shell, not the app itself.
 */
export function isDesktopHost(options = {}) {
	const hasIpc = options.hasIpc ?? typeof process.send === "function";
	if (!hasIpc) return false;
	if (options.trustIpc === true) return true;
	const execPath = options.execPath ?? process.execPath;
	const pid = options.parentPid ?? process.ppid;
	const parent = options.parentCommand ?? parentCommand(pid);
	// No ps (Windows, restricted sandbox): trust the IPC channel alone.
	if (parent === "") return true;
	return parent === execPath || parent.startsWith(execPath + " ");
}

/* ------------------------------------------------------------------ */
/* Restart plans                                                       */
/* ------------------------------------------------------------------ */

/** CFBundleIdentifier of the app bundle, or undefined when unreadable. */
function readBundleId(appPath) {
	try {
		const plist = readFileSync(join(appPath, "Contents", "Info.plist"), "utf8");
		const match = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
		return match === null ? void 0 : match[1].trim();
	} catch (error) {
		return void 0;
	}
}

/** Single-quote one POSIX shell word. */
function shQuote(value) {
	return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** Double-quote one AppleScript/shell string literal. */
function dq(value) {
	return '"' + String(value).replace(/"/g, '\\"') + '"';
}

/**
 * Path of the helper's log. The helper is detached and the app it kills owns
 * the terminal, so the log file is the only place its decisions survive.
 */
export function restartLogPath(options = {}) {
	return join(options.tmpdir ?? tmpdir(), `${PLUGIN_NAME}-restart.log`);
}

/**
 * Directory that holds Chromium's Desktop-profile single-instance files. It
 * lives under Electron's `appData`, which for this app is
 * `~/Library/Application Support/@deepseek-ai/dsh-desktop`. Pinning it as an
 * absolute path matters: the helper runs detached from the shell and must not
 * rely on the caller's environment to find these files.
 */
export function desktopSingletonDir(options = {}) {
	return options.singletonDir ?? join(homedir(), "Library", "Application Support", "@deepseek-ai", "dsh-desktop");
}

function darwinScript(appPath, bundleId, pid) {
	const quit = bundleId === void 0
		? `/usr/bin/osascript -e 'tell application ${dq(appPath.replace(/\/[^/]*\.app$/, (m) => m.slice(1, -4)))} to quit'`
		: `/usr/bin/osascript -e 'tell application id ${dq(bundleId)} to quit'`;
	const poll = (ms) => Math.ceil(ms / 500);
	return [
		"#!/bin/sh",
		"# dsh-one-click-update: quit the DSH desktop app, then open it again.",
		"set -u",
		"trap 'rm -f -- \"$0\"' EXIT",
		`APP=${shQuote(appPath)}`,
		`BUNDLE=${bundleId === void 0 ? "''" : shQuote(bundleId)}`,
		`PID=${Number(pid) || 0}`,
		`SINGLETON_DIR=${shQuote(desktopSingletonDir())}`,
		`LOG=${shQuote(restartLogPath())}`,
		"say() {",
		"\tprintf '%s %s\\n' \"$(date '+%H:%M:%S')\" \"$*\" >> \"$LOG\" 2>/dev/null || true",
		"}",
		"# pgrep cannot see the app's main process (its argv is unreadable from here),",
		"# so a bundle match alone reports the app gone a moment too early. LaunchServices",
		"# is the one source that knows whether the app is still running, so prefer it",
		"# and keep the bundle scan as a fallback for hosts without lsappinfo.",
		"in_ls() {",
		"\t[ -n \"$BUNDLE\" ] || return 1",
		"\t[ -x /usr/bin/lsappinfo ] || return 1",
		"\tasn=$(/usr/bin/lsappinfo find bundleID=\"$BUNDLE\" 2>/dev/null | /usr/bin/head -1)",
		"\t[ -n \"$asn\" ] || return 1",
		"\tp=$(/usr/bin/lsappinfo info -only pid \"$asn\" 2>/dev/null | /usr/bin/sed -n 's/.*pid = \\([0-9][0-9]*\\).*/\\1/p')",
		"\t[ -n \"$p\" ] && [ \"$p\" -gt 1 ] && kill -0 \"$p\" 2>/dev/null",
		"}",
		"in_bundle() {",
		"\t/usr/bin/pgrep -f \"$APP/Contents/MacOS/\" >/dev/null 2>&1",
		"}",
		"running() {",
		"\tin_ls || in_bundle",
		"}",
		"# LaunchServices hands the caller's environment to the new process. This",
		"# helper is started by the DSH Host, which is the Electron binary running",
		"# with ELECTRON_RUN_AS_NODE=1; passing that through makes the \"app\" start",
		"# in Node mode (the Dock bounces, no window appears, it exits immediately).",
		"# Strip the Electron/Node runtime variables so this behaves like a Dock click.",
		"open_app() {",
		"\t/usr/bin/env \\",
		"\t\t-u ELECTRON_RUN_AS_NODE \\",
		"\t\t-u ELECTRON_NO_ATTACH_CONSOLE \\",
		"\t\t-u ELECTRON_ENABLE_LOGGING \\",
		"\t\t-u ELECTRON_ENABLE_STACK_DUMPING \\",
		"\t\t-u ELECTRON_DEFAULT_ERROR_MODE \\",
		"\t\t-u NODE_OPTIONS \\",
		"\t\t-u NODE_PATH \\",
		"\t\t/usr/bin/open \"$@\"",
		"}",
		"# Open, then watch: LaunchServices answers \"ok\" even when it silently",
		"# activates the app that is still shutting down, so exit status proves nothing.",
		"try_open() {",
		"\t\"$@\" >> \"$LOG\" 2>&1",
		"\tsay \"$* (exit=$?)\"",
		"\tk=0",
		`\twhile [ "$k" -lt ${poll(REOPEN_WAIT_MS)} ]; do`,
		"\t\tif running; then return 0; fi",
		"\t\tk=$((k + 1))",
		"\t\tsleep 0.5",
		"\tdone",
		"\treturn 1",
		"}",
		"came_back() {",
		"\tsay \"app is back\"",
		"\t# A launch that dies straight away looks identical for the first second.",
		"\tsleep 5",
		"\tif running; then",
		"\t\tsay \"still up 5s later\"",
		"\t\texit 0",
		"\telse",
		"\t\tsay \"showed up and went away again\"",
		"\t\t# Do not report success for a process that died during startup: keep",
		"\t\t# trying the remaining launch methods and rounds.",
		"\t\treturn 1",
		"\tfi",
		"}",
		"say \"restart requested (pid=$PID)\"",
		// Let the restart route's HTTP response flush before the app dies.
		"sleep 0.8",
		// The quit is an AppleEvent: it returns when the app answers, and if the",
		// app is showing its own confirmation it can sit there for minutes.
		`${quit} >> \"$LOG\" 2>&1 &`,
		"q=$!",
		"k=0",
		`while [ "$k" -lt ${poll(QUIT_ACK_MS)} ] && kill -0 \"$q\" 2>/dev/null; do`,
		"\tk=$((k + 1))",
		"\tsleep 0.5",
		"done",
		"if kill -0 \"$q\" 2>/dev/null; then",
		"\tsay \"quit request still open after the app answered nothing; not waiting on it\"",
		"\tkill \"$q\" 2>/dev/null || true",
		"fi",
		"i=0",
		`while [ "$i" -lt ${poll(QUIT_WAIT_MS)} ]; do`,
		"\tif ! running; then break; fi",
		"\ti=$((i + 1))",
		"\tsleep 0.5",
		"done",
		"j=0",
		`while [ "$PID" -gt 1 ] && [ "$j" -lt ${Math.ceil(QUIT_WAIT_MS / 1000)} ] && kill -0 \"$PID\" 2>/dev/null; do`,
		"\tj=$((j + 1))",
		"\tsleep 1",
		"done",
		"# pgrep cannot see the app's main process, so \"no bundle process\" is not proof",
		"# on its own; only trust it together with the pid we were handed.",
		"alive() {",
		"\tin_bundle && return 0",
		"\t[ \"$PID\" -gt 1 ] && kill -0 \"$PID\" 2>/dev/null && return 0",
		"\treturn 1",
		"}",
		"if in_ls; then",
		"\tif alive; then",
		"\t\t# The quit is waiting for confirmation (or was refused): leave it be.",
		"\t\tsay \"app is still running after $i polls (waiting for a confirmation?); not reopening\"",
		"\t\texit 0",
		"\tfi",
		"\t# LaunchServices can keep a dead app in its list for a while (it is only",
		"\t# reaped lazily); with no process left, reopening is safe.",
		"\tsay \"app left LaunchServices late but no process is left; opening it again\"",
		"else",
		"\tsay \"app is gone after $i polls; opening it again\"",
		"fi",
		"# Chromium's single-instance lock lives in appData, not the profile, and a",
		"# relaunch that finds it still pointing at the instance that is winding down",
		"# quits itself within a second. That window is what made the app bounce back",
		"# and disappear at 11:56. Wait until the owner pid in the lock is really gone,",
		"# then unlink the three stale files so the new instance starts clean.",
		"stale_owner() {",
		"\t[ -L \"$SINGLETON_DIR/SingletonLock\" ] || return 1",
		"\ttarget=$(/bin/ls -l \"$SINGLETON_DIR/SingletonLock\" 2>/dev/null)",
		"\t[ -n \"$target\" ] || return 1",
		"\towner=$(printf '%s' \"$target\" | /usr/bin/sed -n 's/.*->[^0-9]*\\([0-9][0-9]*\\)$/\\1/p')",
		"\t[ -n \"$owner\" ] && [ \"$owner\" -gt 1 ] && kill -0 \"$owner\" 2>/dev/null",
		"}",
		"w=0",
		`while [ "$w" -lt ${Math.ceil(OWNER_WAIT_MS / 500)} ] && stale_owner; do`,
		"\tw=$((w + 1))",
		"\tsleep 0.5",
		"done",
		"if stale_owner; then",
		"\tsay \"single-instance owner still alive after $w polls; leaving the lock alone\"",
		"else",
		"\tcleared=0",
		"\tfor f in SingletonLock SingletonSocket SingletonCookie; do",
		"\t\tif [ -e \"$SINGLETON_DIR/$f\" ] || [ -L \"$SINGLETON_DIR/$f\" ]; then",
		"\t\t\trm -f \"$SINGLETON_DIR/$f\" 2>/dev/null && cleared=$((cleared + 1))",
		"\t\tfi",
		"\tdone",
		"\tsay \"cleared $cleared stale single-instance file(s)\"",
		"fi",
		"# Give LaunchServices and the kernel a quiet beat before asking for a new",
		"# instance; opening the same instant keeps landing on the dying one.",
		`sleep ${(REOPEN_SETTLE_MS / 1000).toFixed(1)}`,
		"round=0",
		"while [ \"$round\" -lt 2 ]; do",
		"\tround=$((round + 1))",
		"\tif try_open open_app -a \"$APP\"; then came_back; fi",
		"\t# Launchd runs the open outside this process tree, which matters when the",
		"\t# request comes from a helper that the app itself started.",
		"\tif [ -x /bin/launchctl ]; then",
		"\t\tif try_open /bin/launchctl submit -l \"com.dsh.one-click-update.reopen.$$\" -- /usr/bin/env -u ELECTRON_RUN_AS_NODE -u ELECTRON_NO_ATTACH_CONSOLE -u ELECTRON_ENABLE_LOGGING -u ELECTRON_ENABLE_STACK_DUMPING -u ELECTRON_DEFAULT_ERROR_MODE -u NODE_OPTIONS -u NODE_PATH /usr/bin/open -a \"$APP\"; then came_back; fi",
		"\tfi",
		"\tif [ -n \"$BUNDLE\" ] && try_open open_app -b \"$BUNDLE\"; then came_back; fi",
		"\tif try_open open_app -n -a \"$APP\"; then came_back; fi",
		"\tsay \"round $round: the app did not come back\"",
		"\tsleep 3",
		"done",
		"say \"gave up after 2 rounds; the app stayed down\"",
		"/usr/bin/lsappinfo find bundleID=\"$BUNDLE\" >> \"$LOG\" 2>&1 || true",
		"exit 1",
	].join("\n") + "\n";
}

function win32Script(execPath, pid) {
	return [
		"@echo off",
		"setlocal",
		"timeout /t 1 /nobreak >nul",
		`taskkill /PID ${Number(pid) || 0} /T >nul 2>&1`,
		"timeout /t 2 /nobreak >nul",
		`start "" ${dq(execPath)}`,
		'del "%~f0" >nul 2>&1'
	].join("\r\n") + "\r\n";
}

function linuxScript(execPath, pid) {
	return [
		"#!/bin/sh",
		"# dsh-one-click-update: stop the DSH desktop app, then start it again.",
		"set -u",
		"trap 'rm -f -- \"$0\"' EXIT",
		`PID=${Number(pid) || 0}`,
		"sleep 0.8",
		"kill -TERM \"$PID\" 2>/dev/null || true",
		"i=0",
		`while [ "$i" -lt ${Math.ceil(QUIT_WAIT_MS / 500)} ]; do`,
		"\tif ! kill -0 \"$PID\" 2>/dev/null; then break; fi",
		"\ti=$((i + 1))",
		"\tsleep 0.5",
		"done",
		"if kill -0 \"$PID\" 2>/dev/null; then",
		"\texit 0",
		"fi",
		"sleep 0.8",
		`${shQuote(execPath)} >/dev/null 2>&1 &`
	].join("\n") + "\n";
}

/**
 * Describe how this Host can restart the desktop app. Pure apart from reading
 * the app bundle's Info.plist, so tests can drive every branch.
 *
 * @returns {{supported: boolean, reason?: string, platform?: string, mode?: string,
 *            appPath?: string, bundleId?: string, parentPid?: number, script?: string}}
 */
export function restartPlan(options = {}) {
	const platform = options.platform ?? process.platform;
	const execPath = options.execPath ?? process.execPath;
	const parentPid = options.parentPid ?? process.ppid;
	const desktop = options.desktop ?? isDesktopHost(options);
	if (!desktop) return { supported: false, reason: "not-desktop" };
	if (platform === "darwin") {
		const marker = execPath.lastIndexOf("/Contents/MacOS/");
		if (marker === -1) return { supported: false, reason: "not-app-bundle" };
		const appPath = execPath.slice(0, marker);
		const bundleId = options.bundleId ?? readBundleId(appPath);
		return {
			supported: true,
			platform,
			mode: "osascript",
			appPath,
			bundleId,
			parentPid,
			script: darwinScript(appPath, bundleId, parentPid)
		};
	}
	if (platform === "win32") {
		return {
			supported: true,
			platform,
			mode: "taskkill",
			appPath: execPath,
			parentPid,
			script: win32Script(execPath, parentPid)
		};
	}
	if (platform === "linux" || platform === "freebsd") {
		return {
			supported: true,
			platform,
			mode: "sigterm",
			appPath: execPath,
			parentPid,
			script: linuxScript(execPath, parentPid)
		};
	}
	return { supported: false, reason: "unsupported-platform" };
}

/** The plan without its script: safe to hand to the page. */
function publicPlan(plan) {
	return {
		supported: plan.supported === true,
		reason: plan.reason,
		platform: plan.platform,
		mode: plan.mode,
		appPath: plan.appPath,
		bundleId: plan.bundleId
	};
}

/* ------------------------------------------------------------------ */
/* Helper launch                                                       */
/* ------------------------------------------------------------------ */

/** Write the plan's script and start it detached; returns the script path. */
export function launchHelper(plan) {
	const extension = plan.platform === "win32" ? "cmd" : "sh";
	const file = join(tmpdir(), `${PLUGIN_NAME}-restart-${process.pid}-${Date.now()}.${extension}`);
	writeFileSync(file, plan.script, { mode: 0o700 });
	chmodSync(file, 0o700);
	const child = plan.platform === "win32"
		? spawn("cmd.exe", ["/c", file], { detached: true, stdio: "ignore", windowsHide: true })
		: spawn("/bin/sh", [file], { detached: true, stdio: "ignore" });
	if (typeof child.unref === "function") child.unref();
	return file;
}

/* ------------------------------------------------------------------ */
/* HTTP route                                                          */
/* ------------------------------------------------------------------ */

function sendJson(response, status, body) {
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text)
	});
	response.end(text);
}

/**
 * Reject a request that a web page on another origin started. Requests the
 * desktop shell forwards from the page carry no Origin (the shell strips it),
 * and non-browser clients send none either, so only a present, mismatched
 * Origin is refused.
 */
function trustedRequest(request) {
	const origin = request.headers.origin;
	if (origin === undefined || origin === null || origin === "" || origin === "null") return true;
	try {
		return new URL(origin).host === request.headers.host;
	} catch (error) {
		return false;
	}
}

/* ------------------------------------------------------------------ */
/* Overlay install (update a mounted bundle without unloading it)      */
/* ------------------------------------------------------------------ */

/** npm package name, including a scope. */
const NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
/** Plain semver (a release, or a prerelease/build of one). */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJsonFile(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return undefined;
	}
}

/** The dependency range the profile declares, or undefined. */
function declaredRange(manifest, name) {
	for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
		const value = manifest?.[field];
		if (value !== null && typeof value === "object" && typeof value[name] === "string") return value[name];
	}
	return void 0;
}

/** The first plain version inside a dependency range (`^1.2.3` -> `1.2.3`). */
function versionInRange(range) {
	if (typeof range !== "string") return void 0;
	const match = range.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
	return match === null ? void 0 : match[0];
}

/** Compare two plain semver strings; <0, 0, >0 (prereleases sort first). */
export function compareVersions(left, right) {
	const core = (value) => value.split("+")[0].split("-");
	const [leftCore, rightCore] = [core(left), core(right)];
	const numbers = (parts) => parts[0].split(".").map((part) => Number(part) || 0);
	const a = numbers(leftCore);
	const b = numbers(rightCore);
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	const leftPre = leftCore[1];
	const rightPre = rightCore[1];
	if (leftPre === void 0 && rightPre === void 0) return 0;
	if (leftPre === void 0) return 1;
	if (rightPre === void 0) return -1;
	return leftPre === rightPre ? 0 : leftPre < rightPre ? -1 : 1;
}

/** `node_modules/<name>/package.json` version, when the package is installed. */
function installedVersion(directory, name) {
	const manifest = readJsonFile(join(directory, "node_modules", name, "package.json"));
	return typeof manifest?.version === "string" ? manifest.version : void 0;
}

/**
 * The runtime directory of the packaged app this Host runs inside, when there
 * is one. A Desktop Host is started by the app bundle but is not handed the
 * bundled pnpm the way the CLI is, so the overlay route looks for the payload
 * next to the binary itself.
 */
export function desktopRuntimeDir(options = {}) {
	const execPath = options.execPath ?? process.execPath;
	const resourcesPath = options.resourcesPath ?? process.resourcesPath;
	const exists = options.exists ?? existsSync;
	const candidates = [];
	if (typeof resourcesPath === "string" && resourcesPath !== "") candidates.push(join(resourcesPath, "runtime"));
	const marker = execPath.lastIndexOf("/Contents/MacOS/");
	if (marker !== -1) candidates.push(join(execPath.slice(0, marker), "Contents", "Resources", "runtime"));
	candidates.push(join(dirname(execPath), "resources", "runtime"));
	return candidates.find((directory) => exists(join(directory, "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs")));
}

/**
 * The pnpm the Desktop app ships, invoked exactly the way the shell invokes it
 * (`ELECTRON_RUN_AS_NODE` turns the app binary into its bundled Node), or
 * `undefined` outside a packaged app.
 */
export function bundledPackageManager(options = {}) {
	const runtime = desktopRuntimeDir(options);
	if (runtime === void 0) return void 0;
	const execPath = options.execPath ?? process.execPath;
	const separator = process.platform === "win32" ? ";" : ":";
	return {
		command: execPath,
		args: ["--expose-internals", join(runtime, "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs")],
		env: {
			ELECTRON_RUN_AS_NODE: "1",
			DSH_DESKTOP_NODE_EXECUTABLE: execPath,
			PATH: `${join(runtime, "bin")}${separator}${process.env.PATH ?? ""}`
		}
	};
}

/**
 * The profile directory to install into: what the Host publishes, or — when a
 * packaged app Host publishes nothing usable — the reserved `desktop` profile
 * under `$DSH_HOME`, which is the only profile the packaged app owns.
 */
function profileDirectoryOf(context, insideApp, options = {}) {
	for (const candidate of [context?.dir, context?.profileDirectory]) {
		if (typeof candidate === "string" && candidate !== "") return candidate;
	}
	if (insideApp !== true) return void 0;
	const exists = options.exists ?? existsSync;
	const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const named = typeof context?.profile === "string" && context.profile !== "" ? context.profile : "desktop";
	const directory = join(home, "profiles", named);
	return exists(join(directory, "package.json")) ? directory : void 0;
}

/**
 * The profile directory and package manager an overlay install needs.
 *
 * Newer Hosts publish `dir` (not `profileDirectory`) and no `packageManager`;
 * older ones publish both. When neither carries an invocation, the pnpm that
 * ships with the Desktop app is used, so the route keeps working on Hosts that
 * were never handed one.
 */
export function describeOverlayTarget(ctx, options = {}) {
	let context;
	try {
		context = typeof ctx?.get === "function" ? ctx.get("profileContext") : void 0;
	} catch (error) {
		context = void 0;
	}
	const hostInvocation = context?.packageManager;
	const bundled = hostInvocation === void 0 ? bundledPackageManager(options) : void 0;
	const directory = profileDirectoryOf(context, bundled !== void 0, options);
	const invocation = hostInvocation ?? bundled;
	const detail = {
		directory: directory !== void 0,
		packageManager: hostInvocation !== void 0,
		bundled: bundled !== void 0,
		runtime: desktopRuntimeDir(options)
	};
	if (directory === void 0) return { available: false, reason: "no-profile-directory", detail };
	if (
		invocation === undefined || invocation === null || typeof invocation.command !== "string" ||
		invocation.command.trim() === ""
	) {
		return { available: false, reason: "no-package-manager", detail };
	}
	return {
		available: true,
		source: hostInvocation === undefined ? "bundled" : "host",
		profile: typeof context?.profile === "string" ? context.profile : void 0,
		directory,
		invocation: {
			command: invocation.command,
			args: Array.isArray(invocation.args) ? invocation.args.map(String) : [],
			env: invocation.env !== null && typeof invocation.env === "object" ? invocation.env : {}
		},
		detail
	};
}

/** Environment for the package manager: the host's PATH first, CI to stop prompts. */
function invocationEnv(invocation) {
	const separator = process.platform === "win32" ? ";" : ":";
	const provided = invocation.env ?? {};
	const path = [provided.PATH ?? "", process.env.PATH ?? ""].filter((part) => part !== "").join(separator);
	return { ...process.env, ...provided, CI: "true", PATH: path };
}

/**
 * Run the host package manager with extra arguments in the profile directory.
 * Resolves (never rejects) with `{exitCode, stdout, stderr, timedOut}`.
 */
export function runPackageManager(invocation, directory, args, options = {}) {
	const timeoutMs = options.timeoutMs ?? OVERLAY_TIMEOUT_MS;
	const spawnImpl = options.spawn ?? spawn;
	const windows = process.platform === "win32" && /\.cmd$/i.test(invocation.command);
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnImpl(invocation.command, [...invocation.args, ...args], {
				cwd: directory,
				env: invocationEnv(invocation),
				stdio: ["ignore", "pipe", "pipe"],
				shell: windows,
				windowsHide: true
			});
		} catch (error) {
			resolve({ exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let killTimer;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch (error) {
				// already gone
			}
			killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch (error) {
					// already gone
				}
			}, 5000);
			if (typeof killTimer.unref === "function") killTimer.unref();
		}, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();
		child.stdout?.on("data", (chunk) => {
			stdout = (stdout + chunk.toString()).slice(-64 * 1024);
		});
		child.stderr?.on("data", (chunk) => {
			stderr = (stderr + chunk.toString()).slice(-64 * 1024);
		});
		child.on("error", (error) => {
			finish({ exitCode: 127, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
		});
		child.on("close", (code) => {
			finish({ exitCode: typeof code === "number" ? code : 1, stdout, stderr, timedOut });
		});
	});
}

/** Read a JSON request body; `{}` when there is none or it is not JSON. */
function readJsonBody(request) {
	const given = request?.body;
	if (given !== null && typeof given === "object") return Promise.resolve(given);
	if (typeof request?.on !== "function") return Promise.resolve(void 0);
	return new Promise((resolve) => {
		let text = "";
		request.on("data", (chunk) => {
			if (text.length < 64 * 1024) text += chunk;
		});
		request.on("end", () => {
			try {
				resolve(text === "" ? void 0 : JSON.parse(text));
			} catch (error) {
				resolve(void 0);
			}
		});
		request.on("error", () => resolve(void 0));
	});
}

/** The refusal sentence the market gives for release-age holds, or nothing. */
function releaseHold(output) {
	return /release.?age|minimumReleaseAge|fresh-release|等待期|成熟期|发布太新/i.test(output);
}

/**
 * Build the overlay route. Injectable for tests: `target()` describes the
 * desktop package manager, `run(target, args)` performs the install, and
 * `readManifest(directory)` / `installed(directory, name)` read the profile and
 * the installed tree.
 */
export function createOverlayHandler(options = {}) {
	const target = options.target ?? (() => describeOverlayTarget());
	const run = options.run ?? ((current, args) => runPackageManager(current.invocation, current.directory, args, options));
	const readManifest = options.readManifest ?? ((directory) => readJsonFile(join(directory, "package.json")));
	const installed = options.installed ?? installedVersion;
	let busy = false;

	return async function overlayRoute(request, response) {
		if (!trustedRequest(request)) {
			sendJson(response, 403, { error: "untrusted origin" });
			return;
		}
		const current = target();
		if (request.method === "GET") {
			sendJson(response, 200, {
				ok: true,
				overlay: current.available === true,
				reason: current.reason,
				profile: current.profile,
				// Whether this Host can lift the profile's release-age wait for one
				// install. True on every desktop Host that has this route at all;
				// a page from an older bundle reads the absence as "no".
				force: current.available === true,
				source: current.source,
				releaseAgeOverride: current.available === true ? RELEASE_AGE_OVERRIDE : void 0,
				// Where the answer came from, so a page can say why the route is
				// unavailable instead of guessing that the Host half is stale.
				detail: current.detail
			});
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405, { allow: "GET, POST" });
			response.end();
			return;
		}
		if (busy) {
			sendJson(response, 409, { ok: false, error: "an overlay install is already running" });
			return;
		}
		if (current.available !== true) {
			sendJson(response, 501, {
				ok: false,
				error: "overlaying a plugin needs the desktop app's package manager",
				reason: current.reason,
				hint: "restart DSH so the app applies the update, or run `pnpm add <name>@<version> --save-exact` in the profile directory"
			});
			return;
		}
		const body = await readJsonBody(request);
		const name = typeof body?.name === "string" ? body.name.trim() : "";
		const version = typeof body?.version === "string" ? body.version.trim() : "";
		const force = body?.force === true;
		if (NAME_PATTERN.test(name) !== true) {
			sendJson(response, 400, { ok: false, error: "invalid package name" });
			return;
		}
		if (VERSION_PATTERN.test(version) !== true) {
			sendJson(response, 400, { ok: false, error: "invalid version" });
			return;
		}
		const manifest = readManifest(current.directory);
		const range = declaredRange(manifest, name);
		if (range === void 0) {
			sendJson(response, 400, { ok: false, error: `${name} is not a dependency of this profile` });
			return;
		}
		const from = installed(current.directory, name) ?? versionInRange(range) ?? "";
		if (from !== "" && compareVersions(version, from) <= 0) {
			sendJson(response, 400, {
				ok: false,
				error: `target ${version} is not newer than the installed ${from}`,
				installedVersion: from
			});
			return;
		}
		busy = true;
		try {
			// `--save-exact` pins what the manifest already declares; the override is
			// scoped to this one pnpm call (see the header comment).
			const args = ["add", `${name}@${version}`, "--save-exact"];
			if (force) args.push(RELEASE_AGE_OVERRIDE);
			const result = await run(current, args);
			const output = `${result.stdout}\n${result.stderr}`.trim().slice(-1200);
			if (result.timedOut === true) {
				sendJson(response, 504, {
					ok: false,
					code: "install-timeout",
					error: "the package manager did not finish in time",
					output
				});
				return;
			}
			if (result.exitCode !== 0) {
				if (releaseHold(output)) {
					sendJson(response, 409, {
						ok: false,
						code: "RELEASE_TOO_FRESH",
						error: "this version is still inside the fresh-release wait, so it cannot be installed yet",
						output
					});
					return;
				}
				sendJson(response, 500, {
					ok: false,
					code: "install-failed",
					error: `the package manager exited with ${result.exitCode}`,
					output
				});
				return;
			}
			const after = readManifest(current.directory);
			const landedRange = after === void 0 ? void 0 : declaredRange(after, name);
			const landedVersion = versionInRange(landedRange);
			const filesVersion = installed(current.directory, name);
			const wrongRange = landedVersion !== void 0 && compareVersions(landedVersion, version) !== 0;
			const wrongFiles = filesVersion !== void 0 && compareVersions(filesVersion, version) !== 0;
			if (wrongRange || wrongFiles) {
				sendJson(response, 500, {
					ok: false,
					code: "install-mismatch",
					error: `the files did not become ${version} (package.json ${landedVersion ?? "unknown"}, node_modules ${filesVersion ?? "unknown"})`,
					output
				});
				return;
			}
			sendJson(response, 200, {
				ok: true,
				name,
				version,
				from: from === "" ? void 0 : from,
				restartRequired: true,
				...(force ? { forced: true, releaseAgeOverride: RELEASE_AGE_OVERRIDE } : {})
			});
		} catch (error) {
			sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			busy = false;
		}
	};
}

/**
 * Build the route handler. Injectable for tests: `plan()` supplies the restart
 * plan and `launch(plan)` performs the side effect.
 */
export function createRestartHandler(options = {}) {
	const plan = options.plan ?? (() => restartPlan());
	const launch = options.launch ?? launchHelper;
	let busy = false;

	return async function restartRoute(request, response) {
		if (!trustedRequest(request)) {
			sendJson(response, 403, { error: "untrusted origin" });
			return;
		}
		if (request.method === "GET") {
			sendJson(response, 200, { ok: true, restart: publicPlan(plan()), log: restartLogPath() });
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405, { allow: "GET, POST" });
			response.end();
			return;
		}
		if (busy) {
			sendJson(response, 409, { error: "a restart is already in progress" });
			return;
		}
		const current = plan();
		if (current.supported !== true) {
			sendJson(response, 501, {
				error: current.reason === "not-desktop"
					? "restarting the desktop app is only available inside the desktop app"
					: "cannot restart the desktop app from this host (" + (current.reason ?? "unknown") + ")",
				reason: current.reason,
				restart: publicPlan(current)
			});
			return;
		}
		const url = new URL(String(request.url ?? "/"), "http://localhost");
		if (url.searchParams.get("dryRun") === "1") {
			sendJson(response, 200, { ok: true, dryRun: true, restart: publicPlan(current) });
			return;
		}
		try {
			const file = launch(current);
			busy = true;
			const timer = setTimeout(() => {
				busy = false;
			}, 60_000);
			if (typeof timer.unref === "function") timer.unref();
			sendJson(response, 202, { ok: true, helper: file, log: restartLogPath(), restart: publicPlan(current) });
		} catch (error) {
			busy = false;
			sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

/** Register the restart route on the Host's web server (and nothing else). */
export function apply(ctx) {
	const register = (scope) => {
		const server = scope.webServer;
		if (server === void 0 || server === null || typeof server.register !== "function") {
			ctx.logger?.warn?.(PLUGIN_NAME + ": the host carries no web server; the restart route is unavailable");
			return;
		}
		scope.effect(() => server.register({
			kind: "exact",
			path: RESTART_PATH,
			handler: createRestartHandler()
		}), PLUGIN_NAME + ": restart route");
		scope.effect(() => server.register({
			kind: "exact",
			path: OVERLAY_PATH,
			handler: createOverlayHandler({ target: () => describeOverlayTarget(ctx) })
		}), PLUGIN_NAME + ": overlay route");
	};
	if (typeof ctx.inject === "function") ctx.inject(["webServer"], register);
	else register(ctx);
}
