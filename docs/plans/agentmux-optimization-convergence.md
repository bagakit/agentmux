# AgentMux 优化收敛计划

## 决策

所有未完成优化继续使用现有 Feature Tracker DAG。Task 状态、Gate 和 blocker 只存在于 Tracker 的 `tasks.json`；本文只说明 Feature 边界和推进顺序，不建立第二份 backlog。

不创建“全部优化” Mega Feature。不同能力保留独立 Goal、依赖和 Closeout，避免 Desktop polish、Core Runtime、Remote、媒体输入和 Session 恢复互相吞并。

## 已交付，不再重复登记

- Scratch 的 filesystem-backed Topic、Files + Topics、空状态创建入口、紧凑 Topic 索引和目录定位。
- 首屏可复用 Terminal、后台 Agent 发现、Terminal Replay Gap 恢复和磁盘空间恢复。
- Graphite Terminal 主题边界、单行 Pane Tabbar、窄分屏 Tab overflow 和 Tab 内 Region 分屏。
- Composition CLI、生产环境 cancellation 边界、空间恢复和 Agent 启动 readiness。
- Provider executors、Activity timeline 与 managed Agent workspace guide。

这些能力若出现回归，按 defect 修复；不得再以“优化项”身份复制进新 Feature。

## 当前执行面

### Core Maturity

Core Feature 先完成最终 ctxmux candidate 的 Benchmark、Kernel/Package 独立 Review 和 release-blocking finding。之后依次推进：

1. Provider-neutral 的结构化 Agent Message、Thread、Delivery、Ask/Reply 与有界 Inbox；
2. ctxmux public Remote/SSH 合同和 AgentMux 同一 Agent Session/Run API 的远端验证。

Core 保持 Provider、Agent Session、Hook、Permission、Prompt readiness、Agent status 与 semantic resume 的唯一 Owner；不得重新加入自建 Run Kernel、tmux path、Backend Selector 或 wire fallback。

### Desktop Productization

Desktop 的交互和本地打包总验收已经完成。此前资源任务因等待 ctxmux Local cutover 而 blocked；该依赖已经满足，下一任务直接在最终 ctxmux Runtime 上重新测量并收敛：

- App、Framework、resources、Renderer chunk 与 Native artifact 体积；
- Cold Start、Idle、Terminal burst、Editor、Browser 与多轮释放；
- Monaco Model、Document、Watcher、Browser WebContents、Terminal View/xterm、Attachment lease 和全局 subscription 的 Owner 计数；
- Run stop、Attachment release、Renderer close 与 daemon 生命周期的真实收敛。

只优化可复现证据指向的 Owner。禁止强制 GC、卸载仍使用的 Surface、增加全局 Cache 框架、修补已删除 Runtime 路径或引入性能配置层。

## 后续独立 Feature

### Authorized Image Input and Mouse-First Interaction

该 Feature 负责用户授权的图片输入、Artifact/Input 组合、跨层 Receipt 和 Desktop 鼠标优先体验。它依赖稳定 Core 合同，但不依赖 Remote/SSH，也不进入 ctxmux 的 Agent 语义。

### Semantic Session Continuity and Recovery

该 Feature 负责 Agent Session 到当前 Run 的幂等 Continuity、Desktop reopen、retire 和最终 ctxmux Adapter 重验。它不能用 PTY 存活冒充语义连续，也不能由 Desktop 拼接第二份恢复状态机。

## 已知但不扩张的边界

- 长会话 terminal screen proof 的 checkpoint/snapshot 与 Resize 时序仍需在 Core 成熟度工作中形成明确合同；在此之前，Gap 和非连续 byte range 必须失败关闭。
- 正式签名、notarization、多架构和发布是单独 release boundary，不混入当前本地产品化与资源任务。
- Region list/move/close、文件移动、持续文件 Watch 和虚拟列表只有在出现明确用户需求与规模证据后再进入对应 Feature，不为命令对称或预防性抽象建项。

## 推进规则

- 同一时刻每个 Feature 只执行一个 Task；跨 Feature 通过依赖 DAG 排序。
- 任务开始前必须有 reviewed plan、唯一 Workspace 和可执行 Gate。
- 完成代码不等于完成 Feature；每个 Feature 必须经过 documentation、learning、promotion closeout review 后归档或明确 blocked。
- 过期 blocker 在依赖解除后直接替换为当前任务，不保留兼容任务、migration 或 fallback。
- 正式文档只保留当前设计、Owner、非目标和未完成边界，不记录日期、来源清单或已完成任务流水。
