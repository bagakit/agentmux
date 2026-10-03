# AgentMux 测试策略

## 权威边界

AgentMux 只测试自己的公共 Core/Client 行为和 CtxMux public boundary，不读取 CtxMux wire、数据库、PID table 或私有模块。PTY、Replay、Signal 与 Stop 的底层正确性由固定 CtxMux source Gate 拥有；AgentMux 必须另做 checkout-external packed-boundary proof，证明打包和映射没有破坏这些能力。Agent-first 空间命令与 selector 合同见[空间 CLI 使用合同](../guides/agentmux-cli-object-control.md)，产品约束见[交互 SSOT](../design/agentmux-desktop-interaction.md)。本文拥有验证分层、任务验收与公开 oracle，不是当前候选的通过报告。命令来源是[根 package scripts](../../package.json)与 [Desktop package scripts](../../apps/desktop/package.json)，随包版本唯一取自 [vendor manifest](../../packages/core/vendor/ctxmux/darwin-arm64/manifest.json)。

Terminal output 是 raw PTY bytes 的 UTF-8 投影，不是模型上下文、Tool、Permission、Reply 或 Worker Done 证据。

## Suite 分层

| Lane | 命令 | 证明范围 |
| --- | --- | --- |
| Fast | `pnpm test:fast` | Pure domain、Store、Provider、Desktop owner 与 UI reducer；不启动 packaged native fixture。 |
| Native package | `pnpm test:native` | checkout 外 `pnpm pack`、offline install、真实 CtxMux PTY、Control handshake、Codex fixture、crash recovery 与公共 Runtime 边界；真实 SSH 与 Linux 资格单独执行。 |
| Security | `pnpm test:security` | ACP 默认拒绝、Hook 认证/Secret scope/队列上限、Store 上限、Control endpoint、Hook installer、Workspace 与 Browser 权限边界。 |
| Seeded fuzz | `pnpm test:fuzz` | 固定 seed/case 数的 Hook/Store/terminal byte 与 Workspace path 边界；失败可由测试名中的 seed 重放。 |
| Reliability | `pnpm test:reliability` | 16 个真实 Run、并发 Attachment、attach/detach churn、stop/input race、slow/fast Consumer、5 MiB 输出、live daemon `SIGKILL`、恢复与 Core 资源斜率。 |
| Desktop resources | `pnpm test:resources` | 隔离 runtime 中七轮 reusable Terminal claim、Terminal+Monaco 使用与 ready launcher 回归，另验证 Browser WebContents 释放和进程组 working-set 预算。 |
| Mounted Desktop | `pnpm --filter @agentmux/desktop package:mac` | [package-macos.mjs](../../apps/desktop/scripts/package-macos.mjs) 持有构建、DMG、挂载及安装身份核对，当前脚本还内置隔离 packaged probe；源码中的 probe 不代表本批已执行。功能与视觉验收在对应任务完成，打包消费已有结论，不另加全量回归、重复图审或无关任务等待作为安装前置。bundle identity、package report 与 artifact hash 须绑定同一 source commit/tree/version/platform/arch。 |
| Nightly | `pnpm test:nightly` | Native Package、Security、fuzz、reliability 和 Desktop resources 各执行一次；不重复 packed smoke 冒充 chaos。 |

Security/Fuzz 的 Input 证据由 public recoverable Input、option-like prompt、并发 prompt 与 stop/input race 提供；Workspace 除 rooted path、静态 symlink 与 seeded traversal 外，还会在 worker 固定 cwd 后交换父目录为 outside symlink，覆盖 read/list/reveal/create/write/move/delete；Secret 由随机 Hook bearer、私有 Stored Session、公共 Session/View 去密及 managed Hook receipt 边界提供；Permission 由 ACP default-reject/invalid decision/oversized event 提供；运行适配层只测试 AgentMux public error/Replay 投影，不 fuzz 或复制 CtxMux wire。

## Shell 与 Desktop 的验证义务

