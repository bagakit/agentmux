# Plan Review r1 — Honest Prompt Readiness Refusal (f-2368fh2tg)

Meta: `f-2368fh2tg` reviewed task plan (revision 1) 的评审依据。修复在计划落盘前完成并过针对性测试。

## 用户原始报告（逐字）

> bug: Error invoking remote method 'sessions:submitPrompt': AgentMuxError: Agent prompt requires a
> ready composer epoch for this exact Run. 当前执行的进程还是遇到这个

## 判定：(a) 门是对的，话是错的

抛出点 `packages/core/src/client.ts:2128`（`AGENT_PROMPT_NOT_READY`）。这**不是** epoch 逻辑的缺陷：

- 9 家 provider 里只有 codex 是 `render-then-submit`（`packages/core/src/agent-provider.ts:725`），
  它只在自己的 composer 真的画出来时才接受 prompt。mid-turn steer 被 fail-closed 是**一等预期**，
  已写进 `f-22r8feyju` T-002 的验收。
- 因此**绝不削弱这道门** —— 那是一份已封的合同，削弱它等于劣化。

真正的缺陷是：Core 用自己的词汇解释拒绝（"a ready composer epoch for this exact Run"），
而这句话对着的是我们、不是那个正在打字的人。用户看到一个内部错误码，不知道该等、该按 ■、还是该报 bug。
更糟的是 Electron 把 `.code` 在跨 `ipcRenderer.invoke` 时丢掉，只剩一层传输外壳
（`Error invoking remote method '<channel>': ...`）裹着内部术语。

## 修复取向（两处，各自独立）

1. **在 main 进程翻译**（`apps/desktop/src/main/runtime-controller.ts:238-252`）：按 code 集合识别
   readiness 家族的四个码（`AGENT_PROMPT_NOT_READY` / `_READINESS_CONSUMED` / `_READINESS_CONFLICT` /
   `_SUBMISSION_BUSY`），换成一句用户能照着做的话，**保留 code 与 detail** 供日志与程序分支。
   选在 main 是因为那里 code 尚存 —— 到了 renderer 只剩字符串可匹配，那会是更脆的第二处真相。
2. **在 renderer 剥掉传输外壳**（`store.ts` 的 `message()`）：去掉 Electron 的
   `Error invoking remote method '…':` 与 `AgentMuxError:` 前缀，使横幅显示 main 实际抛出的那句话。

这两处职责不同，不是重复：一处决定"说什么"，一处决定"不要把信封也念出来"。

## 审阅时我撤回的一处自己的改动

我曾在 renderer 的 `message()` 里另加一套正则→人话的映射表。核实后撤回：main 侧已按 code 翻译，
再加一处按 message 正则匹配的映射就是第二份真相，且更脆（Core 改一个字就失效）。SSOT 原则要求只留一处。
