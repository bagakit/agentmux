# PTY 尺寸：跨客户端 resize、重连与未知尺寸的诚实降级

Contract: `bagakit.feature-goal.v1`
Feature: `f-2698f5kpc`

## 目标

把「这个 Run 现在多大」收敛到 owner 权威。拿不到权威时**如实说不知道**，而不是拿一个看起来
像事实的旧值冒充；同时绝不因为我们自己这段流程判不出尺寸，就把一个健康的 Agent 锁死
（AGENTS.md 原则 11 第 2 类）。

## 已验证的现状（每条都是实测，不是推断）

1. **投影已收敛。** Run 投影已从 `RunSpec.size` 改成 `current_size`，且 `current_size` 显式为
   `null` 时**不回退**——null 是「daemon 说它不知道」，回退会把它伪装成事实。
   判别用例：`packages/core/test/ctxmux-run-current-size.test.ts`。

2. **但仓内 vendored 的 ctxmux 不提供这个能力。** `packages/core/vendor/ctxmux/darwin-arm64/manifest.json`
   = commit `c13ab114`、protocol 14。`bin/ctxmux` 与 `bin/ctxmuxd` 两个二进制 `strings` 计数：
   `current_size` = 0、`resized` = 0。SDK `dist/generated/RunEvent.d.ts` 的变体只有
   `output | exited | interrupted | tmux | observation_discontinuity | gap`，没有 resize 事件。
   所以今天 `snapshotCurrentSize()` 恒为 `undefined`、`liveResizedSize()` 恒为 `null`，
   **100% 的活尺寸来自 `confirmedSizes` 缓存**，而它只由我们自己发出的 resize receipt 的
   `applied_size` 喂养——覆盖不了别的客户端发的 resize。

3. **`confirmedSizes` 从不清除。** 写入在 `ctxmux-run-adapter.ts` 的 resize receipt 处与
   `translateLiveEvent` 处；读取只在 `projectRun`。`disconnect()` 与 `markConnectionLost()`
   清了 `attachments` / `client` / `runtime`，**唯独不清它**。
   判据用 grep 而不是行号（行号会随任何人的编辑漂移，实测本文档上一版的五个行号已全部偏 12 行）：
   `grep -n 'confirmedSizes' packages/core/src/ctxmux-run-adapter.ts` 给出全部读写点，
   `grep -n 'confirmedSizes\.\(delete\|clear\)' packages/core/src` **零命中**即本条成立。

4. **Desktop 侧已按 receipt 记账。** `TerminalViewportSynchronizer` 消费 `resize()` 的返回值
   （`{cols,rows}` 而非 `true`），以 PTY 回执为准。有测试钉住：`terminal-viewport-sync.test.ts:797`。

## 「核心两难」已被证伪（2026-09-14 实测推翻本文档自己的前一版结论）

本节此前写的是一个两难：留着缓存会投影出错尺寸，清掉缓存会把活着的 Agent 永久锁死，
因此需要「第三条路：重连后重新确立尺寸」。**两个前提都不成立**，第三条路是 YAGNI，不做。

**前提一（清缓存会永久锁死）证伪。** 这一支根本不存在——`confirmedSizes` **从来没有被清过**：
`grep confirmedSizes.delete|clear` 在 packages/core/src 下零命中，`markConnectionLost()` 与
`disconnect()` 都只清 attachments/client/runtime。所以「清掉缓存」不是一个选项，是一个假想。

更要紧的是，**即便走到 null 尺寸，恢复路径也是可达的**，因此它压根不是原则 11 第 2 类：
`TERMINAL_SIZE_UNKNOWN` 撞死的那条 readiness 观察，会被下一次 resize 重新挂上
（`client.ts:2440-2450` 的重挂块），而 desktop 在 Agent 面板布局时就会 resize
（`runtime-controller.ts:774` → `resizeAgent`）。关键是：**解除成因的动作与重挂的动作是同一个**——
这个码的成因正是缓存里还没有条目，而 resize 正是填缓存的那一手。
判别器：`packages/core/test/readiness-size-unknown-recovery-reachability.test.ts`（实测，非推断）。

