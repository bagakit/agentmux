# 真实 Codex lifecycle 的隔离输入与清理

`packages/core/test/real-codex.integration.test.ts` 默认 skip。开启前，运行者须准备一个明确独占的、最小 `CODEX_HOME` seed：仅 `auth.json` 与 `config.toml`，认证与模型路由有效，`features.hooks=true`；无 MCP、global Hook、notify、plugins 或原 Session 上下文。不能指向用户默认 `~/.codex`。Root/CI 可自行准备，认证原件不进 Git、不输出到公开证据；这项必要 seed 前提替代原测试隐式消费用户 HOME 的用法。

```sh
CODEX_HOME="$private_seed" AGENTMUX_REAL_CODEX_E2E=1 pnpm --filter @agentmux/core test:real-codex
```

可选 `AGENTMUX_REAL_CODEX_COMMAND` 指定已授权 CLI。fixture 只把两个 seed 文件复制到新建、权限 700 的私有 Root，文件权限 600；`HOME`、`CODEX_HOME`、Runtime/socket、durable/ctxmux、Store、message queue、workspace Hook 均指向本次 Root。CLI 使用固定 `cli_auth_credentials_store="file"` 和关闭 notify/plugins/memories 的覆盖值，不回落用户 HOME/Keychain。真实只读 version/auth/MCP/features 前置先收口全部命令，只核结构与状态，失败不打印认证/config 输出，也不启动 Native/Agent。

fixture 持确切 vendored Native 的 ChildProcess/readiness-fd3，Core 连接这个预启动的私有 Native。本用例覆盖公开 create、同 Run reconnect、输入、自然退出、同 Session semantic resume 新 Run、第二次 reconnect/自然退出、replay 与 retire；不把预启动连接称为 Core 自动 bootstrap。两次输入仍为原 `/exit` 双相位、5→10→11，不包含 idle Ctrl+C。

ACK 观察委托真实 FileStore CAS，成功后同步冻结候选快照。按 exact Session/Run/submission 的两相位 operation/range/readiness 核非空且语义一致，允许等价 CAS 重复；退出后读耐久 admission 和终局 readiness/submission 清空，避免从异步 live getter 要求已退出 Run 继续 ready。

每个 Client 在 connect 前登记。在途未收口时保私有默认路径和 Native，不先恢复 env。finally 关闭新操作，有界等在途实际结束，经已持有公开 Client 收口 exact Session/Run、确认无 running Run，再 dispose 全部 Client、确认 Hook 退出；只对本次 ChildProcess 发正常 SIGINT 并等 close，最后普通删除已完成 Root、恢复 env。没有 SIGTERM/SIGKILL、宿主进程扫描或 force 删除。任何未知/超时/清理错误保 Root 与真实错误；尚有在途认证读取时 auth 保 600，不能提前清除，须由该测试 owner 后继处理。

## 结果与范围

默认 skip 只表示未执行真实用例，不能报告为 real PASS。fixture／readiness 单元检查与真实 lifecycle 结果分别记录；fake ChildProcess 不启动 Native，不能代替真实恢复与退出证据。一次失败不授权自动追加实验，后续运行仍须具备上述隔离前提与当前任务授权。

本指南只定义该测试的运行与清理边界，不证明当前 GUI 输入、活跃取消、连续阅读或性能已通过。候选、失败现场及本轮覆盖范围留在对应验收证据中，不成为后来任务的进度或许可。
