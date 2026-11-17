# dsh-one-click-update

[![CI](https://github.com/jaredwang/dsh-one-click-update/actions/workflows/ci.yml/badge.svg)](https://github.com/jaredwang/dsh-one-click-update/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-one-click-update.svg)](https://www.npmjs.com/package/dsh-one-click-update)

> DSH 桌面端的「一键懒人更新」入口：在 Harness Web UI 侧边栏点一下，就把**插件市场里所有已安装且可更新的插件**依次更新到位；**DSH 桌面 App** 有更新时接着打开它自带的更新流程——不用自己查版本、勾选条目，全程有进度；还在发布成熟期里、暂时不能更新的插件不会混进来，而是单独列在「等待成熟期」分类，等放行后再更新。

A one-click, zero-effort updater for the [DSH](https://github.com/deepseek-ai/deepseek-harness) desktop app. It adds a sidebar row (next to 插件 / 插件市场 / 自动化任务) that opens a page which then does the rest: every upgradable plugin installed from the plugin market is updated in series with live per-item progress, and when the desktop app itself has an update, the entry hands off to the official `window.dshDesktop.updates` flow. Plugins whose newer release is still inside the market's maturity hold are kept out of the run and listed in their own waiting category, so they never block or dilute the updates that can actually install. No version checking, no picking items — one click, then let it run.

## 它做什么

一次进入更新页 = 一次「全部更新」，顺序固定：

1. **插件市场**：先读插件市场公开的 [Update API v1](https://www.npmjs.com/package/dshmarket)（`GET /dsh-market/api/v1/capabilities` 与 `GET /dsh-market/api/v1/updates/summary`），拿到所有可更新插件；再读市场面板自己的 `GET /dsh-market/updates` 做只读补充——只有它知道哪些插件的**最新版**仍在成熟期：只处于成熟期的插件根本不在 v1 summary 里，而最新版被 hold、但还有更旧成熟版本可装的插件会被 v1 列为可更新，这一类同样归入等待分类。该接口不可用时自动退回纯 v1 行为。
2. 对每个可更新插件**串行**发 `POST /dsh-market/api/v1/updates`，然后轮询 `GET /dsh-market/api/v1/operations?operationId=…`（700ms 一次，8 分钟上限），逐行显示 `已安装版本 → 目标版本` 与状态；真正失败的插件显示插件市场返回的失败原因并可点「重试失败项」；**仍在新版本成熟期内的插件单独归入「等待成熟期」分类**——不参与本次更新、不计入可更新数量，也不是失败；卡片里显示待成熟版本和预计可更新时间，等市场放行后重新检查即可更新。只要某插件的最新版仍在成熟期，它就整体留在等待分类、不发起更新——公开的 v1 更新接口无法锁定更旧的成熟版本（会返回 409「当前最新版仍在等待期」），强行更新只会让它在排队与等待之间来回；等最新版放行后重新检查，它会自动回到可更新列表并直接更新到最新版。需要提前装成熟版本时，请用插件市场面板自己更新。
**已经挂载（in-use）的插件不会被卡住**：桌面 Host 不允许在插件仍然挂载时热移除，而市场的托管更新是「先移除再安装」，所以这类插件会返回 `bundle-in-use`（原文「这个插件正在使用中，桌面端不允许现在移除」）。遇到这个失败码时，页面自动改走本插件的 `POST /dsh-one-click-update/overlay`：用桌面 Host 的 pnpm 把目标版本**覆盖安装**进 profile（不动已挂载的 loader 行），成功后同样标记「需要重启 DSH」，重启后新版本生效。若 Host 还没有这条路由（旧版插件半部尚未重启），则提示「当前 Host 还不支持覆盖安装」并直接给出「立即重启 DSH」按钮——重启后重新打开本页，它会自动走覆盖安装（也可以按提示手动 `pnpm add`）。

3. **让更新生效**：更新完成后，页面自己处理版本切换——只更新了客户端插件（`refreshRequired`）时自动刷新页面并提示「刷新页面后即可新建会话」（避免新旧两套 client modules 混用导致新建会话报错）；有插件的 Host 半部变了（`restartRequired`）时显示「立即重启 DSH」按钮，一键把桌面 App 退出并重新打开。重启提醒会用 Host 的 `bootId` 记在 `localStorage` 里，**刷新页面也不会丢**；如果同时有 App 更新在跑，页面刷新会让位给 App 自带的更新流程（它自己会重启）。
4. **DSH 桌面 App**：再读桌面端注入的 `window.dshDesktop.updates`（`status()` / `subscribe()` / `open()`）；只有确实存在新版本时页面才自动调用 `updates.open()`（检查 → 下载 → 安装 → 重启），避免每次打开都弹原生「已是最新」框。
5. 入口图标综合两边状态：有新版本 = 品牌色 + 呼吸圆点；正在更新 = 环形进度；出错 = 红色警示。

状态映射：

| 状态 | 侧边栏图标 | 页面 |
| --- | --- | --- |
| 无更新 | 灰色下载图标 | 所有插件都是最新版本 / 已是最新版本 |
| 发现更新 | 品牌色 + 呼吸圆点 | N 个插件可更新 / 发现新版本 vX.Y.Z |
| 插件更新中 | 环形进度（真实 percent） | 正在更新 name（done/total）+ 进度条 + 行状态 |
| App 下载/安装 | 环形进度 | 百分比 + 进度条 |
| 完成（仅客户端插件） | 灰色 | 插件更新完成 + 「刷新页面后即可新建会话」，页面自动刷新一次 |
| 完成（Host 半部变了） | 品牌色 | 插件更新完成，需要重启 DSH 后生效 + 「立即重启 DSH」 |
| 可更新插件 + 有插件在成熟期 | 品牌色 | 「N 个插件可更新，M 个等待成熟期」+ 独立的「等待成熟期」卡片 |
| 只有插件在成熟期 | 灰色 | 「暂无可以更新的插件，M 个等待成熟期」+ 独立卡片，不给重试按钮 |
| 插件已挂载、覆盖安装成功 | 品牌色 | 「已覆盖安装 x.y.z，重启后生效」+ 「立即重启 DSH」 |
| 插件已挂载、Host 尚未加载覆盖安装路由 | 品牌色 | 「当前 Host 还不支持覆盖安装」+ 「立即重启 DSH」（重启后重试即可） |
| 失败 | 红色警示 | 失败原因 + 重试失败项 |

更新时最常遇到的两条提示，现在都会被自动处理，不再直接显示成失败：

- `operation not found in this host process`：插件市场在更新途中重新加载了自己，进程内的更新记录随之消失（接口声明 `operationRetention: "current-process"`）。页面现在先按 `?force=1` 读一次市场状态核对磁盘：已装到目标版本就按成功处理（提示重启/刷新）；没装上就立刻重新发起这次更新。
- `another plugin operation is running`：市场里有另一个操作还占着锁（例如刚更新完的上一个插件仍在收尾，或市场面板自己正在更新）。页面现在会退避等待（1s/2s/4s/8s，最多约 3 分钟），期间行状态显示「等待其他更新结束…」，锁一释放就接着更新。只有一直等不到才会给出「插件市场一直在忙」的提示并允许重试。

## 用到的接口

插件市场（页面内同源 `fetch`：桌面 App 内由 `dsh-app://` 协议转发到本机 Host，浏览器内直接访问同一源）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/dsh-market/api/v1/capabilities` | 探测 API 是否可用、读 `runtime` 与 `features` |
| GET | `/dsh-market/api/v1/updates/summary` | 一次拿到所有可更新插件（`checked` / `updatable` / `packages`） |
| GET | `/dsh-market/updates` | 市场面板自己的列表：识别最新版仍在成熟期的插件，包括 v1 summary 误列为可更新的那些（只读补充，失败时退回纯 v1 视图） |
| POST | `/dsh-market/api/v1/updates` | 开始更新单个插件（`{packageName, force?}`，202/409/404） |
| GET | `/dsh-market/api/v1/operations?operationId=` | 轮询进度与终态（succeeded / failed / cancelled / rolled-back） |

桌面 App（Electron preload 注入）：`window.dshDesktop.updates.{status,subscribe,open}`。

本插件自己的 Host 路由（`index.js`，仅桌面 App 内的 Host 会真正重启）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/dsh-one-click-update/restart` | 读取重启能力（`supported` / `mode` / `appPath` / `bundleId`，无副作用） |
| POST | `/dsh-one-click-update/restart[?dryRun=1]` | 202 = 已启动重启助手；501 = 当前 Host 不是桌面 App 的 Host；409 = 正在重启 |
| GET | `/dsh-one-click-update/overlay` | 读取覆盖安装能力（`overlay` / `reason`，无副作用） |
| POST | `/dsh-one-click-update/overlay` | `{name,version}` 覆盖安装到当前 profile：200 = 已安装且需重启；400 = 包名/版本非法、未在 profile 声明或不是更新；409 = 成熟期或并发；501 = Host 没有桌面包的 pnpm 上下文；500 = 安装失败/落盘校验不一致；504 = 超时 |

## 明确的限制（不是 bug）

- **App 的最后一步原生确认框不可跳过**：主进程在重启前会弹出自己的「安装并重启」确认对话框，并会阻止在有活跃任务时重启。插件不能、也不应该绕过它。
- **更新 App 只能在 DSH 桌面 App 内使用**：`window.dshDesktop` 由 Electron preload 注入，纯浏览器打开 `http://127.0.0.1:PORT` 时不存在，页面会显示「更新 DSH 桌面 App 仅在桌面 App 内可用」；此时插件市场的更新仍然可用（同一 Host 源）。
- **重启靠一个后台助手脚本**：桌面端 preload 没有 quit/relaunch 通道，插件市场自己的 restart 在 desktop 下也被禁用（`restart.supported: false`，`managedBy: "desktop-host"`），所以「立即重启 DSH」由本插件的 Host 路由写一个临时脚本、脱离进程运行：先用 AppleScript 让 App 正常退出，确认主进程退出后再 `open` 重新打开。它**不会强杀**——如果 App 正在跑任务、退出被确认框拦住，助手会放弃并让确认框由你决定。重启入口只在「Host 真的是桌面 App 拉起的」情况下可用（普通 `dsh web` 会得到 501，网页端改用插件市场自己的 restart 接口）。
- **覆盖安装不是「热更新」**：它只把新版本写到磁盘，正在运行的 Host/页面仍跑旧代码，必须重启 DSH 才生效；之所以这样做，是因为桌面 Host 在插件挂载期间拒绝移除（`bundle-in-use`），而市场托管更新必须先移除。覆盖安装不绕过 market 的成熟期检查（超时/成熟期会如实返回 409），也不改变 profile 里 `dsh.profile.bundles` 的选择。
- **桌面端可能压住刚发布的新版本**：market 的 `holdYoungReleases` 会让刚发布的版本暂不显示为可更新；此时 summary 的 `updatable` 会少算或为 0，属正常。页面会从 `GET /dsh-market/updates` 识别这些插件（包括 v1 仍列为可更新、但最新版其实被 hold 的），整体放进「等待成熟期」分类、不发起更新；该面板接口不可用时退回纯 v1 视图，只是看不到等待分类，不影响正常更新。
- **operation 只活在当前 Host 进程里**：查不到的 operation 会 404（本插件按 “operation lost” 失败处理），重启 Harness 后旧的 operation id 即失效。
- 当前 DSH App 版本号不在 product API 里（只给 `phase` / `version` / `percent` / `failure`），「当前版本」由桌面端自己的对话框展示。

## 装在哪里 / 与皮肤的关系

- 入口 = 侧边栏左上角 `sidebar.panellist` 列表中的一行（`order: 5`，默认位于「插件市场」和「自动化任务」之间），文案由注册的 `label` 提供，图标由本插件渲染，与会话/插件入口同款。
- 主面板页注册在 `main` 的 keyed 条目（key = `one-click-update`），点入口行会切到该页，不会出现 `layout.selectPanel: main panel "one-click-update" is not registered`。
- 皮肤不影响入口：始终走同一套 `sidebar.panellist` slot，不依赖皮肤私有属性，也不需要 DOM hack。

## 结构

```
package.json        bundle 清单（dsh.bundle.patch + dsh.client）
cordis.patch.yml    insert 本插件
index.js            Host 半部：/dsh-one-click-update/restart（一键重启助手脚本）与 /dsh-one-click-update/overlay（已挂载插件的覆盖安装）
client.js           浏览器半部：slot 注册 + 更新状态机 + React 组件（含等待成熟期分类）
locale/{zh,en}.json 插件管理器里显示的标题与描述
icon.svg            64x64 图标
test/smoke.mjs      离线冒烟测试（mini React + 伪 fetch/桥）
test/host.mjs       Host 半部单测（平台分支、路由拒绝路径、覆盖安装校验、slot 注册与清理）
```

## 安装 / 卸载

已发布到 npm（[`dsh-one-click-update`](https://www.npmjs.com/package/dsh-one-click-update)），也可以直接从 GitHub 安装；`dsh plugin` 会把参数转给 pnpm：

```bash
# 从 npm 安装（推荐，桌面 App 使用的 profile 是 desktop）
dsh plugin --profile desktop add dsh-one-click-update

# 从 GitHub 安装（与 npm 上发布的是同一份代码）
dsh plugin --profile desktop add github:jaredwang/dsh-one-click-update

# 本地开发（从工作区目录安装）
dsh plugin --profile desktop add /absolute/path/to/dsh-one-click-update
```

普通 `dsh web` 把 `--profile desktop` 换成 `--profile web` 即可。安装后刷新页面（桌面 App 内 `Cmd+R`）就能看到侧边栏入口。
卸载：让 Harness 内的 `plugin_manager` 以 `remove_bundle` 移除 `dsh-one-click-update`，或 `dsh plugin --profile desktop remove dsh-one-click-update`。

## 开发自检

```bash
npm test        # = node test/smoke.mjs && node test/host.mjs
node --check client.js
```

冒烟测试不依赖任何 npm 包：它用一个 mini React 与伪 `fetch` / 伪桌面桥渲染真实的 `client.js`，覆盖自动开始、串行更新、失败重试、**成熟期等待（不是失败）**、**已挂载插件回退覆盖安装（以及 Host 未加载路由时的受阻提示）**、客户端更新后的自动刷新、**一键重启按钮与请求**、无插件市场、无桌面桥，以及最新版仍在成熟期的插件独立成类且不参与更新（即使 v1 把它列为可更新）、旧市场没有面板接口时退回纯 v1 视图、App 状态晚到（慢 `updates.status()`）仍会自动打开更新、**更新记录因市场重载丢失（已装/未装两种）**、**锁被其他操作占用（POST 409 与操作结果两条路径）**等路径（113 项断言）。`test/host.mjs` 用假的 `ctx` / request / response 覆盖 macOS / Windows / Linux 的重启脚本、非桌面 Host 的 501、外站 Origin 的 403、重复重启的 409、覆盖安装的参数/版本/依赖/成熟期/落盘校验与并发 409，以及两条路由的注册与清理（72 项断言）。

## 更新说明

### 0.5.2

- 修复：更新途中插件市场重新加载后，页面把 `operation not found in this host process` 当成终态失败——即使插件其实已经装好，也要用户自己再检查、甚至被市场状态缓存误导。现在轮询拿到 404 视为「记录丢失」而不是失败：先按 `?force=1` 读一次市场状态核对磁盘，已到目标版本就按成功处理（需要的话提示重启/刷新），没装上就立刻重新发起这次更新。
- 修复：`another plugin operation is running` 不再直接显示成失败。这类忙锁来自市场的互斥锁（另一个插件还在收尾，或面板自身在更新），原来只对 POST 的 409 重试 6 次、约 9 秒，并且从操作结果里返回的同一句话完全不重试。现在 POST 409 与操作结果里的忙锁统一按退避重试（1s/2s/4s/8s，每轮都重新 POST，最多约 3 分钟），期间行状态显示「等待其他更新结束…」。
- 修复：重试次数上限用满后仍失败时，不再把市场原文抛给用户，而是给出可操作的说明（「更新记录已失效…请重新检查后再试」/「插件市场一直在忙…请稍后点重试失败项」），原文留在行 tooltip 里；真正重试仍失败才会显示「失败：」。
- 兼容：成功但记录丢失时无法区分 Host 半部是否变化，一律按「需要重启 DSH」处理（多一次重启提示，不会漏掉生效步骤）；`checkPlugins` 的 30 分钟缓存用 `force=1` 绕过，不会把刚装好的插件又显示成可更新。
- 测试：`test/smoke.mjs` 新增四个场景（记录丢失但已装上、记录丢失且未装上、POST 忙锁重试、操作结果忙锁重试），共 113 项断言。

### 0.5.1

- 修复：最新版仍在成熟期的插件在「重新检查」后反复出现在排队中。0.5.0 把这类插件当作可更新、目标取 `eligibleVersion`，但公开的 `POST /dsh-market/api/v1/updates` 只接受 `packageName` / `force`，无法锁定更旧的成熟版本，市场会返回 409「当前最新版仍在等待期」；页面先显示排队，再把它挪进等待分类，重新检查后循环复现。
- 现在：只要 `GET /dsh-market/updates` 显示某插件有 `heldUpdate`（最新版仍在成熟期），该插件就整体归入「等待成熟期」——不进入可更新列表、不计入 `updatable`、不发起更新，也不会被「全部更新」或「重试失败项」选中；最新版放行后重新检查，它会自动回到可更新列表并直接更新到最新版。
- 取舍：不再通过本插件安装 `eligibleVersion`（例如最新版 0.85.1 被 hold 时先装 0.84.1）——公开接口不支持这种目标锁定；需要提前装成熟版本时请用插件市场面板。等待分类仍显示待成熟版本与预计可更新时间。
- 兼容与测试：面板接口不可用时退回纯 v1 行为；运行中才出现的成熟期结果仍归入等待分类、不会变成可重试失败。`test/smoke.mjs` 更新混合场景断言（被 hold 的插件不发请求、不在可更新列表），共 94 项断言。

### 0.5.0

- 新增：检查更新后，只处于发布成熟期、暂时不能更新的插件不再混在可更新列表里，而是进入独立的「等待成熟期」分类。该分类有自己的卡片、数量与说明，列出 `已安装 → 待成熟版本` 和预计可更新时间；这些插件不参与本次更新、不计入可更新数量、没有「重试失败项」。
- 修复：可更新插件的最新版也可能仍在成熟期（例如 latest 0.85.1 被 hold，实际安装的是 0.84.1）。现在读取市场面板接口的 `eligibleVersion` 作为显示目标，不再把不可安装的 latest 当成目标版本；tooltip 会说明最新版仍在成熟期。
- 兼容：面板接口缺失或报错时退回纯 v1 summary 行为（不显示等待分类），更新流程不变；运行中才出现的成熟期结果也会归入该分类，不会变成可重试失败。
- 测试：`test/smoke.mjs` 新增三类场景（混合更新 + 只等待、纯等待、无面板接口回退），共 95 项断言。

### 0.3.0

- 修复：更新已挂载的插件（如 `dsh-better-sidebar`）时，页面把桌面端的 `bundle-in-use` 拒绝原文直接显示成「失败：这个插件正在使用中，桌面端不允许现在移除」。现在这类失败会自动回退为**覆盖安装**，成功即显示「已覆盖安装 x.y.z，重启后生效」并给出「立即重启 DSH」。
- 新增 Host 路由 `GET/POST /dsh-one-click-update/overlay`：校验包名/版本号、profile 依赖声明、目标版本必须更新；用桌面 Host 的 pnpm 执行 `add <name>@<version> --save-exact`，安装后重新读取 profile 与 `node_modules` 校验落盘版本；成熟期返回 409 `RELEASE_TOO_FRESH`，超时 504，失败 500，非桌面 Host 501。
- 新增客户端识别 `bundle-in-use` / `stop-profile` / `not-removable` 失败码，并新增「覆盖安装成功」「需重启后更新」两种行状态与汇总文案；`blocked` 结果不会被当成可重试失败。若覆盖安装路由尚未加载（旧 Host），页面会直接给出「立即重启 DSH」，重启后重试即可。
- 升级提示：本版本新增了 Host 路由，装好后需要**重启一次 DSH**（或先触发一键重启）才能使用覆盖安装；在重启前回退会明确显示「需重启后更新」和手动 `pnpm add` 命令，不会静默失败。
- 测试：`test/host.mjs` 72 项、`test/smoke.mjs` 78 项断言。

### 0.2.0

- 修复：更新完插件后新建会话报错。根因是页面仍在使用启动时的 client modules 版本，而 Host 已经在提供新的 release；现在客户端插件更新完会自动刷新页面（并给出「刷新页面后即可新建会话」提示），需要 Host 半部更新的情况则改为醒目的一键重启。
- 修复：处于发布成熟期（market 的 release-age hold）的插件不再显示成「失败 + 重试失败项」，而是「等待成熟期」，等市场放行后自动可更新。该 hold 在 Update API v1 里其实以 `OPERATION_BUSY` 失败返回（409 响应体没有 `stale` 标记），所以按失败码 + 文案双重识别。
- 新增：一键重启 DSH。Host 半部新增 `/dsh-one-click-update/restart` 路由与脱离进程的助手脚本（macOS AppleScript 退出 + `open` 重开；Windows `taskkill`；其他 POSIX `SIGTERM`），页面在需要重启时显示「立即重启 DSH」。
- 新增：重启提醒跨刷新保留。Host 半部更新后即使页面被刷新或关闭重开，面板仍提示需要重启，直到 Host 真的重启（按 `bootId` 判断），不会再出现「刷新一下提示就消失、然后新建会话依旧报错」。
- 新增：`test/host.mjs`（44 项断言），`client.js` 冒烟测试扩展到 63 项。

## 许可证

[MIT](LICENSE) © 2026 Jared Wang
