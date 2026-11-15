# AgentMux 文档导航

从任务选择入口，按文档职责找事实。长期约束、当前实现、验证结果和历史证据各有来源；写法及维护规则见 [文档事实与维护规范](guides/document-truth-and-maintenance.md)。

- 查产品约束，从[行为专题](design/agentmux-desktop-interaction.md)或[呈现专题](design/agentmux-surface-density.md)进入。
- 查当前实现、唯一 owner 或源码，从[架构与调用链](#架构与调用链)进入。
- 接入 SDK／RPC 从[公共能力源码入口](specs/public-capabilities.md)开始。按任务使用 CLI，从 [Core 使用指南](../packages/core/guides/README.md)开始。

## 先理解项目

| 要了解什么 | 入口 |
| --- | --- |
| 多层注意力的分层依据、边界与验证 | [多层注意力](design/multi-layer-attention.md) |
| 产品定位、安装与 Core 使用概览 | [项目 README](../README.md)（英文）· [中文版](../README.zh-CN.md) |
| Mote／Work／Know 产品分组、空间模型、Space 入口与实体 | [空间模型与概念](design/behavior/spaces-and-layout.md#空间模型) |
| 伙伴的两条来源、Topic 晋升与内部 Agent 的成长 | [伙伴从哪里来：从 Topic 到 Mote](design/behavior/companions-from-work.md) · [用户故事板](design/presentation/motes-and-coordination.md#伙伴从哪里来用户故事板与教程-banner) |
| 浏览研究与知识积累、创建和继续工作 | [Survey／Recall 工作流](design/behavior/knowledge-workflows.md)（[呈现](design/presentation/knowledge-workflows.md)）、[Launcher 工作起点](design/behavior/workface-launcher.md) |
| 用户数据怎样保存、确认并跨进程恢复 | [用户数据与本地持久化](design/behavior/persistence.md) |
| Capsule 持久页面、隔离／注入模式、HITL 及 Browser／Toolkit 联动 | [Capsule PRD](design/behavior/local-page-hosting.md) · [呈现合同](design/presentation/local-page-hosting.md) |
| Note Markdown、稳定块／引用与独立元数据 | [Note 文件格式与存储](specs/note-markdown.md) |
| Note 中 Agent 与人的协同编辑、并发与历史回滚 | [协同编辑产品要求](design/behavior/knowledge-workflows.md#note-中-agent-与人的协同编辑) |
| Agent 的目标、边界和交付责任 | [AGENTS.md](../AGENTS.md) |
| Core 公共 API、Provider 与 Session | [Core 接入说明](../packages/core/README.md) |
| Agent Hook 为什么保留、怎样隔离配置与更新、各 Provider 的取舍 | [Agent Hook 设计](design/behavior/agent-hooks.md) |
| 分屏树代数 / 目标存储 | [Layout](../packages/layout/README.md)、[Demand](../packages/demand/README.md) |
| 对话视图的目标、场景、交互与产品验收 | [对话视图 PRD](design/behavior/conversation-mode.md) · [呈现 SSOT](design/presentation/conversation-mode.md) |
| 对话记录的字段、关系、分页与覆盖 | [对话公共协议](specs/conversation-protocol.md) |
| amux 信封、业务标记、内容分享与对象链接的格式 | [amux 可读协议 SSOT](specs/amux-protocol.md) |
| Agent 发现、A2A 广播、双向事件、spawn、协作图与通信责任 | [A2A 协作业务 SSOT](design/behavior/a2a-collaboration.md) |
| Composer、邮箱、草稿、队列与持续推进 | [输入与邮箱](design/behavior/conversation-input.md) |
| 共享对话组件、Composer 与客户端平台适配 | [Client UI](../packages/client-ui/README.md) |
| 手机客户端的导航、对话、附件、终端阅读与网页更新行为 | [手机客户端](design/behavior/mobile-client.md)；设备接入与 Relay 连接见[手机版 Relay 连接](design/behavior/public-control.md#手机版-relay-连接) |
| 改手机界面：尺度、控件、文案、状态、动效与采图验收 | [手机客户端的呈现](design/presentation/mobile-client.md) |
| 手机 Web 与既有行为／呈现要求的共用范围、差异和未核实项 | [Mobile 对齐索引](design/agentmux-mobile-alignment.md) |

## 架构与调用链

| 查什么 | 源码机制入口 |
| --- | --- |
| 系统分层、对象身份、空间绑定与导航 | [系统职责总图](architecture/system-ownership.md) · [空间状态与导航机制](architecture/spatial-state.md) |
| 跨设备的身份、路由、分端执行与断连恢复 | [跨设备执行架构](architecture/cross-device-execution.md) |
| Session 恢复与终端 | [Session 恢复模块](architecture/agent-session-recovery.md) · [字节、Attachment 与 viewport](architecture/terminal-runtime.md) · [复制、粘贴、键盘与 IME](architecture/terminal-interaction-layers.md) · [ANSI palette 与 OSC 颜色](architecture/terminal-appearance.md) |
| 对话来源、阅读、输入与外部渠道 | [对话机制总览](architecture/conversation.md) · [Desktop 阅读链](architecture/conversation.md#desktop-阅读链) · [输入与 Mailbox](architecture/conversation.md#输入与-mailbox) · [Connector publication](architecture/conversation.md#connector-publication) |
| 客户端、宿主与更新 | [UI 弹层与原生 Browser](architecture/ui-layering.md) · [原生 Desktop](architecture/native-desktop.md) · [Desktop 更新](architecture/desktop-updates.md) |
| 文件、Git 与 Note | [文件操作、格式扩展、Git 与 worktree](architecture/files-and-git.md) · [Note 编辑与保存对账](architecture/note-editing.md) |
| CPU、内存与卡顿的证据和观测边界 | [性能技术剖面](architecture/performance-diagnostics.md) |

## 按改动定位规则

| 任务 | 唯一规则或机制入口 |
| --- | --- |
| 网络域、节点发布、网关、接入与多跳路径 | [Mesh 网络与接入](design/behavior/mesh.md) · [Mesh 呈现](design/presentation/settings-and-observation.md#mesh-网络工作面) |
| 远程工作的产品需求、运行观察、来源核验与维护流程 | [Remote 管理 PRD](design/behavior/remote-management.md) · [应用账户同步](design/behavior/remote-application-access.md) |
| 从项目开始远程执行、选择两端和继续原工作 | [Core 使用指南](../packages/core/guides/actions/remote-execution.md) · [行为合同](design/behavior/remote-management.md#独立-remote-execution-工作台) · [当前适配范围](../packages/core/README.md#agent-与工具分端执行) |
| 读取所选环境的网络配置、请求耗时与接口地址 | [Host 网络观察](guides/remote-network-observation.md) |
| Dialog、菜单、tooltip 与原生 Browser 的层级 | [共享层级呈现](design/presentation/shared-rules.md#弹层作用域与层级) |
| 开发复用或扩展图标、打开当前目录工作台 | [语义图标开发指南](guides/semantic-icons.md) |
| 品牌结构，或增改 App 图标、大图、插画与 IP 素材 | [品牌架构](design/presentation/brand-identity.md) · [品牌素材指南](guides/brand-assets.md) |
| 文件读写、修订与原子发布、Git 和 worktree 的行为 | [文件、编辑与 Git](design/behavior/files-and-git.md) |
| 接入外部聊天平台：绑定身份、群入口、成员访问、双向交付与凭据 | [外部对话渠道](design/behavior/conversation-channels.md) · [Connection 公共协议](specs/connection-protocol.md) · [连接器包](../packages/connectors/README.md) |
| Agent Session 的启动与恢复阶段 | [Session 恢复行为](design/behavior/session-recovery.md) |
| 并行开发中快速打包、安装、续做和清理 | [macOS 打包指南](guides/macos-packaging.md) |
| 防止流程失败阻断健康能力 | [红线判定](../RED-LINES.md) |
| 原生系统能力的需求与边界 | [AgentMux 原生层](design/behavior/native-desktop.md) |
| 原生层源码、Swift、系统操作与正式安装的验证范围 | [原生层验证](testing/native-desktop.md) |
| 系统／Browser 截图、共享编辑、PNG／贴图及 GIF／长截图评估 | [截图与录制](design/behavior/capture-and-recording.md) · [选区呈现](design/presentation/capture-and-recording.md#系统截图选区) · [标记呈现](design/presentation/browser-workface.md#browser-任务工具与证据的紧凑呈现) |
| 新功能需要哪些 JSON-RPC／CLI、如何接线交付 | [公共能力贡献约定](guides/public-capability-contributions.md) |
| 跨模块观测诊断、证据与错误码、历史/采样接入边界 | [Diagnostic Evidence 设计](design/diagnostic-evidence.md) |
| 模块接入统一证据查询 | [Diagnostic Evidence 协议](specs/diagnostic-evidence-protocol.md) · [接入指南](guides/diagnostic-evidence-integration.md) |
| 任务验证、变异、调用者、假绿防护 | [测试策略](testing/strategy.md) · [从需求到行为场景](testing/product-behavior-validation.md) |
| 运行 opt-in 的真实 Codex lifecycle 测试 | [隔离输入与清理](guides/real-codex-private-lifecycle-test.md) |
| 核对 Codex 原生错误与 AgentMux 的适配范围 | [Codex Provider 错误资料](guides/codex-provider-errors.md) |
| UI 场景采图与独立审美评审 | [视觉验收指南](guides/agent-visual-e2e-review.md) |
| Agent 用 CLI 操作原工作面：委派、打开位置与焦点的选择 | [Delegation and opening playbook](../packages/core/guides/shared/spatial.md#delegation-and-opening-playbook-advisory)；按任务找命令用法见[指南导航](guides/agentmux-cli-object-control.md) |
| 整理具有长期价值的事故案例 | [事故案例写作指南](guides/incident-writing.md) |
| 查看全部设置、管理入口及 GUI/CLI 范围 | [设置目录](settings-catalog.md) |
| 新增设置能力 | [Settings 贡献约定](settings-module-contributions.md) |
| Browser 展示媒体接口与资源 | [ABI](specs/browser-presentation-abi.md)、[资源合同](specs/browser-presentation-resource-contract.md) |

## 当前事实从哪里读取

- 包版本、平台和依赖：各包 `package.json` 与根 `pnpm-lock.yaml`。
- 随包 ctxmux 源码身份、协议、SDK 和二进制：随包 [Darwin manifest](../packages/core/vendor/ctxmux/darwin-arm64/manifest.json) 与 [Linux manifest](../packages/core/vendor/ctxmux/linux-x64/manifest.json)。实际 serving Runtime 身份另由公开 Runtime 事实确认。
- 实现与接线：当前源码及其真实产品消费调用链；源码存在不代表已经安装或通过行为验收。
- 任务状态与 acceptance：官方 `feature-tracker.sh` 读取 `.bagakit/feature-tracker/`；提交、合并和安装事实各按自己的 owner 核对。
- 验证结果：绑定候选、场景、命令和范围的实际 receipt。测试策略描述方法，不是当前候选的通过报告。

## 历史与本机过程资料

[事故复盘](casestudy/) 保留当时的现场、根因和改进动作，每份说明一个可复用的教训：

- [磁盘仍有空间，重启后所有 Session 都无法恢复](casestudy/all-sessions-unrecoverable-with-disk-space.md)：共享持久化的容量、事务分类和原身份恢复的证据边界。
- [一个还活着的 Agent 永远收不到消息了](casestudy/prompt-refused-after-readiness-consumed.md)：内部记账许可没有续期，永久拒绝健康 Run 的输入。
- [新 Agent 的终端退出，原后台却等不到首条输入](casestudy/new-agent-terminal-exits-before-first-input.md)：辅助历史观察与原输入、前台恢复的互锁。
- [重开后 Terminal 无法加载，原进程却仍在运行](casestudy/terminals-stuck-after-reopen.md)：原 Attachment 已取得，回执投影却误等全局恢复；完整调用链的准入与回归边界。
- [后台仍在运行，RPC 却在正常突发中被拒绝](casestudy/rpc-disconnects-during-normal-bursts.md)：人工 ACK 账本、传输背压与连接放大的区别。
- [原页面可读，Browser 呈现仍黑屏](casestudy/browser-presentation-readiness-and-document-identity.md)：资源加载门槛与可变原生 frame 引用的错位，以及怎样保留健康呈现并验证准确文档身份。
- [Performance 合法观察被防御规则误拒](casestudy/performance-valid-observations-rejected.md)：协议包装、叶子预算和管道回压的组合缺口。
- [新建 Agent 与 resume 后终端丢色](casestudy/terminal-colors-lost-after-resume.md)：长寿命 Runtime 的环境继承与显式 unset。
- [Agent 正在执行却显示空闲，改过的名字又变了](casestudy/working-agents-idle-and-names-reset.md)：活动状态投影与显示名写入。
- [新安装包无法启动，随后只显示界面超时](casestudy/packaged-app-could-not-start.md)：preload 外置与签名资格，启动检查须留下真正的首错。
- [安装包更新后黑屏：菜单 Hook 读到空 dispatcher](casestudy/packaged-renderer-duplicate-react-black-screen.md)：Renderer 依赖必须单例。
- [功能已经做过，界面却像没做过：启动了旧 App 包](casestudy/stale-package-feature-disappearance.md)：运行实例与当前源码的身份核对。
- [历史清理改坏引用与候选代码](casestudy/history-hygiene-changes-semantics.md)：隐私扫描越过语义边界的红线事件，区分候选验证故障、审查拒收与尚未证实的线上影响。

[Benchmark 协议](benchmarks/agentmux-daemon-cutover.md) 定义测量方法，历史数值不成为当前预算或排名。

**过程性文档不提交。** 调研、计划、评审、交接、交付清单、状态快照和原型留本机，目录与已有暂存文件的保全规则见[过程资料边界](process-directories.md)。它们帮助追溯，不取代长期设计或官方任务状态。受控仓库中的长期入口应独立可读；本机资料缺席须明确缺证，不把缺席伪装成通过。
