# CtxMux Local cutover

状态：Local Runtime 固定在 Protocol 13；Remote/SSH 仍不支持。
## 固定消费身份

AgentMux 当前只消费 CtxMux 的 exact clean artifact contract：

| 字段 | 值 |
| --- | --- |
| commit | `1603908a253162632e8812ceb9db19c3e416fea4` |
| tree | `464f239190234c8369799dca06a630b3b48f5cca` |
| protocol | `13` |
| platform | `darwin-arm64` |
| manifest SHA-256 | `2629d6d0809d4b85f4b475cc0d00ee677c4f17861b1fc904f2dabd8f18592bca` |
| SDK tarball SHA-256 | `172966940a9f537724afeb9b334f2a225ece3db1a102c4d8e90e154b8cb5bf3d` |
| `ctxmux` SHA-256 | `38083b21656327212c07789dcd199b7c4520a8561006841d76be9a2c23f9cb39` |
| `ctxmuxd` SHA-256 | `c4140151e006c9e775b90c7cb7bdb37d08b1122f7f7a37762c841294633f7656` |

AgentMux 不消费浮动分支名，而是固定上表中的完整 commit、tree 与 artifact hash。

AgentMux vendor 只接受 manifest 声明 `worktree_clean: true` 的同一组 manifest、SDK tarball、
`ctxmux` 与 `ctxmuxd`，不允许跨 commit 或 protocol 混用。

## 消费方式

`packages/core/vendor/ctxmux/darwin-arm64` 是唯一 Artifact 输入，内容只有 CtxMux manifest、SDK tarball 与两个 binaries。Core build 先验证 manifest、platform、mode、size 与 SHA-256，再从 tarball 私有 bundle SDK 到 `CtxmuxRunAdapter`。

Local endpoint 不是可选 Backend。Core 不接受外部 socket/state path；Darwin 固定使用长度有界的 `/private/tmp/amx-<uid>-<artifact-id>/`，不受调用进程 `TMPDIR` 长度影响，socket 当前为 57 bytes。Adapter 创建并复核 `0700` runtime/state 目录，启动前复核 manifest 整体 digest、binary bytes/mode 与 `ctxmuxd --version`，然后只从该随包绝对路径启动 daemon。首次启动通过 caller-owned fd 3 接收 `ctxmux.daemon-ready.v1`，只有 inherited receipt 的 daemon instance 与 public `runtimeInfo` 完全相等才写 owner receipt；socket race、PID、sleep 或 filesystem-only receipt 都不能证明所启动的 child。重连时响应 peer 还必须匹配 `0600` owner receipt 中的 full commit/tree/manifest/binary/path/endpoint、daemon instance、runtime lineage 与 runtime build。仅 protocol 相同不足以被声明为该 build。

Adapter 先用 unfenced diagnostics client 读取一次原始 `runtimeInfo()` 并核对 owner receipt，随后建立
同时绑定完整 `expectedRuntimeIdentity` 与 required capabilities 的 business client。每次 public dispatch
都在承载该业务帧的同一连接上先比较 Runtime identity，再直接要求 `native.start: 1`、`native.recoverable_input: 1`、
`native.recoverable_stop: 1`、`services.persistent_state: 1` 与
`services.planned_exec_upgrade_continuity: 1`。Adapter 还要求 `state_dir` lineage、
`ctxmuxd/0.1.0`、`macos/aarch64`；缺一项即在业务帧发送前失败关闭，不做 runtimeInfo preflight、
重试、错误重映射或 capability fallback。

AgentMux 启动 ctxmuxd 时建立 terminal-capable 基线：`TERM=xterm-256color`、`COLORTERM=truecolor`，并删除父宿主遗留的 `NO_COLOR`、`FORCE_COLOR=0` 与 `CLICOLOR=0`。Provider/调用方仍可通过 Run env 显式覆盖终端设置。这样既保留 Codex ANSI/truecolor，也让 Core 能从同一条权威 raw PTY byte stream 重放当前 terminal screen。

macOS LaunchServices 启动的 packaged Electron 不天然继承 Terminal 的登录环境。Desktop Main
因此在创建任何 Local Runtime Host 之前，只执行一次用户的 profile-loading shell，并把其中的
完整 `PATH` 设为当前进程的权威值；Core executable probe、CtxMux daemon 和每个 Run 都从这一
进程环境自然继承同一值。实现不硬编码 Homebrew、npm、Cargo 或某个用户目录，也不在检测失败后
猜常见路径；探测超时、启动失败或输出不可解析时保留原环境并明确记录失败。SSH Host 的环境仍由
远端执行边界负责，不误用本机登录 Shell。

