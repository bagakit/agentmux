# 一个还活着的 Agent 永远收不到消息了

## 定性

**P0。**

不是因为报错多，而是因为它**同时命中 P0 的三条判据**（SOP 第 1 节）：

1. **触犯红线**（`AGENTS.md` 原则 11）：Agent 进程活着、PTY 仍接受字节、daemon 仍认这个 run，
   被拿走能力的原因**只是我们自己的记账**没走通。
2. **把已跑通的能力由于我们的防御夺走**：这个 run 之前是能发消息的——turn 0 发成功过，
   正是那一次成功把 epoch 消费掉了。
3. **没有 in-band 恢复路径**：消费是永久的，全仓没有 un-consume / expiry / TTL。
   用户在 App 内做任何事都无法恢复，只能杀掉 run。

可证伪的后果：**一个健康的 Agent 只要经历过一次异常收尾或一次 wire 断线，就再也收不到任何消息，
直到它被杀掉重开。** 这不是降级，是永久失能。

## 用户可见症状

> 现在运行中的实例在大量包这样的错, 看看怎么回事

```
AGENT_PROMPT_READINESS_CONSUMED
runId=6daa9e04-6e65-4be7-8d97-3a33268cd670
readinessSource=initial-composer
readinessOutputCursorBytes=55
readyThroughByte=1015
```

> 表现上, 会有 Agent tui 输入框明明是空的, 但是无法输入的情况

> 可是现在识别不准确的时候，反而会拦住我往 terminal 的输入，导致他们无法正常运行。我觉得这个触犯了红线原则。

**两个症状，两个机制，必须分开归属**（SOP 第 2 节）：

- **症状 A（本文的机制）**：洪水式 `AGENT_PROMPT_READINESS_CONSUMED`，发送面永久死亡。
  诊断行里 `readinessSource=initial-composer` 是**当前值**——这本身就是证据：
  `initial-composer` 一个 run 只铸一次（turn 0），它到现在还是当前源，说明这个 run
  **从未拿到过任何一次续期**。
- **症状 B（另一条机制，不要混为一谈）**：输入框空着却打不进字。
  这来自 `composer-submit-mode.ts:44` 用 `session.processState` 投影硬禁输入
  （见 `RED-LINES.md` 反例 2）。它**随投影翻回就恢复**，不是永久的。
  把两者混成一个机制，会让整篇复盘被一条「我重连后就能打字了」的反例推翻。

## 影响面

**坏了什么**（症状 A 的爆炸半径）：

某个 run 一旦其 readiness epoch 被消费且未获续期，以下能力对该 run **永久 STOPS**：

- `submitAgentPrompt` — 每一次都撞 `AGENT_PROMPT_READINESS_CONSUMED`（`prompt-submission.ts:222`）。
- 持续进度循环 — `continuous-progress.ts:39` 在同一个 `consumedBySubmissionId` 上
  `skip / 'readiness-consumed'`，而且是**静默**的。epoch 是跨子系统的单点故障：
  手动发送和自动推进被同一个坏状态一起饿死。

**没坏什么**（同样必须写，SOP 第 3 节）：

- **裸键入仍然 KEEPS WORKING**。`writeAgentInput`（`client.ts:3538`）根本不过 readiness 闸
  （只看 `pendingInteraction` 和字节游标）。用户在终端里直接打字仍然到得了 Agent——
  这恰恰是它属于红线而不是普通 bug 的证据：**绕过我们这段代码，这条路是通的**。
- **其他 run 不受影响**。epoch 绑定 `run.runId`（`client.ts:3703` 写入 `run: { ...current.run }`），
  一个 run 的搁浅 epoch 不波及同 App 内其他 session。
- **Agent 本身完全健康**。进程活着、daemon 认这个 run；坏的只有我们这一份记账。
- **重开 run 后恢复正常**。turn 0 会重新铸一个 `initial-composer` epoch。

## 止血措施

**现在卡住的用户：除了杀掉该 run 重开之外，没有任何带内恢复路径。**

如实说明，不粉饰：消费标记 `consumedBySubmissionId` 全仓只有一处写入
（`prompt-submission.ts:241`），**没有任何一处清除它**，没有过期、没有 TTL、没有重铸。
所以 App 内的任何操作——重试、切 Tab、重启 App——都不会让这个 run 重新可发送
（epoch 是持久化的，重启后原样读回）。

