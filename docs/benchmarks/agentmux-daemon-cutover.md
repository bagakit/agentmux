# AgentMux Daemon Cutover Benchmark

状态：历史 Protocol Freeze Revision 1，已因 mux 决策修正停止。它只适用于被放弃的自建 `agentmuxd` candidate；4 MiB Debug Run 的 sustained-output timeout 已记录为失败证据。Workload、样本量、主指标、统计方法和门槛继续保留，不覆盖旧结果；旧 Runner 已删除。T-013 只提炼候选无关 Fixture 与统计原语，最终 AgentMux+ctxmux candidate 要到 T-018 建立新的 Protocol Revision 和 Runner。

## 1. 判定问题

本 Benchmark 只回答一个问题：在相同机器、相同 PTY Workload 和相同 correctness oracle 下，新的持久 `agentmuxd` 是否在所有可比发布主维度优于切换前真实 tmux Runtime，同时保留已经交付的持久化、安全和资源上限。

发布 Verdict 只有 `pass` 或 `fail`。任何可比主维度回退、correctness oracle 失败、两轮方向不一致、资源超预算或缺少原始样本都会得到 `fail`；不允许用加权总分掩盖单项回退。

## 2. 冻结候选与可比边界

### AgentMux Candidate

- 当前提交构建的 `@agentmux/core` 与包内 `agentmuxd`。
- Local Unix Socket、`AgentMuxDaemonClient`、Incremental Output、Sequence、Ack、Bounded Replay 与 Process Tree Stop。
- 一个独立 Daemon；Benchmark Runner 是 Client，不把 Runner RSS 计入 Daemon RSS。

### 强制 tmux Baseline

- 系统 `tmux 3.6b`，使用独立 `-L agentmux-benchmark-*` Server，不读取或修改用户现有 tmux Server／Session。
- 行为冻结自切换前提交 `2b02df4` 的 `packages/core/src/tmux-client.ts` 与 Runtime：
  - Create：`new-session -d`，随后设置 `remain-on-exit on` 与 `history-limit 50000`；
  - Input：每次 `load-buffer` + `paste-buffer -d`；
  - Visible Output：每 750 ms 执行 `capture-pane -p -e -J -S -50000`，与旧 Runtime 默认 Poll Interval 相同；
  - Attach／Replay：一次 `capture-pane`；
  - Reconnect：`list-sessions`、`list-panes`、`show-environment` 与 `capture-pane`；
  - Stop：`kill-session`。
- Runner 可以直接固化这些命令，不把已删除的 tmux 产品代码重新引入 Core，不提供 Backend Selector、Compatibility Layer 或 Fallback。

### 其他产品

- Zellij 与 WezTerm mux 只有在运行前能从 `PATH` 找到固定版本、且能表达同一 Persist／Input／Capture／Stop Contract 时才运行；当前环境未安装时记录 `unavailable`，不得下载或安装后临时扩围。
- a mature workbench／a mature workbench 是产品与源码参考，不是稳定的公开 Headless Benchmark Contract。不能验证相同输入、Replay Cursor 和进程树清理时标记 `not_comparable`，不得伪装为 AgentMux 胜出。
- 不连接真实 SSH Host。Remote 网络、认证与 MTU 噪声不进入本地 Cutover 主 Verdict；隔离 SSH 的 Partition／Recovery 已由 T-007 Stress Gate 保护。

## 3. 冻结环境

首轮目标机：

| 项目 | 冻结值 |
| --- | --- |
| OS | macOS 26.3.2 / Darwin 25.3.0 |
| CPU | Apple M4 Pro |
| Memory | 48 GiB |
| Architecture | arm64 |
| Node | 24.14.1 |
| pnpm | 11.5.1 |
| tmux | 3.6b |
| Terminal Geometry | 120 × 36 |
| Locale | `LANG=C`, `LC_ALL=C`, `TZ=UTC0`（子进程） |

每个原始结果还必须记录 Git SHA、Dirty Paths、Node／OS／Arch、CPU、总内存、tmux／可选竞品版本、开始／结束时间、Protocol Revision 和 Runner Version。Dirty Worktree 允许只包含当前 T-008 Runner／Result 工作，但必须逐项写入 Manifest；正式 Verdict 只接受结果与 Runner 同一最终候选 SHA 的重跑。

## 4. Workload 与样本量