这不是 `file:` dependency：

- `package.json` 不声明 `@ctxmux/sdk` 路径依赖；
- runtime 不读取相邻 CtxMux checkout；
- runtime 不接受调用方插入的 CtxMux endpoint/state；
- 不依赖全局 `ctxmux`、npm publish、GitHub Release 或下载；
- CtxMux SDK/wire type 不进入 AgentMux public `.d.ts`；
- packed package 自带 manifest、SDK source artifact、`ctxmux` 与 `ctxmuxd`。

## Shell vertical 已完成

唯一 private `CtxmuxRunAdapter` 负责：daemon activation、list/status/start、Attachment、Input、Resize、portable Interrupt 和 Stop。AgentMux 公共 Run identity 直接采用 CtxMux `RunId`，没有 alias、incarnation、PID identity 或第二份 Run ID。

checkout-external packed consumer 已真实证明：

1. 创建 Run 后拿到 CtxMux UUID 和 PID；
2. 第一个 Client 释放后，第二个 Client 看到相同 RunId/PID；
3. fragmented UTF-8 不产生错误替换字符；
4. 从累计 byte 7 的 interior cursor replay 连续 suffix，并在 retained Attachment 存在时为第二 View 读取同一 exact Run 的非持有 Replay；
5. 调用方丢弃首次 Input receipt 后，新 Client 用同一 owner instance、operation id、expected byte 和 data 恢复精确 range，PTY 只收到一次；
6. Resize 由真实 PTY 回读为 `101x37`；
7. Interrupt 被进程观察且进程继续 running；
8. 忽略 HUP/TERM 的 root/child process tree 被 Stop 完整清除；
9. Remote 返回 `REMOTE_UNSUPPORTED`。

旧自建 daemon client/server/protocol/session manager/journal、Local activator、POSIX process cleanup、Remote artifact/connector、`agentmuxd` bin 与 `node-pty` dependency 已删除。Desktop package 改为携带并检查相同 CtxMux artifacts。

## Codex、身份与 CLI vertical 已完成

Codex 没有接入 CtxMux 的 Codex Integration。AgentMux 既有 Provider 继续负责 executable probe、Launch/Resume argv、Hook/Permission 归一化、native handle 与 Evidence；唯一 private `CtxmuxRunAdapter` 只接收 Provider 已生成的通用 Run Intent，并返回 daemon-issued exact RunId。

Core `AgentMuxAgentSessionRegistry` 与 File Store 是唯一身份 Owner：

- `agentSessionId` 是 CLI、SDK、Desktop 的稳定主键；
- current CtxMux RunId 与一个 Agent Session 一一绑定；
- Provider native id 必须和 Provider id 组成反查键，ACP handle 使用 adapter id + session id；
- duplicate Run、duplicate native handle、unknown、conflict 与 retired Run 全部失败关闭；
- CtxMux 不解释或索引 Agent identity，CLI/Renderer 不保存第二份索引。

CtxMux 不允许对已经自然退出的 Run 再调用 Stop。Provider-native Resume 因而在同一 Core Session 记录中保留最多 16 个 retired exact Run tombstone：它们只用于阻止旧 Run 被反查、控制或误投影成 Raw Terminal，不保存 PID、Output、Replay 或 Kernel 状态。current mapping 仍只有一个 RunId。

Hook ingress 使用每次 lifecycle operation 派生的有界 binding identity；等 CtxMux 返回 daemon-issued RunId 且 Agent Session 已持久化后才把事件绑定到 exact Run。Hook command 为每次投递生成稳定 receipt id；已绑定 Run 的 HTTP ingress 只有在 owner persistence 成功后才返回 `204`，失败返回非 2xx 供同一 receipt 重试，关闭时排空已接受的事件。Core Client/CLI 重开时从同一 Store 恢复 endpoint binding，Hook/permission receipt 仍必须匹配当前 Agent Session、Provider 与 Run。