止血只能是 out-of-band：stop 掉该 run，重新起一个。

## 引入时间线

命令（SOP 第 5 节要求来自 git，不来自记忆）：

```
git log -S 'consumedBySubmissionId' --oneline --reverse -- packages/core/src
git log -S "'native-stop'"          --oneline --reverse -- packages/core/src
git log -L 3660,3710:packages/core/src/client.ts
```

- **`923cbd19` 2026-08-01 引入提交** — `fix(core): persist exact terminal prompt readiness epochs`。
  三个半边**同时**在这一个提交里落地：`initial-composer` 铸造、`native-stop` 续期、
  `consumedBySubmissionId` 永久消费。

  **反讽正在它自己的 message 里**：它是一个**修「过度阻断」的提交**——
  > `Stop-only admission rejected a blank Run's first prompt`

  它准确地发现「只认 Stop 回执会把一个空白 run 的第一条 prompt 拒掉」，然后
  **只修了 turn 0**（加了 `initial-composer` 这个一次性来源），把 turn 1..n
  留在完全相同的病因上：仍然只有 Stop 一条路，而那条路会被断线跳过。
  修了过度阻断的第一格，留下了同一类过度阻断的其余所有格。

- **`6ffe7bc7` 2026-08-16 最关键的一次擦肩** — `fix(core): Stop 落 done 不再硬依赖活着的内核`。
  它**看见了完全相同的断线场景**，分析得非常准确（断线时 `status()` 抛 `CTXMUX_DISCONNECTED`、
  hook 被 503、回执永久丢失、窗口可达 31.5s），并且**修好了 `done`**。

  但它对 readiness 那一半做了一个**有意识的取舍**，原话：
  > 缺席则让下一次 agentPrompt 收到 `epoch-missing` 的**响亮**拒绝。

  **这个预测是错的，而且错在可达性上**（本仓反复栽的同一个坑：在场 ≠ 可达）。
  它推理的是「光标缺席」的世界；而实际状态是「**旧 epoch 连同它的光标和已消费标记一起原样活着**」。
  代码根本走不到 `epoch-missing`——`prompt-submission.ts:207` 的
  `!readiness || readiness.readyThroughByte === undefined` 为假（旧 epoch 两者都有），
  直接落到 `:222` 的 `consumedBySubmissionId !== undefined`，抛的是
  `AGENT_PROMPT_READINESS_CONSUMED`，且**永远**如此。
  它当时在优化的是「done 的落盘」，验证也只覆盖了 done；**没有一条断言检查过
  「续期缺失之后，这个 run 还发得出下一条消息吗」**。

- **`3cff3c3a` 2026-08-15** — `fix(desktop): classify prompt readiness refusals`。
  它在优化**拒绝文案的分类**，于是给 `AGENT_PROMPT_READINESS_CONSUMED` 写下了
  「wait for ... the next readiness epoch」（`prompt-readiness-diagnostics.ts:45`）。
  它离真相只差一问——「这个 epoch 会来吗」——但它优化的是措辞而不是可达性，
  于是把一条**永不可达**的建议固化成了用户看到的正式文案。

- **`252c7b23` 2026-08-16** — `test(core): 让 readiness epoch 原子消费的 10 个析取项各自承重`。
  它在优化**测试严格度**，而且做得很认真（10 个析取项逐个承重）。但它守的是
  「消费这个动作是否原子」，不是「消费之后还有没有路」。**把一个错误的设计测得很牢。**

- **`894960e7` 2026-08-30** — `refactor(core): 删掉 observeReadiness 两处恒真的合取项`。
  它在优化**死条件清理**，理由正确（那两项确实恒真、不可达）。它进一步确认了
  「有 consumedBySubmissionId 必有 readyThroughByte」这条不变量——也就是
  **亲手证明了 `6ffe7bc7` 预期的 `epoch-missing` 分支在这条路上不可达**，却没有
  反过来问这意味着什么。

- **`563a8f50` 2026-09-05** — `refactor(core): 把 prompt-readiness source 的运行期白名单改成从
  Record<Union,true> 投影`。它在优化**类型投影**，正面处理了 `'initial-composer' | 'native-stop'`
  这个只有两个成员的联合——**离「续期只有一条路」这个事实最近的一次**，
  但它关心的是白名单怎么派生，不是这两个成员够不够。