**前提二（别的客户端会改尺寸）在当前产品里不可达。** App 取单实例锁
（`apps/desktop/src/main/index.ts:61`），第二个实例直接退出；vendored 的 `ctxmux` CLI 只做完整性
校验、**从不被 spawn**（全仓 grep 无调用）；protocol 14 也没有任何入站几何通道。没有第二个写者，
「留着缓存」投影出的就是对的尺寸。

**因此不做「重连后重发几何」。** 它今天是空操作（尺寸没变过，重发的值与现值相等，
`requestResize` 同 key 直接短路）；而等到多客户端真的成立时，它会变成**坏策略**——每次网络抖动
都把别人的视图改掉（tmux/screen 的惯例是最小客户端优先或显式 force，没人拿抖动触发的
last-writer-wins 当默认）。同时协议 16 自带 `RunEvent::Resized`，而适配器**已经消费它**
（`ctxmux-run-adapter.ts:1149`），下游 `resized → TERMINAL_GEOMETRY_CHANGED → 证据重建 + readiness
重挂`整条链路也已就位。届时零新代码，而不是在渲染层再造一份。

于是原「三道闸」那一节不再是「待修的障碍」，而是**记录为什么这条路今天走不通、也不该走通**。
真要做的时候，落点在 Core 的 `republishLiveRunState` 里比对 `current_size` 与缓存，复用
`resizeAgent` 那个 discard+重挂块——**不在渲染层**，也绝不让 `startLiveSynchronization` 可重入
（它带着 `awaitingFirstLiveFit` / `gridWhenReplayLanded` 那套一次性重放机器，重入会误触重绘）。

## 重连后为什么今天不会重新确立（2026-09-14 新验证，三道互相独立的闸）

此前的判断是「`startLiveSynchronization()` 已经会重置 `lastRequestedGrid`，所以这是**一次调用**
而不是新机制」。**这个判断是错的**，实测三处都挡着：

1. **`startLiveSynchronization()` 在重连后是 no-op。** 它开头就是
   `if (this.disposed || this.live) return`（`terminal-viewport-sync.ts:206-209`）。
   重连时 `this.live` 仍为 `true`，所以里面那行 `this.lastRequestedGrid = null` **根本走不到**。

2. **它的唯一触发条件在重连时不翻转。** 调用点是 `TerminalView.tsx:322`，effect 依赖
   `[canControlRun]`，而 `canControlRun = session.processState === 'running'`（`:183`）。
   掉线**不改 `processState`**——这一点是 `session-state.ts:605` 用注释明写的既定设计
   （"掉线不改 processState"，disconnected 只写 `status.state`）。所以 effect 不重跑。

3. **TerminalView 不会重挂。** attach effect 的依赖是
   `[session.control.run.runId, session.id, themeId]`（`TerminalView.tsx:897`）；重连后 runId 不变，
   于是 synchronizer 实例存活、`lastRequestedGrid` 保持旧值，`requestResize` 对同一 grid key
   直接短路（`:365-370`）。

**结论**：修复需要一个显式的「重连后重新确立几何」入口，不能靠既有调用点顺带完成。
三道闸各自独立，只解其中一道都不够——这正是「看起来是一次调用」的那个判断会踩空的地方。

## 还缺的一环：Desktop 压根收不到跨客户端 resize 的通知

`client.ts:3992` 在 `resized` 上**刻意 return**；`AgentMuxClientEvent` 没有任何几何变体；
渲染侧的几何是**纯出站**的。所以即使 daemon 日后支持了 `resized`，也还需要一条入站的线。

## 验收应当证明的四件事

