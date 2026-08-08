# Agent 写入与 Steer 评审

现象表明 sessions:write 在 pending interaction 时 fail-closed，而终端输入仍可能可用。实现应区分 typed response 与普通 prompt，健康 Agent 不因流程拒绝而停止；普通输入进入有界队列，按 Provider/Run readiness 在立即 steer 或空闲投递之间选择，并持续显示原因。
