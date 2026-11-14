# 真实 Codex lifecycle 的隔离输入与清理

本页说明怎样运行 opt-in 的真实 Codex lifecycle 测试 [real-codex.integration.test.ts](../../packages/core/test/real-codex.integration.test.ts)，以及它怎样隔离用户数据、怎样收尾。夹具实现在 [real-codex-fixture.ts](../../packages/core/test/helpers/real-codex-fixture.ts) 的 `prepareRealCodexScope` 与 `RealCodexScope`。

## 准备独立的 Codex seed

该测试默认 skip。开启前，运行者须准备一个本次独占的最小 `CODEX_HOME` seed 目录：

- 只含 `auth.json` 与 `config.toml`，认证与模型路由有效，`features.hooks=true`；
- 没有 MCP、全局 Hook、notify、plugins 或原 Session 上下文；
- 不能指向用户默认的 `~/.codex`，夹具会在启动任何进程前拒绝它。

运行者（人或 CI）自行准备 seed；认证原件不进 Git，也不输出到公开证据。测试不再隐式读取用户 HOME 下的 Codex 配置。

```sh
CODEX_HOME="$private_seed" pnpm --filter @agentmux/core test:real-codex
```

`test:real-codex` 脚本自己设置 `AGENTMUX_REAL_CODEX_E2E=1`。可选的 `AGENTMUX_REAL_CODEX_COMMAND` 指定已授权的 Codex CLI，缺省为 `PATH` 上的 `codex`。

## 夹具怎样隔离

- 夹具在系统临时目录新建权限 700 的私有 Root，只把 seed 的两个文件复制进去，文件权限 600。
- 进程环境只保留 `PATH`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LC_CTYPE`、`LC_ALL`、`TERM`；`HOME`、`CODEX_HOME`、`TMPDIR`、Runtime 目录与 socket、durable 与 ctxmux 状态目录、Session Store、消息队列都指向这个 Root，workspace Hook 也安装在 Root 内。
- Codex CLI 带固定覆盖值运行：`cli_auth_credentials_store="file"`，关闭 notify、plugins、plugin_hooks、memories 与 chronicle（见 [private-codex-config.ts](../../packages/core/test/helpers/private-codex-config.ts)），因此不会回落到用户 HOME 或 Keychain。
- 启动前先并发执行只读的 version、登录状态、MCP 列表与 features 检查，全部结束后才判断；只核对结构与状态，失败时不打印认证或配置输出，也不启动 ctxmuxd 或 Agent。

## 覆盖什么

夹具持有随包 darwin-arm64 `ctxmuxd` 的 ChildProcess，经 readiness fd 3 确认就绪后，Core 连接这个预先启动的私有 Runtime；这不是 Core 自动 bootstrap。用例经公开 API 覆盖：

1. create，并在同一 Run 上 reconnect（Run ID 与 PID 不变）；
2. 输入 `/exit`，Agent 自然退出；
3. 同一 Session 的语义 resume 产生新 Run，再次 reconnect 并输入 `/exit` 自然退出；
4. replay 与 retire。

两次 `/exit` 都按两相位写入：正文占该 Run 输入字节 5 到 10，提交回车占 10 到 11。用例不包含 idle 时的 Ctrl+C。

ACK 观察包住真实 FileStore 的 compare-and-swap：只有写入成功后才同步冻结一份快照。核对时按准确的 Session、Run 与 submission，要求两相位各自有非空且不同的 operation，字节范围与 readiness 证据一致；等价的重复 CAS 允许存在。Run 退出后读取耐久的 admission 记录，并确认终局的 readiness 与 submission 已清空，而不是要求已退出的 Run 通过异步 live getter 继续显示 ready。

## 怎样收尾

每个 Client 在 connect 前登记到夹具。还有在途操作时，私有默认路径与 ctxmuxd 保持不动，环境变量也不先恢复。收尾顺序是：

1. 关闭新操作，在有界时限内等待所有在途操作真正结束；
2. 用已持有的公开 Client 核对每个 Session 仍在私有 workspace、状态中的 Run 与记录一致，再停止这个准确的 Session／Run，确认没有 running 的 Run；
3. dispose 全部 Client；只有全部 Client 已结束、不再读取凭据时才删除 `auth.json`；
4. 确认 Hook 端口已空出；
5. 只对本次启动的 ctxmuxd 子进程发送一次正常 SIGINT 并等待 close；
6. 普通（非 force）删除 Root，恢复原环境变量。

收尾不使用 SIGTERM、SIGKILL、宿主进程扫描或 force 删除。任何未知、超时或清理错误都保留 Root 与原始错误；尚有在途认证读取时 `auth.json` 保持 600，不提前删除，由该测试的运行者后续处理。

## 结果与范围

默认 skip 只表示没有执行真实用例，不能报告为真实通过。夹具与 readiness 的单元检查和真实 lifecycle 结果分别记录；fake ChildProcess 不启动 ctxmuxd，不能代替真实的恢复与退出证据。一次失败不授权自动追加实验，后续运行仍须满足上述隔离前提，并有当前任务的授权。

本页只定义该测试的运行与清理边界，不证明当前 GUI 输入、活跃取消、连续阅读或性能已通过。每次运行的候选、失败现场与覆盖范围留在对应验收证据中，不成为后来任务的进度或许可。
