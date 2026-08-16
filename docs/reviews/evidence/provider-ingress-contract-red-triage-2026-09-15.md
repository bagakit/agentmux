# provider-ingress-contract 两条红的归因（给写这个文件的人）

日期：2026-09-15。作者：另一个并发 agent。**我没有改你的文件**——这两个 gate 交付物
（`packages/core/test/provider-ingress-contract.test.ts`、
`apps/desktop/test/provider-ingress-consumers.test.tsx`）是你的在制品，归你收口。
这里只留证据，省得你重新查一遍。

实测（仓根，`NODE_OPTIONS` 带 fsevents 钩子）：

```
Test Files  1 failed | 1 passed (2)
     Tests  2 failed | 12 passed (14)
```

desktop 侧 7 条全绿。core 侧 2 红。**两条都不是产品缺陷**，但性质不一样：
第一条是夹具时间戳，第二条是**这条断言的标题本身不成立**。

---

## 红 1：`refuses a prompt while a human request is pending` —— 夹具时间戳

抛在 `agent-session-store.ts:1070`，`AgentMuxError: Pending interaction does not match the Agent Session.`

校验体（`:1062-1071`）要求 pending 请求满足三条，其中：

```ts
interaction.evidence.observedAt > session.updatedAt   // → 抛
```

你的夹具里 `updatedAt: 100`（:47）而 `evidence.observedAt: 200`（:141）。
**这个校验是对的**——一份 pending 请求不可能比它所属会话的最后更新还新，
那意味着会话状态没跟上。所以是夹具的时间戳写反了。

修法：`updatedAt` 抬到 ≥ 200（比如 300），或 `observedAt` 降到 ≤ 100。
被测性质（pending 时 `submitAgentPrompt` 抛 `AGENT_INTERACTION_PENDING`）本身成立，
承重闸门在 `client.ts:2336`，它在 `serializeAgentInput` 回调里读**最新持久状态**，
所以 renderer 被绕过也挡得住。夹具修好后这条应该真绿。

---

## 红 2：`does NOT double-send when the SAME operationId is replayed` —— 标题不成立

这条更值得看一眼，因为改夹具改不好它。

标题说「the anti-double-send owner is Core」。**对 claude 这条路径不成立。**

claude 是单阶段：`prompt-submission.ts:134` 写完 daemon 就直接 `return`，
**Core 的 JS 层不留任何提交状态**。去重发生在 daemon——operationId 经
`ctxmux-run-adapter.ts:1067` 传成 `operationKey`，由 daemon 认重放。

你的假 kernel 无条件 `writes.push`，也就是**没建模那个去重点**。
于是第二次调用当然又写一次，`['once only\r','once only\r']`。
产品没坏，是测试在一条 Core 侧根本不存在去重的路径上要求 Core 去重。

Core 自己持有幂等的是**两阶段**（codex 的 render-then-submit）：
`prompt-submission.ts:186` 比对 `submissionId`，同 id 直接 `assertSubmission` 幂等返回。

两条修法，选哪条取决于你想钉哪个性质：

- **(a) 想钉「daemon 认重放」**：假 kernel 按 `operation.operationId` 记忆已应用的 op，
  重放时返回同一 receipt 而不再 push。标题相应改成「重放同一 operationId 不产生第二次写入」，
  别说 owner 是 Core。
- **(b) 想让标题成立**：改用 codex 走两阶段，幂等就真落在 Core 自己的 submission 状态上。
  变异靶子随之变成 `prompt-submission.ts:186` 的同 submissionId 早返回——删掉它会重复写两相。

我倾向 (b)：T-002 的验收讲的是「并发输入有一个投递 owner」，
两阶段那条路径上 Core 确实是那个 owner，钉它更贴验收。
(a) 钉的是 daemon 的行为，用一个假 kernel 去证真 daemon 的性质，证据力弱。

---

## 顺带：已经绿的那些别再补

这三条验收的产品行为，今天在既有测试里已经全绿（共 74 用例）：

| 性质 | 既有覆盖 |
| --- | --- |
| pending 时不把 prompt 当回答 | `composer-submit-mode.test.ts:75`、`agent-session-composer.test.tsx:317`、`packed-consumer.mjs:418` |
| 重试复用 operationId | `agent-steer-queue.test.ts:25`、`client-submit-prompt-interrupted.test.ts:145` |
| 投递前状态变化有围栏 | `client-submit-prompt-interrupted.test.ts:156`、`agent-steer-queue-run-binding.test.ts:48` |
| 失败不清草稿、compare-and-clear | `agent-session-composer.test.tsx:180/296/164` |
| host accepted ≠ provider consumed | `prompt-delivery-service-window.test.tsx:22/31` |

所以这两个新文件的价值**不是补覆盖缺口**，是给 T-002 一个 verification 点名的落点
加一处集中的变异证据。别把现有断言复制过来凑数。

## 另外两件已定的事

- **T-002 验收第 3 条后半句「移除 renderer 和 host 的重复投递状态机」，那个重复不存在。**
  两轮调查（第二轮专门做对抗性反驳）的完整证据见
  `docs/reviews/acceptance-premise-check-f-25k8f8m9k-2026-09-15.md`。
  这条验收待改写，不要照着它写代码。
- 同文档也记了 T-003 验收第 2 条的「自由文本」同样不存在。
