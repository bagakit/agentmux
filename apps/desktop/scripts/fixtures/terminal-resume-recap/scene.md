# Terminal resume recap 实际场景

约束唯一见交互 SSOT《Terminal resume 画面中的 recap》与密度 SSOT《Terminal resume 的 recap 密度》。独立看图流程见 `docs/guides/agent-visual-e2e-review.md`。

`verify-terminal-resume-recap.mjs --slice scene` 启动同源普通编译 Main、preload 和 Renderer，使用私有 home、userData、workspace、Core FileStore 和真实 ctxmux daemon。健康邻 Region 由真实 `/bin/cat` 接收输入；待恢复 Session 使用已有 fake CLI 的原生 Hook、经公共 FileStore 保存的合成助手回复。只有私有目标 Run 被停下；不进入用户 Runtime，也不生成模型摘要或代表真实厂商会话。

通过实际 workspace、New Tab、公共 `agent.open`／`agent.view`／`focus` 与真实按钮进入场景；通过 ProseMirror 的实际可编辑输入保存未发送草稿。依次采集正常双分屏、窄短双分屏的长 recap、无可读来源、普通进程退出再启动、真实 Resume 进行中五幅完整 GUI 图。私有 CLI 在 resume 启动时延迟三秒，使真实进行中按钮和原 recap 可见，不改写产品阶段或 IPC 回包。

核对原布局、焦点、Tab／Region、未发送草稿和来源；健康邻 Run 保持同一 PID，每次有真实输入 ACK 与非空输出 Replay。源文件、普通编译物、实际已加载 Renderer 字节与 PNG SHA 绑定在 `.tmp/terminal-resume-recap/scene.json`；所有私有 owned 进程退出后才清理其目录。receipt 的 `captureOnly` 表明截图尚未完成审美判断。

独立 Agent 实际打开全部图，检查恢复标题和 Resume 动作是否优先、摘要来源是否清楚、正常和窄短宽度下是否可读、长文是否过重。报告保留具体意见与未知范围，不能以 DOM、像素阈值或采集命令成功替代判断。报告及精确图片身份写在同目录 `review.json`，`--slice review` 只读验证该报告与当前候选，任何代码、编译物或图片变化均使旧评审失效。
