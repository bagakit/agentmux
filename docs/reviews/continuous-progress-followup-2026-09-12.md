# Continuous progress follow-up review (2026-09-12)

This successor feature carries forward the two newly observed release blockers from f-2528fmqbw: Explorer projection evidence must survive Workspace remounts with monotonic receipts, and stop cleanup must converge without leaving native sessions live. Both require runtime behavior tests plus mutation and production-caller checks before packaging.

## Revised decision

The mounted verification protocol uses operation-scoped receipts (`workspaceId`, mount epoch, operation id) rather than aggregate DOM counters. Move commit publishes one authoritative receipt; stale refreshes are rejected by epoch. Stop treats an already vanished Run as an idempotent terminal outcome.

## Proposal promotion scope

At the user's direction, the eight same-product proposals are promoted into this Feature as explicit deferred Tasks, retaining each original Feature id in `source_refs`. They remain todo until their own acceptance and executable gate pass; proposal promotion does not imply implementation. Remote/SSH and other infrastructure closures remain separate because they cross the current desktop Feature boundary.

## 收尾实施复核

用户已要求全部完成后安装；确认 T-008 包含全局浅色/深色/系统跟随，而非仅终端调色板。T-009 使用自有标题栏结合系统交通灯，T-007 通过明确标注的可见上下文续聊提供安全新会话，不声称原生 fork。T-010 采用已有读取通道的本地缩略图与引用复用。T-006 为项目显式角色注册与精确解析，不夹带自动投递。上述约束已同步设计 SSOT。

所有尚未执行任务从仅 typecheck 改为对应行为测试 gate；T-011/T-013 并行实现与 T-006/T-007/T-008/T-009/T-010 无等待边。最后安装使用整合后的单一候选，所有测试临时进程须清理。
