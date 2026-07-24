# CtxMux Local cutover

状态：T-020 Local + Codex implementation candidate；最终真实 Codex 与独立复核 pending
更新：2026-08-15

## 固定消费身份

AgentMux 当前只消费 CtxMux 的 exact clean artifact contract：

| 字段 | 值 |
| --- | --- |
| commit | `2e32a9d647d627952ea5c455fb2efef6c636643a` |
| tree | `d60870c2481c9b153da6bf22f829d24afb8a81a8` |
| protocol | `9` |
| platform | `darwin-arm64` |
| SDK tarball SHA-256 | `1e14be5fdb1193ddce4a266b03d2a8c72bad35e0d88838d504566c438b279b99` |
| `ctxmux` SHA-256 | `d49d8c0ca268f3257ee499cedd41035c10fcd05d7e2255ea9a0da204fad6e021` |
| `ctxmuxd` SHA-256 | `5bb6592989bfc0e77287baba63b6ae4aa0ba536825e74381a787be3d196cf9b6` |

接入确认时 CtxMux `origin/main` 指向 `2e32a9d`；AgentMux 不消费浮动分支名，而是固定上表中的完整 commit、tree 与 artifact hash。

CtxMux 自己的 `npm run test:local-consumer` 已在 exact commit 上通过，receipt 为：

```text
local artifact consumer passed commit=2e32a9d647d627952ea5c455fb2efef6c636643a target=aarch64-apple-darwin
```

AgentMux vendor 已由 `2e32a9d` clean build 整套替换。

## 消费方式

`packages/core/vendor/ctxmux/darwin-arm64` 是唯一 Artifact 输入，内容只有 CtxMux manifest、SDK tarball 与两个 binaries。Core build 先验证 manifest、platform、mode、size 与 SHA-256，再从 tarball 私有 bundle SDK 到 `CtxmuxRunAdapter`。

Local endpoint 不是可选 Backend。Core 不接受外部 socket/state path；Darwin 固定使用长度有界的 `/private/tmp/amx-<uid>-<artifact-id>/`，不受调用进程 `TMPDIR` 长度影响，socket 当前为 57 bytes。Adapter 创建并复核 `0700` runtime/state 目录，启动前复核 manifest 整体 digest、binary bytes/mode 与 `ctxmuxd --version`，然后只从该随包绝对路径启动 daemon。首次启动通过 caller-owned fd 3 接收 `ctxmux.daemon-ready.v1`，只有 inherited receipt 的 daemon instance 与 public handshake 完全相等才写 owner receipt；socket race、PID、sleep 或 filesystem-only receipt 都不能证明所启动的 child。重连时响应 peer 还必须匹配 `0600` owner receipt 中的 full commit/tree/manifest/binary/path/endpoint 和 daemon instance；仅 protocol 9 相同不足以被声明为该 build。

AgentMux 启动 ctxmuxd 时建立 terminal-capable 基线：`TERM=xterm-256color`、`COLORTERM=truecolor`，并删除父宿主遗留的 `NO_COLOR`、`FORCE_COLOR=0` 与 `CLICOLOR=0`。Provider/调用方仍可通过 Run env 显式覆盖终端设置。这样既保留 Codex ANSI/truecolor，也让 Stop 后的 synchronized active-composer frame 可被同一 raw PTY 链路证明。

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

File Store version 2 是 Agent Session、current Run、retired Run 与 lifecycle reservation 的唯一跨进程真相。Create/Resume/Stop 通过文件锁、CAS、带 owner/PID/lease 的 reservation 和 CtxMux Run spec 中的 lifecycle operation id 提交；Owner crash 后，新 Client 只按 public `list/status/stop` 回收匹配 operation 的未提交 Run。自然退出的 Run 只记录 retire，不伪造 Stop。没有进程内 Map 充当第二提交权威，也没有旧 Store migration/fallback。

Codex 终端输入不是“写入成功即 ready”。初次启动先回应 Codex terminal capability query；后续 prompt 必须原子消费 exact Run 的一个未消费 Stop receipt。Stop receipt 保存当时的 CtxMux output byte cursor，Core 只在该 cursor 之后观察到有界 synchronized active-composer frame 后才允许两阶段 `payload` + `CR` 提交。每阶段使用确定性 CtxMux Input operation id 和累计 input cursor，因而 payload/submit 任一点 crash 后都能由新 Client 恢复且不重复输入。Provider-native resume 的第一条 prompt 直接进入 native resume argv，不参与 startup composer race。

checkout-external packed consumer 真实证明：

