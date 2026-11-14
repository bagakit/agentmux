# 新建 Agent 与 resume 后终端丢色

## 定性

P1。本案范围是经长寿命 ctxmux Runtime 启动的 Run：Runtime 若从带禁色变量的宿主 shell 启动，之后所有新建 Agent、Terminal 与 semantic resume 的子进程都会再次继承这些变量，遵从它们的 CLI（例如 Claude Code 的 TUI）整屏变成单色。重启 App 或新建 Agent 都会复用原 daemon，无法消除问题。输入、输出、replay 与恢复能力不受影响，没有拿走健康能力；[AGENTS](../../AGENTS.md#工作面恢复与终端阅读) 中终端阅读的 P0 指活跃终端连续向上阅读与性能，不包括颜色。所以不定为 P0。

现行机制以 [Terminal 运行时《本地 Shell 与 Run 环境》](../architecture/terminal-runtime.md#3-本地-shell-与-run-环境)为准；本文只保留事故证据与结论。

## 用户可见症状

最初表现为 resume 后终端失去颜色，随后新建 Agent 也出现同样现象。原话未保留。

两种症状属于同一机制：两条路径共用同一个长寿命 Runtime 的环境继承。另一个页面有颜色、refresh 后显示变化，都不能说明原 CLI 是否输出了颜色。

## 影响面

**坏了什么**：Runtime 持有宿主的 `NO_COLOR=1`、`FORCE_COLOR=0` 或 `CLICOLOR=0` 时，经它启动的 Run 中，遵从这些变量的 CLI 不输出 ANSI 颜色。Terminal、新建 Agent 与 semantic resume 三条启动路径都受影响。同一机制也让宿主的 CI 与 Agent 会话标记（`CI`、`CODEX_CI`、`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`）漏入子进程，这些键与禁色变量一起由 `packages/core/src/terminal-environment-policy.ts` 管理。

**以下不受影响**：

- 输入、输出、ordered bytes、replay 与恢复：环境只影响 CLI 是否产生颜色，不影响 Runtime 持有的字节与恢复 seed。
- 不同 CLI 的差异不是 Provider 缺陷：对禁色变量的遵从程度不同，同一环境污染可以表现为一个 CLI 无色、另一个仍有颜色，不能据此写 Provider 特例。

## 止血措施

修复前没有带内恢复：重启 App、清理当前客户端环境或新建 Agent 都可能复用原 daemon。只有让 Runtime 在干净环境中重新启动才能消除继承，但这会停止全部健康 Run，不作为建议。修复后，新启动的 Run 在 exec 边界移除缺席的宿主信号；已经在运行的 CLI 的环境无法在线修改，也不为恢复颜色停止健康 Run。

## 引入时间线

命令：

```sh
git log -S 'NO_COLOR' --format='%h %ad %s' --date=short -- packages/core/src
git log -S 'missingHostEnvironmentKeys' --format='%h %ad %s' --date=short -- packages/core/src
```

- `266c881e4e`（2026-07-25）`feat(core): harden ctxmux-backed agent sessions`：引入终端环境基线，在请求环境对象上 `delete environment.NO_COLOR`，并删除值为 `0` 的 `FORCE_COLOR`／`CLICOLOR`。只有完整替换环境时，删键才等于取消继承。
- `86a4aaac1d`（2026-08-30）`fix(desktop): keep agent results compact and Claude prompts deliverable`：已经观察到 Claude 遵从禁色变量、Codex 可能仍输出 ANSI，并在最终 Agent／Terminal 启动边界再次删键，注释写明要防止“stale daemon … reintroduce them”。但 `RunSpec.env` 是增量覆盖，请求中缺席的键不会覆盖 daemon 已持有的值，这次删键在长寿命 Runtime 上不起作用。
- `ce0c80a77d`（2026-09-24）`fix(core): preserve terminal colors with long-lived runtimes`：在唯一 Run 启动 adapter 的 exec 边界用系统 `env -u` 显式移除最终环境中缺席的受管宿主键，并加入长寿命 Runtime 回归。

## 根因分析

- **直接原因**：`RunSpec.env` 是增量覆盖。客户端从请求对象删除 `NO_COLOR`，只是让请求不含该键；Runtime 增量合并时缺席键不覆盖父环境，真实 CLI 再次继承了 daemon 启动时的 `NO_COLOR=1`。
- **根因**：清理逻辑按“完整替换环境”的语义编写，而实际执行者是比调用者活得更久的 Runtime，采用增量合并。删除的含义没有沿真实继承链核对，“请求里没有这个键”被当成了“子进程里没有这个键”。
- **为什么没被更早发现**：排查中的对照实验用 `execFile({ env: captured.env })`，它完整替换环境；从这个对象删键后，对照 child 确实不再带键，但这无法证明增量合并的真实 Runtime 行为。只检查 RunSpec 是否缺键也有同样局限。直到让同一个真实 Runtime 先持有脏变量、再经正常 Core 启动 child 并读取它实际收到的环境，问题才被证实。

## 改进措施

1. **在唯一 Run 启动 adapter 的 exec 边界显式取消继承。** 机制见 [Terminal 运行时《本地 Shell 与 Run 环境》](../architecture/terminal-runtime.md#3-本地-shell-与-run-环境)，实现为 `packages/core/src/ctxmux-run-adapter.ts` 的 `launchCommand` 与 `terminal-environment-policy.ts` 的 `missingHostEnvironmentKeys`。
   - 是否足够 root：修的是“长寿命执行者下的缺席键继承”这一类。Terminal、新建 Agent 与 semantic resume 三条生产路径共用这个 adapter，一处修复覆盖三个实例，不在 Provider 或 client 中分别打补丁。
   - 能否彻底避免：本可阻止这次继承；不能在线修改已经启动的 CLI 的环境，也不能保证所有 CLI 采用同样的颜色策略。
   - 是否降低系统熵：不增加协议、Runtime 或配置层，只在 exec 边界使用系统 `env` 工具。被否掉的方案：只清理冷激活环境，覆盖不了已复用的旧 daemon；修改 Runtime 协议，会把客户端策略推给另一个 owner；按 CLI 分别强制颜色，会把通用环境缺陷变成 Provider 特例；用字符串拼接的 shell wrapper，会让输入语义依赖 shell 转义。
2. **用击中真实机制的反例做回归。** 让同一个 Runtime 先持有七个脏宿主信号，再经正常 Core 启动 child，读取它实际收到的环境；撤掉 exec 边界的 unset 后，反例重新出现。
   - 是否足够 root：覆盖“请求层清理被当成进程层清理”这一类验证缺口。
   - 能否彻底避免：只能让回归更早暴露。
   - 是否降低系统熵：增加一组集成测试，不增加运行时状态。

## 验证

- 生产回归：[长寿命 Runtime 环境测试](../../packages/core/test/long-lived-runtime-environment.integration.test.ts)；请求形状由 [Run 环境测试](../../packages/core/test/run-environment.test.ts) 保护。命令（仓库根）：`env -u NO_COLOR -u FORCE_COLOR -u CLICOLOR -u CI -u CODEX_CI -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION pnpm exec vitest run packages/core/test/long-lived-runtime-environment.integration.test.ts packages/core/test/run-environment.test.ts`。这组测试对环境变量敏感，要在剥掉受管键的环境下运行；受管键以 `terminal-environment-policy.ts` 和 [Terminal 运行时《本地 Shell 与 Run 环境》](../architecture/terminal-runtime.md#3-本地-shell-与-run-环境)为准。
- 承重变异：撤掉 exec 边界的 unset，长寿命 Runtime 反例中的真实 child 重新继承全部七个键。
- 观察组合：
  - 进程边界：真实 child 的环境、PID、cwd、literal argv、退出码与 signal；只看请求对象不够。
  - 生命周期边界：同一 Native 下新建、客户端进程重启后的 reattach、semantic resume；Session 与 nativeHandle 保持，reattach 保持原 Run，resume 创建新 Run。
  - 颜色链路：ANSI16、256 色和 RGB 原始字节，与 Native basic-vt restore bytes 经 xterm cell API 解释出的色值对照，用于区分“未输出颜色”和“恢复后解释错误”。
  - 保护边界：同一 Runtime 上另设健康 sentinel，比较它的 PID、状态、输入游标和输出字节；私有 fixture 在 finally 中释放全部自有资源，不操作生产 Run。

## 遗留

以下按本复盘时（`75d272747c`）的状态记录；锚点之后的变化逐条注明提交。

- 系统工具集成回归只覆盖 macOS arm64；其他系统和远端启动路径需要在各自 owner 验证。
- 修复只影响之后启动的 Run，已在运行的 CLI 保持原环境。已记录的单色输出不会被改写为彩色；修复不替换 Session，也不伪造恢复完成。
- RunSpec 如实记录系统 `env` wrapper，不伪装成直接启动原程序。
- 锚点之后，`98d84acc7b` 把 exec 边界的 unset 逻辑提取为 `CtxmuxRunAdapter.launchCommand`，仍由 `missingHostEnvironmentKeys` 生成 `-u` 参数；`terminal-environment-policy.ts` 在锚点之后没有改动。长寿命 Runtime 回归测试在锚点之后由 `45d741f2ea`、`98df138dd0`、`a713c2816f` 改过，承重以当前测试为准。

可复用的结论：当执行者比调用者活得更久时，缺席字段的含义必须沿真实继承链核对。对环境变量来说，“没传”常常意味着“沿用旧值”；需要删除时，在最终生效边界使用明确的删除语义，同时保留原执行身份和健康进程。
