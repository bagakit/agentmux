# f-22s8fc9kd 计划评审

Feature: `f-22s8fc9kd` — Claude Model and Effort Launch Options
计划修订: 1 · 评审结论: **approved**
依据: 用户要求「对话框上应该要有选择模型的按钮…选择模型和选择推理深度还是很重要的」，并在被告知
只能声明枚举过的值后明确选择 **方案 A**（只在 CLI 真正枚举时声明）。

## 对着真实二进制核实的结果

本机三个 CLI 都装了，逐个跑 `--help`：

| Provider | `--model` | 推理深度 |
| --- | --- | --- |
| claude | **枚举别名** `fable` / `opus` / `sonnet`（也接受全名） | **`--effort` 枚举** `low, medium, high, xhigh, max` |
| codex | 只写 "Model the agent should use"，**无枚举** | **完全没有** reasoning/effort flag |
| cursor-agent | 给的是**举例**（`gpt-5`、`sonnet-4-thinking`），非穷举；effort 埋在 `[effort=high]` 方括号语法里 | 同上 |

据此按方案 A：**只有 claude 声明这两项**。codex 与 cursor 依「未声明即不渲染」自然没有按钮——这不是
能力缺失，是诚实边界：它们的 `--model` 收任意字符串，手写一张模型清单会在厂商改阵容时立刻过期。

## 「对话框」是哪一个——我先前的误判

我曾就此给用户三个选项（Launcher 选 / Composer 只读 / 用新模型重开），**那是基于误判**。核实后：

- **新建 Agent 的输入框**（`NewTabSurface.tsx:210`）已经挂了 `LaunchRefine`，且第 62 行**纯粹从 catalog
  读声明、不按 providerId 分支**。这正是 spawn 时刻，把 model/effort 放这里完全诚实。
- **运行中 Agent 的 Composer** 按合同**故意不挂** launch option：`agentmux-desktop-interaction.md:74`
  写明「启动 argv flag 永不作为 live composer 开关出现，因为它对运行中的 PTY 进程静默 no-op」。

所以用户要的按钮，落在启动输入框上即可，不需要任何新形态。三个选项作废。

## 因此改动面极小

封好的 DESCRIBE/CONTRIBUTE 契约把其余工作都做完了：

- `LaunchRefine` 泛化渲染任意声明，无需改渲染层
- mock catalog 已从 SSOT 投影（`api.ts:44` 的 `describeLaunchOptions`），**不会重现当年手抄的问题**
- 名册的 `resolveRosterScopes` 会自动显示已选模型/深度（只读），顺带解决"忘了启动时选的什么"

## 一个采纳的判断：model 与 effort 不带 tier

`RiskTier`（danger/caution/safe）是给 approval 与 sandbox 的危险分级。选模型或推理深度**既不放宽也不
收紧任何权限**，给它标 tier 会在名册行上打一个**假的风险标记**。`LaunchOptionChoice.tier` 是可选的，
留空才是诚实值。

## 一条挑战的裁决

对抗复核声称"有测试锁定 claude 的 launchOptions 数组，加选项会破坏它"。**我 grep 核实后判定不成立**：
`agent-launch-option.test.ts` 只测 codex 的验证器，`agent-session-store.test.ts` 用的是合成选择，
全仓没有对 claude 声明集的断言。故按原方案执行。
