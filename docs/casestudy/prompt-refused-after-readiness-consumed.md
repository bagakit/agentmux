# 一个还活着的 Agent 永远收不到消息了

## 定性

P0。本案范围是 AgentMux 向一个仍在运行的 Agent Run 提交 Prompt 的路径：Agent 进程、PTY 与 daemon 中的 Run 都健康，只因 AgentMux 自己的 readiness 记账没有续期，这个 Run 之后的每次 Prompt 提交都被永久拒绝。它同时满足[事故案例写作指南](../guides/incident-writing.md#必备章节与验收线)列出的三条 P0 判据：

1. 违反 [AGENTS《健康能力与未知状态》](../../AGENTS.md#健康能力与未知状态)：拿走能力的原因只是流程记账没有走通，Agent 本身没有坏。
2. 我们的防御拿走了已跑通的能力：这个 Run 的 turn 0 发送成功过，正是那次成功消费了 readiness epoch。
3. 没有带内恢复路径：消费标记没有清除、过期或重铸，App 内的重试、切 Tab 和重启 App 都无法让该 Run 重新可发送。

可证伪的后果：一个健康的 Agent 只要经历一次异常收尾或一次 wire 断线，就再也收不到 Prompt，直到用户停止该 Run 并重开。

本案涉及两类机制，不能合并为同一根因：readiness epoch 被消费后没有续期，使后续投递永久被拒；Composer 在 Agent 空闲时被一条搁浅的 `run-process` error 永久禁用输入。Composer 按 `session.processState` 投影禁用输入的分支是第三个独立实例。早期“症状 B 随投影翻回自行恢复”的判断后来被真实场景推翻，见[改进措施 5](#5-第二个永久实例run-process-错误分支在-agent-空闲时锁死-composer)。

本文的源码位置均属于本复盘最后一次内容提交 `e602c2094c`；Desktop 侧 `run-process` 错误分支的位置来自当时的工作树，该分支从未进入 main（见改进措施 5）。后续实现已改变 readiness 准入，现行发送准入约束见 [Steer 与 Provider 输入能力](../design/behavior/agent-capabilities-and-messaging.md#steer-与-provider-输入能力)，拦截判定见 [RED-LINES](../../RED-LINES.md)。

## 用户可见症状

> 现在运行中的实例在大量包这样的错, 看看怎么回事

```
AGENT_PROMPT_READINESS_CONSUMED
runId=<runId>
readinessSource=initial-composer
readinessOutputCursorBytes=55
readyThroughByte=1015
```

> 表现上, 会有 Agent tui 输入框明明是空的, 但是无法输入的情况

> 可是现在识别不准确的时候，反而会拦住我往 terminal 的输入，导致他们无法正常运行。我觉得这个触犯了红线原则。

两个症状属于两个机制：

- **症状 A（readiness 续期机制）**：大量 `AGENT_PROMPT_READINESS_CONSUMED`，该 Run 的发送路径永久失效。诊断里的 `readinessSource=initial-composer` 是当前值：`initial-composer` 每个 Run 只在 turn 0 铸一次，它仍是当前来源，说明这个 Run 从未取得过续期。
- **症状 B（Composer 投影机制）**：输入框为空却打不进字。初判来源是 `apps/desktop/src/renderer/src/lib/composer-submit-mode.ts:44` 按 `session.processState` 投影禁用输入；后续核实又发现空闲 Agent 上的 `run-process` error 会永久禁用 Composer，见改进措施 5。两类机制分开归属，避免“重连后又能打字”这一条反例推翻症状 A 的结论。

## 影响面

**坏了什么**（症状 A）：某个 Run 的 readiness epoch 被消费且未获续期后，以下能力对该 Run 永久 STOPS：

- `submitAgentPrompt`：每次都在 `packages/core/src/prompt-submission.ts:222` 的 `consumedBySubmissionId !== undefined` 分支抛出 `AGENT_PROMPT_READINESS_CONSUMED`。
- 持续推进：continuous-progress 在同一个 `consumedBySubmissionId` 上以 `readiness-consumed` 原因静默跳过。手动发送与自动推进依赖同一个 epoch，一个坏状态让两者同时失效。

**以下不受影响：**

- **终端直接键入 KEEPS WORKING。** `packages/core/src/client.ts:3538` 的 `writeAgentInput` 不读取 readiness，只看 `pendingInteraction` 与字节游标。用户在终端里直接打字仍能到达 Agent；绕过这段记账代码，这条路是通的，这正是本案属于红线问题的证据。
- **其他 Run 不受影响。** epoch 绑定 `run.runId`（`client.ts:3703` 写入 `run: { ...current.run }`），一个 Run 搁浅的 epoch 不影响同一 App 内的其他 Session。
- **Agent 本身健康。** 进程活着，daemon 仍认这个 Run；坏的只是 AgentMux 的记账。
- **重开 Run 后恢复。** 新 Run 的 turn 0 会重新铸一个 `initial-composer` epoch。

## 止血措施

本复盘时，除停止该 Run 并重开外，没有带内恢复路径。消费标记 `consumedBySubmissionId` 在 Core 中只有 `prompt-submission.ts:241` 一处写入，没有任何清除、过期或重铸；epoch 会持久化，重启 App 后原样读回。

止血只能在带外完成：停止该 Run，再重新启动。

## 引入时间线

命令（在 `e602c2094c` 上执行，行号随后续提交漂移）：

```
git log -S 'consumedBySubmissionId' --oneline --reverse e602c2094c -- packages/core/src
git log -S "'native-stop'"          --oneline --reverse e602c2094c -- packages/core/src
git log -L 3660,3710:packages/core/src/client.ts e602c2094c
```

- `266c881e4e` `feat(core): harden ctxmux-backed agent sessions`：pickaxe 显示永久消费标记 `consumedBySubmissionId` 首次出现在这里。缺陷形状——消费只减不增——自这个提交起就存在。
- **`c3b4a8f138` 引入提交** `fix(core): persist exact terminal prompt readiness epochs`：把准入改成持久化的 epoch 模型，加入 `initial-composer` 铸造与 `native-stop` 续期，但只为 turn 0 开了口。它的说明写着 `Stop-only admission rejected a blank Run's first prompt`，即只认 Stop 回执会拒绝空白 Run 的第一条 Prompt。修复只覆盖了 turn 0（新增一次性来源 `initial-composer`）；turn 1..n 仍只有 Stop 回执这一条续期路径，而这条路径会因断线被跳过。
- `3a4f7f2e2f`（历史清理时并入 `feat(core): integrate worktree provider parity`，原提交标题为“Stop 落 done 不再硬依赖活着的内核”）：这次改动已经看到同一断线场景——断线时 `status()` 抛 `CTXMUX_DISCONNECTED`、hook 被 503、回执永久丢失、窗口可达 31.5s——并修好了 `done` 的落盘。它对 readiness 一侧的取舍写在代码注释里（`3a4f7f2e2f:packages/core/src/client.ts:3332`）：「缺席则让下一次 agentPrompt 收到 `epoch-missing` 的响亮拒绝」。这个预测在可达性上是错的：实际状态不是“光标缺席”，而是旧 epoch 连同光标与消费标记原样保留。`prompt-submission.ts:207` 的 `!readiness || readiness.readyThroughByte === undefined` 为假，代码直接落到 `:222` 的 `consumedBySubmissionId !== undefined` 并永久抛 `AGENT_PROMPT_READINESS_CONSUMED`。这次改动只验证了 `done`，没有断言检查“续期缺失后，这个 Run 还能发出下一条消息吗”。同一并入提交还包含一组测试，让 readiness 原子消费的 10 个析取项各自承重；它守的是“消费是否原子”，不是“消费之后还有没有路”。
- `565cf4ec65` `fix(desktop): classify prompt readiness refusals`：优化拒绝文案的分类，给 `AGENT_PROMPT_READINESS_CONSUMED` 写下“wait for … the next readiness epoch”。它没有追问这个 epoch 会不会到来，于是把一条在本案中不可达的建议写成了用户看到的正式文案。
- `58d0cde7e2` `refactor(core): delete two tautology conjuncts in observeReadiness, and guard the invariant they depended on`：清理两个恒真的合取项，确认了“有 `consumedBySubmissionId` 必有 `readyThroughByte`”这条不变量，也就证明了 `epoch-missing` 分支在这条路上不可达，但没有据此回头检查续期设计。
- `18fd04563b` `refactor(core): project the prompt-readiness source whitelist from Record<Union, true>`：优化类型投影，直接处理了只有 `'initial-composer' | 'native-stop'` 两个成员的来源联合。它关心白名单怎样派生，没有问两个成员是否足够。
- `8bdbe4a145` `fix(core): judge turn-end by the canonical lifecycle, not the literal spelling Stop`：把 turn-end 判定从 `eventName !== 'Stop'` 改为规范生命周期，修正 `StopFailure` 被当成伪造回执丢弃的问题。被丢弃的回执同样会吃掉唯一的续期机会；它修对了一个入口，仍没有检查续期路径断掉之后的后果。
- `f9e2893f26` `fix(core): stop rejecting a legitimate StopFailure receipt as a forged cursor`：与本复盘同批，补上同一族的第二个拼法缺口，并加入从 SSOT 反查的守卫。

引入后 main 上有 6 个提交改过这段（原 7 次改动中有两次在历史清理中并入 `3a4f7f2e2f`），每次都在优化真实存在的问题（措辞、测试严格度、死条件、类型投影、事件归一），没有一次检查“这条路断掉之后，这个活着的 Agent 还能发出消息吗”。

pickaxe 还列出另外几个提交：`f5a1708177`（`feat(desktop): budget heavyweight surfaces and prove resource ownership`）新建 `packages/core/src/prompt-submission.ts`，把 Prompt 提交逻辑从 `client.ts` 搬过去，属于代码搬移；`6628c00b66`（`feat(core): add continuous progress decision contract`）在同一个消费条件上加入持续推进的 `readiness-consumed` 静默跳过，即改进措施 1 所说的共根实例；`fc32a817e8` 是断线门修复。不限定 `packages/core/src` 路径时，`'native-stop'` 的 pickaxe 还会列出 `5f50e95699`（`fix(core): screen-verify failure must not block submit on a healthy Agent`），它只在测试文件 `agent-session-continuity.test.ts` 中出现该字面量，与本案的续期路径无关。

## 根因分析

- **直接原因**：epoch 被消费后，没有任何路径能重新铸出一个未消费的 epoch。已确认有两扇门通向这个状态：
  1. **断线门**：`client.ts:3698` 的 `...(stopRun ? { terminalPromptReadiness… } : {})`。turn-end 回执到了，但断线时 `kernel.status()` 返回 `null`，`stopRun` 为 `null`，续期字段不写入，已消费的 epoch 原样保留。已由 `fc32a817e8` 修复。
  2. **无回执门**（线上那次实际经过的门）：一轮 turn 没有收尾 hook。线上 transcript 显示该 Run 以 `"Selected model is at capacity… server_overloaded"` 中止；Codex 对出错的 turn 不发 `Stop`，`acceptHookEvent` 没有被调用，续期不会执行。`client.ts:3646-3661` 的注释还记录了第三种形态：断线期间 hook 子进程连续收到 503（窗口可达 31.5s）后放弃，回执被永久丢弃。

  本文初稿把断线门当成事故本体；它是同一死局的一扇门，但不是线上那次经过的门。此处保留这次更正，避免读者以为断线门修复后 P0 已经闭合。

- **根因**：续期被设计成依赖一个可能永远不到达的外部回执，设计时没有人问“如果回执不来，一个活着的 Agent 还有没有路”。两个各自合理的决定组合在一起形成死局，而没有任何环节负责检查这个组合：
  - “消费是永久的”：防止同一个 epoch 被重复使用。
  - “续期依赖外部回执”：回执是权威事实。
  - 组合起来就是一个只减不增的资源。第一个决定假设“还会有下一个 epoch”，第二个决定不保证它，这个假设没有 owner。

- **为什么没被更早发现**：
  - **测试守的是另一种性质。** 并入 `3a4f7f2e2f` 的测试让消费原子性的 10 个析取项各自承重，但没有一条断言检查“一个 running 的 Run 在没有后续 turn-end 时，还能不能发出下一条消息”。
  - **评审关注各自的优化目标。** 每次改动都有明确目标并达成了目标，没有人检查组合后果。
  - **监控把症状当成正常输出。** `AGENT_PROMPT_READINESS_CONSUMED` 是预期内的拒绝码，大量出现只表现为日志变多，没有机制把“同一个 Run 连续多次撞上同一个永久拒绝”识别为异常，直到用户自己发现日志被刷满。

- **已有规则为什么没绑住**：规则不但存在，而且就在同一个函数里。`client.ts:2221-2225` 的注释写明握手不能成为发送 Prompt 的前置门，因为对一个早已启动的 Run 来说，那个握手信号已经不可达，“一旦拦在这里，那个 run 之后的每一条 prompt 都被永久挡住”。这正是本次事故的形状，而同一个函数曾经识别并修好过它。当时的 AGENTS 也已把“流程问题不能阻断已跑通的 Agent”列为核心原则（现为 [AGENTS《健康能力与未知状态》](../../AGENTS.md#健康能力与未知状态)）。

  规则没绑住，是因为它只是一句话，没有绑定到任何机械检查：新增一个永久门不会让任何测试变红；grep 无法区分合法的伪造守卫与流程记账守卫，两者字面相同；AST 也回答不了“这个 `throw` 之前的那次 `kernel.status()` 是否可达且承重”，那是可达性问题，不是在场问题。于是这条规则在多次提交中被绕过，每次的作者都不认为自己违反了它。这决定了下面改进措施的形状：需要把判断变成交付物，而不是再抄一遍规则。

## 改进措施

### 1. 让断线分支降级放行，而不是静默不续期

断线属于“Agent 健康而观察失败”的情形（[AGENTS《健康能力与未知状态》](../../AGENTS.md#健康能力与未知状态)）。参照同文件 `confirmRenderOrDegrade`（`prompt-submission.ts:484-524`）的做法：向 daemon 查询权威状态，`running` 就放行并记录一条 `degraded` 服务窗事实，Run 确实没了才阻断。

- **是否足够 root**：只修这一个实例，不是这一类。类是“凭自家记账发放、且只有单一续期路径的永久许可”。全仓类扫描的结果（取代初稿依据当时 RED-LINES 反例清单得到的“3 个”，那个数在三个口径上都不准）：
  - 按代码位置：5 个（3 个已记录 + 2 个新发现）。
  - 按根因归并：4 个，即 {epoch 被消费：手动发送被拒（症状 A）与持续推进静默跳过共根}、{processState 投影}、{搁浅的 submission claim}、{run-process 错误通道记账}。
  - 与本 P0 同形（永久、Agent 健康、无带内恢复）：2 个无条件实例。

  两个新发现：
  - **搁浅的 submission claim**（`prompt-submission.ts:190-205`，`AGENT_PROMPT_SUBMISSION_BUSY`）：一条落盘失败但 daemon 已收字节的 submission 会拒绝新的 operationId。初稿把它评为 PARTIAL，理由是“同 operationId 重试可续做”；两条独立评审都指出这个评级错误，它是同族的第二个完整永久锁死。续做分支（`:186` 的 `existing?.submissionId === submissionId`）确实存在，但产品侧无法传入那个 id：id 在唯一漏斗处无条件生成（`apps/desktop/src/main/runtime-controller.ts:797` 的 `operationId: randomUUID()`），整条调用链上 IPC handler（`ipc.ts:547`）、preload（`preload/index.ts:180`）与 contracts 中的 `submitPrompt` 都只有 `(session, prompt)` 两个参数；另一个 `submitInputPlan` 调用方（`client.ts:3294` 的 deliverPostLaunchPrompt）也自行生成 id。因此产品总是走 `:190` 的 BUSY 分支，续做分支在产品视角不可达。清除也只有两处：`client.ts:1008`（进程退出）与 `:1952`（resume 换新 runId）；turn-end 的 persistReceipt 和重连的 republishLiveRunState 都不碰它，也没有 TTL 或清扫。`:279-283` 的 stale-retry 把 BUSY 视为“可能陈旧”，但只在 `registry.load` 后用同一个新 id 再 claim 一次，必然再次撞上 `:190` 并在 `:316` 抛出，与现场“刷新重试也救不回来”是同一机械原因。

    这次勘误的判别方法：证明恢复路径不可达时，不要数调用方——初稿只数了两个 renderer 调用点，漏了 `apps/desktop/src/main/index.ts:83` 的 continuous-progress 循环；要问有没有任何签名能把所需参数传进去。前者少数一个就失效，后者是结构性的。
  - **run-process 错误通道记账**：见改进措施 5，在 Agent 空闲时是永久的。

  本条只覆盖 4 个根因中的 1 个（epoch，连带持续推进的静默跳过），另 3 个根因未动。
- **能否彻底避免**：不能避免这一类，只能修掉这一个实例。它堵住了 `CTXMUX_DISCONNECTED` 这条已知路径，但拦不住下一个凭自家记账发放永久许可的新代码。
- **是否降低系统熵**：降低。它删除“断线时什么都不写”这个静默分支，让断线走上 `OUTPUT_GAP` 与渲染超时已在使用的同一条降级路径。被否掉的更简方案是“断线时直接放行、不记服务窗”：更简单，但违反“不得静默降级”，用户有权知道自己处于降级状态。

### 2. 让一个活着的 Run 始终有路通往可发送状态（root 层）

不变量：只要 Run 是 `running`，就必须存在一条通往可发送状态的路径。

两次独立架构评审给出的结论比“让 epoch 可重铸”更进一步：可能根本不该持久化这份许可。`confirmRenderOrDegrade`（`prompt-submission.ts:504-521`）已经把“这个 Run 现在能不能收输入”作为一次实时 daemon 查询来回答：查询权威状态，`running` 就放行（必要时降级并发布服务窗），Run 确实没了才阻断。准入改成实时查询后，就不存在可被搁浅的单调递减资源，这一类缺陷按构造不可能出现；而且这是删代码：少一个持久结构、少一个状态机、少三个错误码。

- **是否足够 root**：“可重铸”只修这一类的一半；“不持久化许可”覆盖整类。本条覆盖 4 个根因中的 1 个（连带持续推进的静默跳过）。
- **能否彻底避免**：“不持久化许可”本可阻止这次事故，且按构造阻止；“可重铸”只能阻止已知的那些未铸出路径。
- **是否降低系统熵**：显著降低，删除概念而不是增加概念。被否掉的更简方案是给 epoch 加 TTL：它增加一个要调的常数和“TTL 到期但 Agent 正忙”的新竞态，回答的是“过了多久”而不是“Agent 还能干活吗”，用更弱的代理替换了真实判据，违反 [AGENTS《实现选择》](../../AGENTS.md#实现选择)。

### 3. 修掉不可达的建议文案

`prompt-readiness-diagnostics.ts` 中 `AGENT_PROMPT_READINESS_CONSUMED` 的文案让用户“wait for … the next readiness epoch”，而本案中那个 epoch 不会到来。

- **是否足够 root**：完全不 root，只是止损，不改变系统行为。类是“把一个系统没有保证的前提写成给用户的建议”，同类实例未扫描，本条只改这一处，其余未知。
- **能否彻底避免**：不能，连更早发现都算不上，只是让错误状态下的文案不误导用户。
- **是否降低系统熵**：中性，只改文案。措施 2 落地后这段文案的前提才成立，所以它应当跟在措施 2 之后改。

### 4. 拦截改动的提交留痕

`RED-LINES.md` 要求：任何拿走用户已有能力的改动，commit message 须逐条回答四个问题并给出 file:line 证据，尤其要回答“绕过这段代码还能不能通”，要求原文见 [RED-LINES《评审与提交留痕》](../../RED-LINES.md#评审与提交留痕)。

- **是否足够 root**：这是对根因层的直接回应。根因是“没人问过那一问”，这条措施把这一问变成交付物的一部分。
- **能否彻底避免**：不能。它挡不住作者写错，也挡不住作者真诚地想错（`3a4f7f2e2f` 中的那次取舍就是真诚地想错）。它只保证判断留下可审计的痕迹，事后能用 `git log` 对账；上面的时间线就是这样整理出来的。
- **是否降低系统熵**：中性，不加代码和分支，只加一条流程约束。被否掉的更简方案是用 lint 或 grep 自动拦截新增的 `throw`：合法的阻断与流程记账阻断字面相同，这种守卫必然误报，会长出豁免表，豁免表过期后只剩增熵，见 [RED-LINES《评审与提交留痕》](../../RED-LINES.md#评审与提交留痕)末段。

### 5. 第二个永久实例：run-process 错误分支在 Agent 空闲时锁死 Composer

当时工作树中的 `composer-submit-mode.ts:60-62` 在 `status.state === 'error' && status.source === 'run-process'` 时返回 `canType:false, canSubmit:false`。这个闸从未进入 main：在 main 历史中对 `apps/desktop/src` 执行 `git log -S "status.source === 'run-process'"` 没有输出，`composer-submit-mode.ts` 中的 `run-process` 字样只出现在 `734592d598` 加入的注释里。下面的链条与行号同样来自当时的工作树，无法在 main 上逐行复核。它的意图是诚实的：输出通道真的断了时，让用户往沉默的终端里打字更糟。但在 Agent 空闲时，这个禁用是永久的，当时已逐段核实：

1. Desktop 的 session-state reducer 把 `agent-error` 写成 `status.source='run-process'` 的 error。
2. 唯一能把它换回非 error 的是 `process-state` 事件；`run-process` 不在该分支的豁免名单里（名单只豁免 `native-hook` 与 `acp`）。
3. `publishRunState`（`packages/core/src/client-event-publisher.ts:60`）只在状态跃迁时发布，不周期发布。
4. 失败重挂路径 `client.ts:875` 的 `if (resumed === 'dead') continue` 有意跳过 running 的 republish（`client.ts:869-874` 的注释说明：紧跟一条 running 会把刚发的 error 洗掉）。

对一个空闲的 Agent——没有 turn、没有退出、没有任何跃迁——没有事件能解除禁用。用户看到的唯一信号是一个变灰的 placeholder，没有横幅，也没有服务窗，这同时违反“不得静默降级”。

初稿把它判为“随投影翻回自愈”，这个判断由全仓类扫描推翻，并按上述四步逐段复核。症状 B 能否归因到这个闸：PARTIAL，闸本身没有进入 main，现场运行的版本是否含有它未核实。

- **是否足够 root**：这是第 4 个根因（run-process 错误通道记账），与 epoch 那条完全独立。本复盘时 `734592d598` 已用测试固定：Run 为 running 时，输出通道 error 不会禁用 Composer。
- **能否彻底避免**：正确方向是让阻断带上出口，而不是取消阻断：通道真断时阻断仍然诚实。它不能避免通道断开，只能保证断开后用户有路可走，并知道自己处于什么状态。
- **是否降低系统熵**：取决于修法。正确方向是让失败重挂发布一条可恢复的降级事实（参照 `confirmRenderOrDegrade`），而不是在下游再加一个“如果 error 但是……”的分支；后者增熵，并会长出下一个豁免表。

## 验证

- **措施 1（断线门，`fc32a817e8`）**：`packages/core/test/readiness-consumed-recovery-invariant.test.ts`。命令（仓库根，剥掉 ambient env）：
  `env -u AGENTMUX_AGENT_SESSION_STORE -u AGENTMUX_HOOK_URL -u AGENTMUX_HOOK_TOKEN -u AGENTMUX_HOOK_EVENT -u AGENTMUX_AGENT_SESSION_ID pnpm exec vitest run packages/core/test/readiness-consumed-recovery-invariant.test.ts`
  当时结果：2 passed；连同 hook-stop-kernel-disconnected、hook-receipt-turn-end-spelling.guard、agent-session-store、prompt-submission-diagnostics 共 70 passed / 5 files，Core `tsc` exit 0。两个承重变异各自单独变红，并用 `diff -q` 确认还原：(a) 重铸分支条件改为 `false`，断线那一档变红；(b) 重铸光标改为字面量 `0`，修正 fixture 后才变红。(b) 是一次自查出的假绿：fixture 原本 `outputCursorBytes: 0`，`current.outputCursorBytes` 与编造的 `0` 无法区分，期望值不能由被测对象算出；改成 512 并直接断言光标后才真正承重。该测试自带正向对照（健康内核确实续期），保证断线断言不是空过。它不覆盖无回执门，见遗留。
- **措施 2（结构解法）**：本复盘时未动工，未验证。后续状态见遗留。
- **措施 3（文案）**：本复盘时文案已改过三次，每次都同步修改了 `apps/desktop/test/prompt-readiness-diagnostics.test.ts`；经过见遗留。
- **措施 4（提交留痕）**：`RED-LINES.md` 随本复盘入库（`009bb1783a`），现由 [AGENTS《健康能力与未知状态》](../../AGENTS.md#健康能力与未知状态)引用。它按设计没有自动判据，原因见措施 4。
- **同批修复 `f9e2893f26`**：用 `canonicalHookLifecycleEvent(eventName) !== 'turn-end'` 取代 `eventName !== 'Stop'`，堵住 `StopFailure` 合法回执被当成伪造而丢弃的路径。守卫为 `packages/core/test/hook-receipt-turn-end-spelling.guard.test.ts`。承重变异：把实现改回 `eventName !== 'Stop'`，`StopFailure` 那一档单独变红，已实测。判据从 SSOT 反查（`rawEventNamesForLifecycle('turn-end')`），不手抄拼法清单，并自带空集合自检（`expect(SECOND_SPELLINGS.length).toBeGreaterThan(0)`）。
- **“消费标记没有清除路径”**（本文多处论证的基础）：在 `e602c2094c` 上执行 `git grep -n "consumedBySubmissionId" e602c2094c -- packages/core/src apps/desktop/src | grep -v "\.test\."`，得到 5 个文件中的 24 行非测试命中；把消费标记写成某次 submission 的只有 `prompt-submission.ts:241` 一处，没有任何清除。
- **“终端直接键入不经过 readiness 检查”**（影响面“没坏什么”的证据）：`client.ts:3538` 的 `writeAgentInput` 全函数没有读取 readiness。已静态确认。

## 遗留

以下按本复盘时（`e602c2094c`）的状态记录；锚点之后的变化逐条注明提交。

- **无回执门在本复盘时未修，是当时最重要的遗留。** `fc32a817e8` 关掉了断线门，但线上那次经过的是无回执门：turn 因 `server_overloaded` 中止，Codex 不发 `Stop`，续期逻辑不会触发；同族还有 `client.ts:3646-3661` 记录的 503 丢回执窗口。`readiness-consumed-recovery-invariant.test.ts` 只覆盖“回执到了但 `status()` 失败”，不覆盖回执根本没到的路径，测试变绿不等于 P0 闭合。锚点之后，`6cbb4d341d`（`fix: recover prompt delivery and unify composer notifications`）把 readiness 改为可选证据、保留输入事务 fence，并删除了 `AGENT_PROMPT_READINESS_CONSUMED` 拒绝码，与改进措施 2 的方向一致；当前准入以 [Steer 与 Provider 输入能力](../design/behavior/agent-capabilities-and-messaging.md#steer-与-provider-输入能力)为准。
- **改进措施 2 的两条路线在本复盘时尚未择一。** 当时由本机 tracker `f-25q8fccdm`（proposal）持有这项决策，该记录不随仓库分发；锚点之后的实现选择见上一条。
- **措施 3 的文案。** 复盘初稿时文案仍误导用户。到本复盘时已改过三次：`55e22f1be9` 改为同时说明“仍有投递在途”与“回合未发 Stop”两种情形，并建议 resume 或 restart；`6fe26cc8af` 因 running Run 上 resume 会抛错，改为先停止再 resume；`59b54cdffc` 指出停止会退休该 Session，改为如实说明这样恢复只能新开 Agent、失去原连续性。锚点之后，`6cbb4d341d` 删除了这个拒绝码。
- **Composer 的两个实例。** run-process 错误分支（措施 5）：本复盘时 `734592d598`（`test(desktop): nail down that an output-channel error never greys a running composer`）已用测试固定，Run 为 running 时输出通道 error 不会禁用 Composer。processState 投影实例：（`c8f0f7ba1574` 复核：当前 `composer-submit-mode.ts` 在 Run 未 running 时输入框可编辑，placeholder 为 “Send to restore this Agent…”，`primaryAction` 仍是 `send`。）症状 B 不在本文修复范围，有意不与症状 A 合并处理。
- **搁浅的 submission claim** 在本复盘时未动；当时已由本机 tracker 认领修复（记录不随仓库分发），其后状态本文未核实。
- **hook 写入用户共享配置。** Codex 的 hook 写在 `<workspace>/.codex/hooks.json`，这是 Provider 自己的配置，不是 AgentMux 私有配置；用户在该 workspace 中于 AgentMux 之外启动的 Codex 会话也会触发我们的 hook 子进程。如果 hook 从“前置条件”降为“best-effort 加速器”，写入用户共享配置的理由会更弱。当时记为独立议题，未处理。
- **有意扣住未合入的改动**：一个“输出通道已死时禁用 Composer”的闸。按 RED-LINES 判定流程复核后，它本身通过第 1 问（通道真断了，绕过它也不通），但暴露了措施 5 的 permanent-when-idle 缺陷，因此当时没有合入。
