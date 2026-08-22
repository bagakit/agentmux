# AgentMux 无法启动：ctxmux 状态库达到物理上限

2026-09-20，用户报告“agentmux 进程又启动不了了，帮忙看看怎么回事”。本轮完成诊断与可回退的现场恢复，未修改产品代码，永久修复未完成。

## 证据

- 已安装 App 启动报 `The spawned CtxMux daemon did not publish its readiness receipt in time.`
- Core `ctxmux-run-adapter.ts` 的 readiness 预算为 5 秒，spawn 的 stderr 为 ignore。直接启动相同已安装 daemon、同一 state-dir 后得到真实错误：`ctxmux durable state database failed: database or disk is full; startup normalization rollback failed: cannot rollback - no transaction is active`。
- 原库 `state.sqlite3` 为 402,653,184 字节（384 MiB）；4096 字节/页，98,304 页，freelist 0。磁盘当时约有 12 GiB 可用。
- ctxmux `crates/ctxmux-daemon/src/persistence.rs` 定义 `DATABASE_MAX_BYTES = 384 * 1024 * 1024` 并设置 SQLite `max_page_count`；绑定的 daemon 二进制也含同一上限诊断。
- 原库包含 164 个 Run、618,608 个 replay chunk；逻辑 replay_bytes 总计 195,039,837。现象是物理数据库容量耗尽，不能用“机器磁盘没空间”替代解释。

## 现场恢复及验证

1. 用只读、immutable 连接对原库执行 `VACUUM INTO` 到隔离目录，得到 323,117,056 字节的压实副本（约 308 MiB）。
2. 原库和副本四张表逐行、按 rowid 排序计算 SHA-256，行数和摘要完全一致；两边 `PRAGMA quick_check` 均为 `ok`。没有删除 Run 或回放行。
3. 在另一份压实副本上用同一已安装 daemon、隔离 socket/state-dir 启动，3.826 秒收到 `ctxmux.daemon-ready.v1`；随后仅停止该隔离验证进程。
4. 获取真实 state.lock 的排他锁，确认不存在 WAL/SHM，备份原库，再原子换入未被验证进程修改过的压实副本。
5. 已安装 App 成功出现工作区、项目、原 Tab 和历史终端内容。SDK runtimeInfo 确认 protocol 17、`services.persistent_state: 1`、`runtimeIdPersistence: state_dir`，runtimeId 仍为 `ae218ad9-c7f7-437e-83c7-a034b2f3447b`。
6. UI 中旧 Agent 显示 interrupted 与 Resume；不能据此宣称 Agent 已自动恢复运行。启动阶段还出现 historical Run stop 和短暂 attachment ECONNREFUSED，故本轮只确认 App 启动及工作面可见。

恢复目录（仅本机）：`/private/tmp/agentmux-startup-recovery-7vxletus/`；原库备份 `original-state.sqlite3`；未改动的压实副本 `state.sqlite3`；隔离启动结果 `probe-result.json`。

诊断插曲：ctxmux CLI 的 ping 会自动启动无 state-dir 的 daemon，不能当成纯只读探针。该次创建的无 Run 临时 daemon 已精确停止；最终验证改用 SDK runtimeInfo，没有用空 Runtime 替换持久化 Runtime。

## 后续边界

- ctxmux Owner 修复容量/碎片达到物理上限时的恢复余量问题，必须在隔离 fixture 上重现物理满页状态及重启，不得以提高 AgentMux timeout 代替。
- AgentMux 保留有界 daemon 启动错误证据，避免底层拒绝被通用 timeout 掩盖，并遵守设计 SSOT 的工作面恢复约束。
- 本轮未改产品实现、未执行产品变异测试、未宣称永久修复或 Feature done。

另发现独立的开发入口问题：`pnpm dev` 使用的 branded Electron 缓存只有 `version.txt`（43.3.0），没有 AgentMux.app；dev-desktop.mjs 仅匹配版本戳后返回不存在的路径，导致 ENOENT。本轮未修改或重建该开发缓存，它不解释已安装 App 的失败。
