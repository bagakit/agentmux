# CtxMux Local cutover

状态：T-020 Shell checkpoint candidate；Codex vertical pending
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
5. Resize 由真实 PTY 回读为 `101x37`；
6. Interrupt 被进程观察且进程继续 running；
7. 忽略 HUP/TERM 的 root/child process tree 被 Stop 完整清除；
8. Remote 返回 `REMOTE_UNSUPPORTED`。

旧自建 daemon client/server/protocol/session manager/journal、Local activator、POSIX process cleanup、Remote artifact/connector、`agentmuxd` bin 与 `node-pty` dependency 已删除。Desktop package 改为携带并检查相同 CtxMux artifacts。

## 安全边界

Interrupt 使用 retained PTY 上的 `TIOCSIG`。Stop 的 macOS public POSIX implementation 保留极窄 PID reuse race：身份重验后到发信号前若目标退出、同 PID 被同 UID 新进程立即复用，理论上可能误发信号。

本项目接受 CtxMux 的 practical POSIX contract：daemon 永不提权；只支持同一用户本地运行；即时重验 session；zombie leader 作为 incarnation anchor；异常失败关闭；不宣称多租户隔离或数学零风险。为消除这条窄窗而引入私有 entitlement/API 或平台进程容器，成本和维护熵显著高于本地开发场景的实际风险。

## 下一闭环

Shell checkpoint 不代表 T-020 完成。下一步只把 Codex 代表 vertical 接入同一个 Adapter，并解决 AgentSession/Hook 对 exact RunId 的绑定；不得重新引入自建 Run owner、Backend Selector、复制 wire 或 fallback。CLI identity/switch、最终 chaos/resource/benchmark/review 继续按 T-020 后续 Gate 收敛。