- **`7377272b` 2026-09-13** — `fix(core): judge turn-end by the canonical lifecycle, not the literal
  spelling "Stop"`。它在优化**事件拼法的归一**（`eventName !== 'Stop'` 漏掉 `StopFailure`）。
  这一条是**加重项**：它修的正是「另一种收尾拼法被当成伪造回执丢弃」，而那次丢弃
  同样会吃掉唯一的续期。修对了一个入口，仍然没问那条路断掉之后会怎样。

- **`2fe0a040` 2026-09-13（本次）** — 同一族的第二个拼法缺口，带 SSOT 反查的守卫入库。

**这段代码在引入后被改过 7 次，每一次都在优化一个真实的东西（措辞、测试严格度、死代码、
类型投影、事件归一），没有一次问过「这条路断掉之后，这个活着的 Agent 还发得出消息吗」。**

## 根因分析

- **直接原因**：`client.ts:3698` 的 `...(stopRun ? { terminalPromptReadiness… } : {})`。
  断线时 `kernel.status()` 返回 `null` ⇒ `stopRun` 为 `null` ⇒ 整个续期字段不写入 ⇒
  上一轮那个**已消费**的 epoch 原样留在 store 里 ⇒ 之后每一次发送都撞 `:222` 的永久拒绝。

- **根因**（主语必须是流程/判断，不是某行代码）：
  **「续期」这件事被设计成依赖一个可能永远不到达的外部回执，而在设计它的时候，
  没有人问过「如果这个回执不来，一个活着的 Agent 还有没有路」。**

  更精确地说，是**两个决定各自合理、组合起来致命，而没有任何一个环节负责看这个组合**：
  - 「消费是永久的」——单独看是对的，防的是同一个 epoch 被重复使用；
  - 「续期依赖外部回执」——单独看也是对的，回执是权威事实；
  - 组合起来 = **一个只减不增的资源**。第一个决定假设「还会有下一个 epoch」，
    第二个决定不保证这件事。没有人拥有这个假设。

- **为什么没被更早发现**：
  - **测试守的是错误的性质**。`252c7b23` 把「消费的原子性」测到了 10 个析取项各自承重，
    但全仓没有一条断言检查「**一个 running 的 run，在没有后续 turn-end 的情况下，
    还能不能发出下一条消息**」。测试覆盖率很高，覆盖的是设计正确性之外的东西。
  - **评审在场但看的是别处**。7 次改动每次都有明确的优化目标，每次都达成了目标。
  - **监控把症状当成了正常输出**。`AGENT_PROMPT_READINESS_CONSUMED` 是一个
    「预期内的拒绝码」，洪水式地打出来也只是日志变多，没有任何东西把
    「同一个 run 连续 N 次撞同一个永久拒绝」识别为异常——直到用户自己发现日志被刷爆。

- **已有规则为什么没绑住**（SOP 第 6 节：有成文规则时，根因绝不是「我们不知道」）：

  **规则不但存在，而且存在于同一个函数里。**
  `client.ts:2221-2225` 的注释白纸黑字写着：握手绝不做发 prompt 的前置门，因为 `[?u`
  对一个几分钟前启动的 run 早已不可达，**「一旦拦在这里，那个 run 之后的每一条 prompt
  都被永久挡住」**。这正是本次事故的形状——同一个函数认出过它、修好过它。
  `AGENTS.md` 原则 11 也早于本次事故就把红线写成了一等不变量。

  **规则没绑住，因为它只是一句话。**
  它没有绑定到任何机械的东西上：没有测试会因为「新写了一个永久门」而变红，
  没有 grep 能把「伪造守卫（第 1 类，合法）」和「记账守卫（第 2 类，红线）」分开——
  两者字面同形；AST 也答不了「这个 `throw` 之前那次 `kernel.status()` 是否可达且承重」,
  那是可达性问题不是在场问题。于是一条正确的规则在 7 次提交里被绕过了 7 次，
  而每一次绕过它的人都不觉得自己在违反它。

  **需要的是机械化的执行手段，不是把规则再抄一遍。** 这直接决定了下面改进措施的形状。

## 改进措施

### 1. 让断线分支降级放行，而不是静默不续期

断线是原则 11 的第 2 类。照 `confirmRenderOrDegrade`（`prompt-submission.ts:484-524`）的样子：
向 daemon 要权威状态，`running` 就放行并落一条 `degraded` 服务窗事实，run 真没了才阻断。

