# Composer queue and density review

用户确认需要通用 queued/steer 体验。现有 `agentSteerQueues` 仅覆盖 pending interaction，working steer 仍直接提交；本 review 将其扩展为有界、按 Session 保序的待发送队列。Provider readiness 仍由 Core 决定，队列不绕过 permission/interaction gate；成功投递后移除，失败保留并展示原因。
