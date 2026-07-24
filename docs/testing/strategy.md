# AgentMux 测试策略

更新：2026-08-14

## 权威边界

AgentMux 只测试自己的公共 Core/Client 行为和 CtxMux public boundary，不读取 CtxMux wire、数据库、PID table 或私有模块。PTY、Replay、Signal 与 Stop 的底层正确性由固定 CtxMux source Gate 拥有；AgentMux 必须另做 checkout-external composition proof，证明打包和映射没有破坏这些能力。

Terminal output 是 raw PTY bytes 的 UTF-8 投影，不是模型上下文、Tool、Permission、Reply 或 Worker Done 证据。

## 当前 Shell checkpoint proof map

| 不变量 | AgentMux public oracle |
| --- | --- |
| exact artifact identity | pack 内 manifest 固定 commit `3b94288c3a7896bb355e028135409c8e8bbaf764`、tree `58f3630477881e75f0f022d3fbb98a93ff2f46c4`、protocol 9，并在 build/runtime 复核 size/mode/SHA-256 |
| checkout independence | `package-consumer.integration.test.ts` 在 `/private/tmp` 执行 `pnpm pack` 和 offline/no-save npm install；真实 package root 不在 checkout |
| one Run identity | 公共 `AgentMuxRunRef` 只有 CtxMux `runId`；重连后 RunId 与 PID 均不变 |
| ordered byte replay | fixture 拆分一个四字节 emoji 的两次 write；Client 不产生 replacement character；从 byte 7 interior cursor 重连后得到连续 suffix |
| Attachment lifecycle | 第一个 Client dispose 后 Run 继续，第二个 Client attach 同一 Run；detach/dispose 不 stop |
| Resize | public resize 到 `101x37`，真实 PTY 子进程从 TTY 读回并输出同一尺寸 |
| Interrupt | public `SIGINT` 经 CtxMux portable Interrupt；fixture 观察信号后继续 running |
| complete Stop | 忽略 HUP/TERM 的 root + child fixture 经 public Stop 后全部 PID 消失 |
| Remote boundary | `connectSshAgentMux` 与 SSH execution host 返回 typed `REMOTE_UNSUPPORTED`，没有旧 SSH Run fallback |
| no second runtime | packed file list 和源码审计不存在自建 daemon、wire、journal、`node-pty` 或旧 package bin |

主 Oracle：`packages/core/test/package-consumer.integration.test.ts` 与 `packages/core/test/fixtures/packed-consumer.mjs`。

## POSIX signal 安全语义

Interrupt 使用 CtxMux 在 retained PTY 上的 `TIOCSIG`，由内核在 PTY owner 上执行，不经过 PID lookup gap。Stop 需要遍历完整 POSIX session/process tree；在 macOS 公共 API 上，身份重验与发信号之间仍有无法绝对消除的 PID reuse 窄窗。

CtxMux 的实际边界是：同一用户、本地、非提权 daemon；每次信号前重新验证 session identity；保留 zombie leader anchor；异常一律失败关闭；不把 daemon 当作多租户安全隔离。正常开发机风险接近工程零，但文档不伪造 `10^-N` 概率，也不宣称内核级绝对保证。提权或多租户部署不在支持范围。

## Gate

```bash
pnpm typecheck
pnpm test:fast       # pure domains, Desktop owners, no packed native fixture
pnpm test:native     # exact packed checkout-external CtxMux Shell vertical
pnpm check           # typecheck + fast + native + all builds
```

Fast 与 Native 分开是为了让失败归因清晰，不允许用 Mock 代替 Native proof。Native fixture 使用独立 socket/state directory、真实 packaged `ctxmuxd`、真实 PTY 和显式 PID cleanup。

## 未完成，不能外推

- Codex/Agent Session、Hook、Permission、Resume 还未在 CtxMux Adapter 上完成真实 vertical；
- resource soak、slow consumer、crash/restart、security/fuzz 和最终 benchmark 必须在最终 T-020 candidate 上补齐；
- Remote/SSH 属于 T-021；
- 当前 artifact 只支持 `darwin-arm64`，其他平台必须有自己的 exact manifest 和 Native proof，不能从本机结果推断。