File Store version 3 是 Agent Session、current Run、retired Run、Semantic Session retirement 与 lifecycle reservation 的唯一跨进程真相。Create/Resume/Stop 通过文件锁、CAS、带 owner/PID/lease 的 reservation 和 CtxMux Run spec 中的 lifecycle operation id 提交；Stop reservation 在 dispatch 前保存完整 `{daemonInstance, operationKey, runId}`，并只通过 Protocol 13 recoverable Stop 路径完成。Owner crash 后，新 Client 只按 public `list/status/attachRecoverableStop` 收敛原 operation。自然退出的 Run 只记录 retire，不伪造 Stop。没有进程内 Map 充当第二提交权威，也没有旧 Store migration/fallback；version 2 直接拒绝。

Codex 终端输入不是“写入成功即 ready”。初次启动先回应 Codex terminal capability query；后续 prompt 必须原子消费 exact Run 的一个未消费 Stop receipt。Core 从 CtxMux public Output byte 0 开始，以有界 `@xterm/headless` terminal emulator 连续重放 retained Replay 与 live bytes；任何 Gap、重叠或非连续 range 都失败关闭。Stop readiness 只在当前 cursor 所属 active composer 确实为空且 screen 已重放到 Stop cursor 后成立。两阶段 `payload` + `CR` 中，Core 先写 payload，随后只在当前 screen/cursor 的 composer 精确等于 payload 且 output 已越过写入前 boundary 时发送 CR。Codex 的局部更新不要求重复绘制左侧 `›`，但 assistant 行、历史全屏 redraw 或相同文本 substring 都不能冒充当前 composer。每阶段使用确定性 CtxMux Input operation id 和累计 input cursor，因而 payload/submit 任一点 crash 后都能由新 Client 恢复且不重复输入。Provider-native resume 的第一条 prompt 直接进入 native resume argv，不参与 startup composer race。

checkout-external packed consumer 真实证明：

1. Codex Provider create 后取得 CtxMux RunId/PID，并观察 `SessionStart`、Permission、Stop 与 native session id；
2. AgentMux ID、exact RunId、Provider + native id、ACP handle 四种查询只解析到同一 Session；
3. 第一个 Client 完全退出后，第二个 Client 用同一 AgentMux ID 重连原 RunId/PID 并 Replay；
4. `agentmux list/status/attach/send/interrupt` 只接收 AgentMux ID，调用方不理解 RunId 或 Codex native 参数；
5. provider-native `agentmux resume --text <prompt>` 保留 AgentMux ID、创建新 RunId，并把首条 prompt 放入 native resume argv；旧 Run 查询变成 `STALE_AGENT_SESSION_BINDING`；
6. no-Stop、已消费 Stop、不同 operation 并发全部失败关闭；assistant 行里的 `›`、历史 screen 中与 payload 相同的文本都不能伪造当前 composer，post-cursor live readiness 与 payload/submit crash recovery 都只提交一次；
7. 两个独立 Node 进程竞争 Create/Resume 只提交一个 current Run，失败者不留下 orphan；自然终态 retire 不调用 Stop；
8. 外部 `switch` 只聚焦已打开 View；新 Run 的 Hook receipt 绑定新 RunId，`agentmux stop` 清理 current Run 与 Session binding；
9. Shell vertical 的 UTF-8、Input recovery、Resize、Interrupt 与 stubborn-tree Stop 在同一 packed proof 中继续通过。

Core View Resolver 只接收当前已打开 View 的投影。Raw Terminal 按 runtime-issued View ID，Agent 按 AgentMux ID 唯一解析；zero/multiple/stale/closed 都失败。Desktop typed focus broker 只激活既有 workspace/pane/tab，不 Open、Attach、Resume、Spawn 或修改 CtxMux Attachment。

CLI 同时是受管 Agent 可自发现的公共控制面，而不只是给人手工调用的二进制：

- 每个 Local Run 都收到权威 `AGENTMUX_ENV=1`、`AGENTMUX_CLI`，并把随 `@agentmux/core` 打包的 `agentmux` 目录放在 `PATH` 首位；Agent Run 额外收到稳定的 `AGENTMUX_AGENT_SESSION_ID`；
- 顶级 `agentmux --help` 按 Inspect、Control、Desktop 分组解释对象与命令，具体 `agentmux <command> --help` 写明成功语义、失败关闭边界和下一条建议命令；
- `agentmux --skill` 输出可直接被 Coding Agent 阅读的调用说明，要求先验证 caller context、优先解析 JSON receipt、使用返回 ID 而不是猜测焦点或列表顺序；
- 不提供 `appmux`、旧文件名或其他 compatibility alias；品牌命令只有 `agentmux`；
- 当前 `switch` 只聚焦已打开 View。创建、分屏、移动、打开或 Spawn Desktop Pane/Tab/View 属于独立 Desktop Composition 控制面，不偷渡进 T-020，也不因缺少 CLI 而退化为 computer-use。

