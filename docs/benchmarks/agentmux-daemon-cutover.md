# AgentMux Daemon Cutover Benchmark

状态：Protocol Revision 5 observer candidate 已通过实现期双 Runtime smoke、完整 Repository Gate 与独立静态方法 Review；正式 Result 仍等待 CtxMux owner-layer 资源修复、最终 tracked-clean SHA 和 pre-formal provenance 复核。Revision 4 因 CPU counter 与 wall denominator 的窗口错位、无证据的 `1 ns` resolution 声明被 Review 拒绝，且从未产生正式 Result。Revision 3 Round 1 已于 clean candidate `9a92bd14c3f68314354dc406da16f6766fa4c1d5` 运行并得到 `fail`，Raw Result 永久保留。Revision 1 只适用于已经删除的自建 `agentmuxd`，Revision 2 的首轮 Raw Result 保留为 characterization。历史 Revision 都不覆盖、不改写。

Revision 3 Round 1 的所有 workload correctness 与 cleanup oracle 均通过，tmux 仅按冻结规则暴露完整进程树 Stop 限制；主性能维度中 AgentMux 已胜出 input、throughput、attach、reconnect、32 Run scale、steady/peak/released RSS 与完整 Stop。最终 Verdict 仍然失败：Idle RSS `5120 KiB >= 3536 KiB` 是真实 candidate gap；Per-session RSS 的 `142.5 KiB >= 32 KiB` 方向有独立证据支持，但正式样本把 AgentMux 的一个 historical Run 混入 32 live Run，而 tmux 只有 32 live Session，状态不等价；Idle CPU 两端都由百分之一秒精度的 `ps time` 观测成零，证据不可判定。不能把 `0 == 0` 改成通过、放宽严格 `<`、增加容差或从 RSS 事后扣数。完整原始证据位于 `docs/benchmarks/results/` 中带有 `revision-3-round-1-9a92bd14` 标识的结果文件。

Revision 5 只修正证据合同，不调整门槛：每个 CPU counter endpoint 在同一个 C probe 内由 `CLOCK_MONOTONIC_RAW` 调用前后包围；受控的独立 CPU-burn 子进程形成全部正 counter step 和最小观测 quantum；CPU 比较使用保守区间，只有 AgentMux 上界严格小于 tmux 下界才通过，1% 预算也使用 AgentMux 上界。Released census 现在要求 AgentMux 精确为 `0 live + 33 historical`、tmux 为 `0/0/0`，FD/Run 使用已验证的实际 historical 分母。Revision 4 已修正的 fresh `1 → 32 live + 0 historical` 状态继续保留。数值阈值、样本量、统计、outlier policy、strict comparison 和 workload correctness 不变。新正式 Round 之前还必须在 CtxMux owner 层修复真实 Idle/Per-Run RSS 缺口。

## 0. Protocol 修正历史

### Revision 5：可证明的 CPU 区间与 Released census

- C probe 在每次 `proc_pid_rusage(RUSAGE_INFO_V4)` 调用前后读取 `clock_gettime(CLOCK_MONOTONIC_RAW)`。两个 endpoint 的真实 counter snapshot 分别位于各自的原始时间边界内，因此 wall interval 保守地落在 `end.before - start.after` 与 `end.after - start.before` 之间；不再用 Node 侧、排除两个 probe 调度间隙的独立 wall timer。
- Probe 通过自己 fork 的独立、持续 CPU-burn 子进程执行 256 次校准读取，Raw Result 保存全部正 counter step 和最小观测 quantum。校准无正 step 时 Runner 失败；正式 Idle delta 不大于该 quantum 时 Resource correctness 失败关闭，不把零、相等或不可辨别写成胜出。校准子进程只属于 probe，正常由父进程精确 kill/reap，父进程消失时也通过 parent identity 自行退出。
- 若 measured CPU delta 为 `D`、最小观测 quantum 为 `q`，Raw Result 保存保守 CPU interval `[max(0, D-q), D+q]` 与上述 wall interval。Release comparison 只接受 AgentMux CPU-percent 上界严格小于 tmux 下界；AgentMux 1% Idle CPU budget 使用同一个上界。
- Raw Result 记录 C source SHA-256、完整 compile argv、compiler path/version、SDK path/version、受控 compile environment 和 probe binary SHA-256。Compiler 只继承冻结的 `PATH/LANG/LC_ALL/TZ/SDKROOT`，不会读取调用者的 `CPATH`、`C_INCLUDE_PATH`、`MACOSX_DEPLOYMENT_TARGET` 等 ambient build input；两次独立临时输出目录的实现期编译已得到相同 binary SHA-256，正式环境 Gate 同时冻结 source、binary、compiler、SDK 与 compile environment identity，tracked-clean Git SHA 继续绑定 source。
- Released checkpoint 必须精确匹配当前候选的 owner 真相：AgentMux 为 `0 live + (sessions+1) historical`，tmux 为 `0/0/0`。AgentMux retained FD 成本以已验证的实际 historical count 为分母；history 丢失、额外 Run 或 census 漂移全部失败关闭。

