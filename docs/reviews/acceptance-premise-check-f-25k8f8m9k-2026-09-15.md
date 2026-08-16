# 验收前提核验：f-25k8f8m9k 里两条指向不存在问题的验收

Status: decided — 两条验收待改写，需评审 owner 确认

日期：2026-09-15。触发：`f-25k8f8m9k` 的 T-002 与 T-003 同时解锁要开工，
两者的验收里各有一句隐含"某个东西存在"的断言。动手前先证它们。

> **T-002 验收 3**：Host accepted 与 Provider consumed/unknown 分开；**移除 renderer 和 host 的重复投递状态机**。
>
> **T-003 验收 2**：Provider 声明的**选择/自由文本**能力和响应计划对应；缺失能力显示原生入口与原因。

"移除 X"要求 X 存在；"自由文本能力和响应计划对应"要求自由文本这条能力轴存在。
两条都不成立。

## 结论

| 验收 | 前半句 | 后半句 |
| --- | --- | --- |
| T-002 #3 | 成立，保留 | **那个重复不存在**，删除 |
| T-003 #2 | 选择能力↔响应计划：**已满足** | **自由文本这条能力轴不存在**，且没有消费者需要它 |

照着这两句写代码，会分别驱动两次最坏形态的返工：一次"为了收敛而先制造一个重复"，
一次"为了让降级 UI 有东西可降级而先造一个没人要的能力"。

---

# 一、T-002 #3：那个重复投递状态机

## 为什么做了两轮

第一轮调查的结论是"host 侧根本没有投递状态机"，依据是 `grep SteerQueue|deliveryState|promptQueue`
在 `apps/desktop/src/main/` 零命中。**这个依据不够硬**：本仓吃过按名字形状推理的亏
（`startsWith('Post')` 对 snake_case 事件名全失明），四个名字的 grep 证明不了"没有"。

所以第二轮的立场设成**对抗**：假定 host 侧有状态机，只是第一轮没找到。

## 第二轮找到了第一轮漏掉的东西

枚举 `apps/desktop/src/main/` 下**每一个** `Map`/`Set`/`Record` 字段（不按名字筛，读用途），
确实挖出两处真正有状态的投递机制：

- `runtime-controller.ts:295` `terminalInputCursors = new Map<string, number>()`
- `runtime-controller.ts:296` `terminalInputTails = new Map<string, Promise<void>>()`

`writeTerminalInput`（`runtime-controller.ts:1143`）用 tail 按 `(hostId, runId)` 串行化写入，
用 `expectedByte`/`acceptedThroughByte` 做乐观并发游标，出错时重置游标，
`waitForHostQuiescence`（`:1137`）负责排空。这是货真价实的 host 侧投递状态机。

**所以"host 是无状态透传"这句话，作为一般陈述是错的。** 第一轮的论据不完整。

但它改不了结论，有两个理由：

1. **它不在 T-002 管的那条路径上。** 这是 terminal PTY 直写路径；T-002 管的是 agent-prompt/provider
   路径。后者的 host 入口 `submitPrompt`（`runtime-controller.ts:791`）确实无状态：
   状态校验 → `client.submitAgentPrompt` → 错误人性化。没有队列、没有游标、没有 in-flight 抑制、
   没有去重（幂等性来自 Core 的 `operationId`，不是 host 状态）。
2. **它没有 renderer 对侧。** `terminalInputSender`（`terminal-reveal.ts:80`）是
   `if (accepts()) write(data)` 的 fire-and-forget，无游标无队列。**一侧持有状态、另一侧什么都不持有，
   构不成"重复"**——重复要求两处各存一份会漂移的同一事实。

## 另外两条论据的实证复核

不采信任何自述注释——本仓有「文档清单会烂是因为没人读它」的教训。

### `terminalPromptDelivery` 的两处出现是只读投影

只证"这一行是 `structuredClone`"不够，得证**别处没有第二个写入点**（见「两个写入点要收成一处投影」）。
搜了 renderer 与 main 里对 `terminalPromptDelivery` / `terminalPromptSubmission` 的全部**赋值**：

- renderer `session-state.ts:572`（解构丢弃过期值）、`:587`（从 `core.session` `structuredClone`）
- host `runtime-controller.ts:230`（同样是 `structuredClone` 投影）

