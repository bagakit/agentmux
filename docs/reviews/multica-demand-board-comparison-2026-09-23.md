# Multica Demand board comparison

## 结论

Multica 的可借鉴点是业务边界和同一事实的多种投影，不是把它的数据库或 Web 组件搬进 AgentMux。AgentMux 当前已经有 Demand 文件系统包、Main IPC 和 Board 右侧 Session 投影；下一步应补齐 triage、属性完整性、负责人/执行边界、活动与执行日志、筛选视图和 CUI/UI 等价性。

## 借鉴位置与 AgentMux 落点

| Multica 已验证能力 | 参考位置 | AgentMux 借鉴规则 | AgentMux 目标位置 | 验收重点 |
|---|---|---|---|---|
| 持续需求与一次执行分离 | `apps/docs/content/docs/issues.zh.mdx:8-19`、`101-103`；`apps/docs/content/docs/tasks.zh.mdx:8-20` | Demand 保存目标、描述、状态、讨论和负责人；每次 Agent 执行/失败/重试是独立 Demand 工作记录，引用既有 Session/Run 事实 | `packages/demand/src/demand-types.ts`、`apps/desktop/src/renderer/src/lib/global-demand-board.ts`、Board 详情 | 执行完成不自动把 Demand 标成 done；同一 Demand 可保留多条工作记录和多个 Session |
| 明确的七状态生命周期 | `apps/docs/content/docs/issues.zh.mdx:41-64` | 保留 `backlog/todo/in_progress/in_review/blocked/done/cancelled`；状态是显式业务动作，不从 Session attention 推断 | `packages/demand/src/demand-types.ts`、`GlobalBoardSurface.tsx` | 跨列更新可审计；失败、断联和流程探测失败不覆盖 Demand 状态 |
| 负责人、Project、执行上下文分离 | `apps/docs/content/docs/issues.zh.mdx:29-39`；`apps/docs/content/docs/assigning-issues.zh.mdx:8-37`、`40-85` | 负责人表示谁跟进，Project 表示共享目标/资源，Session 表示一次执行；允许只分配不启动，启动是明确动作 | `packages/demand` API/CLI、Main IPC、DemandWorkspace | 分配 Executor 不隐式创建 Session；离开 backlog 时给出 start/no-start 选择；改负责人不停止已有 Session |
| 丰富的工作属性 | `apps/docs/content/docs/issues.zh.mdx:10-19` | 卡片/详情共享标题、描述、优先级、标签、计划起止日期、父子关系和扩展属性；空值不伪造槽位 | `packages/demand/src/demand-types.ts`、`GlobalBoardSurface.tsx`、`styles/global-board.css` | UI、CUI、文件快照读写同一字段；编辑失败保留旧值并显示服务窗 |
| Project 提供共享上下文 | `apps/docs/content/docs/projects.zh.mdx:8-46` | Project 不是卡片装饰，而是需求执行的共享说明和资源入口；Demand 可移动到另一个 Project，不复制需求 | `global-demand-board.ts`、Project 选择器、PMO teams prompt | Project 与 Session 关联独立；Project 缺失时 Demand 仍保留并显示 unknown |
| Board 卡片的可扫描信息密度 | `packages/views/issues/components/board-card.tsx:90-290` | 第一行 ID/优先级，第二行标题，随后描述、状态/Project/labels chips、负责人、日期、子任务进度和更新时间 | `GlobalBoardSurface.tsx`、`styles/global-board.css` | 卡片不再只显示 Session 数；多 Agent/Session 摘要复用 topology 组件 |
| 拖动与列投影 | `packages/views/issues/components/board-view.tsx`（`DndContext`、`onDragEnd`、`buildColumns`） | Board 列是同一 Demand 集合的状态投影；移动列是显式状态更新，空列仍是有效 drop target | `global-demand-board.ts`、`GlobalBoardSurface.tsx` | 变更状态产生 receipt/activity；筛选下移动不丢选中项，失败回滚 |
| 固定详情与行内编辑 | `packages/views/issues/components/issue-detail.tsx:695-900`、`1100-1300` | 卡片负责扫描，详情负责完整编辑、子 Demand、评论、属性和危险动作；保持 Board 上下文 | `DemandWorkspace`、后续 `DemandDetail` reusable surface | 详情固定在右侧，不跳到 Project；删除需确认，取消优先保留历史 |
| Demand 层级/推进批次 | `apps/docs/content/docs/issues.zh.mdx:105-111`；`issue-detail.tsx` 的 `SubIssueRow`/stage 逻辑 | Demand 可有父 Demand 和推进批次；父子状态不自动互相篡改，批次只表达一组子项的推进 | `packages/demand` 类型/CLI、DemandWorkspace 子 Demand 区域 | 父 Demand 可查看子项进度；完成通知不替换父状态 |
| 活动与执行日志 | `apps/docs/content/docs/tasks.zh.mdx:56-75`；`issue-detail.tsx` 的 activity timeline；`execution-log-section.tsx` | 活动、决策、评论与 Demand 工作记录按来源和状态分组；进行中置顶，历史可折叠，可查看/停止/重试 | `packages/demand` activities/decisions 扩展、DemandWorkspace timeline | 重启和跨进程读取后顺序、来源、状态稳定；停止/重试不改写历史 |
| 待处理路由队列 | `packages/views/inbox/components/inbox-page.tsx:108-220`、`inbox-list-item.tsx:96-214` | 增加跨 Project 的待处理入口：未分配、无 Project、needs-user、失败告示可集中处理；路由队列是视图，不是另一个实体 | `GlobalBoardSurface.tsx` 工具带和过滤模型 | 路由队列可恢复、可清除、可键盘操作；不把通知复制成第二张 Demand |
| 多视图、筛选和排序 | `apps/docs/content/docs/issues.zh.mdx:113-115`；`issues-header.tsx`、`filter-chips-bar.tsx` | Board、列表/表格和未来泳道共享同一 Demand 数据；筛选可按状态、Project、负责人、优先级、标签、日期、Session/Agent | `global-demand-board.ts`、Board toolbar、未来 `DemandListSurface` | 当前筛选可复制/清除；CUI 能重放同一筛选，不维护第二份投影 |
| 删除与取消边界 | `apps/docs/content/docs/issues.zh.mdx:117-123` | 删除是不可逆危险动作；默认用 cancelled 保留历史；删除 Demand 不删除 Project 或 Session | `DemandWorkspace`、Demand CLI/API | 删除确认、审计 receipt、运行中 Session 保留取消说明；失败不清空卡片 |