下表列出需要证明的行为及其 oracle；测试存在或过去通过不等于本轮候选通过。原 Shell checkpoint 的历史记录绑定 ctxmux commit `073e206407ce28331aa882c2c80e9354cfe2879a`、tree `3ddf0706c35517c0dd6bdf4d4f7fa251d88c0e0a`、protocol 13。该身份只描述原记录，不是当前 manifest，也不能把原结果改写成新协议的通过记录。

| 不变量 | AgentMux public oracle |
| --- | --- |
| exact artifact identity | manifest 唯一绑定随包 source commit/tree/protocol，build/runtime 复核 size/mode/SHA-256。核对随包产物与核对正在服务的 daemon 是两项事实。 |
| exact endpoint owner | [runtime-paths.ts](../../packages/core/src/runtime-paths.ts) 提供与 artifact 无关的稳定宿主 namespace，endpoint 临时目录与用户目录下的 durable state 分开；升级不能另建 Runtime。已有服务按公开身份、协议与能力核验，业务 dispatch 在实际连接上匹配 expected Runtime identity。owner receipt 缺失只限制清理权限并明确告知，不能阻断兼容服务上的健康 Run。 |
| checkout independence | `package-consumer.integration.test.ts` 在系统临时目录执行 `pnpm pack` 和 offline/no-save npm install；真实 package root 不在 checkout |
| one Run identity | 公共 `AgentMuxRunRef` 只有 CtxMux `runId`；重连后 RunId 与 PID 均不变 |
| ordered byte replay | fixture 拆分一个四字节 emoji 的两次 write；Client 不产生 replacement character；从 byte 7 interior cursor 重连后得到连续 suffix |
| recoverable Input | 公共 Input operation 保留 owner instance、operation id、expected byte 和 exact data；丢弃首次 receipt 并换 Client 重试后恢复同一 applied range，真实 PTY 只观察到一次输入 |
| Attachment lifecycle | 第一个 Client dispose 后 Run 继续，第二个 Client attach 同一 Run；detach/dispose 不 stop |
| Resize | public resize 到 `101x37`，真实 PTY 子进程从 TTY 读回并输出同一尺寸 |
| Interrupt | public `SIGINT` 经 CtxMux portable Interrupt；fixture 观察信号后继续 running |
| complete Stop | 忽略 HUP/TERM 的 root + child fixture 经 public Stop 后全部 PID 消失 |
| Remote boundary | `connectSshAgentMux` 组合系统 SSH 和唯一 Hosted SDK，连接远端已有 Core owner；真实远端 Provider、权限、原 Session／Run 恢复和原活跃终端阅读分别取得同源证据。此边界不宣称 ctxmux 独立 Remote Runtime 已交付。 |
| no second runtime | packed file list 和源码审计不得保留第二份 daemon、wire、journal 或 `node-pty` owner；公开可执行入口由 [Core package 的 bin](../../packages/core/package.json) 定义，随包 `ctxmux`/`ctxmuxd` 不是第二份实现。 |
| Agent identity resolver | AgentMux id、Provider + native id、ACP handle 与 exact RunRef 唯一解析；unknown/conflict/retired 失败关闭 |
| cross-process lifecycle | 两个真实 Node 进程竞争 Create/Resume，只允许一个 File Store reservation/CAS commit；Owner crash 按 CtxMux Run spec operation id 回收 orphan |
| natural terminal retire | public CtxMux status 证明 Run 已 terminal 后只退休语义绑定，不伪造 Stop 成功 |
| Codex terminal handshake | fake + real Codex 发出 terminal query；Core 只回复 flags 0 并持久化可恢复 Input receipt |
| Prompt readiness epoch | Core 的 [screen evidence](../../packages/core/src/screen-evidence.ts) 经 [terminalContinuationSteps](../../packages/core/src/terminal-continuation.ts) 消费公开 continuation、ordered bytes 与 Resize。证明 active composer、精确 Run 的 epoch/CAS 和投递边界；历史文本或 handshake 不能伪造 composer。Gap、checkpoint 不可用或观察未知不得猜成 ready，也不得禁用健康 Agent 的原生终端；结构化能力受限时保留服务窗说明。 |
| prompt crash recovery | payload 与 submit 各自使用确定性 operation id；Provider 分离实际 transport payload 与 TUI rendered logical text，只有当前 screen/cursor 的 composer 精确等于 renderedText 且 output 越过写入前 boundary 才发送 CR；bracketed paste 只由明确 Provider 选择，局部更新不要求重画 marker，历史同文、丢失 receipt 或进程 crash 都不能造成重复 payload/CR |
| typed Agent interaction | Core 验证 exact Session/Run/request/option，拒绝未知、重复或不完整 response；ACP delivery 与 semantic settlement、Native recoverable Input claim 分开证明。普通 Prompt 在 pending interaction 期间受限，原生 `writeAgent` 输入仍可用，不能把 typed response 路径变成对健康终端的封锁。accepted/unknown 不等于批准，不自动重放。 |
| terminal color capability | packed consumer 在父环境显式设置 `NO_COLOR=1`，真实 daemon/PTY child 仍观察到 `TERM=xterm-256color`、`COLORTERM=truecolor` 且 `NO_COLOR` 不存在 |
| Terminal appearance query | Desktop Main 在 Renderer 未 attach 时识别完整及跨 chunk OSC 10/11 query，等待 Core 发布 ready Agent Session 后才经 Core → CtxMux Input 回复当前 shared palette，不能与 Core Terminal handshake 竞争 Input cursor；Renderer replay handler 消费旧 query 而不重复注入 |
| Terminal/Explorer interaction | Fast suite 固定纯黑 Graphite 工作面、完整 ANSI 色槽、OSC parser、历史 Run 只读 fit、平台路径、Workspace Root reveal 边界、Move plan 与 Store action；Mounted Desktop 走真实 PointerSensor/drop、Radix `Move This Item to`、`Shift+F10`、invalid drop、500ms hover expand/cancel cleanup、Workspace 回访和 Workbench DnD overlay 隔离；Production build 证明 Search/WebLinks/WebGL/Context Menu 可打包 |
| Terminal interaction latency | Fast suite 证明 raw `terminal-output` 绕过全局 Zustand projection、输出 ACK 在单一在途调用后折叠到最新游标、pointer Split drag 只提交一次最终 ratio；viewport owner 在拖动中执行零 fit/resize、释放后只同步最终 grid，并继续证明必需的真实像素门控、latest-wins PTY resize 与 View dispose 丢弃排队 Resize；Attachment owner 线性化 Resize/Stop，Stop 撤销 lease 后迟到 Resize 不触达 ctxmux；慢启动 Agent 在 attach 后、首段输出前显示启动中，首段 Replay 或 Live 输出到达后立即让位给真实 TUI，失败或退出不伪装成启动中 |
| Agent exact-Run control | Native package consumer 在 provider-native Resume 后用旧 Run 调用 resize/stop，证明 `STALE_AGENT_SESSION` 发生前没有改变 rebound Run 的 runId、grid 或运行态；合法 exact Run resize 仍成功 |
| Workbench presentation persistence | [workbench-persistence.ts](../../apps/desktop/src/renderer/src/lib/workbench-persistence.ts) 保存 Tab Group、Region 树、焦点与持久内容描述（Agent、Terminal、File、GitDiff、Launcher、Browser），不保存活 WebContents 或复制 Run/PTY/状态。启动先恢复原工作面；空 snapshot、探测失败或 lease 未释放不能删除投影。健康 Run 自动 reattach；ended/missing Session 的恢复时机按 SSOT「冷启动按需恢复」。未被保存的 Runtime Session 不自动补 Tab，也不因未认领推断应杀掉健康 Run。 |
| Workbench View close transaction | Fast suite 冻结逐 Surface owner 的关闭计划，并确定性覆盖 Browser/Session cleanup 独立并发 dispatch、部分成功只保留失败 owner、retry 不重复已成功资源、同 View 重复 close 不重复 cleanup、共享 Session 的唯一 Stop 责任、关闭期间 View/Session admission、owner event 先于 receipt 的幂等收敛，以及 Recover/Refresh 的 exact Run epoch fence；旧 Stop receipt 不能删除新 Run，Recover owner 丢失后的 cleanup failure 必须留下可发现 View。Renderer 不建立第二份 Stop ledger、tail 或 fallback。 |
| Native Browser geometry | Fast suite 证明 DOM CSS bounds 会按当前 Renderer `webFrame` Zoom Factor 换算为 BrowserWindow DIP；100%、放大和缩小界面后原生网页仍贴合自己的 Region。窗口/侧栏交互缩放期间 Browser 不冻结旧 viewport，而是在最多一个 IPC 在途的前提下持续跟随，积压值只保留最新尺寸；瞬时零尺寸转为隐藏，Browser 已关闭后的迟到 bounds 幂等忽略而不弹全局错误 |
| Terminal Replay Gap recovery | 分别验证公开 continuation 可恢复当前画面、缺失历史如实提示，以及原始后缀不冒充完整屏幕。确需重绘的 Running Run 只经唯一 viewport owner 请求；Historical Run 与拖拽期间不写 PTY。重绘只能恢复当前画面，不能补回淘汰的 scrollback，也不能替代活跃会话连续向上阅读验收。 |
| Workspace Agent discovery | Fast suite 证明二级菜单只保留 Files、Agents、Browser；Agents 从现有 Session Snapshot 过滤当前 Workspace 的 Agent，复用 Board 状态分组和 `selectSession` 重开 View，不包含 Raw Terminal 或第二份 Session Registry |
| Workspace revision save | Owner tests 注入临时写入和替换故障并锁定原字节；Store tests 覆盖每文件串行、generation、close/reopen epoch、clean/dirty invalidation、Reload/Overwrite、删除与 read error；mounted oracle 走真实 Renderer → preload → IPC → `WorkspaceFiles`。 |
| Workspace atomic move | Main owner tests 在 destination-absent 后、最终 syscall 前制造竞争目标，并覆盖 no-follow、no-replace、typed unsupported；post-commit receipt matrix 覆盖 source/destination replacement、moved-back、双缺失、destination parent/Workspace Root 换代与 mutation/read interleave，所有场景都保持 `unknown`，不从 pathname occupancy 猜对象身份。Store tests 覆盖 save mutation admission、目标 owner 冲突、unknown 不改投影，以及 Document/Dirty/Last Active/Tab/Region/Selection/Expanded/changed observed payload 的一次性 segment-aware rekey；订阅断言证明每次 Rename 恰好一次 Explorer projection 引用变化，A→B→A 为零次。Fast interaction tests 固定同 parent、自身/后代与 loaded collision 的共享 plan、成功或 unknown 后恰好两 parent 并发去重刷新。Mounted Desktop 证明 Pointer/菜单只表达单项 Move、非法目标不提交、真实 input 驱动的 A→B→A 保持多选且产生零 Explorer projection 通知；commit barrier 另制造 A Move 已提交、B 已激活、旧 A closure 才继续的时序，证明一次路径事务通知之外两个 parent load 都被 Workspace identity/epoch admission 拒绝，B DOM/cache 不受污染，回 A 后由当前 owner 自行恢复。packaged helper 继续证明安装副本使用同一 no-replace owner。 |
| Hook acceptance/drain | Hook command 的 receipt id 跨重试稳定；bound ingress 仅在 owner persistence 成功后 `204`，失败以非 2xx 触发同 receipt 重试；Server shutdown 排空已接受事件 |
| Desktop Control owner | Fast suite 对真实 Renderer Store 验证 caller identity、Tab/Region 投影、四向 split、精确 focus、三类 typed open、send 唯一性、arrange 和 owner-loss rollback；bridge 测试证明跨 Electron world 只传普通 request/response/cancellation，所有布局 mutation 继续通过同一个 workbench reducer，ctxmux 只接收最终 viewport size |
| Packed Control CLI | checkout-external packed consumer 从 injected `PATH` 执行同版本 `agentmux`，通过一个版本化 endpoint 验证 `inspect/list/open/send/focus/arrange/output/interrupt/resume/stop`、稳定 JSON receipt、literal `--help` payload、UTF-8 分片和 peer early-close；Core endpoint 测试另锁定 protocol mismatch、closed target、typed candidates 与 owner unavailable error |
| Agent-owned CLI discovery | fake Codex 复核 `AGENTMUX_ENV`、权威 `AGENTMUX_CLI` 与 Agent Session identity；Fast suite 固定逐级帮助、typed flags、子命令成功语义和 `--skill` 的 fail-closed Control 边界；Desktop package smoke 在 `PATH=/usr/bin:/bin` 下证明 launcher 使用 `.app` 自带 Node runtime |
| Managed Agent 启动指南 | Core 验证开启、关闭、原任务与空任务的组装；Desktop 使用 [config-store.ts](../../apps/desktop/src/main/config-store.ts) 的当前 Executor 模型与默认配置，RuntimeController 把同一 Executor 交给 Core。历史 Config/Profile 版本不能充当现行合同。 |
| Darwin endpoint bound | 默认 Unix endpoint 按 runtime-paths.ts 的稳定短 namespace 构造，并与 durable state 分离；绝对路径 override 仍需验证平台 socket 长度边界。Native package/LaunchServices oracle 使用真实随包 ctxmuxd。 |
| bounded Consumer publication | Client 最多 64 个同步 listeners；callback 一旦返回 Promise 就立即自动退订，不建立隐式队列，也不在“忙碌期”静默漏掉仍注册 listener 的 lifecycle/permission 事件；永久 pending Promise 不保留 Client/Publisher。需要异步处理的 Consumer 必须在同步 callback 内复制到自己的有界队列；需要无损字节流则使用独立 Attachment/Replay |
| bounded Hook/ACP ingress | Hook 最多 256 binding、每 binding 8 个 unbound event 和 8 个 bound delivery；超限返回 `429`；stable binding identity 与随机 bearer 分离，公共 Session/View 不含二者；bound callback 接受 AbortSignal，timeout 期间 token 返回 `503`，旧 owner 真正 settle 后同 token 才恢复 admission；取消只作用于本次排队或执行中的 Store write，不能中止同 Agent Session 的前序 lifecycle/readiness 持久化；close/stop 排空已接收 delivery；ACP/Hook body 均有 128 KiB 硬上限 |
| daemon activation ownership | readiness 与 public handshake 确认服务，owner.json 记录启动归属。[CtxmuxRunAdapter](../../packages/core/src/ctxmux-run-adapter.ts) 中 receipt 保存失败不能终止兼容 daemon 或其健康 Run；归属不明应告知并限制清理。测试隔离进程的 cleanup 须证明精确 owner，不得外推为对用户 daemon 的强杀授权。 |

