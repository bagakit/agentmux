# Message Tool 可读诊断场景

行为和呈现按 [Message Tool 等待与失败说明](../../../../../docs/design/presentation/agent-capabilities-and-messaging.md#message-tool-的等待与失败说明) 和[原 Prompt 投递凭据](../../../../../docs/design/behavior/agent-capabilities-and-messaging.md#跨重启的-prompt-投递凭据)。

本入口实际挂载 `WorkspaceWorkbench → SessionPane → AgentSessionComposer → SessionMailbox → ComposerOutbox` 与产品 CSS。在每格约 640px 的正常双分屏、320px 的窄双分屏中，键盘打开 Mailbox 的 Outbox，选择原失败消息；查看简洁原因、状态和下一步，再打开技术详情，执行完整诊断复制失败、重试与成功，并保留原草稿与邻侧工作面。覆盖本次准备失败、原操作结果未知、旧通用失败、正在整理上下文的退避等待与尝试耗尽；另覆盖没有旧 error/log 的首次等待，确保只有一段进度且不造失败面板。

`--only=observer` 覆盖 Core 已保存输入、原观察结束且需明确 rejoin 的回执：外层与诊断区同为“已保存 · 等待确认”，不把观察 Abort 当成输入未知；完整复制保留原 key/ref、control、admission 和原错误。该回执由 fixture 在原 Store 边界提供，采图不证明 Native 已接纳或 RPC 生命周期修复。

fixture 仅在 preview API、既有诊断 journal 与 queue store 边界提供已知事实，不制造第二个 owner，不调用真实提交/重试/取消，不操作用户 Session/Run；复制流过产品 clipboard helper 到私有 sink。采图证明真实 Renderer 消费与阅读、键盘/剪贴板结果，不能代签 Core 重试、真实 CLI、安装或整个产品。编译输入身份、截图、操作和诊断原文保存在本轮 capture 目录，独立 Agent 实际打开截图再判断审美通过。

```sh
node apps/desktop/scripts/capture-message-delivery-diagnostics.mjs
```
