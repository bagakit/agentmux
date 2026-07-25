# AgentMux 测试策略

## 权威边界

AgentMux 只测试自己的公共 Core/Client 行为和 CtxMux public boundary，不读取 CtxMux wire、数据库、PID table 或私有模块。PTY、Replay、Signal 与 Stop 的底层正确性由固定 CtxMux source Gate 拥有；AgentMux 必须另做 checkout-external packed-boundary proof，证明打包和映射没有破坏这些能力。本文的 Desktop Composition 专指 Pane/Tab/View 空间合同，不与 package composition 混用。

Terminal output 是 raw PTY bytes 的 UTF-8 投影，不是模型上下文、Tool、Permission、Reply 或 Worker Done 证据。

## Suite 分层

| Lane | 命令 | 证明范围 |
| --- | --- | --- |
| Fast | `pnpm test:fast` | Pure domain、Store、Provider、Desktop owner 与 UI reducer；不启动 packaged native fixture。 |
| Native package | `pnpm test:native` | checkout 外 `pnpm pack`、offline install、真实 CtxMux PTY、分组 CLI/Composition handshake、Codex fixture、crash recovery 与 Remote typed unsupported。 |
| Security | `pnpm test:security` | ACP 默认拒绝、Hook 认证/Secret scope/队列上限、Store 上限、Composition endpoint、Hook installer、Workspace 与 Browser 权限边界。 |
| Seeded fuzz | `pnpm test:fuzz` | 固定 seed/case 数的 Hook/Store/terminal byte 与 Workspace path 边界；失败可由测试名中的 seed 重放。 |
| Reliability | `pnpm test:reliability` | 16 个真实 Run、并发 Attachment、attach/detach churn、stop/input race、slow/fast Consumer、5 MiB 输出、live daemon `SIGKILL`、恢复与 Core 资源斜率。 |
| Desktop resources | `pnpm test:resources` | 隔离 runtime 中七轮 reusable Terminal claim、Terminal+Monaco 使用与 ready launcher 回归，另验证 Browser WebContents 释放和进程组 working-set 预算。 |
| Mounted Desktop | `pnpm --filter @agentmux/desktop package:mac` | 唯一 packaging owner 先固定 clean HEAD/tree，再依次执行 Desktop/Core build、DMG 构建、只读挂载、复制安装和 LaunchServices packaged probe；真实 `webContents.sendInputEvent` 证明 revision save、外部冲突、原子替换故障、PointerSensor、Radix Context Menu、`Shift+F10`、hover/cancel cleanup、Workspace 回访和 bundled no-replace move helper。owner 在 package report 与 artifact hashing 后再次核对同一 source commit/tree/clean 状态，并输出 packaged executable 与 DMG SHA-256；证明仍由同一个 packaged Electron owner 持有，不新增 public IPC、第二套 harness 或产品 Runtime owner。 |
| Nightly | `pnpm test:nightly` | Native Package、Security、fuzz、reliability 和 Desktop resources 各执行一次；不重复 packed smoke 冒充 chaos。 |

Security/Fuzz 的 Input 证据由 public recoverable Input、option-like prompt、并发 prompt 与 stop/input race 提供；Workspace 除 rooted path、静态 symlink 与 seeded traversal 外，还会在 worker 固定 cwd 后交换父目录为 outside symlink，覆盖 read/list/reveal/create/write/move/delete；Secret 由随机 Hook bearer、私有 Stored Session、公共 Session/View 去密及 managed Hook receipt 边界提供；Permission 由 ACP default-reject/invalid decision/oversized event 提供；运行适配层只测试 AgentMux public error/Replay 投影，不 fuzz 或复制 CtxMux wire。

## 当前 Shell checkpoint proof map