## 当前差距排序

1. **P0：语义完整性** — Demand 领域补齐 tags、计划日期、父子/推进批次、路由队列标记和工作记录/Session 摘要；保持零/多 Session 和单一文件事实。
2. **P0：详情工作区** — 把目前的长表单改为属性 rail + 活动/决策/执行日志的固定详情，保留 Project/Session 跳转和删除确认。
3. **P1：Board 路由队列与筛选** — 增加未分配/无 Project/needs-user/失败的可恢复路由队列，并补齐负责人、优先级、tags、日期和 Session/Agent 过滤。
4. **P1：执行分配边界** — 提供“只分配”“开始执行”“重新分配”三种明确动作；不能把分配 Executor 等同于创建 Session。
5. **P1：CUI/UI 等价** — Demand CLI/API 与 Board 详情共享字段、receipt、activity/decision 语义；错误保持稳定 code/phase/path。
6. **P2：多投影** — 在不复制数据的前提下加入列表/表格/泳道投影；Agents topology graph 仍由独立 Feature 负责。

## 明确不照搬的内容

- 不引入 Multica 的服务器、数据库、React Query、厂商 Agent 协议或登录模型。
- 不把 AgentMux 的 Session、Run、PTY、ordered bytes 或 ctxmux 事实复制到 Demand 包。
- 不把每个通知、工作记录或 Session 生成一张 Board 主卡；Board 永远以 Demand 为主实体。
- 不因参考产品支持复杂视图，就提前实现甘特图或完整自定义属性系统；先闭合最小业务流程和重启/CUI 证据。

## PMO CLI 与插件边界

PMO Teams 需要一套面向 Agent 的稳定 CLI，不依赖 Renderer 画面或猜测当前焦点。P0/P1 的命令面分成两组：

| 命令组 | 作用 | 最小命令 |
|---|---|---|
| 全局观察 | 让 PMO 先知道系统事实，再决定路由 | `agentmux pmo snapshot`、`projects`、`workspaces`、`topics`、`agents`、`sessions`、`demands`、`activity`、`inspect` |
| Demand 操作 | 用稳定 Demand ID 完成需求闭环 | `agentmux demand list/show/create/update/delete`、`link-session`、`unlink-session`、`link-project`、`unlink-project`、`activity`、`decision`、`assign`、`start`、`handoff` |

所有命令默认输出带 `schemaVersion`、`requestId`、`operation`、`observedAt`/`revision` 的 JSON receipt。观察命令返回稳定 ID、来源、关系 ID 和 `active/idle/unknown`；默认不灌入完整 transcript，需要时用精确 `inspect` 下钻。写命令要求显式目标、幂等 operation id、权限和可审计结果；“只分配”“开始执行”“交接”是三个不同动作。

这套 CLI 应通过 AgentMux 的插件注册边界提供能力目录：插件声明 `observe`、`plan`、`act`、`evaluate` 等能力和输入/输出 schema，Host 负责发现、权限、调用、版本、生命周期和回执。插件版本不可变，激活前可 inspect，停止会释放所有 effect，失败保留已完成步骤并报告阶段；插件不能直接读 Renderer Store、Demand 文件、ctxmux socket 或绕过 Core Control API。

对 RSI 的支持采用“证据驱动的可回滚迭代”：每次 PMO/插件调用都留下 bounded receipt、输入摘要、输出摘要、耗时、失败阶段和 evaluator 结果；改进只产生新版本候选，经过 replay/组合测试和明确的质量阈值后再激活，旧版本可以停止或回退。系统不允许插件在运行中自改代码、覆盖 Demand 真相或把一次成功的模型输出当成产品事实。

DeepSeek Harness 的借鉴位置记录在 Tracker：Plugin Manager 的 inspect-before-install、不可变版本、requestId 流式状态、失败恢复和共享写锁；Cordis runner 的注册表/生命周期单一 owner、provide/inject、只读 inspect manifest、可逆 effect 和真实组合测试。AgentMux 只吸收这些边界，保持自己的 Core/ctxmux/Runtime 分层。

## P0/P1 与 P2/P3

当前 Feature 只接受以下 P0/P1：PMO 全局观察、Demand CUI、Demand Board/详情、明确分配与执行、插件能力边界、跨进程/重启闭环，以及必要的 tags/计划日期/父 Demand/推进批次、路由队列和筛选。P2/P3 单独进入后续 Feature：复杂列表/表格/甘特/泳道投影、自定义属性框架、实时多客户端同步、插件安装管理界面、远程插件市场和自动化 RSI 实验编排；当前 Feature 完成后再根据真实证据逐项讨论。
