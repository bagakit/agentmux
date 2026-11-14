# AgentMux 协作入口

本文定义进入仓库时必须遵守的目标、边界和交付责任。专题规则及事实来源从 [文档导航](docs/README.md) 进入；文档修改遵循 [文档事实与维护规范](docs/guides/document-truth-and-maintenance.md)。

## 目标与优先级

1. **通用本地 Agent 核心包优先。** `packages/core` 可独立发布、无 UI 依赖、与宿主框架无关。它以类型安全的公共 API 统一 Agent CLI 的发现、配置、Session、输入输出、状态、权限与语义恢复；新增 Agent 原则上只增加 Provider，不迫使 client 改写交互。持久 Session 与原身份可恢复是项目的 P00 基础，行为合同归[Durable Runtime 健康](docs/design/behavior/session-recovery.md#durable-runtime-健康)；「能启动新进程」或「当前画面正常」都不能当作恢复成功的证明。
2. **编辑器是第一方 client 和参考实现。** Desktop 用真实编辑、终端、工作区、worktree 与多 Agent 流程验证 Core，保持 Agent-first、terminal-first，并达到成熟产品的交互与视觉质量。全部 Agent 生命周期经过 Core 公共 API。

本文的 P00、P0 是产品优先级：P00 是全局底线（见[低资源下的正确性与可恢复性](docs/design/behavior/shared-rules.md#低资源下的正确性与可恢复性)），P0 是必须优先保证的能力。它们不同于复盘用的[事故等级](docs/guides/incident-writing.md#1-定性--事故等级)和评审用的[评审严重度](docs/testing/strategy.md#任务验收与假绿防护)，不互相换算。

## 分层与身份

| 唯一 owner | 持有的事实 |
| --- | --- |
| ctxmux | 通用 Run Runtime：PTY、进程、Run lifecycle、ordered bytes、Replay、Gap、Attachment 与权威 Runtime 状态 |
| AgentMux Core | Provider、AgentSession、Hook、Permission、readiness、语义恢复，以及与前端无关的持久空间身份、拓扑和绑定 |
| Desktop / client | 屏幕呈现、焦点与宿主编辑，文件、Git 和 Browser 能力；消费 Core 给出的位置，并经 Core 操作 Agent |

Core 不得依赖 Electron、React 或编辑器实现；任一侧不得复制另一侧的 Runtime 或语义实现。空间身份与执行身份按 [交互 SSOT《统一概念与空间寻址》](docs/design/behavior/spaces-and-layout.md#统一概念与空间寻址) 区分，移动展示不改变执行 cwd。请求原上下文续接（Level B 语义恢复，定义见 [Durable Runtime 健康](docs/design/behavior/session-recovery.md#durable-runtime-健康)）时，不得暗中降为新建空会话的 Level A 重启。

## 不可破坏的行为

### 健康能力与未知状态

判据是「Agent 还能干活吗」，不是「我们的检查过了吗」。

- Agent、CLI、进程或工作区确实坏了，阻断须如实说明权威事实。
- Agent 健康而握手、探测、校验或记账失败，保留可用能力，给出持续、非阻塞的服务窗：失败步骤、当前运行状态、恢复动作。不得静默降级。
- 已确认完全正常时不打扰。
- 分不清时明确未知，不能猜正常或猜死亡，不能用观察缺口拿走已有能力。错误目标或缺少授权的那一次操作仍应明确拒绝，不能因此关闭健康 Agent。

新增 `throw`、早退、置灰或静默跳过前，执行 [RED-LINES.md](RED-LINES.md) 的判定流程和提交留痕要求。

### 工作面恢复与终端阅读

- 持久 Session 与恢复失效按重大故障处理。修复、更新与资源治理优先保全原身份和可恢复数据，执行与验收沿[Session 恢复](docs/design/behavior/session-recovery.md)，不能以另起空状态、删除原 Session 或绕过真实恢复证明完成。
- 需跨重启保全的用户数据沿[本地持久化合同](docs/design/behavior/persistence.md)明确唯一 owner、确认与恢复入口；草稿、队列和未保存编辑内容纳入同一保全责任。
- 重启、重装或 Runtime 暂不可用后，先恢复 durable 的 Tab、Tab Group、Region、焦点与分割布局。健康 Run 自动接回；已结束或丢失 Run 的恢复时机遵循 [交互 SSOT《冷启动按需恢复》](docs/design/behavior/session-recovery.md#冷启动按需恢复p0-末位)，通过 Core 执行，不要求冷启动批量恢复所有 CLI。
- 空快照、握手超时、探测失败或未释放的 lifecycle lease 都不是删除投影的理由。只有 Core 明确确认 Session 终局事实才允许移除；观测 unknown / unavailable 不冒充终局。失败保留原工作面和服务窗，不伪装成新 Session。
- 活跃终端连续向上阅读与性能是 P0。结果、成本与观测条件唯一见 [交互 SSOT《Terminal 连续向上阅读历史》](docs/design/behavior/terminal-reading.md#terminal-连续向上阅读历史) 和 [密度 SSOT《Terminal 历史阅读的呈现》](docs/design/presentation/terminal-reading.md#terminal-历史阅读的呈现)。另一页可读、局部测试通过或安装成功都不能代替真实活跃会话的连续阅读。
- 热路径工作量须随真正相关的消费者和事实增长，不因无关 Session 放大；验收同时保护正常使用、原工作面和健康 Run。

### 通用机制与 Provider 适配

控制事实指 Agent／Runtime 的输入资格、权限、身份、状态迁移、语义恢复、操作完成和自动动作。它们只以准确对象上的权威 Runtime／Provider 协议事实与真实操作回执为依据。以下内容不能授予、撤销或用来猜测控制事实：

- 给人看的文案、标题、图标、排版、颜色或阅读位置；
- 对这些展示内容的正则匹配或其他识别结果；
- 显示方式的变化——它不得改变已确认的业务能力。

来源或合同缺失时保持未知：守住本次操作的真实目标与授权边界，保留原身份、请求、已有可用能力和恢复路径；不能用观察失败关闭健康 Agent。唯一的例外是稳定机器协议：其文本编码与终端控制序列可以按明确合同解析，但须核对原来源、主体和用途；把展示字符串改称「协议」不构成例外。

Provider 在 Core 内提供基于原生协议的可复用语义能力，Core 组合原对象、权限、意图、回执与恢复判定；工具和客户端消费同一边界，不各造检测器或事实 Store。消息输入的具体责任与高阶输入环境语义归[输入环境判定与复用边界](docs/design/behavior/agent-capabilities-and-messaging.md#输入环境判定与复用边界)，新增拦截仍执行 [RED-LINES](RED-LINES.md#写拦截前回答四个问题)。

Browser、Runtime 与编辑器公共机制按协议和行为泛化；在 Core、Main、设计 SSOT 与公共测试中均不预设具体站点、产品名、按钮文案或厂商协议特例。Provider 在自己的边界内解释原生协议，不能把这些差异泄漏为 client 分支。真实站点仅作黑盒输入；暴露的通用缺陷至少用两种不同协议或触发形态验证。历史背景留在复盘，不成为实现分支或验收条件。

## 实现选择

- 选满足当前需求的最简单实现，不做预防性抽象或多余配置层；组件模块化、关注点分离。
- 先查现有依赖，再考虑新包或自写；优先成熟、有人维护的库及成熟产品已验证的模式。
- 先跑通最小端到端版本，再增加能力；不要为未完成的复杂度拆掉能跑的东西。
- 架构决策面向长期，不接受「先这样以后再换」。过时实现直接删除，不留兼容层、migration 或 fallback；这不授权丢弃用户数据、身份或工作面。

## 需求与验收

需求以 idea 为原点，按以下顺序推进：

1. 有价值的需求、思路或体验反馈先在 `docs/ideas/` 记录，并整合到同一主题；具体写法见[以 idea 为原点记录和整合](docs/guides/document-truth-and-maintenance.md#以-idea-为原点记录和整合)。尚未安排执行也要保留，记录 idea 不自动创建执行任务。
2. 从 `docs/design/agentmux-desktop-interaction.md` 定位 owning 行为专题并原位合入用户确认约束；视觉、密度与控件语言从 `docs/design/agentmux-surface-density.md` 定位 owning 呈现专题。两入口只维护范围和导航；同一约束只定义一次，相邻文档引用，不把聊天过程或实现步骤追加成设计合同。
3. 决定推进执行后、动手改实现前，通过 `feature-tracker.sh` 建或更新同一用户目标的 Feature。新计划使用 `bagakit.feature-task-plan.v1` 与 approved review artifact；每项 Task 有可证伪 acceptance 和 verification command。脚本在已安装的 feature-tracker skill 中查找并使用 `.sh` 入口；路径失效时重新查找，排除 `node_modules/`、`.tmp/` 和 `-adopt-worktree` 副本。

新增功能或修改行为时，作者必须按[公共能力贡献约定](docs/guides/public-capability-contributions.md)在同一计划中判断 JSON-RPC／CLI 的复用、修改或新增，以及受影响的发现、回执与真实消费；无需变更也须说明理由。交付和 review 核对该判断已兑现，不能只完成 GUI 或 help 就将受影响的公共能力标 done。

验收随改动类型成立，不能用一种证据代替另一种：

- 实现任务同时通过变异测试与真实产品调用链检查；未接到产品消费者是竖切未闭合，标 blocked。调用链不以文件边界或符号是否导出判断。具体方法及源码扫描、空集合假绿守护归 [测试策略](docs/testing/strategy.md#任务验收与假绿防护)。
- 视觉改动须由独立 Agent 实际看图评审，修正后复拍，直至明确可交付；采图成功不代替审美通过。流程、复拍与交付前消费意见唯一见[独立 Agent 看图评审](docs/guides/agent-visual-e2e-review.md)。
- 布局或 Session 生命周期改动，须验证真实进程重启后原工作面仍可见且可恢复；热路径另核相关消费者成本。
- 纯文档任务核对来源、链接、冲突和语义保全；不为不存在的实现制造代码调用者或变异通过。夹带实现时仍完整执行对应实现验收。

## 并行协作与交付

并发的目标是在保持质量和品位的同时提高效率。提前判断改动范围与风险，明确可以独立推进的切片和需要谨慎核对的交叠；不以减少验收或牺牲产品品质换取并发速度。协作消息默认中文，代码、命令、标识符与原始证据保留原文。

### 角色

- **协调者**（也称 Root）：负责本轮的目标、优先级、依赖、交付节点、冲突和集成，在交付节点安排实现、评审和验收。方向一致时不逐步催报或重复指挥；只在失配、跑偏、长期不响应或交付节点介入，不以冻结同事强制串行。
- **下属**：由协调者派出的 Agent。用户反馈先由下属按「需求与验收」的顺序记录整合 idea、调研并更新设计 SSOT，决定执行后再登记 Tracker；平时主要承担稳定切片的独立 review、关键行为、回归与性能检查，必要时做明确的小切片。
- **同事**：并行工作的其他 Agent 或人，保有实现自主权。

### Git 提交与冲突

- 过程性文档不提交；调研、计划、评审与任务证据留本机，已有暂存或跟踪内容先保全再移出 Git，边界见[过程资料规则](docs/process-directories.md)。
- 每个提交只承载一个职责；可独立验收的改动分别提交，验收后尽早基于最新 main HEAD 以单亲提交合入，不积攒最终大提交。未合入 main 的改动容易被丢弃，应及时合入。
- 提交、rebase 与合码一律跳过 Git 钩子（`git commit --no-verify`、`git rebase --no-verify`、`git merge --no-verify`），不论钩子是否正常：钩子属于仓库外的本机环境，卡死、交互或等待网络时会让所有 Agent 的提交排队；验收由本文的测试、变异与调用链负责，钩子不能替代。钩子进程卡住时可以结束它；仍有进程持有的 `.git/index.lock` 不手动删除。
- 并发时可能带上他人的提交：先确认影响，完整保全对方工作。发现他人的修改已提交，或自己的提交混入他人的改动，核对影响后继续推进。
- 小修改优先在当前树做小闭环，在符合当前需求的前提下通过结构调整减少冲突；大改动用 worktree，频繁将已验收的完整切片合入 main，合入后及时清理。
- 不得用 stash、切分支或破坏性清场处理冲突，不得要求同事停工或放弃任务来强制串行。

### 打包

开始打包或安装前，先核实是否已有打包负责人；已有负责人时，先与负责人对齐，由负责人统一执行，避免并行打包或安装。

打包前把本批已验收改动集成到 main，从 main 构建完整交付物，并核对源码、编译内容与实际安装包身份。打包只做构建、组装、签名、身份核对和保护用户数据的安装动作，复用任务验收，除用户明确要求外不追加前置检查；交付速度与 CPU、内存、磁盘占用也是打包责任。可复用的结果、何时才补查及具体步骤唯一见 [macOS 打包指南](docs/guides/macos-packaging.md)。

### 清理

每个执行 Agent 对自己创建的 worktree、验收副本、产物和缓存负责：创建前先复用可安全复用的现有结果，避免逐轮复制完整源码、依赖和生成物；消费结束后及时清理不再需要的内容，不把清理留给用户或协调者猜测。交付或交接时说明本次清理结果，以及仍保留对象的路径、用途和待处理原因；协调者核对各切片的收尾，不替代原执行者的责任。

清理前核对准确目录的提交、未提交、未跟踪及忽略内容，并确认运行、工作面和引用状态；保全未保存工作、在用内容、原 Session／Run 恢复数据与必要证据。无法确认时保留并说明未知，不以旧日期或观察失败当作删除依据。过程资料如何保留与回收见[过程资料规则](docs/process-directories.md)；清理不成为安装前置门。
