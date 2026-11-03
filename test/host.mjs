// Offline unit test for dsh-one-click-update/index.js (the Host half that owns
// the one-click restart route). No DSH, no network: fake request/response
// objects and injectable plans/launchers drive every branch.
//
// Run with `npm test` (Node 20+, no dependencies).
import {
	PLUGIN_NAME,
	RESTART_PATH,
	apply,
	createRestartHandler,
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
	ok("macOS script opens the app again", darwin.script.includes('/usr/bin/open "$APP"'), darwin.script);
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
function fakeRequest(method, url, headers) {
	return { method, url, headers: headers ?? {} };
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
	ok("apply registers one route", routes.length === 1, routes.length);
	ok("the route is the restart path", routes[0] && routes[0].path === RESTART_PATH && routes[0].kind === "exact", routes[0] && routes[0].path);
	ok("the route has a handler", typeof (routes[0] && routes[0].handler) === "function");
	ok("the route is disposable", disposers.length === 1 && typeof disposers[0] === "function", disposers.length);
	ok("no warning with a web server", warnings.length === 0, warnings);
	disposers[0]?.();
	ok("disposing removes the route", routes.length === 0, routes.length);
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
