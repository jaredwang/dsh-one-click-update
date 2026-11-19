// Offline unit test for dsh-one-click-update/index.js (the Host half that owns
// the one-click restart route). No DSH, no network: fake request/response
// objects and injectable plans/launchers drive every branch.
//
// Run with `npm test` (Node 20+, no dependencies).
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OVERLAY_PATH,
	PLUGIN_NAME,
	RELEASE_AGE_OVERRIDE,
	RESTART_PATH,
	apply,
	compareVersions,
	createOverlayHandler,
	createRestartHandler,
	describeOverlayTarget,
	isDesktopHost,
	restartPlan
} from "../index.js";

const checks = [];
const ok = (name, cond, extra) => {
	checks.push({ name, pass: !!cond, extra });
	if (!cond) console.log("FAIL", name, extra ?? "");
};

const MAC_EXEC = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";

/* ------------------------------------------------------------------ */
/* Shell detection                                                     */
/* ------------------------------------------------------------------ */
{
	ok("constant name", PLUGIN_NAME === "dsh-one-click-update", PLUGIN_NAME);
	ok("constant path", RESTART_PATH === "/dsh-one-click-update/restart", RESTART_PATH);
	ok("no IPC means no desktop", isDesktopHost({ hasIpc: false }) === false);
	ok("IPC alone can be trusted", isDesktopHost({ hasIpc: true, trustIpc: true }) === true);
	ok(
		"parent running the same executable counts",
		isDesktopHost({ hasIpc: true, execPath: MAC_EXEC, parentCommand: MAC_EXEC }) === true
	);
	ok(
		"parent executable with arguments counts",
		isDesktopHost({ hasIpc: true, execPath: MAC_EXEC, parentCommand: MAC_EXEC + " /x/y" }) === true
	);
	ok(
		"a terminal parent does not count",
		isDesktopHost({ hasIpc: true, execPath: MAC_EXEC, parentCommand: "/bin/zsh -l" }) === false
	);
	ok(
		"unreadable ps falls back to the IPC channel",
		isDesktopHost({ hasIpc: true, execPath: MAC_EXEC, parentCommand: "" }) === true
	);
}