### Revision 4：资源 observer

- Exact owner CPU 不再读取百分之一秒精度的 `ps time`。Runner 从已提交的 C source 编译一个只读 probe，调用 macOS public `proc_pid_rusage(RUSAGE_INFO_V4)`，以纳秒单位读取 owner process 的 user/system 累计计数；这一方向保留，但 Revision 4 把 counter 两端的 probe 调度间隙只计入 numerator、不计入 denominator，并把字段单位错误写成 `1 ns` 有效 resolution，因此被独立 Review 拒绝。
- Fresh owner 先采 Idle，再创建并保留第一个 Session，随后只增加 31 个 Session。Per-session RSS 因而比较双方相同的 `32 live + 0 historical`，不从 AgentMux 样本中事后扣除 history。
- AgentMux owner census 只调用公共 `listRuns()`，tmux census 只调用独立 socket 的 `list-panes`；Idle、1 Session、32 Session 与 Released checkpoint 都保存 `live/historical/total`。Idle、1 与 32 census 不相等时 Resource correctness 失败关闭。
- Revision 3 的严格 `<`、1% Idle CPU 预算、15 个 RSS sample、2 秒 settle、200 ms interval 和其余所有统计/数值门槛保持不变；Revision 4 没有正式 Result。

### Revision 3：Baseline 与执行顺序

Revision 2 原始结果保留在 `docs/benchmarks/results/` 中带有 `round-1-308dd27c` 标识的结果文件。它暴露了四个 Runner／Protocol 方法错误，因此只能作为 characterization，不能据此判定产品回退：

- tmux Reconnect 收到完整 Run object，却把它当 session string 拼成 `=[object Object]`；Revision 3 统一让两个 Runtime 消费同一个 Run object，并核对 exact session 与 PID。
- tmux 在首个 pane 已经按默认较小 history 创建后才设置 per-window `history-limit 50000`，4 MiB capture 已经丢失 ready／payload prefix；Revision 3 在任何 `new-session` 之前先设置 global window history limit，同时继续保留历史 per-window command。
- stubborn-tree 正是用于证明 tmux `kill-session` 不能清理完整进程树；Revision 2 却把这个预期 baseline limitation 当成全局自动失败。Revision 3 只在 AgentMux Stop correctness 通过时把它记录为定性正确性胜出，并明确跳过 Stop p95 速度比较；其他 tmux correctness 仍全部失败关闭。
- Revision 2 把资源族放在数百个 historical CtxMux Run 之后，所谓 57 MiB “idle”并不是 §G 规定的 empty owner。Revision 3 在 freshly initialized AgentMux daemon／tmux server 上首先执行完整、数值不变的资源族；Revision 2 resource samples 无效，不是产品回退证据。

除上述方法修正外，Workload、样本量、统计、Outlier policy、资源预算与所有数值门槛均保持不变。

## 1. 判定问题

本 Benchmark 只回答一个问题：在相同机器、相同 PTY Workload 和相同 correctness oracle 下，最终 AgentMux + CtxMux candidate 是否在所有可比发布主维度优于切换前真实 tmux Runtime，同时保留已经交付的持久化、安全和资源上限。

发布 Verdict 只有 `pass` 或 `fail`。除 §6 明确限定的 tmux Stop Cleanup baseline limitation 外，任何可比主维度回退、correctness oracle 失败、两轮方向不一致、资源超预算或缺少原始样本都会得到 `fail`；不允许用加权总分掩盖单项回退。

## 2. 冻结候选与可比边界

### AgentMux Candidate

