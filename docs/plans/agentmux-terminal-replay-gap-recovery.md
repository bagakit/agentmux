# 终端 Replay Gap 恢复

## 问题

AgentMux 关闭或 Renderer 重启后，内存里的终端画面会消失。重新打开会话时，
Desktop 只能读取 ctxmux 保留的最后一段原始输出。如果更早的输出已经被淘汰，
这段输出可能从 TUI 的半次刷新开始，无法独立还原屏幕，用户就会看到黑屏或残缺画面。

## 目标

- 正在运行的 TUI 出现 Replay Gap 时，自动请求一次真实的终端重绘，恢复当前可用画面。
- 较早的滚动记录已经丢失时，如实提示，但提示不能混进终端字节后又被 TUI 清掉。
- 自动重绘没有解决时，用户可以直接点一次“重新绘制”，不用重启或丢掉当前 Session。
- 已结束的历史 Run 只展示仍然保留的内容和缺失提示，绝不向它发送 Resize 或输入。

## 交互

- 没有 Replay Gap 时，终端打开方式不变。
- 正在运行的 Run 有 Gap 时，终端先回放保留内容，再由现有 Viewport Owner 把 PTY
  临时减少一行并恢复最终尺寸。多数 TUI 会因此输出一张完整的新画面。
- Gap 提示显示在终端上方的小浮层中：`较早的滚动记录不可用`。正在运行的 Run 同时
  提供 `重新绘制` 按钮；历史 Run 不显示这个按钮。
- 重绘只改变一次临时尺寸并立刻恢复，不发送字符、不创建新 Run、不 Resume Session。

## 分层

- ctxmux 继续唯一持有 PTY、Run 和有界原始 Replay；本 Feature 不修改 Replay 上限。
- Core 和 Main 继续原样传递明确的 Gap 事实，不伪造完整历史。
- Renderer 的 `TerminalViewportSynchronizer` 是 Fit 和 PTY Resize 的唯一 Owner，自动重绘
  和手动重绘都走这条路径，不能从组件旁路 Resize。

## 不做

- 不把 Replay 改成无限增长，也不靠增大缓存掩盖问题。
- 不新增守护进程、第二套 PTY Owner、兼容层或后台 Session。
- 不声称恢复已经被淘汰的滚动记录。
- 不用自动 Relaunch 或 Resume 替代同一个 Run 的屏幕重绘。

## 验收

- Running Run 的 Gap 恢复会按顺序提交“临时尺寸 → 最终尺寸”，最终尺寸与当前 xterm 一致。
- 重绘期间到达的 Live Output 仍经过现有启动缓冲，顺序不乱、不重复确认。
- Historical Run 的 Gap 恢复不会调用 PTY Resize。
- Gap 提示不会写入 xterm 字节流，保留内容里的清屏指令也无法擦掉提示。
- 自动化测试覆盖自动重绘、手动重绘、历史 Run、不发生 Gap 的原路径和提示按钮。
- 仓库统一检查通过。