/* ------------------------------------------------------------------ */
/* Restart plans                                                       */
/* ------------------------------------------------------------------ */
{
	const refused = restartPlan({ desktop: false });
	ok("no desktop host is refused", refused.supported === false && refused.reason === "not-desktop", refused);

	const darwin = restartPlan({
		desktop: true,
		platform: "darwin",
		execPath: MAC_EXEC,
		parentPid: 4242,
		bundleId: "com.deepseek.dsh"
	});
	ok("macOS plan is supported", darwin.supported === true && darwin.mode === "osascript", darwin);
	ok("macOS plan finds the app bundle", darwin.appPath === "/Applications/DeepSeek Harness.app", darwin.appPath);
	ok("macOS plan keeps the bundle id", darwin.bundleId === "com.deepseek.dsh", darwin.bundleId);
	ok("macOS script asks the app to quit", darwin.script.includes(`tell application id "com.deepseek.dsh" to quit`), darwin.script);
	ok("macOS script waits for the shell pid", darwin.script.includes("PID=4242") && darwin.script.includes('kill -0 "$PID"'), darwin.script);
	ok("macOS script opens the app again", darwin.script.includes('open_app -a "$APP"'), darwin.script);
	ok("macOS script retries in rounds", darwin.script.includes('while [ "$round" -lt 2 ]') && darwin.script.includes("try_open open_app -a"), darwin.script);
	ok("macOS script asks LaunchServices whether the app runs", darwin.script.includes('/usr/bin/lsappinfo find bundleID="$BUNDLE"'), darwin.script);
	ok("macOS script tries a new instance before giving up", darwin.script.includes('try_open open_app -n -a "$APP"'), darwin.script);
	ok("macOS script opens by bundle id too", darwin.script.includes('try_open open_app -b "$BUNDLE"'), darwin.script);
	ok("macOS script strips Electron runtime variables before reopening", darwin.script.includes("-u ELECTRON_RUN_AS_NODE") && darwin.script.includes("-u NODE_OPTIONS"), darwin.script);
	ok(
		"macOS script does not report a short-lived app as success",
		darwin.script.includes("showed up and went away again") && darwin.script.includes("\t\treturn 1"),
		darwin.script
	);
	ok("macOS script watches the whole bundle", darwin.script.includes('/usr/bin/pgrep -f "$APP/Contents/MacOS/"'), darwin.script);
	ok("macOS script logs its decisions", darwin.script.includes("dsh-one-click-update-restart.log") && darwin.script.includes("say \"app is gone"), darwin.script);
	ok("macOS script removes itself", darwin.script.includes('trap '), darwin.script);

	const noBundle = restartPlan({
		desktop: true,
		platform: "darwin",
		execPath: "/usr/local/bin/node",
		parentPid: 1
	});
	ok("macOS without an app bundle is refused", noBundle.supported === false && noBundle.reason === "not-app-bundle", noBundle);

	const win = restartPlan({ desktop: true, platform: "win32", execPath: "C:\\DSH\\DSH.exe", parentPid: 99 });
	ok("windows plan is supported", win.supported === true && win.mode === "taskkill", win);
	ok("windows script kills and restarts", win.script.includes("taskkill /PID 99 /T") && win.script.includes("DSH.exe"), win.script);

	const linux = restartPlan({ desktop: true, platform: "linux", execPath: "/opt/dsh/dsh", parentPid: 77 });
	ok("linux plan is supported", linux.supported === true && linux.mode === "sigterm", linux);
	ok("linux script signals and restarts", linux.script.includes('kill -TERM "$PID"') && linux.script.includes("/opt/dsh/dsh"), linux.script);

	const exotic = restartPlan({ desktop: true, platform: "aix", execPath: "/x", parentPid: 1 });
	ok("unknown platforms are refused", exotic.supported === false && exotic.reason === "unsupported-platform", exotic);
}

/* ------------------------------------------------------------------ */
/* Route handler                                                       */
/* ------------------------------------------------------------------ */
function fakeResponse() {
	const res = {
		status: 0,
		headers: null,
		body: "",
		writeHead(status, headers) {
			res.status = status;
			res.headers = headers ?? null;
			return res;
		},
		end(text) {
			res.body = text === undefined ? "" : String(text);
			return res;
		}
	};
	return res;
}
function fakeRequest(method, url, headers, body) {
	return { method, url, headers: headers ?? {}, body };
}
const jsonBody = (res) => {
	try {
		return JSON.parse(res.body);
	} catch (error) {
		return undefined;
	}
};
const plan = () => ({
	supported: true,
	platform: "darwin",
	mode: "osascript",
	appPath: "/Applications/DeepSeek Harness.app",
	bundleId: "com.deepseek.dsh",
	parentPid: 1,
	script: "#!/bin/sh\n"
});

