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
 *
 * The Host half owns one more route, because the market's managed update is a
 * remove-then-install and the desktop app refuses to remove a bundle whose
 * loader entry is still live ("bundle-in-use"): the market cannot hot-update a
 * plugin that is currently mounted, no matter how often the button is clicked.
 *
 *   GET  /dsh-one-click-update/overlay -> capability document (no side effect)
 *   POST /dsh-one-click-update/overlay {name, version}
 *        -> run the host's own package manager (`pnpm add <name>@<version>
 *           --save-exact`, the same invocation the desktop publishes on
 *           `profileContext`) over the running version, then answer 200 with
 *           `restartRequired: true`. Overlaying never unloads the plugin, so it
 *           does not trip the in-use guard; the update lands on disk and the
 *           app restart that the page already offers applies it.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PLUGIN_NAME = "dsh-one-click-update";
export const RESTART_PATH = "/dsh-one-click-update/restart";
export const OVERLAY_PATH = "/dsh-one-click-update/overlay";

/** How long the helper waits for the shell to exit before giving up (ms). */
const QUIT_WAIT_MS = 20_000;

/** How long one overlay install may take before it is abandoned (ms). */
const OVERLAY_TIMEOUT_MS = 300_000;

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
 * The package manager invocation the desktop publishes on `profileContext`,
 * plus the profile directory it belongs to. `undefined` outside the desktop
 * (a plain `dsh web` Host publishes no such context).
 */
export function describeOverlayTarget(ctx) {
	let context;
	try {
		context = typeof ctx?.get === "function" ? ctx.get("profileContext") : void 0;
	} catch (error) {
		context = void 0;
	}
	const invocation = context?.packageManager;
	const directory = context?.profileDirectory;
	if (
		invocation === undefined || invocation === null || typeof invocation.command !== "string" ||
		invocation.command.trim() === "" || typeof directory !== "string" || directory === ""
	) {
		return { available: false, reason: "not-desktop-host" };
	}
	return {
		available: true,
		profile: typeof context.profile === "string" ? context.profile : void 0,
		directory,
		invocation: {
			command: invocation.command,
			args: Array.isArray(invocation.args) ? invocation.args.map(String) : [],
			env: invocation.env !== null && typeof invocation.env === "object" ? invocation.env : {}
		}
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
				profile: current.profile
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
			const result = await run(current, ["add", `${name}@${version}`, "--save-exact"]);
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
				restartRequired: true
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
		scope.effect(() => server.register({
			kind: "exact",
			path: OVERLAY_PATH,
			handler: createOverlayHandler({ target: () => describeOverlayTarget(ctx) })
		}), PLUGIN_NAME + ": overlay route");
	};
	if (typeof ctx.inject === "function") ctx.inject(["webServer"], register);
	else register(ctx);
}
