// Offline smoke test for dsh-one-click-update/client.js: a mini React and a fake
// fetch/market/desktop bridge drive the entry icon and the update page through
// its states (auto run, progress, retry, unsupported market, no desktop bridge).
//
// Run with `npm test` (Node 20+, no dependencies).
import fs from "node:fs";
import vm from "node:vm";

const SRC = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
const checks = [];
const ok = (name, cond, extra) => {
	checks.push({ name, pass: !!cond, extra });
	if (!cond) console.log("FAIL", name, extra ?? "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Mini React                                                          */
/* ------------------------------------------------------------------ */
function createReact() {
	let current = null;
	const roots = new Set();
	const effectsOf = (inst) => inst.hooks.filter((h) => h && h.kind === "effect");

	function useState(init) {
		const inst = current;
		const i = inst.index++;
		if (!inst.hooks[i]) inst.hooks[i] = { kind: "state", value: typeof init === "function" ? init() : init };
		const slot = inst.hooks[i];
		const set = (next) => {
			slot.value = typeof next === "function" ? next(slot.value) : next;
			renderInto(inst.root);
		};
		return [slot.value, set];
	}
	function useEffect(fn, deps) {
		const inst = current;
		const i = inst.index++;
		let slot = inst.hooks[i];
		if (!slot) slot = inst.hooks[i] = { kind: "effect", deps: undefined, cleanup: undefined, fn };
		slot.fn = fn;
		const prev = slot.deps;
		const changed = prev === undefined || deps === undefined || prev.length !== deps.length || deps.some((d, k) => !Object.is(d, prev[k]));
		if (changed) {
			slot.deps = deps;
			slot.pending = true;
		}
	}
	function useRef(value) {
		const inst = current;
		const i = inst.index++;
		if (!inst.hooks[i]) inst.hooks[i] = { kind: "ref", current: value };
		return inst.hooks[i];
	}
	function createElement(type, props, ...children) {
		const flat = [];
		const push = (c) => {
			if (c === null || c === undefined || c === false || c === true) return;
			if (Array.isArray(c)) return c.forEach(push);
			flat.push(c);
		};
		push(children);
		return { type, props: { ...(props || {}), children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat } };
	}
	function expand(el) {
		if (el === null || el === undefined || typeof el === "boolean") return null;
		if (Array.isArray(el)) return el.map(expand);
		if (typeof el.type === "function") return expand(el.type(el.props));
		if (el.props && el.props.children !== undefined) return { type: el.type, props: { ...el.props, children: expand(el.props.children) } };
		return el;
	}
	function renderInto(root) {
		if (root.inst === null) root.inst = { hooks: [] };
		const inst = { index: 0, hooks: root.inst.hooks, root, props: root.props };
		root.inst = inst;
		current = inst;
		root.output = expand(root.Component(root.props));
		current = null;
		for (const slot of effectsOf(inst)) {
			if (!slot.pending) continue;
			slot.pending = false;
			if (typeof slot.cleanup === "function") slot.cleanup();
			slot.cleanup = slot.fn();
		}
	}
	function mount(Component, props) {
		const root = { Component, props, inst: null, output: null };
		roots.add(root);
		renderInto(root);
		return {
			root,
			get output() {
				return root.output;
			},
			rerender(next) {
				root.props = { ...root.props, ...(next || {}) };
				renderInto(root);
			},
			unmount() {
				for (const slot of effectsOf(root.inst)) if (typeof slot.cleanup === "function") slot.cleanup();
				roots.delete(root);
			}
		};
	}
	return { createElement, useState, useEffect, useRef, mount };
}

/* ------------------------------------------------------------------ */
/* Fake document / bridge                                              */
/* ------------------------------------------------------------------ */
function makeDocument() {
	const styles = new Map();
	const head = {
		children: [],
		appendChild(el) {
			this.children.push(el);
			el.isConnected = true;
			styles.set(el.id, el);
			return el;
		}
	};
	return {
		head,
		getElementById(id) {
			return styles.get(id) || null;
		},
		createElement() {
			return {
				id: "",
				textContent: "",
				isConnected: false,
				remove() {
					this.isConnected = false;
				}
			};
		}
	};
}

const bridgeCalls = { status: 0, subscribe: 0, open: 0, listeners: [] };
function makeBridge(phase, delayMs) {
	return {
		status: async () => {
			bridgeCalls.status++;
			if (delayMs) await sleep(delayMs);
			if (phase === undefined) return { phase: "idle" };
			if (phase === "available") return { phase, version: "9.9.9", percent: 0 };
			return { phase };
		},
		subscribe(listener) {
			bridgeCalls.subscribe++;
			bridgeCalls.listeners.push(listener);
			return () => {
				bridgeCalls.detached = true;
			};
		},
		open: async () => {
			bridgeCalls.open++;
		}
	};
}

/* ------------------------------------------------------------------ */
/* Fake market API                                                     */
/* ------------------------------------------------------------------ */
function makeApi(options) {
	const api = {
		posted: [],
		polls: {},
		summaryCalls: 0,
		summaryStatus: options.summaryStatus ?? 200,
		packages: options.packages ?? [],
		failNames: options.failNames ?? [],
		holdNames: options.holdNames ?? [],
		restartNames: options.restartNames ?? [],
		restarts: [],
		async fetch(url, init) {
			const method = (init && init.method) || "GET";
			const path = String(url);
			if (path.startsWith("/dsh-market/api/v1/capabilities")) {
				return resp(200, {
					schema: "dsh-market/update-api/v1",
					apiVersion: 1,
					runtime: "desktop",
					bootId: options.bootId ?? "boot-1",
					features: { check: true, update: true, progress: true, rollback: true, restart: false, updatesSummary: true },
					restart: { supported: false, managedBy: "desktop-host" }
				});
			}
			if (path.startsWith("/dsh-market/api/v1/updates/summary")) {
				api.summaryCalls += 1;
				if (api.summaryStatus === 404) return resp(404, { error: "not found" });
				return resp(200, { schema: "dsh-market/update-api/v1", checked: 7, updatable: api.packages.length, packages: api.packages });
			}
			if (path === "/dsh-market/api/v1/updates" && method === "POST") {
				const name = JSON.parse(init.body).packageName;
				api.posted.push(name);
				return resp(202, { operation: { operationId: "op-" + name } });
			}
			if (path === "/dsh-one-click-update/restart" && method === "POST") {
				api.restarts.push(path);
				return resp(202, { ok: true, helper: "/tmp/helper.sh", restart: { supported: true, mode: "osascript" } });
			}
			if (path.startsWith("/dsh-market/api/v1/operations?operationId=")) {
				const id = decodeURIComponent(path.split("=")[1]);
				const n = (api.polls[id] = (api.polls[id] || 0) + 1);
				const name = id.slice(3);
				if (n < 2) return resp(200, { operation: { operationId: id, state: "running", percent: 55 } });
				if (api.holdNames.indexOf(name) !== -1) {
					// What the market really answers for a maturity hold: a failed
					// operation whose 409 body carried no `stale` flag, so the v1 API
					// reports the generic busy code and the Chinese hold sentence.
					return resp(200, {
						operation: {
							operationId: id,
							state: "failed",
							failure: { code: "OPERATION_BUSY", message: "当前最新版仍在等待期；请刷新市场以确认可安装的成熟版本。", retryable: true }
						}
					});
				}
				if (api.failNames.indexOf(name) !== -1) {
					return resp(200, {
						operation: { operationId: id, state: "failed", failure: { code: "AGENTS_RUNNING", message: "agents are running", retryable: true } }
					});
				}
				return resp(200, {
					operation: {
						operationId: id,
						state: "succeeded",
						installedVersion: "9.9.9",
						restartRequired: api.restartNames.indexOf(name) !== -1
					}
				});
			}
			throw new Error("unexpected fetch " + method + " " + path);
		}
	};
	return api;
}

function resp(status, body) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => body,
		text: async () => JSON.stringify(body)
	};
}

