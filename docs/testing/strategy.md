# AgentMux 测试策略

更新：2026-08-17

## 权威边界

AgentMux 只测试自己的公共 Core/Client 行为和 CtxMux public boundary，不读取 CtxMux wire、数据库、PID table 或私有模块。PTY、Replay、Signal 与 Stop 的底层正确性由固定 CtxMux source Gate 拥有；AgentMux 必须另做 checkout-external composition proof，证明打包和映射没有破坏这些能力。

Terminal output 是 raw PTY bytes 的 UTF-8 投影，不是模型上下文、Tool、Permission、Reply 或 Worker Done 证据。

## Suite 分层

| Lane | 命令 | 证明范围 |
| --- | --- | --- |
| Fast | `pnpm test:fast` | Pure domain、Store、Provider、Desktop owner 与 UI reducer；不启动 packaged native fixture。 |
| Native package | `pnpm test:native` | checkout 外 `pnpm pack`、offline install、真实 CtxMux PTY、CLI/Doctor、Codex fixture、crash recovery 与 Remote typed unsupported。 |
| Security | `pnpm test:security` | ACP 默认拒绝、Hook 认证/Secret scope/队列上限、Store 上限、Focus socket、Hook installer、Workspace 与 Browser 权限边界。 |
| Seeded fuzz | `pnpm test:fuzz` | 固定 seed/case 数的 Hook/Store/terminal byte 与 Workspace path 边界；失败可由测试名中的 seed 重放。 |
| Reliability | `pnpm test:reliability` | 16 个真实 Run、并发 Attachment、attach/detach churn、stop/input race、slow/fast Consumer、5 MiB 输出、live daemon `SIGKILL`、恢复与 Core 资源斜率。 |
| Desktop resources | `pnpm test:resources` | 隔离 runtime 中五轮 Terminal+Monaco 创建/释放、Browser WebContents 释放、owner 回归 idle 基线与进程组 working-set 预算。 |
| Nightly | `pnpm test:nightly` | Native Package/Doctor、Security、fuzz、reliability 和 Desktop resources 各执行一次；不重复 packed smoke 冒充 chaos。 |

Security/Fuzz 的 Input 证据由 public recoverable Input、option-like prompt、并发 prompt 与 stop/input race 提供；Workspace 除 rooted path、静态 symlink 与 seeded traversal 外，还会在 worker 固定 cwd 后交换父目录为 outside symlink，覆盖 read/list/reveal/create/write/rename/delete；Secret 由随机 Hook bearer、私有 Stored Session、公共 Session/View 去密及 managed Hook receipt 边界提供；Permission 由 ACP default-reject/invalid decision/oversized event 提供；Adapter 只测试 AgentMux public error/Replay 投影，不 fuzz 或复制 CtxMux wire。

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
| bounded Consumer publication | Client 最多 64 个同步 listeners；callback 一旦返回 Promise 就立即自动退订，不建立隐式队列，也不在“忙碌期”静默漏掉仍注册 listener 的 lifecycle/permission 事件；永久 pending Promise 不保留 Client/Publisher。需要异步处理的 Consumer 必须在同步 callback 内复制到自己的有界队列；需要无损字节流则使用独立 Attachment/Replay |
| bounded Hook/ACP ingress | Hook 最多 256 binding、每 binding 8 个 unbound event 和 8 个 bound delivery；超限返回 `429`；stable binding identity 与随机 bearer 分离，公共 Session/View 不含二者；bound callback 接受 AbortSignal，timeout 期间 token 返回 `503`，旧 owner 真正 settle 后同 token 才恢复 admission；取消只作用于本次排队或执行中的 Store write，不能中止同 Agent Session 的前序 lifecycle/readiness 持久化；close/stop 排空已接收 delivery；ACP/Hook body 均有 128 KiB 硬上限 |
| packaged Doctor | checkout-external packed CLI 的真实 `agentmux doctor --json` 报告 exact CtxMux capability、Local available、Remote unsupported、Provider/Hook/ACP/Permission 边界 |
| daemon activation ownership | spawned `ctxmuxd` 的 readiness、public handshake 与 `owner.json` 原子提交处于同一 cleanup guard；receipt rename 失败的 checkout-external fixture 要求精确 child 在 `connect()` 返回前完成 TERM/KILL + reap，且不遗留临时 receipt。Desktop harness 另启动一个没有 `owner.json` 的真实 daemon，仅凭测试专属随机 socket owner、artifact path 与完整 argv 精确识别并清理，覆盖 Desktop 在 readiness 与 receipt 之间崩溃的窗口。 |

