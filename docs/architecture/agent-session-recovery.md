# Agent Session Recovery

`@agentmux/core/agent-session-recovery` 是 Core 内部会话恢复模块的[公开子路径](../../packages/core/src/agent-session-recovery.ts)，随 `@agentmux/core` 发布，不是独立 npm 包，无 Electron、React 或宿主界面依赖。公共 Core 方法与 JSON-RPC／CLI 仍使用原对象和操作入口。行为及状态分支由[Session 启动与恢复阶段](../design/behavior/session-recovery.md#agent-session-启动与恢复的统一阶段)定义，本页只说明机制和依赖。

## 唯一 owner

模块组合原 Session、Run、Provider 身份、原创建／恢复意图与输入回执，决定本次动作，保存副作用前的操作边界并核对结果。[AgentMuxClient](../../packages/core/src/client.ts) 装配现有宿主能力，将恢复公共方法委托给内部 `AgentSessionRecoveryService`。公开子路径导出合同、parser 与纯策略，执行 service 不作为可独立构造的公共 API。

Provider 解释原生初始化、会话创建／恢复及前台连接协议，贡献结构化事实，不决定跨 Session 政策、不重放未知输入。ctxmux 独占进程、Run、PTY 和有序字节；恢复模块只调用其公共能力。持久事实继续在原 Session Store／生命周期记录，输入继续由原输入交付 owner 管理，没有第二套恢复 Store 或 Runtime。

模块通过[原 owner 端口](../../packages/core/src/agent-session-recovery/ports.ts)消费 Session registry／CAS、Runtime、Provider registry、Host executor、Hook、原输入提交／回执及无 UI 的投影发布。Run 转换记账、Hook binding 管理与 Provider 观察登记通过具名能力访问，原可变 Map／Set 留在资源 owner。端口不接收完整 client、动态 Proxy 或把恢复决策回调给 client。普通启动与恢复共享 Provider 初始化能力。

## 模块分工与依赖

| 源码 owner | 职责 |
| --- | --- |
| [continuity-contract.ts](../../packages/core/src/agent-session-recovery/continuity-contract.ts)、[control-contract.ts](../../packages/core/src/agent-session-recovery/control-contract.ts)、[restart-contract.ts](../../packages/core/src/agent-session-recovery/restart-contract.ts)、[resume-contract.ts](../../packages/core/src/agent-session-recovery/resume-contract.ts) | 按领域持有公开类型及相应 parser，供 Store、公共接口与执行层共同消费。 |
| [continuity-policy.ts](../../packages/core/src/agent-session-recovery/continuity-policy.ts) | 消费合同和已给出的事实，计算 admission、continuity decision、提醒与退避；不读取 Store 或执行 Runtime 操作。 |
| [service.ts](../../packages/core/src/agent-session-recovery/service.ts) | 接入公共请求、核对控制回执，装配 supervisor、输入观察、生命周期与对账 owner，并管理恢复模块的释放。 |
| [continuity-attempt.ts](../../packages/core/src/agent-session-recovery/continuity-attempt.ts) | `performAgentContinuity` 执行一次原 operation 的事务：读取原事实、冻结请求和 receipt、应用策略、调用执行或对账能力并记录结果；函数本身不另持跨请求状态。 |
| [lifecycle.ts](../../packages/core/src/agent-session-recovery/lifecycle.ts) | `AgentSessionRunLifecycle` 执行原 Store reservation 对应的启动计划、Run Start／显式 Stop、提交及未收口生命周期的 settlement。 |
| [reconciliation.ts](../../packages/core/src/agent-session-recovery/reconciliation.ts) | `AgentSessionRecoveryReconciler` 核对原初始化、native identity、frontend 与输入交付，守准确 actor／Run／操作栅栏；Runtime 端口仅允许状态读取与身份核对，没有 Run Start、Stop 或 retire 能力。 |
| [interruption.ts](../../packages/core/src/agent-session-recovery/interruption.ts)、[resumed-interruption.ts](../../packages/core/src/agent-session-recovery/resumed-interruption.ts) | 在启动下一个 writer 前检查原生目标的中断状态；只有原生 resume 能细化其冻结的旧 turn。两者都不读取终端文字，不调度、不写输入。 |
| [resume-resolution.ts](../../packages/core/src/agent-session-recovery/resume-resolution.ts)、[executor.ts](../../packages/core/src/agent-session-recovery/executor.ts)、[continuity-activity.ts](../../packages/core/src/agent-session-recovery/continuity-activity.ts) | 分别持有 resume 的安全关联记录（原生退休不声称历史 Start 没有副作用）、恢复所用的 Executor 逻辑选项（不含 RunSpec、生成的凭据或输入载体），以及读取最近活动事实（观察已保留的结束不刷新其年龄）。 |

执行依赖从 `client` 进入 `service`，由单次 attempt 调用 `lifecycle` 和 `reconciliation`；`lifecycle` 也复用同一 reconciler。下层不反向依赖 service 或 client，合同与纯策略不依赖执行 owner。[supervisor.ts](../../packages/core/src/agent-session-recovery/supervisor.ts) 继续持有每个 Session 的串行边界与调度，生命周期共用该串行边界；Run 创建的互斥仍由原 Store reservation 保证。[input.ts](../../packages/core/src/agent-session-recovery/input.ts) 组合和观察恢复输入，通过原 submission owner 投递。

## 原操作与观察

每次动作绑定 Session、expected Run、原 operation、原生目标和准确前台代次。副作用前保留目标与意图；未知回复、观察取消、Core owner 退出不改变原业务身份。Provider 的初始化状态区分权威未创建、准确已确认对象和未知；原生创建尚在途时加入原请求和晚回执，不把请求 ID 当作原生未提供的幂等承诺。

初始化协议可以先确认准确原生 ID，原 Provider 随后再确认同一会话的记录来源。恢复模块在绑定原 ID 后唤醒既有 native discovery；对本次声明初始化能力的 actor，发现流程只补充同一 Provider／ID 尚缺失、且由原进程证明的 locator，已有 ID 和已知 locator 均不能被替换。补充观察仍核原 Run／PID、Provider witness 与 Store CAS；失败保留已确认身份和健康输入，不把缺少记录来源说成原生对象尚未创建。

GUI 与 CLI 仅消费 Core 的原阶段和结果。原 Run 存活只证明物理运行，不能代签前台恢复、原生上下文或输入接受。故障诊断正文可供阅读，但不参与权限、身份、恢复资格或成功判定。

Core 通过[持久 Hook 运行时](../../packages/core/src/managed-hook-runtime.ts)发布受托解释器与 worker。解释器的磁盘动态库须在受托闭包或系统目录内。Linux 内核注入的虚拟动态库由内核映射，直接复用宿主提供的映射。Hook 准备失败只影响对应身份和状态观察，运行中的 Agent 保持可用。

## 持久 Session 与保存确认

Core Session Store 在原 Session 路径使用 SQLite 保存身份与生命周期事实，物理事务和一次格式切换归 [Session database](../../packages/core/src/agent-session-database.ts)。原稳定 inode 的跨进程锁持续保护写入；旧完整文档先校验全部事实、按内容摘要保全原字节，再以已同步事务原子切换，完成身份标记防止后来替换文件被误当作旧事实重新导入。切换中断从原文件或已发布事务重开，不另建空 Session。损坏旧文档的局部救援保持只读，不把部分救回的事实发布为完整转换结果。

Session 元数据与每条未来消息正文分行持久化。Registry 只保留元数据，目录读取不带累计未来正文；准确 Session 读取、元数据 CAS 与单条未来消息读写只访问目标事实。未来消息正文、原 Session／Run 与 occurrence 领取在同一事务内核对，元数据更新不会因未携带正文而删除它。显式 `Store.load()`／完整 CAS 保持完整业务事实合同；普通控制使用名称明确的 metadata／单条／有界分页接口。SQLite 提交及文件、目录同步分别确认；提交结果未知或同步未确认不冒充未发生，也不停止健康 Run，原绑定可重新读取并在同一 owner 确认保存。

Session 元数据与历史贡献可以在一次提交中合并：

- 普通 Tool Hook 由 [`AgentMuxClient`](../../packages/core/src/client.ts) 在 Registry 更新队列中先计算 current→next，再判断这一条历史贡献能否与回执合并。只有不带 outcome、活动边界、待 flush、交互或 continuity 变更的稳态贡献，才调用 Store 接口 `AgentMuxAgentSessionStore`（[agent-session-store.ts](../../packages/core/src/agent-session-store.ts)）的 `compareAndSwapMetadataWithTimeline`；首次 handover 与复杂贡献仍走各自的路径。Registry 复用同一 CAS、身份与 durability owner，Session 与历史的提交结果分别返回。
- File Store（代码名 `AgentMuxFileAgentSessionStore`）在 timeline 顺序、writer 与 SQLite 事务中保存 metadata，用内部 SAVEPOINT 隔离可选的历史。只有 writer 确认 COMMIT 从未尝试、整个事务已回滚、handle 与 lease 已释放时，才允许按同一 expected／next 只做 metadata CAS；COMMIT 结果未知或提交后 sync 失败时不重写。
- Memory Store（代码名 `AgentMuxMemoryAgentSessionStore`）先同步 stage 受影响的 metadata、输入记录与一条历史版本，再修改内存中的 map。
- 必需 metadata 的错误保留真实类型与原因，历史错误只作为辅助明细；仅在准备阶段出现的错误不会把本次回执标为保存未确认。保存承诺见[本地持久化合同](../design/behavior/persistence.md#保存合同)。

## Provider 差异（恢复判定内）

部分 Provider 在第一轮对话前不保存可续接的原生会话：原生 resume 会找不到记录。这是 Provider 的持久化合同；AgentMux 不改写、补造或伪装它的保存。Core 的 [`agentSessionHasNoNativeConversation`](../../packages/core/src/agent-session-recovery/continuity-policy.ts)／[`agentSessionHoldsNativeEvidence`](../../packages/core/src/agent-session-recovery/continuity-policy.ts) 只根据已确认的 Session 保存事实、托管身份通道与 ctxmux 输入计数判定，不推断 Provider 磁盘上保存过什么。[`performAgentContinuity`](../../packages/core/src/agent-session-recovery/continuity-attempt.ts) 在该情形下给出 `native-conversation-absent`，替代自动准入，不代替 supervised／resident 授权检查。用户可见表述见 [Session 恢复](../design/behavior/session-recovery.md)。

终端权限选项由各 Provider 在 detection 配置中声明 `permissionOptions`；[`createNumberedTerminalInteractionProtocol`](../../packages/core/src/agent-interaction.ts) 闭包解析所选 option 的按键，投影到 Renderer 时去掉 `input` 键位。当前声明 `respond` 权限并提供编号权限选项的内置 Provider，只暴露 `allow-once`／`reject-once` 一类选项（见各 Provider 的 `permissionOptions`），不把未声明的 always／其他档位投影到公共权限卡。

## 初始输入与公共消费

原始初始输入在 Runtime Start 之前写入原创建准备记录，绑定实际 Run 后沿原 submission owner 提交；作者、上下文与正文保持原意图。公开 Session 只给出 `creation.initialInputKey`，既有输入 inspection 核对该 key。原始正文和 actor 凭据不进入公开投影，公开 RPC 拒绝私有字段。Native admitted、终端 confirmed、Runtime launch carried 和 unknown 分开保留；Core owner 重启不把 unknown 还原成待发送。

Desktop 收到原 Core 结果才改变恢复呈现。Main 到 preload 传递可序列化的回复封套，Renderer 在本 realm 恢复本地传输来源；业务错误码不能伪造传输丢回复。丢回复后只以相同 Session／Run／operation／输入核对一次，最终决策仍归 Core。