主 Oracle：`packages/core/test/package-consumer.integration.test.ts` 与 `packages/core/test/fixtures/packed-consumer.mjs`。

## Production Desktop Control smoke

该 oracle 在隔离 runtime 的 packaged `AgentMux.app` 上检查以下纵切；是否完成、是否通过须查本轮 receipt，不能从本文推断：

- ready receipt 确认 `packaged: true`；caller Agent Session 由 `.app` 内随包 Core/ctxmux artifact
  创建，packaged Desktop 从同一 Store 建立其唯一 Tab/Region 投影；
- 受管 caller 执行 `agentmux space inspect --tab self`，读取确切 Region ID，再用
  `agentmux agent open --executor <executor-id> --region <region-id> --split right`；
  receipt 的 `result.agent` 返回新 Agent Session/Run，`result.to` 返回实际空间地址，
  新 Run 的 public status 为 `running`；
- launch 前后 `owner.json.daemonInstanceId` 与 exact `ctxmuxd` PID 均不变；同一份受信 Core artifact
  从 checkout 搬到 packaged App 后可以继续使用原 daemon，receipt 中的启动路径只作诊断，不参与身份判断；
- 将随包 source/manifest 身份、正在服务的 Runtime identity/capability 与 cleanup 归属分别核对；
  兼容服务可以继续承载健康 Run，旧启动路径或缺失 owner receipt 不能代替不兼容判据；