/* ------------------------------------------------------------------ */
/* Load one module instance                                            */
/* ------------------------------------------------------------------ */
async function load(options) {
	const document = makeDocument();
	const localStorage = { data: new Map(), setItem(k, v) { this.data.set(k, v); }, getItem(k) { return this.data.get(k) ?? null; }, removeItem(k) { this.data.delete(k); } };
	for (const [key, value] of Object.entries(options.storage ?? {})) localStorage.data.set(key, value);
	const api = makeApi(options);
	const reloads = { count: 0 };
	const sessionStorage = { data: new Map(), setItem(k, v) { this.data.set(k, v); }, getItem(k) { return this.data.get(k) ?? null; } };
	const sandbox = {
		document,
		location: { reload() { reloads.count += 1; } },
		sessionStorage,
		localStorage,
		fetch: (url, init) => api.fetch(url, init),
		console,
		setTimeout,
		clearTimeout,
		Promise,
		Math,
		JSON,
		Object,
		Array,
		String,
		Number,
		Set,
		Error,
		Infinity
	};
	let factory = null;
	sandbox.globalThis = sandbox;
	sandbox.window = sandbox;
	sandbox.__ModuleLoader__ = {
		load(def) {
			factory = def.factory;
			sandbox.__loadedId = def.id;
		}
	};
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox, { filename: "client.js" });
	const React = createReact();
	const requires = [];
	const mod = factory((name) => {
		requires.push(name);
		if (name === "react") return React;
		throw new Error("unexpected require " + name);
	});
	const dicts = {};
	const registered = [];
	const injectedKeys = [];
	const ctx = {
		effect(fn) {
			fn();
			return () => {};
		},
		on() {
			return () => {};
		},
		locale: {
			register(ns, dict) {
				dicts[ns] = dict;
				return () => {};
			},
			bind(ns) {
				return (key, params) => {
					const bag = dicts[ns] || {};
					const raw = (bag.zh && bag.zh[key]) ?? key;
					return params ? raw.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k]))) : raw;
				};
			}
		},
		slots: {
			inject(key, cb) {
				injectedKeys.push(key);
				return cb();
			},
			register(o, c) {
				registered.push({ options: o, component: c });
				return () => {};
			}
		}
	};
	if (options.bridge !== false) sandbox.window.dshDesktop = { updates: makeBridge(options.appPhase, options.statusDelay) };
	mod.apply(ctx);
	const t = ctx.locale.bind("dsh-one-click-update");
	return { sandbox, api, mod, React, requires, dicts, registered, injectedKeys, document, t, reloads, sessionStorage, localStorage };
}

