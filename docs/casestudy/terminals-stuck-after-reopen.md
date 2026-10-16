# 重开后 Terminal 无法加载，原进程却仍在运行

## 定性

P0：原 Run 仍在运行，客户端却因无关恢复观察无法交付原终端，触犯健康能力与工作面恢复红线。本案例复盘 Hosted 附着阻断、`fd437cbb11` 的限定修复，以及随后在新建 Agent 消费者证实的同类准入遗漏与 `3f7ef43c0a` 修复；资源占用与其它启动故障仍分别归因。

## 用户可见症状

> 现在 terminals 都加载不出来了, 而 orca 就没这个问题

用户报告的对比用于定位终端交付边界。实际画面已显露终端区域，但内容空白并有服务窗；“界面已揭示”和“原输出已接回”是两个事实。原服务窗包含以下诊断：

> `CTXMUX_CONNECTION_OBSERVATION_FAILED`

公开 Runtime 身份和 Run 元信息可读，多个原 Run 仍是 running；GUI 的部分控制读取却未取得结果。后者与高 CPU、较高内存占用分别保留，不能只凭症状一起出现，就认定它们都由本次分类遗漏导致。

## 影响面

**交付受阻的能力**是 Hosted 路径下原 Agent 与普通 Terminal 的完整附着回执：物理 Attachment 可以建立，Main 仍可能在生成 Session 投影时等待无关语义恢复，因而无法把初始内容交给 Renderer。全局恢复尚未完成和兄弟 Session 的握手已确认失败，均有真实私有链路反例；不是某个站点或 Provider 文案触发的分支。

**以下事实和能力不因这条失败而失效**：Native 的原 Run、进程身份与保留输出继续存在，公开 Runtime 身份／Run 查询仍可用。修复前后的实际安装元信息确认原 Native 与原 Run／PID 保留；[真实附着夹具](../../apps/desktop/test/runtime-membership-cold-host.integration.test.ts) 又核对已知初始输出、后续字节和原握手记录。这些证据不代签所有 Session 的语义状态、所有终端都已读取，或新输入已被 Provider 消费。

原附着恢复后，用户继续反馈“还没法新建 terminal”。实际普通 shell 的公开创建与显示成功，新 Agent 却仍停在原创建界面，尚无确认的 Core Session／Run。两条消费者必须分开核对；新增的真实 Main 创建夹具证实，Agent 创建入口也会等待无关恢复，原附着修复没有覆盖这条链。

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
| `3f7ef43c0a` | `fix(core): create agents without waiting for unrelated recovery`：补齐准确创建、原回执读取与来源授权的既有准入 | 独立验证新建链，并补足冷 fork 准确来源采用；不是附着成功即可代签创建 |

指定分类段的 Git 沿革显示，从 Runtime 分类引入到 `fd437cbb11` 附着修复之前，改过该段的是上述被动诊断分类与冷 Host membership 两项；文件其它方法的改动不等于检查过这一段附着依赖。

## 根因分析

**直接原因**在回执的后置投影。Main 的 `attachSession` 先用 Runtime 准入取得准确 Attachment，再调用 `sessionByTarget` → `runtimeSubject(target, attached.run)`。后者未列入 Runtime 或 offline 分类，Host 于是再次等待完整 `client.connect()`。无关恢复未完成时，已经建立的物理能力无法交付；恢复失败时，该次 attach 又会回滚自己的 reader 并报错，原 Run 仍保留。

**根因是依赖边界只在入口成立，没有覆盖完整交付链。** 评判终端可用时，物理附着成功、membership 可读与最终回执交付被当成了相近结果；一个看似只读的展示投影就重新引入了全局语义准备前提。真正需要的是准确 Run 与原 Session 元数据，而不是所有 Session 的恢复都成功。

**更早的证明没有触达这个等待点。** 修复前的 membership 夹具只读 `RuntimeController.snapshot`，[物理 observation admission 测试](../../packages/core/test/runtime-observation-admission.test.ts)主要消费写入；[Main attach 单测](../../apps/desktop/test/runtime-controller.test.ts)则 mock 了 `runtimeSubject`。它们各自能通过，却没有穿过默认 Desktop connector、真实 Host 分类和最后的 Session 投影。[原附着回归](../../apps/desktop/test/runtime-membership-cold-host.integration.test.ts) 延伸到最终回执后，移除生产分类才明确变红。

