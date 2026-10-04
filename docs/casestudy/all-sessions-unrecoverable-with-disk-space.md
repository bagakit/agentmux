# 磁盘仍有空间，重启后所有 Session 都无法恢复

## 定性

P0：共享 Native 持久化 owner 无法完成冷启动，用户既不能恢复原 Session，也不能正常新建 Session；重复检查和机器重启都不能解除这个阻断。原数据仍在，却没有旧版本可用的带内恢复路径。这违反了[持久工作面恢复](../../AGENTS.md#工作面恢复与终端阅读)的底线。

本案证明了共享 ctxmux 恢复故障，以及修复后原 Session 的语义恢复。最初那一次 resume、随后 takeover 的完整操作历史没有保留下来，不能把它们的每一步失败都倒推成同一个 Native 错误。

## 用户可见症状

> “现在启动 session 也都是卡死的, 感觉和 takeover 本身没什么关系”
>
> “ctxmux 的持久化层报 database or disk is full, 但是当前肯定是有磁盘的”
>
> “我重启了机器, 发现所有的 session 都无法恢复, 且所有 executor 都 check failed 了”

用户最先看到的错误是：

```text
Takeover is not confirmed
Error invoking remote method 'sessions:creation': AgentMuxError: The original creation has no confirmed Session or prepared start. Inspect the same operation without replaying.
```

这些症状有三个证据边界：

- **共享持久化恢复故障**：SQLite 报 `database or disk is full`，在操作系统仍有磁盘空间时，应用自己的数据库页配额也可以触发 FULL。失败发生在共享 Runtime 的恢复路径，所以多个 Session 和依赖这个 Runtime 的 Executor 检查同时受阻。它不证明每个 Provider 的 CLI 都坏了。
- **首次错误被后续检查盖住**：首次启动失败后，检查同一创建操作只看到了“没有 Session 或 prepared start”。这是创建诊断保全的问题；后续检查结果不能取代首次失败，也不能授权重放启动或 Prompt。它与存储故障可以叠加，但不构成 SQLite 根因。
- **恢复后仍有旧检查提示**：原 Session 已 ready/running，GUI 仍显示 Startup Snapshot 的 114 条部分完成提示。对恢复后的 owner 重读实际得到 67 个 subject、23 条完整成功的 timeline；这些计数不是同一个集合，不能把 114 全部解释成 Session 丢失。首次空快照和 Provider RPC notice 的自动收口属于另外的观察恢复路径，本案记录时尚未完成行为验收。

## 影响面

爆炸半径是同一持久化 Native owner 下的创建、冷恢复和依赖它的检查，不是已证明的全部 Agent 数据损坏。现场目标 Provider 是 Codex；通用存储修复用真实 Native Run 和公共 client 验证，不依赖这个 Provider 的协议。

| 能力或事实 | 故障时的结果 | 证据边界 |
| --- | --- | --- |
| 原 Runtime 冷启动、新 Start、依赖它的 resume | STOPS | 必要恢复写入不能提交；仅重新启动 App 或机器无法消除页配额和错误分类问题 |
| 依赖同一 Runtime 的 Executor readiness 检查 | STOPS | 共享前提失败；不能据此宣称所有 CLI 文件或 Provider 句柄损坏 |
| 原 Run 的已确认元数据、历史 head、已有字节 | KEEPS WORKING：数据保留，服务暂不可达 | 修复后的原冷副本恢复 188 个 Run，目标 Run 的 16,414,116 字节已确认历史仍可读 |
| Core Session 身份和 Provider-native handle | KEEPS WORKING：恢复身份保留 | 实际恢复 `kind=resumed`，同一 SID、同一 native handle，新 Run 达到 ready/running |
| 持久空间身份和绑定 | KEEPS WORKING：原工作面可恢复 | 123 个 Session 前后无缺失；60 个 Space、90 个 Zone、139 个 Tab、153 个 Region 前后无身份缺失 |
| 重启前原 PTY/PID 的连续性 | 不作存活保证 | 宿主重启后的语义 resume 创建新 Run；不能把新 PID 说成旧进程继续运行 |

**以下不受影响**：已保存的 Session/空间身份、可用的 Provider-native 恢复线索和最后已确认的 Run 历史没有被这次修复删除或重建。原现场恢复的聚合证据见“验证”；可复现的公共证据是 `ctxmux@f1345ff` 的 `crates/ctxmux-daemon/src/lib.rs::sqlite_page_capacity_public_two_runs_survive_and_cold_recover`、`persistence.rs::policy_default_retains_beyond_old_quota_and_second_process_reads_original`，以及本仓库的 [Run 代次投影测试](../../apps/desktop/test/run-service-projection.test.ts)。

压力本身也不授权关闭健康输入：可服务 owner 遇到输出容量债时保留输入、查询和已有历史读取；未知输入交付不自动重发。这个能力保全是修复后已验证的行为，不能冒充旧版本故障时所有进程都仍可工作的证据。

## 止血措施

旧故障版本没有不更换 Native 实现的带内恢复办法。保留原 Runtime 状态目录、Core 持久 Session 和空间数据，先做可核对的冷副本；安装含 `ctxmux@f1345ff` 的已验交付物，再连接原 owner，通过 Core 对原 SID 执行 Provider-native resume。不要删除数据库、创建替代 Session 或重发原 Prompt 来取得“能启动”的假象。本次已按这条路径恢复目标 Session，并在真实 GUI 看到了原 Codex 历史和可用 Prompt。

原端点已恢复后，可检查准确目标的存储事实：

```bash
agentmux system storage --host "$incident_host" --run "$incident_run"
ctxmux --socket "$incident_socket" storage "$incident_run"
```

先核对 Runtime 身份，再读 `firstFailure`、actor 是否停止、offered/confirmed 水位和有效容量。`ctxmux` CLI 会在没有监听者时尝试启动 daemon，因此第二条不是对任意失效 socket 的纯离线取证命令。显式配额真的用尽时，可以释放实际受限资源，或由 owner 在下一次启动时采用经确认的配额；连接一个现有 Runtime 不会重新配置它。

如果 COMMIT 结果仍未知，继续阻断写入是正确行为；必须先从 durable truth 恢复，不能用“磁盘有空间”清除这个 fence。

## 引入时间线

以下提交及其先后关系来自 ctxmux 的 main 祖先历史，不代表本案的安装顺序。核对使用了 pickaxe、逐段历史和文件完整历史：

```bash
git log -S '384 * 1024 * 1024' --oneline -- crates/ctxmux-daemon/src/resources.rs
git log -S 'DATABASE_MAX_BYTES' --oneline -- crates/ctxmux-daemon/src/persistence.rs
git log -S 'fn rollback_startup_error' --oneline -- crates/ctxmux-daemon/src/persistence.rs
git log -S 'fn rollback_maintenance_error' --oneline -- crates/ctxmux-daemon/src/persistence.rs
git log -L 82,105:crates/ctxmux-daemon/src/resources.rs f1345ff
git log -L '/fn rollback_startup_error/','/^    }/':crates/ctxmux-daemon/src/persistence.rs f1345ff
git log -L '/fn rollback_maintenance_error/','/^    }/':crates/ctxmux-daemon/src/persistence.rs f1345ff
git log -L '/fn commit_maintenance_batch_without_spill/','/^    }/':crates/ctxmux-daemon/src/persistence.rs f1345ff
git log --follow --pretty='%h %s' -- crates/ctxmux-daemon/src/resources.rs
git log --follow --pretty='%h %s' -- crates/ctxmux-daemon/src/persistence.rs
```

| 提交 | 当时的目标与留下的问题 |
| --- | --- |
| `28dc61a`，`feat(runtime): qualify recoverable and tmux-owned Runs` | 最早在 persistence 中引入 384 MiB 的 `DATABASE_MAX_BYTES` 和派生页上限。固定数据库容量早于统一资源 policy，不能说它到 36ece41 才首次出现。 |
| `f313ee9`，`feat(persistence): normalize retained history before startup` | 引入 `rollback_startup_error`：无条件执行 ROLLBACK，清理失败升级为 Mutation。没有处理 FULL 已自动结束事务的情况。 |
| `a5c0afb`，`fix(persistence): externalize replay payloads from sqlite` | 将 payload 移出 SQLite，数据库仍持有坐标和索引。它降低 payload 页成本，没有消除大量小坐标触顶的机制；后续维护 helper 是从该文件的 compaction 区域抽出。 |
| `36ece41`，`fix(runtime): govern durable resource pressure without workload ceilings` | 新建 ResourceLimits，把 384 MiB 数据库、256 MiB aggregate replay 纳入默认 policy；引入维护回滚 helper 和 spill-disabled 页证明，启动证明也沿用原 helper。去掉 Run 数量天花板时仍留下字节天花板，并复用了无条件 ROLLBACK 假设。 |
| `2525eff`，`feat(runtime): integrate native service and resource owners` | 在同一默认 policy 块补诊断 owner 的预算字段；三个磁盘配额和页耗尽恢复合同没有变化。该段 diff 不包含真实 page-cap FULL 的恢复验证。 |
| `b061b8d`，`feat(runtime): observe owned foreground execution without disrupting runs` | 在同一默认 policy 块明确 cleanup worker 派生说明；保留磁盘配额。关注前台执行观察，没有检查这些配额与 host 空闲磁盘的区别。 |
| `9044f62`，`fix(storage): retain terminal state and retry proven rollback` | 改动维护事务同段，为已尝试 COMMIT 的错误加入精确 Old/New witness 分类；这是有用的安全修复，但 pre-COMMIT apply 错误仍调用无条件回滚 helper。COMMIT 故障注入不能证明 apply 阶段真实 FULL。 |
| `325876b`，`fix(resources): derive default run replay quotas from aggregate funding` | 修改同一默认块，使 per-Run allowance 跟随 aggregate，去掉独立 4 MiB 默认限制；仍保留 256 MiB aggregate 和 384 MiB database。解决了额度之间不一致，没有取消人工总额度。 |
| `d2bc03c`，`fix(persistence): retain storage errors after automatic rollback` | 修复两个 helper：未尝试 COMMIT 且已 autocommit 时保留原 typed 错误；活动事务仍必须显式回滚并确认。 |
| `78cee50`，`fix(persistence): recover from fixed SQLite page capacity without losing accepted output` | 补固定页配额下的有限回收、原 accepted debt 顺序、Start 局部拒绝和真实跨进程恢复。只保留 FULL 类型还不够，不能在不变页上限上永久重试。 |
| `f1345ff`，`fix(runtime): fund durable history from actual filesystem resources` | 默认三个磁盘 quota 改为 None；显式 quota 保留。补物理 compaction、首次 FULL 有界重试、共享债等待、可选冷维护延期及原子 service pressure。 |

`-L` 证明：从各自引入到 `d2bc03c`，两个回滚 helper 的无条件 ROLLBACK 函数体没有其它修改；并非所有期间提交都重写了该错误分支。默认 policy 块的后续修改则是上表的 `2525eff`、`b061b8d`、`325876b`，维护证明块的后续修改是 `9044f62`。更大的文件改动史还有其它优化，不能据“改过同一文件”声称它们改过这些缺陷行。

AgentMux 同批相关修复是 `7e14b3947`（`fix(desktop): retain the original spatial creation failure`）、`cfbd210d7`（`fix(desktop): show output resource pressure in Session service windows`）和 `54d881cf0`（`fix(core): integrate durable storage pressure recovery`）。它们分别保留首次错误、消费 Native 压力事实、接入已验 Native；不能反过来补齐最初失败操作缺失的历史。

## 根因分析

**直接原因是应用容量、SQLite 事务状态和共享恢复路径组合成了全局阻断。** Replay payload 外置后，大量小输出仍产生 SQLite 坐标和 uniqueness index 页。数据库达到应用的 `max_page_count` 时，host 磁盘空闲不能让这个事务继续增长。FULL 可以在 apply 阶段自动回滚；再次 ROLLBACK 的“没有活动事务”错误把原容量事实包装成 Mutation。启动必要 reconciliation 和后续维护由共享 owner 承担，这个错误分类扩大了故障范围。

**根因是容量治理和资格验证把“限制住了”当成“恢复得了”。** 删除人口上限、约束字节与 WAL 成本解决了有限资源问题，但设计没有同时要求：数据合法增长到原额度、事务自动回滚、资源恢复后，同一个 owner 必须继续服务原身份和原字节。只有重试，没有可观测的资源进展，也会把错误分类修好后的故障变成永久等待。逻辑删除坐标若没有释放实际文件和索引页，同样不能证明资源恢复。

**测试覆盖了不同的故障时机，却没有覆盖这个组合。** 既有 COMMIT Old/New/unknown 证明保护了已尝试提交的结果；人工注入一个 disk-full 返回值没有让 SQLite 真的在 apply 阶段自动回滚。历史恢复、同一进程重开、提高测试额度，也都不能代替固定页上限、同 owner 继续、第二进程读取第一进程原状态。新 fixture 分开保留真实 SQLite FULL 和 controlled scheduling 的资格，避免一种证据替另一种签字。

**观测和显示缺口让排查更难。** 创建检查只有最后一次 unknown，丢掉了首次启动错误；Core 已有 `backpressured` 投影，Desktop 服务窗却没有消费；恢复后旧 Startup/Provider notice 仍可能不自动收口。共享检查失败和当前 Agent 是否可工作因此混在一起。已有 storage API 能提供 original failure 和水位，却不等于已经有系统 RSS、磁盘可用块或所有资源的监控告警，本案没有“监控已完整覆盖”的证据。

[健康能力判据](../../AGENTS.md#健康能力与未知状态)和[红线判定](../../RED-LINES.md)已经要求不能用检查失败夺走健康能力，也不能以 unknown 删除工作面。规则未能约束这里，是因为资格证据没有绑定真实 FULL 的时机、未提交债和实际冷状态；“有磁盘预算”“有恢复测试”被当成这条底线已成立。修复把这些缺失变成可单独变红的承重 oracle，而不是再增加一句“要鲁棒”。当前规则中针对持久容量与原 Session 的机械检查，消费[测试策略](../testing/strategy.md#任务验收与假绿防护)和[Durable Runtime 健康](../design/behavior/session-recovery.md#durable-runtime-健康)。

## 改进措施

1. **取消默认人工磁盘天花板，仍执行真实资源和显式配额。** 三个磁盘字段 `database_bytes`、`durable_replay_bytes`、`durable_run_output_bytes` 默认 None；SQLite 使用真实 engine ceiling，磁盘历史按观察到的物理 funding 保留，并为替换、WAL/SHM 和工作单元保留 scratch。压力时原子退休已确认最旧前缀，实际迁移坐标并释放不再引用的文件；head 不倒退，floor、truncation、Gap 如实变化。
   - **是否足够 root**：覆盖“人工磁盘额度冒充物理耗尽”类的 3 个默认字段，以及数据库页和 replay 文件 2 种物理占用；显式 quota 路径也要在不提高额度的条件下恢复。
   - **能否彻底避免**：能避免本次默认 384 MiB/256 MiB 天花板；不能避免 host ENOSPC、inode、外部 quota 或 SQLite engine 自身上限。
   - **是否降低系统熵**：删除 3 个默认硬额度，保留已有 operator policy。物理迁移增加必要 I/O；更简单的“只删索引行”被否掉，因为没有实际磁盘释放，不能为下一次写入提供资金。

2. **只在已证明未提交时保留原错误，未知 COMMIT 仍阻断。** pre-COMMIT 已 autocommit 证明事务已结束；活动事务显式回滚且核对状态。已尝试 COMMIT 的 Old/New/unknown witness 合同保持。
   - **是否足够 root**：扫描并修复启动、维护 2 个同类回滚 helper；COMMIT 分类是另一类，没有套用这个捷径。
   - **能否彻底避免**：能避免 automatic rollback 被再次清理误报成全局 Mutation；不能保证真实 corruption 或未知提交可继续写。
   - **是否降低系统熵**：保留 typed 原因，减少错误包装造成的伪终局。增加一个事务状态判据；更简单的“所有 ROLLBACK 错误都忽略”被否掉，因为活动事务或未知结果必须 fence 后续写入。

3. **把容量不足作为原债等待，恢复读与控制的公平服务。** 首次已证明的 transient FULL 至多额外重试一次；连续失败回到共享 capacity lane。Append、Finalize 和 idle compaction 不在不变资源上反复 I/O；已接受的队列债连同 pending 保留资金，不让新任务越过它。两条可选冷 compaction 路径可在已证明 Old 的 filesystem capacity 下延期，必要启动写入仍须实际提交。
   - **是否足够 root**：覆盖 Append、Finalize、idle maintenance 3 条写入服务路径和 2 条可选冷维护路径；Barrier 不伪造 ACK，ReadReplay 可响应，未 funded Start 局部 NotCommitted。
   - **能否彻底避免**：可避免已知资源失败造成无限忙等、控制饥饿和冷启动被可选工作拖死；不能保证永不恢复的外部资源最终能提交。
   - **是否降低系统熵**：复用现有 pending、queue credits 和资源观察，不新增 payload ledger。增加有界重试/等待规则；更简单的“永久立即重试”使共享 owner 饥饿，“立即丢债或释放 credits”则违反已接受工作的所有权，两者均被否掉。

4. **把压力作为非阻塞服务事实从 Native 送到用户。** Native 原子 pressure guard 不覆盖 Closed/Unavailable；Desktop 复用既有服务窗，显示失败步骤、当前运行观察和恢复动作，当前 Serving 才清除压力提示。
   - **是否足够 root**：覆盖 Native 1 个共享 service 状态写入 guard，以及 Terminal 和 Activity/Global notice 2 条呈现消费路径。输入不可用和输出压力可并存，unknown 不猜成“磁盘满”。
   - **能否彻底避免**：不能阻止资源耗尽；能避免静默暂停及观察失败夺走健康输入，帮助用户按真实资源恢复。
   - **是否降低系统熵**：复用 `Backpressured`、`ServiceChanged` 和既有服务窗，无新 Session 生命周期状态。增加稳定 cause；更简单的“沿用带 revision 的指纹”会把每次观察当新告警，“常量 cause”会遗漏事实变化，均被否掉。

5. **原操作的首次失败与后续观察分开保全。** 在 1 个 spatial request ledger 保存首次失败，重复 request/inspect 只读原 owner；确认创建完成后清除过期失败，冲突身份仍拒绝。
   - **是否足够 root**：覆盖同一创建意图的首次执行、重复执行、inspect 3 种入口形态；不是恢复缺失的旧日志，也不是放松 takeover 身份确认。
   - **能否彻底避免**：能避免未来首次失败被“没有 Session”覆盖；只能改善诊断，不能阻止 Native 容量故障。
   - **是否降低系统熵**：增加 1 个原错误字段，保留既有操作身份。更简单的“只显示最近错误”丢失因果，“再启动一次以取得新错误”会重放副作用，均被否掉。

6. **把这类事故纳入源绑定鲁棒 fixture 和持久 Session 底线。** Native `fixtures/wrong-cases.json` 的 `PERSIST-03` 同时记录失败机制、保全不变量、实际 workload 与 oracle；规则只引用 owning SSOT，不把聊天或单次通过写成长期资格。
   - **是否足够 root**：覆盖 1 个容量恢复事故类，包含真实 SQLite FULL、跨进程原状态、controlled scheduling/物理 compaction、未知 COMMIT 对照 4 组证据；AgentMux 另覆盖首次错误、压力呈现和下面的启动观察消费缺口。
   - **能否彻底避免**：不能证明未来所有资源故障都消失；能在同类行为回退时更早打红，阻止用扩大预算、重新造状态或缺少 caller 的假绿交付。
   - **是否降低系统熵**：扩充既有事故 corpus 和测试合同，没有新公共能力层；过程 receipt 留本机，长期规则和历史案例各自只定义一次。

7. **让启动观察在原作用域自动收口，保留健康能力。** 初次空快照和 Provider RPC 失败各自保留原诊断来源，通过既有单个 membership reader 有界重查、让出执行机会并可取消。只用原 Core Region 的执行 Host 和 Session 身份确认运行、结束、待恢复或退休；无执行身份、错误 Host 和不可用 owner 继续 unknown。目录与历史的内部 observation receipt 携带部分成功和本次读取的失败，不能用不完整目录证明接手来源唯一。
   - **是否足够 root**：覆盖空快照、拒绝的 RPC、持续 unknown、部分 Host 失败、未完成的远端握手和读取期间 owner 替换；错误 Host 的同 SID 不得改写原输入目标或触发恢复。一次独立 Provider/历史读取成功只能清除自己的诊断，后来的错误与其他启动失败保留。
   - **能否彻底避免**：能避免一次观察失败变成永久提示或拿走健康输入；不能承诺所有远端始终在线，也不把缺失身份猜成正常。有限重查用尽后保留原工作面和诊断，owner 恢复事件继续触发同一观察，不重放输入或批量启动 CLI。
   - **是否降低系统熵**：复用 Core 公开只读事实、Desktop 原 IPC 和 membership reader，不另建 Runtime、持久错误账本或业务命令。仅内部部分读取回执明确完整性；更简单的“清空全部告警”会掩盖 unknown，“重启或再次执行”会扩大影响，两者均被否掉。长期约束归[恢复 SSOT](../design/behavior/session-recovery.md)，案例只保存本次缺陷和反事实。

## 验证

源码事实绑定 `ctxmux@f1345ff428fadb581f8271e2a3456fec390d5d87`；本仓库压力呈现绑定 `cfbd210d7`，首次错误绑定 `7e14b3947`。下面命令分别在各自仓库根运行，使用 fixture 自有状态；`env -i` 去除 ambient Runtime 路由、资源 policy 和 Provider 环境，只保留运行构建工具需要的 PATH/HOME。每组要求列出的 anchor 实际被发现并执行，零测试不是通过。

```bash
# ctxmux 仓库根：实际 SQLite FULL、固定额度公共链路及原状态冷恢复。
env -i PATH="$PATH" HOME="$HOME" CARGO_TARGET_DIR=target/incident-fixtures cargo test -p ctxmux-daemon --lib sqlite_full_before_commit -- --nocapture
env -i PATH="$PATH" HOME="$HOME" CARGO_TARGET_DIR=target/incident-fixtures cargo test -p ctxmux-daemon --lib sqlite_page_capacity -- --nocapture
# 无默认硬额度、实际物理回收、有界原债与可选冷维护；controlled 与实际 FULL 分开解释。
env -i PATH="$PATH" HOME="$HOME" CARGO_TARGET_DIR=target/incident-fixtures cargo test -p ctxmux-daemon --lib policy_ -- --nocapture
# COMMIT unknown 对照不能因容量修复变绿为“可重试”。
env -i PATH="$PATH" HOME="$HOME" CARGO_TARGET_DIR=target/incident-fixtures cargo test -p ctxmux-daemon --lib uncertain_compaction_commit_latches_even_when_error_looks_like_disk_full -- --nocapture
env -i PATH="$PATH" HOME="$HOME" node scripts/check-fixtures.mjs

# AgentMux 仓库根：首次错误、同操作检查、Run-local 压力与输入能力。
env -i PATH="$PATH" HOME="$HOME" pnpm exec vitest run apps/desktop/test/space-agent-control.test.ts apps/desktop/test/session-takeover.test.tsx
env -i PATH="$PATH" HOME="$HOME" pnpm exec vitest run apps/desktop/test/run-service-projection.test.ts
# 启动观察：原诊断自动收口、Host/SID 边界、有界重查和健康输入。
env -i PATH="$PATH" HOME="$HOME" pnpm exec vitest run apps/desktop/test/startup-snapshot-notice-resolution.test.tsx apps/desktop/test/startup-event-progress.test.tsx
```

各改进的实际承重证据如下；source-bound 变异在独立候选树重建并执行相同 oracle，非编译失败、文本扫描或空集合造成 RED：

| 改进 | 实际 fixture 与结果 | 单独变红的反事实 | 定义文件外生产调用者 |
| --- | --- | --- | --- |
| 1：默认 policy、物理回收 | 真 257 MiB 输出在第二进程逐字节读取；显式 128 KiB SQLite cap 和 4096 B per-Run suffix 保持生效（aggregate 设为 8192 B）；固定 128 KiB cap 下 2400 个真实 PTY 小片段触发 4 次回收，两个原 Native Run 和后续 Start、终局在第二进程恢复 | 恢复旧默认 quota；删除物理 compaction；关闭页回收，各自 RED | `ctxmux@f1345ff:crates/ctxmux-daemon/src/main.rs:192` 读取 ResourceLimits；`lib.rs:342` 打开 store、`:2483` stage Start、`:5307` 提供真实 PTY ordered bytes；CLI `crates/ctxmux/src/main.rs:149` 消费 storage |
| 2：事务分类 | 4 个 `sqlite_full_before_commit` anchor GREEN：真实页上限 FULL、同 connection/owner 继续、活动事务显式回滚、独立进程读取原状态；COMMIT Old/New/hybrid 和 unknown 对照保留 | 将两个 helper 还原无条件 ROLLBACK 后承重自动回滚测试 RED，活动事务对照仍 GREEN | `ctxmux@d2bc03c:lib.rs:337` startup open、`:2478` stage Start、`:5664`/`:5710` finalize |
| 3：原债、公平服务 | `sqlite_page_capacity_controlled_retries_preserve_funding_observation_and_finalize_order` 保 16 个含 pending 的队列资金和原字节；Barrier 拒绝、ReadReplay 可响应、Finalize 不越债。同 owner 真实 DROP ballast 后 settle；idle 两种 FULL、cold 两路径×两种 FULL 均经过实际 copy/sync/SQL staging→ROLLBACK | 提前释放原债 credits；恢复无限首次重试；在已满页 cap 上忽略 filesystem 资金变化；绕过 idle capacity 分类；把可增长/可复用页下的 SQLite FULL 误判成 page-cap refusal，各自 RED | `ctxmux@f1345ff:lib.rs:5307` append、`:5711`/`:5757` finalize、`:1091`/`:1114`/`:1180` upgrade 前 guard；startup/handoff open 消费冷恢复 |
| 4：非阻塞压力 | Native quiet Run 在不足 funding 增量后保持 pressure、原债 settle 后才 Serving；原子 guard 保 Closed/Unavailable。Desktop 55 个相关测试 GREEN，输入仍可提交、revision 不制造新 cause、独立 terminal fault 不随压力解除 | 去掉压力 outcome、去掉 Activity/Global 消费、cause 改常量，3 个实际 transform mutant 分别 RED | Native `native_runtime.rs:1770`/`:1886`/`:1890`→`lib.rs:4993`；Desktop [TerminalView](../../apps/desktop/src/renderer/src/components/TerminalView.tsx)、[AgentSessionComposer](../../apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx)、[GlobalSystemNotices](../../apps/desktop/src/renderer/src/components/GlobalSystemNotices.tsx) 消费共享服务窗 |
| 5：首次错误 | 创建与 takeover 相关 37 个测试 GREEN；同 operation 不二次 launch/send，原始错误经公开 receipt 读回，确认后过期错误消失 | 删除错误保存、删除 readback、删除冲突 fence、保留过期错误、移除操作身份，5 个 mutant 各自 RED | [store.ts](../../apps/desktop/src/renderer/src/store.ts) 调用 `executeSpatialControl`；[SessionTakeoverSurface](../../apps/desktop/src/renderer/src/components/SessionTakeoverSurface.tsx) 调用 `takeOverSession` |
| 6：事故 corpus 与底线 | `PERSIST-03` 的 anchor 在非空 49-case corpus 校验；规则、SSOT 和本案来源/链接复核 | 复用上述实现变异；纯文档不另制造“代码变异通过” | 公共 CLI/SDK activation、storage response 与实际 Native client 一并验收；方法归[测试策略](../testing/strategy.md#任务验收与假绿防护) |
| 7：启动观察与最小影响面 | 启动 fixture 保原 Region、焦点和草稿，分别检查初次空快照、Provider 失败后自然重读、逐项确认和持续 unknown；实际 Main、preload 与 IPC fixture 检查多 Host 部分成功、严格接手目录和读取期间重配置 | 回退为目录全有或全无；无关快照清除观察诊断；恢复旧计数条件；去掉精确执行 Host 边界，分别由实际行为 oracle 承重 | [Main IPC](../../apps/desktop/src/main/ipc.ts) 调用原 RuntimeController；[preload](../../apps/desktop/src/preload/index.ts) 输送内部回执；[store.ts](../../apps/desktop/src/renderer/src/store.ts) 消费目录、快照和历史；[接手](../../apps/desktop/src/renderer/src/lib/session-takeover.ts) 保留完整目录要求 |

controlled fixture 的界限必须保留：ballast 提供真实页压力，但某些重试时机和 filesystem 观测受控；它证明 scheduling/receipt/compaction 行为，不代签宿主真实 ENOSPC。可选冷维护 fixture 真实复制、同步并 staging SQL 后注入 typed StorageFull/SQLite FULL，证明 Old 分类和原数据保全，不是任意文件系统故障的资格证明。真实 page-cap FULL 公共 workload 独立承担 SQLite 耗尽与跨进程恢复。

原现场验收另外核对了以下聚合事实，原始回执与截图只保留在本机，不含在案例中；这些是当次证据，不作为可公开重放的 fixture：

- 从受保护原状态复制出的 store 冷启动成功，188 个 Run；单次 activation 用时 20,760 ms。目标原 Run 的 latest/durable head 都为 16,414,116，floor 为 0，确认历史未被人工缩短。这个时间不是 fleet SLA 或性能资格。
- Core 对原 Session 返回 `resumed`，原 SID 和 Provider-native handle 不变，原 Run 留在 retiredRuns，新 Run ready/running；前后 123 个 SID 和空间身份均无缺失。宿主重启后的新 Run 不冒充旧 PTY。
- 真正安装后的 GUI 保留原工作面，并显示原 Codex 历史和 Prompt；storage 原 fatal firstFailure 已解除。单个目标恢复不证明所有 123 个 Session 都已逐个启动了 CLI。
- 启动观察修复前，同一恢复 owner 的只读重查得到 67 个 subject 和 23 条 `ok && exact` timeline；GUI 的 114 提示仍在。这证明旧提示没有跟随观察事实，不能用该读取成功替自动收口签字。第 7 项由独立行为 fixture、变异和实际客户端消费承担，安装验收另核同一健康 Run/PID 与原工作面。

本案不保存用户 Prompt、终端正文、Session/Run/native UUID、环境值或机器绝对路径。来源范围是用户症状、上述提交的源代码/历史、绑定候选的 fixture/mutant receipts，以及原现场的聚合恢复和 GUI 证据；最初 resume/takeover 的完整日志不在这个来源集合中。

## 遗留

- **PARTIAL：首次 resume/takeover 的完整因果链。** 已有后续报错和共享 Native 故障证据，缺首次操作的完整启动、RPC 与提交历史；不补猜测，也不把后来的恢复成功当成当时错误原因的证明。
- **unknown 不能自动猜成恢复完成。** 第 7 项只结算原 producer 的已确认事实；没有原执行 Host、不可用远端或未确认身份的引用仍留在原工作面。首次空快照和 Provider RPC 结束的全部历史时序没有完整日志，当前恢复和新反例不能补造它们。
- **资源观测不是全景 API。** public storage 提供原失败、水位和采样的有效 allowance；它不提供结构化 configured quota、statvfs free blocks 或整个进程 RSS。diagnostics RPC 当前提供 sink counters，不能据此声称能查询全部资源用量。
- **取消磁盘默认 cap 不等于取消成本。** 冷恢复按 hot payload 预算加载，坐标流式读并按至多 64 KiB payload 合并，不是一行坐标一个常驻 Vec；1 GiB hot payload 预算不是 RSS 上限。全历史坐标验证、SQLite 排序/分组、allocator slack、元数据和终端模型仍有额外成本。原 forensic 内存观察不作为当前候选资格；本批没有扩成全量内存/性能项目。
- **真实资源永不恢复与未知提交仍有边界。** 已接受债保留并诚实等待，不能保证无限历史；真实物理耗尽允许退休已确认前缀并告知截断。必要 startup 写入无法提交时仍拒绝启动，未知 COMMIT 仍 fence 写入，不能靠忽略错误或删除原数据规避。