- 当前提交从源码构建的 `@agentmux/core` 公共 `AgentMuxClient`；Runner 只能调用 package 根导出的 `connect`、`runtimeIdentity`、`runtimeDiagnostics`、`createTerminal`、`attachTerminal`、`releaseRunAttachment`、`writeTerminal`、`listRuns`、`stopTerminal`、`disconnect` 与 `dispose`。不得导入 `CtxmuxRunAdapter`、`@ctxmux/sdk`、wire、state 或其他 private module。
- 固定 CtxMux artifact 是 clean commit `f89dabe70eba38d46992c320e40c9ebe2f09b5e5`、tree `37632c41c4aae42ba40f33ebe9c54fab13d17c44`、product `0.1.0`、protocol `9`、manifest SHA-256 `ac53b1e43e67a73841d4f6cfbd272628e47f3731f29772dbb86bfbfce77935de`；Runner 从 `runtimeDiagnostics()` 核对公开 identity，并把 package 中 manifest 的 SHA-256 作为只读 build-input evidence 记录，不读取 CtxMux state。
- 每轮使用一个独立、随机、权限 `0700` 的 `AGENTMUX_RUNTIME_DIRECTORY`。CtxMux daemon 是唯一 Run Owner；Benchmark Runner 是 Client，不把 Runner RSS 计入 daemon RSS。
- 正式 `full` Result 必须来自 tracked-clean Git SHA；Runner 把 SHA 与 dirty paths 写入 Manifest，dirty 时拒绝写发布 Verdict。`smoke` 只验证 Runner 路径，不产生 release `pass`，也不得写入正式 results 目录。

### 强制 tmux Baseline

- 系统 `tmux 3.6b`，使用独立 `-L agentmux-benchmark-*` Server，不读取或修改用户现有 tmux Server／Session。
- 行为冻结自切换前提交 `2b02df4` 的 `packages/core/src/tmux-client.ts` 与 Runtime：
  - Create：任何 `new-session` 前先执行 `set-option -gw history-limit 50000`；每个 Session 仍执行 `new-session -d`，随后设置 `remain-on-exit on` 与 per-window `history-limit 50000`；
  - Input：每次 `load-buffer` + `paste-buffer -d`；
  - Visible Output：每 750 ms 执行 `capture-pane -p -e -J -S -50000`，与旧 Runtime 默认 Poll Interval 相同；
  - Attach／Replay：一次 `capture-pane`；
  - Reconnect：`list-sessions`、`list-panes`、`show-environment` 与 `capture-pane`；
  - Stop：`kill-session`。
- Runner 可以直接固化这些命令，不把已删除的 tmux 产品代码重新引入 Core，不提供 Backend Selector、Compatibility Layer 或 Fallback。
- Revision 5 Runner 延续 fresh-owner 资源测量的 `start-server`、`set-option -g exit-empty off`、首个 pane 前的 `set-option -gw history-limit 50000` 与 `display-message -p '#{pid}'`，为 exact Session／fixture PID 记录冻结 `list-panes -a -F '#{session_name}|#{pane_pid}'`，并用 `#{pane_dead}` 形成 owner census。所有命令都必须带同一个随机 `-L agentmux-benchmark-*`；cleanup 只调用该 socket 的 `kill-session`／`kill-server`，绝不调用默认 tmux socket 或枚举、终止用户 Session。

### 其他产品

- Zellij 与 WezTerm mux 只有在运行前能从 `PATH` 找到固定版本、且能表达同一 Persist／Input／Capture／Stop Contract 时才运行；当前环境未安装时记录 `unavailable`，不得下载或安装后临时扩围。
- a mature workbench／a mature workbench 是产品与源码参考，不是稳定的公开 Headless Benchmark Contract。不能验证相同输入、Replay Cursor 和进程树清理时标记 `not_comparable`，不得伪装为 AgentMux 胜出。
- 不连接真实 SSH Host。Remote 网络、认证与 MTU 噪声不进入本地 Cutover 主 Verdict；隔离 SSH 的 Partition／Recovery 已由 T-007 Stress Gate 保护。

## 3. 冻结环境

首轮目标机；Runner 必须逐项实测并与下表一致，否则本轮 `fail`：

| 项目 | 冻结值 |
| --- | --- |
| OS | macOS 26.3.2 / Darwin 25.3.0 |
| CPU | Apple M4 Pro |
| Memory | 48 GiB |
| Architecture | arm64 |
| Node | 24.14.1 |
| pnpm | 11.5.1 |
| tmux | 3.6b |
| CPU observer compiler | Apple clang 21.0.0 (`clang-2100.0.123.102`) |
| CPU observer SDK | CommandLineTools macOS SDK 26.4 |
| Terminal Geometry | 120 × 36 |
| Locale | `LANG=C`, `LC_ALL=C`, `TZ=UTC0`（子进程） |