- smoke 后通过公开 `agentmux agent stop --session <test-session-id>` 停止两个测试 Run，退出 test Desktop，确认没有隔离 runtime
  进程残留，再删除系统临时目录中的 test-only 子目录。

空间方向的非视觉合同由 Desktop Control/Layout 测试对真实 Layout Store/reducer
自动化锁定；此 mixed smoke 证明 packaged 跨进程 CLI → Desktop → Core → ctxmux 纵切。它不外推
多 Desktop、Remote/SSH 或 headless Control Host。

## Agent-first Space CLI 的私有纵切

`node apps/desktop/scripts/verify-space-agent-cli.mjs` 使用实际 CLI、Control socket、Desktop IPC、Main Git/config owner、Renderer Workbench 与公开 Core，创建独立目录、用户配置、Session Store 和 Native Runtime。五个普通 Electron 进程依次覆盖跨 Space 新 worktree/首 Tab/第一句任务、精确 Region 移动、后续 send、丢回执查询、durable 恢复、空首快照与仅意图已保存时的退出。

验收核对原 Session/Run/PID/native handle/cwd、完整 Tab/Group/Region/焦点、真实终端正文与 Chromium 键入；查询和重复 request 不执行第二次 Git、启动或投递。私有 Provider fixture 不证明上游 CLI 版本；普通 Electron 不代替已安装 App，flush 请求也不宣称 disk ACK。原始回执、变异与独立看图意见保存到本轮 Feature 的 acceptance 证据中。

