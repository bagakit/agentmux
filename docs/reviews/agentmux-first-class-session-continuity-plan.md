# Task Plan Review — First-class Agent Session Continuity

日期：2026-08-30

## 用户原话

> 我重启以后，进入一个 topic，执行 resume 就是 `Agent resume unavailable` / `This Agent Session has no verified Provider handle for native resume`。
> 这个能恢复是当前项目的第一性功能，我觉得可以提到一个独立的 feature 里头彻底实现。
>
> 切换项目再回来，Earlier scrollback is unavailable，agent tui 需要重新 loading；重启以后要无缝衔接，打开就看。

## 结论

**approved**。这是一个独立的产品 Closure，不是旧 `session-resume` Feature 的单文件修补：

1. Core 必须持久化 Agent Session 的语义身份和经过校验的 Provider-native locator；
2. Desktop 启动要自动恢复所有已持久化 Workspace/Topic 投影，不要求用户先点 Resume；
3. 恢复失败的投影仍留在原 Region，原因可区分、可继续处理；
4. Workspace 切换只改变可见性，不能卸载仍打开的 Workbench、xterm 或 ctxmux attachment；
5. active Workspace、布局和窗口几何要在正常退出、崩溃/硬重启边界尽可能保留；
6. 机器重启只承诺 Session 语义和 Provider-native resume，不伪装旧 PTY、scrollback 或 pending interaction 仍存在。

## 架构边界（SSOT）

- `packages/core` 是 Agent Session / Provider / semantic continuity 的唯一 owner。它负责 durable session record、verified handle、恢复决策、去重和结果分类；不得依赖 Electron、React 或第二份 Runtime。
- `ctxmux` 是 Run/PTY/ordered bytes/Replay/Gap/Attachment 的唯一 owner。机器重启后 Run、PTY、内存 scrollback 消失是合法边界；Core 只能用 Provider-native resume 建立新 Run。
- `apps/desktop` 只投影 Core 的恢复结果并保存展示布局。Renderer 不拼 provider argv、不维护第二个恢复状态机；布局失败不能删除 Session 语义事实。
- Workspace/Topic/Tab/Region 是展示身份。跨 Workspace 切换由窗口级 Workbench owner 保持挂载，非活动实例隐藏并停工；真正关闭 Region/Workbench 或用户显式停止时才释放。

## 当前根因证据

- `AgentMuxFileAgentSessionStore` 默认根目录来自临时 runtime，机器重启后 native handle 消失；`agent-timelines` 与它同根。
- Desktop `store.initialize()` 只 sweep 旧的 attached id，并在恢复失败时裁剪 Tab/Region；这把“恢复失败”伪装成“布局不存在”。
- `activeWorkspaceId` 被启动逻辑硬编码成第一个 Workspace，若干 dock/rail 字段和窗口几何没有完整持久化。
- `App.tsx` 只挂载 active Workspace 的一个 Workbench；切换 Workspace 会销毁 xterm/attachment，从而制造 loading 和 replay gap。

## 失败与恢复合同

| 情况 | 合法动作 | 用户可见结果 |
| --- | --- | --- |
| 权威 Run 仍在且身份精确匹配 | attach 原 Run | 直接显示，不创建第二个 Run |
| Run 已丢失且 Provider handle verified、capability positive | native resume，保留 Session ID，创建新 Run | 自动恢复，无需点击 Resume |
| Provider 不支持 resume | 不伪造新上下文 | 原 Region 保留，按 `provider-resume-unsupported` 归类 |
| handle 缺失/未验证/失效 | 不猜 token、不 fallback 到新 Run | 原 Region 保留，按 `native-handle-unavailable` 归类 |
| Provider 在这台 Host 上缺席 | 不改判为永久失败 | 原 Region 保留，按 `provider-unavailable` 归类——这一类**可重试** |
| Core 无该 Session 的任何绑定 | 不凭空重建身份 | 原 Region 保留，按 `unknown-session` 归类 |
| Core identity/ownership conflict | 停止该候选，不重复 spawn | 原 Region 保留，按 conflict 归类（无 reason 码，冲突自己就是原因） |

> 这一列写的是**归类**，不是显示给用户的字符串。原始 code 不出现在界面上：每一类给出自己的标题、原因与下一步动作，见交互合同《Session 恢复》。上表原先只列了三类且其中两个 code 名（`provider-unsupported`、`continuity-conflict`）在 Core 中并不存在，已按 `agent-session-continuity.ts:21` 的实际 union 更正。
| 用户显式 stop/retire | 不自动复活 | 投影按明确的 retired 状态处理 |

未知状态不得静默放行或静默删除；应显示“无法判定”并保留诊断入口。

## 机器重启边界

旧 PTY、ctxmux Run、内存 scrollback、pending ACP interaction 不承诺恢复。成功恢复的判据是：同一个 Agent Session ID、经 Provider 验证的 native locator、一个新的权威 Run/attachment，以及原 View/Region/Topic 投影仍在。

## 任务 DAG 与独立验收