没有本地重算、没有 reducer 里再派生、没有 spread 覆盖。真正的状态机写入全在 `packages/core`
（`prompt-submission.ts`、`client.ts:1088/2059`、`agent-session-store.ts`）。SSOT 在 Core，成立。

### steer queue 的收敛是完整的

数三个判据函数在 renderer 下的全部调用点，并找有没有哪个调用方绕开模块就地又判一遍：

| 函数 | 调用点 |
| --- | --- |
| `steerQueueCanEverDrain` | `AgentSessionComposer.tsx:232`（角标） |
| `steerQueueCanDrainNow` | `store.ts:4520`（flush 闸门） |
| `steerEntryTargetsRun` | `store.ts:4526`（flush）、`AgentSessionComposer.tsx:233`（角标） |

历史上分家的那两处——flush 闸门与 composer 角标——现在都走这个模块。
`AgentSessionComposer.tsx:55/58` 那两处就地的 `processState`/`pendingInteraction` 判断属于
`composerSubmitMode`，回答的是"能不能打字"，跟"这条队列会不会排空"是两个问题，不是手抄副本。
没有任何地方孤立地写 `entry.runId === runId` 或 `processState === 'running'`。

实测：`agent-steer-queue-run-binding.test.ts` + `agent-steer-queue-deliverability.test.tsx`
→ Test Files 2 passed / 16 tests passed。

### `checkDeliveries` / `ackDeliveryBatch` 零消费者

反向从 preload 和 IPC channel 名入手（不从函数名），没有任何 channel 路由到它们；
`control-host.ts` 的 operation 分发表里也没有一项走 `DeliveryQueue`。
`agent-message.ts` 的 `AgentDeliveryState` 机器另有一个瘦消费者
（`client.startDiscussion` → `client.ts:1581` `advanceDelivery(...,'delivered')`），
但 `agent-delivery-queue.ts` 这一支确实无人消费。
`delivery-evidence.ts` 是只读 `Record` 查表，不是第二张状态转移表，不构成对 Core `NEXT` 的重复。

## 这条验收是怎么来的

两种可能，证据不足以区分：

1. **已经做完了。** `6db686b2`（"bind each queued steer to the run it was typed at"）就是那次收敛；
   验收写于收敛之前，落地后没人回头改验收。
2. **预防性措辞。** 写计划时担心会出现这个重复，措辞成了"移除"。

两种情况下，今天的正确动作都是**改验收**，不是写代码。

---

# 二、T-003 #2：自由文本能力

## 这条能力轴在类型里根本没有

从类型入手，不从 `freeText` 这个名字入手（grep 它在 `packages/core/src` 下零命中，
但零命中本身证明不了什么——见上一节的教训）：

- **`AgentCapabilities` 恰好六条轴**（`types.ts:297`）：`terminal`、`timeline`、`permission`、
  `providerResume`、`replyCorrelation`、`usage?`。没有一条描述自由文本。
- **question 请求形状只有选项。** `AgentMuxQuestion = { id, prompt, title?, options[] }`（`types.ts:678`）；
  `AgentMuxQuestionOption = { id, label, description? }`（`types.ts:672`）。没有 text/input/freeform 分支。
- **响应形状只能回选项 id。** `AgentMuxQuestionAnswer = { questionId, optionId }`（`types.ts:695`）。
  没有任何途径回传一段文本。
- **响应计划永远只发一个数字。** `planResponse` 的 question 分支以
  `return { data: String(optionIndex + 1) }` 结束（`agent-interaction.ts:356`）。
- **自由文本在入口就被拒了。** `parseQuestion` 在 `rawOptions.length === 0` 时返回 `null`
  （`agent-interaction.ts:213`），null 让 `questionRequest`/`normalizeTerminalInteraction`
  返回 `undefined`（`:242`、`:315`）——一个"请输入你的答案"式的无选项提问被静默丢弃，不会成卡片。
- **三个 Provider 谁都没声明它。** claude（`claude.ts:109`）、codex（`codex.ts:84`）、
  grok（`grok.ts:110`）各自只列那六条。

能力字段、请求分支、响应分支、响应计划、入口解析——五处全缺。不是缺一半。

