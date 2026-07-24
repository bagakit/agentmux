# ctxmux 能力审计与 AgentMux Adapter Gate

状态：T-015 已完成对历史 candidate 的审计；`b2bbc7a` **不满足原 T-016 原子替换门槛**。当前 T-020 必须重新审计一个已提交、版本化、可公共消费的 ctxmux candidate；本文件记录的历史事实不授权在 AgentMux 内补齐缺口。

审计日期：2026-08-11（Asia/Shanghai）

## 1. 审计对象与结论

本轮审计对象是公开仓库 [`bagaking/ctxmux`](https://github.com/bagaking/ctxmux) 的精确 commit [`b2bbc7a219753ad2664a438ab89347df180b7d31`](https://github.com/bagaking/ctxmux/commit/b2bbc7a219753ad2664a438ab89347df180b7d31)。GitHub API 显示该仓库创建于 2026-08-09，默认分支为 `main`；该 commit 的 GitHub Actions run `31330002660` 通过。

结论分两层：

- **可用的 Local 基础**：Rust daemon、Rust CLI 和 TypeScript SDK 已通过同一 generation 2 Unix-socket 协议运行真实 PTY。Start、List、Status、Input、Attach、Detach、Replay、Live Output、Resize、Stop 与 Client 退出后重连都有真实行为证据。
- **不能开始替换**：当前没有可合法消费的 License／Release／Package，没有 SSH Transport；Create/Input 没有幂等 cursor 或 lost-response recovery；Output 使用 chunk sequence 而 AgentMux 合同使用 byte cursor；Stop 没有完整后代树保证；Run/Attachment/内存没有 daemon 级总预算与 GC；Runtime identity/capability negotiation、任意 Signal 和 applied-size readback 也未交付。

因此 T-015 可以完成“审计与冻结映射”，原 T-016 的 blocked 证据保持为历史事实。T-020 不能沿用这份 2026-08-11 审计作为当前通过结论：它必须对新的、已提交且版本化的 public candidate 做新鲜审计，并逐项关闭硬 Gate。ctxmux 工作区的 dirty WIP、未提交源码或本地产物都不能关闭任何 Gap。不得用 AgentMux 私有 daemon、Adapter 内持久 Map、隐藏 Backend、wire fork 或 fallback 填这些缺口。

## 2. 发布、License 与供应链

| 检查项 | 判定 | 证据 |
| --- | --- | --- |
| 公开源码仓库 | `available` | GitHub 仓库公开；本轮固定到 `b2bbc7a`，不跟随浮动 `main`。 |
| GitHub Release / Tag | `missing` | GitHub Releases 与 Tags API 都返回空数组。 |
| TypeScript SDK 发布 | `missing` | `packages/sdk/package.json` 为 `@ctxmux/sdk@0.0.0` 且 `private: true`；npm 查询 `@ctxmux/sdk` 返回 404。 |
| Rust crate 发布 | `missing` | 四个 crate 都声明 `publish = false`；`cargo search ctxmux` 无结果。 |
| License | `missing` | 仓库无 License 文件，GitHub License API 返回 404，Manifest 也没有 license/SPDX 字段。公开可读不等于允许复制、分发或打包。 |
| Binary / package artifact | `missing` | 没有 Release asset、稳定 npm tarball、crate 或安装/校验合同。T-020 不能临时下载未知 binary，也不能把 Git checkout 当发布依赖。 |
| 版本 | `available`（开发态） | Rust workspace `0.1.0`、CLI/daemon 输出 `ctxmux 0.1.0 (protocol 2)`；SDK workspace 仍为 `0.0.0`。 |
| CI 平台 | `available`（Linux 单点） | GitHub Actions 只有一个 `ubuntu-latest` Gate；本轮另在 Darwin arm64 原样通过。没有 durable macOS matrix 或发布资格矩阵。 |

Context7 没有 ctxmux 条目；本机常用项目目录、AgentMux lockfile、当前 workspace dependency tree 和 PATH 都没有 ctxmux。审计没有把源码 checkout、生成的 `target/debug` 或临时 npm 安装写入 AgentMux 依赖。

## 3. 当前公开边界的运行证据

在独立临时 checkout 上执行原仓库 `npm ci` 与 `scripts/check.sh`，没有修改 ctxmux 源码：

- 环境：Darwin 25.3.0 arm64、Rust/Cargo 1.96.0、Node 24.14.1、npm 11.12.1；
- Fixture corpus：35 项，`active=13 / characterization=2 / covered=2 / future=17 / rejected=1`；
- Rust：CLI 4 项、daemon 8 项、真实 native lifecycle 7 项、protocol 5 项，全部通过；
- TypeScript：SDK/Integration/protocol 25 项通过；
- 跨语言真实 daemon：CLI 与 SDK 跨 Client 退出共享同一 PID、Codex Level B fork，共 2 项通过；
- format、Clippy、protocol generation drift、typecheck、build 全部通过。

这组结果证明公开 Local vertical slice 真实可运行。它不把 ctxmux 自己标为 future、characterization 或 unproved 的能力升级成已交付。

## 4. Run Kernel 能力矩阵

判定只使用 `available`、`missing`、`not_comparable`：

- `available`：当前 public SDK/protocol 有实现，并有足够的公开 owner-boundary 证据；
- `missing`：AgentMux 替换所需行为、发布物或证据不存在；
- `not_comparable`：ctxmux 用不同但更窄的长期模型消除了该具体动作，仍需在 Adapter 合同中明确。

| 能力 | 判定 | 当前证据与接入含义 |
| --- | --- | --- |
| Local Start/List/Status | `available` | `CtxmuxClient.start/list/status` 走真实 daemon；Run 由 daemon 生成 UUID 并持有 PTY/PID。 |
| Raw Input | `available` | 短请求会等待 `Accepted`；Attachment input 只等待 socket write，远端接受需另读 Event。 |
| Attach / Detach / Client 重开 | `available` | 独立 Attachment connection；clean detach 和 abrupt close 都不 Stop；真实 E2E 核对同一 PID。 |
| 有序 Raw Output | `available` | 每次 PTY read 产生单调 chunk `seq`，Replay 与 Live 的订阅先后和去重边界明确；二进制字节保真。 |
| Retained Replay | `available` | 每 Run 目标 4 MiB，Attach 返回 `chunks/oldest_seq/head_seq/truncated`；退出后仍可读取。 |
| Live Gap 后 public recovery 证据 | `missing` | 协议有 `Gap { head_seq }`，但 ctxmux 自己的测试策略明确记录“真实 daemon lag → Gap → cursor reattach”尚无公开 E2E。 |
| Resize 操作 | `available` | 真实 E2E 用 shell `stty size` 验证 120×40；零尺寸明确拒绝。 |
| Applied-size public readback | `missing` | `RunInfo` 只保留初始 `spec.size`，Resize response 不携带当前实际尺寸。AgentMux 不能把请求值伪装成 Kernel readback。 |
| Stop 直接子进程 | `available` | public Stop 通过 `portable-pty::ChildKiller`，真实测试观察直接 child 退出并拒绝重复 Stop。 |
| 任意 Signal / Interrupt | `missing` | generation 2 只有 Stop，没有 SIGINT 等 public Signal API。 |
| 完整后代树 Stop | `missing` | ctxmux 决策文档明确没有 process-group/descendant-kill 合同，只验证直接 child；daemon 退出时 descendant/orphan 行为也未声明。 |
| Client disconnect recovery | `available` | daemon 仍存活时重连同一 Run/PID、Replay、Input、Resize 和 Exit 可继续。 |
| Daemon crash/restart disposition | `missing` | Run metadata、Replay 和 PTY 全在内存；无 daemon identity/epoch、store、reconciliation 或 orphan policy。 |
| SSH Run / Partition recovery | `missing` | SDK 只接受本地 Unix `socketPath`；没有 stdio proxy、Remote activation、artifact、Host identity 或 SSH public transport。 |
| Protocol generation handshake | `available` | 每条连接必须 Hello，generation 必须精确等于 2；Frame 上限、嵌套验证和错误类别明确。 |
| Build/Host/Capability negotiation | `missing` | Hello 只有 protocol number；没有 daemon build、instance、platform、Host 或 Run capability 集。 |
| Run ID reuse fence | `not_comparable` | ctxmux 只由 daemon 生成随机 UUID，不允许调用方复用 ID；旧 ID 不会指向新 Run。AgentMux Adapter 应采用 ctxmux ID，不应再制造可复用逻辑 ID。 |
| Create idempotency / lost response | `missing` | Start 没有 caller operation ID、Intent fingerprint 或 durable receipt；Response 丢失后无法确认是哪一个新 Run，也不能安全重试。 |
| Input idempotency / lost response | `missing` | Input 没有 start byte、accepted byte cursor、content fingerprint 或 duplicate/conflict 结果；Response 丢失后重试会重复写入。 |
| Output byte cursor | `missing` | ctxmux cursor 是“第几个 PTY read chunk”，不是累计 byte offset；Eviction 后也没有绝对 byte boundary，Adapter 内存无法在重启/截断后可靠重建。 |
| Output acknowledgement | `not_comparable` | ctxmux 依赖 socket backpressure、SDK 256 frame/1 MiB inbound queue、daemon 256 event broadcast 与 Gap，不提供显式 per-Attachment Ack。AgentMux 是否保留 UI Ack 必须只管理 AgentMux 自己的 View queue，不能假装 ctxmux 已确认。 |
| Slow Consumer 隔离 | `available`（基础机制） | 每 Attachment 单独连接；daemon broadcast 有界并可发 Gap，SDK inbound queue 有界并 pause socket。真实 high-volume public Gap/其他 Client 不受影响的组合证据仍归上面的 missing 项。 |
| Per-Run Replay budget | `available`（有限） | 目标 4 MiB，但单个 oversized chunk 会诚实超出一次；不是严格硬上限。 |
| Daemon 全局资源预算 / GC | `missing` | Run、Exited Run、Attachment、线程和 daemon 总内存没有 quota；Exited Run 永久留在 Map，没有 remove/collect API。 |
| Public Package artifact | `missing` | SDK/crates private，License/Release/Tag 缺失，不能成为 AgentMux 可发布依赖。 |

## 5. 对 T-013 Conformance 的逐项判定

| Contract | 判定 | 原因 |
| --- | --- | --- |
| `create-operation-content-identity` | `missing` | 没有 Operation ID、Intent fingerprint 或 lost-response receipt。 |
| `input-content-identity` | `missing` | 没有 input byte cursor、accepted cursor 或不同内容冲突。 |
| `incarnation-fence` | `not_comparable` | Kernel UUID 永不复用，旧引用不会命中新 Run；Conformance 应以“不可命中新 Run”验证，而不是强迫复用 ID。 |
| `ordered-input-output` | `missing` | Output 顺序可用，但没有 byte range；Input 也没有 accepted byte cursor。 |
| `attach-release-replay-gap` | `missing` | Attach/Release/Replay 已有；公开 live Gap recovery 证据、byte cursor 和 Stop 后资源清除不满足完整 Oracle。 |
| `resize-readback` | `missing` | 操作已验证，public applied-size readback 缺失。 |
| `stop-process-tree` | `missing` | 只有 direct-child Stop，无后代树合同和 fixture。 |
| `slow-consumer-budget` | `missing` | 有有界机制和 unit evidence，缺真实 daemon high-volume Gap/recovery/其他 Client 连续性的组合 Gate。 |
| `release-resource-budget` | `missing` | 无 Run/Exited/Attachment/FD/RSS 总预算、GC 或 soak。 |
| `local-recovery` | `missing` | Client 重连可用；Kernel crash 的 disposition、orphan 和身份边界未定义。 |
| `ssh-partition-recovery` | `missing` | 没有 SSH Transport 与 Remote deployment/public identity。 |

不能为了让表格变绿而给 shared Suite 添加 ctxmux 专属豁免。ctxmux candidate 应在硬能力交付后以新的 public Adapter 无 `knownGaps` 运行；不适用的 ID reuse 形状可以把 Oracle 改写为候选无关的 stale-control safety，但不能降低安全结果。

## 6. 冻结的 `CtxmuxRunAdapter` 映射

只有对新的、已提交且版本化的 public candidate 重新审计并关闭上一节硬缺口后，T-020 才实现一个 Adapter。它不是 Backend Registry，也不接入 ctxmux 的 shell/Codex Integration：Agent 发现、Launch Plan、Hook、ACP、Permission、Resume 与 Evidence 继续由 AgentMux Provider 持有。

| AgentMux Run Port | ctxmux public SDK | 映射约束 |
| --- | --- | --- |
| Connect Local | `new CtxmuxClient({ socketPath })` | socket discovery/activation 必须来自 ctxmux 稳定 package 合同；AgentMux 不 import wire。 |
| Connect SSH | 待交付的 ctxmux public Remote connector | 必须使用系统 SSH 与用户认证，核对 Host/Build/Protocol/Capability；不自建 proxy protocol。 |
| Create | `client.start(defineRun(...))` | ctxmux 返回的 UUID 成为 AgentMux `runId`；必须先有 operation/fingerprint/recovery 合同。 |
| List / Status | `client.list/status` | 只映射 AgentMux Run fields；不把 `RunInfo` 或第三方类型 re-export。 |
| Attach | `client.attach(id, cursor)` | snapshot/replay/live event 映射成 `AgentMuxRunAttachment`；必须先统一 byte cursor 与 Gap 语义。 |
| Release | `attachment.detach()` / `close()` | 只释放 Attachment，不 Stop Run。 |
| Input | 短请求 `client.input` | 必须使用可相关、可幂等、带 accepted byte cursor 的 public response；不使用“socket write 已完成”冒充接受。 |
| Resize | `client.resize` | 必须映射实际 applied size，而不是回显请求。 |
| Signal / Stop | 待交付 Signal + `client.stop` | Stop 必须满足完整后代树与确定 disposition；SIGINT 不能翻译成 Stop。 |
| Runtime identity / Doctor | 待交付 public Hello/diagnostics | 只投影稳定 version/build/host/platform/capability，不读取 daemon 私有对象。 |

Adapter 不持久化第二份 Run Map、Replay、Input receipt 或 Remote artifact。若为了弥合缺口需要 AgentMux 自己拥有这些状态，说明 ctxmux 仍未达到接入门槛。

Agent identity 不属于 Adapter。`agentSessionId`、Provider + native session ID、ACP handle 及其唯一性索引全部由 AgentMux Core-owned Store/Resolver 持有；ctxmux `runId` 只作为 exact RunRef 的一部分被索引。CLI、SDK 与 Desktop 先经同一个 Resolver 得到当前 Agent Session 与 RunRef，再调用 Adapter。ctxmux 不解析 AgentMux ID，AgentMux 也不把 ctxmux SDK/wire 类型作为公共身份；零匹配、多匹配、过期 incarnation 或冲突绑定都必须失败关闭。

## 7. 历史 T-016 parked context 与当前 T-020 新鲜审计门槛

以下九项是原 T-016 blocked 时记录的外部解除条件，历史证据继续可审计；T-020 必须在新的、已提交、版本化且可公共消费的 ctxmux candidate 上重新核对，不能用 `b2bbc7a` 的旧结论或当前 dirty WIP 代替：

1. 仓库加入明确 License，并提供版本化、可校验的 `@ctxmux/sdk` 与 `ctxmuxd/ctxmux` Package/Artifact；
2. Public SDK/Protocol 提供 Create Operation content identity 与 lost-response recovery；
3. Public Input 提供 byte cursor、内容冲突和 lost-response recovery；
4. Output cursor 能稳定映射累计 byte range，并有真实 live Gap → Replay recovery 证据；
5. Resize 返回实际 applied size，Signal/Stop 覆盖 AgentMux 所需控制和完整后代树；
6. Run/Exited/Attachment/Replay/FD/RSS 有硬预算、GC 与释放后收敛证据；
7. Hello/Doctor 提供可核对的 Build、Host、Instance/epoch、平台与 Capability；
8. 提供同一 Run 合同的系统 SSH Transport、显式部署/升级方式和 partition recovery；
9. 最终 candidate 在支持平台通过 AgentMux Conformance，无 `knownGaps`；AgentMux Core Store/Resolver 能以 Provider + native session ID、ACP handle 或 exact RunRef 唯一反查稳定 `agentSessionId`，并让 CLI、SDK、Desktop 共用该身份与操作合同。

在这些条件满足前，AgentMux 保持当前可运行过渡实现但不继续给它增加产品能力；T-017/T-018 也不能用旧 candidate 的 Package、资源或 Benchmark 证据冒充最终结果。

## 8. 审计未越权边界

- 没有修改、提交、发布或向 ctxmux 仓库发送 Issue/PR/评论；
- 没有安装全局 ctxmux、下载 Release binary、接入真实 SSH Host 或修改 Credential；
- 只在系统临时目录 checkout 精确公开 commit 并从 lockfile 构建测试；
- 没有读取、修改或纳入 AgentMux 的用户 `.tmp/`；
- 没有为原 T-016 编写 Adapter、Backend Selector、fallback、migration 或兼容层。
