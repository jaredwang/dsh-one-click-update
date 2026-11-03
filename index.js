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
 *           waits for the shell to exit, and starts the app again. It never
 *           force-kills a quit the user refused (the shell's own quit
 *           confirmation still wins), and it removes itself.
 *
 * The route only works when the Host was actually spawned by the desktop shell
 * (an IPC channel to the Electron main process exists); a plain `dsh web` Host
 * refuses and the page falls back to the market's restart endpoint.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PLUGIN_NAME = "dsh-one-click-update";
export const RESTART_PATH = "/dsh-one-click-update/restart";

/** How long the helper waits for the shell to exit before giving up (ms). */
const QUIT_WAIT_MS = 20_000;

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

function darwinScript(appPath, bundleId, pid) {
	const quit = bundleId === void 0
		? `/usr/bin/osascript -e 'tell application ${dq(appPath.replace(/\/[^/]*\.app$/, (m) => m.slice(1, -4)))} to quit'`
		: `/usr/bin/osascript -e 'tell application id ${dq(bundleId)} to quit'`;
	return [
		"#!/bin/sh",
		"# dsh-one-click-update: quit the DSH desktop app, then open it again.",
		"set -u",
		"trap 'rm -f -- \"$0\"' EXIT",
		`APP=${shQuote(appPath)}`,
		`PID=${Number(pid) || 0}`,
		// Let the restart route's HTTP response flush before the app dies.
		"sleep 0.8",
		`${quit} >/dev/null 2>&1 || true`,
		"i=0",
		`while [ "$i" -lt ${Math.ceil(QUIT_WAIT_MS / 500)} ]; do`,
		"\tif ! kill -0 \"$PID\" 2>/dev/null; then break; fi",
		"\ti=$((i + 1))",
		"\tsleep 0.5",
		"done",
		"if kill -0 \"$PID\" 2>/dev/null; then",
		"\t# The quit is waiting for confirmation (or was refused): leave it be.",
		"\texit 0",
		"fi",
		"sleep 0.8",
		"/usr/bin/open \"$APP\""
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
			sendJson(response, 200, { ok: true, restart: publicPlan(plan()) });
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
			sendJson(response, 202, { ok: true, helper: file, restart: publicPlan(current) });
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
	};
	if (typeof ctx.inject === "function") ctx.inject(["webServer"], register);
	else register(ctx);
}