**已有规则没有被完整消费者约束住。** [Durable Runtime 健康](../design/behavior/session-recovery.md#durable-runtime-健康) 已要求观察失败不撤销健康通道，但此前证据在首个物理入口或全量投影处结束，没有核对回执的全部必要依赖。修复把原规则落实到真实交付链与承重变异，而不是再加一套健康状态、等待门或恢复调度器。

**附着修复仍漏了独立的新建消费者。** Main `launchAdmittedAgent` 调用 Hosted `createAgentWithDelivery`；SDK 的 `createAgent`、远端目标的 `createHostAgentWithDelivery` 同样未列入 Runtime 分类，于是在进入准确创建 owner 前等待完整 `connect()`。这些入口在引入 Runtime 分类时已存在，不能把遗漏说成后一次附着修复新增的回归。原创建检查与来源 attest 也沿默认全局连接，妨碍未知结果核对和准确授权。修正分类后还须去掉两个隐含前提：prepared 检查自行连接原 Runtime，新的冷 fork 只采用准确原来源，再执行原校验；不能依赖先前全局恢复偷偷填好 registry。

## 改进措施

1. **在原 shared admission owner 修正回执投影分类。** `runtimeSubject` 与原 attach、`runtimeProjection` 使用相同 Runtime 前提；完整依赖边界原位合入既有健康合同，实际分类和链路见 [Terminal Runtime 架构](../architecture/terminal-runtime.md#11-原终端附着与-hosted-准入)。
   - **是否足够 root**：本次确认一处共享分类遗漏，影响 Agent 与 raw Terminal 两类已验证消费者，修复共同 owner。没有把所有只读方法改为 Runtime，也没有宣称扫描了所有语义操作。
   - **能否彻底避免**：正确分类本可阻止本次错误等待；无法保证未来新增的依赖永远分类正确。准确目标元数据缺失、权限不足或真实 Native 不可用仍应由原 owner 如实拒绝或表达未知。
   - **是否降低系统熵**：去掉物理回执对无关全局恢复的依赖，复用既有分类；没有新 API、缓存、schema、fallback、超时或重试层。
2. **把现有回归延伸到原 Main 的最终回执与连续输出。** 保留真实 Native、Host、默认 Desktop connector，覆盖 pending／failed 两阶段和两类原目标。
   - **是否足够 root**：同一条完整交付链验证两个目标、两个阶段，并保留 owner／换 Run 拒绝、reader 清理和原握手记录。新建 Agent 链和全部终端遍历不在这项覆盖内。
   - **能否彻底避免**：承重变异能抓住本次分类回退，帮助更早发现同一交付链断裂；不能代替新依赖或新消费者的真实验证。
   - **是否降低系统熵**：扩展一个现有真实夹具，以全局恢复实际被调用的事件作反例 oracle，避免把机器负载当作业务失败，不增加生产门控。
3. **为新建、原创建检查和来源授权分别闭合真实消费者。** 复用 shared Runtime／offline 分类和原创建 owner，保留意图摘要、权限、Executor revision、prepared seed 与未知首次投递，不扩大为所有 SDK 方法的放行。
   - **是否足够 root**：本地 Main、SDK alias、远端目标、原回执、来源授权与冷 fork 的准确依赖各有消费者；原附着测试保持独立。
   - **能否彻底避免**：七项实际加载生产变异能抓住本次回退，不能保证未覆盖的所有操作或 Provider 原生 fork 都正确。已有回执先读取，新的来源采用与最终检查后执行，不因来源后来变化撤销原回执。
   - **是否降低系统熵**：修正现有 owner 的前提，没有新健康状态、缓存、API、schema、fallback 或重试层。

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

创建修复 `3f7ef43c0a` 的同一真实 Main 夹具共三项通过：新增创建项在 pending／failed 两阶段分别创建一个 Agent 和一个 raw Terminal，核准确 Native／Run／PID、非空初始内容与后续有序字节；重复原 operation 不新增启动或输入，原首次投递未知保持未知。六项 Hosted 定点测试通过。撤销三项创建分类、inspect／attest 分类、prepared 重连与冷 fork 来源采用，共七项实际加载生产变异，均在对应消费者产生语义失败，恢复后通过。生产构建与类型检查通过，测试类型无新增诊断。

相关 Core 套件合计五十一项通过、五项失败；五项失败已用精确基线 `ceddee1ef6` 的原源码和测试实际对照，分别是四项旧 Provider fork 夹具与一项旧消息展示断言。新增冷 fork 用明确 Provider collaborator 保留真实原来源 witness 校验，不代签当前全部 Provider 原生 fork 集成；不能把这批结果描述为 Core 全量测试通过。

## 后续恢复：过期辅助握手扩大为全局失败

用户继续反馈原 Session 无法恢复，提示当前输入游标已前进，而原操作期望从零开始。准确 Native Run 仍为 running，输入开放，已接收字节均已完成；原 Provider-native conversation 身份与来源文件也仍可读。现场没有该新 Run 已观察到原上下文的确认回执，语义恢复完成状态须保持未知。

**零是原输入事务的坐标。** Core 发终端键盘能力握手时，从准确 Run 读取当时的累计输入游标，将原 operation 与字节区间持久保存。重启后这笔事务尚未确认，Run 却已接收后来的输入；Native 在物理写入前拒绝旧坐标，正确保护了后续输入。本次拒绝不能追认旧事务从未写过。终端协议回复也计入物理游标，现场没有完整输入回执可解释每个累计字节，不能将它们全部说成 Prompt 或颜色查询回复。

**失败扩散发生在 Core。** 旧 `ensureTerminalHandshake` 复用未确认 claim 自动重投；非 timeout 错误被完整 `open` 收集并抛为全局连接失败。后续的原生状态与上下文恢复观察尚未完成，另一个 Session 的消费者又等待同一完整 `connect()`。这形成了“观察失败阻断后续恢复观察”的闭环。

`e10cd3cad4` 在原 owner 修正这条边界：过期 claim 不自动重投，原 operation、range 与未确认状态保留；准确失败沿既有 capability 服务窗呈现。新人工输入取得当前 Native 游标，继续经过原授权和输入 fence。新握手的 claim/write 进入已有 Session 输入串行边界，查询观察留在队列之外；辅助 marker 保存失败保留健康 Run 的既有能力及持久性未知。

语义恢复的结果是：同一 durable Session 沿准确 Provider-native conversation 继续原上下文。原进程仍在时，接回同 Run／PTY 可以先完成；原 Run 确认结束或丢失后，请求 Level B 则仍须核对原 native target、Provider、Executor、权限、原操作与持久 prepare/commit。全局依赖判据唯一见[按操作判断强弱依赖](../design/behavior/shared-rules.md#按操作判断强弱依赖)，恢复结果边界归[Durable Runtime 健康](../design/behavior/session-recovery.md#durable-runtime-健康)。

这项修复的证据包括：同 Native／Run／PID 跨真实语义进程重启保留；原输出及新有序输出可读；新输入取得准确 ACK；原 claim 未改写、旧输入未重放；实际输入竞争及目录 sync 返回 ENOSPC 时仍保留健康能力。五条实际编译 Core 变异和三条实际 Renderer 消费变异产生对应业务失败，恢复候选后相关 Core/Main 六十项、UI 三十三项通过。这里的 ENOSPC 是 FileStore 同步调用边界的受控 syscall 错误，真实满卷、OOM 或物理掉电仍需各自的隔离证据；测试 Provider 的 native target 保全也不代签真实 Provider 上下文恢复。

P00 可靠性原则已原位写入[低资源原则](../design/behavior/shared-rules.md#低资源下的正确性与可恢复性)、恢复合同、[拦截判定](../../RED-LINES.md)和[故障验证策略](../testing/strategy.md#隔离资源故障与恢复验证)。已确认持久的原身份、请求和进度是跨极端事件的恢复起点；未知副作用不自动重放。SIGKILL 验证进程崩溃，受控断电验证存储耐久性，两项分别留证。

## 遗留

- **性能归因仍未完成。** Host 高 CPU、Renderer 高内存与交互成本仍需分开归因，已有观察尚不能完成全部因果归因。终端恢复可读不代签整体资源优化、长期稳定性或活跃长历史连续阅读。
- **旧 GUI 的完整即时恢复未确认。** 缺少退出前完整观察，原持久拓扑相等不证明所有焦点、阅读位置或未持久界面状态都相等；安装事务的 unknown 保留。
- **原待创建请求仍须对账。** 普通 shell 与私有 Main 新建分别有证据；原用户请求尚无确认 Run，不能用新的测试目标替代。待创建请求和错误通知仅在 Renderer 内存，完整旧提交参数未持久保全的缺口仍在；先保全可确认正文与身份，缺少原结果、prepared 关联或完整旧 intent 时保持未知，不补造参数或重放首句。
- **覆盖范围有限。** 已验证原 Agent 与 raw Terminal 两类实际消费者，没有逐个遍历所有终端，也没有证明未知 Level B 上下文恢复。Timeline／名称元数据的全体等待仅是独立静态风险，没有本次现场因果证明，不夹入此修复。
