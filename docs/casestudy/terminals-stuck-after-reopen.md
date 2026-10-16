# 重开后 Terminal 无法加载，原进程却仍在运行

## 定性

P0：原 Run 仍在运行，客户端却因无关恢复观察无法交付原终端，触犯健康能力与工作面恢复红线。本案例复盘已证实的 Hosted 附着阻断，以及 `fd437cbb11` 的限定修复；它不把资源占用、创建失败或其它启动故障归为同一根因。

## 用户可见症状

> 现在 terminals 都加载不出来了, 而 orca 就没这个问题

用户报告的对比用于定位终端交付边界。实际画面已显露终端区域，但内容空白并有服务窗；“界面已揭示”和“原输出已接回”是两个事实。原服务窗包含以下诊断：

> `CTXMUX_CONNECTION_OBSERVATION_FAILED`

公开 Runtime 身份和 Run 元信息可读，多个原 Run 仍是 running；GUI 的部分控制读取却未取得结果。后者与高 CPU、较高内存占用分别保留，不能只凭症状一起出现，就认定它们都由本次分类遗漏导致。

## 影响面

**交付受阻的能力**是 Hosted 路径下原 Agent 与普通 Terminal 的完整附着回执：物理 Attachment 可以建立，Main 仍可能在生成 Session 投影时等待无关语义恢复，因而无法把初始内容交给 Renderer。全局恢复尚未完成和兄弟 Session 的握手已确认失败，均有真实私有链路反例；不是某个站点或 Provider 文案触发的分支。

**以下事实和能力不因这条失败而失效**：Native 的原 Run、进程身份与保留输出继续存在，公开 Runtime 身份／Run 查询仍可用。修复前后的实际安装元信息确认原 Native 与原 Run／PID 保留；[真实附着夹具](../../apps/desktop/test/runtime-membership-cold-host.integration.test.ts) 又核对已知初始输出、后续字节和原握手记录。这些证据不代签所有 Session 的语义状态、所有终端都已读取，或新输入已被 Provider 消费。

## 止血措施

旧分类下没有已验证的带内动作能够绕过错误等待。实际脱困采用包含修复的应用与语义 Host，重新打开界面，保留原 Native、Session、Run 与工作面。旧 GUI 的保存未确认且正常退出失败，本次在用户明确同意后只结束卡住的 Renderer，再让 Main 退出。不能为恢复画面停止 Native 或原 Run，也不能换新 Session、补造握手 ACK 或重放未知输入。

这次 UI-only 更新后，实际原 Agent 与 raw Terminal 在同一工作面显示真实内容，原 Run／PID 保留，产品观察为 visible、liveReady、acceptsInput。旧 GUI 缺少完整退出前观察，安装事务仍保留 UI recovery unknown；不能把当前可用改写为所有旧即时状态已确认相等。

## 引入沿革

以下按提交顺序记录，来源是 Git；为避免暴露事件元数据，仅保留 SHA 与 message。可从仓库根核对：

```sh
git log --format='%h %s' -S runtimeSubject -- packages/core/src/hosted-client-contract.ts
git log --format='%h %s' -L '/^export const AGENTMUX_HOSTED_RUNTIME_METHODS/,+8:packages/core/src/hosted-client-contract.ts'
git log --follow --format='%h %s' -- packages/core/src/hosted-client-contract.ts
```