1. 起 80×24、resize 到 200×87 → Run 投影与后台虚拟屏都用新尺寸；`current_size: null` 不许回退冒充事实。
2. 别的客户端改了尺寸时，本窗口被通知到，pending 的 readiness 能恢复而不是挂死。
   （**改判：本条在协议 14 下不可达，且不该由我们这侧补。** 没有第二个写者，也没有入站几何通道；
   协议 16 的 `resized` 落地时，`1149` 的消费与下游重建/重挂链路已就位，届时零新代码。
   「pending 的 readiness 能恢复」这一半**已经成立并有判别器**，见
   `readiness-size-unknown-recovery-reachability.test.ts`。）
3. Desktop 以 PTY 回执为权威尺寸。（**已完成并有测试**：`terminal-viewport-sync.test.ts:797`，
   已复核为真判别器——回退到「信任请求值」会让第二次提议被同 key 短路，那条即红。）
4. 重连 / 输出丢失 / 跨尺寸历史时，状态同步失败或降级**必须显式**——既不许静默用错屏幕，
   也不许把一个健康的 Agent 拦住。
   （现状核对：尺寸缺席是 **fail-closed** 的——`screen-evidence.ts:155-160` 抛
   `TERMINAL_SIZE_UNKNOWN` 而不是拿 spec.size 造屏；而 `prompt-submission.ts:497-526` 把这个码
   连同 OUTPUT_GAP 等一起走**降级放行**：先向 daemon 核实 Run 还活着，然后发
   `unverified/degraded` 并放行，而不是拒发。两边合起来正是本条要的「显式且不拦人」。）

## 结论（2026-09-14）

本 Feature 的 1、3、4 已成立并各有判别器；2 经复核为**当前产品不可达、且不应在渲染层补**。
**因此不落新代码。** 本文档从「待实现的设计缺口」转为「为什么不做的记录 + 前提守卫」：
唯一的活交付物是那条反向判别器，它钉住「恢复路径可达」这个让我们决定不加兜底的前提——
谁删掉 `resizeAgent` 里的重挂块，它会红，那时才真的出现红线违规。

## 上游确认：这两个字段今天在本仓**根本到不了**（2026-09-14，与 ctxmux owner 对账后各自独立实测）

有一份需求描述写着「ctxmux 最新 main 已提供 `RunInfo.current_size` 和 `RunEvent::Resized`，可以直接
使用」。**这句话对 ctxmux main 成立，对 AgentMux 实际消费的东西不成立**——我们吃的不是 main，是
`packages/core/vendor/ctxmux/` 里冻结的构建快照。本机实测（不是推断，也不是转述）：

| 判的事 | 命令 | 实测 |
| --- | --- | --- |
| vendored 的协议版本 | `packages/core/vendor/ctxmux/darwin-arm64/bin/ctxmuxd --version` | `ctxmuxd 0.1.0 (protocol 14)` |
| 它是哪个 commit | `manifest.json` 的 `source.commit` | `c13ab114…`，**不是** main |
| 二进制里有没有这两个词 | `strings bin/ctxmux \| grep -c current_size` 及 `ctxmuxd`、`resized` | 四个数**全是 0** |
| SDK 里有没有这个字段 | 解包 `ctxmux-sdk-0.0.0.tgz` 看 `RunInfo.d.ts` | 字段止于 `applied_input_bytes`，**没有** `current_size` |
| SDK 里有没有这个事件 | 同上看 `RunEvent.d.ts` | 六个变体 `output / exited / interrupted / tmux / observation_discontinuity / gap`，**没有** `resized` |

**后果要说清楚**：今天在本仓写 `current_size` / `Resized` 的消费代码，**类型能过、注入假事件测试就能
绿，而运行时对每一个 Run 永远走不到**。`if ('current_size' in run)` 恒假，`resized` 分支永不触发。
这正是本仓记过的那条「声明了却静默不做的能力」——绿灯不等于交付。