每个原始结果还必须记录 Git SHA、Dirty Paths、Node／OS／Arch、CPU、总内存、tmux／可选竞品版本、开始／结束时间、Protocol Revision、Runner Version、CtxMux public identity 与固定 artifact identity。正式 Verdict 只接受结果与 Runner 同一最终 candidate SHA 的 tracked-clean 重跑；实现期 dirty smoke 只能得到 `smoke`，不能冒充正式证据。

## 4. Workload 与样本量

所有时间使用 `process.hrtime.bigint()`；延迟单位为微秒，吞吐单位为 Payload Byte／Second，RSS 为 KiB。Marker 使用 ASCII，Sequence 与 Hash 按 UTF-8 Payload Byte 计算。

### A. Input-to-visible-output

- Fixture 是同一个 `node` 行式 Echo Agent；收到 `latency:<sample-id>` 后立刻输出 `visible:<sample-id>`。
- 每个 Runtime 先 Warmup 20 次，再采集 120 次。
- 输入严格串行；前一 Marker 可见后才发下一次，避免队列吞吐冒充单次延迟。
- tmux Watcher 固定 750 ms；每次发送前使用 Seed `8008` 在一个 Poll Period 内生成均匀 Offset，避免总在 Poll 后立刻发送的相位偏差。AgentMux 使用同一 Offset 序列；等待时间不计入延迟。
- 记录 p50、p95、p99 和全部原始 Sample。

### B. Sustained Output Throughput

- Input 触发 Fixture 先输出 Payload-start Marker，再输出恰好 4 MiB 可验证 Payload，使用 16 KiB Chunk，最后输出 SHA-256 End Marker；PTY 对触发 Input 的本地 echo 位于 Payload-start 之前，不计入 Payload Hash。
- Warmup 1 次，采集 7 次；每次使用新 Session，避免历史窗口互相污染。
- AgentMux 从 Input Ack 到 Client 收齐 End Marker；tmux 从 Paste 完成到 750 ms Watcher 的 Capture 收齐 End Marker。
- Correctness 要求 Payload Byte Count 与 SHA-256 完全一致；不完整样本计失败，不删掉重跑。

### C. Attach／Replay

- Session 先产生 192 KiB Payload 并 Detach。
- Warmup 20 次，采集 100 次。
- AgentMux 每个样本都计一次 `attachTerminal(runId, 0)` 返回完整 Replay，计时在 Attachment receipt 返回时停止，再在计时区间外 `releaseRunAttachment`；tmux 计一次冻结 `capture-pane` 返回完整历史。
- 每个样本验证 End Marker 和内容 Hash；记录 p50／p95／p99。

### D. Reconnect Recovery

- 一个保持运行且已经产生 64 KiB 历史的 Session。
- Warmup 20 次，采集 100 次。
- AgentMux 从新 Local Socket Client Connect 开始，到 Hello 身份核对与 `attachTerminal(runId, 0)` Replay 完成，随后在计时区间外 release；tmux 从新控制调用开始，依次完成冻结的 List Session／Pane／Environment／Capture。
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

- 资源族必须是每轮 fresh owner 初始化后的第一个 workload family；在它之前不得创建任何 AgentMux Run 或 tmux Session。
- 分别启动空 AgentMux Daemon 与空 tmux Server；稳定 2 秒后，每 200 ms 采样 15 次。
- Idle CPU 使用 exact owner 的 `proc_pid_rusage(RUSAGE_INFO_V4)` user/system 累计纳秒计数在采样窗口内的增量；每个 endpoint 保存 `CLOCK_MONOTONIC_RAW` 调用前／后边界，Raw Result 同时保存受控 CPU-burn 校准的全部正 step、最小观测 quantum、CPU/wall interval 与 CPU-percent interval。正式 delta 不可辨别时失败关闭。Idle RSS 取 15 次均值。
- Per-session RSS 使用同一个 fresh owner：先测 1 live Session，再保留它并增加 31 个，最终以 `32 live + 0 historical` 相对 Idle 的增量除以 32。Owner census 与任一冻结状态不符时失败关闭。
- Steady／Peak RSS 使用 4 MiB Throughput Workload 的采样序列；停止并释放后再采样 15 次作为 Released RSS。
- Runner RSS 不计入任一 Runtime；Fixture 子进程 RSS 单独记录且不混入 Owner RSS。