| 不变量 | AgentMux public oracle |
| --- | --- |
| exact artifact identity | pack 内 manifest 固定 commit `1603908a253162632e8812ceb9db19c3e416fea4`、tree `464f239190234c8369799dca06a630b3b48f5cca`、protocol 13，并在 build/runtime 复核 size/mode/SHA-256 |
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
| Terminal/Explorer interaction | Fast suite 固定纯黑 Graphite 工作面、完整 ANSI 色槽、OSC parser、历史 Run 只读 fit、平台路径、Workspace Root reveal 边界、Move plan 与 Store action；Mounted Desktop 走真实 PointerSensor/drop、Radix `Move This Item to`、`Shift+F10`、invalid drop、500ms hover expand/cancel cleanup、Workspace 回访和 Workbench DnD overlay 隔离；Production build 证明 Search/WebLinks/WebGL/Context Menu 可打包 |
| Terminal interaction latency | Fast suite 证明 raw `terminal-output` 绕过全局 Zustand projection、输出 ACK 在单一在途调用后折叠到最新游标、pointer Split drag 只提交一次最终 ratio；viewport owner 在拖动中执行零 fit/resize、释放后只同步最终 grid，并继续证明必需的真实像素门控、latest-wins PTY resize 与 View dispose 丢弃排队 Resize；Attachment owner 线性化 Resize/Stop，Stop 撤销 lease 后迟到 Resize 不触达 ctxmux；慢启动 Agent 在 attach 后、首段输出前显示启动中，首段 Replay 或 Live 输出到达后立即让位给真实 TUI，失败或退出不伪装成启动中 |
| Agent exact-Run control | Native package consumer 在 provider-native Resume 后用旧 Run 调用 resize/stop，证明 `STALE_AGENT_SESSION` 发生前没有改变 rebound Run 的 runId、grid 或运行态；合法 exact Run resize 仍成功 |
| Workbench presentation persistence | Fast suite 证明 Zustand 只持久化 attached Agent/Terminal 的 Tab Group 与 Tab 内 Region 树；三块 Region 重启后仍是一张 View，ratio 和方向不变；已结束 Session 只折叠自己的 Region，未被持久化 View 表示的 Runtime Session 不得自动补成 Tab；默认创建页的 reusable Terminal 可以预热，但 Desktop 必须精确记录未认领 Session ID，重启时只清理并排除这些 Session，不能让它们冒成 Tab；不复制 Run、PTY、Replay 或 Agent 状态 |
| Workbench View close transaction | Fast suite 冻结逐 Surface owner 的关闭计划，并确定性覆盖 Browser/Session cleanup 独立并发 dispatch、部分成功只保留失败 owner、retry 不重复已成功资源、同 View 重复 close 不重复 cleanup、共享 Session 的唯一 Stop 责任、关闭期间 View/Session admission、owner event 先于 receipt 的幂等收敛，以及 Recover/Refresh 的 exact Run epoch fence；旧 Stop receipt 不能删除新 Run，Recover owner 丢失后的 cleanup failure 必须留下可发现 View。Renderer 不建立第二份 Stop ledger、tail 或 fallback。 |
| Native Browser geometry | Fast suite 证明 DOM CSS bounds 会按当前 Renderer `webFrame` Zoom Factor 换算为 BrowserWindow DIP；100%、放大和缩小界面后原生网页仍贴合自己的 Region。窗口/侧栏交互缩放期间 Browser 不冻结旧 viewport，而是在最多一个 IPC 在途的前提下持续跟随，积压值只保留最新尺寸；瞬时零尺寸转为隐藏，Browser 已关闭后的迟到 bounds 幂等忽略而不弹全局错误 |
| Terminal Replay Gap recovery | Fast suite 证明 Running Run 在保留 Replay 之后只经 viewport owner 提交“临时少一行 → 最终 grid”的重绘请求，Historical Run 与交互拖拽不写 PTY；Gap 提示位于 xterm 字节流之外并只对 Running Run 提供手动重绘 |
| Workspace Agent discovery | Fast suite 证明二级菜单只保留 Files、Agents、Browser；Agents 从现有 Session Snapshot 过滤当前 Workspace 的 Agent，复用 Board 状态分组和 `selectSession` 重开 View，不包含 Raw Terminal 或第二份 Session Registry |
| Workspace revision save | Owner tests 注入临时写入和替换故障并锁定原字节；Store tests 覆盖每文件串行、generation、close/reopen epoch、clean/dirty invalidation、Reload/Overwrite、删除与 read error；mounted oracle 走真实 Renderer → preload → IPC → `WorkspaceFiles`。 |
| Workspace atomic move | Main owner tests 在 destination-absent 后、最终 syscall 前制造竞争目标，并覆盖 no-follow、no-replace、typed unsupported；post-commit receipt matrix 覆盖 source/destination replacement、moved-back、双缺失、destination parent/Workspace Root 换代与 mutation/read interleave，所有场景都保持 `unknown`，不从 pathname occupancy 猜对象身份。Store tests 覆盖 save mutation admission、目标 owner 冲突、unknown 不改投影，以及 Document/Dirty/Last Active/Tab/Region/Selection/Expanded/changed observed payload 的一次性 segment-aware rekey；订阅断言证明每次 Rename 恰好一次 Explorer projection 引用变化，A→B→A 为零次。Fast interaction tests 固定同 parent、自身/后代与 loaded collision 的共享 plan、成功或 unknown 后恰好两 parent 并发去重刷新。Mounted Desktop 证明 Pointer/菜单只表达单项 Move、非法目标不提交、真实 input 驱动的 A→B→A 保持多选且产生零 Explorer projection 通知；commit barrier 另制造 A Move 已提交、B 已激活、旧 A closure 才继续的时序，证明一次路径事务通知之外两个 parent load 都被 Workspace identity/epoch admission 拒绝，B DOM/cache 不受污染，回 A 后由当前 owner 自行恢复。packaged helper 继续证明安装副本使用同一 no-replace owner。 |
| Hook acceptance/drain | Hook command 的 receipt id 跨重试稳定；bound ingress 仅在 owner persistence 成功后 `204`，失败以非 2xx 触发同 receipt 重试；Server shutdown 排空已接受事件 |
| Desktop Composition owner | Fast suite 对真实 Renderer Store 验证唯一 caller context、当前 View 全部 Region 的归一化 bounds、同 Pane Tab、四向 split、精确 focus、配置 Agent launch、ambiguous/stale target、launch failure 与 Renderer/View owner-loss rollback；三块不对称布局会暴露左侧整块与右上/右下，Agent 因而能选精确左 Region 形成 2×2；bridge 测试证明跨 Electron world 只传取消消息并由 Renderer 创建真实 AbortSignal；所有布局 mutation 继续通过同一个 workbench reducer，ctxmux 只接收最终 viewport size |
| Packed Composition CLI | checkout-external packed consumer 从 injected `PATH` 执行同版本 `agentmux`，通过一个版本化 endpoint 验证受管 caller、context/launch/open/focus、JSON receipt、literal `--help` prompt、分组 Session 命令、deleted flat surface 与 `session output --follow` JSON Lines；Core endpoint 测试另锁定 protocol mismatch、closed target 与 owner unavailable error |
| Agent-owned CLI discovery | fake Codex 复核 `AGENTMUX_ENV`、权威 `AGENTMUX_CLI` 与 Agent Session context；Fast suite 固定逐级帮助、typed flags、子命令成功语义、`next:` 和 `--skill` 的 fail-closed Composition 边界；Desktop package smoke 在 `PATH=/usr/bin:/bin` 下证明 launcher 使用 `.app` 自带 Node runtime |
| Managed Agent 启动指南 | Core 纯测试固定开启、关闭、原任务和空任务的组装结果；Desktop 测试固定 Config v5 的逐 Profile 开关、内置 Profile 默认开启，内置 Grok Profile 默认使用 `--permission-mode bypassPermissions`，并证明 RuntimeController 把同一份 Profile 原样交给 Core |
| Darwin endpoint bound | product endpoint 固定在 `/private/tmp/amx-<uid>-<artifact-id>` 且小于 104 bytes；package LaunchServices smoke 启动真实内置 ctxmuxd |
| bounded Consumer publication | Client 最多 64 个同步 listeners；callback 一旦返回 Promise 就立即自动退订，不建立隐式队列，也不在“忙碌期”静默漏掉仍注册 listener 的 lifecycle/permission 事件；永久 pending Promise 不保留 Client/Publisher。需要异步处理的 Consumer 必须在同步 callback 内复制到自己的有界队列；需要无损字节流则使用独立 Attachment/Replay |
| bounded Hook/ACP ingress | Hook 最多 256 binding、每 binding 8 个 unbound event 和 8 个 bound delivery；超限返回 `429`；stable binding identity 与随机 bearer 分离，公共 Session/View 不含二者；bound callback 接受 AbortSignal，timeout 期间 token 返回 `503`，旧 owner 真正 settle 后同 token 才恢复 admission；取消只作用于本次排队或执行中的 Store write，不能中止同 Agent Session 的前序 lifecycle/readiness 持久化；close/stop 排空已接收 delivery；ACP/Hook body 均有 128 KiB 硬上限 |
| daemon activation ownership | spawned `ctxmuxd` 的 readiness、public handshake 与 `owner.json` 原子提交处于同一 cleanup guard；receipt rename 失败的 checkout-external fixture 要求精确 child 在 `connect()` 返回前完成 TERM/KILL + reap，且不遗留临时 receipt。Desktop harness 另启动一个没有 `owner.json` 的真实 daemon，仅凭测试专属随机 socket owner、artifact path 与完整 argv 精确识别并清理，覆盖 Desktop 在 readiness 与 receipt 之间崩溃的窗口。 |