- **是否足够 root**：修的是**这一个实例**，不是这一类。类是「**凭我们自己的记账发放、
  且只有单一续期路径的永久许可**」。同类已知实例：`RED-LINES.md` 的类扫描给出 3 个
  （readiness epoch 本体、`composer-submit-mode.ts:44` 的投影硬禁、`continuous-progress.ts:39`
  的静默停车），本条只覆盖第 1 个。**另 2 个未动**——第 2 个随投影翻回自愈（是「要盯的形状」
  而非已证等价事故），第 3 个随本条的 epoch 修复一并解决但需要独立的服务窗断言。
- **能否彻底避免**：**不能彻底避免这一类，只能彻底修掉这一个实例。** 它堵住了
  `CTXMUX_DISCONNECTED` 这条已知路径，但「下一个凭自家记账发放永久许可的新代码」它拦不住。
  诚实地说：这是实例级修复，不是类级免疫。
- **是否降低系统熵**：**降低。** 它**去掉**一个特例（「断线时什么都不写」这个静默分支），
  让断线走上和 `OUTPUT_GAP`／渲染超时**已经在走的同一条**降级路径——少一个分支，
  不是多一个。被否掉的更简方案：「断线时直接放行、不落服务窗」——更简单，但踩原则 11
  的第一条边界（不许静默降级），用户有权知道自己在降级状态，故否。

### 2. 让 epoch 在一个活着的 run 上可重铸（真正 root 的那一条）

不变量：**只要 run 是 `running`，就必须存在一条通往可发送 epoch 的路。**
实现形态是让消费不再是绝对终态——在权威状态确认 `running` 时允许重铸。

- **是否足够 root**：这条**才是**类级修复的一半。它不再依赖「续期回执一定会来」这个
  没有人拥有的假设，而是把「活 Agent 恒有路」变成系统自己维持的性质。
  它同时解决 `continuous-progress.ts:39` 的静默停车（那 3 个实例里的第 3 个），
  因为两者饿死于同一个 epoch。
- **能否彻底避免**：**本可以阻止这次事故。** 有这条不变量，`923cbd19` 当天就会红——
  它引入的正是一个「turn 1..n 无路可走」的状态。但它只覆盖 readiness 这一个资源，
  换一个子系统再发明一个单调递减的许可，它同样看不见。
- **是否降低系统熵**：**降低。** 它**去掉**「永久终态」这个概念，让 epoch 只有
  「当前有效 / 需要重铸」两态，而不是「未铸 / 有效 / 永久死亡」三态。
  被否掉的更简方案：给 epoch 加 TTL。更简单，但那是**增熵**——加一个时间参数、
  一个需要调的常数、一个「TTL 到期但 Agent 正忙」的新竞态，而且它答的仍然不是
  「Agent 还能干活吗」而是「过了多久」，用一个更弱的代理换掉了真判据（原则 2、原则 7）。故否。

### 3. 修掉那条永不可达的建议文案

`prompt-readiness-diagnostics.ts:45` 现在告诉用户
「wait for ... the next readiness epoch」——一个在本事故里**永远不会到来**的 epoch。

- **是否足够 root**：**完全不 root，这是纯止损。** 它一行代码都不改变系统行为。
  类是「**把一个我们没有保证的前提写成给用户的建议**」，同类实例未做扫描——
  本条只改这一处，**其余未知**。
- **能否彻底避免**：**不能，连更早发现都算不上。** 它只是让错误状态下的文案不说谎。
  列在这里是因为把「更早发现」伪装成「彻底避免」不可接受——那这条就该诚实地标成
  它本来的样子：**善后**。
- **是否降低系统熵**：**中性偏降。** 只改文案，不加分支。措施 2 落地后这段文案的前提
  才真正成立（那时 epoch 确实会来），所以它应当**跟在** 2 后面改，而不是单独改完就算完。

### 4. 人闸留痕（应对「规则存在却被绕过 7 次」）

`RED-LINES.md` 要求：任何拿走用户已有能力的改动，commit message 里必须逐条回答
四步判定流程并带 file:line 证据，尤其要回答「绕过我这段代码这条路还通不通」。

- **是否足够 root**：这是**对根因那一层**的直接回应——根因是「没人问过那一问」，
  而不是任何一行代码。它把这一问变成交付物的一部分。
- **能否彻底避免**：**不能，它守不住作者撒谎，也守不住作者真诚地想错**
  （`6ffe7bc7` 就是真诚地想错了）。它只保证这个判断**留下可审计的痕迹**，
  事后能被 `git log` 翻出来对账。上面 7 条时间线正是这样翻出来的。