## POSIX signal 安全语义

Interrupt 使用 CtxMux 在 retained PTY 上的 `TIOCSIG`，由内核在 PTY owner 上执行，不经过 PID lookup gap。Stop 需要遍历完整 POSIX session/process tree；在 macOS 公共 API 上，身份重验与发信号之间仍有无法绝对消除的 PID reuse 窄窗。

CtxMux 的实际边界是：同一用户、本地、非提权 daemon；每次信号前重新验证 session identity；保留 zombie leader anchor；异常一律失败关闭；不把 daemon 当作多租户安全隔离。正常开发机风险接近工程零，但文档不伪造 `10^-N` 概率，也不宣称内核级绝对保证。提权或多租户部署不在支持范围。

## Gate

UI 交付按 [独立 Agent 看图评审](../guides/agent-visual-e2e-review.md) 采图、实际看图、修正后重拍，并在打包或更新 Renderer 前消费本批候选的意见。首个 Message Tool 示例入口是 `pnpm --filter @agentmux/desktop capture:visual`。采图成功不判审美，preview API 的真实 Renderer 证据不冒充 CLI/Native；流程由 Agent 执行，不增加自动发布拦截器。

```bash
pnpm typecheck
pnpm test:fast       # pure domains, Desktop owners, no packed native fixture
pnpm test:native     # exact packed checkout-external CtxMux Shell vertical
pnpm test:security   # deterministic auth, permission, secret and bounded-owner checks
pnpm test:fuzz       # deterministic seeded public-boundary fuzz
pnpm test:reliability # native chaos/stress plus Core resource receipt
pnpm test:resources  # isolated Desktop resource receipt
pnpm --filter @agentmux/desktop package:mac # mounted DMG + LaunchServices workspace-file oracle
pnpm test:nightly    # native package + security + fuzz + reliability + resources, each exactly once
pnpm test:real-codex # opt-in，使用用户现有 Codex CLI/auth，不读取或复制 Credential
pnpm check           # typecheck + fast + native + all builds
```

