# Terminal 服务提醒与历史缺口

需求：设计 SSOT 的《我们的流程坏了，不等于 Agent 坏了》与密度 SSOT《服务提醒与结果信息的轻量控件》。原 Terminal state unconfirmed 没有收起入口，多条告示占满终端；本场景检验同一公共展示 owner 的逃生、身份和实际输入。

编译生产 WorkspaceWorkbench、SessionPane、TerminalView、TerminalServiceNotices、TerminalReplayGapNotice、ServiceNoticeDisclosure、实际 xterm 与全部产品 CSS。复用 result-ready fixture 的两个独立 Session、Run、已输入终端文本和两份未发送草稿；只控制 preview API 的 checkpoint/ordered bytes、可复核失败和系统输入桥接，不冒签真实厂商 CLI、真实用户 Run、安装状态或 Native 完整恢复。

640/320 Region 分别观察 attachment、Session observation、reveal、replay geometry、viewport sync、continuation，以及 history gap/read failure 和并发通知。主动打开、X 收起、Escape 退出、重新查看，检查事实和恢复说明没有被删除；同 cause 重复观测/隐藏保留回执、新 cause/new Run/恢复后复发仍可发现。只读 Region 仍可查看和退出，关闭不重绘、不提交输入。

正常与窄工作面中的终端键入使用 Chromium 的可信 Input 事件到产品 sessions.write；详情受自己 Region bounds 限制，终端末行和整个 Composer 草稿保持可见，打开/关闭不换 xterm、不改原 Run/Tab/分割布局。Renderer 场景不代签真实 Runtime 重启，Root 在集成候选另消费 workbench persistence crash proof。

`node apps/desktop/scripts/verify-terminal-service-notice-escape.mjs` 保存精确源/编译输入、完整 PNG、非空 JSX caller、私有块变异 RED/restored GREEN 与仅清理自有 probe 的结果。命令不进行审美打分，完整图交独立 Agent 实际观察；修改后重拍同场景。
