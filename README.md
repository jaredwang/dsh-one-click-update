# dsh-one-click-update

[![CI](https://github.com/jaredwang/dsh-one-click-update/actions/workflows/ci.yml/badge.svg)](https://github.com/jaredwang/dsh-one-click-update/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-one-click-update.svg)](https://www.npmjs.com/package/dsh-one-click-update)

> DSH 桌面端的「一键懒人更新」入口：在 Harness Web UI 侧边栏点一下，就把**插件市场里所有已安装且可更新的插件**依次更新到位；**DSH 桌面 App** 有更新时接着打开它自带的更新流程——不用自己查版本、勾选条目，全程有进度。

A one-click, zero-effort updater for the [DSH](https://github.com/deepseek-ai/deepseek-harness) desktop app. It adds a sidebar row (next to 插件 / 插件市场 / 自动化任务) that opens a page which then does the rest: every upgradable plugin installed from the plugin market is updated in series with live per-item progress, and when the desktop app itself has an update, the entry hands off to the official `window.dshDesktop.updates` flow. No version checking, no picking items — one click, then let it run.

## 它做什么

一次进入更新页 = 一次「全部更新」，顺序固定：

1. **插件市场**：先读插件市场公开的 [Update API v1](https://www.npmjs.com/package/dshmarket)（`GET /dsh-market/api/v1/capabilities` 与 `GET /dsh-market/api/v1/updates/summary`），拿到所有可更新插件。
2. 对每个可更新插件**串行**发 `POST /dsh-market/api/v1/updates`，然后轮询 `GET /dsh-market/api/v1/operations?operationId=…`（700ms 一次，8 分钟上限），逐行显示 `已安装版本 → 目标版本` 与状态；失败的插件显示插件市场返回的失败原因（例如 `RELEASE_TOO_FRESH` → 「发布太新」），可点「重试失败项」。
3. **DSH 桌面 App**：再读桌面端注入的 `window.dshDesktop.updates`（`status()` / `subscribe()` / `open()`）；只有确实存在新版本时页面才自动调用 `updates.open()`（检查 → 下载 → 安装 → 重启），避免每次打开都弹原生「已是最新」框。
4. 入口图标综合两边状态：有新版本 = 品牌色 + 呼吸圆点；正在更新 = 环形进度；出错 = 红色警示。

状态映射：

| 状态 | 侧边栏图标 | 页面 |
| --- | --- | --- |
| 无更新 | 灰色下载图标 | 所有插件都是最新版本 / 已是最新版本 |
| 发现更新 | 品牌色 + 呼吸圆点 | N 个插件可更新 / 发现新版本 vX.Y.Z |
| 插件更新中 | 环形进度（真实 percent） | 正在更新 name（done/total）+ 进度条 + 行状态 |
| App 下载/安装 | 环形进度 | 百分比 + 进度条 |
| 完成 | 灰色 | 插件更新完成（N 个失败）/ 需要重启 DSH 桌面 App 后生效 |
| 失败 | 红色警示 | 失败原因 + 重试 |

## 用到的接口

插件市场（页面内同源 `fetch`：桌面 App 内由 `dsh-app://` 协议转发到本机 Host，浏览器内直接访问同一源）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/dsh-market/api/v1/capabilities` | 探测 API 是否可用、读 `runtime` 与 `features` |
| GET | `/dsh-market/api/v1/updates/summary` | 一次拿到所有可更新插件（`checked` / `updatable` / `packages`） |
| POST | `/dsh-market/api/v1/updates` | 开始更新单个插件（`{packageName, force?}`，202/409/404） |
| GET | `/dsh-market/api/v1/operations?operationId=` | 轮询进度与终态（succeeded / failed / cancelled / rolled-back） |

桌面 App（Electron preload 注入）：`window.dshDesktop.updates.{status,subscribe,open}`。

## 明确的限制（不是 bug）

- **App 的最后一步原生确认框不可跳过**：主进程在重启前会弹出自己的「安装并重启」确认对话框，并会阻止在有活跃任务时重启。插件不能、也不应该绕过它。
- **更新 App 只能在 DSH 桌面 App 内使用**：`window.dshDesktop` 由 Electron preload 注入，纯浏览器打开 `http://127.0.0.1:PORT` 时不存在，页面会显示「更新 DSH 桌面 App 仅在桌面 App 内可用」；此时插件市场的更新仍然可用（同一 Host 源）。
- **桌面端不能自重启**：Update API 的 `restart.supported` 在 desktop 下为 `false`（`managedBy: "desktop-host"`），需要重启的插件由页面提示「重启 DSH 桌面 App 后生效」，不显示重启按钮。
- **桌面端可能压住刚发布的新版本**：market 的 `holdYoungReleases` 会让刚发布的版本暂不显示为可更新；此时 summary 会显示 `updatable: 0`，属正常。
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
index.js            Host 半部：空实现（本插件不需要 Host 能力，全部走页面内同源请求与 preload 桥）
client.js           浏览器半部：slot 注册 + 更新状态机 + React 组件
locale/{zh,en}.json 插件管理器里显示的标题与描述
icon.svg            64x64 图标
test/smoke.mjs      离线冒烟测试（mini React + 伪 fetch/桥，42 项断言）
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
npm test        # = node test/smoke.mjs，离线冒烟：注册、状态机、自动更新流程、降级路径
node --check client.js
```

冒烟测试不依赖任何 npm 包：它用一个 mini React 与伪 `fetch` / 伪桌面桥渲染真实的 `client.js`，覆盖自动开始、串行更新、失败重试、无插件市场、无桌面桥，以及 App 状态晚到（慢 `updates.status()`）仍会自动打开更新等路径。

## 许可证

[MIT](LICENSE) © 2026 Jared Wang
