# CtxMux Local cutover

状态：T-020 Local implementation candidate；独立复核 pending
更新：2026-08-14

## 固定消费身份

AgentMux 当前只消费 CtxMux 的 exact clean artifact contract：

| 字段 | 值 |
| --- | --- |
| commit | `3b94288c3a7896bb355e028135409c8e8bbaf764` |
| tree | `58f3630477881e75f0f022d3fbb98a93ff2f46c4` |
| protocol | `9` |
| platform | `darwin-arm64` |
| SDK tarball SHA-256 | `1e14be5fdb1193ddce4a266b03d2a8c72bad35e0d88838d504566c438b279b99` |
| `ctxmux` SHA-256 | `d49d8c0ca268f3257ee499cedd41035c10fcd05d7e2255ea9a0da204fad6e021` |
| `ctxmuxd` SHA-256 | `2299b47cb193d417ceb62a0089a6de62f3324a4edac59506478d124c72a7d7e0` |

接入确认时 CtxMux `origin/main` 指向 `3b94288`；AgentMux 不消费浮动分支名，而是固定上表中的完整 commit、tree 与 artifact hash。

CtxMux 自己的 `npm run test:local-consumer` 已在 exact commit 上通过，receipt 为：

```text
local artifact consumer passed commit=3b94288c3a7896bb355e028135409c8e8bbaf764 target=aarch64-apple-darwin
```

前一份未提交 manifest 与当前 commit 的 tree 相同，因此行为调查可以复用，但 commit-bound manifest 不能复用或改标签。AgentMux vendor 已由 `3b94288` clean build 整套替换。

## 消费方式

`packages/core/vendor/ctxmux/darwin-arm64` 是唯一 Artifact 输入，内容只有 CtxMux manifest、SDK tarball 与两个 binaries。Core build 先验证 manifest、platform、mode、size 与 SHA-256，再从 tarball 私有 bundle SDK 到 `CtxmuxRunAdapter`。

Local endpoint 不是可选 Backend。Core 不接受外部 socket/state path；默认路径由 exact commit 和 manifest SHA-256 派生的 identity 隔离。Adapter 启动前复核 manifest 整体 digest、binary bytes/mode 与 `ctxmuxd --version`，然后只从该随包绝对路径启动 daemon。重连时响应 peer 还必须匹配 `0600` owner receipt 中的 full commit/tree/manifest/binary/path/endpoint 和 daemon instance；仅 protocol 9 相同不足以被声明为该 build。

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
4. 从累计 byte 7 的 interior cursor replay 连续 suffix；
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

Hook ingress 使用每次 lifecycle operation 派生的有界 binding identity；等 CtxMux 返回 daemon-issued RunId 且 Agent Session 已持久化后才把事件绑定到 exact Run。Core Client/CLI 重开时从同一 Store 恢复 endpoint binding，Hook/permission receipt 仍必须匹配当前 Agent Session、Provider 与 Run。

checkout-external packed consumer 真实证明：

1. Codex Provider create 后取得 CtxMux RunId/PID，并观察 `SessionStart`、Permission 与 native session id；
2. AgentMux ID、exact RunId、Provider + native id 三种查询只解析到同一 Session；
3. 第一个 Client 完全退出后，第二个 Client 用同一 AgentMux ID 重连原 RunId/PID 并 Replay；
4. `agentmux list/status/attach/send/interrupt` 只接收 AgentMux ID，调用方不理解 RunId 或 Codex native 参数；
5. provider-native `agentmux resume` 保留 AgentMux ID、创建新 RunId，并把旧 Run 查询变成 `STALE_AGENT_SESSION_BINDING`；
6. 新 Run 的 Hook receipt 绑定新 RunId，`agentmux stop` 清理 current Run 与 Session binding；
7. Shell vertical 的 UTF-8、Input recovery、Resize、Interrupt 与 stubborn-tree Stop 在同一 packed proof 中继续通过。

Core View Resolver 只接收当前已打开 View 的投影。Raw Terminal 按 runtime-issued View ID，Agent 按 AgentMux ID 唯一解析；zero/multiple/stale/closed 都失败。Desktop typed focus broker 只激活既有 workspace/pane/tab，不 Open、Attach、Resume、Spawn 或修改 CtxMux Attachment。

## 安全边界

Interrupt 使用 retained PTY 上的 `TIOCSIG`。Stop 的 macOS public POSIX implementation 保留极窄 PID reuse race：身份重验后到发信号前若目标退出、同 PID 被同 UID 新进程立即复用，理论上可能误发信号。

本项目接受 CtxMux 的 practical POSIX contract：daemon 永不提权；只支持同一用户本地运行；即时重验 session；zombie leader 作为 incarnation anchor；异常失败关闭；不宣称多租户隔离或数学零风险。为消除这条窄窗而引入私有 entitlement/API 或平台进程容器，成本和维护熵显著高于本地开发场景的实际风险。

## 下一闭环

实现提交为 `8322cbf`（Core Codex/identity/CLI）与 `1f74518`（Core View Resolver/typed Desktop focus）。在独立 reviewer 完成 scope、identity、lifecycle 与 Shell regression 复核，并在 clean checkpoint 跑完 `pnpm check` 前，不把 Tracker T-020 标记为 done。Remote/SSH 继续留给 T-021；不得重新引入 Run owner、Backend Selector、复制 wire、fallback 或 compatibility。
