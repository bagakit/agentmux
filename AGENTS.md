# AgentMux 协作入口

本文定义进入仓库时必须遵守的目标、边界和交付责任。专题规则及事实来源从 [文档导航](docs/README.md) 进入；文档修改遵循 [文档事实与维护规范](docs/guides/document-truth-and-maintenance.md)。

## 目标与优先级

1. **通用本地 Agent 核心包优先。** `packages/core` 可独立发布、无 UI 依赖、与宿主框架无关。它以类型安全的公共 API 统一 Agent CLI 的发现、配置、Session、输入输出、状态、权限与语义恢复；新增 Agent 原则上只增加 Provider，不迫使 client 改写交互。
2. **编辑器是第一方 client 和参考实现。** Desktop 用真实编辑、终端、工作区、worktree 与多 Agent 流程验证 Core，保持 Agent-first、terminal-first，并达到成熟产品的交互与视觉质量。全部 Agent 生命周期经过 Core 公共 API。

## 分层与身份

| 唯一 owner | 持有的事实 |
| --- | --- |
| ctxmux | 通用 Run Runtime：PTY、进程、Run lifecycle、ordered bytes、Replay、Gap、Attachment 与权威 Runtime 状态 |
| AgentMux Core | Provider, AgentSession, Hook, Permission, readiness, semantic recovery, and frontend-independent durable spatial identities, topology and bindings |
| Desktop / client | Screen presentation, focus and host editing, files, Git and Browser capabilities; consumes Core positions and operates Agents through Core |

Core 不得依赖 Electron、React 或编辑器实现；任一侧不得复制另一侧的 Runtime 或语义实现。空间身份与执行身份按 [交互 SSOT《统一概念与空间寻址》](docs/design/behavior/spaces-and-layout.md#统一概念与空间寻址) 区分，移动展示不改变执行 cwd。请求 Level B 语义恢复时，不得暗中降为 Level A 重启。

## 不可破坏的行为

### 健康能力与未知状态

判据是「Agent 还能干活吗」，不是「我们的检查过了吗」。

- Agent、CLI、进程或工作区确实坏了，阻断须如实说明权威事实。
- Agent 健康而握手、探测、校验或记账失败，保留可用能力，给出持续、非阻塞的服务窗：失败步骤、当前运行状态、恢复动作。不得静默降级。
- 已确认完全正常时不打扰。
- 分不清时明确未知，不能猜正常或猜死亡，不能用观察缺口拿走已有能力。错误目标或缺少授权的那一次操作仍应明确拒绝，不能因此关闭健康 Agent。

新增 `throw`、早退、置灰或静默跳过前，执行 [RED-LINES.md](RED-LINES.md) 的判定流程和提交留痕要求。

### 工作面恢复与终端阅读

- 重启、重装或 Runtime 暂不可用后，先恢复 durable 的 Tab、Tab Group、Region、焦点与分割布局。健康 Run 自动接回；已结束或丢失 Run 的恢复时机遵循 [交互 SSOT《冷启动按需恢复》](docs/design/behavior/session-recovery.md#冷启动按需恢复p0-末位)，通过 Core 执行，不要求冷启动批量恢复所有 CLI。
- 空快照、握手超时、探测失败或未释放的 lifecycle lease 都不是删除投影的理由。只有 Core 明确确认 Session 终局事实才允许移除；观测 unknown / unavailable 不冒充终局。失败保留原工作面和服务窗，不伪装成新 Session。
- 活跃终端连续向上阅读与性能是 P0。结果、成本与观测条件唯一见 [交互 SSOT《Terminal 连续向上阅读历史》](docs/design/behavior/terminal-reading.md#terminal-连续向上阅读历史) 和密度 SSOT 对应章节。另一页可读、局部测试通过或安装成功都不能代替真实活跃会话的连续阅读。
- 热路径工作量须随真正相关的消费者和事实增长，不因无关 Session 放大；验收同时保护正常使用、原工作面和健康 Run。

### 通用机制与 Provider 适配

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
3. 决定推进执行后、动手改实现前，通过 `feature-tracker.sh` 建或更新同 Closure 的 Feature。新计划使用 `bagakit.feature-task-plan.v1` 与 approved review artifact；每项 Task 有可证伪 acceptance 和 verification command。脚本从已安装的 feature-tracker skill 定位，走 `.sh`；路径失效时重新查找，排除 `node_modules/`、`.tmp/` 和 `-adopt-worktree` 副本。

新增功能或修改行为时，作者必须按[公共能力贡献约定](docs/guides/public-capability-contributions.md)在同一计划中判断 JSON-RPC／CLI 的复用、修改或新增，以及受影响的发现、回执与真实消费；无需变更也须说明理由。交付和 review 核对该判断已兑现，不能只完成 GUI 或 help 就将受影响的公共能力标 done。

验收随改动类型成立，不能用一种证据代替另一种：

- 实现任务同时通过变异测试与定义文件外的生产调用者检查；缺调用者是竖切未闭合，标 blocked。具体方法及源码扫描、空集合假绿守护归 [测试策略](docs/testing/strategy.md#任务验收与假绿防护)。
- 视觉改动按 [独立 Agent 看图评审](docs/guides/agent-visual-e2e-review.md) 实际操作、采图、独立评审；修正后复拍复验至明确可交付。打包或更新 Renderer 消费本批结论，采图成功不代替审美通过。
- 布局或 Session 生命周期改动，须验证真实进程重启后原工作面仍可见且可恢复；热路径另核相关消费者成本。
- 纯文档任务核对来源、链接、冲突和语义保全；不为不存在的实现制造代码调用者或变异通过。夹带实现时仍完整执行对应实现验收。

## 并行协作与交付

- 协作消息默认中文，代码、命令、标识符与原始证据保留原文。用户反馈由下属先记录整合 idea、调研并更新设计 SSOT；决定执行后再登记 Tracker，Root 在交付节点安排实现、评审和验收。
- 协调者管理目标、优先级、依赖、交付节点、冲突和集成；同事保有实现自主权。下属主要承担稳定切片的独立 review、关键行为、回归与性能检查，必要时做明确小切片。方向一致时不逐步催报或重复指挥；只在失配、跑偏、长期不响应或交付节点介入，不以冻结同事强制串行。
- 过程性文档不提交；调研、计划、评审与任务证据留本机，已有暂存或跟踪内容先保全再移出 Git，边界见[过程资料规则](docs/process-directories.md)。
- 并发可带上他人的提交，先确认影响，完整保全工作。小修改在当前树闭环；大改动用 worktree，频繁将已验收完整切片合入 main。不得用 stash、切分支或破坏性清场处理冲突。
- 打包前将本批已验收改动集成 main，从 main 构建完整交付物，核对源码、编译内容与实际安装包身份。及时合入 main, 未合入 main 的改动容易被丢弃。
- 打包安装只做构建、组装、签名、身份核对及保护用户数据的安装动作，复用任务验收。除用户明确要求，不把全量回归、功能 E2E、重复图审、多轮全文件比对、无关验收或等待后续提交加成前置条件。
- 合码、打包和收尾后清理不用的产物、缓存、临时 worktree 与副本。先核对提交、未提交和未跟踪内容，保全未保存工作、在用内容与必要证据；清理不成为安装前置门。
