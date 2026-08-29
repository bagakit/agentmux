# AgentMux 自操作边界评审

状态：approved（用户已确认：Agent 操作 AgentMux 自身不应依赖 Computer Use）

## 用户目标

AgentMux 内的 Agent 在操作 AgentMux 自己时，直接使用 AgentMux 提供的控制能力，不经过 a mature workbench、Codex Computer Use、截图坐标点击或 macOS Accessibility。外部 Computer Use 只属于可选的开发验收和跨应用工具，不成为产品运行条件。

## 当前证据

- `packages/core` 已有 typed Control 协议与 CLI，覆盖 `inspect`、`list`、`open`、`send`、`focus`、`arrange`、Browser Control 以及 Demand/PMO 操作。
- 打包验收使用 LaunchServices、应用内 ready/file-editing receipt 和 ctxmux owner receipt；没有调用 a mature workbench 或自动点击。
- 当前会话通过 Codex 的 `cua_repl` 直接读取安装版 AgentMux，已经证明开发验收不需要 a mature workbench 作为唯一 Computer Use 实现。
- 仓库中少量 a mature workbench 文字和 MIT 许可改编代码属于参考/来源记录，不是 a mature workbench 运行时依赖。改编代码在被自有实现替换前必须保留许可声明。

## 保护不变量

1. AgentMux 自操作只有一份 Control/semantic surface 真相；不在 Core、Desktop 或 PMO 内复制截图、坐标和系统窗口自动化状态。
2. 外部 Computer Use 不可用、权限失效或观察超时，不得阻断健康 Agent、Session、Demand 或重启恢复。
3. Browser 页面操作继续走 CDP；它与 macOS Accessibility 分层，不把页面语义降级成桌面坐标。
4. 跨应用桌面自动化若有明确需求，单独设计可选 adapter 包，不进入 `packages/core`，不成为启动和发布 Gate。

## 本次范围

- 固化 AgentMux 自操作的 Control 边界和非阻断规则。
- 对现有 Control/PMO/Demand surface 做接线和证据核对，补齐真正缺失的产品调用者。
- 为后续外部 Computer Use adapter 留出隔离边界。

## 非目标

- 本次不实现通用 macOS Accessibility 驱动器。
- 本次不把 Codex Computer Use 或 a mature workbench 打包进 AgentMux。
- 本次不删除仍在使用中的第三方 MIT 改编代码；替换它们需要独立的行为等价 Feature。