主 Oracle：`packages/core/test/package-consumer.integration.test.ts` 与 `packages/core/test/fixtures/packed-consumer.mjs`。

## Production Desktop Composition smoke

在 `pnpm package:mac` 产出的 `AgentMux.app` 上完成一次隔离 runtime 的真实 mixed smoke：

- ready receipt 确认 `packaged: true`；caller Agent Session 由 `.app` 内随包 Core/ctxmux artifact
  创建，packaged Desktop 从同一 Store 建立其唯一 View；
- 受管 caller 先执行 `agentmux context`，再执行
  `agentmux launch --agent codex --placement split-right --relative-to self`；launch receipt 返回新的
  Agent Session/View，且新 `paneId` 与 caller `paneId` 不同；新 Run 的 public status 为 `running`；
- launch 前后 `owner.json.daemonInstanceId` 与 exact `ctxmuxd` PID 均不变；同一份受信 Core artifact
  从 checkout 搬到 packaged App 后可以继续使用原 daemon，receipt 中的启动路径只作诊断，不参与身份判断；
- owner 身份继续精确绑定 source commit/tree、manifest/daemon hash、runtime endpoint 和 daemon instance；
  任一身份字段不一致都会被拒绝，不能仅凭协议相同接管；
- smoke 后通过公开 `session stop` 停止两个测试 Run，退出 test Desktop，确认没有隔离 runtime
  进程残留，再删除 test-only `/private/tmp` 目录。