## 5. 统计方法

- 分位数使用排序后的 nearest-rank。Input-to-visible、Attach／Replay 与 Reconnect 的 p99 各自至少有 100 个正式样本；Throughput、Scale 与 Stop 的 p99 仍按 Raw Sample 描述性记录，但因样本不足 100 不作为 p99 release comparison。
- 汇总同时输出 count、min、mean、p50、p95、p99、max、standard deviation。
- Standard deviation 使用 population 公式 `sqrt(sum((x - mean)^2) / n)`。
- 使用固定 Bootstrap Seed `8008`、10,000 次有放回重采样，为 mean 与 p50／p95／p99 输出 95% Percentile Confidence Interval；bootstrap PRNG 冻结为 32-bit Mulberry32，CI 两端取 bootstrap statistic 排序后的 nearest-rank 2.5／97.5 percentile。每个 summary 独立从 Seed `8008` 开始，保证相同 Raw Sample 逐字节复现相同 Summary。
- 不删除 Outlier，不 Winsorize，不按 IQR 过滤。OS 调度、GC、tmux Server 启动和失败样本全部进入 Raw Result；失败另有 Error Code／Phase。
- 至少两轮独立完整运行；每轮之间完整 Shutdown 两个 Runtime、等待 10 秒，不共享 Session、Replay 或 Server。两轮所有 Gate 必须同方向通过。

## 6. 冻结资源预算与胜出门槛

### Correctness Gate

- AgentMux 的每个有效样本必须通过 Marker、Byte Count／Hash、Session Identity 和 Cleanup Oracle；tmux 除下述 Stop Cleanup 例外外，所有相同 Oracle 也必须通过。
- AgentMux 还必须通过 Sequence 单调、无隐藏 Gap、Reconnect 不 Respawn、Stop 后零个 benchmark-owned live Run；CtxMux 可继续保留明确为 historical 的 Run identity，不把历史记录伪装成 live Session。tmux 是否留下仍可运行的孤儿进程必须被如实记录，并只按下述 Stop Cleanup 特例判定。
- 任何 AgentMux correctness failure 直接 `fail`；tmux 的 Input、Throughput、Attach、Reconnect、Scale 或 Resource correctness failure 同样直接 `fail`，不得泛化例外。
- Stop Cleanup 单独处理：tmux correctness 为 `true` 时双方比较 p95，AgentMux 必须更小；tmux correctness 明确为 `false` 且 AgentMux 为 `true` 时记录 `stopCleanup.complete-process-tree` 定性正确性胜出，并记录跳过 `stopCleanup.p95`，不得伪称速度胜出。缺失或非布尔 tmux Stop correctness 仍失败关闭。

### Resource Budget

- AgentMux CtxMux daemon：Idle RSS 不超过 96 MiB；32 Run Peak RSS 不超过 160 MiB；Idle CPU 区间上界不超过 1%。Live child、Attachment 与 transient thread 在 Stop 后必须归零。固定 CtxMux candidate 尚无 global Run GC，historical Run 可保留的 FD 成本不得超过 `packages/core/test/fixtures/reliability-budgets.json` 冻结的每 Run `2.25`；这项 T-017 Gate 前置证据必须与最终 SHA 一起复核，不能误写成“历史 Run 已删除”或“FD 零保留”。
- 单 Runtime Client Queue、Replay、Frame、Session 与 Client 数继续使用 `docs/testing/strategy.md` 的硬上限；Benchmark 不提供放宽开关。
- Desktop：沿用 T-007，Terminal 增量 256 MiB、Editor 增量 512 MiB、释放后进程组 1 GiB、Warm Cache 漂移 128 MiB。Desktop 数字不与 Headless tmux Server 混合。

### Release Primary Dimensions

对每个可比指标，两轮都必须满足：

