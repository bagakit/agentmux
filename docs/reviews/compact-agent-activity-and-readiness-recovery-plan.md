# 紧凑 Agent Activity 与 Readiness 恢复计划

Feature: `f-24x8fsvu3`  / `compact-agent-activity-and-readiness-recovery`

## Closure

同一套 AgentMux 工作面中，Activity 能以 Topic / Branch / Worktree 聚合呈现，停止后的 Run 不再被 stale readiness 卡成“仍在运行”，而全局 transient 错误不遮挡内容且可关闭、可回看。Core/ctxmux 仍是 Runtime、Run、Session 和 readiness 的唯一事实来源。

## 评审结论

status: **approved**

依据：用户明确要求按 topic 与 branch 分组、视图更紧凑，并要求修复停止 Agent 仍无法发送及底部错误遮挡、不可关闭的问题；交互与密度合同已同步更新。

## Task 边界

1. readiness stale-state causal fix：权威 Run lifecycle 进入 stopped/exited/done 后失效 pending readiness；错误翻译给出 resume/restart 路径，真实运行中的 not-ready 仍 fail-closed。
2. Activity context grouping projection：从已有 Session、Workspace、Scratch collaborators 派生 Topic / Branch / Worktree 聚合纯函数，接入 Activity 默认紧凑行并保留展开明细。
3. Dismissible non-blocking error surface：为 transient `reportError` 增加 dismiss/reopen 语义，替换底部遮挡式 toast；Service Window 保持持久、无关闭按钮。
4. Integration/regression proof：行为、样式、调用链、变异红绿和受影响桌面测试，证明三条能力都接入生产路径且未削弱 Core readiness 门。
