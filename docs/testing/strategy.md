# AgentMux 测试策略

更新：2026-08-17

## 权威边界

AgentMux 只测试自己的公共 Core/Client 行为和 CtxMux public boundary，不读取 CtxMux wire、数据库、PID table 或私有模块。PTY、Replay、Signal 与 Stop 的底层正确性由固定 CtxMux source Gate 拥有；AgentMux 必须另做 checkout-external composition proof，证明打包和映射没有破坏这些能力。

Terminal output 是 raw PTY bytes 的 UTF-8 投影，不是模型上下文、Tool、Permission、Reply 或 Worker Done 证据。

## 当前 Shell checkpoint proof map

| 不变量 | AgentMux public oracle |
| --- | --- |
| exact artifact identity | pack 内 manifest 固定 commit `2e32a9d647d627952ea5c455fb2efef6c636643a`、tree `d60870c2481c9b153da6bf22f829d24afb8a81a8`、protocol 9，并在 build/runtime 复核 size/mode/SHA-256 |
| exact endpoint owner | 首次启动 inherited readiness receipt 与 public handshake 的 daemon instance 必须相等；socket/state 根再由 commit + manifest identity 派生，replacement peer 因 owner receipt/daemon instance 不匹配失败关闭 |
| checkout independence | `package-consumer.integration.test.ts` 在 `/private/tmp` 执行 `pnpm pack` 和 offline/no-save npm install；真实 package root 不在 checkout |
| one Run identity | 公共 `AgentMuxRunRef` 只有 CtxMux `runId`；重连后 RunId 与 PID 均不变 |
| ordered byte replay | fixture 拆分一个四字节 emoji 的两次 write；Client 不产生 replacement character；从 byte 7 interior cursor 重连后得到连续 suffix |
| recoverable Input | 公共 Input operation 保留 owner instance、operation id、expected byte 和 exact data；丢弃首次 receipt 并换 Client 重试后恢复同一 applied range，真实 PTY 只观察到一次输入 |
| Attachment lifecycle | 第一个 Client dispose 后 Run 继续，第二个 Client attach 同一 Run；detach/dispose 不 stop |
| Resize | public resize 到 `101x37`，真实 PTY 子进程从 TTY 读回并输出同一尺寸 |
| Interrupt | public `SIGINT` 经 CtxMux portable Interrupt；fixture 观察信号后继续 running |
| complete Stop | 忽略 HUP/TERM 的 root + child fixture 经 public Stop 后全部 PID 消失 |
| Remote boundary | `connectSshAgentMux` 与 SSH execution host 返回 typed `REMOTE_UNSUPPORTED`，没有旧 SSH Run fallback |
| no second runtime | packed file list 和源码审计不存在自建 daemon、wire、journal、`node-pty` 或旧 package bin |
| Agent identity resolver | AgentMux id、Provider + native id、ACP handle 与 exact RunRef 唯一解析；unknown/conflict/retired 失败关闭 |
| cross-process lifecycle | 两个真实 Node 进程竞争 Create/Resume，只允许一个 File Store reservation/CAS commit；Owner crash 按 CtxMux Run spec operation id 回收 orphan |
| natural terminal retire | public CtxMux status 证明 Run 已 terminal 后只退休语义绑定，不伪造 Stop 成功 |
| Codex terminal handshake | fake + real Codex 发出 terminal query；Core 只回复 flags 0 并持久化可恢复 Input receipt |
| Stop-epoch readiness | Core 用有界 headless terminal emulator 从 byte 0 连续重放 CtxMux public Replay/live；只有当前 cursor 所属 composer 为空且 screen 已穿过 Stop cursor 才 ready，Gap/overlap 失败关闭，assistant 或历史行里的 `›` 不能伪造 composer |
| prompt crash recovery | payload 与 submit 各自使用确定性 operation id；只有当前 screen/cursor 的 composer 精确等于 payload 且 output 越过写入前 boundary 才发送 CR；局部更新不要求重画 marker，历史同文、丢失 receipt 或进程 crash 都不能造成重复 payload/CR |
| terminal color capability | packed consumer 在父环境显式设置 `NO_COLOR=1`，真实 daemon/PTY child 仍观察到 `TERM=xterm-256color`、`COLORTERM=truecolor` 且 `NO_COLOR` 不存在 |
| Terminal appearance query | Desktop Main 在 Renderer 未 attach 时识别完整及跨 chunk OSC 10/11 query，等待 Core 发布 ready Agent Session 后才经 Core → CtxMux Input 回复当前 shared palette，不能与 Core Terminal handshake 竞争 Input cursor；Renderer replay handler 消费旧 query 而不重复注入 |
| Terminal/Explorer interaction | Fast suite 固定黑底 Graphite 的 Agent Surface 层次、workbench-derived options、OSC parser、历史 Run 只读 fit、平台路径、Workspace Root reveal 边界与 Store action；Production build 证明 Search/WebLinks/WebGL/Context Menu 可打包 |
| Hook acceptance/drain | Hook command 的 receipt id 跨重试稳定；bound ingress 仅在 owner persistence 成功后 `204`，失败以非 2xx 触发同 receipt 重试；Server shutdown 排空已接受事件 |
| external View switch | CLI 通过 Core Resolver 与 typed Desktop focus socket，只聚焦已打开 View，不 Open/Attach/Resume/Spawn |
| Agent-owned CLI discovery | checkout-external packed consumer 的真实 PTY 从 injected `PATH` 执行 `agentmux --version`；fake Codex 同时复核 `AGENTMUX_ENV`、权威 `AGENTMUX_CLI` 与 Agent Session context；Fast suite 固定分组帮助、子命令成功语义、`next:` 和 `--skill` 的 fail-closed composition 边界；Desktop package smoke 在 `PATH=/usr/bin:/bin` 下证明 launcher 使用 `.app` 自带 Node runtime |
| Darwin endpoint bound | product endpoint 固定在 `/private/tmp/amx-<uid>-<artifact-id>` 且小于 104 bytes；package LaunchServices smoke 启动真实内置 ctxmuxd |