主 Oracle：`packages/core/test/package-consumer.integration.test.ts` 与 `packages/core/test/fixtures/packed-consumer.mjs`。

## POSIX signal 安全语义

Interrupt 使用 CtxMux 在 retained PTY 上的 `TIOCSIG`，由内核在 PTY owner 上执行，不经过 PID lookup gap。Stop 需要遍历完整 POSIX session/process tree；在 macOS 公共 API 上，身份重验与发信号之间仍有无法绝对消除的 PID reuse 窄窗。

CtxMux 的实际边界是：同一用户、本地、非提权 daemon；每次信号前重新验证 session identity；保留 zombie leader anchor；异常一律失败关闭；不把 daemon 当作多租户安全隔离。正常开发机风险接近工程零，但文档不伪造 `10^-N` 概率，也不宣称内核级绝对保证。提权或多租户部署不在支持范围。

## Gate

```bash
pnpm typecheck
pnpm test:fast       # pure domains, Desktop owners, no packed native fixture
pnpm test:native     # exact packed checkout-external CtxMux Shell vertical
pnpm test:security   # deterministic auth, permission, secret and bounded-owner checks
pnpm test:fuzz       # deterministic seeded public-boundary fuzz
pnpm test:reliability # native chaos/stress plus Core resource receipt
pnpm test:resources  # isolated Desktop resource receipt
pnpm test:nightly    # native package/Doctor + security + fuzz + reliability + resources, each exactly once
pnpm test:real-codex # opt-in，使用用户现有 Codex CLI/auth，不读取或复制 Credential
pnpm check           # typecheck + fast + native + all builds
```

Fast 与 Native 分开是为了让失败归因清晰，不允许用 Mock 代替 Native proof。Native fixture 不开放产品 runtime path override；它在测试子进程里使用有界 synthetic uid，从而仍走 Darwin 固定路径规则，同时得到独立 socket/state、真实 packaged `ctxmuxd`、真实 PTY 和显式 PID/runtime cleanup。

## T-017 资源与故障证据

`test:reliability` 的 `agentmux.t017-reliability.v1` receipt 绑定 AgentMux HEAD、tracked diff 状态、精确 CtxMux commit/protocol/capability 和前后 daemon instance。2026-08-17 的代表性 darwin-arm64 观测中，daemon 基线约 5 MiB RSS/19 FD；16 个 idle Run 为约 8 MiB/67 FD；16 个 live Attachment 为约 8.4 MiB/83 FD；5 MiB 输出并保留 4 MiB replay 时约 19 MiB。斜率约为 179 KiB、2 threads、3 FD/Run，以及 27 KiB、1 FD/Attachment。精确数值随机器采样波动，Gate 比较冻结预算并把每轮原始 JSON 写入日志，不把这组代表值当固定等式。

停止 16 个 Run 后 child、Attachment 和 transient thread 全部归零；daemon 相对基线保留 32 FD，即 2 FD/历史 Run。这不是未追踪泄漏：固定 CtxMux commit 的 `reliability-budgets.json` 明确声明，在没有 global Run GC 时，exited Run metadata、retained PTY descriptors 与部分 RSS 是有界历史成本。AgentMux Gate 分别验收 live owner 释放与这项显式保留成本，不能把“历史仍可查询”误写成 Run 已被删除。

