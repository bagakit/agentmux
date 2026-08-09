# f-22r8feyju 计划修订 2：按证据校正 steer，明确不做队列

日期: 2026-08-29 · 评审结论: **approved**
依据: 用户追加要求「对话框上面要支持 Steer 发送，或者进入队列, 而不是说有一条在执行就不让发」。
用户把 steer 与队列作为**二选一**提出，因此选出诚实的那个就是本次评审的工作。

## 我先前的判断是错的，收回

我曾据 `AgentTerminalPromptReadinessState.source` 只有 `'initial-composer' | 'native-stop'` 推断
「运行中没有 readiness，所以直接送会把字符插进正被 CLI 使用的 TUI，队列可能是唯一诚实实现」。

**逐行核实后这是误读**：

- `client.ts:1317-1326` 的 `submitAgentPrompt` 里，**唯一的前置门是 `pendingInteraction`**，
  全路径没有任何 `working` / semanticStatus 检查。
- 单相 Provider 走 `client.ts:2043` 直接把 `prompt+\r` 交给 PTY。
- readiness 门只作用于 **render-then-submit** 这一条分支，而 `agent-provider.ts` 里 9 个 Provider
  只有 **codex 一个**是 render-then-submit（:725），其余 8 个都是 single-phase（:577）。

也就是说 **Core 从来不拦运行中的 steer**。今天挡住它的只有 Renderer 自己加的一行：
`AgentComposer.tsx:46` 的 `!isWorking && canSubmit` 吞掉 Enter。

## 因此：做 steer-send，不做队列

**队列被砍掉，理由是它需要一份不存在的 Core 合同**：持久的 per-session 有序 backlog、Stop/新 Run/
pending-interaction 到来时 backlog 的去留语义、以及一个「Agent 何时就绪接收下一条」的投递驱动。
最后一条无法诚实实现——mid-turn readiness 只有 codex 有，另外 8 个 Provider 在回合中没有就绪信号，
Core 无从得知何时投递下一条。

**而队列其实已经存在于下游**：现代 Agent TUI（claude code 等）自带 mid-turn 持久输入行，`prompt+\r`
交给的正是那个输入行。AgentMux 再建一个就是给已有 owner 造第二个 owner——违反单一 owner 原则，
也是无意义的熵增。

设计 SSOT 亦已锁定该立场：`agentmux-desktop-interaction.md:54` 明写状态跃迁「只推进基线、不排队」；
单槽的 `AgentTerminalPromptSubmissionState`(`types.ts:359`) 是一次 in-flight 提交的幂等记录，
**不是 backlog**——并发第二次提交抛 `AGENT_PROMPT_SUBMISSION_BUSY` 而非入队。

## 「不发裸 PTY 字节」的准确含义

不是「不写 PTY」——单相通路本就写 PTY，那是既有行为。它的含义是 **Renderer 不得新开第二条写通道**：
steer 复用 `store.send → submitPrompt → Core.submitAgentPrompt`，与普通 prompt 同一条路。

## codex 的 fail-closed 是一等预期，不是缺陷

codex 在回合中 steer 会被 Core 拒绝（`AGENT_PROMPT_NOT_READY` / `AGENT_PROMPT_READINESS_CONFLICT`）。
这是它 sealed readiness 合同的正确表现。关键细节：抛错发生在 `recordPromptAfterSideEffect`
(`client.ts:1327`) **之前**，所以**不留幻影 user 回合**，草稿保留。

因此 T-002 的验收**不得**写成「working 时 Enter 一律送达」——那对 codex 为假，照它写测试会诱导后人
去削弱 codex 的 readiness 门，即劣化一份已封的合同。改为分两支的可测断言。

## 用户看到什么

因为选了同步的 deliver-or-refuse，**不存在「已排队但未送达」的中间态**，所以不需要新词汇：

- 送达：草稿按既有 compare-clear 清空，这句话作为一条 `user` 回合出现在 Activity turn register
- 被拒：**草稿留在输入框**——字还在框里就是「没发出去」的诚实信号；错误经既有 reportError 浮现
- 红线：草稿只在 Core ack 后清空，绝不在 `await send` 返回前乐观清空

不新增 `queued` / `pending-send` 状态点或颜色。
