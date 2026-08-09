# f-22r8feyju 独立实现审查（T-004 收尾）

日期：2026-08-29
审查者：主 session（未参与实现）
方法：对着工作树真实代码核对，不采信自述

## 背景

用户原话：Composer 的占位文案早已承诺 steer，但 working 时 Enter 被吞、主动作只有 Stop，
承诺与行为矛盾——「让用户在 Agent 正在跑的时候就能补一句话把它带回正轨」。

## T-001 判定收敛为一个纯函数 —— 通过

`apps/desktop/src/renderer/src/lib/composer-submit-mode.ts:32 composerSubmitMode`
返回 `{ canType, canSubmit, primaryAction, placeholder }`。

- **不读 Store、不碰 Electron、不按 providerId 分支**（全文件无 providerId 判断）。
  这一点很关键：能否真正送达是 **Core 的裁决**，不是界面按 provider 猜测的结果；
  界面只回答"是否允许尝试提交"。
- `:48` 明确把两个轴分开：`primaryAction = working ? 'stop' : 'send'`，
  而 `canSubmit` 在 working 时仍为 true。**一个跑动中的 Agent 既要能被补话也要能被叫停，
  二者不互斥**——这正是原缺陷把两个问题混成一个所致。

## T-002 working 时 Enter 真的把话送出去 —— 通过

送达经**既有** send 通路（store.send → submitPrompt → Core），不新增 Renderer 侧第二条写通道。
`AgentComposer.tsx` 原先那个 `isWorking` 门（吞掉 Enter）已整个删除，不留兼容分支。

## pending interaction 期间不允许 steer —— 通过（双重保险）

`composer-submit-mode.ts:49-54`：存在 `pendingInteraction` 时
`canType: false, canSubmit: false`，占位文案改为「Answer the Agent request above…」，
**但 `primaryAction` 保留**——working 时 Stop 仍然可达。

注释写明了理由：卡片是待答期间唯一输入面（既有 Core 合同），
Core 侧也会抛 `AGENT_INTERACTION_PENDING`，但**界面不能连提供都提供**。
两道保险，且职责清楚：Core 是权威，界面不诱导用户去撞一道必然拒绝的门。

## 合同不得写成普遍送达承诺 —— 已正确表述

设计 SSOT（interaction:72-74）明写：这**不是**"working 时提交一律送达"的承诺；
render-then-submit Provider（9 家里只有 codex）的 mid-turn steer 会被 Core fail-closed 拒绝，
那是一等预期而非缺陷；被拒时草稿保留（这就是诚实的"没送出去"信号），且不产生任何 user 回合。

条款还写明了**为什么不做队列**：下游 CLI 自带输入行 + 就绪门控对 8/9 Provider 不可实现。
这条很重要——它解释了一个看起来"更完整"的方案为何被否决，避免后人重新提议。

Core 侧的就绪门确实存在（`agent-session-store.ts:655` 起的
`terminalPromptReadinessSource` 与 Run 边界校验），合同没有承诺一件 Core 会拒绝的事。

## 门禁

`pnpm check` 实测全绿：typecheck + 1208 passed / 0 failed / 3 skipped + build 成功。

## 结论

无 blocking 发现。三条不变量——送达经既有通路、working 可提交而 Stop 仍是主动作、
pending 期间卡片唯一——在代码中成立，且合同表述与 Core 的实际行为一致，
没有把 fail-closed 的边界粉饰成普遍承诺。
