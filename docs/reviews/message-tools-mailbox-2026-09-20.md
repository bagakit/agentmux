# Message Tools 统一邮箱

## 已批准范围

用户 2026-09-20 明确要求“新消息有红点，看过了红点就消失”，排队消息进入“发件列表”，“这两个组件就统一了”。这是此前通知收件箱交付后的新交互闭合：单入口、收件/发件两个视图、看过即已读。用户已授权提交和安装更新。无需额外确认。

## 设计边界

只统一展示与阅读回执，通知事实仍归 Runtime/局部操作、发件事实仍归现有发送队列。删除旧横幅与独立队列浮层，不加第二套持久化队列。保留投递并发与 Run 绑定保护，不扩展成聊天记录或通用通知平台。

## 验收与证据

一个端到端任务验证单邮箱、红点阅读语义、队列动作及忙碌/禁用/窄屏路径；真实 Store + React 行为测试、变异测试、产品调用链和浏览器交互共同证明。测试使用隔离候选路径，避免其他 Browser/Copy Paths 未提交工作影响验收。

## 上轮安装观察

05c08810 已安装，旧桌面退出流程卡在已移除 IPC 后。正常退出和 SIGTERM 未完成；关闭窗口、备份持久数据后只结束旧桌面主进程。独立 ctxmux PID 13458 和 Agent PID 25223 未变，Session、Run、Tab、Region 和布局均恢复。该观察不证明桌面退出挂起的根因已修复。

## 用户追加确认

用户要求邮箱相对固定、靠右和 Agent 图标合成整体组件。此更改仍属于单一邮箱入口的同一闭合，不改变队列、阅读回执或验证边界；T-001 的位置判据随用户明确修正移到右侧。截图缩略图有独立的草稿渲染/引用往返闭合，另建 Feature，不混进邮箱 owner。

## 交付证据

真实组件与输入回归共 161 项通过；队列并发/Run 绑定及非空扫描等补充 52 项通过；desktop typecheck 通过。17 个行为变异全部被捕获，详见 `docs/reviews/evidence/message-tools-mailbox-mutations-20260920.json`。排除定义文件后，SessionMailbox/useSessionNotices 由 AgentSessionComposer 调用，ComposerOutbox 由 SessionMailbox 调用，真实队列动作以 Store/API 行为测试验证。

真实浏览器在内容宽 280/520/960px × 三态共 9 个组合，切换、邮箱、发送均 24px 高，邮箱右侧间距恒为 5px。打开收件通知使红点从有到无、当前通知仍保留；统一发件页显示原顺序与原因。浮层右缘与邮箱右缘同为 x=551，380px 宽且在视口内。截图 `/tmp/message-tools-unified-final.png`。视觉/交互核验使用同一个 TaskSpace 5，已正常关闭。

补充运行的 clipboard-copy 扫描测试有一个已有 TerminalView 转发清单不匹配（候选的该测试及 TerminalView 均未改）；不把它算入通过数。其他并行 Browser/Copy Paths 工作未纳入候选。
