# ctxmux 磁盘写满后的终端恢复

## 问题

ctxmux 把 Run、PTY 和最后一段终端输出写进 SQLite。磁盘曾经写满时，当前版本会把
第一次 `DiskFull` 永久记住；即使后来已经腾出空间，daemon 仍拒绝所有新修改。
AgentMux App 重启不会杀掉这个 daemon，所以旧错误会一直存在，`Restart terminal`
也只能再次收到同一个错误。

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

## 当前运行中的旧 daemon

已经进入 fail-stop 的旧 daemon 没有保存可恢复的失败批次，也没有在线升级接口。
实现不能伪造这段缺失状态。安装带修复的新 artifact 时，需要结束旧 daemon；这一次切换会
结束它仍持有的旧 PTY。修复生效后，普通 App 重启仍不会结束由新 daemon 持有的 Run。

## 验收

- 强制第一次输出持久化返回 `DiskFull`，随后恢复时，同一 Run 的完整输出和最终状态可重放。
- 恢复前的新 Start 不会越过失败批次，恢复后可以正常创建。
- 明确的 replay 冲突仍会锁住 actor，不能因为新增重试而放宽数据正确性。
- ctxmux 的公开 artifact 来自干净、精确 commit；AgentMux 校验 manifest、binary 和 SDK。
- AgentMux 的 Core、原生 consumer、Desktop 和打包检查通过。

## 固定结果

修复后的 AgentMux 只消费 ctxmux clean commit
`f89dabe70eba38d46992c320e40c9ebe2f09b5e5`。新的 manifest 指纹同时换了
AgentMux runtime 目录身份；新版本不会误连仍记着旧错误的 daemon。旧 daemon 与它持有的
PTY 不会被新版本冒充或接管，是否结束它由安装切换单独决定。