`test:resources` 的 `agentmux.t017-desktop-resources.v1` receipt 使用 `/private/tmp` 下的短、测试专属 Runtime；清理从 exact socket 的 `lsof` owner 出发，同时复核可用时的 `owner.json`、daemon path 与完整 argv，并在每次发信号前重验。Harness 先证明一个已 ready 但尚无 receipt 的真实 test-owned daemon 也能被精确清理，再运行 Desktop。代表性观测的 Desktop idle working set 约 450～500 MiB，300 KiB xterm 输出增量约 70～125 MiB，Monaco 首次加载与 Chromium cache 增量约 130～370 MiB。资源循环共七轮：前两轮显式记录 lazy-cache warm-up，后五轮以第一个 post-warmup 样本为 baseline，任一后续峰值相对它的增长必须低于 128 MiB；内存被系统回收后的下降不冒充泄漏。全部七轮 owner-clean release 样本与 browserReleased 都分别受 released-vs-idle increment 和 absolute total 硬上限约束，不能靠 warm-up 分类掩盖整体膨胀。Absolute total 保持 1 GiB；released increment 由该总上限减去 448 MiB 支持 idle floor 得到 576 MiB，不再错误复用 Editor 的 512 MiB 增量预算。Fresh idle 必须是 0 Monaco model、0 document、0 file watcher、0 Browser WebContents、0 Terminal/xterm owner、0 Main Session Attachment owner/lease 和恰好 3 个全局 runtime subscription；Terminal live phase 必须正好有 1 个 Main Attachment owner、1 个 Renderer lease，并显式计数 View、Addon 与 listener，释放后全部回到零。多轮 steady-state peak growth 单独阻止持续泄漏；预算判断与完整进程样本保留在 Gate receipt，而不是只记录摘要。

live daemon `SIGKILL` 发生在 Run 与 Attachment 仍活跃时；fixture 证明 child 消失、同 Run ID 恢复为 historical/interrupted、崩溃前 Replay marker 保留，并由 replacement daemon 的不同 instance identity 证明没有复用死亡 Owner。slow Consumer 从 byte 0 读取时得到真实 Gap，另一 fast Consumer 仍连续收到超过 4 MiB 和最终 marker。

## 未完成，不能外推

- 确定性 Codex/Agent Session、Hook、Permission、Resume 与 Stop-epoch prompt vertical 已完成；最终 candidate 已在用户现有 Codex `0.147.0` 与原位认证上通过 create/reconnect/resume/natural-retire E2E；
- T-017 已补齐固定规模的 security/fuzz、slow consumer、daemon crash/restart、chaos/stress 和 Core/Desktop resource ceiling；这些 correctness/resource 证据不是性能排名；
- T-018 才冻结最终 candidate 的 latency、throughput、CPU/RSS 对比方法、重复样本、outlier policy 与 tmux/竞品 Benchmark；当前 T-017 receipt 不能外推“全面胜出”；
- terminal screen proof 当前必须从 byte 0 连续重放；当 CtxMux 的 4 MiB retained Output 已淘汰 byte 0 时，后续 semantic prompt 会明确 `OUTPUT_GAP`，不会猜测 readiness。长期会话 checkpoint/snapshot 合同属于后续成熟度工作；
- headless replay 使用 attach snapshot 的当前 cols/rows，历史 Resize 时序尚未进入 Output stream，观察期间的 Resize 也不会直接更新该 screen。当前真实 Codex Gate 依赖 TUI resize 后全屏 redraw；在将此模型泛化到其他 TUI 前，必须补 Resize 失效或时序合同；
- Remote/SSH 属于 T-021；
- 当前 artifact 只支持 `darwin-arm64`，其他平台必须有自己的 exact manifest 和 Native proof，不能从本机结果推断。