| Task | 依赖 | 交付 |
| --- | --- | --- |
| T-001 | — | Core durable session store、verified locator 持久化与 reopen round-trip |
| T-002 | T-001 | Core/Provider 恢复候选、去重、失败分类的单一公共结果 |
| T-003 | T-002 | Desktop 启动自动恢复所有 Workspace 投影；失败不裁剪布局 |
| T-004 | — | 窗口级 Workbench registry，跨 Workspace 切换 keep-alive 且非活动实例停工 |
| T-005 | — | active Workspace、布局字段、窗口几何与 shutdown/pagehide flush |
| T-006 | T-003,T-004,T-005 | 端到端回归、变异测试、零调用者检查、独立架构/工艺审计 |

每个 Task 必须有可执行 command gate；完成还要提供“故意改坏对应实现后测试变红”和定义文件之外的零调用者证据。旧 `f-23f8f4eb2` 的 durable-path 任务可作为实现输入，但不作为本 Feature 的唯一验收真相。

## 外部成熟模式对照

- 一个成熟桌面工具的 `use-app-session-persistence`、field-level persisted UI writer、sleeping-agent resume 和 window-bounds 校验说明：持久化应有 debounced writer、unload/shutdown checkpoint、几何合法性校验，恢复失败保留记录。
- 外部对照中 `PersistedAgentSession`、provider ref/argv 集中构造、dedupe key 和 geometry-ready 后后台 resume 的做法说明：不要从 session id 猜 transcript path；恢复计划应集中、去重并在布局可见后异步执行。

这里只抽取 project-native 最小模式，不复制第二套 Runtime、daemon 或 UI 状态机。

## T-006 收口证据

**零调用者检查**：`packages/core` 的 continuity 面共 7 个导出符号，经 `export *`
（`packages/core/src/index.ts:30`）出仓。其中 3 个导出类型没有*具名*生产调用方，但它们不是死码：
打包后的 consumer 经 `ensureAgentContinuity` 与 `.evidence.kind` 在结构上到达它们，删掉任一个
两侧 typecheck 立刻红。Renderer/Main/Core 三侧 `tsc --noEmit` 均通过。

**独立审计发现的真缺陷（一处）**：归属判断
`sessionBelongsToWorkspace`（`apps/desktop/src/renderer/src/lib/workbench-persistence.ts:106`）
是一个 `&&`——Workspace 仍被配置**且**这个 Session 归它所有。此前只有「该留的留下」与
「Workspace 没了」两侧有人守，**「Workspace 在、但 Session 是别人的」这一侧无人守**：把该
函数强制 `|| true`，`apps/desktop` 全部 192 文件 2025 条测试全绿。

认错归属比丢一个 Region 更糟——用户看到一个"属于这里"的 Agent，而它的输出来自别处。投影里存的
是 sessionId 字符串，id 复用、Workspace 改路径、同一台机上两个 Workspace 指向不同目录，都会让
Session 自带的 `hostId`/`workspacePath` 与 tab 对不上。已补 G6b
（`apps/desktop/test/workbench-persistence.test.ts`，commit `1d6623e`），与既有 G4 配成正负对；
变异证据：`|| true` 红、`&& false` 7 红（证明不是单侧守卫）、`workspaceOwnsSessionPath` 的两个
`return false` 各自失效各 1 红。

**这条的方法论教训**：一个 `&&` 有两侧出口，覆盖了「拒绝」侧不等于覆盖了「接受」侧。守卫要按
**出口**数，不按条件数。

**第二处真缺陷（独立审计，同族但在另一条路上）**：`reduceAgentMembershipSnapshot`
（`apps/desktop/src/renderer/src/lib/session-state.ts:308`）的 `canonicalIds` 只从
`snapshot.sessions` 建，`recoveryCandidates` 仅参与「整份快照是否为空」。一个 run 退出后 Core 不再
把它当投影主体，于是它从 `sessions` 消失、只留在 `recoveryCandidates` 里——**Core 正在说这个 agent
可以恢复**——却会在任何一次无关的成员 resync 中被连 tab 带 layout 摘掉，`partialize` 随后把删剩的
投影落盘：不可逆，且不给任何理由。

这正是本 Feature 承诺消灭的失败（用户原话「切换走再切换回来, 有些 Region 会消失」）在**运行时**
那条路上的真身；此前只修了启动那条。启动侧对同一个候选是「保留 + 恢复」——两条路对同一个 Core
概念给出了相反语义。已修（commit `f87fa60`）：候选 id 进入 `removalProtectedIds`。变异证据：去掉
保护 → 2 红；改成「有候选就谁都不删」的过宽修法 → 2 红（证明守的是精度，不是存在性）。

同时修掉一处**使测试失明的 fixture**：既有那条候选测试把 `SessionSnapshot` 摊进候选位置，而两者
身份字段不同名（`id` vs `agentSessionId`），得到的假候选 `agentSessionId` 是 `undefined`——它能通过
「候选数不为零」这类只看长度的判断，却在任何按 id 比对的地方都对不上。**用错形状的 fixture 写出来
的测试会看起来覆盖了那条路径，实际一次也没有。**

**待决（不在本 Task 内）**：`continuity-failure-notice.ts:54` 把 Core 的两类 `conflict`
（`session-run-changed` / `lifecycle-busy`）折成同一条 remedy `wait`；对前者「等」是错建议。但
`contracts.ts:479` 明确规定 `continuityReason` 对 `conflict` 缺席，故 renderer 收不到区分信息——
修法跨 Core／contract／renderer 三层，且要先定两类各自该给用户什么动作，属交互合同决策。