- AgentMux Input-to-visible p50、p95、p99 均小于 tmux；
- AgentMux Throughput p50 大于 tmux，且每轮都完整通过 4 MiB Hash；
- AgentMux Attach／Replay p50、p95、p99 均小于 tmux；
- AgentMux Reconnect p50、p95、p99 均小于 tmux；
- AgentMux 32 Session Ready Wall Time 小于 tmux，Session／Second 大于 tmux；
- Stop 在双方 correctness 都通过时比较 p95，AgentMux 必须更小；若 tmux 明确留下可运行孤儿而 AgentMux correctness 通过，则只记录 AgentMux 的完整进程树定性胜出并跳过 p95，不把 tmux 已知限制扩散成整体自动失败；
- AgentMux Idle CPU 的区间上界必须严格小于 tmux 区间下界；Idle RSS、Per-session RSS、Steady RSS、Peak RSS 与 Released RSS 均小于 tmux 对应值。AgentMux Idle CPU 的 1% 自身预算同样使用区间上界。

这里故意不设容差、不做加权，也不允许“延迟收益抵消内存回退”。如果独立 Node Daemon 的 RSS 高于 tmux，T-008 就应失败，后续只能基于这份冻结证据重新讨论产品目标，不能回头把 RSS 降为次要指标。

## 7. Raw Result Contract

Runner 写入一个不覆盖已有文件的 JSON：

```json
{
  "schema": "agentmux.benchmark.daemon-cutover.v5",
  "protocolRevision": 5,
  "runnerVersion": 5,
  "mode": "full",
  "runId": "<uuid>",
  "round": 1,
  "manifest": {},
  "comparators": {},
  "workloads": {
    "resources": {},
    "inputToVisible": { "agentmux": { "samplesUs": [] }, "tmux": { "samplesUs": [] } },
    "throughput": {},
    "attachReplay": {},
    "reconnect": {},
    "sessionScale": {},
    "stopCleanup": {}
  },
  "correctness": {},
  "qualitativeWins": [],
  "skippedComparisons": [],
  "summary": {},
  "verdict": "pass | fail | smoke"
}
```

Raw Sample、失败、跳过原因与 Manifest 全部保留。Runner 在内存中只从 Raw Sample 生成 Summary；统计原语是纯函数，不能修改样本。默认输出目录是 `docs/benchmarks/results/`；Revision 5 正式文件名以 `revision-5-round-` 开头，并包含 Round、Git Short SHA、Platform 和 UTC Timestamp，采用排他创建，禁止覆盖。正式模式必须显式传 `--round 1` 或 `--round 2`；`--smoke` 使用缩小样本验证相同控制路径，必须显式传一个 results 目录外的 `--output`，Verdict 固定为 `smoke`。

## 8. 复现与安全

Revision 1 已没有可执行入口，避免继续在错误 candidate 上累积结果。它使用的自建 daemon 已删除；已知 4 MiB Debug sustained-output 在 30 秒内没有形成完整 Hash，旧结果不能证明 AgentMux + CtxMux，也不能通过调低 payload、延长后删样本或改变主维度来修饰。`run-kernel-workload.mjs` 和 `run-kernel-statistics.mjs` 是 T-013 保留并由 Revision 5 复用的 candidate-neutral Fixture／统计原语。

Revision 5 入口是 `pnpm benchmark:daemon-cutover -- --round <1|2>`；实现期路径验证是 `pnpm benchmark:daemon-cutover:smoke -- --round 1 --output <outside-results.json>`。Runner 只创建自己的临时目录、在其中编译只读 CPU probe、使用以 `agentmux-benchmark-` 开头的随机 tmux socket，并精确记录 AgentMux RunId 和 Fixture PID。CPU 校准子进程是 probe fork 的唯一子进程，正常路径精确 kill/reap，父进程异常退出后也因 parent identity 改变而自行退出。正常 cleanup 只通过 AgentMux 公共 `stopTerminal(exact RunRef)` 停止其创建且仍 running 的 Run，只通过带 exact `-L` 的 tmux `kill-session`／`kill-server` 停止自己的 baseline。若 correctness 证明 tmux 留下 Runner 记录的 fixture PID，最终 emergency cleanup 只对这些 exact PID 发信号。最后可用 OS process metadata 仅匹配 exact benchmark runtime directory 的 daemon argv 并关闭该空 daemon；不得读 CtxMux wire/state，不得按名称广泛 `pkill`，不得触碰默认 tmux socket、用户 Session 或非 benchmark PID。

不连接真实 SSH，不下载或临时安装竞品，不改 Agent Hook／Credential，不发布 Package。两轮正式结果之间必须完整 cleanup 两个 Runtime 并由调用者等待 10 秒；Round 2 不能复用 Round 1 的临时目录、daemon、tmux socket、Run、Replay 或 Fixture。
