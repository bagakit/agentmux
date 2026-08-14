# 红线：不许用防御拿走本可以的能力

本文件是 `AGENTS.md` 原则 11 的**执行细则**，不是它的复述。

原则 11 已经把「不能因为我们的流程问题，让原本已经跑通的 Agent 受阻」写成一等不变量，
连同 1/2/3 三类故障分类、判据（`「Agent 还能干活吗」，而不是「我们的检查过了吗」`）与
服务窗式提醒都在那里。按 SSOT（`AGENTS.md` line 72：同一件事只写在一处，另一处引用它），**那些不在这里重写**。
这份文档只承担原则 11 没有的那一半：把它变成一条**任何人下手前能真的跑一遍的判定流程**，
一份**从本仓真实事故里长出来的过度防御反面清单**，以及一句诚实的话——**哪些能自动守住、哪些守不住**。

一条写下来的规则，被反复改到同一段代码的提交各自绕过了一次（`923cbd19` 修「首轮被过度拦截」时把 turn 1..n 留在同一个永久拒绝的因上；
`6ffe7bc7` 正面分析了同一个断线场景、修好了 `done` 却把 readiness 缺口作为**有意识的取舍**留下；
`7377272b` 收窄了收尾拼法却没问这条路断掉会怎样）——缺的不是更响的措辞，是一个机械的执行口。

---

## 什么是红线，它凭什么和普通 bug 不一样

普通 bug 是**某件事本来就没做对**。红线违规是**某件事本来做对了、现在还在物理上工作，被我们自己的防御拿走了**——
一次自伤式回归（self-inflicted regression）。区别不在严重度，在方向：

- 普通 bug：能力从来没有过，或坏在能力自己身上。修它是把缺的补上。
- 红线违规：能力**用户已经拥有、底层此刻仍然工作**（进程活着、PTY 仍接受字节、daemon 仍认这个 run），
  是我们的握手/探测/校验/记账**没走通**，代码顺手 `throw` 或 `return`，把健康的能力关掉了。

判红线只需一问：**我拦掉的这条路，绕过我这段代码它还能不能通？** 能——就是红线。

---

## 唯一的判据

原则 11 line 45 已经定死：**「Agent 还能干活吗」，而不是「我们的检查过了吗」**。

本文不重新推导它，只把它变成下手前的动作。

---

## 下手前的判定流程（写任何拦截前跑一遍）

在你写下一个会**拿走用户已有能力**的 `throw` / 早退 / 置灰之前，按顺序回答：

1. **这条能力此刻在物理上还工作吗？**
   Agent 进程活着？PTY 还接受字节？daemon 还认这个 run？
   → 不确定就**去问 daemon 的权威状态**（`kernel.status(runId)`），别拿我们缓存的投影去猜。
   参照 `confirmRenderOrDegrade`（`packages/core/src/prompt-submission.ts:503-508`）：出错先问 daemon，`run.state.type !== 'running'` 才让原始错误照常阻断。

2. **我要拦的是「Agent 坏了」还是「我们的某一步没走通」？**
   按原则 11 的第 1/2/3 类判——三类的定义在 `AGENTS.md:37-41`，这里不重写，只给它们对应的动作：
   - **第 1 类** → 阻断诚实，放行阻断。
   - **第 2 类** → **绝不阻断**：降级放行 + 服务窗告示（见下节）。
   - **分不清** → 按未知处理：如实说「分不清」，**不猜好也不猜坏**，默认**不拿走**已有能力。

3. **如果我拦了，用户还有没有别的 in-band 路子恢复这条能力？**
   有过期？有重铸？有重试？还是只能**杀掉 run / 重启 App**？
   → 只能杀掉重启 = 你造了一个**永久**自伤回归。回到第 2 步，这几乎一定是第 2 类被写成了第 1 类。

4. **我拦的这个前置条件，是「一次性、对一个已经跑了一会儿的 run 早已不可达」的东西吗？**
   （握手 `[?u`、启动输出、首个 receipt……）
   → 是 = 它**绝不能**当后续操作的门。参照 `packages/core/src/client.ts:2221-2225` 的注释：
   `握手绝不做发 prompt 的前置门……一旦拦在这里，那个 run 之后的每一条 prompt 都被永久挡住`。

---

## 过度防御反面清单（都来自本仓真实代码）

### 反例 1 — 永久消费、单一续期、断线即死锁（P0 事故本体）