Agent-friendly 不是多写一页帮助，而是让受管 Agent 能在一次发现后闭环执行：从 injected caller context 确定“我在哪”，从只读命令枚举 workspace、View、Region 与 Agent，用显式 target 发出原子 mutation，再从 JSON receipt 读取新 ID 和下一步。Desktop Composition 因此把 layout primitive 与 Agent lifecycle 分开：先在当前 View 中建立有方向的 Region，再在该位置启动指定 Provider，并在可交互后返回稳定 Agent Session id。`switch` 继续只负责 focus，Core Session CLI 继续只负责 Agent lifecycle；不能用 UI 焦点猜 target，也不能把 computer-use 当成缺少公共命令时的 fallback。

checkout-external packed consumer 会在真实 CtxMux PTY 内执行 `agentmux --version`，并由 fake Codex 复核相同 managed CLI environment，证明这不是仓库 PATH 或全局安装造成的偶然可用。npm Package 的 CLI 使用其声明的 Node 24 host；Desktop Package 则把同一入口物化为只调用 `.app` 自带 Electron Node mode 的 launcher，打包 smoke 在 `PATH=/usr/bin:/bin`、没有外部 Node 的条件下直接执行它，不改变用户普通 `node` 解析。

Desktop 的 Terminal View 不再直接一对一占有 Core Attachment。Main Process 以 exact `(hostId, runId)` 串行化 attach/detach，为第一个 View 建立一个 retained Core Attachment，为后续 View 通过 `readRunReplay` 获取各自 byte cursor 的 Replay，并给每个 View 返回 opaque `attachmentId` lease；只有最后一份 lease 释放才调用 `releaseRunAttachment(exact RunRef)`。Agent Session 的多 View acknowledgement 取最大 cursor，迟到的慢 View 不能回退持久进度。因此双 Pane、Terminal/Activity 快速切换和 Renderer 消失不会把一个 View 的 cleanup 错当成另一个 View 的 Attachment 生命周期。

Host 配置替换从 `prepare` 到 `commit/discard` 持有显式 reservation。reservation 建立后先等待已经登记的 Launch/Resume 与 Attachment tail 收敛，再复核旧 Host 没有 Run；期间新生命周期操作失败关闭。这样不能在“第一次检查为空”之后插入新 Run 或 Attachment，再让 commit 把它连同旧 Client 一起异步丢弃。Desktop 退出同样先等待这些 owner-owned tail，再 dispose Core Client，Electron 的最终 quit 在 cleanup 完成后继续。

## 安全边界

Interrupt 使用 retained PTY 上的 `TIOCSIG`。Stop 的 macOS public POSIX implementation 保留极窄 PID reuse race：身份重验后到发信号前若目标退出、同 PID 被同 UID 新进程立即复用，理论上可能误发信号。

本项目接受 CtxMux 的 practical POSIX contract：daemon 永不提权；只支持同一用户本地运行；即时重验 session；zombie leader 作为 incarnation anchor；异常失败关闭；不宣称多租户隔离或数学零风险。为消除这条窄窗而引入私有 entitlement/API 或平台进程容器，成本和维护熵显著高于本地开发场景的实际风险。

## 剩余边界

Protocol 13 当前固定 artifact 在 ctxmux 的单一 persistence owner 内按 SQLite typed `DiskFull`
保留并有界重试同一个 mutation；队列、顺序、Replay 与终态仍由 ctxmux 持有。AgentMux 不增加
daemon 重启、备用状态库、错误字符串分类、兼容层或 fallback。

现有正式 Benchmark 结果不能外推为 Protocol 13 的测量结果。Remote/SSH 也继续保持 typed unsupported，
直到 ctxmux public Remote 合同交付；AgentMux 不私造 Remote wire、artifact ingress 或第二 Runtime owner。
