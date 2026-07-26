# Task Plan Review — ctxmux 活着，恢复态却永远转圈

日期：2026-08-30
原则 SSOT：`AGENTS.md` 第 11 条（三种状态）
架构 SSOT：`docs/architecture/terminal-runtime.md`（Attach replay 与原子揭示）
设计 SSOT：`docs/design/agentmux-desktop-interaction.md`《我们的流程坏了，不等于 Agent 坏了》、
`docs/design/agentmux-surface-density.md`《动效》

## 用户原话

> 现在有个 ctxmux 明明存在还在打开时显示 restoring 的问题, 以及 restoring 的动画太简单, 没有品牌感

> 彻底优化提交吧

两件事在同一个覆盖层上，但性质不同：一个是**我们的步骤挡住了一个健康的终端**（原则 11 违例），
一个是**最显眼的等待态没有品牌语言**。合并成一个 Feature 是因为它们改同一处表面、同一次验收；
拆成两个 Task 是因为前者是缺陷、后者是设计。

## 结论

**approved**。

问题一不是"恢复慢"，是**恢复态在结构上没有失败出口**。这与既有的
`f-23j8f43ck/T-004`（跨 Workspace keep-alive）、`f-23k8f8avd/T-002`（cold-park）都不重叠：
那两条治的是"不要重新挂载"，本条治的是"挂载之后揭示卡住了怎么办"。keep-alive 做到极致也不能
消除首次 attach、断连重连、replay gap 这三种真实需要重放的场合，而只要还有重放，就还有卡住。

## 定位（本轮只读审计）

恢复态判据 `terminal-startup.ts:11` 只看 `hydrating` 一个字段，与 ctxmux 是否存在、Run 是否
running **完全无关**。`hydrating` 只有两个出口：

| 出口 | 位置 | 条件 |
|---|---|---|
| `setHydrating(false)` | `TerminalView.tsx:524` | 全链成功 |
| 同上（错误分支） | `TerminalView.tsx:535` | attach **抛错** |

**所以卡在恢复态 ⟺ 那条链既没成功也没抛错。** 而链上五处 `await` 全无超时：

| 步骤 | 位置 | 有界？ |
|---|---|---|
| `api.sessions.attach` | `ipc.ts:437` → `runtime-controller.ts:650` | ❌ |
| ↳ 按 Run 串行锁 | `runtime-controller.ts:1128` | ❌ 前一个不 settle 就永远排队 |
| ↳ `client.connect()` | `client.ts:459` | ❌ `if (this.connecting) return await this.connecting` |
| ↳ SDK `wire.receive()` | `@ctxmux/sdk/dist/client.js:254` | ❌ 裸 socket 读 |
| `finishTerminalReplayRecovery` | `TerminalView.tsx:506` | ❌ 见下 |

### 最可能的死锁

`finishTerminalReplayRecovery` 在 `setHydrating(false)` **之前**就 `await startLiveSynchronization()`
（`TerminalView.tsx:509`），它一路走到 `api.sessions.resize` → `resizeSessionAttachment`
（`runtime-controller.ts:742`），而后者与 attach **共用同一把按 Run 串行的锁**
（`sessionAttachmentKey` = `[hostId, runId]`，`runtime-controller.ts:127`）。该 Run 上只要还排着
一个不 settle 的操作，这个 resize 就永远排在后面 → 恢复流程不返回 → `:524` 永不执行。
**ctxmux 完全健康，Run 正常打开，UI 永久转圈。**

唯一的好消息：resize 若**报错**有出口（会被 `:526` 的 catch 兜住）。只有"不 settle"会挂死。

### 已排除

- `terminal.write('', cb)`：空串回调正常触发（headless xterm 实测），不是这里。
- attach/detach 的 IPC 竞态：两种到达顺序都能自洽收敛，不是这里。

### 顺带记录：本轮撞到的一个独立故障