所有时间使用 `process.hrtime.bigint()`；延迟单位为微秒，吞吐单位为 Payload Byte／Second，RSS 为 KiB。Marker 使用 ASCII，Sequence 与 Hash 按 UTF-8 Payload Byte 计算。

### A. Input-to-visible-output

- Fixture 是同一个 `node` 行式 Echo Agent；收到 `latency:<sample-id>` 后立刻输出 `visible:<sample-id>`。
- 每个 Runtime 先 Warmup 20 次，再采集 120 次。
- 输入严格串行；前一 Marker 可见后才发下一次，避免队列吞吐冒充单次延迟。
- tmux Watcher 固定 750 ms；每次发送前使用 Seed `8008` 在一个 Poll Period 内生成均匀 Offset，避免总在 Poll 后立刻发送的相位偏差。AgentMux 使用同一 Offset 序列；等待时间不计入延迟。
- 记录 p50、p95、p99 和全部原始 Sample。

### B. Sustained Output Throughput

- Input 触发 Fixture 输出恰好 4 MiB 可验证 Payload，使用 16 KiB Chunk，最后输出 SHA-256 End Marker。
- Warmup 1 次，采集 7 次；每次使用新 Session，避免历史窗口互相污染。
- AgentMux 从 Input Ack 到 Client 收齐 End Marker；tmux 从 Paste 完成到 750 ms Watcher 的 Capture 收齐 End Marker。
- Correctness 要求 Payload Byte Count 与 SHA-256 完全一致；不完整样本计失败，不删掉重跑。

### C. Attach／Replay

- Session 先产生 192 KiB Payload 并 Detach。
- Warmup 20 次，采集 100 次。
- AgentMux 计一次 `attach(sessionId, 0)` 返回完整 Replay；tmux 计一次冻结 `capture-pane` 返回完整历史。
- 每个样本验证 End Marker 和内容 Hash；记录 p50／p95／p99。

### D. Reconnect Recovery

- 一个保持运行且已经产生 64 KiB 历史的 Session。
- Warmup 20 次，采集 100 次。
- AgentMux 从新 Local Socket Client Connect 开始，到 Hello 身份核对与 Attach Replay 完成；tmux 从新控制调用开始，依次完成冻结的 List Session／Pane／Environment／Capture。
- 必须保持原 PID 与 Session 身份，不允许 Respawn；记录 p50／p95／p99。

### E. Concurrent Session Scale

- 5 轮，每轮从空 Runtime 创建 32 个 120×36 Session；每个 Fixture 输出 Ready Marker。
- 记录全部 Session Ready 的 Wall Time、Session／Second、Daemon／Server Peak RSS、每 Session RSS 增量和失败数。
- 创建完成后统一 Stop，并验证 Session 列表为空、Fixture PID 不再可控制。

### F. Stop Cleanup

- 10 个独立样本使用同一个“根进程与子进程都忽略 HUP／TERM”的 Fixture。
- 从 Stop 请求开始，到根／子 PID 都不再可控制为止；记录 p50／p95／p99 与 Cleanup Success。
- Zombie 视为已停止、等待 Parent Reap；仍可运行的孤儿进程是 correctness failure。
- 若 Baseline 不能清理完整 Process Tree，它首先失败 correctness，不用更快的“只杀入口”时间赢得 Stop 指标。

### G. CPU 与 RSS

- 分别启动空 AgentMux Daemon 与空 tmux Server；稳定 2 秒后，每 200 ms 采样 15 次。
- Idle CPU 使用 `ps time` 在采样窗口内的增量；Idle RSS 取 15 次均值。
- Per-session RSS 使用 1 Session 与 32 Session 稳态相对 Idle 的增量。
- Steady／Peak RSS 使用 4 MiB Throughput Workload 的采样序列；停止并释放后再采样 15 次作为 Released RSS。
- Runner RSS 不计入任一 Runtime；Fixture 子进程 RSS 单独记录且不混入 Owner RSS。

## 5. 统计方法

- 分位数使用排序后的 nearest-rank；p99 至少需要 100 个样本。
- 汇总同时输出 count、min、mean、p50、p95、p99、max、standard deviation。
- 使用固定 Bootstrap Seed `8008`、10,000 次有放回重采样，为 mean 与 p50／p95／p99 输出 95% Percentile Confidence Interval。
- 不删除 Outlier，不 Winsorize，不按 IQR 过滤。OS 调度、GC、tmux Server 启动和失败样本全部进入 Raw Result；失败另有 Error Code／Phase。
- 至少两轮独立完整运行；每轮之间完整 Shutdown 两个 Runtime、等待 10 秒，不共享 Session、Replay 或 Server。两轮所有 Gate 必须同方向通过。

