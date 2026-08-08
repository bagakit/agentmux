# 重启后 Tab/Region 与 Session 恢复回归评审

日期：2026-09-11

## 用户现象

进程重装重启后，之前的 Tab 和 Region 消失，Session 没有自动恢复；手动 resume 又提示 Session 已经运行在其他进程。

## 当前证据

- Renderer 只有在 `ensurePersistHydrated()` 完成后才读取 Runtime snapshot；`restorePersistedWorkbench` 是布局恢复边界。
- `initialize()` 在 snapshot 为空或恢复调用抛错时已经尝试保留未知 Region，但最终仍会把 `visibleSessions` 与持久化投影重新拼接；需要回归测试证明布局不会因一次流程失败被覆盖。
- lifecycle reservation 以 `ownerPid`、`expiresAt` 判定 stale；仅检查 PID 存活会把 PID 被新进程复用的重启窗口误判成旧 owner 仍在。
- Hook ingress 端口被旧进程占用时，Core 统一返回 `HOOK_INGRESS_BUSY`；这必须与“Agent/Run 仍健康”区分并保留 Session/Region。

## 评审结论

approved。修复范围是启动恢复投影的持久化保护、stale lifecycle/owner 的可证明回收，以及把回归固定在 Renderer 与 Core 的真实生产调用路径。不能通过静默创建新 Session、清空旧布局或把未知状态当作健康冲突来“修复”。

## 验收边界

- 重启后持久化 Tab Group、Region 树、焦点与分割比例仍可见。
- Runtime snapshot 暂时为空、自动恢复抛错或 Hook 流程失败时，原 Region 保留并出现服务窗告示。
- 旧 owner PID 已退出或租约已过期时，新进程能回收 lifecycle reservation；只有 owner 可证明仍活着时才报告冲突。
- Provider 真正不可 resume、Session 明确退休、旧 owner 仍存活三类结果仍分别呈现。
