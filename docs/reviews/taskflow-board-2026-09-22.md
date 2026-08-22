# Agents 看板与 Board 需求流转计划

Status: approved

授权：用户确认 Board Demand 是需求，可关联零个或多个 Session；要求将旧 Board 设计替换 Agents，Board 业务逻辑参考 multica，继续彻底实现、小提交、合入 main，并创建 feature-tracker。本计划细化上述确认范围。

来源：multica packages/core/types/issue.ts 的七个需求状态和独立 assignee，packages/core/types/agent.ts 的独立执行尝试，以及 packages/views/issues/actions/run-confirm-gate.ts 的 Backlog 分配不启动规则。采用本地需求管理模式，不搬入 SaaS 组织权限或远端 Runtime。执行仍走 AgentMux Core。

T-001 闭合 Agents 卡片看板、同屏观察与请求处理。T-002 闭合独立 Demand的创建、编辑、七状态流转、负责人、显式执行、多会话关联和活动记录。两者独立，串行改动共享文件。包含变异、定义文件外调用者、持久状态重新加载与恢复验证。独立 worktree 小提交后合入 main，保留并行工作。
