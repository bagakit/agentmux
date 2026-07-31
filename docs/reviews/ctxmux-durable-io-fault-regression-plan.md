# Task Plan Review — ctxmux durable I/O fault regression

状态：approved（用户确认采用隔离故障注入，不破坏宿主环境）

## 用户确认

> 这个故障能模拟, 放进测试集吗

> 当然肯定不是把这个宿主搞挂, 而是模拟失败等

## 目标与边界

把本次 `ctxmux durable state database failed: disk I/O error` 事故冻结成可重复的 owner-level 回归：在临时 state-dir 注入一次 SQLite I/O 错误，验证错误分类与 failure-latch 边界，再释放测试资源并重新打开同一份隔离 state，确认数据仍可恢复、后续 mutation 可继续。测试不得填满宿主磁盘、改动用户 runtime、停止宿主应用或接触真实 Session 数据。

ctxmux 仍是 SQLite、persistence actor、failure-latch 与重启恢复的唯一 Owner。AgentMux 不增加备用数据库、错误字符串匹配、daemon 重启或第二套重试逻辑；本仓库只记录约束并消费 ctxmux 的公开结果。

## 验收

- 注入的 `SQLITE_IOERR` 只影响隔离 fixture，并被归类为数据库 I/O 失败；同一 actor 后续 mutation 被明确拒绝，证明测试确实覆盖事故路径。
- 关闭失败 actor、重新打开同一 state-dir 后，既有 durable Run 可恢复，新的 mutation 成功；测试不删除或重写任何用户状态。
- 测试用 test-only hook/fixture 注入错误，不调用真实磁盘耗尽、系统级 I/O 破坏或宿主进程终止。
- 现有 DiskFull、WAL busy、corruption 与 shutdown 回归继续通过，错误分类不被放宽成无限重试。

## 验证命令

```text
cargo fmt --manifest-path /Users/bytedance/proj/priv/bagaking/ctxmux/Cargo.toml --all -- --check
cargo test --manifest-path /Users/bytedance/proj/bagaking/ctxmux/Cargo.toml -p ctxmux-daemon persistence
```
