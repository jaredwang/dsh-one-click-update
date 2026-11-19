# dsh-one-click-update

[![CI](https://github.com/jaredwang/dsh-one-click-update/actions/workflows/ci.yml/badge.svg)](https://github.com/jaredwang/dsh-one-click-update/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-one-click-update.svg)](https://www.npmjs.com/package/dsh-one-click-update)

> DSH 桌面端的「一键懒人更新」入口：在 Harness Web UI 侧边栏点一下，就把**插件市场里所有已安装且可更新的插件**依次更新到位；**DSH 桌面 App** 有更新时接着打开它自带的更新流程——不用自己查版本、勾选条目，全程有进度；还在发布成熟期里、暂时不能更新的插件不会混进来，而是单独列在「等待成熟期」分类；需要马上用上新版时，打开「跳过冷静期」开关即可直接安装（逐次、可回退，只跳过这一次的发布等待）。

A one-click, zero-effort updater for the [DSH](https://github.com/deepseek-ai/deepseek-harness) desktop app. It adds a sidebar row (next to 插件 / 插件市场 / 自动化任务) that opens a page which then does the rest: every upgradable plugin installed from the plugin market is updated in series with live per-item progress, and when the desktop app itself has an update, the entry hands off to the official `window.dshDesktop.updates` flow. Plugins whose newer release is still inside the market's maturity hold are kept out of the run and listed in their own waiting category, so they never block or dilute the updates that can actually install. A **skip-the-hold switch** on that card installs a held release immediately when you really need it. No version checking, no picking items — one click, then let it run.

## 它做什么

一次进入更新页 = 一次「全部更新」，顺序固定：

1. **插件市场**：先读插件市场公开的 [Update API v1](https://www.npmjs.com/package/dshmarket)（`GET /dsh-market/api/v1/capabilities` 与 `GET /dsh-market/api/v1/updates/summary`），拿到所有可更新插件；再读市场面板自己的 `GET /dsh-market/updates` 做只读补充——只有它知道哪些插件的**最新版**仍在成熟期：只处于成熟期的插件根本不在 v1 summary 里，而最新版被 hold、但还有更旧成熟版本可装的插件会被 v1 列为可更新，这一类同样归入等待分类。该接口不可用时自动退回纯 v1 行为。
2. 对每个可更新插件**串行**发 `POST /dsh-market/api/v1/updates`，然后轮询 `GET /dsh-market/api/v1/operations?operationId=…`（700ms 一次，8 分钟上限），逐行显示 `已安装版本 → 目标版本` 与状态；真正失败的插件显示插件市场返回的失败原因并可点「重试失败项」；**仍在新版本成熟期内的插件单独归入「等待成熟期」分类**——不参与本次更新、不计入可更新数量，也不是失败；卡片里显示待成熟版本和预计可更新时间，等市场放行后重新检查即可更新。只要某插件的最新版仍在成熟期，它就整体留在等待分类、不发起更新——公开的 v1 更新接口无法锁定更旧的成熟版本（会返回 409「当前最新版仍在等待期」），强行更新只会让它在排队与等待之间来回；等最新版放行后重新检查，它会自动回到可更新列表并直接更新到最新版。需要提前装这个版本时，不用再绕去插件市场面板——打开等待分类卡片上的「跳过冷静期」开关即可（见下）。

**已经挂载（in-use）的插件不会被卡住**：桌面 Host 不允许在插件仍然挂载时热移除，而市场的托管更新是「先移除再安装」，所以这类插件会返回 `bundle-in-use`（原文「这个插件正在使用中，桌面端不允许现在移除」）。遇到这个失败码时，页面自动改走本插件的 `POST /dsh-one-click-update/overlay`：用桌面 Host 的 pnpm 把目标版本**覆盖安装**进 profile（不动已挂载的 loader 行），成功后同样标记「需要重启 DSH」，重启后新版本生效。若 Host 还没有这条路由（旧版插件半部尚未重启），则提示「当前 Host 还不支持覆盖安装」并直接给出「立即重启 DSH」按钮——重启后重新打开本页，它会自动走覆盖安装（也可以按提示手动 `pnpm add`）。

**跳过冷静期（开关）**：等待分类的卡片标题栏有一个「跳过冷静期」开关——打开后，每个等待中的插件行都会出现「立即更新」按钮（多行时卡片底部还有「全部立即更新」），点一下就**立刻安装仍在新版本成熟期内的那个版本**。桌面端插件市场自己的 `force` 在桌面 Host 上被显式禁用，所以这里改走本插件的覆盖安装路由：`POST /dsh-one-click-update/overlay {name,version,force:true}` 会让 Host 在这一次 pnpm 调用里额外带上 `--config.minimum-release-age=0`（pnpm 11 的发布年龄下限，默认 24 小时），装完同样校验落盘版本并要求重启。开关状态记在 `localStorage`（键 `dsh-one-click-update:skip-hold`），刷新后保留；关掉即恢复「只等待、不越过」的默认行为。旧版 Host 半部还不认识 `force` 时，页面会明确提示「当前运行的 Host 半部还不支持跳过冷静期：请先更新本插件再重启 DSH」，并退回市场自带的 `force` 请求，不会静默失败。

桌面 App 的 GUI Host 并不像 CLI 那样被交给 `profileContext.packageManager`，所以覆盖安装的 pnpm 由 Host 半部自己找：先读 `profileContext` 里的 `packageManager`（旧版 DSH）或 `dir`（新版 DSH），拿不到可执行文件时就用桌面 App 自带的那份 pnpm（`<App>.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`，以 `ELECTRON_RUN_AS_NODE=1` 由 App 二进制执行，和桌面 shell 自己跑 CLI 的方式一致）。两条都不成立时，页面不会谎称 Host 太旧，而是给出可照抄的手动命令：在 profile 目录执行 `pnpm add <name>@<version> --save-exact --config.minimum-release-age=0`，装好后重启 DSH。

3. **让更新生效**：更新完成后，页面自己处理版本切换——只更新了客户端插件（`refreshRequired`）时自动刷新页面并提示「刷新页面后即可新建会话」（避免新旧两套 client modules 混用导致新建会话报错）；有插件的 Host 半部变了（`restartRequired`）时把「立即重启 DSH」按钮高亮（它其实一直在——平时是安静样式，随时可以点，不必等页面判定「需要重启」），一键把桌面 App 退出并重新打开。重启提醒会用 Host 的 `bootId` 记在 `localStorage` 里，**刷新页面也不会丢**；如果同时有 App 更新在跑，页面刷新会让位给 App 自带的更新流程（它自己会重启）。
4. **DSH 桌面 App**：再读桌面端注入的 `window.dshDesktop.updates`（`status()` / `subscribe()` / `open()`）；只有确实存在新版本时页面才自动调用 `updates.open()`（检查 → 下载 → 安装 → 重启），避免每次打开都弹原生「已是最新」框。自动打开前先探一下 Host（`/dsh-market/api/v1/capabilities`，最多 5 轮、每轮 3 秒超时）：插件刚装完时 Host 还在热重载，桌面 shell 却只给「任务检查」10 秒、且失败不重试（`desktop update: task inspection timed out`），所以等 Host 能应答了再点；安装交接那一步若失败，页面把它当作可重试的 `install` 失败，安静地自动重试一次（下载包还在缓存里，5 秒后重新 `open()`，每会话最多一次）。
5. 入口图标综合两边状态：有新版本 = 品牌色 + 呼吸圆点；正在更新 = 环形进度；出错 = 红色警示。

状态映射：

| 状态 | 侧边栏图标 | 页面 |
| --- | --- | --- |
| 无更新 | 灰色下载图标 | 所有插件都是最新版本 / 已是最新版本 |
| 发现更新 | 品牌色 + 呼吸圆点 | N 个插件可更新 / 发现新版本 vX.Y.Z |
| 插件更新中 | 环形进度（真实 percent） | 正在更新 name（done/total）+ 进度条 + 行状态 |
| 空闲 | 灰色 | 卡片底部常驻一个安静的「立即重启 DSH」（悬停提示「随时可以重启」）；需要生效时它会变成高亮按钮 |
| App 下载/安装 | 环形进度 | 百分比 + 进度条 |
| 完成（仅客户端插件） | 灰色 | 插件更新完成 + 「刷新页面后即可新建会话」，页面自动刷新一次 |
| 完成（Host 半部变了） | 品牌色 | 插件更新完成，需要重启 DSH 后生效 + 「立即重启 DSH」 |
| 可更新插件 + 有插件在成熟期 | 品牌色 | 「N 个插件可更新，M 个等待成熟期」+ 独立的「等待成熟期」卡片 |
| 只有插件在成熟期 | 灰色 | 「暂无可以更新的插件，M 个等待成熟期」+ 独立卡片，不给重试按钮；卡片标题栏带「跳过冷静期」开关 |
| 打开跳过冷静期 | 灰色 | 每行多出「立即更新」（多行时还有「全部立即更新」），正在强制安装的行显示「正在安装…」 |
| 跳过冷静期安装成功 | 品牌色 | 「已覆盖安装 x.y.z，重启后生效」+ 「立即重启 DSH」 |
| 跳过冷静期但 Host 半部太旧 | 灰色 | 「当前运行的 Host 半部还不支持跳过冷静期：请先更新本插件再重启 DSH，然后重试」，该行保留可重试 |
| 跳过冷静期但 Host 没有 pnpm | 灰色 | 说明 Host 没有可用的 pnpm 上下文，并给出手动 `pnpm add … --config.minimum-release-age=0` 命令；该行保留可重试 |
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
| GET | `/dsh-one-click-update/restart` | 读取重启能力（`supported` / `mode` / `appPath` / `bundleId`，以及助手日志路径 `log`，无副作用） |
| POST | `/dsh-one-click-update/restart[?dryRun=1]` | 202 = 已启动重启助手（响应带 `helper` 脚本路径与 `log` 日志路径）；501 = 当前 Host 不是桌面 App 的 Host；409 = 正在重启 |
| GET | `/dsh-one-click-update/overlay` | 读取覆盖安装能力（`overlay` / `reason` / `force` / `source` / `releaseAgeOverride` / `detail`，无副作用） |
| POST | `/dsh-one-click-update/overlay` | `{name,version,force?}` 覆盖安装到当前 profile：200 = 已安装且需重启（`force:true` 时响应带 `forced`）；400 = 包名/版本非法、未在 profile 声明或不是更新；409 = 成熟期或并发；501 = Host 既没有发布 pnpm 上下文、也找不到桌面 App 自带的 pnpm；500 = 安装失败/落盘校验不一致；504 = 超时。`force:true` 只给**这一次** pnpm 调用加 `--config.minimum-release-age=0`，不改 profile 的 `pnpm-workspace.yaml`，也不影响其他更新 |

## 明确的限制（不是 bug）

- **App 的最后一步原生确认框不可跳过**：主进程在重启前会弹出自己的「安装并重启」确认对话框，并会阻止在有活跃任务时重启。插件不能、也不应该绕过它。
- **更新 App 只能在 DSH 桌面 App 内使用**：`window.dshDesktop` 由 Electron preload 注入，纯浏览器打开 `http://127.0.0.1:PORT` 时不存在，页面会显示「更新 DSH 桌面 App 仅在桌面 App 内可用」；此时插件市场的更新仍然可用（同一 Host 源）。
- **重启靠一个后台助手脚本**：桌面端 preload 没有 quit/relaunch 通道，插件市场自己的 restart 在 desktop 下也被禁用（`restart.supported: false`，`managedBy: "desktop-host"`），所以「立即重启 DSH」由本插件的 Host 路由写一个临时脚本、脱离进程运行：先用 AppleScript 让 App 正常退出，确认 LaunchServices 里**真的没有这个 App**之后，再分几路把它重新打开。
  - 判断「真的退出了」不再只看 `process.ppid`（那个 pid 可能是包装进程、甚至就是 launchd），也不再只靠 `pgrep`：当前 macOS 上 `pgrep -f "<App>.app/Contents/MacOS/"` **看不到 App 主进程**（只有 Chromium 的子进程能匹配），会误判成「已经退出」。现在以 LaunchServices 为准——`lsappinfo find bundleID=<bundle>` 返回空才算走了，`pgrep` 只作没有 `lsappinfo` 时的兜底。
  - 这一点是关键：早先的版本在 App 还在退出的那一秒就判「已退出」并立刻 `open`，LaunchServices 会把这次打开请求吸收给「正在关闭的那个 App」，于是什么都不发生。
  - 重新打开分几路，每一路都要看到 App 真的回来才算数（最多 2 轮）：`open -a` → `launchctl submit … open -a`（让 launchd 在进程树之外发起，绕开「App 自己打开自己」的怪异情境）→ `open -b <bundle>` → `open -n -a`（强制新实例）。App 回来后还会再观察 5 秒，确认不是「闪一下就没了」。
  - 退出请求本身也有超时：AppleScript 的 `quit` 要等 App 应答，若 App 正弹确认框它会一直挂着；助手最多等 15 秒，超时就放弃这条请求（不杀 App），接着按「App 是否还在」决定要不要重开。
  - 每次判断都写进 `${TMPDIR:-/tmp}/dsh-one-click-update-restart.log`（`GET` / `POST` 响应里的 `log` 字段就是它），每一路的命令与退出码都在里面。重启后没有弹回来，先看这个文件：`app is still running … not reopening` 表示退出被确认框或运行中的任务拦住了；`… (exit=0)` 但随后 `did not come back` 表示 LaunchServices 收下了请求却没真的启动；末尾的 `lsappinfo find` 输出说明当时 App 注册状态。
  - 它**不会强杀**——如果 App 正在跑任务、退出被确认框拦住，助手会放弃并让确认框由你决定。重启入口只在「Host 真的是桌面 App 拉起的」情况下可用（普通 `dsh web` 会得到 501，网页端改用插件市场自己的 restart 接口）。
- **覆盖安装不是「热更新」**：它只把新版本写到磁盘，正在运行的 Host/页面仍跑旧代码，必须重启 DSH 才生效；之所以这样做，是因为桌面 Host 在插件挂载期间拒绝移除（`bundle-in-use`），而市场托管更新必须先移除。覆盖安装默认**不**绕过 market/ pnpm 的成熟期检查（超时/成熟期会如实返回 409），只有页面上的「跳过冷静期」开关会让那一次调用带上 `--config.minimum-release-age=0`；那一次调用也不要求 `profileContext` 里有 pnpm——拿不到时用桌面 App 自带的那份（见上）；它也不改变 profile 里 `dsh.profile.bundles` 的选择，更不会把 `name@version` 写进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（那是持久的 profile 策略改动，本插件不做）。
- **桌面端可能压住刚发布的新版本**：market 的 `holdYoungReleases` 会让刚发布的版本暂不显示为可更新；此时 summary 的 `updatable` 会少算或为 0，属正常。页面会从 `GET /dsh-market/updates` 识别这些插件（包括 v1 仍列为可更新、但最新版其实被 hold 的），整体放进「等待成熟期」分类、不发起更新；该面板接口不可用时退回纯 v1 视图，只是看不到等待分类，不影响正常更新。这一等待本质上来自 pnpm 11 的 `minimumReleaseAge`（桌面 profile 未配置时默认 1440 分钟），要立刻安装就打开「跳过冷静期」。
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
index.js            Host 半部：/dsh-one-click-update/restart（一键重启助手脚本）与 /dsh-one-click-update/overlay（已挂载插件的覆盖安装，`force` 时放开发布年龄等待）
client.js           浏览器半部：slot 注册 + 更新状态机 + React 组件（含等待成熟期分类与「跳过冷静期」开关）
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

冒烟测试不依赖任何 npm 包：它用一个 mini React 与伪 `fetch` / 伪桌面桥渲染真实的 `client.js`，覆盖自动开始、串行更新、失败重试、**成熟期等待（不是失败）**、**已挂载插件回退覆盖安装（以及 Host 未加载路由时的受阻提示）**、**跳过冷静期的开关/单行/全部安装/旧 Host 退回/无 pnpm Host 的手动指引**、客户端更新后的自动刷新、**常驻重启按钮（空闲时的安静样式与请求）**、无插件市场、无桌面桥，以及最新版仍在成熟期的插件独立成类且不参与更新（即使 v1 把它列为可更新）、旧市场没有面板接口时退回纯 v1 视图、App 状态晚到（慢 `updates.status()`）仍会自动打开更新、**更新记录因市场重载丢失（已装/未装两种）**、**锁被其他操作占用（POST 409 与操作结果两条路径）**等路径，以及**安装交接超时后的自动重试**、**Host 尚在热重载时先探测再打开**等路径（155 项断言）。`test/host.mjs` 用假的 `ctx` / request / response 覆盖 macOS / Windows / Linux 的重启脚本、非桌面 Host 的 501、外站 Origin 的 403、重复重启的 409、覆盖安装的参数/版本/依赖/成熟期/落盘校验与并发 409，以及**强制覆盖安装的 argv（`--config.minimum-release-age=0`）与响应标记**、两条路由的注册与清理（94 项断言）。

## 更新说明

### 0.6.4

- 修复：点「立即重启 DSH」后 App 关掉了、但不会重新打开（0.6.3 仍未解决）。真正根因是 **Host 运行在 Electron 的 `ELECTRON_RUN_AS_NODE=1` 模式**：助手脚本由 Host 拉起，`open(1)` 会把调用者的环境原样传给新进程，于是 App 以 Node 模式启动——Dock 弹一下、没有窗口、立即 `exit(0)`，看起来就像「没有重启」。助手现在启动 App 前统一清掉 `ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ATTACH_CONSOLE`、`ELECTRON_ENABLE_LOGGING`、`ELECTRON_ENABLE_STACK_DUMPING`、`ELECTRON_DEFAULT_ERROR_MODE`、`NODE_OPTIONS`、`NODE_PATH`（`launchctl submit` 那一路同样处理）。
- 修复：`came_back` 以前在 App「起来又掉」时仍 `exit 0`，把短命实例当成成功并放弃后续重试；现在只有 App 稳定存活 5 秒才算成功，否则继续下一路/下一轮，最终 `exit 1`。
- 修复：改用 LaunchServices 判断 App 是否还在——`lsappinfo find bundleID=<bundle>` 返回空才继续，`pgrep` 只作兜底（macOS 允许 `pgrep` 读到的往往只是 Chromium 子进程，App 主进程匹配不上 `pgrep -f "<App>.app/Contents/MacOS/"`，会把「刚开始退出」误判成「已经没了」）。
- 改进：重新打开分四路（`open -a`、`launchctl submit … open -a`、`open -b`、`open -n -a`），放两轮，每路都有 10 秒观察窗；App 回来后额外观察 5 秒确认没有「起来又掉」。去掉必然失败的「直接启动 bundle 可执行文件」兜底（必被 Electron 的代码签名检查拒绝，`codesign_util.cc task_name_for_pid`）。
- 改进：日志记录每一步与每路命令的退出码及当时的 `lsappinfo` 状态，失败时能直接看出是哪一步没落地。
- 修复：插件更新刚装完、页面紧接着自动打开 App 更新时，桌面 shell 的「任务检查」可能等不到 Host 应答而报 `desktop update: task inspection timed out`（shell 只给 10 秒，失败不重试）。自动打开前先探测 Host（`/dsh-market/api/v1/capabilities`，最多 5 轮、每轮 3 秒超时），Host 还在热重载就等它能应答再点，不再把唯一的那次预算花在忙碌的 Host 上。
- 改进：安装交接失败（shell 对页面只暴露 `install` 这一种失败）时安静地自动重试一次：安装包还在更新缓存里，5 秒后重新走一遍 `updates.open()`；每会话最多一次，再失败就保留原来的提示。
- 测试：`test/host.mjs` 新增「重启脚本清理 Electron/Node 环境变量」「短命实例不得报成功」断言，共 94 项断言；`test/smoke.mjs` 共 155 项断言。

### 0.6.3

- 修复：点「立即重启 DSH」后 App 关掉但不再打开。助手脚本原来用 `process.ppid` 判断「App 是否已经退出」，而那个 pid 在桌面端可能是包装进程、甚至就是 `launchd`（pid 1）：`kill -0 1` 永远成功，脚本等满 20 秒后按「用户没确认退出」处理，于是再也不 `open`。
- 修复：判定改为看整个 bundle——`pgrep -f "<App>.app/Contents/MacOS/"`，App 主进程和它拉起的 node Host 都在这条路径下；原 pid 仅作兜底，且 `pid <= 1` 时不再参与判断。
- 修复：AppleScript 的 `quit` 只在 App 应答后返回，App 弹确认框时会一直挂着，助手因此卡死。现在退出请求最多等 15 秒，超时即放弃该请求（不杀 App），再按「App 是否还在」继续。
- 改进：重新打开带重试（`open -a` 最多 5 次、间隔 2 秒，并用 `pgrep` 确认真的起来了），全失败时直接启动 bundle 内可执行文件。
- 改进：助手把每一步写进 `$TMPDIR/dsh-one-click-update-restart.log`；`GET`/`POST /dsh-one-click-update/restart` 响应新增 `log` 字段指向该文件，失败后可直接查原因。
- 测试：`test/host.mjs` 新增脚本断言（bundle 级 `pgrep`、重试、直接启动兜底、日志）与两个路由的 `log` 字段，92 项断言；`test/smoke.mjs` 仍为 146 项。

### 0.6.2

- 改进：「立即重启 DSH」按钮改为**常驻显示**。它原先只在页面判定「需要重启」时出现，遇到 Host 半部没加载新路由、或用户想主动重启时根本找不到入口。现在插件卡片底部一直都有一颗按钮：平时用安静样式并带「随时可以重启」提示，需要生效（`restartRequired`）或覆盖安装受阻时自动变成高亮按钮，行为不变。
- 测试：`test/smoke.mjs` 新增「空闲时重启按钮仍在且为安静样式、可点击并打到 Host 路由」，146 项断言。

### 0.6.1

- 修复：桌面 GUI Host 上「跳过冷静期」永远报「当前运行的 Host 半部还不支持跳过冷静期」。根因是当前 DSH 的 `profileContext` 只发布 `dir`、不发布 `profileDirectory`，GUI Host 也不像 CLI 那样被交给 `packageManager`，覆盖安装路由因此一直判定「不是桌面 Host」，页面又把这个判定误报成 Host 半部过旧。
- 修复：覆盖安装路由改为从 `profileContext.dir`（兼容旧的 `profileDirectory`）取 profile 目录，缺少 `packageManager` 时回退到桌面 App 自带的 pnpm（`ELECTRON_RUN_AS_NODE` + `<App>.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`），与桌面 shell 跑 CLI 的方式一致；已在真实 App 二进制上实测能安装并绕过 `minimumReleaseAge`。
- 改进：带上 `--config.minimum-release-age=0` 后 pnpm 仍拒绝时，页面显示「已经带上跳过冷静期的参数，pnpm 仍拒绝安装」而不是含糊的「等待成熟期」。
- 改进：`GET /dsh-one-click-update/overlay` 增加 `source`（`host` / `bundled`）与 `detail`（目录/兼容上下文/自带运行时是否找到）；页面按「旧 Host 半部」与「Host 没有 pnpm」两种情况给不同提示，后者直接给出可照抄的手动命令，不再误报。
- 测试：`test/host.mjs` 覆盖 `dir`/`profileDirectory`/自带 pnpm/执行失败四类解析，84 项断言；`test/smoke.mjs` 新增「无 pnpm Host 的手动指引」「旧 Host 半部」「已带参数但 pnpm 仍拒绝」三条路径，140 项断言。

## 0.6.0

- 新增：「等待成熟期」卡片标题栏加入**「跳过冷静期」开关**。打开后每个等待中的插件行出现「立即更新」（多行时卡片底部还有「全部立即更新」），可以立刻安装仍在新版本成熟期内的版本；开关状态记在 `localStorage`（`dsh-one-click-update:skip-hold`），刷新后保留，关掉即回到默认的「只等待」行为。
- 实现：桌面端插件市场自己的 `force` 在 `config.desktopHost === true` 下被显式禁用（`POST /dsh-market/api/v1/updates` 仍会 409），所以强制安装走本插件的覆盖安装路由：`POST /dsh-one-click-update/overlay {name,version,force:true}` 让 Host 只给**这一次** pnpm 调用附加 `--config.minimum-release-age=0`（已用 pnpm 11.28.5 实测：profile 写 30 天 `minimumReleaseAge` 时原命令报 “within the minimumReleaseAge cutoff”，同一命令加该参数即安装成功）。不写 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`，不改 profile 策略。
- 兼容：`GET /dsh-one-click-update/overlay` 现在回报 `force` / `releaseAgeOverride`；页面据此判断 Host 半部是否支持跳过。旧 Host 上会明确提示「当前运行的 Host 半部还不支持跳过冷静期：请先更新本插件再重启 DSH，然后重试」，并退回市场自带的 `force` 请求，失败行保留可重试，不会静默失败。
- 细节：强制安装成功与被强更的包原本被一次运行标成「等待」时，会把它改写成「已覆盖安装 x.y.z，重启后生效」，该行离开等待分类；仍按 `bootId` 记录重启提醒。
- 测试：`test/smoke.mjs` 新增跳过冷静期开关（开关渲染/单行强制安装/旧 Host 退回/运行中等待行被结算）等场景，共 136 项断言；`test/host.mjs` 新增 `force` 能力回报与强制 argv 断言，共 76 项。

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