{
	let launches = 0;
	const handler = createRestartHandler({
		plan,
		launch: () => {
			launches += 1;
			return "/tmp/helper.sh";
		}
	});

	const capability = fakeResponse();
	await handler(fakeRequest("GET", RESTART_PATH), capability);
	const capabilityBody = jsonBody(capability);
	ok("GET describes the restart", capability.status === 200 && capabilityBody.ok === true, capability.body);
	ok(
		"GET exposes no script",
		capabilityBody.restart && capabilityBody.restart.supported === true && capabilityBody.restart.script === undefined,
		capability.body
	);
	ok(
		"GET points at the helper log",
		typeof capabilityBody.log === "string" && capabilityBody.log.endsWith("dsh-one-click-update-restart.log"),
		capability.body
	);

	const dry = fakeResponse();
	await handler(fakeRequest("POST", RESTART_PATH + "?dryRun=1"), dry);
	const dryBody = jsonBody(dry);
	ok("dryRun answers 200", dry.status === 200 && dryBody.dryRun === true, dry.body);
	ok("dryRun launches nothing", launches === 0, launches);

	const wrongMethod = fakeResponse();
	await handler(fakeRequest("PUT", RESTART_PATH), wrongMethod);
	ok("other methods are refused", wrongMethod.status === 405, wrongMethod.status);

	const started = fakeResponse();
	await handler(fakeRequest("POST", RESTART_PATH), started);
	ok("POST starts the helper", started.status === 202 && jsonBody(started).helper === "/tmp/helper.sh", started.body);
	ok(
		"POST points at the helper log",
		typeof jsonBody(started).log === "string" && jsonBody(started).log.endsWith("dsh-one-click-update-restart.log"),
		started.body
	);
	ok("POST launched once", launches === 1, launches);

	const whileBusy = fakeResponse();
	await handler(fakeRequest("POST", RESTART_PATH), whileBusy);
	ok("a second restart is refused while one runs", whileBusy.status === 409, whileBusy.body);
	ok("the refused restart launches nothing", launches === 1, launches);

	const foreign = fakeResponse();
	await handler(
		fakeRequest("POST", RESTART_PATH, { origin: "https://evil.example", host: "127.0.0.1:62550" }),
		foreign
	);
	ok("a foreign origin is refused", foreign.status === 403, foreign.body);

	const sameOrigin = fakeResponse();
	await handler(
		fakeRequest("GET", RESTART_PATH, { origin: "http://127.0.0.1:62550", host: "127.0.0.1:62550" }),
		sameOrigin
	);
	ok("the same origin is accepted", sameOrigin.status === 200, sameOrigin.body);
}

{
	const refused = createRestartHandler({
		plan: () => ({ supported: false, reason: "not-desktop" }),
		launch: () => {
			throw new Error("must not launch");
		}
	});
	const res = fakeResponse();
	await refused(fakeRequest("POST", RESTART_PATH), res);
	const body = jsonBody(res);
	ok("a web host refuses to restart the app", res.status === 501 && body.reason === "not-desktop", res.body);
}

{
	const failing = createRestartHandler({
		plan,
		launch: () => {
			throw new Error("spawn failed");
		}
	});
	const res = fakeResponse();
	await failing(fakeRequest("POST", RESTART_PATH), res);
	ok("a failed launch is reported", res.status === 500 && jsonBody(res).error === "spawn failed", res.body);
}

/* ------------------------------------------------------------------ */
/* Overlay installs                                                    */
/* ------------------------------------------------------------------ */
{
	ok("versions compare by number", compareVersions("0.30.1", "0.28.2") > 0, compareVersions("0.30.1", "0.28.2"));
	ok("equal versions compare flat", compareVersions("1.2.3", "1.2.3") === 0);
	ok("prereleases sort before releases", compareVersions("0.2.0-rc.1", "0.2.0") < 0);
	ok("releases sort after prereleases", compareVersions("0.2.0", "0.2.0-rc.1") > 0);
}

