# 独立窗口告警呈现

运行 `node apps/desktop/scripts/verify-workbench-window-notices.mjs`，加载真实 App、原 Window owner 消费者、共享 ServiceNoticeDisclosure 与产品样式。原返回回执由隔离 API 提供 unknown，主工作面保留真实 Launcher 和未发送草稿。没有用户数据根、安装包或真实 Agent/Run 被控制。

核对窄／矮、正常宽窗、明暗主题：提示收在原24px底栏；出现、查看、展开完整 JSON、阅读后收起都不改变 App 高度和底栏位置；长诊断在独立详情里滚动；收起仍可复查。原 Tab、布局与草稿身份不变，Runtime 操作集合为空。

基线先通过，再用私有编译变异把告警重新插入全局文档流，以及移除当前告警供给；两者必须在真实加载消费者中被断言检出。源码在变异前后保持不变。

行为约束：[工作面的独立窗口](../../../../../docs/design/behavior/spaces-and-layout.md#工作面的独立窗口)。呈现约束：[同主题呈现](../../../../../docs/design/presentation/spaces-and-layout.md#工作面的独立窗口)。主进程和原 Session/Run、跨进程持久恢复由返回链的独立验收承担，本采图不代签。