- **是否降低系统熵**：**中性。** 不加代码、不加分支，加的是一条流程约束。
  被否掉的更简方案：加一个 lint / grep 规则自动拦截新增的 `throw`。更省事，
  但它**必然误伤**——第 1 类的合法阻断和第 2 类的红线阻断字面同形
  （`RED-LINES.md` 机械执行章节已点名），一个必然误报的守卫会被加豁免表、
  豁免表会过期，最后变成纯增熵的摆设。故否。

## 验证

- **措施 1、2（未落地，agent `a3aea4d9` 进行中）**：验收线是一条**可证伪的不变量测试**——
  构造 run 处于 `running`、readiness 已 `consumedBySubmissionId`、无后续 `turn-end`，
  断言系统**要么**重铸出可发送 epoch、**要么**暴露一条 in-band 恢复，
  而**不是**永久 `AGENT_PROMPT_READINESS_CONSUMED`。
  承重变异：把断线分支改回「不写续期」，该测试必须单独变红。
  命令：`env -u AGENTMUX_AGENT_SESSION_STORE -u AGENTMUX_HOOK_URL -u AGENTMUX_HOOK_TOKEN
  -u AGENTMUX_HOOK_EVENT -u AGENTMUX_AGENT_SESSION_ID pnpm exec vitest run <该测试路径>`（仓根）。
  **当前状态：未验证。**

- **加重项 `2fe0a040`（已落地并验证）**：`canonicalHookLifecycleEvent(eventName) !== 'turn-end'`
  取代 `eventName !== 'Stop'`，堵住 `StopFailure` 合法回执被当成伪造丢弃的路径。
  守卫：`packages/core/test/hook-receipt-turn-end-spelling.guard.test.ts`。
  承重变异：把实现折回 `eventName !== 'Stop'`，`StopFailure` 那一档单独变红——已实测。
  判据从 SSOT 反查（`rawEventNamesForLifecycle('turn-end')`）而非手抄拼法清单，
  并自带空扫自检（`expect(SECOND_SPELLINGS.length).toBeGreaterThan(0)`）。

- **「消费无清除路径」这一事实**（本文多处论证的基础）：
  `grep -rn "consumedBySubmissionId" packages/core/src apps/desktop/src | grep -v "\.test\."`
  — 11 个非测试命中，写入只有 `prompt-submission.ts:241` 一处，无一处清除。**已实测。**

- **「裸键入不过 readiness 闸」**（影响面「没坏什么」的证据）：
  `client.ts:3538` `writeAgentInput` 全函数无 readiness 读取。**已静态确认。**

## 遗留

- **措施 1、2 尚未落地**，本文的验证一节对它们标注为「未验证」。在它们入库前，
  本事故只做了**加重项**的修复（`2fe0a040`），**主因未修**——
  一个活着的 Agent 仍然可能因为一次断线而永久失能。这是本文最重要的遗留。
- **类扫描的实例计数标 PARTIAL**：3 个实例来自 `RED-LINES.md` 的反面清单，
  仍有若干 audit agent 在跑全仓扫描（core 的 gating throws、desktop 的 disabled 状态、
  lifecycle/resume 闸）。**计数可能上调**；上调后本文改进措施 1 的「同类已知 N 个实例」
  必须同步更新，否则「只修了 N 个中的 1 个」这句话会失真。
- **措施 3 的同类扫描未做**：「把没有保证的前提写成用户建议」这一类还有多少处，未知。
- **症状 B（输入框空着打不进字）不在本文修复范围**。它是另一条机制
  （`composer-submit-mode.ts:44` 的投影硬禁），在 `RED-LINES.md` 反例 2 中被标注为
  「要盯的形状」而非已证等价事故——它随投影翻回就恢复，不具备本文这种永久性。
  **有意识不在本文合并处理**，以免两个机制混成一个而让整篇复盘可被一条反例推翻。
- **被有意识扣住未合入的改动**：一个「死通道时禁用 composer」的闸（另一 agent 产出，
  双向变异已证）。它在一场「结论是我们拦得太多」的 P0 里**增加**阻断，
  且其作者自己标注了一个洞（一个游离的 hook 事件会把闸重新打开）。
  按 `RED-LINES.md` 的判定流程复核之前不合入。