1. Codex Provider create 后取得 CtxMux RunId/PID，并观察 `SessionStart`、Permission、Stop 与 native session id；
2. AgentMux ID、exact RunId、Provider + native id、ACP handle 四种查询只解析到同一 Session；
3. 第一个 Client 完全退出后，第二个 Client 用同一 AgentMux ID 重连原 RunId/PID 并 Replay；
4. `agentmux list/status/attach/send/interrupt` 只接收 AgentMux ID，调用方不理解 RunId 或 Codex native 参数；
5. provider-native `agentmux resume --text <prompt>` 保留 AgentMux ID、创建新 RunId，并把首条 prompt 放入 native resume argv；旧 Run 查询变成 `STALE_AGENT_SESSION_BINDING`；
6. no-Stop、已消费 Stop、不同 operation 并发全部失败关闭；lookbehind readiness、post-cursor live readiness、payload/submit crash recovery 都只提交一次；
7. 两个独立 Node 进程竞争 Create/Resume 只提交一个 current Run，失败者不留下 orphan；自然终态 retire 不调用 Stop；
8. 外部 `switch` 只聚焦已打开 View；新 Run 的 Hook receipt 绑定新 RunId，`agentmux stop` 清理 current Run 与 Session binding；
9. Shell vertical 的 UTF-8、Input recovery、Resize、Interrupt 与 stubborn-tree Stop 在同一 packed proof 中继续通过。

Core View Resolver 只接收当前已打开 View 的投影。Raw Terminal 按 runtime-issued View ID，Agent 按 AgentMux ID 唯一解析；zero/multiple/stale/closed 都失败。Desktop typed focus broker 只激活既有 workspace/pane/tab，不 Open、Attach、Resume、Spawn 或修改 CtxMux Attachment。

Desktop 的 Terminal View 不再直接一对一占有 Core Attachment。Main Process 以 exact `(hostId, runId)` 串行化 attach/detach，为第一个 View 建立一个 retained Core Attachment，为后续 View 通过 `readRunReplay` 获取各自 byte cursor 的 Replay，并给每个 View 返回 opaque `attachmentId` lease；只有最后一份 lease 释放才调用 `releaseRunAttachment(exact RunRef)`。Agent Session 的多 View acknowledgement 取最大 cursor，迟到的慢 View 不能回退持久进度。因此双 Pane、Terminal/Activity 快速切换和 Renderer 消失不会把一个 View 的 cleanup 错当成另一个 View 的 Attachment 生命周期。

Host 配置替换从 `prepare` 到 `commit/discard` 持有显式 reservation。reservation 建立后先等待已经登记的 Launch/Resume 与 Attachment tail 收敛，再复核旧 Host 没有 Run；期间新生命周期操作失败关闭。这样不能在“第一次检查为空”之后插入新 Run 或 Attachment，再让 commit 把它连同旧 Client 一起异步丢弃。Desktop 退出同样先等待这些 owner-owned tail，再 dispose Core Client，Electron 的最终 quit 在 cleanup 完成后继续。

## 安全边界

Interrupt 使用 retained PTY 上的 `TIOCSIG`。Stop 的 macOS public POSIX implementation 保留极窄 PID reuse race：身份重验后到发信号前若目标退出、同 PID 被同 UID 新进程立即复用，理论上可能误发信号。

本项目接受 CtxMux 的 practical POSIX contract：daemon 永不提权；只支持同一用户本地运行；即时重验 session；zombie leader 作为 incarnation anchor；异常失败关闭；不宣称多租户隔离或数学零风险。为消除这条窄窗而引入私有 entitlement/API 或平台进程容器，成本和维护熵显著高于本地开发场景的实际风险。

## 下一闭环

已提交的基础为 `8322cbf`（Core Codex/identity/CLI）与 `1f74518`（Core View Resolver/typed Desktop focus）；当前未提交候选补齐跨进程 lifecycle、真实 Codex Hook/resume、Stop-epoch readiness、prompt crash recovery、Darwin 短 endpoint、可安装 package smoke 与 Desktop View lease broker。2026-08-15 的 candidate 已通过 typecheck、159 个 fast tests、checkout-external packed Native proof、Production build 和独立 Attachment review；先前候选的 DMG/签名/LaunchServices/CtxMux smoke 也已通过，并从 `~/Applications/AgentMux.app` 启动精确 artifact owner。最终真实 Codex E2E、clean commit 上的 Tracker Gate 完成前，不把 T-020 标记为 done。Remote/SSH 继续留给 T-021；不得重新引入 Run owner、Backend Selector、复制 wire、fallback 或 compatibility。