function textOf(node) {
	if (node === null || node === undefined) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (typeof node !== "object") return "";
	if (node.props && node.props.children !== undefined) return textOf(node.props.children);
	return "";
}
function findButton(node, label) {
	if (node === null || typeof node !== "object") return undefined;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findButton(child, label);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}
	if (node.type === "button" && textOf(node).includes(label)) return node;
	if (node.props && node.props.children !== undefined) return findButton(node.props.children, label);
	return undefined;
}

/* ------------------------------------------------------------------ */
/* Scenario 1 — plugins updatable + app update available               */
/* ------------------------------------------------------------------ */
{
	const env = await load({
		appPhase: "available",
		packages: [
			{ name: "alpha", source: "npm", installedVersion: "1.0.0", latestVersion: "1.1.0" },
			{ name: "beta", source: "npm", installedVersion: "2.0.0", latestVersion: "2.1.0" }
		],
		holdNames: ["beta"],
		restartNames: ["alpha"]
	});
	ok("module id", env.sandbox.__loadedId === "dsh-one-click-update", env.sandbox.__loadedId);
	ok("requires only react", JSON.stringify(env.requires) === '["react"]', JSON.stringify(env.requires));
	ok("inject list", JSON.stringify(env.mod.inject) === '["slots","locale"]', JSON.stringify(env.mod.inject));
	await sleep(80);
	ok("market summary fetched", env.api.summaryCalls === 1, env.api.summaryCalls);
	ok("styles injected", [...env.document.head.children].some((el) => el.id === "dsh-one-click-update-style" && String(el.textContent).includes(".dsh-ocu-rows")));
	ok("locale dicts", !!(env.dicts["dsh-one-click-update"] && env.dicts["dsh-one-click-update"].zh && env.dicts["dsh-one-click-update"].en));
	ok("slot inject keys", JSON.stringify(env.injectedKeys) === '["sidebar.panellist","main"]', JSON.stringify(env.injectedKeys));

	const entry = env.registered.find((r) => r.options.name === "sidebar.panellist");
	const page = env.registered.find((r) => r.options.name === "main");
	ok("panellist register", !!entry && entry.options.id === "one-click-update" && entry.options.order === 5, entry && entry.options);
	ok("panellist label", entry && entry.options.label() === "一键更新", entry && entry.options.label());
	ok("main register", !!page && page.options.key === "one-click-update", page && page.options);

	const glyph = env.React.mount(entry.component, { t: env.t, size: 16 });
	ok("glyph tone available with plugin updates", glyph.output.props["data-tone"] === "available", glyph.output.props["data-tone"]);
	ok("glyph title counts plugins", String(glyph.output.props.title).includes("2 个插件可更新"), glyph.output.props.title);
	glyph.unmount();

	const view = env.React.mount(page.component, { t: env.t });
	const initial = JSON.stringify(view.output);
	ok("page title", initial.includes("一键更新"), initial.slice(0, 200));
	ok("page sections", initial.includes("插件市场") && initial.includes("DSH 桌面 App"), initial.slice(0, 400));
	ok("page shows a plugin action", /全部更新|更新中/.test(initial), initial.slice(0, 600));

	await sleep(350);
	ok("auto run posts first plugin", env.api.posted[0] === "alpha", JSON.stringify(env.api.posted));
	const running = JSON.stringify(view.output);
	ok("running status text", running.includes("正在更新"), running.slice(0, 800));
	ok("running progress bar", running.includes("dsh-ocu-bar"), running.slice(0, 800));

	await sleep(2600);
	ok("both plugins posted once", JSON.stringify(env.api.posted) === '["alpha","beta"]', JSON.stringify(env.api.posted));
	const done = JSON.stringify(view.output);
	ok("row shows versions", done.includes("1.1.0") && done.includes("\u2192"), done.slice(0, 1200));
	ok("row shows installed", done.includes("已更新到 9.9.9"), done.slice(0, 1200));
	ok("row shows the maturity hold", done.includes("等待成熟期"), done.slice(0, 1600));
	ok("held plugin is not retryable", !done.includes("重试失败项") && done.includes("重新检查"), done.slice(0, 1600));
	ok("restart hint shown", done.includes("需要重启"), done.slice(0, 1600));
	ok("restart button shown", done.includes("立即重启 DSH"), done.slice(0, 1600));
	ok("restart required keeps the page alive", env.reloads.count === 0, env.reloads.count);
	ok("app flow auto-started once", bridgeCalls.open === 1, bridgeCalls.open);
	ok("app section present", done.includes("发现新版本"), done.slice(0, 2000));

	const restartButton = findButton(view.output, "立即重启 DSH");
	ok("restart button is clickable", !!restartButton, restartButton);
	if (restartButton) {
		await restartButton.props.onClick();
		await sleep(60);
		const restarting = JSON.stringify(view.output);
		ok("restart posts to the plugin route", env.api.restarts.length === 1, JSON.stringify(env.api.restarts));
		ok("restart status shown", restarting.includes("正在重启 DSH"), restarting.slice(0, 1400));
	}
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 2 — nothing to update                                      */
/* ------------------------------------------------------------------ */
{
	const env = await load({ appPhase: "idle", packages: [] });
	await sleep(80);
	const entry = env.registered.find((r) => r.options.name === "sidebar.panellist");
	const page = env.registered.find((r) => r.options.name === "main");
	const glyph = env.React.mount(entry.component, { t: env.t, size: 16 });
	ok("glyph idle when nothing to do", glyph.output.props["data-tone"] === "idle", glyph.output.props["data-tone"]);
	ok("glyph idle title", String(glyph.output.props.title).includes("所有插件都是最新版本"), glyph.output.props.title);
	glyph.unmount();
	const view = env.React.mount(page.component, { t: env.t });
	const text = JSON.stringify(view.output);
	ok("page says plugins up to date", text.includes("所有插件都是最新版本"), text.slice(0, 600));
	ok("no update posted", env.api.posted.length === 0, JSON.stringify(env.api.posted));
	await sleep(300);
	ok("app not auto-run when idle", bridgeCalls.open === 1, bridgeCalls.open); // still 1 from scenario 1
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 3 — market missing (404)                                   */
/* ------------------------------------------------------------------ */
{
	const env = await load({ appPhase: "idle", summaryStatus: 404 });
	await sleep(80);
	const page = env.registered.find((r) => r.options.name === "main");
	const view = env.React.mount(page.component, { t: env.t });
	const text = JSON.stringify(view.output);
	ok("unsupported market notice", text.includes("未检测到插件市场"), text.slice(0, 600));
	ok("unsupported disables button", view.output && JSON.stringify(view.output).includes('"disabled":true'), text.slice(0, 800));
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 4 — plain browser tab (no desktop bridge)                  */
/* ------------------------------------------------------------------ */
{
	const env = await load({ bridge: false, appPhase: "idle", packages: [] });
	await sleep(80);
	const entry = env.registered.find((r) => r.options.name === "sidebar.panellist");
	const page = env.registered.find((r) => r.options.name === "main");
	const glyph = env.React.mount(entry.component, { t: env.t, size: 16 });
	ok("no bridge keeps glyph usable", ["idle", "available"].indexOf(glyph.output.props["data-tone"]) !== -1, glyph.output.props["data-tone"]);
	glyph.unmount();
	const view = env.React.mount(page.component, { t: env.t });
	const text = JSON.stringify(view.output);
	ok("no bridge explains app limit", text.includes("仅在桌面 App 内可用"), text.slice(0, 800));
	ok("no bridge disables app button", text.includes('"disabled":true'), text.slice(0, 800));
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 5 — late app status reply after the plugin run             */
/* ------------------------------------------------------------------ */
{
	const before = bridgeCalls.open;
	const env = await load({ appPhase: "available", packages: [], statusDelay: 400 });
	await sleep(80);
	const page = env.registered.find((r) => r.options.name === "main");
	const view = env.React.mount(page.component, { t: env.t });
	await sleep(150);
	ok("late app status: no open before the reply", bridgeCalls.open === before, bridgeCalls.open);
	await sleep(600);
	ok("late app status still auto-opens once", bridgeCalls.open === before + 1, bridgeCalls.open);
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 6 — a transient failure is still retryable                 */
/* ------------------------------------------------------------------ */
{
	const env = await load({
		appPhase: "idle",
		packages: [{ name: "beta", source: "npm", installedVersion: "2.0.0", latestVersion: "2.1.0" }],
		failNames: ["beta"]
	});
	await sleep(80);
	const page = env.registered.find((r) => r.options.name === "main");
	const view = env.React.mount(page.component, { t: env.t });
	await sleep(2600);
	const text = JSON.stringify(view.output);
	ok("transient failure keeps the retry action", text.includes("重试失败项"), text.slice(0, 1400));
	ok("transient failure shows its message", text.includes("agents are running"), text.slice(0, 1400));
	ok("a failed run does not reload the page", env.reloads.count === 0, env.reloads.count);
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 7 — only a held release: nothing to retry                  */
/* ------------------------------------------------------------------ */
{
	const env = await load({
		appPhase: "idle",
		packages: [{ name: "gamma", source: "npm", installedVersion: "3.0.0", latestVersion: "3.1.0" }],
		holdNames: ["gamma"]
	});
	await sleep(80);
	const page = env.registered.find((r) => r.options.name === "main");
	const view = env.React.mount(page.component, { t: env.t });
	await sleep(2600);
	const text = JSON.stringify(view.output);
	ok("held-only run counts the hold", text.includes("1 个等待成熟期"), text.slice(0, 1400));
	ok("held-only run offers no retry", !text.includes("重试失败项") && text.includes("重新检查"), text.slice(0, 1400));
	ok("held-only run does not reload", env.reloads.count === 0, env.reloads.count);
	ok("held row explains itself", text.includes("等待成熟期（发布满期限后可更新）"), text.slice(0, 1800));
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 8 — client-only update: the page reloads itself            */
/* ------------------------------------------------------------------ */
{
	const env = await load({
		appPhase: "idle",
		packages: [{ name: "delta", source: "npm", installedVersion: "4.0.0", latestVersion: "4.1.0" }]
	});
	await sleep(80);
	const page = env.registered.find((r) => r.options.name === "main");
	const view = env.React.mount(page.component, { t: env.t });
	await sleep(4200);
	const text = JSON.stringify(view.output);
	ok("client-only update reloads the page once", env.reloads.count === 1, env.reloads.count);
	ok("client-only update explains the reload", text.includes("刷新页面后即可新建会话"), text.slice(0, 1400));
	ok("reload is stamped to stop loops", env.sessionStorage.getItem("dsh-one-click-update:refreshed-at") !== null, [...env.sessionStorage.data.keys()]);
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 9 — a restart reminder survives a page reload              */
/* ------------------------------------------------------------------ */
{
	const env = await load({
		appPhase: "idle",
		packages: [],
		storage: { "dsh-one-click-update:restart-pending": JSON.stringify({ bootId: "boot-1", at: Date.now() }) }
	});
	await sleep(80);
	const entry = env.registered.find((r) => r.options.name === "sidebar.panellist");
	const page = env.registered.find((r) => r.options.name === "main");
	const glyph = env.React.mount(entry.component, { t: env.t, size: 16 });
	ok("restart reminder marks the glyph", glyph.output.props["data-tone"] === "available", glyph.output.props["data-tone"]);
	ok("restart reminder changes the tooltip", String(glyph.output.props.title).includes("需要重启 DSH"), glyph.output.props.title);
	glyph.unmount();
	const view = env.React.mount(page.component, { t: env.t });
	const text = JSON.stringify(view.output);
	ok("restart reminder survives a reload", text.includes("需要重启 DSH 后生效"), text.slice(0, 1400));
	ok("restart reminder keeps the button", text.includes("立即重启 DSH"), text.slice(0, 1400));
	ok("restart reminder does not reload the page", env.reloads.count === 0, env.reloads.count);
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Scenario 10 — the Host did reboot, the stale reminder is dropped    */
/* ------------------------------------------------------------------ */
{
	const env = await load({
		appPhase: "idle",
		packages: [],
		storage: { "dsh-one-click-update:restart-pending": JSON.stringify({ bootId: "boot-old", at: Date.now() }) }
	});
	await sleep(80);
	const page = env.registered.find((r) => r.options.name === "main");
	const view = env.React.mount(page.component, { t: env.t });
	const text = JSON.stringify(view.output);
	ok("stale restart reminder is ignored", !text.includes("需要重启 DSH 后生效"), text.slice(0, 1400));
	ok("stale restart reminder is erased", env.localStorage.getItem("dsh-one-click-update:restart-pending") === null, [...env.localStorage.data.keys()]);
	view.unmount();
}

/* ------------------------------------------------------------------ */
/* Probe leftovers                                                     */
/* ------------------------------------------------------------------ */
for (const marker of ["TEMP-PROBE", "ocu.probe", "__ocuCtx"]) {
	ok("no leftover " + marker, !SRC.includes(marker));
}

const failed = checks.filter((c) => !c.pass);
console.log(failed.length === 0 ? `ALL CHECKS PASSED (${checks.length})` : `${failed.length}/${checks.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
