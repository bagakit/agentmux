# 本轮追加需求与验收修正

用户明确要求继续执行 f-24v8fec2k，并追加输入区布局、左侧菜单与状态图标、浏览器分屏/Tab 打开位置（参考 Refproj）、pending interaction 过度防御排查和 Steer（参考 Refpeer）、Branch recap、Region 快捷键冲突、当前 Agent context 剩余监控。按用户指定保留在同一 Feature；不以仅记录文档代替交付。

原 T-001 的 gate 调用 Desktop 不存在的 test script，且没有布局测量或变异证据，其历史 done 不证明交付。T-009 重新完成并验证这条能力。所有新 gate 用 exec vitest run 指定实际测试；缺测试文件必须失败。原本地预览需求遗漏任务，补 T-006。新增需求均来自用户明确请求，review approved；具体实现由执行者在这些边界内决定。

Context 只使用 Provider 报告的当前上下文和容量，区分累计计费用量；缺数据显示未知，显示采样时刻，压缩后允许占用下降。浏览器新页面由源 Region 归属路由，无独立弹窗；右键复用打开位置选择。快捷键只消费所属作用域，未匹配原样交给 TUI。

## T-004 验证

Core build、Desktop typecheck 通过。`pnpm exec vitest run apps/desktop/test/agent-context-usage.test.tsx apps/desktop/test/agent-session-composer.test.tsx packages/core/test/agent-usage-transcript.test.ts packages/core/test/agent-usage-capability.test.ts`：43/43。

变异分别移除 `nativeContext` 提取调用及 AgentSessionComposer 的 `contextUsage` 绑定，对应测试变红；恢复后 43/43。排除定义文件后：`parseTurnUsage` 被 hook-normalizer 消费；AgentContextUsage 被 AgentSessionComposer 消费；AgentSessionComposer 被 SessionPane 消费。持久化往返已覆盖。实测当前 Codex transcript 有 `last_token_usage` 和 `model_context_window`；只读取这些数值，不记录会话正文。

限制：当前观测沿收尾 hook 更新，界面标注最近原生观测及时间，非逐秒监控。尚未安装到活动应用。

## 交付等待边

T-010 是所有能力完成后的最终候选验证、提交与安装 join；保留各实现任务依赖。实现期间各自做增量验证，不把测试准备拖到 join 后；候选变化时最终 join 重新运行。