Fast 与 Native 分开是为了让失败归因清晰，不允许用 Mock 代替 Native proof。Native fixture 使用独立 runtime/state 与真实 packaged `ctxmuxd`、真实 PTY；具体隔离方法以 harness 为准。产品进程级路径策略由 runtime-paths.ts 持有，不能把某一版 fixture 的 synthetic uid 方案写成「产品不支持 override」。清理只针对已证明归属的测试资源。

## 资源与故障证据

本节的代表数值和故障结果是历史观测，适用范围由对应 receipt 的源码、产物、Runtime、机器和场景身份决定；它们不证明当前候选已通过，也不替代本轮热路径的相关消费者成本检查。当前预算与 harness 是执行来源。

`test:reliability` 的 `agentmux.t017-reliability.v1` receipt 绑定 AgentMux HEAD、tracked diff 状态、精确 CtxMux commit/protocol/capability 和前后 daemon instance。代表性 darwin-arm64 观测中，daemon 基线约 5 MiB RSS/19 FD；16 个 idle Run 为约 8 MiB/67 FD；16 个 live Attachment 为约 8.4 MiB/83 FD；5 MiB 输出并保留 4 MiB replay 时约 19 MiB。斜率约为 179 KiB、2 threads、3 FD/Run，以及 27 KiB、1 FD/Attachment。精确数值随机器采样波动，Gate 比较冻结预算并把每轮原始 JSON 写入日志，不把这组代表值当固定等式。