- **形状**：一个凭我们自己观察状态发放的「许可」被**永久消费**，而它的续期只有一条路，且那条路会被一次 wire 断线跳过。
- **实例**：terminal prompt readiness epoch。turn 0 由 `initial-composer` 铸一次（`client.ts:1591`/`1967`），
  之后**唯一能铸出一个全新、未被消费的 epoch** 的路径是 `native-stop`（`client.ts:3700`），它同时需要 canonical `turn-end` receipt **和**一次成功的
  `kernel.status()`；`CTXMUX_DISCONNECTED` 时 `status()` 返回 `null`，`stopRun` 为 `null`，
  `...(stopRun ? { terminalPromptReadiness… } : {})`（`client.ts:3698`）**不写任何续期**。
  （`client.ts:3090` 是第四个写入点，但它只把 `initialReadiness` 就地展开、更新 `outputCursorBytes`，
  不产生新 id；且 `client.ts:3069` 在 epoch 已被消费时直接抛错，所以它永远不构成续期。）
  消费是永久的：写入只有 `prompt-submission.ts:241` 一处（`consumedBySubmissionId: submissionId`），
  `prompt-submission.ts:222-234` 读到即无条件拒绝，全仓无 un-consume/expiry/TTL（`grep -rn consumedBySubmissionId packages/core/src apps/desktop/src` 共 11 个非测试命中，无一清除它）。
  于是一次缺失/非 turn-end/断线期间的 receipt ⇒ epoch 永不被替换 ⇒ 之后每一次 `submitAgentPrompt` 永远撞
  `AGENT_PROMPT_READINESS_CONSUMED`。诊断里 `readinessSource=initial-composer` 仍是当前值，本身就证明这个 run 从未拿到过一次 `native-stop` 续期。
- **为什么是红线**：Agent 进程活得好好的（`writeAgentInput`，`client.ts:3538`，裸键入根本不过 readiness 闸，还能打字），
  坏的只有我们的续期记账。教科书式第 2 类，被实现成第 1 类。拒绝文案还叫用户「等下一个 readiness epoch」——一个永远不会来的 epoch，建议本身是错的。
- **正确做法**：断线是第 2 类。要么让断线分支**降级放行 + 服务窗**（照 `confirmRenderOrDegrade`），
  要么让 epoch 能在一个**活着、running** 的 Agent 上过期/重铸——任何让「活 Agent 永远有一条通往可发送 epoch 的路」的设计。

### 反例 2 — 用我们的投影硬禁输入

- **形状**：拿我们对进程状态的**投影**当门，投影一抖就把输入面关掉。
- **实例**：`composer-submit-mode.ts:44-46`，`session.processState !== 'running'` 时 `canType:false`。
  `processState` 是**我们**算出来的投影；一个短暂断连但仍活着的 Agent（CTXMUX 瞬断）会被画成不可打字——
  这正是用户报的第二个症状「输入框空着却打不进字」的那一类形状。
- **与反例 1 的差别（要如实写清）**：这个**随投影翻回**就恢复，不像 epoch 是永久的。所以它是「要盯的形状」，不是已证的等价事故。
  同一文件已经很小心地把 `run-process` 真故障和 advisory 分开（见该文件下半段注释），风险只在 `processState` 这条投影上抖动时。
- **正确做法**：门要开在**权威事实**（daemon 说 run 没了、输出通道真断且不可恢复）上，而不是我们缓存投影的每一次抖动上。

### 反例 3 — 同一个消费条件让自动进度**静默**停车

- **形状**：不 `throw` 给用户，但在同一个坏状态上**静默**跳过，永远不再动。
- **实例**：`continuous-progress.ts:39`，`readiness.consumedBySubmissionId` 为真即 `skip / 'readiness-consumed'`。
  于是一个搁浅的 epoch 同时饿死手动发送**和**持续进度循环——epoch 是跨子系统的单点故障。
- **为什么是红线**：它踩了原则 11 的第一条边界——**不许静默降级**。用户有权知道自己停在降级状态。
- **正确做法**：随反例 1 的 epoch 修复一起解决；且静默 skip 不能是永久终态，必须有一条被观察到的服务窗。

---

## 正面样板（照抄这些）

- **同一函数里认出并修好过同一形状** — `client.ts:2221-2225`：`submitAgentPrompt` 明写握手绝不当发 prompt 的门，
  因为 `[?u` 对几分钟前的 run 早已不可达，拦在这里会永久挡住之后每条 prompt。**这个教训本地就有，只是没泛化到下一层的 readiness epoch。**
- **教科书式第 2 类降级** — `prompt-submission.ts:484-524` `confirmRenderOrDegrade`：`OUTPUT_GAP` / 渲染超时 / 观察被替换时，
  向 daemon 要权威状态，`running` 就把 `\r` 透传过去并落一条 `degraded` 服务窗事实，**从不静默、从不阻断**；run 真没了才让原始错误阻断。这正是 `native-stop` 断线分支该做而没做的事。
- **未知就说未知，指向环境不指向安装** — 三态探测 `classifyExecutable`（`client.ts:413`，返回 available/missing/check-failed）
  + `doctor.ts:111` 把 `check-failed` 映成 `unverifiable`、动作指向 `PATH` 与 shell 环境而非装包器。这是「绝不把未知当成好的」做对的样子。
