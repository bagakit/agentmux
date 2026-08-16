# 对话组件与输入引用交付评审

用户于 2026-09-16 明确批准继续完成前次缺口，并将对话样式接入新组件。此计划落实该授权，保留 Core/Store 数据与发送归属，展示组件只读 typed props。

已检查 React、Radix、Monaco、remark 与现有 ComposerTextarea：原生 textarea 不能承载可点击行内节点；如需编辑器库，采用成熟维护库而非自写 contenteditable/光标与撤销系统。Provider command 不等于 prompt template，不能把 description 冒充 prompt。

T-001 输入引用与 T-002 对话消息是独立消费者，可并行修改不同组件；T-003 消费合并候选作最终验证。Gallery 文件由 T-002 负责，输入示例整合由 T-003 负责。

设计参考为已有 Workflow/Gallery 及原对话身份轴：低干扰、紧凑、真实状态、可恢复。验收包含 IME、粘贴、撤销、发送载荷、宽窄布局、失败态、状态字形和恢复证据。
