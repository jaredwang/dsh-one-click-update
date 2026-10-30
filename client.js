/* dsh-one-click-update — browser half.
 *
 * Adds a 「一键更新」 entry to the sidebar's top-left panel list (next to
 * 插件 / 插件市场 / 自动化任务) and the page it opens. That page updates two
 * things in one go:
 *
 *   1. every installed plugin the plugin market reports as upgradable, through
 *      the market's documented public API v1 (/dsh-market/api/v1/updates/...);
 *   2. the DSH desktop app itself, through window.dshDesktop.updates, which the
 *      Electron preload exposes to the main window:
 *        status()            -> { phase, version?, percent?, failure? }
 *        open()              -> official flow: check -> download -> install -> relaunch
 *        subscribe(listener) -> live presentation updates (no initial replay)
 *
 * Opening the entry is the one click: the page starts both flows by itself and
 * shows live progress. The shell still owns the final "install and restart"
 * confirmation for the app update, and the market still owns the restart guard
 * for plugins — this plugin never bypasses either.
 */
window.__ModuleLoader__.load({
	id: "dsh-one-click-update",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		const NS = "dsh-one-click-update";
		const PANEL_ID = "one-click-update";
		const STYLE_ID = "dsh-one-click-update-style";
		const API = "/dsh-market/api/v1";

		/** App phases during which a second run must not start. */
		const BUSY_PHASES = { downloading: true, verifying: true, installing: true };

		/** Market operation states that end a run. */
		const TERMINAL_STATES = { succeeded: true, failed: true, cancelled: true, "rolled-back": true };

		const TEXT = {
			zh: {
				panel: "一键更新",
				"page.title": "一键更新",
				"page.desc": "更新 DSH 桌面 App，以及插件市场里所有已安装插件。打开本页会自动开始。",
				"page.status": "当前状态",
				"section.plugins": "插件市场",
				"section.app": "DSH 桌面 App",

				"plugins.checking": "正在检查插件更新…",
				"plugins.checked": "已检查 {checked} 个已安装插件",
				"plugins.none": "所有插件都是最新版本",
				"plugins.count": "{count} 个插件可更新",
				"plugins.unsupported": "未检测到插件市场，无法更新插件",
				"plugins.error": "检查插件更新失败：{reason}",
				"plugins.running": "正在更新 {name}（{done}/{total}）",
				"plugins.done": "插件更新完成",
				"plugins.doneSome": "插件更新完成，{failed} 个失败",
				"plugins.pending": "排队中",
				"plugins.updating": "正在更新…",
				"plugins.installed": "已更新到 {version}",
				"plugins.failed": "失败：{reason}",
				"plugins.cancelled": "已取消",
				"plugins.rolled": "已回滚",
				"plugins.restart": "有插件需要重启 DSH 桌面 App 后生效",
				"plugins.action": "全部更新",
				"plugins.retry": "重试失败项",
				"plugins.recheck": "重新检查",
				"plugins.busy": "更新中…",

				"app.unsupported": "更新 DSH 桌面 App 仅在桌面 App 内可用",
				"app.action": "检查并更新",
				"app.retry": "重试",
				"app.busy": "检查中…",
				"app.hint": "更新 App 的最后一步由桌面端弹出「安装并重启」确认框。",

				"phase.loading": "正在读取更新状态…",
				"phase.checking": "正在检查更新…",
				"phase.idle": "已是最新版本",
				"phase.available": "发现新版本 {version}，准备下载",
				"phase.downloading": "正在下载… {percent}%",
				"phase.verifying": "正在校验… {percent}%",
				"phase.ready": "更新已就绪，等待确认重启",
				"phase.installing": "正在安装并重启…",
				"phase.error": "更新失败",

				"failure.check": "检查更新失败",
				"failure.check-network": "检查更新失败：网络不可用",
				"failure.download": "下载失败",
				"failure.download-network": "下载失败：网络中断",
				"failure.install": "安装失败",
				"failure.install-network": "安装失败：网络中断",
				"failure.stop-failed": "停止运行中的任务失败",
				"failure.tasks-changed": "任务状态已变化，请重试",
				"failure.tasks-unavailable": "仍有任务在运行，暂不能重启"
			},
			en: {
				panel: "Update all",
				"page.title": "Update all",
				"page.desc": "Updates the DSH desktop app and every installed plugin from the plugin market. The page starts by itself.",
				"page.status": "Status",
				"section.plugins": "Plugins",
				"section.app": "DSH desktop app",

				"plugins.checking": "Checking plugin updates…",
				"plugins.checked": "{checked} installed plugins checked",
				"plugins.none": "All plugins are up to date",
				"plugins.count": "{count} plugins can be updated",
				"plugins.unsupported": "Plugin market not found, plugins can't be updated",
				"plugins.error": "Plugin check failed: {reason}",
				"plugins.running": "Updating {name} ({done}/{total})",
				"plugins.done": "Plugins updated",
				"plugins.doneSome": "Plugins updated, {failed} failed",
				"plugins.pending": "Queued",
				"plugins.updating": "Updating…",
				"plugins.installed": "Updated to {version}",
				"plugins.failed": "Failed: {reason}",
				"plugins.cancelled": "Cancelled",
				"plugins.rolled": "Rolled back",
				"plugins.restart": "Some plugins take effect after restarting the DSH desktop app",
				"plugins.action": "Update all",
				"plugins.retry": "Retry failed",
				"plugins.recheck": "Check again",
				"plugins.busy": "Updating…",

				"app.unsupported": "Updating the DSH desktop app is only available inside the desktop app",
				"app.action": "Check and update",
				"app.retry": "Retry",
				"app.busy": "Checking…",
				"app.hint": "The desktop app still asks for confirmation before installing and restarting.",

				"phase.loading": "Reading update state…",
				"phase.checking": "Checking for updates…",
				"phase.idle": "Already up to date",
				"phase.available": "Version {version} available, preparing download",
				"phase.downloading": "Downloading… {percent}%",
				"phase.verifying": "Verifying… {percent}%",
				"phase.ready": "Update ready, waiting for confirmation",
				"phase.installing": "Installing and restarting…",
				"phase.error": "Update failed",

				"failure.check": "Update check failed",
				"failure.check-network": "Update check failed: network unavailable",
				"failure.download": "Download failed",
				"failure.download-network": "Download failed: network interrupted",
				"failure.install": "Install failed",
				"failure.install-network": "Install failed: network interrupted",
				"failure.stop-failed": "Could not stop running tasks",
				"failure.tasks-changed": "Task state changed, please retry",
				"failure.tasks-unavailable": "Tasks are still running, can't restart yet"
			}
		};



		/* ---------------------------------------------------------------- */
		/* Desktop bridge (DSH app updates)                                   */
		/* ---------------------------------------------------------------- */

		/** The desktop update bridge, or null outside the desktop app. */
		function bridge() {
			const desktop = typeof window === "object" && window !== null ? window.dshDesktop : void 0;
			const updates = desktop === null || desktop === void 0 ? void 0 : desktop.updates;
			if (updates === null || updates === void 0) return null;
			if (typeof updates.status !== "function" || typeof updates.open !== "function") return null;
			return updates;
		}

		/** Normalize one app-update presentation payload into the shape the UI renders. */
		function normalize(raw) {
			const value = raw === null || typeof raw !== "object" ? {} : raw;
			const percent = typeof value.percent === "number" && Number.isFinite(value.percent)
				? Math.max(0, Math.min(100, Math.floor(value.percent)))
				: void 0;
			return {
				phase: typeof value.phase === "string" ? value.phase : "idle",
				version: typeof value.version === "string" && value.version !== "" ? value.version : void 0,
				percent,
				failure: typeof value.failure === "string" && value.failure !== "" ? value.failure : void 0
			};
		}

		/* ---------------------------------------------------------------- */
		/* Market HTTP API                                                    */
		/* ---------------------------------------------------------------- */

		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		async function readJson(response) {
			try {
				return await response.json();
			} catch (error) {
				return void 0;
			}
		}

		/** GET one market API path; resolves { status, body } and never throws. */
		async function apiGet(path) {
			try {
				const response = await fetch(path, {
					credentials: "same-origin",
					cache: "no-store",
					headers: { accept: "application/json" }
				});
				return { status: response.status, body: await readJson(response) };
			} catch (error) {
				return { status: 0, body: void 0, error: error instanceof Error ? error.message : String(error) };
			}
		}

		/** POST one market API path; resolves { status, body } and never throws. */
		async function apiPost(path, body) {
			try {
				const response = await fetch(path, {
					method: "POST",
					credentials: "same-origin",
					cache: "no-store",
					headers: { accept: "application/json", "content-type": "application/json" },
					body: JSON.stringify(body)
				});
				return { status: response.status, body: await readJson(response) };
			} catch (error) {
				return { status: 0, body: void 0, error: error instanceof Error ? error.message : String(error) };
			}
		}

		/* ---------------------------------------------------------------- */
		/* Store                                                              */
		/* ---------------------------------------------------------------- */

		let state = {
			app: {
				supported: false,
				ready: false,
				phase: "idle",
				version: void 0,
				percent: void 0,
				failure: void 0,
				pending: false
			},
			market: {
				/** unknown | checking | ready | unsupported | error */
				status: "unknown",
				capabilities: void 0,
				checked: 0,
				updatable: 0,
				packages: [],
				error: void 0,
				running: false,
				finished: false,
				current: void 0,
				results: {},
				percent: void 0,
				restartRequired: false
			}
		};
		const listeners = new Set();
		let monitorStarted = false;
		let detachBridge = null;
		/** One automatic run per session; the buttons still allow manual reruns. */
		let autoRunStarted = false;
		/** Whether the update page is currently mounted (both auto flows only run there). */
		let panelOpen = false;
		/** One automatic app open per session, attempted only after the plugin run finished. */
		let autoAppRequested = false;

		function emit() {
			for (const listener of [...listeners]) listener();
			maybeAutoOpenApp();
		}

		function patchApp(next) {
			state = { ...state, app: { ...state.app, ...next } };
			emit();
		}

		function patchMarket(next) {
			state = { ...state, market: { ...state.market, ...next } };
			emit();
		}

		function applyPresentation(raw) {
			patchApp(normalize(raw));
		}

		/** Subscribe once to the shell's presentation stream; it never replays. */
		function startMonitor(ctx) {
			if (monitorStarted) return () => {};
			monitorStarted = true;

			// Plugin updates only need the market's HTTP API, so they also work when
			// the page is opened in a plain browser tab.
			void loadCapabilities();
			void checkPlugins(false);

			const updates = bridge();
			if (updates === null) {
				patchApp({ supported: false, ready: true });
				return () => {
					monitorStarted = false;
				};
			}
			patchApp({ supported: true });
			let alive = true;
			if (typeof updates.subscribe === "function") {
				try {
					const detach = updates.subscribe((next) => {
						if (alive) applyPresentation(next);
					});
					if (typeof detach === "function") detachBridge = detach;
				} catch (error) {
					/* the shell may refuse a second subscription; status() still works */
				}
			}
			Promise.resolve()
				.then(() => updates.status())
				.then((next) => {
					if (!alive) return;
					applyPresentation(next);
					patchApp({ ready: true });
				})
				.catch(() => {
					if (alive) patchApp({ ready: true });
				});
			const dispose = ctx === null || ctx === void 0 || typeof ctx.on !== "function" ? null : ctx.on("connection/reset", () => {
				void checkPlugins(false);
				Promise.resolve()
					.then(() => updates.status())
					.then((next) => {
						if (alive) applyPresentation(next);
					})
					.catch(() => {});
			});
			return () => {
				alive = false;
				if (typeof dispose === "function") dispose();
				if (detachBridge !== null) {
					try {
						detachBridge();
					} catch (error) {
						/* ignore */
					}
					detachBridge = null;
				}
				monitorStarted = false;
			};
		}

		/** Run the official app check/download/install flow once. */
		function requestAppUpdate() {
			const updates = bridge();
			if (updates === null) return;
			if (state.app.pending || BUSY_PHASES[state.app.phase] === true) return;
			patchApp({ pending: true });
			Promise.resolve()
				.then(() => updates.open())
				.catch(() => {})
				.then(() => patchApp({ pending: false }));
		}

		/**
		 * Open the official app flow at most once per session, only while the update
		 * page is open and only after this visit's plugin run finished. Called from
		 * every state change so a late `updates.status()` reply cannot lose the
		 * automatic open that the page's one-click run is supposed to trigger.
		 */
		function maybeAutoOpenApp() {
			if (!panelOpen || autoAppRequested || !autoRunStarted) return;
			if (!state.market.finished) return;
			if (!state.app.supported || state.app.phase !== "available") return;
			autoAppRequested = true;
			requestAppUpdate();
		}

		/* ---------------------------------------------------------------- */
		/* Market: capabilities, check, update-all                            */
		/* ---------------------------------------------------------------- */

		/** Read the market's capability document (features, restart support). */
		async function loadCapabilities() {
			const res = await apiGet(API + "/capabilities");
			if (res.status === 200 && res.body && res.body.schema) patchMarket({ capabilities: res.body });
		}

		/** Ask the market which installed plugins can be updated. */
		async function checkPlugins(force) {
			if (state.market.running) return;
			patchMarket({ status: "checking", error: void 0 });
			const res = await apiGet(API + "/updates/summary" + (force ? "?force=1" : ""));
			if (res.status === 404) {
				patchMarket({ status: "unsupported", checked: 0, updatable: 0, packages: [] });
				return;
			}
			if (res.status !== 200 || res.body === void 0) {
				patchMarket({ status: "error", error: (res.body && res.body.error) || res.error || "HTTP " + res.status });
				return;
			}
			const body = res.body;
			const packages = Array.isArray(body.packages) ? body.packages : [];
			patchMarket({
				status: "ready",
				checked: typeof body.checked === "number" ? body.checked : 0,
				updatable: packages.length,
				packages,
				error: void 0
			});
		}

		/** Poll one market operation until it reaches a terminal state. */
		async function pollOperation(operationId, name) {
			const deadline = Date.now() + 8 * 60 * 1000;
			for (;;) {
				await sleep(700);
				const res = await apiGet(API + "/operations?operationId=" + encodeURIComponent(operationId));
				if (res.status === 404) {
					// operations live in the host process; a restart loses them
					return { status: "failed", error: (res.body && res.body.error) || "operation lost" };
				}
				if (res.status !== 200 || res.body === void 0 || res.body.operation === void 0) {
					if (Date.now() > deadline) return { status: "failed", error: "timeout" };
					continue;
				}
				const operation = res.body.operation;
				const whole = typeof operation.percent === "number"
					? operation.percent
					: operation.progress && typeof operation.progress.percent === "number"
						? operation.progress.percent
						: void 0;
				if (whole !== void 0 && state.market.current === name) {
					patchMarket({ percent: Math.max(0, Math.min(100, whole)) });
				}
				if (TERMINAL_STATES[operation.state] === true) {
					if (operation.state === "succeeded") {
						return {
							status: "done",
							installedVersion: operation.installedVersion ?? operation.afterVersion,
							restartRequired: operation.restartRequired === true || operation.refreshRequired === true
						};
					}
					const failure = operation.failure;
					return {
						status: operation.state === "cancelled" ? "cancelled" : operation.state === "rolled-back" ? "rolled" : "failed",
						error: (failure && (failure.message || failure.code)) || operation.error || operation.state,
						code: failure && failure.code,
						retryable: failure && failure.retryable === true
					};
				}
				if (Date.now() > deadline) return { status: "failed", error: "timeout" };
			}
		}

		/** Update one plugin through the market API. */
		async function updateOne(pkg) {
			let res = await apiPost(API + "/updates", { packageName: pkg.name });
			let attempts = 0;
			while (res.status === 409 && attempts < 6) {
				await sleep(1500);
				attempts += 1;
				res = await apiPost(API + "/updates", { packageName: pkg.name });
			}
			if (res.status === 202 && res.body && res.body.operation) {
				return await pollOperation(res.body.operation.operationId, pkg.name);
			}
			const failure = res.body && (res.body.failure ? res.body.failure.message || res.body.failure.code : res.body.error);
			return {
				status: "failed",
				error: failure || res.error || "HTTP " + res.status,
				code: res.body && res.body.failure && res.body.failure.code
			};
		}

		/** Update plugins one at a time, keeping the visible list in sync. */
		async function runPluginUpdates(onlyNames) {
			if (state.market.running) return;
			if (state.market.status !== "ready") await checkPlugins(false);
			if (state.market.status !== "ready") {
				patchMarket({ finished: true });
				return;
			}
			const chosen = state.market.packages.filter((pkg) => {
				if (onlyNames !== void 0 && onlyNames.indexOf(pkg.name) === -1) return false;
				const result = state.market.results[pkg.name];
				return result === void 0 || result.status !== "done";
			});
			if (chosen.length === 0) {
				patchMarket({ finished: true, current: void 0, percent: void 0 });
				return;
			}
			// The plugin market can upgrade itself through this API, but that drops the
			// API for the rest of the run — keep it last.
			const ordered = [...chosen].sort((a, b) => (a.name === "dshmarket" ? 1 : 0) - (b.name === "dshmarket" ? 1 : 0));
			const results = { ...state.market.results };
			for (const pkg of ordered) delete results[pkg.name];
			let restartRequired = state.market.restartRequired === true;
			patchMarket({ running: true, finished: false, current: ordered[0].name, results, percent: 0, restartRequired: false });
			for (const pkg of ordered) {
				patchMarket({ current: pkg.name, percent: 0 });
				let outcome;
				try {
					outcome = await updateOne(pkg);
				} catch (error) {
					outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
				}
				results[pkg.name] = outcome;
				if (outcome.restartRequired === true) restartRequired = true;
				patchMarket({ results: { ...results }, percent: 0 });
			}
			const packages = state.market.packages.map((pkg) => {
				const result = results[pkg.name];
				if (result === void 0 || result.status !== "done") return pkg;
				const installed = result.installedVersion === void 0 ? pkg.latestVersion : result.installedVersion;
				return { ...pkg, installedVersion: installed };
			});
			const remaining = packages.filter((pkg) => (results[pkg.name] === void 0 || results[pkg.name].status !== "done"));
			patchMarket({
				running: false,
				finished: true,
				current: void 0,
				percent: void 0,
				restartRequired,
				packages,
				updatable: remaining.length
			});
		}

		/** Subscribe a component to the shared state. */
		function useSnapshot() {
			const [, bump] = React.useState(0);
			React.useEffect(() => {
				let alive = true;
				const listener = () => {
					if (alive) bump((value) => value + 1);
				};
				listeners.add(listener);
				return () => {
					alive = false;
					listeners.delete(listener);
				};
			}, []);
			return state;
		}

		/* ---------------------------------------------------------------- */
		/* Text helpers                                                       */
		/* ---------------------------------------------------------------- */

		/** Sentence for the shell's failure kind. */
		function failureText(snapshot, t) {
			if (snapshot.failure === void 0) return t("phase.error");
			const key = "failure." + snapshot.failure;
			const line = t(key);
			return line === key ? snapshot.failure : line;
		}

		/** One status sentence for the app-update section. */
		function describeApp(app, t) {
			if (!app.supported) return t("app.unsupported");
			if (!app.ready) return t("phase.loading");
			if (app.pending) return t("app.busy");
			switch (app.phase) {
				case "checking":
				case "check":
					return t("phase.checking");
				case "available":
					return app.version === void 0 ? t("phase.checking") : t("phase.available", { version: app.version });
				case "downloading":
					return t("phase.downloading", { percent: app.percent === void 0 ? 0 : app.percent });
				case "verifying":
					return t("phase.verifying", { percent: app.percent === void 0 ? 0 : app.percent });
				case "ready":
					return t("phase.ready");
				case "installing":
					return t("phase.installing");
				case "error":
					return failureText(app, t);
				default:
					return t("phase.idle");
			}
		}

		/** One status sentence for the plugin-update section. */
		function describePlugins(market, t) {
			if (market.running) {
				const done = Object.keys(market.results).length;
				const total = market.packages.length;
				return t("plugins.running", { name: market.current === void 0 ? "" : market.current, done, total });
			}
			if (market.status === "unsupported") return t("plugins.unsupported");
			if (market.status === "error") return t("plugins.error", { reason: market.error === void 0 ? "?" : market.error });
			if (market.status === "unknown" || market.status === "checking") return t("plugins.checking");
			if (market.finished) {
				const results = Object.values(market.results);
				if (results.length === 0) return t("plugins.none");
				const failed = results.filter((result) => result.status === "failed").length;
				return failed > 0 ? t("plugins.doneSome", { failed }) : t("plugins.done");
			}
			if (market.updatable > 0) return t("plugins.count", { count: market.updatable });
			return t("plugins.none");
		}

		/** idle | available | active | error */
		function toneOf(snapshot) {
			const app = snapshot.app;
			const market = snapshot.market;
			if (app.phase === "error" || market.status === "error") return "error";
			if (market.running || app.pending || BUSY_PHASES[app.phase] === true) return "active";
			if (market.updatable > 0 || app.phase === "available" || app.phase === "ready") return "available";
			return "idle";
		}

		/** Tooltip of the sidebar entry. */
		function entryTitle(snapshot, t) {
			const parts = [];
			if (snapshot.market.running) parts.push(describePlugins(snapshot.market, t));
			else if (snapshot.market.status === "ready") {
				parts.push(snapshot.market.updatable > 0 ? t("plugins.count", { count: snapshot.market.updatable }) : t("plugins.none"));
			}
			if (snapshot.app.supported) parts.push(describeApp(snapshot.app, t));
			return parts.length === 0 ? t("panel") : parts.join(" · ");
		}

		/** True while any update is running. */
		function busyOf(snapshot) {
			return snapshot.market.running || snapshot.app.pending || BUSY_PHASES[snapshot.app.phase] === true;
		}

		/* ---------------------------------------------------------------- */
		/* Icons                                                              */
		/* ---------------------------------------------------------------- */

		/** Download-into-tray glyph, drawn to sit next to the shipped 16px icons. */
		function DownloadIcon(props) {
			const size = props.size;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("path", { d: "M8 1.9v7.4" }),
				h("path", { d: "M4.9 6.4 8 9.5l3.1-3.1" }),
				h("path", { d: "M2.6 11.2v1.5c0 .55.45 1 1 1h8.8c.55 0 1-.45 1-1v-1.5" })
			);
		}

		function WarningIcon(props) {
			const size = props.size;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("path", { d: "M8 2.2 1.8 13h12.4L8 2.2Z" }),
				h("path", { d: "M8 6.3v3.1" }),
				h("path", { d: "M8 11.4v.1" })
			);
		}

		/** Progress ring used while downloading, verifying or installing. */
		function RingIcon(props) {
			const size = props.size;
			const percent = props.percent;
			const radius = 5.6;
			const circumference = 2 * Math.PI * radius;
			const ratio = percent === void 0 ? 0.28 : Math.max(0.02, Math.min(1, percent / 100));
			const spinning = percent === void 0;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					className: spinning ? "dsh-ocu-spin" : void 0
				},
				h("circle", { cx: 8, cy: 8, r: radius, stroke: "currentColor", strokeOpacity: 0.22, strokeWidth: 1.6 }),
				h("circle", {
					cx: 8,
					cy: 8,
					r: radius,
					stroke: "currentColor",
					strokeWidth: 1.6,
					strokeLinecap: "round",
					strokeDasharray: (circumference * ratio).toFixed(2) + " " + circumference.toFixed(2),
					transform: "rotate(-90 8 8)"
				})
			);
		}

		/* ---------------------------------------------------------------- */
		/* Sidebar entry glyph                                                */
		/* ---------------------------------------------------------------- */

		/**
		 * Glyph of the sidebar panel row. The row itself belongs to the sidebar;
		 * this only draws the icon and mirrors the live update state.
		 */
		function UpdateEntryIcon(props) {
			const snapshot = useSnapshot();
			const t = props.t;
			const size = typeof props.size === "number" ? props.size : 16;
			const tone = toneOf(snapshot);
			let icon = h(DownloadIcon, { size });
			if (tone === "active") {
				icon = h(RingIcon, { size, percent: snapshot.market.running ? snapshot.market.percent : snapshot.app.percent });
			} else if (tone === "error") {
				icon = h(WarningIcon, { size });
			}
			return h(
				"span",
				{ className: "dsh-ocu-glyph", "data-tone": tone, title: t === void 0 ? void 0 : entryTitle(snapshot, t) },
				icon,
				tone === "available" ? h("span", { className: "dsh-ocu-dot", "aria-hidden": "true" }) : null
			);
		}

		/* ---------------------------------------------------------------- */
		/* Panel page                                                         */
		/* ---------------------------------------------------------------- */

		function Spinner() {
			return h("span", { className: "dsh-ocu-spinner", "aria-hidden": "true" }, h(RingIcon, { size: 13 }));
		}

		function ProgressBar(props) {
			const percent = typeof props.percent === "number" && Number.isFinite(props.percent)
				? Math.max(0, Math.min(100, Math.round(props.percent)))
				: 0;
			return h(
				"div",
				{
					className: "dsh-ocu-bar",
					role: "progressbar",
					"aria-valuemin": 0,
					"aria-valuemax": 100,
					"aria-valuenow": percent
				},
				h("i", { className: "dsh-ocu-bar-fill", style: { width: percent + "%" } })
			);
		}

		/** One row per upgradable plugin, with its own state. */
		function PluginRows(props) {
			const market = props.market;
			const t = props.t;
			if (market.packages.length === 0) return null;
			return h(
				"ul",
				{ className: "dsh-ocu-rows" },
				market.packages.map((pkg) => {
					const result = market.results[pkg.name];
					let stateText = t("plugins.pending");
					let tone = "idle";
					if (market.running && market.current === pkg.name && result === void 0) {
						stateText = t("plugins.updating");
						tone = "active";
					}
					if (result !== void 0) {
						if (result.status === "done") {
							stateText = t("plugins.installed", {
								version: result.installedVersion === void 0 ? pkg.latestVersion : result.installedVersion
							});
							tone = "done";
						} else if (result.status === "failed") {
							stateText = t("plugins.failed", { reason: result.error === void 0 ? "?" : result.error });
							tone = "error";
						} else if (result.status === "cancelled") {
							stateText = t("plugins.cancelled");
							tone = "error";
						} else if (result.status === "rolled") {
							stateText = t("plugins.rolled");
							tone = "error";
						}
					}
					return h(
						"li",
						{ className: "dsh-ocu-row", "data-tone": tone, key: pkg.name },
						h(
							"span",
							{ className: "dsh-ocu-row-main" },
							h("code", { className: "dsh-ocu-row-name" }, pkg.name),
							h(
								"span",
								{ className: "dsh-ocu-row-versions" },
								h("span", { className: "dsh-ocu-version" }, pkg.installedVersion),
								h("span", { className: "dsh-ocu-arrow", "aria-hidden": "true" }, "\u2192"),
								h("span", { className: "dsh-ocu-version dsh-ocu-version-new" }, pkg.latestVersion)
							)
						),
						h("span", { className: "dsh-ocu-row-state" }, tone === "active" ? Spinner() : null, h("span", null, stateText))
					);
				})
			);
		}

		function PluginSection(props) {
			const market = props.market;
			const t = props.t;
			const busy = market.running;
			const failedNames = Object.keys(market.results).filter((name) => market.results[name].status === "failed");
			const showRows = market.packages.length > 0 && market.status !== "unsupported";
			const disabled = busy || market.status === "unsupported";
			let actionLabel = t("plugins.action");
			let action = () => void runPluginUpdates(void 0);
			if (busy) actionLabel = t("plugins.busy");
			else if (market.finished && failedNames.length > 0) {
				actionLabel = t("plugins.retry");
				action = () => void runPluginUpdates(failedNames);
			} else if (market.finished) {
				actionLabel = t("plugins.recheck");
				action = () => {
					patchMarket({ finished: false, results: {}, restartRequired: false });
					void checkPlugins(true);
				};
			}
			const total = market.packages.length;
			const done = Object.keys(market.results).length;
			const overall = busy && total > 0
				? ((done + (market.percent === void 0 ? 0 : market.percent) / 100) / total) * 100
				: 0;
			return h(
				"section",
				{ className: "dsh-ocu-card", "data-tone": market.status === "error" ? "error" : busy ? "active" : "idle" },
				h(
					"div",
					{ className: "dsh-ocu-card-head" },
					h("h2", { className: "dsh-ocu-card-title" }, t("section.plugins")),
					market.status === "ready" ? h("span", { className: "dsh-ocu-card-meta" }, t("plugins.checked", { checked: market.checked })) : null
				),
				h(
					"div",
					{ className: "dsh-ocu-card-row" },
					h("span", { className: "dsh-ocu-card-label" }, t("page.status")),
					h("span", { className: "dsh-ocu-card-value", "aria-live": "polite" }, describePlugins(market, t))
				),
				busy ? ProgressBar({ percent: overall }) : null,
				showRows ? h(PluginRows, { market, t }) : null,
				market.restartRequired && market.finished ? h("p", { className: "dsh-ocu-card-note dsh-ocu-note-warn" }, t("plugins.restart")) : null,
				h(
					"div",
					{ className: "dsh-ocu-card-actions" },
					h(
						"button",
						{
							type: "button",
							className: "dsh-ocu-primary",
							onClick: action,
							"data-busy": busy ? "true" : void 0,
							"aria-disabled": disabled ? "true" : void 0,
							disabled: market.status === "unsupported"
						},
						actionLabel
					)
				)
			);
		}

		function AppSection(props) {
			const app = props.app;
			const t = props.t;
			const busy = app.pending || BUSY_PHASES[app.phase] === true;
			const showBar = app.phase === "downloading" || app.phase === "verifying";
			const showFailure = app.phase === "error" && app.failure !== void 0;
			const label = busy ? t("app.busy") : app.phase === "error" ? t("app.retry") : t("app.action");
			return h(
				"section",
				{ className: "dsh-ocu-card", "data-tone": app.phase === "error" ? "error" : busy ? "active" : "idle" },
				h(
					"div",
					{ className: "dsh-ocu-card-head" },
					h("h2", { className: "dsh-ocu-card-title" }, t("section.app")),
					app.version !== void 0 && app.phase !== "idle" && app.phase !== "error"
						? h("span", { className: "dsh-ocu-card-meta" }, app.version)
						: null
				),
				h(
					"div",
					{ className: "dsh-ocu-card-row" },
					h("span", { className: "dsh-ocu-card-label" }, t("page.status")),
					h("span", { className: "dsh-ocu-card-value", "aria-live": "polite" }, describeApp(app, t))
				),
				showBar ? ProgressBar({ percent: app.percent === void 0 ? 0 : app.percent }) : null,
				showFailure ? h("p", { className: "dsh-ocu-card-note" }, failureText(app, t)) : null,
				h(
					"div",
					{ className: "dsh-ocu-card-actions" },
					h(
						"button",
						{
							type: "button",
							className: "dsh-ocu-primary dsh-ocu-primary-quiet",
							onClick: requestAppUpdate,
							"data-busy": busy ? "true" : void 0,
							"aria-disabled": busy || !app.supported ? "true" : void 0,
							disabled: !app.supported
						},
						label
					)
				),
				h("p", { className: "dsh-ocu-card-foot" }, app.supported ? t("app.hint") : t("app.unsupported"))
			);
		}

		/**
		 * The page the sidebar entry opens. It starts both flows by itself, so the
		 * click on the sidebar row is the whole interaction; the buttons stay for
		 * retries and manual reruns.
		 */
		function UpdatePanelPage(props) {
			const snapshot = useSnapshot();
			const t = props.t;
			const market = snapshot.market;

			React.useEffect(() => {
				panelOpen = true;
				return () => {
					panelOpen = false;
				};
			}, []);

			React.useEffect(() => {
				if (autoRunStarted) return;
				if (market.status !== "ready") return;
				autoRunStarted = true;
				void (async () => {
					if (state.market.updatable > 0) await runPluginUpdates(void 0);
					else patchMarket({ finished: true });
					// The app open is triggered by the finished state change itself
					// (maybeAutoOpenApp), so a slow updates.status() reply cannot lose it.
					maybeAutoOpenApp();
				})();
			}, [market.status]);

			return h(
				"div",
				{ className: "dsh-ocu-page" },
				h(
					"header",
					{ className: "dsh-ocu-page-head" },
					h("h1", { className: "dsh-ocu-page-title" }, t("page.title")),
					h("p", { className: "dsh-ocu-page-desc" }, t("page.desc"))
				),
				h(PluginSection, { market, t }),
				h(AppSection, { app: snapshot.app, t })
			);
		}

		/* ---------------------------------------------------------------- */
		/* Styles                                                             */
		/* ---------------------------------------------------------------- */

		const CSS = [
			".dsh-ocu-glyph{position:relative;display:inline-flex;align-items:center;justify-content:center;color:inherit}",
			'.dsh-ocu-glyph[data-tone="available"],.dsh-ocu-glyph[data-tone="active"]{color:var(--dsw-alias-brand-primary,#3b6ef6)}',
			'.dsh-ocu-glyph[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d64545)}',
			".dsh-ocu-dot{position:absolute;top:-1px;right:-2px;width:5px;height:5px;border-radius:50%;background:currentColor;animation:dsh-ocu-breathe 1.9s ease-in-out infinite}",
			".dsh-ocu-spin{animation:dsh-ocu-rotate .9s linear infinite}",
			".dsh-ocu-spinner{display:inline-flex;align-items:center;color:var(--dsw-alias-brand-primary,#3b6ef6)}",
			"@keyframes dsh-ocu-rotate{to{transform:rotate(360deg)}}",
			"@keyframes dsh-ocu-breathe{0%,100%{opacity:.45}50%{opacity:1}}",
			".dsh-ocu-page{box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:40px 40px 48px;color:var(--dsw-alias-label-primary,#1c1c1e);display:flex;flex-direction:column;gap:14px}",
			".dsh-ocu-page-head{max-width:760px;width:100%;margin:0 auto 8px}",
			".dsh-ocu-page-title{margin:0 0 6px;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em}",
			".dsh-ocu-page-desc{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b70)}",
			".dsh-ocu-card{box-sizing:border-box;max-width:760px;width:100%;margin:0 auto;padding:18px 20px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-elevated,#fff);display:flex;flex-direction:column;gap:10px}",
			'.dsh-ocu-card[data-tone="error"]{border-color:var(--dsw-alias-state-error-primary,#d64545)}',
			".dsh-ocu-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}",
			".dsh-ocu-card-title{margin:0;font-size:14px;font-weight:600}",
			".dsh-ocu-card-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b70)}",
			".dsh-ocu-card-row{display:flex;align-items:baseline;gap:14px;font-size:13px}",
			".dsh-ocu-card-label{flex:0 0 72px;color:var(--dsw-alias-label-secondary,#6b6b70)}",
			".dsh-ocu-card-value{flex:1 1 auto;line-height:1.6;word-break:break-word}",
			'.dsh-ocu-card[data-tone="error"] .dsh-ocu-card-value{color:var(--dsw-alias-state-error-primary,#d64545)}',
			".dsh-ocu-bar{height:6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));overflow:hidden}",
			".dsh-ocu-bar-fill{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary,#3b6ef6);transition:width .3s ease}",
			".dsh-ocu-rows{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}",
			".dsh-ocu-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 8px;border-radius:var(--dsw-radius-sm,8px);font-size:12.5px}",
			".dsh-ocu-row:nth-child(odd){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}",
			".dsh-ocu-row-main{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}",
			".dsh-ocu-row-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-ocu-row-versions{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#6b6b70);white-space:nowrap}",
			".dsh-ocu-version{font-variant-numeric:tabular-nums}",
			".dsh-ocu-version-new{color:var(--dsw-alias-label-primary,#1c1c1e)}",
			".dsh-ocu-arrow{opacity:.55}",
			".dsh-ocu-row-state{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#6b6b70);white-space:nowrap;max-width:52%;overflow:hidden;text-overflow:ellipsis}",
			'.dsh-ocu-row[data-tone="error"] .dsh-ocu-row-state{color:var(--dsw-alias-state-error-primary,#d64545)}',
			'.dsh-ocu-row[data-tone="done"] .dsh-ocu-row-state{color:var(--dsw-alias-state-success-primary,#2f9e5f)}',
			".dsh-ocu-card-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b70)}",
			".dsh-ocu-note-warn{color:var(--dsw-alias-state-warning-primary,#b07d1a)}",
			".dsh-ocu-card-actions{display:flex;align-items:center;gap:10px;padding-top:2px}",
			".dsh-ocu-primary{appearance:none;border:none;cursor:pointer;padding:0 14px;height:32px;border-radius:var(--dsw-radius-sm,8px);font-size:13px;font-weight:500;color:var(--dsw-alias-button-primary-text,#fff);background:var(--dsw-alias-button-primary-fill,#3b6ef6);transition:filter .15s ease,opacity .15s ease}",
			".dsh-ocu-primary:hover{filter:brightness(1.06)}",
			".dsh-ocu-primary:active{filter:brightness(.94)}",
			'.dsh-ocu-primary[data-busy="true"]{opacity:.55;cursor:default}',
			".dsh-ocu-primary-quiet{color:var(--dsw-alias-label-primary,#1c1c1e);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
			".dsh-ocu-card-foot{margin:2px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b70)}",
			"@media (max-width:560px){.dsh-ocu-page{padding:24px 20px 36px}.dsh-ocu-row{flex-direction:column;align-items:flex-start;gap:4px}.dsh-ocu-row-state{max-width:100%}}",
			"@media (prefers-reduced-motion:reduce){.dsh-ocu-dot,.dsh-ocu-spin{animation:none}}"
		].join("\n");

		/** Inject the stylesheet once; HMR reloads reuse the same element. */
		function installStyles() {
			if (typeof document !== "object" || document === null) return () => {};
			let style = document.getElementById(STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				if (document.head === null) return () => {};
				document.head.appendChild(style);
			}
			style.textContent = CSS;
			return () => {
				if (style.isConnected === true) style.remove();
			};
		}

		/* ---------------------------------------------------------------- */
		/* Plugin                                                             */
		/* ---------------------------------------------------------------- */

		const inject = ["slots", "locale"];

		/** Register the sidebar entry and the page it opens. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, TEXT), "dsh-one-click-update: dictionaries");
			ctx.effect(() => installStyles(), "dsh-one-click-update: styles");
			ctx.effect(() => startMonitor(ctx), "dsh-one-click-update: monitors");
			const t = ctx.locale.bind(NS);

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 5,
						label: () => t("panel"),
						locale: NS
					},
					UpdateEntryIcon
				)
			);

ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
						locale: NS
					},
					UpdatePanelPage
				)
			);
		}

		return { inject, apply };
	}
});