停止 16 个 Run 后 child、Attachment 和 transient thread 全部归零；daemon 相对基线保留 32 FD，即 2 FD/历史 Run。这不是未追踪泄漏：固定 CtxMux commit 的 `reliability-budgets.json` 明确声明，在没有 global Run GC 时，exited Run metadata、retained PTY descriptors 与部分 RSS 是有界历史成本。AgentMux Gate 分别验收 live owner 释放与这项显式保留成本，不能把“历史仍可查询”误写成 Run 已被删除。

`test:resources` 的 `agentmux.t017-desktop-resources.v1` receipt 使用系统临时目录下的短、测试专属 Runtime；清理从 exact socket 的 `lsof` owner 出发，同时复核可用时的 `owner.json`、daemon path 与完整 argv，并在每次发信号前重验。Harness 先证明一个已 ready 但尚无 receipt 的真实 test-owned daemon 也能被精确清理，再运行 Desktop。receipt 从完整 ready-launcher process sample 计算 300 KiB xterm 输出、Monaco、Browser 和 release 增量，不为新的首屏基线预写未经测量的代表值。资源循环共七轮：前两轮显式记录 lazy-cache warm-up，后五轮以第一个 post-warmup 样本为 baseline，任一后续峰值相对它的增长必须低于 128 MiB；内存被系统回收后的下降不冒充泄漏。全部七轮 owner-clean release 样本与 browserReleased 都分别受 released-vs-ready-launcher increment 和 absolute total 硬上限约束，不能靠 warm-up 分类掩盖整体膨胀。Absolute total 保持 1 GiB；released increment 由该总上限减去 448 MiB 支持 baseline floor 得到 576 MiB，不再错误复用 Editor 的 512 MiB 增量预算。Fresh baseline 是首屏 reusable Terminal 已 ready 的真实产品态：0 Monaco model、0 document、0 file watcher、0 Browser WebContents、恰好 4 个全局 runtime subscription，以及恰好 1 个 Terminal View、3 或 4 个 Addon（取决于 WebGL 是否可用）、6 个 listener、1 个 Main Session Attachment owner 和 1 个 Renderer lease。每轮 claim 后继续使用同一 Run；stop 后必须出现从未使用过的新 reusable Terminal Session，并让完整 owner 集合精确回到 fresh baseline，不能复用已 stopped Session。打开 Browser 时 reusable Terminal 的 View 与 Attachment 会释放，但 backend Run 合法保留；关闭 Browser 后必须由同一个 Session 重新建立 ready launcher 并回到相同 owner baseline。多轮 steady-state peak growth 单独阻止持续泄漏；预算判断与完整进程样本保留在 Gate receipt，而不是只记录摘要。

live daemon `SIGKILL` 发生在 Run 与 Attachment 仍活跃时；fixture 证明 child 消失、同 Run ID 恢复为 historical/interrupted、崩溃前 Replay marker 保留，并由 replacement daemon 的不同 instance identity 证明没有复用死亡 Owner。slow Consumer 从 byte 0 读取时得到真实 Gap，另一 fast Consumer 仍连续收到超过 4 MiB 和最终 marker。

## 证据边界

