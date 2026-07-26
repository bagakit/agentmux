# Task Plan Review — Agent Session store lock recovery

日期：2026-08-31
评审结论：**approved**

## 目标

修复 AgentMux Core 文件型 Session store 的陈旧锁处理：正常写入留下的 owner 仍然存活时必须等待，
owner 已退出、锁内容为空或锁内容被截断而无法证明存活时，不能把锁永久当成活锁。新 Agent 的创建
应在这种陈旧锁被回收后继续；清理不应触碰 Session、布局或 ctxmux 私有状态。

## Task

T-001 只在 `packages/core/src/agent-session-store.ts` 的锁拥有边界处理该行为，并以 store 测试证明：

- 活 owner 锁保持不动并最终返回 `AGENT_SESSION_STORE_BUSY`（不会误删）；
- 空锁、截断/非法 owner 锁以及已退出 owner 锁可被回收，后续写入成功；
- 回收过程仍尊重 AbortSignal，失败不会产生迟到提交。

验证必须执行 Core 的定向 store 测试和 typecheck；测试需先能在故意保留旧行为时变红。