{
	const missing = describeOverlayTarget(undefined, { execPath: "/usr/bin/node", exists: () => false });
	ok(
		"no profile context means no overlay",
		missing.available === false && missing.reason === "no-profile-directory",
		missing
	);
	const noManager = describeOverlayTarget({ get: () => ({ dir: "/tmp/p" }) }, { execPath: "/usr/bin/node", exists: () => false });
	ok(
		"a context without a package manager and without a bundled pnpm is refused",
		noManager.available === false && noManager.reason === "no-package-manager",
		noManager
	);
	const described = describeOverlayTarget({
		get: () => ({ packageManager: { command: "/x/pnpm", args: ["--dir"], env: { PATH: "/x" } }, dir: "/tmp/p", profile: "desktop" })
	});
	ok("the published invocation is used", described.available === true && described.profile === "desktop", described);
	ok(
		"the invocation keeps its own argv",
		described.invocation.command === "/x/pnpm" && described.invocation.args[0] === "--dir",
		described.invocation
	);
	ok("the directory comes from `dir`", described.directory === "/tmp/p", described.directory);
	ok("the source says the host published it", described.source === "host", described.source);
	const legacy = describeOverlayTarget({
		get: () => ({ packageManager: { command: "/x/pnpm" }, profileDirectory: "/tmp/legacy" })
	});
	ok("an older profileDirectory still resolves", legacy.available === true && legacy.directory === "/tmp/legacy", legacy);
	const bundled = describeOverlayTarget(
		{ get: () => ({ dir: "/tmp/p" }) },
		{
			execPath: "/Applications/App.app/Contents/MacOS/App",
			exists: (candidate) => candidate.endsWith("pnpm/bin/pnpm.mjs")
		}
	);
	ok(
		"the desktop payload is used when the Host publishes none",
		bundled.available === true && bundled.source === "bundled",
		bundled
	);
	ok(
		"the bundled invocation runs the app binary as node",
		bundled.invocation.command === "/Applications/App.app/Contents/MacOS/App" &&
			bundled.invocation.args[0] === "--expose-internals" &&
			bundled.invocation.env.ELECTRON_RUN_AS_NODE === "1",
		bundled.invocation
	);
	const reserved = describeOverlayTarget(
		{ get: () => ({}) },
		{
			execPath: "/Applications/App.app/Contents/MacOS/App",
			home: "/tmp/dsh-home",
			exists: (candidate) =>
				candidate.endsWith("pnpm/bin/pnpm.mjs") || candidate === "/tmp/dsh-home/profiles/desktop/package.json"
		}
	);
	ok(
		"a packaged app Host falls back to its reserved desktop profile",
		reserved.available === true && reserved.directory === "/tmp/dsh-home/profiles/desktop",
		reserved
	);
	ok("the reserved profile names the profile too", reserved.profile === void 0, reserved.profile);
	const outsideApp = describeOverlayTarget(
		{ get: () => ({}) },
		{ execPath: "/usr/bin/node", exists: () => false }
	);
	ok(
		"no packaged app means no reserved profile guess",
		outsideApp.available === false && outsideApp.reason === "no-profile-directory",
		outsideApp
	);
}

const overlayDir = mkdtempSync(join(tmpdir(), "ocu-overlay-"));
const overlayManifest = join(overlayDir, "package.json");
const overlayPackage = join(overlayDir, "node_modules", "dsh-better-sidebar");
mkdirSync(overlayPackage, { recursive: true });
const writeProfile = (version) => {
	writeFileSync(overlayManifest, JSON.stringify({ name: "desktop", dependencies: { "dsh-better-sidebar": version } }, null, 2));
};
const writeInstalled = (version) => {
	writeFileSync(join(overlayPackage, "package.json"), JSON.stringify({ name: "dsh-better-sidebar", version }, null, 2));
};
writeProfile("0.28.2");
writeInstalled("0.28.2");
const overlayTarget = () => ({
	available: true,
	profile: "desktop",
	directory: overlayDir,
	invocation: { command: "/x/pnpm", args: [], env: {} }
});

function fakeStreamRequest(method, url, headers, payload) {
	const request = new EventEmitter();
	request.method = method;
	request.url = url;
	request.headers = headers ?? {};
	process.nextTick(() => {
		if (payload !== undefined) request.emit("data", Buffer.from(JSON.stringify(payload)));
		request.emit("end");
	});
	return request;
}