## 为什么它也不该被补上

1. **没有任何 Provider 需要它。** claude/codex 的 `askuserquestion` 都是多选
   （`claude.ts:117`、`codex.ts:104`），grok 只观察。没有谁会发出一个 AgentMux 必须渲染的自由文本请求。
2. **自由文本的"原生入口"本来就一直在，就是终端。** `AgentSessionComposer` 任何时候都在往 PTY
   发自由文本。Agent 在自己的 TUI 里开放式提问时，用户就是靠打字回答的。
   typed 交互卡片是**为编号选择追加的**便利，它对自由文本的缺席不是"点了没反应的控件"，
   而是"压根没控件，走终端"——那条路一直通着。
3. **给三个 Provider 各加一行 `freeText: false`，是在声明一个没有消费者的缺席。**
   正中「纯描述字段没消费者＝谎言免检」那条教训，也正中 YAGNI。

## 前半句其实已经满足

"Provider 声明的选择能力和响应计划对应"——这正是 `55c10ad5` 那份契约测试钉住的第一条：
optionId → 字节在 core 解析，两个 Provider 各自从同一份语义答案解析出自己声明的字节。

## 降级 UI 的现状（顺带核清）

按能力字段找消费点：renderer 只消费 `timeline` 和 `usage`（`store.ts:898`、`SessionPane.tsx:360`、
`agent-usage.ts:114`、`agent-observation.ts:22`）。**没有任何地方读 `capabilities.permission` 来改交互 UI**。

按"纯禁用 vs 给原因"统计：

- **纯禁用无解释：1 处** —— `AgentInteractionCard` 的 `disabled`（`SessionPane.tsx:395`），
  但它由进程/连接死亡驱动，不由能力驱动，不在这条验收的射程内。
- **真给了原因和去向：1 处，但是另一条能力** —— `ActivityView.tsx:813`，
  `capabilities.timeline === 'unavailable'` 时渲染
  *"This executor does not provide structured activity. Terminal remains available."*
  这正是验收想要的形状，只是用在 timeline 上。

**"原因 + 恢复动作"的通用组件已经有了**：`ServiceWindowNotice`（`{step, mode, restore}`），
由 `service-window-notice.ts` 驱动。真要做这个形态，不该新造组件。

## 唯一可能的真缺口（但可达性未证）

`agent-interaction.ts:213` 那个无选项提问的丢弃是**静默**的——不像 timeline 那样会告诉用户
"这需要自由文本回答，请去终端"。但**没有证据表明这个分支可达**（claude/codex 的
`askuserquestion` 总是带选项到达）。

若要补，是复用 `ServiceWindowNotice` 的一行说明，**不是**一套自由文本能力+控件；
且它属于 T-003 现有射程（同一条交互生命周期），不该单拆 Task。

在可达性被证明之前，按「写恢复文案前先证可达性」这条教训，不动它。

---

# 三、待办

两条改动都触到了已评审的需求边界，需用户或受委托的评审 owner 确认后才能发布：

1. **T-002 #3** 改为只保留前半句：「Host accepted 与 Provider consumed/unknown 分开」。
2. **T-003 #2** 改为：「Provider 声明的选择能力和响应计划对应；缺失能力显示原生入口与原因」，
   删去"自由文本"，并在计划里记一句：自由文本的原生入口是终端，始终可达，不新增能力轴。

两个 Task 仍是 `todo`，属于「未开工任务可改写」的范围。它们真正未做的工作不在这两句里。

# 四、重开条件

以下任一出现，重新审对应结论：

- 有人在 `apps/desktop/src/main/` 新增任何持有 agent-prompt 投递中间状态的字段
  （队列、游标、in-flight 集合、重试表），且 renderer 侧存在同一事实的第二份
- `terminalPromptDelivery` 在 renderer 或 host 出现 `structuredClone` 以外的写入点
- 上表三个判据函数之外，出现就地重判 steer 可排空性的代码
- `terminalInputCursors` 的那套游标长出 renderer 对侧（届时它就真成了一处重复）
- 有 Provider 开始发出无选项的提问（`agent-interaction.ts:213` 那个分支真的可达），
  或有 Provider 声明需要自由文本回答