空间方向的非视觉合同由 `apps/desktop/test/composition.test.ts` 对真实 Layout Store/reducer
自动化锁定；此 mixed smoke 证明 packaged 跨进程 CLI → Desktop → Core → ctxmux 纵切。它不外推
多 Desktop、Remote/SSH、布局持久化或 headless Composition Owner。

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
pnpm --filter @agentmux/desktop package:mac # mounted DMG + LaunchServices workspace-file oracle
pnpm test:nightly    # native package + security + fuzz + reliability + resources, each exactly once
pnpm test:real-codex # opt-in，使用用户现有 Codex CLI/auth，不读取或复制 Credential
pnpm check           # typecheck + fast + native + all builds
```

Fast 与 Native 分开是为了让失败归因清晰，不允许用 Mock 代替 Native proof。Native fixture 不开放产品 runtime path override；它在测试子进程里使用有界 synthetic uid，从而仍走 Darwin 固定路径规则，同时得到独立 socket/state、真实 packaged `ctxmuxd`、真实 PTY 和显式 PID/runtime cleanup。

## 资源与故障证据

`test:reliability` 的 `agentmux.t017-reliability.v1` receipt 绑定 AgentMux HEAD、tracked diff 状态、精确 CtxMux commit/protocol/capability 和前后 daemon instance。代表性 darwin-arm64 观测中，daemon 基线约 5 MiB RSS/19 FD；16 个 idle Run 为约 8 MiB/67 FD；16 个 live Attachment 为约 8.4 MiB/83 FD；5 MiB 输出并保留 4 MiB replay 时约 19 MiB。斜率约为 179 KiB、2 threads、3 FD/Run，以及 27 KiB、1 FD/Attachment。精确数值随机器采样波动，Gate 比较冻结预算并把每轮原始 JSON 写入日志，不把这组代表值当固定等式。

停止 16 个 Run 后 child、Attachment 和 transient thread 全部归零；daemon 相对基线保留 32 FD，即 2 FD/历史 Run。这不是未追踪泄漏：固定 CtxMux commit 的 `reliability-budgets.json` 明确声明，在没有 global Run GC 时，exited Run metadata、retained PTY descriptors 与部分 RSS 是有界历史成本。AgentMux Gate 分别验收 live owner 释放与这项显式保留成本，不能把“历史仍可查询”误写成 Run 已被删除。

`test:resources` 的 `agentmux.t017-desktop-resources.v1` receipt 使用 `/private/tmp` 下的短、测试专属 Runtime；清理从 exact socket 的 `lsof` owner 出发，同时复核可用时的 `owner.json`、daemon path 与完整 argv，并在每次发信号前重验。Harness 先证明一个已 ready 但尚无 receipt 的真实 test-owned daemon 也能被精确清理，再运行 Desktop。receipt 从完整 ready-launcher process sample 计算 300 KiB xterm 输出、Monaco、Browser 和 release 增量，不为新的首屏基线预写未经测量的代表值。资源循环共七轮：前两轮显式记录 lazy-cache warm-up，后五轮以第一个 post-warmup 样本为 baseline，任一后续峰值相对它的增长必须低于 128 MiB；内存被系统回收后的下降不冒充泄漏。全部七轮 owner-clean release 样本与 browserReleased 都分别受 released-vs-ready-launcher increment 和 absolute total 硬上限约束，不能靠 warm-up 分类掩盖整体膨胀。Absolute total 保持 1 GiB；released increment 由该总上限减去 448 MiB 支持 baseline floor 得到 576 MiB，不再错误复用 Editor 的 512 MiB 增量预算。Fresh baseline 是首屏 reusable Terminal 已 ready 的真实产品态：0 Monaco model、0 document、0 file watcher、0 Browser WebContents、恰好 4 个全局 runtime subscription，以及恰好 1 个 Terminal View、3 或 4 个 Addon（取决于 WebGL 是否可用）、6 个 listener、1 个 Main Session Attachment owner 和 1 个 Renderer lease。每轮 claim 后继续使用同一 Run；stop 后必须出现从未使用过的新 reusable Terminal Session，并让完整 owner 集合精确回到 fresh baseline，不能复用已 stopped Session。打开 Browser 时 reusable Terminal 的 View 与 Attachment 会释放，但 backend Run 合法保留；关闭 Browser 后必须由同一个 Session 重新建立 ready launcher 并回到相同 owner baseline。多轮 steady-state peak growth 单独阻止持续泄漏；预算判断与完整进程样本保留在 Gate receipt，而不是只记录摘要。

live daemon `SIGKILL` 发生在 Run 与 Attachment 仍活跃时；fixture 证明 child 消失、同 Run ID 恢复为 historical/interrupted、崩溃前 Replay marker 保留，并由 replacement daemon 的不同 instance identity 证明没有复用死亡 Owner。slow Consumer 从 byte 0 读取时得到真实 Gap，另一 fast Consumer 仍连续收到超过 4 MiB 和最终 marker。

## 证据边界

- 真实 Codex `0.147.0` 与原位认证 E2E 覆盖 create、reconnect、resume 和 natural-retire；该结果只证明被执行的 Agent Session vertical；
- 固定规模的 security/fuzz、slow consumer、daemon crash/restart、chaos/stress 和 Core/Desktop resource ceiling 证明 correctness 与资源边界，不构成性能排名；
- latency、throughput、CPU/RSS 的对比结论需要独立的重复样本、outlier policy 和同条件 Benchmark，不能从 correctness/resource receipt 外推“全面胜出”；
- terminal screen proof 当前必须从 byte 0 连续重放；当 CtxMux 的 4 MiB retained Output 已淘汰 byte 0 时，后续 semantic prompt 会明确 `OUTPUT_GAP`，不会猜测 readiness。长期会话 checkpoint/snapshot 合同属于后续成熟度工作；
- headless replay 使用 attach snapshot 的当前 cols/rows，历史 Resize 时序尚未进入 Output stream，观察期间的 Resize 也不会直接更新该 screen。当前真实 Codex Gate 依赖 TUI resize 后全屏 redraw；在将此模型泛化到其他 TUI 前，必须补 Resize 失效或时序合同；
- Remote/SSH 的 Agent runtime 仍为 typed unsupported；
- 当前 artifact 只支持 `darwin-arm64`，其他平台必须有自己的 exact manifest 和 Native proof，不能从本机结果推断。
