# Task Plan Review — Agent Session store contention

日期：2026-08-31
评审结论：**approved**（用户要求继续处理多 Session 后的新建失败）

## 保护目标

多个 Agent 高频上报状态时，新的 Session 创建、恢复和停止仍必须能在有限窗口内完成；只读列举不得
把同一份 Session store 的写锁变成全局门闩。孤立 Timeline 清理仍然保留，但只能作为可让出的维护旁路。

## Task

T-001：让 File Session store 的 `load()` 走一致性读取，并在拿不到锁时跳过孤立 Timeline 清理；写入锁
仍保持活 owner 保护、有限退避和明确的 `AGENT_SESSION_STORE_BUSY` 结果。行为测试必须证明活锁下只读
加载快速返回、清理在无争用时仍发生，且生命周期数据实际落盘。

验证：Core Session store 定向测试、Core typecheck。
