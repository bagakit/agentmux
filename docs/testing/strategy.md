# AgentMux 测试策略

## 权威边界

AgentMux 只测试自己的公共 Core/Client 行为和 CtxMux public boundary，不读取 CtxMux wire、数据库、PID table 或私有模块。PTY、Replay、Signal 与 Stop 的底层正确性由固定 CtxMux source Gate 拥有；AgentMux 必须另做 checkout-external packed-boundary proof，证明打包和映射没有破坏这些能力。Agent-first 空间命令的用法见 [Core space 指南](../../packages/core/guides/modules/space.md)（准确 selector 与参数以 `amux space --help` 为准），产品约束见[交互 SSOT](../design/agentmux-desktop-interaction.md)。本文拥有验证分层、任务验收与公开 oracle，不是当前候选的通过报告。命令来源是[根 package scripts](../../package.json)与 [Desktop package scripts](../../apps/desktop/package.json)，随包版本唯一取自 [vendor manifest](../../packages/core/vendor/ctxmux/darwin-arm64/manifest.json)。

Terminal output 是 raw PTY bytes 的 UTF-8 投影，不是模型上下文、Tool、Permission、Reply 或 Worker Done 证据。

## 从需求选择行为场景

从产品需求／设计推导可证伪行为、枚举关键场景与选择实际行为证据，见[从产品需求到行为验证](product-behavior-validation.md)。该方法同时说明 Agent 上下文的知情／盲读诊断及按需人类 GT 裁定；本页继续持有验证分层、实现验收和公开 oracle。

## Suite 分层

