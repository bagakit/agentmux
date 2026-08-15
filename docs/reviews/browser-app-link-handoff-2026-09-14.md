# 内置浏览器把应用链接交给系统

Review: approved

依据：用户 2026-09-14 就飞书文档 "Authorize in Feishu App" 点下去没反应给出的策略原话——
**「对齐一般浏览器, 假定用户会自己吧本应用当做浏览器」**，以及流程选择「建 feature + 先更设计文档」。
设计约束已写进 `docs/design/agentmux-desktop-interaction.md` 的 Browser 工作面一节（`2b60864e`），
本计划只落实那一节，不新增 Runtime 能力。

Closure：内置 Browser 遇到非 http(s) 的应用链接时，像一般浏览器那样交给系统打开；每个 scheme
首次问一次并可记住；拒绝或失败要说到下一步为止。

## 事实基线（每条都核过，不是推的）

三条路今天各自的行为：

| 入口 | 今天 | 证据 |
|---|---|---|
| 地址栏 | `normalizeBrowserUrl` → `assertAllowedBrowserUrl` 抛 | `browser-view-manager.ts:166` |
| 页面内导航 | `will-navigate` → `guardNavigation` 拦下并写 `entry.error` | `browser-view-manager.ts:857-866` |
| `window.open` / `target="_blank"` | **不走 `will-navigate`**，Electron 默认真的开一个 `BrowserWindow` | 真机探针，见下 |

第三条是真机探针的结论，不是读代码推的。探针形状照 `browser-drive-e2e.test.ts`：
Electron 43.3.0 + `WebContentsView`，与生产同形（不设 `setWindowOpenHandler`）。结果是窗口数
1 → 2 → 3，`did-create-window` 每次都发。所以症状不是「被吞掉」，是**冒出一个应用管不着的
空窗口**：不在 Region 里、没有工具栏、不归 Browser 生命周期管。

我此前在 `969e6623` 里把这一条写成「Electron 默认拒绝且不发事件，彻底静默」，那是把推理当成
事实。`2b60864e` 与 `e29eaa67` 已把它从设计文档、goal.md 和 Feature 标题三处撤回。

## 三条必须正面处理的既有决定

1. **`setWindowOpenHandler` 的缺席是有意的。** `649df3a2`（"preserve native popup semantics"）
   删掉了它，并加了 `browser-view-manager.test.ts:637` 钉住 `windowOpenHandler === null`。
   被删的那段把**每一个** window-open 都改道成 `this.navigate(entry.id, url)` 再 deny——
   等于把原生弹窗全压进同一个 view。重新加回来的判定**不许回到那个形状**：http(s) 必须继续
   交给 Chromium 原生处理，只有应用链接才被截走。这条是承重的，要有反向断言。

2. **`assertAllowedBrowserUrl` 继续拒绝非 http(s) 是对的，不改它。** `lark://` 装不进
   `WebContentsView`。应用链接要的不是「放行进视图」，是**改道给系统**——判定发生在闸门**之前**，
   闸门本身保持原状。这样 `javascript:` 一类仍然死在原地。

3. **主窗口已有一条同形的移交路**：`index.ts:180` 的
   `windowOpenOutcome(url, (t) => { void shell.openExternal(t) })`，判定在
   `window-security.ts` 的纯函数里。那个文件的 docstring 记着两个**实测存活**的变异，
   都是因为判定住在 Electron 回调体里。本计划照同一形状：判定是纯函数，回调体里不留语句。
   但注意那是**另一个 webContents 上的另一个 handler**，不是同一处，不能复用实例。

## 分类的形状：顺序判，不是一张清单

三段，按顺序：

1. **视图能装的**（`http` / `https` / `file` / `about:blank`）→ 照旧进闸门，不移交。
2. **永不移交的伪 scheme**（`javascript` / `data` / `blob`）→ 照旧拒绝，且**绝不**递给
   `shell.openExternal`。
3. **其余一律算应用链接** → 问一次，然后移交。

第 3 段刻意**不是**白名单。一般浏览器的做法就是把未知 scheme 交给 OS 判，我们枚举不完
`lark` / `slack` / `zoommtg` / `vscode` / `mailto` 之外的世界。安全边界是**那一问**，不是那张表。

第 2 段是一张禁止清单，而「禁止清单必漏」。这里可以接受，因为**漏一个的后果是安全的那一边**：
漏掉的伪 scheme 会掉进第 3 段，于是用户被问一次——保守、可发现。反过来把白名单用在第 3 段，
漏一个就是「这个 app 链接永远打不开」，而且没人会注意到。判据是漏了会往哪边倒。

## 问这一下走哪条线：复用既有投影，不新开通道

主进程今天**没有**任何能让渲染进程弹确认框的通道（`BrowserEvent` 只有 `updated` / `closed`
两种，`contracts.ts:1025-1028`；`dialog.showMessageBox` 在 main 里一次都没用过；
`ConfirmationDialog` 全部由渲染进程自己的 state 驱动）。

所以不新建通道，把待决请求挂进**已经在流的那份投影**：`BrowserSnapshot` 加一个
`appLinkPrompt: { url, scheme } | null`，渲染进程在**已经存在的那个错误块**里画
（`BrowserPane.tsx:564-570`——那里已经有一个 Retry 按钮，有位置也有先例）。回答走
`api.browser.*` 加一个方法。

零新通道、零新组件。理由不是省事：新开一条 main→renderer 的提示通道，意味着第二套「谁在等
用户回答」的生命周期，而 `BrowserSnapshot` 这条已经解决了重启、切 Tab、多 Region 的投影问题。

记住的选择落在 `ConfigStore` 的 `browser` 节（`config-store.ts:80`），照 `agentAutomation`
那个 `.optional()` + 缺省补齐的既有形状（`withBrowserAutomationDefault`，`:304`），不是 migration。

## 任务边界

三个任务按**入口**切，每个都是竖切闭合的（判定 + 接线 + 能看见的结果），不按「先纯函数后接线」
切——那样第一个任务过不了零调用者检查。

T-001 先落地，因为导航那条今天**有**错误可显示，是最短的一条端到端。T-002 依赖 T-001 的判定
与同意状态。T-003 是标准收尾：能力落地后 CLI、skill、默认页首条消息都要跟上。

## 验证

行为测试 + 变异红绿 + 排除定义文件的零调用者检查。三处判定各自要有反向断言：
只证「应用链接被移交」的实现，把 http(s) 也移交掉照样全绿。
