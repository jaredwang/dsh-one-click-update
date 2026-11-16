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
		/**
		 * The market panel's own listing (not part of public API v1). It is the only
		 * place that exposes the releases still inside the desktop maturity hold and
		 * the mature version an updatable package will really install.
		 */
		const INTERNAL_UPDATES = "/dsh-market/updates";
		/** Host route of this bundle: restarts the desktop app (see index.js). */
		const RESTART_API = "/dsh-one-click-update/restart";
		/** Host route of this bundle: installs over a mounted bundle (see index.js). */
		const OVERLAY_API = "/dsh-one-click-update/overlay";

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
				"plugins.countHeld": "{count} 个插件可更新，{held} 个等待成熟期",
				"plugins.heldOnly": "暂无可以更新的插件，{held} 个等待成熟期",
				"plugins.heldNote": "部分插件的最新版仍在成熟期，本次先更新到已成熟的版本。",
				"plugins.heldHint": "最新版 {version} 仍在成熟期，本次先更新到已成熟的版本。",
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
				"plugins.blocked": "正在使用中，需重启后更新",
				"plugins.blockedNote": "有插件正在使用中，桌面端不允许热移除，覆盖安装也未完成；可重启 DSH 后再试。",
				"plugins.overlayWorking": "无法热更新，正在覆盖安装…",
				"plugins.overlayDone": "已覆盖安装 {version}，重启后生效",
				"plugins.overlayUnavailable": "此插件正在使用中，当前 Host 还不支持覆盖安装；重启 DSH 后重新打开本页，就会自动覆盖安装。",
				"plugins.summary": "插件更新完成：{parts}",
				"plugins.sumJoin": "，",
				"plugins.sumDone": "{count} 个已更新",
				"plugins.sumFailed": "{count} 个失败",
				"plugins.sumPending": "{count} 个等待成熟期",
				"plugins.sumBlocked": "{count} 个需重启后更新",
				"plugins.restart": "插件已更新，需要重启 DSH 后生效（未重启时新建会话可能出错）。",
				"plugins.restartTitle": "需要重启 DSH",
				"plugins.action": "全部更新",
				"plugins.retry": "重试失败项",
				"plugins.recheck": "重新检查",
				"plugins.busy": "更新中…",
				"plugins.pendingHold": "等待成熟期（发布满期限后可更新）",
				"plugins.donePending": "插件更新完成，{pending} 个等待成熟期",
				"plugins.doneMixed": "插件更新完成，{failed} 个失败，{pending} 个等待成熟期",
				"section.held": "等待成熟期",
				"held.meta": "{count} 个插件",
				"held.until": "{when} 后可更新",
				"held.untilEstimated": "预计 {when} 前后可更新",
				"held.untilUnknown": "发布满期限后可更新",
				"held.note": "成熟期内的插件不参与本次更新；到期后重新检查即可更新。",
				"plugins.restartNow": "立即重启 DSH",
				"plugins.restarting": "正在重启 DSH…",
				"plugins.restartFailed": "重启失败：{reason}",
				"plugins.restartManual": "未能自动重启，请手动重启 DSH。",
				"plugins.restartStale": "重启接口尚未加载：请先手动退出并重新打开 DSH 桌面 App 一次，之后就能一键重启。",
				"plugins.refreshHint": "插件已更新，刷新页面后即可新建会话。",
				"plugins.refreshNow": "刷新页面",
				"plugins.refreshing": "正在刷新页面…",

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
				"plugins.countHeld": "{count} plugins can be updated, {held} waiting for maturity",
				"plugins.heldOnly": "Nothing to update; {held} plugins waiting for maturity",
				"plugins.heldNote": "Some plugins have a newer release still inside the maturity hold; this run installs the mature version instead.",
				"plugins.heldHint": "Version {version} is still maturing; this run installs the mature release.",
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
				"plugins.blocked": "In use — needs a restart",
				"plugins.blockedNote": "A plugin is in use, so the desktop app will not remove it while it runs, and the install over it did not finish. Restart DSH and try again.",
				"plugins.overlayWorking": "Cannot hot-update; installing over it…",
				"plugins.overlayDone": "Installed over {version} — restart to apply",
				"plugins.overlayUnavailable": "This plugin is in use and this Host cannot install over it yet. Restart DSH, then reopen this page and it will install over it automatically.",
				"plugins.summary": "Plugins updated: {parts}",
				"plugins.sumJoin": ", ",
				"plugins.sumDone": "{count} updated",
				"plugins.sumFailed": "{count} failed",
				"plugins.sumPending": "{count} waiting for maturity",
				"plugins.sumBlocked": "{count} need a restart",
				"plugins.restart": "Plugins updated. Restart DSH to apply them (a new session may fail until then).",
				"plugins.restartTitle": "DSH restart required",
				"plugins.action": "Update all",
				"plugins.retry": "Retry failed",
				"plugins.recheck": "Check again",
				"plugins.busy": "Updating…",
				"plugins.pendingHold": "Waiting for the maturity hold to clear",
				"plugins.donePending": "Plugins updated, {pending} waiting for maturity",
				"plugins.doneMixed": "Plugins updated, {failed} failed, {pending} waiting for maturity",
				"section.held": "Maturity hold",
				"held.meta": "{count} plugins",
				"held.until": "Available after {when}",
				"held.untilEstimated": "Estimated around {when}",
				"held.untilUnknown": "Available once the release matures",
				"held.note": "Plugins in the maturity hold are not part of this update; check again once the hold clears.",
				"plugins.restartNow": "Restart DSH now",
				"plugins.restarting": "Restarting DSH…",
				"plugins.restartFailed": "Restart failed: {reason}",
				"plugins.restartManual": "Could not restart automatically. Please restart DSH manually.",
				"plugins.restartStale": "The restart endpoint is not loaded yet: quit and reopen the DSH desktop app once, and one-click restart will work from then on.",
				"plugins.refreshHint": "Plugins updated. Refresh this page before opening a new session.",
				"plugins.refreshNow": "Refresh page",
				"plugins.refreshing": "Refreshing…",

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
				/** Installed plugins whose newer release is still inside the maturity hold. */
				held: [],
				error: void 0,
				running: false,
				finished: false,
				current: void 0,
				/** The plugin the Host is currently installing over (see OVERLAY_API). */
				overlay: void 0,
				results: {},
				percent: void 0,
				restartRequired: false,
				/** The page itself is stale: refresh it before opening a new session. */
				refreshRequired: false,
				/** A page reload was scheduled/showed to apply the new client modules. */
				refreshing: false,
				/** A restart was requested and the shell has not died yet. */
				restarting: false,
				restartError: void 0,
				/** "desktop" (host helper) | "market" (market restart endpoint) */
				restartMode: void 0
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
			if (res.status === 200 && res.body && res.body.schema) {
				patchMarket({ capabilities: res.body });
				restoreRestart();
			}
		}

		/**
		 * Read the market panel's full listing. Public API v1's summary lists only
		 * updatable packages, so held releases and the actually installable version
		 * are read from here. The call is deliberately best-effort: an older market
		 * without this route just produces the plain v1 view and no hold category.
		 */
		async function readUpdateDetails() {
			const res = await apiGet(INTERNAL_UPDATES);
			if (res.status !== 200 || res.body === null || typeof res.body !== "object") return void 0;
			const updates = res.body.updates;
			if (updates === null || typeof updates !== "object" || Array.isArray(updates)) return void 0;
			return updates;
		}

		/** The version an update will really install (the mature one when latest is held). */
		function targetVersionOf(pkg, detail) {
			if (detail !== null && typeof detail === "object" && typeof detail.eligibleVersion === "string" && detail.eligibleVersion !== "") {
				return detail.eligibleVersion;
			}
			return pkg.latestVersion;
		}

		/** Annotate v1 rows with the mature target and the newer held release, if any. */
		function annotatePackages(packages, details) {
			return packages.map((pkg) => {
				if (details === void 0) return { ...pkg, targetVersion: pkg.latestVersion };
				const detail = details[pkg.name];
				const target = targetVersionOf(pkg, detail);
				const next = { ...pkg, targetVersion: target };
				const held = detail !== null && typeof detail === "object" ? detail.heldUpdate : void 0;
				if (held !== null && typeof held === "object" && typeof held.latest === "string" && held.latest !== "" && held.latest !== target) {
					next.heldVersion = held.latest;
					if (typeof held.until === "string" && held.until !== "") next.heldUntil = held.until;
					if (held.estimated === true) next.heldEstimated = true;
				}
				return next;
			});
		}

		/** Held-only packages: present in the market listing, absent from v1's summary. */
		function collectHeld(details) {
			if (details === void 0) return [];
			const rows = [];
			for (const [name, detail] of Object.entries(details)) {
				if (detail === null || typeof detail !== "object") continue;
				if (detail.updateAvailable === true) continue;
				const hold = detail.heldUpdate;
				if (hold === null || typeof hold !== "object") continue;
				const version = typeof hold.latest === "string" && hold.latest !== ""
					? hold.latest
					: typeof detail.latest === "string" && detail.latest !== ""
						? detail.latest
						: void 0;
				if (version === void 0) continue;
				rows.push({
					name,
					installedVersion: typeof detail.current === "string"
						? detail.current
						: typeof detail.version === "string"
							? detail.version
							: "?",
					heldVersion: version,
					...(typeof hold.until === "string" && hold.until !== "" ? { heldUntil: hold.until } : {}),
					...(hold.estimated === true ? { heldEstimated: true } : {})
				});
			}
			return rows.sort((a, b) => a.name.localeCompare(b.name));
		}

		/** Ask the market which installed plugins can be updated. */
		async function checkPlugins(force) {
			if (state.market.running) return;
			patchMarket({ status: "checking", error: void 0 });
			const res = await apiGet(API + "/updates/summary" + (force ? "?force=1" : ""));
			if (res.status === 404) {
				patchMarket({ status: "unsupported", checked: 0, updatable: 0, packages: [], held: [] });
				return;
			}
			if (res.status !== 200 || res.body === void 0) {
				patchMarket({ status: "error", error: (res.body && res.body.error) || res.error || "HTTP " + res.status });
				return;
			}
			const body = res.body;
			const packages = Array.isArray(body.packages) ? body.packages : [];
			// Read after the summary so the market's cached check (already refreshed
			// by an explicit recheck) answers without a second network round.
			const details = await readUpdateDetails();
			const annotated = annotatePackages(packages, details);
			patchMarket({
				status: "ready",
				checked: typeof body.checked === "number" ? body.checked : 0,
				updatable: annotated.length,
				packages: annotated,
				held: collectHeld(details),
				error: void 0
			});
		}

		/** One automatic page refresh per run, after plugins that need no restart. */
		let autoRefreshStarted = false;

		/**
		 * The market refuses to hand out a release that is still inside the
		 * desktop maturity hold. Depending on the path, that refusal reaches us as
		 * RELEASE_TOO_FRESH, as a generic 409 (OPERATION_BUSY) or as a plain
		 * message, so both the code and the sentence are recognised. It is not a
		 * failure: the package simply waits until the hold clears.
		 */
		const HOLD_TEXT = /等待期|成熟期|发布太新|release.?age|release is held|still in (its )?waiting period|maturity hold/i;

		function maturityHold(code, message) {
			if (code === "RELEASE_TOO_FRESH") return true;
			return typeof message === "string" && HOLD_TEXT.test(message);
		}

		/** Map a non-202 update response onto a row result. */
		function outcomeOf(res) {
			const body = res.body !== null && typeof res.body === "object" ? res.body : void 0;
			const failure = body !== void 0 && body.failure !== null && typeof body.failure === "object" ? body.failure : void 0;
			const code = failure !== void 0 && typeof failure.code === "string"
				? failure.code
				: body !== void 0 && body.stale === true && body.staleReason === "release-age"
					? "RELEASE_TOO_FRESH"
					: void 0;
			const error = (failure !== void 0 && (failure.message || failure.code)) || (body !== void 0 && body.error) || res.error || "HTTP " + res.status;
			if (maturityHold(code, error)) return { status: "pending", code: "RELEASE_TOO_FRESH", error };
			return {
				status: "failed",
				error,
				code,
				retryable: failure !== void 0 ? failure.retryable === true : res.status !== 409
			};
		}

		/** True when a 409 response is the maturity hold instead of a busy lock. */
		function isHeld(res) {
			const body = res.body !== null && typeof res.body === "object" ? res.body : void 0;
			if (body === void 0) return false;
			const failure = body.failure !== null && typeof body.failure === "object" ? body.failure : void 0;
			const code = failure !== void 0 ? failure.code : void 0;
			const message = failure !== void 0 ? failure.message : body.error;
			if (maturityHold(code, message)) return true;
			return body.stale === true && body.staleReason === "release-age";
		}

		/**
		 * The desktop app refuses to remove a bundle whose loader entry is still
		 * live ("bundle-in-use"), and the market's managed update is
		 * remove-then-install, so a mounted plugin can never be hot-updated — the
		 * button would show the same bilingual refusal on every click. Such a
		 * plugin is installed over instead: the running copy stays loaded, the new
		 * files land on disk, and the restart the page already offers applies it.
		 */
		const IN_USE_CODES = { "bundle-in-use": true, "stop-profile": true, "not-removable": true };
		const IN_USE_TEXT = /bundle-in-use|this plugin is in use|will not remove it|正在使用中|不允许现在移除/i;

		function inUseFailure(code, message) {
			if (typeof code === "string" && IN_USE_CODES[code] === true) return true;
			return typeof message === "string" && IN_USE_TEXT.test(message);
		}

		/** Install the target version over the running one through the Host half. */
		async function overlayUpdate(pkg) {
			let res;
			try {
				res = await apiPost(OVERLAY_API, { name: pkg.name, version: pkg.latestVersion });
			} catch (error) {
				return {
					status: "blocked",
					code: "overlay-failed",
					error: error instanceof Error ? error.message : String(error)
				};
			}
			const body = res.body !== null && typeof res.body === "object" ? res.body : {};
			if (res.status === 200 && body.ok === true) {
				return {
					status: "done",
					overlaid: true,
					installedVersion: typeof body.version === "string" ? body.version : pkg.latestVersion,
					restartRequired: true,
					refreshRequired: false
				};
			}
			if (maturityHold(body.code, body.error)) return { status: "pending", code: "RELEASE_TOO_FRESH", error: body.error };
			if (res.status === 404 || res.status === 501) {
				return {
					status: "blocked",
					code: "overlay-unavailable",
					error: typeof body.hint === "string" ? body.hint : body.error
				};
			}
			return {
				status: "blocked",
				code: typeof body.code === "string" ? body.code : "overlay-failed",
				error: body.error || "HTTP " + res.status
			};
		}

		/**
		 * A market update that failed because the plugin is mounted falls back to
		 * the overlay install. Anything else keeps its own outcome.
		 */
		async function recoverInUse(pkg, outcome) {
			if (outcome.status !== "failed" || inUseFailure(outcome.code, outcome.error) !== true) return outcome;
			patchMarket({ overlay: pkg.name });
			try {
				return await overlayUpdate(pkg);
			} finally {
				patchMarket({ overlay: void 0 });
			}
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
						const restartRequired = operation.restartRequired === true;
						return {
							status: "done",
							installedVersion: operation.installedVersion ?? operation.afterVersion,
							restartRequired,
							refreshRequired: restartRequired !== true && (operation.refreshRequired === true || operation.hot === true)
						};
					}
					const failure = operation.failure;
					const code = failure !== void 0 && failure !== null ? failure.code : void 0;
					const error = (failure && (failure.message || failure.code)) || operation.error || operation.state;
					if (maturityHold(code, error)) return { status: "pending", code: "RELEASE_TOO_FRESH", error };
					return {
						status: operation.state === "cancelled" ? "cancelled" : operation.state === "rolled-back" ? "rolled" : "failed",
						error,
						code,
						retryable: failure !== void 0 && failure !== null && failure.retryable === true
					};
				}
				if (Date.now() > deadline) return { status: "failed", error: "timeout" };
			}
		}

		/**
		 * Update one plugin through the market API. A 409 usually means the market
		 * is still busy with another operation, so it is retried — except when the
		 * 409 carries the maturity hold, which no retry can clear.
		 */
		async function updateOne(pkg) {
			let attempts = 0;
			for (;;) {
				const res = await apiPost(API + "/updates", { packageName: pkg.name });
				if (res.status === 202 && res.body && res.body.operation) {
					return await recoverInUse(pkg, await pollOperation(res.body.operation.operationId, pkg.name));
				}
				const outcome = outcomeOf(res);
				if (outcome.status === "pending" || isHeld(res) || res.status !== 409 || attempts >= 6) {
					return await recoverInUse(pkg, outcome);
				}
				attempts += 1;
				await sleep(1500);
			}
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
				// A held release is waiting, not retryable: a rerun must not pick it up.
				return result === void 0 || (result.status !== "done" && result.status !== "pending");
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
			let refreshRequired = false;
			patchMarket({ running: true, finished: false, current: ordered[0].name, results, percent: 0, restartRequired: false, refreshRequired: false });
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
				if (outcome.refreshRequired === true) refreshRequired = true;
				patchMarket({ results: { ...results }, percent: 0 });
			}
			const packages = state.market.packages.map((pkg) => {
				const result = results[pkg.name];
				if (result === void 0 || result.status !== "done") return pkg;
				const target = pkg.targetVersion === void 0 ? pkg.latestVersion : pkg.targetVersion;
				const installed = result.installedVersion === void 0 ? target : result.installedVersion;
				return { ...pkg, installedVersion: installed };
			});
			// Pending holds stay visible in the hold category, not as updatable rows.
			const remaining = packages.filter((pkg) => {
				const result = results[pkg.name];
				return result === void 0 || (result.status !== "done" && result.status !== "pending");
			});
			patchMarket({
				running: false,
				finished: true,
				current: void 0,
				percent: void 0,
				restartRequired,
				refreshRequired,
				packages,
				updatable: remaining.length
			});
			rememberRestart(restartRequired === true);
		}

		/* ---------------------------------------------------------------- */
		/* Applying updates: refresh the page, or restart the app             */
		/* ---------------------------------------------------------------- */

		const REFRESH_STAMP = "dsh-one-click-update:refreshed-at";

		/** The window, when the client runs in a real browser page. */
		function pageWindow() {
			return typeof window === "object" && window !== null ? window : void 0;
		}

		/** Reload the page (the client modules of a fresh release are picked up). */
		function refreshPage() {
			const where = pageWindow();
			if (where === void 0 || where.location === void 0 || typeof where.location.reload !== "function") return false;
			where.location.reload();
			return true;
		}

		/**
		 * A plugin update changes the Host release, and a page keeps serving the
		 * client modules it booted with until it reloads — that skew is the reason
		 * 「新会话」 can fail right after an update. Reload once when the run ends;
		 * the sessionStorage stamp stops a stale market summary from looping it.
		 */
		function scheduleRefresh(delay) {
			const where = pageWindow();
			if (where === void 0 || where.location === void 0 || typeof where.location.reload !== "function") return false;
			let storage;
			try {
				storage = where.sessionStorage;
			} catch (error) {
				storage = void 0;
			}
			if (storage !== void 0 && storage !== null) {
				try {
					const last = Number(storage.getItem(REFRESH_STAMP) || "0");
					if (Number.isFinite(last) && Date.now() - last < 120000) return false;
					storage.setItem(REFRESH_STAMP, String(Date.now()));
				} catch (error) {
					return false;
				}
			}
			patchMarket({ refreshing: true });
			setTimeout(() => {
				try {
					where.location.reload();
				} catch (error) {
					/* the shell may have replaced the page already */
				}
			}, typeof delay === "number" ? delay : 1400);
			return true;
		}

		/**
		 * A Host-half update only takes effect after a full restart, and the page
		 * learns that from one operation that lives in the Host process — a reload
		 * would lose it. Keep the reminder in localStorage, keyed by the Host
		 * bootId, so it survives reloads and disappears by itself once the Host
		 * really rebooted.
		 */
		const RESTART_STAMP = "dsh-one-click-update:restart-pending";

		function localStore() {
			const where = pageWindow();
			if (where === void 0) return void 0;
			try {
				return where.localStorage;
			} catch (error) {
				return void 0;
			}
		}

		function rememberRestart(pending) {
			const storage = localStore();
			if (storage === void 0 || storage === null) return;
			try {
				if (!pending) {
					storage.removeItem(RESTART_STAMP);
					return;
				}
				const caps = state.market.capabilities;
				const bootId = caps !== void 0 && caps.bootId !== void 0 ? String(caps.bootId) : null;
				storage.setItem(RESTART_STAMP, JSON.stringify({ bootId, at: Date.now() }));
			} catch (error) {
				/* a storage-less shell just loses the reminder */
			}
		}

		function restoreRestart() {
			const storage = localStore();
			if (storage === void 0 || storage === null) return;
			let raw;
			try {
				raw = storage.getItem(RESTART_STAMP);
			} catch (error) {
				return;
			}
			if (raw === null || raw === void 0) return;
			let saved;
			try {
				saved = JSON.parse(raw);
			} catch (error) {
				saved = null;
			}
			const caps = state.market.capabilities;
			const bootId = caps !== void 0 && caps.bootId !== void 0 ? String(caps.bootId) : void 0;
			const same = saved !== null && typeof saved === "object" && typeof saved.bootId === "string" && bootId !== void 0 && saved.bootId === bootId;
			if (same) {
				patchMarket({ restartRequired: true });
				return;
			}
			try {
				storage.removeItem(RESTART_STAMP);
			} catch (error) {
				/* ignore */
			}
		}

		/**
		 * One-click restart of the whole app. Desktop asks this bundle's Host route
		 * (the shell exposes no restart call); a plain web Host uses the market's
		 * own restart endpoint, and the page reloads once the Host answers again.
		 */
		async function restartDsh() {
			if (state.market.restarting === true) return;
			patchMarket({ restarting: true, restartError: void 0 });
			const caps = state.market.capabilities;
			const desktop = caps !== void 0 && caps.runtime === "desktop";
			const marketRestart = caps !== void 0 && caps.restart !== void 0 && caps.restart.supported === true;
			const attempts = [];
			if (desktop) attempts.push({ url: RESTART_API, mode: "desktop" });
			else {
				if (marketRestart) attempts.push({ url: API + "/restart", mode: "market" });
				attempts.push({ url: RESTART_API, mode: "desktop" });
			}
			let lastError;
			for (const attempt of attempts) {
				const res = await apiPost(attempt.url, {});
				if (res.status >= 200 && res.status < 300) {
					patchMarket({ restarting: true, restartMode: attempt.mode, restartError: void 0 });
					if (attempt.mode === "market") void watchRestart();
					else watchDesktopRestart();
					return;
				}
				const body = res.body !== null && typeof res.body === "object" ? res.body : void 0;
				lastError = res.status === 404 ? "stale" : (body !== void 0 && body.error) || res.error || "HTTP " + res.status;
			}
			patchMarket({ restarting: false, restartError: lastError === void 0 ? "manual" : lastError });
		}

		/** Desktop: if the page is still alive after a while, the quit was refused. */
		function watchDesktopRestart() {
			setTimeout(() => {
				if (state.market.restarting !== true) return;
				patchMarket({ restarting: false, restartError: "manual" });
			}, 30000);
		}

		/** Web: wait for the restarted Host, then reload onto the new release. */
		async function watchRestart() {
			const deadline = Date.now() + 60000;
			for (;;) {
				await sleep(1200);
				const res = await apiGet(API + "/capabilities");
				if (res.status === 200) break;
				if (Date.now() > deadline) {
					patchMarket({ restarting: false, restartError: "manual" });
					return;
				}
			}
			scheduleRefresh(800);
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
			const held = market.held.length;
			if (market.running) {
				const done = Object.keys(market.results).filter((name) => market.results[name].status !== "pending").length;
				const total = market.packages.filter((pkg) => {
					const result = market.results[pkg.name];
					return result === void 0 || result.status !== "pending";
				}).length;
				return t("plugins.running", { name: market.current === void 0 ? "" : market.current, done, total });
			}
			if (market.status === "unsupported") return t("plugins.unsupported");
			if (market.status === "error") return t("plugins.error", { reason: market.error === void 0 ? "?" : market.error });
			if (market.status === "unknown" || market.status === "checking") return t("plugins.checking");
			if (market.restarting === true) return t("plugins.restarting");
			if (market.refreshing === true) return t("plugins.refreshing");
			if (market.finished) {
				const results = Object.values(market.results);
				if (results.length === 0) {
					// The auto-run still finished: a pure hold is not "up to date".
					return held > 0 ? t("plugins.heldOnly", { held }) : t("plugins.none");
				}
				const failed = results.filter((result) => result.status === "failed").length;
				const pending = results.filter((result) => result.status === "pending").length;
				const blocked = results.filter((result) => result.status === "blocked").length;
				// An overlay install is a success that leaves the app restart-pending,
				// so the plain "done" sentences would read wrong; compose instead.
				if (blocked > 0 || results.some((result) => result.overlaid === true)) {
					const done = results.filter((result) => result.status === "done").length;
					const parts = [];
					if (done > 0) parts.push(t("plugins.sumDone", { count: done }));
					if (failed > 0) parts.push(t("plugins.sumFailed", { count: failed }));
					if (pending > 0) parts.push(t("plugins.sumPending", { count: pending }));
					if (blocked > 0) parts.push(t("plugins.sumBlocked", { count: blocked }));
					return t("plugins.summary", { parts: parts.join(t("plugins.sumJoin")) });
				}
				if (failed > 0 && pending > 0) return t("plugins.doneMixed", { failed, pending });
				if (failed > 0) return t("plugins.doneSome", { failed });
				if (pending > 0) return t("plugins.donePending", { pending });
				return t("plugins.done");
			}
			if (market.updatable > 0) {
				return held > 0
					? t("plugins.countHeld", { count: market.updatable, held })
					: t("plugins.count", { count: market.updatable });
			}
			return held > 0 ? t("plugins.heldOnly", { held }) : t("plugins.none");
		}

		/** idle | available | active | error */
		function toneOf(snapshot) {
			const app = snapshot.app;
			const market = snapshot.market;
			if (app.phase === "error" || market.status === "error" || market.restartError !== void 0) return "error";
			if (market.running || market.restarting === true || market.refreshing === true || app.pending || BUSY_PHASES[app.phase] === true) return "active";
			if (market.restartRequired === true) return "available";
			if (market.updatable > 0 || app.phase === "available" || app.phase === "ready") return "available";
			return "idle";
		}

		/** Tooltip of the sidebar entry. */
		function entryTitle(snapshot, t) {
			const parts = [];
			if (snapshot.market.restartRequired === true) parts.push(t("plugins.restartTitle"));
			else if (snapshot.market.finished === true && snapshot.market.status === "ready") parts.push(describePlugins(snapshot.market, t));
			else if (snapshot.market.running) parts.push(describePlugins(snapshot.market, t));
			else if (snapshot.market.status === "ready") {
				const held = snapshot.market.held.length;
				if (snapshot.market.updatable > 0) {
					parts.push(held > 0
						? t("plugins.countHeld", { count: snapshot.market.updatable, held })
						: t("plugins.count", { count: snapshot.market.updatable }));
				} else {
					parts.push(held > 0 ? t("plugins.heldOnly", { held }) : t("plugins.none"));
				}
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

		/** One row per upgradable plugin, with its own state. Held rows live elsewhere. */
		function PluginRows(props) {
			const market = props.market;
			const t = props.t;
			const rows = market.packages.filter((pkg) => {
				const result = market.results[pkg.name];
				return result === void 0 || result.status !== "pending";
			});
			if (rows.length === 0) return null;
			return h(
				"ul",
				{ className: "dsh-ocu-rows" },
				rows.map((pkg) => {
					const result = market.results[pkg.name];
					let stateText = t("plugins.pending");
					let tone = "idle";
					let stateTitle;
					if (market.running && market.current === pkg.name && result === void 0) {
						stateText = t("plugins.updating");
						tone = "active";
					}
					if (market.overlay === pkg.name && result === void 0) {
						stateText = t("plugins.overlayWorking");
						tone = "active";
					}
					if (result !== void 0) {
						if (result.status === "done") {
							const target = pkg.targetVersion === void 0 ? pkg.latestVersion : pkg.targetVersion;
							const version = result.installedVersion === void 0 ? target : result.installedVersion;
							stateText = result.overlaid === true
								? t("plugins.overlayDone", { version })
								: t("plugins.installed", { version });
							tone = result.overlaid === true ? "warn" : "done";
							stateTitle = result.overlaid === true ? t("plugins.blockedNote") : void 0;
						} else if (result.status === "blocked") {
							// The plugin is mounted and even the overlay install was
							// refused (an old Host, or a read-only profile).
							stateText = t("plugins.blocked");
							stateTitle = result.error;
							tone = "warn";
						} else if (result.status === "failed") {
							stateText = t("plugins.failed", { reason: result.error === void 0 ? "?" : result.error });
							stateTitle = result.error;
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
								h(
									"span",
									{
										className: "dsh-ocu-version dsh-ocu-version-new",
										title: pkg.heldVersion === void 0 ? void 0 : t("plugins.heldHint", { version: pkg.heldVersion })
									},
									pkg.targetVersion === void 0 ? pkg.latestVersion : pkg.targetVersion
								)
							)
						),
						h("span", { className: "dsh-ocu-row-state", title: stateTitle }, tone === "active" ? Spinner() : null, h("span", null, stateText))
					);
				})
			);
		}

		/** Local month-day hour:minute for a hold's release time, or undefined. */
		function holdWhen(row) {
			if (typeof row.heldUntil !== "string") return void 0;
			const when = new Date(row.heldUntil);
			if (!Number.isFinite(when.getTime())) return void 0;
			const pad = (value) => String(value).padStart(2, "0");
			return (when.getMonth() + 1) + "-" + pad(when.getDate()) + " " + pad(when.getHours()) + ":" + pad(when.getMinutes());
		}

		/** When the market expects the release to become installable. */
		function holdUntilText(row, t) {
			const when = holdWhen(row);
			if (when === void 0) return t("held.untilUnknown");
			return t(row.heldEstimated === true ? "held.untilEstimated" : "held.until", { when });
		}

		/**
		 * The hold category: packages whose newer release exists but is still inside
		 * the market's maturity hold. They are never part of a run; the rows only
		 * say what is waiting and when it should clear.
		 */
		function HeldRows(props) {
			const rows = props.rows;
			const t = props.t;
			if (rows.length === 0) return null;
			return h(
				"ul",
				{ className: "dsh-ocu-rows dsh-ocu-rows-held" },
				rows.map((row) => h(
					"li",
					{ className: "dsh-ocu-row dsh-ocu-row-held", "data-tone": "pending", key: row.name },
					h(
						"span",
						{ className: "dsh-ocu-row-main" },
						h("code", { className: "dsh-ocu-row-name" }, row.name),
						h(
							"span",
							{ className: "dsh-ocu-row-versions" },
							h("span", { className: "dsh-ocu-version" }, row.installedVersion === void 0 ? "?" : row.installedVersion),
							h("span", { className: "dsh-ocu-arrow", "aria-hidden": "true" }, "\u2192"),
							h("span", { className: "dsh-ocu-version dsh-ocu-version-new" }, row.heldVersion)
						)
					),
					h(
						"span",
						{ className: "dsh-ocu-row-state", title: t("plugins.pendingHold") },
						h("span", null, holdUntilText(row, t))
					)
				))
			);
		}

		function heldRowsOf(market) {
			const rows = [...market.held];
			const known = new Set(rows.map((row) => row.name));
			// A run can still report a hold (the summary raced the market's check);
			// keep that package visible here instead of in the updatable list.
			for (const pkg of market.packages) {
				const result = market.results[pkg.name];
				if (result === void 0 || result.status !== "pending" || known.has(pkg.name)) continue;
				known.add(pkg.name);
				rows.push({
					name: pkg.name,
					installedVersion: pkg.installedVersion,
					heldVersion: pkg.heldVersion === void 0
						? pkg.targetVersion === void 0
							? pkg.latestVersion
							: pkg.targetVersion
						: pkg.heldVersion,
					...(pkg.heldUntil === void 0 ? {} : { heldUntil: pkg.heldUntil }),
					...(pkg.heldEstimated === true ? { heldEstimated: true } : {})
				});
			}
			return rows;
		}

		function HeldSection(props) {
			const market = props.market;
			const t = props.t;
			const rows = heldRowsOf(market);
			if (rows.length === 0) return null;
			return h(
				"section",
				{ className: "dsh-ocu-card dsh-ocu-card-held", "data-tone": "held" },
				h(
					"div",
					{ className: "dsh-ocu-card-head" },
					h("h2", { className: "dsh-ocu-card-title" }, t("section.held")),
					h("span", { className: "dsh-ocu-card-meta" }, t("held.meta", { count: rows.length }))
				),
				h(HeldRows, { rows, t }),
				h("p", { className: "dsh-ocu-card-foot" }, t("held.note"))
			);
		}

		function PluginSection(props) {
			const market = props.market;
			const t = props.t;
			const busy = market.running;
			const results = Object.values(market.results);
			const failedNames = Object.keys(market.results).filter((name) => {
				const result = market.results[name];
				return result.status === "failed" && result.retryable !== false;
			});
			const succeeded = results.filter((result) => result.status === "done").length;
			// Held packages are shown by HeldSection, never among the updatable rows.
			const visibleRows = market.packages.filter((pkg) => {
				const result = market.results[pkg.name];
				return result === void 0 || result.status !== "pending";
			});
			const showRows = visibleRows.length > 0 && market.status !== "unsupported";
			const heldAnnotated = market.packages.some((pkg) => pkg.heldVersion !== void 0);
			const restartNeeded = market.restartRequired === true;
			// Any successful plugin update changes the client-module release the page
			// booted from; until it reloads, creating a new session can mix modules of
			// two versions. On desktop only a full restart clears the server half.
			const refreshNeeded = market.finished && succeeded > 0 && !restartNeeded;
			const restarting = market.restarting === true;
			const refreshing = market.refreshing === true;
			const disabled = busy || restarting || market.status === "unsupported";
			let actionLabel = t("plugins.action");
			let action = () => void runPluginUpdates(void 0);
			if (busy) actionLabel = t("plugins.busy");
			else if (market.finished && failedNames.length > 0) {
				actionLabel = t("plugins.retry");
				action = () => void runPluginUpdates(failedNames);
			} else if (market.finished) {
				actionLabel = t("plugins.recheck");
				action = () => {
					patchMarket({
						finished: false,
						results: {},
						restartRequired: false,
						refreshRequired: false,
						restarting: false,
						restartError: void 0,
						refreshing: false
					});
					rememberRestart(false);
					void checkPlugins(true);
				};
			}
			const notes = [];
			if (restartNeeded) notes.push(t("plugins.restart"));
			else if (refreshNeeded) notes.push(t("plugins.refreshHint"));
			if (heldAnnotated) notes.push(t("plugins.heldNote"));
			const blockedResults = Object.values(market.results).filter((result) => result.status === "blocked");
			// An old Host has no overlay route; restarting DSH loads it from disk,
			// so offer the very restart that makes the next run work.
			const overlayBlocked = blockedResults.some((result) => result.code === "overlay-unavailable");
			if (blockedResults.length > 0) {
				notes.push(overlayBlocked ? t("plugins.overlayUnavailable") : t("plugins.blockedNote"));
			}
			if (market.restartError === "manual") notes.push(t("plugins.restartManual"));
			else if (market.restartError === "stale") notes.push(t("plugins.restartStale"));
			else if (market.restartError !== void 0) notes.push(t("plugins.restartFailed", { reason: market.restartError }));
			const total = visibleRows.length;
			const done = Object.keys(market.results).filter((name) => {
				const result = market.results[name];
				return result.status !== "pending" && visibleRows.some((pkg) => pkg.name === name);
			}).length;
			const overall = busy && total > 0
				? ((done + (market.percent === void 0 ? 0 : market.percent) / 100) / total) * 100
				: 0;
			let tone = "idle";
			if (market.status === "error" || market.restartError !== void 0) tone = "error";
			else if (busy || restarting || refreshing) tone = "active";
			else if (restartNeeded) tone = "warn";
			return h(
				"section",
				{ className: "dsh-ocu-card", "data-tone": tone },
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
				notes.length > 0
					? h("p", { className: "dsh-ocu-card-note dsh-ocu-note-warn" }, notes.join(" "))
					: null,
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
							disabled: market.status === "unsupported" || restarting
						},
						actionLabel
					),
					restartNeeded || overlayBlocked
						? h(
							"button",
							{
								type: "button",
								className: "dsh-ocu-primary dsh-ocu-primary-warn",
								onClick: () => void restartDsh(),
								"data-busy": restarting ? "true" : void 0,
								"aria-disabled": restarting ? "true" : void 0,
								disabled: restarting
							},
							restarting ? t("plugins.restarting") : t("plugins.restartNow")
						)
						: null,
					refreshNeeded
						? h(
							"button",
							{
								type: "button",
								className: "dsh-ocu-primary dsh-ocu-primary-quiet",
								onClick: refreshPage,
								"aria-disabled": refreshing ? "true" : void 0,
								disabled: refreshing
							},
							refreshing ? t("plugins.refreshing") : t("plugins.refreshNow")
						)
						: null
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

			// Once the run ends, the page is serving the previous client-module
			// release. Reload it automatically when no restart is needed, so a new
			// session can't mix two versions; a restart keeps the button instead.
			React.useEffect(() => {
				if (autoRefreshStarted) return;
				if (!market.finished || market.running) return;
				if (market.restartRequired === true) return;
				// The app updater ends with its own restart (and owns a native
				// window): don't race it with a page reload. The panel keeps the
				// 「刷新页面」 button for the case where that update is declined.
				const app = snapshot.app;
				if (app.pending === true || BUSY_PHASES[app.phase] === true || app.phase === "available") return;
				if (Object.values(market.results).every((result) => result.status !== "done")) return;
				autoRefreshStarted = true;
				scheduleRefresh();
			}, [market.finished, market.running, market.restartRequired, snapshot.app.phase, snapshot.app.pending]);

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
				h(HeldSection, { market, t }),
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
			'.dsh-ocu-row[data-tone="pending"] .dsh-ocu-row-state{color:var(--dsw-alias-state-warning-primary,#b07d1a)}',
			'.dsh-ocu-row[data-tone="warn"] .dsh-ocu-row-state{color:var(--dsw-alias-state-warning-primary,#b07d1a)}',
			'.dsh-ocu-card[data-tone="warn"]{border-color:var(--dsw-alias-state-warning-primary,#b07d1a)}',
			'.dsh-ocu-card[data-tone="warn"] .dsh-ocu-card-value{color:var(--dsw-alias-state-warning-primary,#b07d1a)}',
			".dsh-ocu-card-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b70)}",
			".dsh-ocu-note-warn{color:var(--dsw-alias-state-warning-primary,#b07d1a)}",
			".dsh-ocu-card-actions{display:flex;align-items:center;gap:10px;padding-top:2px}",
			".dsh-ocu-primary{appearance:none;border:none;cursor:pointer;padding:0 14px;height:32px;border-radius:var(--dsw-radius-sm,8px);font-size:13px;font-weight:500;color:var(--dsw-alias-button-primary-text,#fff);background:var(--dsw-alias-button-primary-fill,#3b6ef6);transition:filter .15s ease,opacity .15s ease}",
			".dsh-ocu-primary:hover{filter:brightness(1.06)}",
			".dsh-ocu-primary:active{filter:brightness(.94)}",
			'.dsh-ocu-primary[data-busy="true"]{opacity:.55;cursor:default}',
			".dsh-ocu-primary:disabled{opacity:.55;cursor:default}",
			".dsh-ocu-primary-warn{background:var(--dsw-alias-state-warning-primary,#b07d1a)}",
			".dsh-ocu-primary-quiet{color:var(--dsw-alias-label-primary,#1c1c1e);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
			".dsh-ocu-card-foot{margin:2px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b70)}",
			".dsh-ocu-card-held{border-style:dashed}",
			'.dsh-ocu-card-held .dsh-ocu-card-title{font-weight:500;color:var(--dsw-alias-label-secondary,#6b6b70)}',
			".dsh-ocu-rows-held{margin-top:0}",
			".dsh-ocu-row-held{font-size:12px}",
			".dsh-ocu-row-held .dsh-ocu-row-state{white-space:normal;text-align:right;max-width:46%;overflow:visible;text-overflow:clip;line-height:1.45}",
			"@media (max-width:560px){.dsh-ocu-page{padding:24px 20px 36px}.dsh-ocu-row{flex-direction:column;align-items:flex-start;gap:4px}.dsh-ocu-row-state{max-width:100%}.dsh-ocu-row-held .dsh-ocu-row-state{text-align:left;max-width:100%}}",
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
