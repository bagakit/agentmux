# AgentMux Browser visible launch E2E review

状态：approved

本轮用户确认的发布要求是：在聚焦的 Universal Pane（包括当前非 launcher 的 Region）点击
`New Browser` 后，必须出现 Browser Tab/Region；若 Main 创建失败，必须在同一工作面显示
确定性错误。按钮不能在 Tab、Region、Browser state 和错误提示都不变时静默 no-op。
