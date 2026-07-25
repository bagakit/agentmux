# ctxmux 磁盘写满后的终端恢复

## 问题

ctxmux 把 Run、PTY 和最后一段终端输出写进 SQLite。旧 artifact 在磁盘写满后会把
第一次 `DiskFull` 永久记住；即使后来已经腾出空间，daemon 仍拒绝所有新修改。

## 目标

- 磁盘只是暂时写满时，保留尚未写入的终端输出并等待空间恢复。
- 写入恢复后，原 Run 继续使用同一字节游标，不丢一段、不重复一段。
- 在等待期间对 PTY 输出施加有界背压，不能让内存无限增长。
- 数据冲突、损坏、越界和无法确认的其他错误仍然失败关闭。
- AgentMux 只升级并验证 ctxmux artifact，不在 App 内建立备用数据库或第二个 Run Owner。

## 行为

- SQLite 明确返回 `DiskFull` 时，ctxmux 保留当前批次并在同一个持久化 Owner 中重试。
- 持久化队列仍然有界。空间长期不足时，子进程最多被 PTY 背压暂停，不会靠继续读输出
  把内存撑大。
- 空间恢复后，失败批次先写入成功，后面的创建、终止和输出修改再按原顺序继续。
- 其他持久化错误仍然进入现有 fail-stop，不被误当成可重试错误。

## 验收

- 强制第一次输出持久化返回 `DiskFull`，随后恢复时，同一 Run 的完整输出和最终状态可重放。
- 恢复前的新 Start 不会越过失败批次，恢复后可以正常创建。
- 明确的 replay 冲突仍会锁住 actor，不能因为新增重试而放宽数据正确性。
- ctxmux 的公开 artifact 来自干净、精确 commit；AgentMux 校验 manifest、binary 和 SDK。
- AgentMux 的 Core、原生 consumer、Desktop 和打包检查通过。

## 当前实现

AgentMux 固定消费 Protocol 13 clean commit
`1603908a253162632e8812ceb9db19c3e416fea4`。ctxmux 在唯一 persistence actor 中只根据
SQLite typed `DiskFull` 保留并重试当前 append/finalize mutation；既有有界队列继续施加背压，
shutdown 可以中断等待，其他错误继续 fail-stop。AgentMux 只原子携带并校验同一来源的 manifest、
SDK 与两个 binary，不增加 daemon 重启、备用数据库、错误文案匹配、兼容层或 fallback。
