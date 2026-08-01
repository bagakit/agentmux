# Task Plan Review — Terminal restart projection cleanup

日期：2026-09-01

## 结论

**approved.** 这是一个独立的恢复投影闭环：不改变 ctxmux 的 PTY 生命周期，也不为
Terminal 发明 semantic resume；只修 Desktop 在 Runtime 暂不可达后如何收敛已保存的
Terminal Region。Agent 的 continuity/recovery-candidate 保留策略保持不变。

## 目标与边界

- snapshot 暂时失败时，已保存布局可以先保留，但这个窗口必须可观察，不能产生无内容的
  永久 Tab。
- 后续权威 snapshot 到达时，Terminal 与 Agent 一样完成成员对齐；snapshot 明确没有的
  Terminal Session 要从 Region、Tab layout 和下一次持久化投影一起移除。
- 空 snapshot（无 Session、无 recovery candidate）仍不是退役证据，避免把一次连接/根目录
  问题误判为“用户没有 Session”。
- 已知 Terminal Session 仍在 Runtime 中时，更新现有 projection 并保持它的布局；不把未被
  用户打开的 Runtime Terminal 自动制造成 Tab。

## 验证要求

行为测试必须覆盖：空 snapshot fail-open、包含其他事实的 snapshot 清理失踪 Terminal、
保留仍存在的 Terminal、Agent 的既有候选保护不回归。变异测试要让 Terminal 清理分支和
空 snapshot 守卫分别变红；零调用者检查确认新 reducer 接入运行时成员重整调用点。