主 Oracle：`packages/core/test/package-consumer.integration.test.ts` 与 `packages/core/test/fixtures/packed-consumer.mjs`。

## POSIX signal 安全语义

Interrupt 使用 CtxMux 在 retained PTY 上的 `TIOCSIG`，由内核在 PTY owner 上执行，不经过 PID lookup gap。Stop 需要遍历完整 POSIX session/process tree；在 macOS 公共 API 上，身份重验与发信号之间仍有无法绝对消除的 PID reuse 窄窗。

CtxMux 的实际边界是：同一用户、本地、非提权 daemon；每次信号前重新验证 session identity；保留 zombie leader anchor；异常一律失败关闭；不把 daemon 当作多租户安全隔离。正常开发机风险接近工程零，但文档不伪造 `10^-N` 概率，也不宣称内核级绝对保证。提权或多租户部署不在支持范围。

## Gate

```bash
pnpm typecheck
pnpm test:fast       # pure domains, Desktop owners, no packed native fixture
pnpm test:native     # exact packed checkout-external CtxMux Shell vertical
pnpm test:real-codex # opt-in，使用用户现有 Codex CLI/auth，不读取或复制 Credential
pnpm check           # typecheck + fast + native + all builds
```

Fast 与 Native 分开是为了让失败归因清晰，不允许用 Mock 代替 Native proof。Native fixture 不开放产品 runtime path override；它在测试子进程里使用有界 synthetic uid，从而仍走 Darwin 固定路径规则，同时得到独立 socket/state、真实 packaged `ctxmuxd`、真实 PTY 和显式 PID/runtime cleanup。

## 未完成，不能外推

- 确定性 Codex/Agent Session、Hook、Permission、Resume 与 Stop-epoch prompt vertical 已完成；最终 candidate 已在用户现有 Codex `0.147.0` 与原位认证上通过 create/reconnect/resume/natural-retire E2E；
- resource soak、slow consumer、daemon crash/restart、security/fuzz 和最终 benchmark 仍由后续已审核 Task 补齐，不从当前 T-020 proof 外推；
- terminal screen proof 当前必须从 byte 0 连续重放；当 CtxMux 的 4 MiB retained Output 已淘汰 byte 0 时，后续 semantic prompt 会明确 `OUTPUT_GAP`，不会猜测 readiness。长期会话 checkpoint/snapshot 合同属于后续成熟度工作；
- headless replay 使用 attach snapshot 的当前 cols/rows，历史 Resize 时序尚未进入 Output stream，观察期间的 Resize 也不会直接更新该 screen。当前真实 Codex Gate 依赖 TUI resize 后全屏 redraw；在将此模型泛化到其他 TUI 前，必须补 Resize 失效或时序合同；
- Remote/SSH 属于 T-021；
- 当前 artifact 只支持 `darwin-arm64`，其他平台必须有自己的 exact manifest 和 Native proof，不能从本机结果推断。