{
	const runs = [];
	const handler = createOverlayHandler({
		target: overlayTarget,
		run: async (current, args) => {
			runs.push(args);
			const version = args[1].slice(args[1].lastIndexOf("@") + 1);
			writeProfile(version);
			writeInstalled(version);
			return { exitCode: 0, stdout: "Progress: resolved 1", stderr: "", timedOut: false };
		}
	});

	const capability = fakeResponse();
	await handler(fakeRequest("GET", OVERLAY_PATH), capability);
	ok("GET describes the overlay", capability.status === 200 && jsonBody(capability).overlay === true, capability.body);

	const wrongMethod = fakeResponse();
	await handler(fakeRequest("PUT", OVERLAY_PATH), wrongMethod);
	ok("the overlay refuses other methods", wrongMethod.status === 405, wrongMethod.status);

	const done = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "0.30.1" }), done);
	const doneBody = jsonBody(done);
	ok("a valid overlay install is accepted", done.status === 200 && doneBody.ok === true, done.body);
	ok("the overlay reports the new version", doneBody.version === "0.30.1" && doneBody.from === "0.28.2", done.body);
	ok("the overlay asks for a restart", doneBody.restartRequired === true, done.body);
	ok(
		"the overlay installs exact and over the running copy",
		runs.length === 1 && JSON.stringify(runs[0]) === JSON.stringify(["add", "dsh-better-sidebar@0.30.1", "--save-exact"]),
		JSON.stringify(runs)
	);

	const streamed = fakeResponse();
	await handler(fakeStreamRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "0.30.2" }), streamed);
	ok("a streamed JSON body is read", streamed.status === 200 && jsonBody(streamed).ok === true, streamed.body);

	const downgrade = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "0.28.0" }), downgrade);
	ok("a downgrade is refused before running pnpm", downgrade.status === 400 && runs.length === 2, downgrade.body);

	const undeclared = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "left-pad", version: "1.0.0" }), undeclared);
	ok("a package outside the profile is refused", undeclared.status === 400 && jsonBody(undeclared).error.includes("not a dependency"), undeclared.body);

	const badName = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "../../etc/passwd", version: "1.0.0" }), badName);
	ok("a package name that is not a name is refused", badName.status === 400, badName.body);

	const badVersion = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "latest" }), badVersion);
	ok("a tag is not a version", badVersion.status === 400, badVersion.body);

	const foreign = fakeResponse();
	await handler(
		fakeRequest("POST", OVERLAY_PATH, { origin: "https://evil.example", host: "127.0.0.1:62550" }, { name: "dsh-better-sidebar", version: "0.30.3" }),
		foreign
	);
	ok("a foreign origin cannot overlay", foreign.status === 403, foreign.body);
}

/* The skip-hold switch: one install may lift pnpm's release-age wait. */
{
	const forcedRuns = [];
	const handler = createOverlayHandler({
		target: overlayTarget,
		run: async (current, args) => {
			forcedRuns.push(args);
			const version = args[1].slice(args[1].lastIndexOf("@") + 1);
			writeProfile(version);
			writeInstalled(version);
			return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
		}
	});
	const capability = fakeResponse();
	await handler(fakeRequest("GET", OVERLAY_PATH), capability);
	ok("the Host advertises the release-age override", jsonBody(capability).force === true, capability.body);
	const res = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "0.30.4", force: true }), res);
	const body = jsonBody(res);
	ok("a forced overlay install is accepted", res.status === 200 && body.ok === true, res.body);
	ok(
		"a forced install lifts the wait for that one call",
		forcedRuns.length === 1 &&
			JSON.stringify(forcedRuns[0]) === JSON.stringify(["add", "dsh-better-sidebar@0.30.4", "--save-exact", RELEASE_AGE_OVERRIDE]),
		JSON.stringify(forcedRuns)
	);
	ok("a forced install reports the override", body.forced === true && body.releaseAgeOverride === RELEASE_AGE_OVERRIDE, res.body);
}

{
	const handler = createOverlayHandler({
		target: overlayTarget,
		run: async () => ({ exitCode: 1, stdout: "ERR_PNPM_MINIMUM_RELEASE_AGE", stderr: "release-age", timedOut: false })
	});
	const held = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "9.0.0" }), held);
	ok("a held release is reported as a hold", held.status === 409 && jsonBody(held).code === "RELEASE_TOO_FRESH", held.body);
}

