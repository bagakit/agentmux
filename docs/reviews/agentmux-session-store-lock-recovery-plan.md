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

## Revision 2 — 多 Agent 活跃时的锁争用

用户反馈在同时运行多个 Session 后，新的 Session 偶发收到 `Agent Session store is busy.`。
复现证据是 App 进程每秒都在写最新的语义状态/Hook receipt；CLI 的只读启动也会先拿同一把文件锁，
让生命周期写入在有限重试窗口里被读者和高频状态更新饿死。这不是陈旧 owner，应在拥有边界收敛争用：

### T-002 只读加载让出写锁，生命周期写入不被读者饿死

- `load()` 先做一致性读取；孤立 Timeline 清理作为拿不到锁时可跳过的旁路，不把只读列举变成独占写锁。
- 生命周期写入仍通过同一锁和有限退避排队；活 owner 不得被误删，重试耗尽才报告 `AGENT_SESSION_STORE_BUSY`。
- 新增行为测试证明高频只读加载与生命周期写入并发时，读取不占锁且写入最终落盘；清理在无争用时仍执行。

验证：

- `pnpm --filter @agentmux/core exec vitest run test/agent-session-store.test.ts`
- `pnpm --filter @agentmux/core typecheck`

验证必须执行 Core 的定向 store 测试和 typecheck；测试需先能在故意保留旧行为时变红。
