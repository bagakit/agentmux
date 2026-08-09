# f-22r8feyju 计划评审

Feature: `f-22r8feyju` — Steer a Working Agent
计划修订: 1 · 评审结论: **approved**
依据: 用户在会话中明确要求「输入框应该要支持 steer，这个也补充到 feature 里面」

## 这不是新能力，是一个已声明却没兑现的承诺

打开代码核实（非转述）：

- `AgentSessionComposer.tsx:32` 的占位文案已经是 **"Ask, steer, or paste a command…"**
- 同一个 `agentComposerAvailability` **并不因为 `working` 而禁用输入** —— 它只对
  disconnected / 非 running / 有 pending interaction 禁用
- 但 `AgentComposer.tsx:46` 在 `isWorking` 时**吞掉 Enter**（`!isWorking && canSubmit`），
  第 98 行把唯一主动作换成 Stop

也就是说：用户在 Agent 跑动时打完字**发不出去**，而界面明说可以 steer。**门是 UI 自己加的。**

Core 侧不是障碍：`client.ts:2181` 有 prompt-readiness stale 重试逻辑，说明运行中提交遇到状态陈旧
本就是被预期的情形。

## 为什么独立成 feature 而不并入扇出

它属于 Composer 域，与 worktree 扇出没有任何依赖关系。塞进 `f-22q8f25qd` 会让那个 feature 的
文档收口被一个不相关的东西拖住；两者可真正并行。

## 明确不做

- **不改 pending interaction 的门。** 有待答请求时卡片是唯一输入面（既有合同），steer 不能绕过它。
- **不发裸 PTY 字节。** steer 走既有的 semantic send 通路，与普通 prompt 同一条路。
- **不猜测 readiness。** Renderer 不因为看到 `working` 就自行判断能不能发；Core 拒绝时保留草稿。