- 真实 Codex `0.147.0` 与原位认证 E2E 覆盖 create、reconnect、resume 和 natural-retire；该结果只证明被执行的 Agent Session vertical；
- 固定规模的 security/fuzz、slow consumer、daemon crash/restart、chaos/stress 和 Core/Desktop resource ceiling 证明 correctness 与资源边界，不构成性能排名；
- latency、throughput、CPU/RSS 的对比结论需要独立的重复样本、outlier policy 和同条件 Benchmark，不能从 correctness/resource receipt 外推“全面胜出”；
- 当前 Core 已消费公开 `basic-vt` checkpoint、restore bytes 与 ordered Resize 的 continuation；来源为 terminal-continuation.ts、screen-evidence.ts 和 CtxmuxRunAdapter。存在这条实现不证明新候选画面或长期 scrollback 已验收；restore bytes 不能冒充新的 PTY output，缺失 checkpoint/历史或观察未知须如实表达；
- headless 与 Renderer 共用公开 continuation 顺序，各自拥有解释和像素；Runtime 持有字节、checkpoint 与 Resize 事实。不能再把「从 byte 0 重播且等 TUI 全屏 redraw」写成唯一现行恢复模型，也不能从当前画面恢复外推连续向上阅读历史通过；
- SSH 管理连接远端已有语义 owner，按当前公共 SDK／服务合同验证；本机通过记录不代签真实 SSH、远端 Provider 或桌面验收；
- 原生产物平台从 [artifact contract](../../packages/core/src/ctxmux-artifact-contract.json) 与对应 manifest 取得；每个平台必须有同源 Native proof，不能从本机结果推断。portable 空间 API 的可安装性与 Native Run 能力分别验证。

## 任务验收与假绿防护

实现 task 判 done 须同时有变异测试和产品调用者证明。变异是改坏实际实现，确认对应测试变红；不能只改测试制造红灯。调用者检查从实际源码范围检索 symbol，排除测试、生成物和定义文件本身；命中都在定义文件即竖切未闭合，如实标 blocked。可用 `rg -n "<symbol>" packages apps` 定位，再核对生产调用路径。纯函数的测试覆盖、同文件内部调用或接口声明都不能代替接到产品的证据。

新增或修改公共能力时，接口影响判断、原业务 owner 到 RPC／CLI 的真实接线及完成边界按[公共能力贡献约定](../guides/public-capability-contributions.md#同一任务交付和验收)核对；本节继续持有变异与调用者证明的方法，不另维护方法或命令全集。

扫描式契约测试必须先证明扫描有收获（如 `expect(found.size).toBeGreaterThan(0)`），再从来源反推约束，不维护与来源一起漂移的手写清单。豁免按具体选择器点名，不能全局放行某个数值。

切片扫描还须证明起止锚点都存在（各自 `expect(index).toBeGreaterThan(-1)`），并断言切出来的内容确实是目标片段。`indexOf` 返回 `-1` 时，`slice` 可能产出空串，让每条 `not.toContain` 恒真。守护来源：[sliced-scan-surface-not-empty.test.ts](../../apps/desktop/test/sliced-scan-surface-not-empty.test.ts)。

运行期集合的 `[].every(p)` 为 true，`[].some(p)` 为 false；测试这两个方向时，同一个 `it()` 必须证明集合非空。能用 `toEqual([...])` 钉死整体集合时优先这样写。反向断言对空集合会直接变红，不需要该守护；有意接受空集合时用紧贴上一行的 `// vacuous-ok:` 解释，不建集中豁免清单。守护来源：[vacuous-on-empty-predicate.test.ts](../../apps/desktop/test/vacuous-on-empty-predicate.test.ts)。这一族变异须按块把同一 `it()` 中该集合的每次读取都改为空，模拟生产「什么都不返回」；只在 `.every()` 调用点喂空集合无法证明整体守护有效。

纯文档任务核对来源、有效链接、冲突与语义保全；职责重组或硬约束改写需独立评审。没有实现变更时不制造代码变异或产品调用者证据；混合任务的代码部分仍过原验收。规范见[文档事实与维护](../guides/document-truth-and-maintenance.md)。
