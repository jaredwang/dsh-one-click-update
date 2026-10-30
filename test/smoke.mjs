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
function makeBridge(phase) {
	return {
		status: async () => {
			bridgeCalls.status++;
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
		restartNames: options.restartNames ?? [],
		async fetch(url, init) {
			const method = (init && init.method) || "GET";
			const path = String(url);
			if (path.startsWith("/dsh-market/api/v1/capabilities")) {
				return resp(200, {
					schema: "dsh-market/update-api/v1",
					apiVersion: 1,
					runtime: "desktop",
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
			if (path.startsWith("/dsh-market/api/v1/operations?operationId=")) {
				const id = decodeURIComponent(path.split("=")[1]);
				const n = (api.polls[id] = (api.polls[id] || 0) + 1);
				const name = id.slice(3);
				if (n < 2) return resp(200, { operation: { operationId: id, state: "running", percent: 55 } });
				if (api.failNames.indexOf(name) !== -1) {
					return resp(200, {
						operation: { operationId: id, state: "failed", failure: { code: "RELEASE_TOO_FRESH", message: "发布太新", retryable: true } }
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
	const localStorage = { data: new Map(), setItem(k, v) { this.data.set(k, v); }, getItem(k) { return this.data.get(k) ?? null; } };
	const api = makeApi(options);
	const sandbox = {
		document,
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
	if (options.bridge !== false) sandbox.window.dshDesktop = { updates: makeBridge(options.appPhase) };
	mod.apply(ctx);
	const t = ctx.locale.bind("dsh-one-click-update");
	return { sandbox, api, mod, React, requires, dicts, registered, injectedKeys, document, t, sandboxDocument: document };
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
		failNames: ["beta"],
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
	ok("row shows failure message", done.includes("发布太新"), done.slice(0, 1600));
	ok("restart hint shown", done.includes("需要重启"), done.slice(0, 1600));
	ok("retry label after failure", done.includes("重试失败项"), done.slice(0, 1600));
	ok("app flow auto-started once", bridgeCalls.open === 1, bridgeCalls.open);
	ok("app section present", done.includes("发现新版本"), done.slice(0, 2000));
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
/* Probe leftovers                                                     */
/* ------------------------------------------------------------------ */
for (const marker of ["TEMP-PROBE", "ocu.probe", "localStorage.setItem", "__ocuCtx"]) {
	ok("no leftover " + marker, !SRC.includes(marker));
}

const failed = checks.filter((c) => !c.pass);
console.log(failed.length === 0 ? `ALL CHECKS PASSED (${checks.length})` : `${failed.length}/${checks.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