| 提交 | message 与该段变化 | 为什么没有覆盖本缺口 |
| --- | --- | --- |
| `a1c94fec4a` | `feat(core): share hosted RPC and browser HTTP transport`：shared Hosted 方法表已有 `runtimeSubject` | 说明该方法先于独立 Runtime 分类存在，遗漏不能归给后来的 membership 修复 |
| `15bc64a45f` | `fix(core): keep exact control independent of observation leases`：引入 `AGENTMUX_HOSTED_RUNTIME_METHODS`，包含 attach 等物理方法，遗漏 `runtimeSubject` | 准入已区分物理操作与观察，但附着后回执投影仍落到完整 `connect()`；缺口从该分类引入时存在 |
| `0046c02b11` | `feat(remote): expose passive Host runtime observations in Settings and CLI`：将两个被动 Runtime 诊断移入 offline 分类 | 改善诊断观察的前提，没有覆盖附着后的 Session 投影 |
| `4cae4223c5` | `fix(runtime): restore cold Host membership independently of recovery`：加入 `runtimeProjection`，让冷 Host 的原绑定可先投影 | 解决全量 membership 的前一步，回归没有消费 `attachSession` 的最终回执，因此仍留下 `sessionByTarget` 的等待 |
| `fd437cbb11` | `fix(core): attach original terminals without waiting for unrelated recovery`：将 `runtimeSubject` 加入同一 shared Runtime 分类 | 把原 Agent／raw Terminal 的真实 Main 附着回执和后续输出接入同一回归 |

指定分类段的 Git 沿革显示，从引入到本修复之间，改过该段的是上述被动诊断分类与冷 Host membership 两项；文件其它方法的改动不等于检查过这一段附着依赖。

## 根因分析

**直接原因**在回执的后置投影。Main 的 `attachSession` 先用 Runtime 准入取得准确 Attachment，再调用 `sessionByTarget` → `runtimeSubject(target, attached.run)`。后者未列入 Runtime 或 offline 分类，Host 于是再次等待完整 `client.connect()`。无关恢复未完成时，已经建立的物理能力无法交付；恢复失败时，该次 attach 又会回滚自己的 reader 并报错，原 Run 仍保留。

**根因是依赖边界只在入口成立，没有覆盖完整交付链。** 评判终端可用时，物理附着成功、membership 可读与最终回执交付被当成了相近结果；一个看似只读的展示投影就重新引入了全局语义准备前提。真正需要的是准确 Run 与原 Session 元数据，而不是所有 Session 的恢复都成功。

**更早的证明没有触达这个等待点。** 修复前的 membership 夹具只读 `RuntimeController.snapshot`，[物理 observation admission 测试](../../packages/core/test/runtime-observation-admission.test.ts)主要消费写入；[Main attach 单测](../../apps/desktop/test/runtime-controller.test.ts)则 mock 了 `runtimeSubject`。它们各自能通过，却没有穿过默认 Desktop connector、真实 Host 分类和最后的 Session 投影。[原附着回归](../../apps/desktop/test/runtime-membership-cold-host.integration.test.ts) 延伸到最终回执后，移除生产分类才明确变红。

