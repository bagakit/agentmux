# 输入框图片缩略图

用户 2026-09-20 明确反馈截图在输入框里没有缩略图，授权修复。复核现有实现：截图/粘贴已持久保存图片并写入草稿引用，ConversationImage 已能经受限 IPC 读取同一图片与放大；缺口是 InlineComposer 只把 skill/component/subcommand 识别成节点，图片引用仍是普通文本。

复用已有图片引用识别、读取 IPC 和图片组件；ProseMirror 节点负责输入、选择、删除与撤销，草稿字符串仍是同一文件路径，不新增附件 Store 或第二份图片内容。Session 与 Launcher 通过同一 InlineComposer 接入。验收包括真实 capture/paste → 草稿缩略图 → 提交路径保真、重挂载与删除撤销、加载失败保留引用，以及行为变异和产品调用者检查。

## 交付证据

实际 capture/paste → 受限读取 → React NodeView 缩略图 → 大图 → 同一路径发送已用真实 Store/输入组件验证；图片复制序列化、删除/undo、重挂载和读取失败保文均通过。Launcher 共用 InlineComposer，真实键盘事件证明 IME 确认不启动、Ctrl+Enter 仍启动，并传递当前草稿。图像引用保持绝对路径，工作区即使包含 pasted 目录也不会丢失缩略图识别。

浏览器实际显示图片节点并成功打开图片 Dialog；一行态缩略图 16px 高，其他形态 48px 高，三态工具行仍均 24px。图片节点建立、引用序列化、Session/Launcher 读取接线、读取路径等 5 个图像变异均红；与邮箱的变异记录一并保存在 `docs/reviews/evidence/message-tools-mailbox-mutations-20260920.json`。产品链为 Session/Launcher → InlineComposer → 已有 ConversationImage → 已有 readPastedImage IPC，没有附件内容 Store 或新的文件协议。