| Lane | 命令 | 证明范围 |
| --- | --- | --- |
| Fast | `pnpm test:fast` | Pure domain、Store、Provider、Desktop owner 与 UI reducer；不启动 packaged native fixture。 |
| Native package | `pnpm test:native` | checkout 外 `pnpm pack`、offline install、真实 CtxMux PTY、Control handshake、Codex fixture、crash recovery 与公共 Runtime 边界；真实 SSH 与 Linux 资格单独执行。 |
| Security | `pnpm test:security` | ACP 默认拒绝、Hook 认证/Secret scope/在途背压、Store 格式与身份、Control endpoint、Hook installer、Workspace 与 Browser 权限边界。 |
| Seeded fuzz | `pnpm test:fuzz` | 固定 seed/case 数的 Hook/Store/terminal byte 与 Workspace path 边界；失败可由测试名中的 seed 重放。 |
| Reliability | `pnpm test:reliability` | 16 个真实 Run、并发 Attachment、attach/detach churn、stop/input race、slow/fast Consumer、5 MiB 输出、live daemon `SIGKILL`、恢复与 Core 资源斜率。 |
| Desktop resources | `pnpm test:resources` | 隔离 runtime 中验证七轮 reusable Terminal、Monaco 和 Browser WebContents 的资源释放，记录工作集诊断，并验收恢复后代表工作面的主 Renderer 预算。 |
| Mounted Desktop | `pnpm --filter @agentmux/desktop package:mac` | [package-macos.mjs](../../apps/desktop/scripts/package-macos.mjs) 持有构建、DMG、挂载及安装身份核对，并内置隔离 packaged probe；ad-hoc 签名的开发候选跳过其中的 LaunchServices 检查（`verifyLaunchServices`）。源码中有 probe 不代表某次候选已执行。打包复用任务验收、不追加前置检查的边界唯一见 [macOS 打包指南](../guides/macos-packaging.md#必要核对与触发式补查)。bundle identity、package report 与 artifact hash 须绑定同一 source commit/tree/version/platform/arch。 |
| Nightly | `pnpm test:nightly` | Native Package、Security、fuzz、reliability 和 Desktop resources 各执行一次；不重复 packed smoke 冒充 chaos。 |

Security/Fuzz 的 Input 证据由 public recoverable Input、option-like prompt、并发 prompt 与 stop/input race 提供；Workspace 除 rooted path、静态 symlink 与 seeded traversal 外，还会在 worker 固定 cwd 后交换父目录为 outside symlink，覆盖 read/list/reveal/create/write/move/delete；Secret 由随机 Hook bearer、私有 Stored Session、公共 Session/View 去密及 managed Hook receipt 边界提供；Permission 由 ACP default-reject/invalid decision/oversized event 提供；运行适配层只测试 AgentMux public error/Replay 投影，不 fuzz 或复制 CtxMux wire。

## Shell 与 Desktop 的验证义务

下表列出需要证明的行为及其 oracle；测试存在或过去通过不等于本轮候选通过。原 Shell checkpoint 的历史记录绑定 ctxmux commit `073e206407ce28331aa882c2c80e9354cfe2879a`、tree `3ddf0706c35517c0dd6bdf4d4f7fa251d88c0e0a`、protocol 13。该身份只描述原记录，不是当前 manifest，也不能把原结果改写成新协议的通过记录。

| 不变量 | AgentMux public oracle |
| --- | --- |
| exact artifact identity | manifest 唯一绑定随包 source commit/tree/protocol，build/runtime 复核 size/mode/SHA-256。核对随包产物与核对正在服务的 daemon 是两项事实。 |
| exact endpoint owner | [runtime-paths.ts](../../packages/core/src/runtime-paths.ts) 提供与 artifact 无关的稳定宿主 namespace，endpoint 临时目录与用户目录下的 durable state 分开；升级不能另建 Runtime。已有服务按公开身份、协议与能力核验，业务 dispatch 在实际连接上匹配 expected Runtime identity。owner receipt 缺失只限制清理权限并明确告知，不能阻断兼容服务上的健康 Run。 |
| checkout independence | `package-consumer.integration.test.ts` 在系统临时目录执行 `pnpm pack` 和 offline/no-save npm install；真实 package root 不在 checkout |
| Connector adapter runtime | `node apps/desktop/scripts/verify-connector-adapter-package.mjs --mutations` 消费正式 Main 构建配置、原依赖组装与默认适配器，在无工作区依赖兜底的包布局验证延迟加载。预先取消的登录初始化须零网络返回；撤掉 SDK 交付接线须产生真实加载失败。该检查不代签扫码授权、应用创建或安装成功。 |
| Renderer dependency singleton | `node apps/desktop/scripts/verify-renderer-react-singleton.mjs` 加载三个生产 Vite 配置，以同字节的不同物理依赖根覆盖绝对 alias 和外链组件；真实菜单、对话框及回调须可用。移除生产 dedupe 须复现 Radix 的空 Hook dispatcher；单独测试解析配置、版本相等、加载失败或超时不能代签这条行为。 |
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
| prompt crash recovery | 按[输入环境合同](../design/behavior/agent-capabilities-and-messaging.md#输入环境判定与复用边界)分别验证人工当前终端、原生输入及原冻结计划：存在 payload／submit 的路径各自使用确定性 operation id，已确认阶段不重发，未知阶段只核对原受据；重启、历史同文和丢失 receipt 不得新增 payload/CR。终端展示观察只证明所选协议明确保证的事实，不作为人工当前终端的通用准入条件。 |
| typed Agent interaction | Core 验证 exact Session/Run/request/option，拒绝未知、重复或不完整 response；ACP delivery 与 semantic settlement、Native recoverable Input claim 分开证明。普通 Prompt 在 pending interaction 期间受限，原生 `writeAgent` 输入仍可用，不能把 typed response 路径变成对健康终端的封锁。accepted/unknown 不等于批准，不自动重放。 |
| terminal color capability | packed consumer 在父环境显式设置 `NO_COLOR=1`，真实 daemon/PTY child 仍观察到 `TERM=xterm-256color`、`COLORTERM=truecolor` 且 `NO_COLOR` 不存在 |
| Terminal appearance query | Desktop Main 在 Renderer 未 attach 时识别完整及跨 chunk OSC 10/11 query，等待 Core 发布 ready Agent Session 后才经 Core → CtxMux Input 回复当前 shared palette，不能与 Core Terminal handshake 竞争 Input cursor；Renderer replay handler 消费旧 query 而不重复注入 |
| Terminal/Explorer interaction | Fast suite 固定纯黑 Graphite 工作面、完整 ANSI 色槽、OSC parser、历史 Run 只读 fit、平台路径、Workspace Root reveal 边界、Move plan 与 Store action；Mounted Desktop 走真实 PointerSensor/drop、Radix `Move This Item to`、`Shift+F10`、invalid drop、500ms hover expand/cancel cleanup、Workspace 回访和 Workbench DnD overlay 隔离；Production build 证明 Search/WebLinks/WebGL/Context Menu 可打包 |
| Terminal interaction latency | Fast suite 证明 raw `terminal-output` 绕过全局 Zustand projection、输出 ACK 在单一在途调用后折叠到最新游标、pointer Split drag 只提交一次最终 ratio；viewport owner 在拖动中执行零 fit/resize、释放后只同步最终 grid，并继续证明必需的真实像素门控、latest-wins PTY resize 与 View dispose 丢弃排队 Resize；Attachment owner 线性化 Resize/Stop，Stop 撤销 lease 后迟到 Resize 不触达 ctxmux；慢启动 Agent 在 attach 后、首段输出前显示启动中，首段 Replay 或 Live 输出到达后立即让位给真实 TUI，失败或退出不伪装成启动中 |
| ordered Input under concurrency | 双 Client 交错写入仍各自取得准确范围；前一条回执延迟时，后一条 raw 输入已实际被接纳且字节有序；突发输入经过真实窗口后完整到达；授权准备乱序、Run 替换、语义输入交错、观察 detach 或失败、部分写与断连，都不换目标、不丢字节、不自动重放未知输入。链路见 [Terminal Runtime《输入顺序与等待成本》](../architecture/terminal-runtime.md#12-输入顺序与等待成本)。没有实际交互或尚未更新的实例不能证明流畅度已改善。 |
| Agent token usage | Core 的 `agent-usage-transcript.test.ts`、`agent-usage-capability.test.ts` 证明声明 usage 能力的 Provider 只在既有收尾事件由 Hook 读一次自家 transcript 尾部，不新增轮询；`agent-usage-env-injection.test.ts` 守 catalog 到 Hook 环境的注入。Desktop 的 `agent-usage-display.test.ts`、`agent-roster.test.ts` 证明「报了用量」「声明能力但尚无样本」「根本不报」三态可辨，缺值不补 0，真实零值按原报告显示，用量只落在所属 Agent 的名册行。口径见[状态栏](../design/behavior/settings-and-observation.md#状态栏)。 |
| Agent exact-Run control | Native package consumer 在 provider-native Resume 后用旧 Run 调用 resize/stop，证明 `STALE_AGENT_SESSION` 发生前没有改变 rebound Run 的 runId、grid 或运行态；合法 exact Run resize 仍成功 |
| Workbench presentation persistence | [workbench-persistence.ts](../../apps/desktop/src/renderer/src/lib/workbench-persistence.ts) 保存 Tab Group、Region 树、焦点与持久内容描述（Agent、Terminal、File、GitDiff、Launcher、Browser），不保存活 WebContents 或复制 Run/PTY/状态。启动先恢复原工作面；空 snapshot、探测失败或 lease 未释放不能删除投影。健康 Run 自动 reattach；ended/missing Session 的恢复时机按 SSOT「冷启动按需恢复」。未被保存的 Runtime Session 不自动补 Tab，也不因未认领推断应杀掉健康 Run。 |
| Workbench View close transaction | Fast suite 冻结逐 Surface owner 的关闭计划，并确定性覆盖 Browser/Session cleanup 独立并发 dispatch、部分成功只保留失败 owner、retry 不重复已成功资源、同 View 重复 close 不重复 cleanup、共享 Session 的唯一 Stop 责任、关闭期间 View/Session admission、owner event 先于 receipt 的幂等收敛，以及 Recover/Refresh 的 exact Run epoch fence；旧 Stop receipt 不能删除新 Run，Recover owner 丢失后的 cleanup failure 必须留下可发现 View。Renderer 不建立第二份 Stop ledger、tail 或 fallback。 |
| Native Browser geometry | Fast suite 证明 DOM CSS bounds 会按当前 Renderer `webFrame` Zoom Factor 换算为 BrowserWindow DIP；100%、放大和缩小界面后原生网页仍贴合自己的 Region。窗口/侧栏交互缩放期间 Browser 不冻结旧 viewport，而是在最多一个 IPC 在途的前提下持续跟随，积压值只保留最新尺寸；瞬时零尺寸转为隐藏，Browser 已关闭后的迟到 bounds 幂等忽略而不弹全局错误 |
| Terminal Replay Gap recovery | 分别验证公开 continuation 可恢复当前画面、缺失历史如实提示，以及原始后缀不冒充完整屏幕。确需重绘的 Running Run 只经唯一 viewport owner 请求；Historical Run 与拖拽期间不写 PTY。重绘只能恢复当前画面，不能补回淘汰的 scrollback，也不能替代活跃会话连续向上阅读验收。 |
| Workspace Agent discovery | Fast suite 证明二级菜单只保留 Files、Agents、Browser；Agents 从现有 Session Snapshot 过滤当前 Workspace 的 Agent，复用 Board 状态分组和 `selectSession` 重开 View，不包含 Raw Terminal 或第二份 Session Registry |
| Workspace revision save | Owner tests 注入临时写入和替换故障并锁定原字节；Store tests 覆盖每文件串行、generation、close/reopen epoch、clean/dirty invalidation、Reload/Overwrite、删除与 read error；mounted oracle 走真实 Renderer → preload → IPC → `WorkspaceFiles`。 |
| Workspace atomic move | Main owner tests 在 destination-absent 后、最终 syscall 前制造竞争目标，并覆盖 no-follow、no-replace、typed unsupported；post-commit receipt matrix 覆盖 source/destination replacement、moved-back、双缺失、destination parent/Workspace Root 换代与 mutation/read interleave，所有场景都保持 `unknown`，不从 pathname occupancy 猜对象身份。Store tests 覆盖 save mutation admission、目标 owner 冲突、unknown 不改投影，以及 Document/Dirty/Last Active/Tab/Region/Selection/Expanded/changed observed payload 的一次性 segment-aware rekey；订阅断言证明每次 Rename 恰好一次 Explorer projection 引用变化，A→B→A 为零次。Fast interaction tests 固定同 parent、自身/后代与 loaded collision 的共享 plan、成功或 unknown 后恰好两 parent 并发去重刷新。Mounted Desktop 证明 Pointer/菜单只表达单项 Move、非法目标不提交、真实 input 驱动的 A→B→A 保持多选且产生零 Explorer projection 通知；commit barrier 另制造 A Move 已提交、B 已激活、旧 A closure 才继续的时序，证明一次路径事务通知之外两个 parent load 都被 Workspace identity/epoch admission 拒绝，B DOM/cache 不受污染，回 A 后由当前 owner 自行恢复。packaged helper 继续证明安装副本使用同一 no-replace owner。验证事件按操作与 Workspace epoch 归属：挂载重建后不复用聚合 DOM 计数推断某一次 mutation，一次 Move 提交只产生一条权威 receipt，旧 epoch 的刷新记为 rejected，对已消失 Run 的 Stop 归入幂等终态。 |
| Hook acceptance/drain | Hook command 的 receipt id 跨重试稳定；bound ingress 仅在 owner persistence 成功后 `204`，失败以非 2xx 触发同 receipt 重试；Server shutdown 排空已接受事件 |
| Desktop Control owner | Fast suite 对真实 Renderer Store 验证 caller identity、Tab/Region 投影、四向 split、精确 focus、三类 typed open、send 唯一性、arrange 和 owner-loss rollback；bridge 测试证明跨 Electron world 只传普通 request/response/cancellation，所有布局 mutation 继续通过同一个 workbench reducer，ctxmux 只接收最终 viewport size |
| Packed Control CLI | checkout-external packed consumer 从 injected `PATH` 执行同版本 `amux`，通过一个版本化 endpoint 验证 `inspect/list/open/send/focus/arrange/output/interrupt/resume/stop`、稳定 JSON receipt、literal `--help` payload、UTF-8 分片和 peer early-close；Core endpoint 测试另锁定 protocol mismatch、closed target、typed candidates 与 owner unavailable error |
| Agent-owned CLI discovery | fake Codex 复核 `AGENTMUX_ENV`、权威 `AGENTMUX_CLI` 与 Agent Session identity；Fast suite 固定逐级帮助、typed flags、子命令成功语义和 `--skill` 的 fail-closed Control 边界；Desktop package smoke 在 `PATH=/usr/bin:/bin` 下证明 launcher 使用 `.app` 自带 Node runtime |
| Managed Agent 启动指南 | Core 验证开启、关闭、原任务与空任务的组装；Desktop 使用 [config-store.ts](../../apps/desktop/src/main/config-store.ts) 的当前 Executor 模型与默认配置，RuntimeController 把同一 Executor 交给 Core。历史 Config/Profile 版本不能充当现行合同。 |
| Darwin endpoint bound | 默认 Unix endpoint 按 runtime-paths.ts 的稳定短 namespace 构造，并与 durable state 分离；绝对路径 override 仍需验证平台 socket 长度边界。Native package/LaunchServices oracle 使用真实随包 ctxmuxd。 |
| bounded Consumer publication | 公共类型表达同步 callback 合同；运行时违规消费者获得可观察诊断与恢复入口，异常或永久 pending Promise 不阻断其他消费者和生命周期，永久 pending Promise 不保留 Client/Publisher。正常消费者不因无关观察者增加而失去事件；不建立隐式无界队列，也不在“忙碌期”静默漏掉仍注册 listener 的 lifecycle/permission 事件。需要异步处理的 Consumer 在同步 callback 内复制到自己的有界队列；需要无损字节流则使用独立 Attachment/Replay |
| bounded Hook/ACP ingress | 在途队列与 body 边界按真实内存、协议和处理成本验证；背压明确区分未受理与已受理但回执未知，排队时间纳入 sender 等待与重试验证，重试保原 receipt 且不重复提交。stable binding identity 与随机 bearer 分离，公共 Session/View 不含二者；bound callback 接受 AbortSignal，旧 owner 真正 settle 后同 token 才恢复 admission，其他 binding 不受牵连；取消只作用于本次排队或执行中的 Store write，不能中止同 Agent Session 的前序 lifecycle/readiness 持久化；close/stop 排空已接收 delivery |
| daemon activation ownership | readiness 与 public handshake 确认服务，按准确 Runtime 身份与 artifact 寻址的 owner receipt（[`ctxmuxOwnerReceiptPath`](../../packages/core/src/runtime-paths.ts)）记录启动归属。[CtxmuxRunAdapter](../../packages/core/src/ctxmux-run-adapter.ts) 中 receipt 保存失败不能终止兼容 daemon 或其健康 Run；归属不明应告知并限制清理。测试隔离进程的 cleanup 须证明精确 owner，不得外推为对用户 daemon 的强杀授权。 |

主 Oracle：`packages/core/test/package-consumer.integration.test.ts` 与 `packages/core/test/fixtures/packed-consumer.mjs`。

## Production Desktop Control smoke

Production Desktop Control smoke 是目标验证，当前没有实现脚本；[package-macos.mjs](../../apps/desktop/scripts/package-macos.mjs) 的 LaunchServices 验证（`verifyLaunchServices`）只覆盖 ready receipt 与产品身份、owner receipt 与 socket owner 归属、正常退出及隔离 runtime 清理，不执行下列 CLI 纵切。

该 oracle 在隔离 runtime 的 packaged `AgentMux.app` 上检查以下纵切；是否完成、是否通过须查本轮 receipt，不能从本文推断：

- ready receipt 确认 `packaged: true`；caller Agent Session 由 `.app` 内随包 Core/ctxmux artifact
  创建，packaged Desktop 从同一 Store 建立其唯一 Tab/Region 投影；
- 受管 caller 执行 `amux space inspect --tab self`，读取确切 Region ID，再用
  `amux agent open --executor <executor-id> --region <region-id> --split right`；
  receipt 的 `result.agent` 返回新 Agent Session/Run，`result.to` 返回实际空间地址，
  新 Run 的 public status 为 `running`；
- launch 前后按 [`ctxmuxOwnerReceiptPath`](../../packages/core/src/runtime-paths.ts) 寻址的 owner receipt 中 `daemonInstanceId` 与 exact `ctxmuxd` PID 均不变；同一份受信 Core artifact
  从 checkout 搬到 packaged App 后可以继续使用原 daemon，receipt 中的启动路径只作诊断，不参与身份判断；
- 将随包 source/manifest 身份、正在服务的 Runtime identity/capability 与 cleanup 归属分别核对；
  兼容服务可以继续承载健康 Run，旧启动路径或缺失 owner receipt 不能代替不兼容判据；
- smoke 后通过公开 `amux agent stop --session <test-session-id>` 停止两个测试 Run，退出 test Desktop，确认没有隔离 runtime
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

界面改动的采图、看图、复拍和交付前消费意见，唯一按[独立 Agent 看图评审](../guides/agent-visual-e2e-review.md)执行；它由 Agent 完成，不是自动发布拦截器。下列命令是本文各验证层的入口：

```bash
pnpm typecheck
pnpm test:fast       # pure domains, Desktop owners, no packed native fixture
pnpm test:native     # exact packed checkout-external CtxMux Shell vertical
pnpm test:security   # deterministic auth, permission, secret and bounded-owner checks
pnpm test:fuzz       # deterministic seeded public-boundary fuzz
pnpm test:reliability # native chaos/stress plus Core resource receipt
pnpm test:resources  # isolated Desktop resource receipt
pnpm --filter @agentmux/desktop package:mac # mounted DMG + LaunchServices workspace-file oracle (skipped for ad-hoc signing)
pnpm test:nightly    # native package + security + fuzz + reliability + resources, each exactly once
CODEX_HOME="$private_seed" pnpm test:real-codex # 显式使用独立 seed，与用户默认配置目录分开。fixture 把 auth.json 与 config.toml 复制到私有 Root
pnpm check           # typecheck + fast + native + all builds
```

Fast 与 Native 分开是为了让失败归因清晰，不允许用 Mock 代替 Native proof。Native fixture 使用独立 runtime/state 与真实 packaged `ctxmuxd`、真实 PTY；具体隔离方法以 harness 为准。产品进程级路径策略由 runtime-paths.ts 持有，不能把某一版 fixture 的 synthetic uid 方案写成「产品不支持 override」。清理只针对已证明归属的测试资源。 每个已登记的清理动作须按原依赖顺序尝试完成，某一步失败不能跳过后续资源释放或 mock／环境恢复；保留所有原始错误并在收尾后汇总报告。失败变异的兜底清理仍只操作其精确私有资源，不能把兜底成功计为被验证收尾路径已经成功。

验证进程必须在报告结束前真正回收，因为用户内存有限。验证失败、超时或中断后不得留下 Electron、文件 observer 或测试 Runtime；runner 须确认本次进程已经退出，一条超时日志不算进程结束。一次验证尚未完成回收时，不启动下一份 Electron 验证。清理只针对本次验证的进程组、独立临时目录和 Runtime 身份，不影响正式应用和用户 Agent；先回收进程，再删除它们依赖的临时目录。观察失败必须明确报告，不能当作零残留。验证模式的启动落点只决定初始选择，不持续覆盖用户或 probe 随后的 Workspace 切换，也不能让项目切换在测试模式下失效。

真实 Desktop Main 夹具还须在加载生产模块前设置并核对 Electron 的 `home`、`appData`、`userData` 与 `sessionData`；仅覆盖 `HOME` 或读取 `os.homedir()` 不能证明这些路径已隔离。独立启动入口先设置路径，再动态加载 Main，避免模块顶层提前固化用户目录。启动后复核实际 Store、scratch、Notes、Mote 和 connector owner 的目录；继承的 Agent 身份、Hook、端点及队列上下文须清除或由夹具明确替换。隔离缺口保留原回执和副作用未知，不以修正后的新夹具通过证明旧运行未触达用户数据。

官方打包的私有启动检查由 `package-smoke-context.mjs` 提供明确环境：只保留系统搜索路径、语言和时区，替换私有 HOME、shell 配置目录、Store、消息队列及 Runtime/state，不继承执行检查的 Agent 凭据。检查失败后，先将该次私有 Desktop stdout/stderr、Host 日志及收尾回执保存在仓库本机状态目录，再删除临时包；每份日志最多保留末尾 1 MiB，回执明确完整、截断、读取期间变化或缺失，保留原主错误与收尾错误。证据保存本身失败时明确保留原暂存位置，不冒称已完成清理。该证据不代替启动成功，也不授权清理原 App、Run 或用户日志。

## 资源与故障证据

本节的代表数值和故障结果是历史观测，适用范围由对应 receipt 的源码、产物、Runtime、机器和场景身份决定；它们不证明当前候选已通过，也不替代本轮热路径的相关消费者成本检查。当前预算与 harness 是执行来源。

`test:reliability` 的 `agentmux.t017-reliability.v1` receipt 绑定 AgentMux HEAD、tracked diff 状态、精确 CtxMux commit/protocol/capability 和前后 daemon instance。代表性 darwin-arm64 观测中，daemon 基线约 5 MiB RSS/19 FD；16 个 idle Run 为约 8 MiB/67 FD；16 个 live Attachment 为约 8.4 MiB/83 FD；5 MiB 输出并保留 4 MiB replay 时约 19 MiB。斜率约为 179 KiB、2 threads、3 FD/Run，以及 27 KiB、1 FD/Attachment。精确数值随机器采样波动，Gate 比较冻结预算并把每轮原始 JSON 写入日志，不把这组代表值当固定等式。

停止 16 个 Run 后 child、Attachment 和 transient thread 全部归零；daemon 相对基线保留 32 FD，即 2 FD/历史 Run。这不是未追踪泄漏：固定 CtxMux commit 的 `reliability-budgets.json` 明确声明，在没有 global Run GC 时，exited Run metadata、retained PTY descriptors 与部分 RSS 是有界历史成本。AgentMux Gate 分别验收 live owner 释放与这项显式保留成本，不能把“历史仍可查询”误写成 Run 已被删除。

`test:resources` 由 [measure-desktop-resources.mjs](../../apps/desktop/scripts/measure-desktop-resources.mjs) 驱动 Main 的 [resource-probe.ts](../../apps/desktop/src/main/resource-probe.ts)，报告 schema 为 `agentmux.t001-desktop-resources.v2`，外层脚本以 `T017_DESKTOP_RESOURCE_RECEIPT=` 行输出并附加源码与 ctxmux 身份。它使用系统临时目录下的短、测试专属 Runtime。清理以 exact socket、daemon executable 与完整 argv 确认 owner，每次发信号前重验。Harness 先证明一个已 ready、尚无 receipt 的真实 test-owned daemon 能被精确清理，再运行 Desktop。

轻载场景记录至少 300,000 字节的 xterm 输出、Monaco、Browser 和释放阶段的工作集增量。七轮包含两轮预热和五轮稳态观测。硬检查验证有限读数与 owner 收敛。实际 ready 的 reusable Terminal 建立 View、Addon、listener、Main Attachment 和 Renderer lease 基线。每轮 claim 继续使用同一 Run。Stop 核对原 Native 回执后，新的 reusable Terminal 恢复同等 owner。Browser 打开和关闭也分别核对释放和恢复。Monaco 首次请求前以原加载入口和 registry 缺席确认冷态。实际编辑以准确 File Tab／Region、Editor、Model、Document 和 watcher 确认，关闭后须读到加载后的真实零计数。加载后缺测单独报告。

代表工作面 Gate 沿同一资源入口，按[产品预算](../design/behavior/settings-and-observation.md#status-bar-cpumemory-资源面板)报告当前候选。用私有产品实例恢复持久 Tabs、Regions 和后台 Run，保持一个实际可交互的活跃终端。按实际主窗口文档绑定 Renderer PID，分别在暖态和有界输出、切换活动窗口采样。回执记录实现与运行身份、机器容量、实际恢复数量、采样区间、取到的主 Renderer 工作集及预算结果。验证负载成立后才判断性能；观测缺失或机器容量不符时保留缺测范围。原轻载资源循环继续核资源释放并记录多轮增长。真实 16 GiB 设备的结果用同样条件确认。

定向成本测试固定相关操作、目标与初始状态，只扩大无关数据或消费者。按实际产品链路选用读取和编码字节、解码次数、订阅唤醒、派生、绘制或保留 owner 数量等独立判据。每项同时证明相关变化仍及时到达，原对象、操作回执及恢复语义仍成立。变异恢复全量广播、历史读取或重复处理时，同一断言须能捕获增长。缓存场景覆盖首次加载、命中、相关版本变动和释放，分别保留相应成本与恢复结果。发布验证另测同一代表负载的内存、CPU 或交互响应预算，判级沿[任务验收](#任务验收与假绿防护)。

live daemon `SIGKILL` 发生在 Run 与 Attachment 仍活跃时；fixture 证明 child 消失、同 Run ID 恢复为 historical/interrupted、崩溃前 Replay marker 保留，并由 replacement daemon 的不同 instance identity 证明没有复用死亡 Owner。slow Consumer 从 byte 0 读取时得到真实 Gap，另一 fast Consumer 仍连续收到超过 4 MiB 和最终 marker。

保活与资源停放须显式断言隐藏消费者不新增 fit／resize／绘制／定时器／监听及无关 Session 工作；画面正确不能证明相关成本。内存结果按原进程和 surface owner 分层：至少分别记录 Main、Renderer、GPU／Utility 与 Browser target 进程，以及 Terminal、Monaco、Browser 与 Attachment owner 的数量。不能把 Chromium helper 的 RSS、共享页或 V8 保留容量相加后称为应用泄漏，也不能只看进程退出；只有同一场景的工作集与 owner 数量同时收敛，才把冷停（cold-park）记为有效回收。与其他客户端比较时按同样的分层记录；没有测量证据的数值不写成产品承诺。

### 隔离资源故障与恢复验证

以下验证[全局 P00 资源与恢复底线](../design/behavior/shared-rules.md#低资源下的正确性与可恢复性)，并沿[按操作判断强弱依赖](../design/behavior/shared-rules.md#按操作判断强弱依赖)选择本次受影响的故障与消费者，不代表当前候选已通过，也不把整张矩阵变成无关改动的全量 gate。

| 故障边界 | 可证伪的接受与证据边界 |
| --- | --- |
| 无关观察慢、pending 或 failed | 在真实消费链阻住无关目录、历史、名称或整组恢复，原持久工作面仍可见，已具备前提的准确健康 Run 仍能附着／交付已有能力，持续服务窗表达缺口；再移除本次自己的准确目标、授权或必要事务条件，该次错误操作仍被拒绝。核到同一次回执与结果投影，不能只证入口不等待。 |
| ENOSPC／不可写与提交边界 | 分别制造写前已确认未提交、写入／替换后持久结果未知及 cleanup 失败；核原记录、operation、已确认进度与可达重试。必要持久提交不能跳过或假成功，缺回执不等于未执行；资源恢复不自动重投未知输入。 |
| 内存压力、挂起、分配失败、OOM／强杀 | 记录实际故障及进程／Run 事实。仍存活则保原 PTY 和已有可用能力；进程丢失后另进程从第一次真实保存的数据恢复原 SID、上下文来源、工作面和原未知操作。超时不证明 OOM，模拟分配失败不代签真实进程丢失，未保存内存不冒充已持久。 |
| 系统断电与存储耐久性 | 区分持久来源恢复、Provider 原上下文确认与旧物理进程连续性；不要求失电后原 PID／PTY 存活。声明失电耐久性须有实际失电或覆盖相同存储故障模型的受控环境证据，明确文件系统、刷盘及设备假设；`SIGKILL`、正常重启或读取仍在缓存中的文件不能单独代签。缺测明确未知。 |

恢复验收保留准确原 SID、Provider native conversation／上下文、durable 工作面与 operation／投递进度，并消费其原已保存输入；不换新身份、不重新种数据，不以新进程成功或终端有输出代签[原生上下文恢复](../design/behavior/session-recovery.md#durable-runtime-健康)。沿本次受影响的 Core／Runtime／Main／客户端真实链逐项证明；实现修改仍需承重变异及真实产品消费，纯文档不宣称矩阵已执行。

- 在测试专属目录、存储或进程边界注入真实 errno，使实际 Owner 消费 ENOSPC、EACCES、EIO、短写，以及调度或内存压力；覆盖写前、写入／替换后回执与 cleanup 失败，断言故障确已触发。注入发生在隔离的临时 state-dir 等测试专属位置：不得为注入故障耗尽宿主磁盘、改动用户 Runtime 或压迫用户 Run，也不把宿主带入故障态；这类测试只证明服务窗分类与恢复边界，受控注入不能代签真实宿主资源耗尽后的自动恢复。慢响应、分配失败和进程被杀分别记录，不能仅凭超时推断资源原因；声称覆盖 OOM／强杀时，须有独立进程的实际退出及持久恢复证据。
- 对比故障前、故障期间与资源恢复后的原草稿、消息身份、条件、已确认输入进度和工作面。失败不能覆盖最后已确认记录；未保存内容仍在当前进程时须可见，并与持久确认区分。释放真实故障后，验证原操作可在同 Owner 及实际受影响的跨 Owner 入口显式重试、已确认字节不重复、未知输入不自动重投，健康能力不因旧失败持续被占用。
- 按本次改动选择定义外生产消费者及受影响的公共 SDK／RPC／CLI 链，核对同一次失败的原因、标识与查询结果；不为未改动的接口复制全部场景。诊断存储失败或观测不完整也须可辨认，不以缺记录代替零输入或成功，不要求在不可写或 OOM 时凭空生成完整持久日志。
- 涉及持久恢复时，用第二个测试专属进程直接读取第一次实际保存的记录，不重新种入数据。已确认内容应保持原身份与进度；强杀前未确认的内容只按真实可恢复结果陈述。记录本轮源码、实际故障、恢复条件、缺失证据与精确归属的清理结果，不将历史资源样本外推为本轮通过。
- 持久化故障的回归在临时 state-dir 中分别制造真实容量不足与受控 I/O 失败，验证原始错误分类、同一 Owner 的后续写入与失败边界；固定容量且逻辑历史尚未超额的场景须证明不会永久等待。真实的第二个 Run、原 Run 的健康控制，以及不同进程从第一次实际保存的数据恢复，须一并保全身份、确认水位与可用的连续历史。不能用增大预算、重新种数据或「文件存在」代替持久 Session 的证明；不得杀掉宿主应用，也不能把测试故障伪装成真实用户数据损坏。

构建与变异资格须量测宿主实际可用空间及本批产物占用，优先构建本次选定的精确 target；复用输出时绑定未变的源码、依赖、构建参数和实际产物身份，不将重编全部 integration 输出当作默认前置。空间不足时只释放本批已结束、可重建的缓存，保留在用产物、源码与执行证据；构建因外层资源不足应明确终止并记为未资格，编译失败、链接失败或资源超时均不计语义 RED 或 GREEN。这些要求约束 fixture 成本，不定义新的产品容量硬配额。

### 真实重启与恢复

以下验证[工作面恢复](../design/behavior/session-recovery.md#durable-runtime-健康)在真实进程边界上成立：

- 重启验收启动隔离的真实 Electron 主进程和 Renderer，记录应用进程身份、持久化布局身份、焦点、草稿以及 Session、Run 与 Provider 原生 handle。至少发生一次真实退出，再由不同的进程从同一 userData 根目录恢复；组件 remount、Store 序列化或只比较启动文件都不能代替。恢复先重建 Tab、Region 与焦点，再尝试 reattach 或 resume 原 Session；Run 可以依法换代，但 Session、工作面和草稿不能被换成新对象。
- 完整产品的私有恢复验收在首次 hydrate 之前提供真实、非空的持久化输入，并确认它进入实际工作面、正常退出后仍可恢复；不能在 hydrate 之后补写 seed，再把即时读回或人工修补当作重启保留的证明。
- 退出与恢复类改动须有私有的真实 Renderer 消失证据和不同进程重启证据，原非空工作面仍可见且可恢复。
- 探针只操作自己创建的隔离资源，记录前后不同的 PID 与身份匹配，结束时清理临时目录；故障注入不得停止用户当前的 App、daemon 或 Run。
- 配置升级保留每个可读的 authored Host；所有 authored Host 都不可读时保留原文件并确定性拒绝，不能用本机 `local` 的回填掩盖。这项判断须有 focused regression，且验证命令能在打包前单独运行。

## 证据边界

- opt-in 真实 Codex lifecycle E2E（`pnpm test:real-codex`，隔离前提与清理见[真实 Codex lifecycle 的隔离输入与清理](../guides/real-codex-private-lifecycle-test.md)）覆盖 create、reconnect、resume 和 natural-retire；某次结果只证明该次实际 Codex 版本下被执行的 Agent Session vertical；
- 固定规模的 security/fuzz、slow consumer、daemon crash/restart、chaos/stress 和 Core/Desktop resource ceiling 证明 correctness 与资源边界，不构成性能排名；
- latency、throughput、CPU/RSS 的对比结论需要独立的重复样本、outlier policy 和同条件 Benchmark，不能从 correctness/resource receipt 外推“全面胜出”；
- 当前 Core 已消费公开 `basic-vt` checkpoint、restore bytes 与 ordered Resize 的 continuation；来源为 terminal-continuation.ts、screen-evidence.ts 和 CtxmuxRunAdapter。存在这条实现不证明新候选画面或长期 scrollback 已验收；restore bytes 不能冒充新的 PTY output，缺失 checkpoint/历史或观察未知须如实表达；
- headless 与 Renderer 共用公开 continuation 顺序，各自拥有解释和像素；Runtime 持有字节、checkpoint 与 Resize 事实。不能再把「从 byte 0 重播且等 TUI 全屏 redraw」写成唯一现行恢复模型，也不能从当前画面恢复外推连续向上阅读历史通过；
- SSH 管理连接远端已有语义 owner，按当前公共 SDK／服务合同验证；本机通过记录不代签真实 SSH、远端 Provider 或桌面验收；
- 连接器回归守在被修改的边界，改动行为须用原消费者与带负载的反例，保留授权、未知效果与独立内容用例。各类证据只证明自己的范围：`<img src>` 断言不证明浏览器解码；手工构造的 typed attachment 不证明粘贴或提交；两个 SDK fixture 都收到正文不证明两个平台都渲染了头像；飞书／Lark SDK 协议样本与 Core／CLI／Mailbox 消费测试不证明真实凭据、订阅权限、现场群、通用 Host 启动组合或最终平台送达。发布合同测试用锁定的 SDK 与 Axios 序列化对 loopback HTTP，证明产品调用链与准确字节；[room-public-journey](../../packages/connectors/test/room-public-journey.integration.test.ts) 的 Host 授权经受控 RPC adapter，不证明生产 Host 组合或本地直接授权路径；建群 adapter 测试只建立通用 Host 边界；Channel metadata 的 SDK 消费测试不证明现场订阅、数据可见性与权限；Profile refresh 只覆盖 IPC／SDK 观察，真实 Renderer 的图片解码需要生产策略；App image recovery 配置把真实 Composer 输出接到 Host 与两个 SDK，单有预备好的输入引用不证明 App 生产者。候选结果与平台现场回执留在任务证据，历史结果不代表当前安装；
- 原生产物平台从 [artifact contract](../../packages/core/src/ctxmux-artifact-contract.json) 与对应 manifest 取得；每个平台必须有同源 Native proof，不能从本机结果推断。portable 空间 API 的可安装性与 Native Run 能力分别验证。

## 界面规则与真实行为

共享 UI 的宿主集成可从仓库根运行 `node packages/client-ui/scripts/verify-shared-conversation.mjs --mutation-and-callers` 和 `node packages/client-ui/scripts/verify-browser-context-reading.mjs`。前者构建共享包、检查 Renderer 类型、渲染交互并验证变异与实际消费者。后者验证对话、资源与邮箱对同一原记录的读取。对应的 `capture-shared-conversation.mjs` 与 `capture-browser-context-reading.mjs` 在独立的 Electron profile 中采集常规与窄窗，由[独立视觉评审](../guides/agent-visual-e2e-review.md)核对实图。认证、原生设备、终端挂载和持久恢复分别沿各自场景验收。

空间呈现的视觉约束归[空间与布局](../design/presentation/spaces-and-layout.md#工作面与注意力密度)。本节描述样式与输入的失效形态和 oracle；以下原事故样本只说明当时的假绿边界，不代表当前候选已验收。静态扫描、类型检查和静态渲染各有证明范围，真实状态变化与输入写回仍按任务场景操作验证。

- **CSS 中不能写 `-var(...)` 形式的负值。** `-var(--sp-2)` 不是合法 CSS，浏览器会静默丢弃整条声明：不报错、不回退，样式表看起来正常，效果却从未发生（例如负外边距归零，依赖它居中或叠压的元素一直错位）。数值型契约测试扫不到这一类，因为其中没有数字字面量。负值写成 `calc(-1 * var(--sp-2))`，或改用不依赖数值的手法（如随自身尺寸变化的 `translate(-50%)`）。守护测试是 `apps/desktop/test/stylesheet-organisation.test.ts`，它断言全部样式表中 `-var(` 出现零次，并报出文件与行号。这类失效还会掩盖第二层错误：声明从未生效，写在里面的数值也从未被验证；修复时要重新核算那个值，不能照抄进 `calc()`。
- **低于最小 token 的圆角必须是已声明的例外。** 守护测试 `apps/desktop/test/surface-radius-contract.test.ts` 从 CSS 推出所有低于最小 token 的圆角，并核对它们是否在例外清单内；新增未声明的硬编码圆角会使它变红。
- **状态在场标志必须与样式规则成对，按元素判定。** `data-x={cond ? '' : undefined}` 只有空串与不在场两种取值，对 JS 没有信息量，存在的唯一理由是被 `[data-x]` 选中；渲染了它却没有对应的 `.该元素的class[data-x]` 规则，说明规则在重构中丢了，或这个属性本就多余、应删除。这条按定义成立，没有例外清单。守护测试 `apps/desktop/test/rendered-class-has-rule.test.ts` 逐元素把 class 与该元素的标志配对，并用一对成对样本和一对「属性名存在但不在同一元素」的样本自证这个区别。只查选择器名字是否出现会漏判：曾有一次删掉 `.log-fold[data-open] .log-fold__chevron` 的旋转规则后折叠箭头永久不转，而旧测试因为 `.log-row__chevron[data-open]` 仍在而保持全绿。同一测试的扫描面除 BEM 记号外，还收 `-button` 结尾的扁平类名：曾有人按密度合同的档位名写出 `.secondary-button`，全仓没有任何规则，按钮落成 macOS 原生样式，在深色主题里比相邻的主操作还重。扁平名此前整族不在扫描面内，这是判据形状的缺口，修法是扩大判据而不是加豁免。按钮档位与类名的对应归[控件语言](../design/presentation/shared-rules.md#控件语言)。
- **列表选中态不能出现左侧竖条。** 守护测试 `apps/desktop/test/surface-selection-contract.test.ts` 从 CSS 推出 `box-shadow: inset <n>px 0 …` 与 `border-left`（含 `border-inline-start`）两种画法的全部左缘竖条，并断言选中态类名上不存在；两个形状判定各带一条自证样本（合法的容器分隔线与内容引用条），因为认不出竖条的检查会因「没找到」而全绿。
- **Agent 状态到颜色的对照只在状态语汇定义一次。** 守护测试 `apps/desktop/test/topic-agent-status.test.ts` 防止新表面再列一遍状态与颜色。
- **样式字面值必须落在刻度或具名例外内。** [surface-scale-contract.test.ts](../../apps/desktop/test/surface-scale-contract.test.ts) 的目标是从真实消费的样式反推字号、间距与颜色字面值，核对 token、具名例外及引用来源；同一测试判断 `.agent-catalog` 的规则体同时有 `max-height` 与 `overflow`（先断言确实扫到这条规则），守的是「有界」而不是某个像素值，避免同一个数值住在两处。尺寸规则归[全局尺度与样式 owner](../design/presentation/shared-rules.md#字号阶梯)，10px 已在字号刻度内，不需额外豁免。该守卫当前待修，不能作为全仓合规或完整覆盖的证据：[样式读取器](../../apps/desktop/test/helpers/styles.ts) 只沿 `index.css` 的 CSS 导入图检查目录，却未识别 [GoalDetail](../../apps/desktop/src/renderer/src/components/GoalDetail.tsx) 等组件直接导入样式的生产路径，已会在收集阶段拒绝这些真实入口；测试只取首个 `:root`，不能代表完整层叠及[共享运行时主题投影](../../packages/client-ui/src/theme/runtime.ts)；`FONT_SIZE_EXCEPTIONS` 仍按旧 `.status__dot::after` 的 `content` 字形登记，而实际状态点已消费[语义图标遮罩](../../packages/client-ui/src/theme/icon-sprite.ts)。修复须先核非空的真实入口、全局与组件作用域及运行时变量来源，区分应用样式与第三方样式，再判断消费是否违规；未分类的字面值或未找到定义只能算诊断候选。临时绕过收集错误、删除旧断言或扩大白名单均不证明守卫已恢复，也不授权机械修改全仓视觉。
- **happy-dom 不计算布局。** 依赖子元素个数或几何的排版错误（例如 `justify-content: space-between` 遇到数量不定的子元素）不会让任何组件测试变红；这类约束在写法上消除（规则见[控件语言](../design/presentation/shared-rules.md#控件语言)），或用真实 Renderer 的采图与几何读数验证。
- **受 Radix `Presence` 管理的入场动画只在 `[data-state='open']` 生效。** 守护测试 `apps/desktop/test/presence-exit-animation.test.ts` 从 Desktop 与共享 UI 包的实际组件源码推导受管节点，集合必须非空，不维护手抄类名，同时保留入场动画的断言，不能靠删动效满足。静态守护不能证明退出动画完成；有意的退出动画须由真实 Native Renderer 证明完成与卸载。
- **受控表单控件必须有写回口，或显式声明永不接受输入。** 判据直接取自 React 运行时的规则：给了 `value`／`checked`，却既没有 `onChange`／`onInput`，也没有无条件的 `readOnly`／`disabled`，React 会报 "without an `onChange` handler … read-only"。受控取值与写回口按定义成对，同样没有例外清单；`defaultValue`、`readOnly`、`disabled` 本身就是判据的另一半。只有无条件的 `disabled` 才算自洽：形如 `disabled={busy !== null}` 的条件禁用在空闲时仍不可写。守护测试 `apps/desktop/test/controlled-input-is-writable.test.tsx` 静态扫描每个组件文件，并把 React 的这句告警接成断言。只用 `renderToStaticMarkup` 的测试不运行 effect、不派发 DOM 事件，抓不到这类交互失效：曾有启动对话框的两个名字输入框删掉 `onChange` 后永久不可写，相关组件测试与 `tsc --noEmit` 仍全绿。事故中的输入框正带着 `disabled={busy !== null}`；若把任何 disabled 算作自洽，这次变异仍会全绿。

## 任务验收与假绿防护

实现 task 判 done 须同时有变异测试和真实产品调用链证明。变异是改坏实际实现，确认对应测试变红；不能只改测试制造红灯。调用链从受影响实现追到 owning 入口及实际产品消费者，核对调用条件、参数和结果，而不是以文件边界或符号是否导出判断。私有 helper 经同文件 owner、原生 helper 协议或模块入口接到实际消费者，可以构成该链；不为取得跨文件命中额外导出、拆文件或增加包装。可用 `rg -n "<symbol>" packages apps` 定位，再沿入口核对生产路径；测试、生成物、接口声明或仅有内部自调用不能单独代替产品消费。没有真实产品路径时仍是竖切未闭合，如实标 blocked。修复用户现场报错的 task 还须把两件事分开取证：用户现场错误的原因，取自现场的原始错误、日志或状态；隔离环境里复现并修好的问题，取自复现条件与修复后的测试结果。隔离环境复现出相同报错，不等于找到了现场原因；隔离复现或局部测试通过，也不能代替用户现场错误已消失的证明，缺少现场证据时写明现场错误是否消失仍未确认。

删除同样以真实调用链为依据。删除死 props 或分支，依据是真实生产调用链与生成路径，不是文件行数；只向废弃入口喂数据的测试不能代表现有产品消费，组件变薄时仍保留实际的当前、历史、退休与无数据路径。删除任何现有保护前，须能在它所在的共同边界解释它防住的原反例；解释不出就不能删。

一个用例只证一件事。把多个各自启动子进程的场景串进同一个 `it`，耗时会叠加到逼近默认超时（并发运行时最先失败的就是它），失败时也指不出是哪个场景，后面的场景还会被前面的失败挡住、从不执行。安全性质逐操作各立用例，并断言注入钩子确实被消费：钩子没触发的绿是假绿。测试按执行时间和变更范围设计：小改动优先定向、并发地验证，只有跨边界的变化才触发更宽的回归。

新增或修改公共能力时，接口影响判断、原业务 owner 到 RPC／CLI 的真实接线及完成边界按[公共能力贡献约定](../guides/public-capability-contributions.md#同一任务交付和验收)核对；本节继续持有变异与调用者证明的方法，不另维护方法或命令全集。

**评审严重度**只给评审意见和失败的检查定级，级别决定它挡住什么。事故复盘的定性另用[事故等级](../guides/incident-writing.md#1-定性--事故等级)，[AGENTS](../../AGENTS.md#目标与优先级) 中的 P0／P00 是产品优先级；三者名称相近，含义不互相换算。评审严重度的 P0 是数据、身份或 Session 丢失，安全缺口，或正常使用中拿走健康能力；P1 是真实路径上用户可见的缺陷或合同违背；P2 是有明确代价但影响有界的缺陷、边界情况或维护漂移；P3 是细小体验或措辞。P0、P1 阻止该 Task 判 done、合入和发布，修完并重新验证后才能继续。P2、P3 不阻止合入或发布：随 Task 记成具名残留，写明影响和下一步，归入后续 Task 或下一轮评审。级别按实际影响定，不按发现的位置或修起来难不难定；修复本身引入的问题照它造成的影响定级。不能把 P2、P3 提成门禁来换取保险，也不能把 P0、P1 降级来换取通过。

限制类改动按 [RED-LINES《时限与容量必须守真实边界》](../../RED-LINES.md#时限与容量必须守真实边界)验证依据与影响范围。测试从正常业务规模和保护的不变量选择输入，分别证明正常使用、真实越界或故障、其他健康能力以及原身份恢复；覆盖触发后的重试、取消和回执未知时，不能重新种入数据或换身份代签恢复。仅导入实现常量再断言第 `N + 1` 项拒绝，或把常量改大后测试仍绿，只能证明实现遵循自己的选择，不能证明该限制合理。拒绝分支的变异与资源成本检查仍保留，但不代替这些行为证据；按本次受影响的 owner 和消费者选场景，不增加全仓扫描或无关验收。

默认测试必须自带可移植输入，不读取忽略的个人 Tracker 或要求原仓某条旧 Git 对象。Tracker/Git 守卫以临时目录、真实自建 Git commits 验证原 scanner 和 CLI 的正反行为；本机实际任务资料另用 `node scripts/audit-tracker-test-targets.mjs --root <repository>` 显式审计。它只检查已推进任务的无守卫 Vitest 点名目标，不代签完整 gate；缺资料或空扫描报告未确认，退出码 2，存在缺失目标退出码 1，完成且无缺失才为 0。

扫描式契约测试必须先证明扫描有收获（如 `expect(found.size).toBeGreaterThan(0)`），再从来源反推约束，不维护与来源一起漂移的手写清单。豁免按具体选择器点名，不能全局放行某个数值。

切片扫描还须证明起止锚点都存在（各自 `expect(index).toBeGreaterThan(-1)`），并断言切出来的内容确实是目标片段。`indexOf` 返回 `-1` 时，`slice` 可能产出空串，让每条 `not.toContain` 恒真。守护来源：[sliced-scan-surface-not-empty.test.ts](../../apps/desktop/test/sliced-scan-surface-not-empty.test.ts)。

运行期集合的 `[].every(p)` 为 true，`[].some(p)` 为 false；测试这两个方向时，同一个 `it()` 必须证明集合非空。能用 `toEqual([...])` 钉死整体集合时优先这样写。反向断言对空集合会直接变红，不需要该守护；有意接受空集合时用紧贴上一行的 `// vacuous-ok:` 解释，不建集中豁免清单。守护来源：[vacuous-on-empty-predicate.test.ts](../../apps/desktop/test/vacuous-on-empty-predicate.test.ts)。这一族变异须按块把同一 `it()` 中该集合的每次读取都改为空，模拟生产「什么都不返回」；只在 `.every()` 调用点喂空集合无法证明整体守护有效。

纯文档任务核对来源、有效链接、冲突与语义保全；职责重组或硬约束改写需独立评审。没有实现变更时不制造代码变异或产品调用者证据；混合任务的代码部分仍过原验收。规范见[文档事实与维护](../guides/document-truth-and-maintenance.md)。

### 体验、阅读品质与已交付优化

界面审美的看图流程与各表面场景归[独立 Agent 看图评审](../guides/agent-visual-e2e-review.md)；本节规定体验类结论需要什么证据。

- 自行体验验收须实际走完完整使用流程，记录实际操作、可见结果、响应成本与保留的原身份；组件测试通过或安装成功不能代替。发现的缺陷与未验证边界如实保留。
- 「达到成熟产品水准」「优于竞品」是目标，不是已完成的事实；比较结论须绑定对比对象的版本、同等数据和任务条件。阅读入口的键盘、选区、复制、链接及原展开选择须实际操作验证；同内容、宽窄与关键阅读操作按成熟产品的阅读品质做有限匹配的独立评审，不足则返修，缺少比较不算完成。已接入 Provider 的原生会话阅读，须对照成熟参考项目已有的实现核验覆盖范围。
- 大数量资格验证须绑定实际数据来源、版本与窗口条件；真实观测集合与扩展压力样本分别声明，合成样本或自然窗口之外的局部测试不能称为真实使用通过。
- 原生协议须接到真实产品调用；内容顺序、主会话身份、恢复、长对话阅读和资源边界分别验证。
- 输入类能力（如 Message Tool）的交付证据覆盖真实宿主调用、关键实现变异变红、浏览器交互及草稿恢复；已归档的状态不能代替当前候选的验证。
- 已交付的优化须在并行集成与实际安装后仍可用。体验退化时，结论区分四种情况：实现被改回、实现还在但当前产物没包含、当前运行副本没用上、尚未确认。历史提交或当前源码还在，都不能证明用户正在用的界面保留了这项优化。


## Survey 开页依赖回归

`pnpm verify:survey-opening` 运行[固定验证入口](../../apps/desktop/scripts/verify-survey-opening.mjs)，从当前 checkout Source 消费原 Store／Core、系统 URL／网页文件入口和公共 CLI。`--checks=boundary` 只运行窄能力、模块依赖和必要保存边界；默认入口还改坏实际源码中的目录等待、无关片段保存、请求并发与提前呈现，要求对应业务断言失败，并恢复正常源码再验证。类型负例与运行时导入检查单独归类，不能代替业务消费；用例与实际加载集合必须非空。

验证在私有临时目录构建 CLI；生成型 Identity runtime 复用原构建配方，类型检查、Renderer 与 CLI 的生成模块解析指向同一份结果，实际加载集合不得含工作区陈旧的 `dist`。临时状态、编译产物和原测试进程由同次验证清理。现有 Verify 工作流在 `pnpm check` 前独立执行该命令；本地通过不证明远端 CI 或分支保护通过。该入口验证因果依赖和原位置 ACK，不代签已安装 App、默认浏览器关联、Native 首帧或网络正文加载的实测。

## Provider 输入边界回归

行为真值只归[输入环境判定与复用边界](../design/behavior/agent-capabilities-and-messaging.md#输入环境判定与复用边界)；本节规定如何验证，不另定义输入许可或 Provider 能力。

- 通用 Core 回归从实际注册表取得 Provider 定义，验证集合非空，使用原终端编码和公共输入提交／查询 owner。对可选原生准备贡献注入失败后，核对原操作的准确目标、key、等待原因和未认领事实，确认没有转写终端或重放；再验证同一健康 Run 的独立人工输入可用，错 Run 仍拒绝。Runtime 字节端口与 Provider 协议端口的夹具边界明确记录。
- Provider 自身的准入条件以其受支持协议逐项举证。构造附带观察缺失、但必要事实仍由准确原协议确认的正例，以及目标、权限或冻结对象真实变化的反例；通过实际消费者核对原操作、接纳与未知结果。移除真实能力隔离或对象核验后，对应业务断言必须变红。
- 注册表驱动测试证明通用 Core 隔离边界；注入的原生端口不证明该 Provider 的真实 CLI 已有此能力。原生协议、版本与真实输入回执仍各自取得同源证据，不能从一种队列或一种终端计划推广到所有 Provider；缺少协议资格如实保持未知或未支持，不为取得绿灯增加隐藏输入通路。

## 工作面键盘与地址验证

工作面快捷键的判定及落点解析使用原纯函数，组件负责实际注册与 `preventDefault`。静态渲染不会运行 effect，因此既验证判定，也验证生产接线；删除注册调用须使断言失败。不同平台与终端作用域键按真实键位比对，不能凭惯例猜无冲突。

地址失败与恢复命令给出的下一步，按动词逐行经实际 CLI parser 验证对象、动词、必填参数及转义，也须核语义是否对应真实失败分支；`send` 与 `inspect` 的必填项分别校验，不能共用一条粗形状断言。复制与错误回执共用出口时，两侧使用同一个校验函数，并各自断言检查行数的下界，证明实际检查集合非空。文案方向用语义断言钉住：`self` 多位置歧义的提示必须点名 `self`，能与显式 ID 分支区分；只断言形状抓不到措辞张冠李戴，也不以错误码名字猜含义。修「断言太粗」时，回查同一条断言里是否还有第二处粗糙。

## 对话阅读的验证与性能测量

纯序列、布局事务、卡片与宿主控制器的重构，以及渐进阅读的性能改动，按下列方法验证；接口影响按[公共能力贡献约定](../guides/public-capability-contributions.md)判断。

验证按承诺的结果区分：统一序列保持原顺序、贡献与定位；呈现事务覆盖跨贡献变更、跨过程选区、没有 Reader 的共同消费者及迟到操作；共同组件覆盖两端的差异能力、完整复制、两个按钮交错操作及切换来源；输入控制器覆盖失败与未知、重连、切换与原操作核对。删除真实保护或接线的实现变异必须使对应场景变红（方法见[任务验收与假绿防护](#任务验收与假绿防护)）。

渐进阅读分别测量「下一段何时可读」和「数据到达后主线程做了多少工作」：记录读取、组装、提交的时刻，长任务、帧耗时、节点规模与锚点偏移；使用折叠过程密集、长正文或已展开过程两类长会话，并核对隐藏位置、无关 Session 的输出和双向返程。受控批量输入先以原 Provider／Store 的准确回执确认准备完成，输入状态处理与阅读呈现的成本分别记录。新增正文只有进入原接受窗口后，才能比较挂载成本；待保护帧尚未呈现时的零挂载不算优化收益。首段可读正文与长答案完整呈现是两个指标，不能互相代替。源码里有 memo、分页或虚拟化都不是性能通过的证据；文档审查只证明设计与事实边界，不代替实现、真实产品或安装验收。

成本比较保留原长任务的时长和时间条目。观察到的阻塞量按每项 `max(0, duration − 50ms)` 相加，复用[阻塞部分的定义](https://developer.chrome.com/docs/lighthouse/performance/lighthouse-total-blocking-time)，但不冒称 Lighthouse 的页面加载窗口，也不沿用它的评分阈值；只记录超过门槛的任务时，整项时长不代表全部任务成本。全部工作另以原生 `timeTicks` 的任务占用墙钟度量：「真实起点到终点」与「首次可读原样本到同一终点」两个窗口分别比较，不能用前段节省抵消连续阅读的增加；它不是 CPU 时间，重叠的子类不相加，采样开销不扣除。首次可读延迟、帧与长任务分布仍独立保留。

测量起止点在正式样本之前固定。Current 原状态完成后的两个绘制帧之后，依次读取呈现快照与原生最终计数，保留各自的真实端点，不把两个独立读数称为同一时刻。Observer 快照先排空当时已完成且已入队的条目；当前快照任务及其后到原生端点之间的任务不保证在该集合中，须声明覆盖边界。旧的失败不按新口径回算成通过；任何窗口或指标持续退化、超过同基线样本的波动时，仍须调查并阻止性能通过。

## 动态视觉的浏览器成本验证

[动态视觉的渲染边界](../design/presentation/shared-rules.md#动态视觉的渲染边界)以实际 Native Renderer 的样式、布局、绘制与输入证据验收。happy-dom、mock 几何、React commit 计数、CSS 属性检查和静态图各有用途，不能证明浏览器逐帧成本或隔离。动态过程和小尺寸品质仍沿原视觉评审，不以性能通过代签。

持续共享动效的新增或相关修正，应在实际产品组件、原样式与主要交互消费者共同工作的场景验证：保原动画及必要状态／指针响应，固定可见实例数与输出负载，分别增加无关留存工作面的规模和相关可见动态实例，核对局部工作、传播范围及成本增量。涉及 Terminal 时包含真实 xterm 的持续输出、滚动和组字输入，不以空 replay、Activity 面或拒绝写入的桩代替该消费链；测试使用隔离 fixture，不向用户的健康 Run 注入探测输入。

候选与基线绑定实际 Renderer／构建身份、场景规模、观察时段及工具开销；结合 Layout／Style／Paint 失效来源与范围、耗时和输入／滚动响应判定，缺测明确未知。根为 `#document`、`partialLayout=false` 或 `totalObjects` 不能单独证明所有节点逐帧重排，也不能单独作为失败阈值；成本判据按要保护的交互和无关规模增量制定，不将某台机器的一次耗时写成永久预算。修复的承重变异须撤销真实隔离／局部化机制后使同一成本判据变红，恢复后通过；不能靠停掉动画、强制 GC、删掉留存面或只检查 `contain` 字符串得到绿。纯规范修改按文档验证，不宣称这些实现资格已存在。

有长静止阶段的周期动画须覆盖完整自然周期，核对原生呈现政策、实际部位矩阵与最终像素继续变化；像素范围按实际位图与 CSS viewport 的比例换算。只看动画处于 running、合成层理由或短静止时段，不能代签真实运动与成本。浏览器完整管线另观察 Layerize／Commit／Intersection 等阶段，主线程总工作按同进程、同线程任务区间去重，不叠加父子事件的 inclusive 耗时；局部 Layout 通过不代签合成或全页成本。诊断替换树时排除重复动画干扰，正式验收始终使用单一生产树；背景成本改善不代签原活跃终端的冻结已经解决。