**已有规则没有被完整消费者约束住。** [Durable Runtime 健康](../design/behavior/session-recovery.md#durable-runtime-健康) 已要求观察失败不撤销健康通道，但此前证据在首个物理入口或全量投影处结束，没有核对回执的全部必要依赖。修复把原规则落实到真实交付链与承重变异，而不是再加一套健康状态、等待门或恢复调度器。

## 改进措施

1. **在原 shared admission owner 修正回执投影分类。** `runtimeSubject` 与原 attach、`runtimeProjection` 使用相同 Runtime 前提；完整依赖边界原位合入既有健康合同，实际分类和链路见 [Terminal Runtime 架构](../architecture/terminal-runtime.md#11-原终端附着与-hosted-准入)。
   - **是否足够 root**：本次确认一处共享分类遗漏，影响 Agent 与 raw Terminal 两类已验证消费者，修复共同 owner。没有把所有只读方法改为 Runtime，也没有宣称扫描了所有语义操作。
   - **能否彻底避免**：正确分类本可阻止本次错误等待；无法保证未来新增的依赖永远分类正确。准确目标元数据缺失、权限不足或真实 Native 不可用仍应由原 owner 如实拒绝或表达未知。
   - **是否降低系统熵**：去掉物理回执对无关全局恢复的依赖，复用既有分类；没有新 API、缓存、schema、fallback、超时或重试层。
2. **把现有回归延伸到原 Main 的最终回执与连续输出。** 保留真实 Native、Host、默认 Desktop connector，覆盖 pending／failed 两阶段和两类原目标。
   - **是否足够 root**：同一条完整交付链验证两个目标、两个阶段，并保留 owner／换 Run 拒绝、reader 清理和原握手记录。新建 Agent 链和全部终端遍历不在这项覆盖内。
   - **能否彻底避免**：承重变异能抓住本次分类回退，帮助更早发现同一交付链断裂；不能代替新依赖或新消费者的真实验证。
   - **是否降低系统熵**：扩展一个现有真实夹具，以全局恢复实际被调用的事件作反例 oracle，避免把机器负载当作业务失败，不增加生产门控。

## 验证

本修复的历史证据绑定 `fd437cbb11`。正式夹具的两项测试通过；仅从实际加载的生产 shared Runtime 分类移除 `runtimeSubject` 后，两项中附着测试明确失败，另一项通过；恢复原候选后两项重新通过。失败是 `unrelatedRecovery` 事件先于 attach 回执到达，断言为“原 Main 附着不得等待无关 Session 恢复”，不是模块加载错误、空集合或机器负载超时。

从仓库根可复核现有私有夹具；夹具还会清除其余 `AGENTMUX_`／`CTXMUX_` 环境继承，自建 Native、存储和私有子进程：

```sh
pnpm --filter '@agentmux/core...' build
env -u AGENTMUX_AGENT_SESSION_STORE -u AGENTMUX_RUNTIME_DIRECTORY -u AGENTMUX_STATE_DIRECTORY \
  pnpm exec vitest run apps/desktop/test/runtime-membership-cold-host.integration.test.ts
```

变异作用于 [shared contract](../../packages/core/src/hosted-client-contract.ts) 的实际 Runtime 分类，保持测试不变并恢复源码后再跑同一命令；不能删除一般方法声明来制造导入失败。该命令只运行夹具，不自动施加变异，也不操作用户 Run。具体断言与生产入口在 [真实测试源码](../../apps/desktop/test/runtime-membership-cold-host.integration.test.ts)、[Main attachSession](../../apps/desktop/src/main/runtime-controller.ts) 和 [Host admission](../../packages/core/src/hosted-runtime-service.ts)。

夹具从准确目标的真实 stdout 取得已知初始 marker，再检查 Main 收到的新 marker 与连续 output byte range；原 Native、Run、PID 和握手记录保留，无兄弟输入重放或新 Run。每个 reader 释放后确认真实 Attachment 消失，错误 Host fence 与不匹配 Run 继续拒绝。完整字节链和这些拒绝证明改进措施一、二的行为，测试方法沿 [任务验收与假绿防护](../testing/strategy.md#任务验收与假绿防护)。

实际 clean App 安装后，公开 `space.inspect` 确认原 Agent 与 raw Terminal 的准确 Region／Run，二者可见、liveReady、acceptsInput；独立看图确认同屏真实内容可读。原 Native、Run／PID、持久 Session、Tab／Region 和 Core 布局保留。GUI 观察与原身份核对分别成立，不把截图当作新输入已被消费或完整旧焦点相等的证明。原始 receipt 与截图保留本机，本文不复制身份、机器信息或终端正文。

## 遗留

- **性能归因仍未完成。** Host 高 CPU、Renderer 高内存与交互成本仍需分开归因，已有观察尚不能完成全部因果归因。终端恢复可读不代签整体资源优化、长期稳定性或活跃长历史连续阅读。
- **旧 GUI 的完整即时恢复未确认。** 缺少退出前完整观察，原持久拓扑相等不证明所有焦点、阅读位置或未持久界面状态都相等；安装事务的 unknown 保留。
- **新建能力另查。** 用户随后反馈“还没法新建terminal”。普通 shell 已有真实 `terminal.open` 成功及可见性证明；新的 Agent 创建尚未确认 Run，原创建操作与未知结果继续保留。其是否受语义准备阻塞仍待完整因果验证（PARTIAL），不能把原终端 attach 修复称为所有创建链已解决。
- **覆盖范围有限。** 已验证原 Agent 与 raw Terminal 两类实际消费者，没有逐个遍历所有终端，也没有证明未知 Level B 上下文恢复。Timeline／名称元数据的全体等待仅是独立静态风险，没有本次现场因果证明，不夹入此修复。
