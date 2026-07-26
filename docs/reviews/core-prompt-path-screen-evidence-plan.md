# Task Plan Review — Core Prompt 路径的屏幕证据与提交不阻断

日期：2026-08-30
原则 SSOT：`AGENTS.md` 第 11 条（三种状态）与第 10 条（ctxmux / AgentMux 边界）
设计 SSOT：`docs/design/agentmux-desktop-interaction.md` 的《我们的流程坏了，不等于 Agent 坏了》与本节新增的《Prompt 交付验证不得挡死健康 Agent》

## 用户授权

用户在确认 fable5 关键优化结论后，明确要求：创建 feature-tracker Feature，并彻底优化。本文件是该授权下的 reviewed plan evidence。

## 结论

**approved**。最高杠杆是 Core 侧屏幕语义证据：今天每次 `submitAgentPrompt` 的 render 验证与 readiness 观察都从 byte 0 全量重放进临时 headless xterm；replay 截断时 `OUTPUT_GAP` fail-closed，健康 Agent 发不出提交。这是原则 11 的第 2 类被写成第 1 类。

## 问题

1. **性能**：提交延迟随会话历史线性增长；每次观察临时分配大 scrollback xterm。
2. **正确性**：`waitForTerminalScreenState` 在 `observeOutput(..., 0)` 遇到 gap/截断时抛 `OUTPUT_GAP`，两阶段提交的 `\r` 永远发不出——Agent 活着，是我们的验证流程挡路。
3. **写放大**：一次 prompt 对 session store / timeline 多次整文件 rewrite，多 Agent 并发排队。
4. **结构**：`packages/core/src/client.ts` 混居 prompt 状态机与屏幕观察，后续增量屏幕与 conformance 难独立演化。
5. **合同缺口**：「新增 Agent 只需 Provider」缺少 Provider 无关的 prompt-render / readiness conformance。

## 非目标

- 不在 AgentMux 缓存第二份 Run 字节史（原则 10：replay/checkpoint 权威在 ctxmux）。
- 不把 session store 换成第二套 SQLite。
- 不做 Remote/SSH、不做 Provider 动态插件系统。
- 不为 Claude 等无 matcher 的 Provider 伪造假 readiness；诚实走 single-phase 并在 capability 声明。

## 方向（按 Task 闭合）

1. **服务窗降级（最小端到端）**：payload receipt 已确认、仅屏幕验证失败（gap / render timeout）时，照常发 submit，并发布不可静默的降级事实（哪一步没走通、现在按什么状态跑、如何恢复完整验证）。真坏的 Run（exit / 进程死）仍 fail-closed。
2. **有界屏幕证据**：为活跃 AgentSession 维护长命增量屏幕，或从最近完整 TUI 帧起点观察；失效（resize / 重连 / gap）时重建。帧/checkpoint 起点若需 daemon 能力，只提 ctxmux 公共诉求，不在 Core 旁路缓存字节。
3. **timeline / receipt 写放大**：timeline 改为 per-session JSONL append；高频 receipt 字段合并或延迟，CAS JSON 保留低频权威字段。崩溃恢复必须可从 receipt / ctxmux 事实重推。
4. **按 Owner 拆 `client.ts` 内部模块**：公开 API 不动；抽出 prompt-submission 与 screen-evidence。
5. **Codex recorded-PTY conformance 骨架**：同一套断言覆盖 readiness / promptRender；变异尺与零调用者尺按 AGENTS.md。

## 与 WIP 交汇

- Cold parking 与增量屏幕是同一问题的两半：谁从字节流重建屏幕。帧起点有界后，parking 唤醒成本也有界。
- WAL checkpoint resilience 是 ctxmux owner；本 Feature 消费其公开结果，不复制 checkpoint 逻辑。
- Window geometry 无关。

## 验收总尺

- 变异测试：去掉降级告示、恢复 fail-closed、或删掉有界重放起点时，对应测试变红。
- 零调用者：新增公开/跨模块符号在定义文件之外有生产调用者。
- 长历史下 submit 验证路径延迟有界（相对 byte-0 全量重放的基线）。