用 `agentmux open terminal` 开拓扑面板时，三次全部返回
`ctxmux durable state rejected a mutation: WAL truncate checkpoint could not reach zero bytes`。
**这是另一个缺陷**（ctxmux durable state 侧，终端创建全线失败），与本 Feature 无关，
不在此处顺手修——但它正是原则 11 想防的形状，应单独立项。

## 修法的取舍

**揭示的前提收敛为画面正确所真正依赖的那一步：replay 字节写完。** live 视口同步与 gap redraw
改善画面，但不决定画面是否可看，移到揭示之后继续。这一步同时消除了上面那个死锁。

**外加一个 deadline**：到点仍未揭示则强制揭示。这是"不许无限期持有遮挡权"的兑现，
不依赖对根因的猜测——链上五处任何一处卡住，用户都能拿回画布。

**强制揭示不得静默**：复用 `f-23g8feb8c/T-001` 已建好的服务窗（`lib/service-window-notice.ts`
的 `classifyServiceNotice` + `ServiceWindowNotice`），不新建第二条失败通路。Run 仍 running →
第 2 类；exited → 交给既有恢复横幅；interrupted → 如实说分不清。

**不改 `finishTerminalReplayRecovery` 本身**：`terminal-replay.test.ts:43` 钉住它内部
`['live','release','redraw']` 的顺序，那个顺序是对的，本轮只改"等不等它"。

**恢复态本身保留**。`hidden-tab-terminal-retention.test.ts` 的"真正需要重放时恢复态仍然出现"
是合同：删掉它更"干净"，但那是拿谎报换安静。被削弱的只是它无限期遮挡画布的权利。

## 测试环境的硬约束

**本仓没有任何测试跑 `useEffect`**——全部用 `renderToStaticMarkup`，零 `@testing-library/react`
（见 `launch-naming.test.ts:100` 的自述）。所以承重断言必须落在 `lib/` 纯函数上，
这也是 T-001 已确立的做法。已核实的其他雷：

- `terminal-startup.ts` 不得出现 `visible` 子串（`hidden-tab-terminal-retention.test.ts:100`，注释也算）。
- `terminal-interaction-latency.test.ts:83-99` 钉住六组输入→输出，新增字段必须可选且不改这六组结果。
- 新 token 必须被 `var()` 引用，否则 `surface-scale-contract.test.ts:182` 判"无人引用"变红。
- `pane-body` JSX 内不得出现 `setInterval` / `new ResizeObserver` / `IntersectionObserver`
  （`hidden-tab-terminal-retention.test.ts:128-130`）；`setTimeout` 不在黑名单。
- `terminal.css` 现 195 行，上限 400 行（`stylesheet-organisation.test.ts`）。
- **无测试守护、需手工验证**：`.terminal-hydration` 标记、`terminal-view__xterm--hydrating`、
  恢复态文案。这是既有覆盖的缺口，不是本轮引入的。

## 品牌化的依据

恢复态今天用的是全 App 通用的 `LoaderCircle className="spin"`（`base.css:27`，16 个文件共用），
与"Loading branches"毫无区别。兄弟态 `.terminal-agent-startup`（`terminal.css:67-93`）是居中卡片，
两者都没用绿色——所以绿色是可用的差异化手段，且 App 已有两个现成的绿色母题可复用：
`linear-gradient(180deg, var(--green), var(--green-2))`（主操作）与签名径向光晕
`radial-gradient(120% 90% at 100% 0, var(--overlay-line), transparent 52%)`（已在五处使用）。

`tokens.css` 声称拥有"动效"却**没有任何动效 token**，这是文档与实现的偏差，本轮一并补上。
补的 token 必须有落点：把既有 `cubic-bezier(.16,1,.3,1)` 提为具名并回填 `menu-in` 的三个调用点。

`prefers-reduced-motion` 下 `base.css:152-154` 是全局 `animation-duration: 0s !important`，
会**冻结**任何 keyframe。因此静态首帧本身必须读得出"正在工作"，不能靠动起来才说得清。