ctxmux owner 同时确认了两条**语义**（来自协议源码文档，不是猜的），先记下来，等 vendor 升级后直接用：

- `current_size` 的 `null` 是**一个真答案**，意思是「没有任何 owner 能确认尺寸」（tmux 背书的 Run、
  或被替代 daemon 恢复的历史 Run）。**绝不许拿 `spec.size` 顶替**——那是「启动时请求过」而非
  「有人确认过」，顶替就是把「不知道」伪装成一个看起来像事实的错数字。本仓投影已按此实现。
- receipt 的 `applied_size` 与 `current_size` **不可能冲突**：同一把锁里的同一个读回值。所以**不要**
  实现任何「谁优先」的仲裁规则；真观察到不一致，那是 ctxmux 的 bug，应当上报而不是在这侧兜底。
  唯一的次序问题是**新旧**（resize 前取的快照就是旧的），按时间新近解决，不按来源。

升级到 protocol 16 需要 7 处 fail-closed 的东西同改（manifest、两个二进制、SDK tgz、
`CTXMUX_COMMIT`+`CTXMUX_TREE`、`CTXMUX_MANIFEST_SHA256`、pnpm-lock），属于一次独立的 vendor 动作，
不在本 Feature 范围内。

**因此本 Feature 第 2 条的正确状态是「阻塞在上游 artifact」，不是「已完成」，也不是「我们没做」。**
上游侧跟踪在 ctxmux 自己的 tracker（其 Task 1 仍 in_progress）；本仓这侧零新代码，理由见上一节。

## 前提已从本文档搬进代码（2026-09-14，e2783e92）

上面「不清缓存是对的」那套论证**曾经只写在这个文件里**，而本文件是一个未来的改动者**不需要路过**
的地方。ctxmux owner 指出了这一点：三条前提全是 AgentMux 的**部署事实**，不是 ctxmux 的保证——
ctxmux 的接口就是那个 socket，它自带的 CLI 和我们一样只是个客户端。于是把它们搬到
`confirmedSizes` 的声明旁，连同「什么会让前提失效」和「失效时**不要**做什么」。

三条前提各自的判别器（本文档不再是它们的唯一存放处）：

| 前提 | 判别器 |
| --- | --- |
| 只有一个 app 实例 | `apps/desktop/test/main-window-setup.test.ts`（单实例锁在构造任何运行时 owner 之前） |
| 我们从不启动 vendored CLI | `packages/core/test/ctxmux-second-writer-premise.test.ts`（**新增**） |
| protocol 14 无入站几何通道 | `ctxmux-run-current-size.test.ts` 的 `expect(PROTOCOL_VERSION).toBe(14)` |

**写判据的过程纠正了论断本身。** 第一版写的是「CLI 的路径从未被拼出来过」，判据当场变红：
`verifyArtifact` 为了 stat+sha 必然要把传给它的任何描述符拼成路径，CLI 也不例外。真正成立的性质更窄
——**那条路径从不逃出校验函数**。所以判据钉的是 `cli` 这个绑定**流向谁**（恰好一处：verifyArtifact），
而不是某一种路径拼法的拼写；后者换个写法就绕过去了。这一条若照着原话写进注释，会是一句永远没人
质疑的错话。

`PROTOCOL_VERSION` 用的是 SDK 导出的**类型化字面量**（`constants.d.ts` 写死 `: 14`），不是 grep
生成物路径：路径一变，grep 静默退化成读不到文件或恒真断言。另外握手是**精确相等**不是下限
（daemon 侧 `hello.protocol == PROTOCOL_VERSION`，否则 VersionMismatch 断连），所以 `>= 16` 不是
有效的运行时特性检测——升上去之后要么对面就是 16，要么根本连不上，**没有静默给错答案的窗口**。

## 边界

不要重复实现 ctxmux 的尺寸能力。缺的是我们这侧的重建与诚实降级，不是再造一份尺寸真相。