- **缺席保持缺席、下一次响亮报错** — `agent-session-store.ts:444-457` 的注释：`有光标 ⟹ 必须是 turn-end`（守伪造，承重），
  反方向 `turn-end ⟹ 必须有光标`**故意不承重**，因为 wire 抖动（`CTXMUX_DISCONNECTED`）会打破它——缺席就让它缺席，下一次发 prompt 收到 `epoch-missing` 的**响亮**拒绝，而不是静默走错边界。这是设计对的那一半；事故是「永久消费在断线时缺了对称的『向 Agent 活着的方向降级』处理」。

---

## 不阻断，那做什么

原则 11 line 47-48 已经给了形态：**服务窗式的提醒**——说清哪一步没走通、现在按什么状态在跑、要恢复完整能力该做什么；它停在旁边，不挡路，也不消失。

两条边界见原则 11（`AGENTS.md:50-51`）：不许静默降级、不许把未知当成好的。本文不重述，只给它在本事故上的落点：
对本仓的 readiness 事故，这意味着：断线时不是「不写续期然后永久拒绝」，而是「放行本次发送 + 落一条 `degraded` 服务窗 + 让 epoch 在活 run 上可重铸」。

---

## 机械执行：能守住的与守不住的

诚实第一，不承诺守不住的守卫（本仓已有教训：名字在场 ≠ 可达；见 `MEMORY.md` 多条「guard must check reachability not presence」「name existence check is blind to rule bodies」）。

**能自动守住的（应当加）：**

- **活 Agent 恒有可发送路径的不变量测试**。构造：run 处于 `running`、readiness 已 `consumedBySubmissionId`、无后续 `turn-end`，
  断言系统**要么**重铸出可发送 epoch、**要么**暴露一条 in-band 恢复——而不是永久 `AGENT_PROMPT_READINESS_CONSUMED`。
  这是把「活 Agent 永远有路」写成可证伪断言，是这一事故最直接的机械答案。
- **变异测试**（`AGENTS.md` line 80）：把断线分支改成「照写续期」，对应不变量测试必须变红——证明这条路径被测试真的用到。
- **对断线降级路径的服务窗断言**：降级发生时必产出一条被观察到的 delivery 事实（照 `confirmRenderOrDegrade` 的 `publishDeliveryDegrade`），
  防止「静默 skip」这一族（反例 3）。

**守不住的（要点名，别假装能守）：**

- **「作者有没有问过第 1 类 vs 第 2 类」** 没有任何测试看得见意图。
- **按错误码/`throw` 在场做 grep 分不出一个防御是伪造守卫（第 1 类合法）还是记账守卫（第 2 类红线）**——两者字面同形。
  AST 也测不了「这个 `throw` 之前那次 `kernel.status()` 是否真的可达且承重」（可达性问题，不是在场问题）。
- 因此**评审这道人闸是主执行口**，上面的判定流程就是评审要逐条跑的东西。自动测试只能守住已知的具体不变量，守不住「下一个同形状的新代码」。

**人闸要留痕，否则它和没有一样。** 一道「跑过了」但不产出任何可核对痕迹的流程，正是 line 11 诊断的那种
「写下来却被绕过」——所以它自己必须有产物。任何**拿走用户已有能力**的改动（新增 `throw` / 早退 / 置灰 / 静默 skip），
commit message 里必须逐条回答判定流程的四步，每条带 file:line 证据；**第 2 步的类号判定必须附上第 1 节那一问的答案**：

> 绕过我这段代码，这条路还能不能通？

答「能」而仍然阻断的，就是红线，不许合入。没有这段留痕，视为未过闸。这一条约束的是 commit message 而不是代码，
所以它同样守不住「作者撒谎」——但它把判断从脑子里挪到了可审计的文本里，事后能被 `git log` 翻出来对账，
上面三个绕过它的提交（`923cbd19` / `6ffe7bc7` / `7377272b`）正是这样被翻出来的。

---

## 事故引用

本红线由一次 P0 事故触发（运行实例洪水式拒绝 `AGENT_PROMPT_READINESS_CONSUMED`、可发送面全死而 Agent 仍活）。
完整现象、排除过的假设、根因链、来源时间线与改进动作见 postmortem：

- `docs/casestudy/prompt-refused-after-readiness-consumed.md`

反例 2 的第二症状（输入框空着却打不进字）在该 postmortem 中被认定为**另一条机制**，不要与 readiness 事故混为一谈。

house 格式与「按用户看到的现象命名、复发以 dated `## 复发` 章节在同一文件追加」的先例见
`docs/casestudy/stale-package-feature-disappearance.md` 及其 plan `docs/reviews/agentmux-feature-disappearance-case-study-plan.md`。