## 6. 冻结资源预算与胜出门槛

### Correctness Gate

- AgentMux 与 tmux 的每个有效样本必须通过 Marker、Byte Count／Hash、Session Identity 和 Cleanup Oracle。
- AgentMux 还必须通过 Sequence 单调、无隐藏 Gap、Reconnect 不 Respawn、Stop 后零 Session；tmux 必须无仍可运行的孤儿进程。
- 任何 AgentMux correctness failure 直接 `fail`；Baseline correctness failure 诚实记录，并使对应性能项不可用，不能算成 AgentMux 的速度胜出。

### Resource Budget

- AgentMux Daemon：沿用 T-007，Idle RSS 不超过 96 MiB；32 Session Peak RSS 不超过 160 MiB；20 轮释放无 FD 线性增长；Idle CPU 不超过 1%。
- 单 Runtime Client Queue、Replay、Frame、Session 与 Client 数继续使用 `docs/testing/strategy.md` 的硬上限；Benchmark 不提供放宽开关。
- Desktop：沿用 T-007，Terminal 增量 256 MiB、Editor 增量 512 MiB、释放后进程组 1 GiB、Warm Cache 漂移 128 MiB。Desktop 数字不与 Headless tmux Server 混合。

### Release Primary Dimensions

对每个可比指标，两轮都必须满足：

- AgentMux Input-to-visible p50、p95、p99 均小于 tmux；
- AgentMux Throughput p50 大于 tmux，且每轮都完整通过 4 MiB Hash；
- AgentMux Attach／Replay p50、p95、p99 均小于 tmux；
- AgentMux Reconnect p50、p95、p99 均小于 tmux；
- AgentMux 32 Session Ready Wall Time 小于 tmux，Session／Second 大于 tmux；
- Stop 只有在双方 correctness 都通过时比较 p95，AgentMux 必须更小；若 tmux 留下可运行孤儿，tmux Stop correctness 直接失败；
- AgentMux Idle CPU、Idle RSS、Per-session RSS、Steady RSS、Peak RSS 与 Released RSS 均小于 tmux 对应值，同时不超过自身硬预算。

这里故意不设容差、不做加权，也不允许“延迟收益抵消内存回退”。如果独立 Node Daemon 的 RSS 高于 tmux，T-008 就应失败，后续只能基于这份冻结证据重新讨论产品目标，不能回头把 RSS 降为次要指标。

## 7. Raw Result Contract

Runner 写入一个不覆盖已有文件的 JSON：

```json
{
  "schema": "agentmux.benchmark.daemon-cutover.v1",
  "protocolRevision": 1,
  "runId": "<uuid>",
  "round": 1,
  "manifest": {},
  "comparators": {},
  "workloads": {
    "inputToVisible": { "agentmux": { "samplesUs": [] }, "tmux": { "samplesUs": [] } },
    "throughput": {},
    "attachReplay": {},
    "reconnect": {},
    "sessionScale": {},
    "stopCleanup": {},
    "resources": {}
  },
  "correctness": {},
  "summary": {},
  "verdict": "pass | fail"
}
```

Raw Sample、失败、跳过原因与 Manifest 全部保留。汇总脚本只读 Raw JSON，不能重新跑 Workload 或修改样本。默认输出目录是 `docs/benchmarks/results/`；文件名包含 Round、Git Short SHA、Platform 和 UTC Timestamp，采用排他创建，禁止覆盖。

## 8. 复现与安全

Revision 1 已没有可执行入口，避免继续在错误 candidate 上累积结果。`run-kernel-workload.mjs` 和 `run-kernel-statistics.mjs` 是 T-013 保留的中立资产，不构成 Benchmark Runner，也不会写结果目录。

T-018 只有在 ctxmux Adapter 已通过无豁免 Conformance 后，才按本文件冻结的新 Revision 重建两轮 Runner。新 Runner 只能创建自己的临时目录、精确命名的 tmux Baseline 和 Fixture Process；不得读取或删除用户 tmux Session，不连接未授权 SSH，不下载竞品，不改 Agent Hook/Credential，不发布 Package。
