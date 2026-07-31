# Task Plan Review — ctxmux WAL checkpoint resilience

状态：approved（本次用户授权的实现边界）

## 用户原话

> 打开 terminal 报 `ctxmux durable state rejected a mutation: WAL truncate checkpoint could not reach zero bytes`，非常不合理，排查下；和前面的问题一起处理后打个新包并安装。

## 证据与结论

ctxmux 的 persistence actor 在 WAL 超过 admission 阈值时执行
`PRAGMA wal_checkpoint(TRUNCATE)`，当前连接设置 `busy_timeout=0`。一次短暂的
SQLite reader/attachment 争用会返回 busy，随后 actor 把错误写入共享 failure
槽；之后所有 mutation 都被永久拒绝。离线复制同一 state 后 `quick_check` 与
`wal_checkpoint(TRUNCATE)` 均可归零，故当前证据指向瞬态锁竞争被错误升级为永久
失败，而非先假设数据库损坏。

## 架构边界

- ctxmux persistence 是 WAL、SQLite、checkpoint、队列 FIFO 与 failure-latch 的唯一 owner。
- AgentMux 不增加 WAL 截断、数据库修复、重试或第二 Runtime；Desktop 只显示 ctxmux 的分类结果。
- busy 只在有界窗口内重试；corruption、disk-full、超出物理上限或重试耗尽仍 fail closed，并保留原 Session/布局投影。
- 重试不能重排 actor FIFO、重复已提交 mutation，不能让 shutdown 卡住，也不能把“恢复中”伪装成“已成功”。
- Renderer 启动时先提交已持久化的 Workbench 投影；单个 runtime snapshot/provider probe 失败只形成作用域明确的服务窗，不得因 `Promise.all` 拒绝而丢弃布局。

## 最小任务 DAG

| Task | 依赖 | 交付 |
| --- | --- | --- |
| T-001 | — | 在隔离 ctxmux state 上稳定复现 busy checkpoint，并冻结 owner-level regression contract |
| T-002 | T-001 | persistence owner 的有界 busy retry/backoff；瞬态 busy 不 latch，非 busy 错误仍 fail closed |
| T-003 | T-002 | 精确 ctxmux candidate 被 AgentMux vendor/manifest 消费，Terminal 创建与 resume 真实 smoke 不再触发旧错误 |
| T-004 | T-003 | 干净 macOS package/install、重启连续性与独立审计；变异和 zero-caller 证据汇合 |

每个 Task 都必须有可执行 command gate。完成还需证明：故意移除 retry 或恢复
接线时对应测试变红；新增公开 symbol 在定义文件之外有生产调用者。不要手工截断
真实用户 WAL，也不要删除旧状态作为“修复”。

## T-003 消费决策（2026-08-31）

ctxmux 最新 `main` 为 `c13ab114f6ddf0cf8eb22c6cc39bb16f7aa0dec7`，其中
`14955258d443b5582616bc962449d39aba03ab41` 保留 SQLite extended result code，
只把 `SQLITE_IOERR_WRITE`、`SQLITE_IOERR_FSYNC`、`SQLITE_IOERR_DIR_FSYNC` 与
`SQLITE_IOERR_TRUNCATE` 纳入空间压力重试；READ、LOCK、DELETE、MMAP、裸
`SQLITE_IOERR` 与未知 extended code 继续 fail closed。最新 artifact 为 protocol 14，
SDK 已在 wire validation 边界把 base64 output 解码成 `Uint8Array`，AgentMux
`CtxmuxRunAdapter` 的 ordered-byte 输入合同无需改变。因此 T-003 消费最新 main 的
完整 daemon/CLI/SDK/manifest artifact，不维护 protocol 13 私有 backport。