{
	const handler = createOverlayHandler({
		target: overlayTarget,
		run: async () => ({ exitCode: 1, stdout: "", stderr: "ERR_PNPM_FETCH_404", timedOut: false })
	});
	const broken = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "9.0.0" }), broken);
	ok("a failed install is reported", broken.status === 500 && jsonBody(broken).code === "install-failed", broken.body);
}

{
	const handler = createOverlayHandler({
		target: overlayTarget,
		run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })
	});
	const stale = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "9.0.0" }), stale);
	ok("files that did not change are not success", stale.status === 500 && jsonBody(stale).code === "install-mismatch", stale.body);
}

{
	const refused = createOverlayHandler({
		target: () => ({ available: false, reason: "not-desktop-host" }),
		run: async () => {
			throw new Error("must not run");
		}
	});
	const capability = fakeResponse();
	await refused(fakeRequest("GET", OVERLAY_PATH), capability);
	ok("a web host describes why overlay is unavailable", capability.status === 200 && jsonBody(capability).overlay === false, capability.body);
	const res = fakeResponse();
	await refused(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "0.30.1" }), res);
	const body = jsonBody(res);
	ok("a web host refuses to overlay", res.status === 501 && typeof body.hint === "string", res.body);
}

{
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const handler = createOverlayHandler({
		target: overlayTarget,
		run: async () => {
			await gate;
			return { exitCode: 1, stdout: "", stderr: "nope", timedOut: false };
		}
	});
	const first = handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "9.0.0" }), fakeResponse());
	await new Promise((resolve) => setTimeout(resolve, 20));
	const second = fakeResponse();
	await handler(fakeRequest("POST", OVERLAY_PATH, {}, { name: "dsh-better-sidebar", version: "9.0.1" }), second);
	ok("a concurrent overlay is refused", second.status === 409, second.body);
	release();
	await first;
}
rmSync(overlayDir, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* Plugin wiring                                                       */
/* ------------------------------------------------------------------ */
{
	const routes = [];
	const disposers = [];
	const warnings = [];
	const ctx = {
		logger: { warn: (line) => warnings.push(line) },
		inject(deps, callback) {
			ok("apply injects the web server", JSON.stringify(deps) === '["webServer"]', JSON.stringify(deps));
			callback({
				webServer: {
					register(route) {
						routes.push(route);
						return () => routes.pop();
					}
				},
				effect(fn, label) {
					disposers.push(fn());
					ok("apply labels the route effect", typeof label === "string" && label.length > 0, label);
					return () => {};
				}
			});
		}
	};
	apply(ctx);
	ok("apply registers both routes", routes.length === 2, routes.length);
	ok("the first route is the restart path", routes[0] && routes[0].path === RESTART_PATH && routes[0].kind === "exact", routes[0] && routes[0].path);
	ok("the second route is the overlay path", routes[1] && routes[1].path === OVERLAY_PATH && routes[1].kind === "exact", routes[1] && routes[1].path);
	ok("both routes have handlers", typeof (routes[0] && routes[0].handler) === "function" && typeof (routes[1] && routes[1].handler) === "function");
	ok("both routes are disposable", disposers.length === 2 && disposers.every((dispose) => typeof dispose === "function"), disposers.length);
	ok("no warning with a web server", warnings.length === 0, warnings);
	for (const dispose of disposers) dispose();
	ok("disposing removes the routes", routes.length === 0, routes.length);
}

{
	const warnings = [];
	apply({
		logger: { warn: (line) => warnings.push(line) },
		inject(deps, callback) {
			callback({ effect() {} });
		}
	});
	ok("a host without a web server warns", warnings.length === 1 && warnings[0].includes("no web server"), warnings);
}

const failed = checks.filter((check) => !check.pass);
console.log(failed.length === 0 ? `ALL HOST CHECKS PASSED (${checks.length})` : `${failed.length}/${checks.length} HOST CHECKS FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
