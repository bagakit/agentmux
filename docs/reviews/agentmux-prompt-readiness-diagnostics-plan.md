# Prompt readiness 诊断分类计划

状态：approved（用户于 2026-09-01 明确要求“把四种错误分类报错，并给出详细信息，直接交给 subagent 彻底完成并提交”）

## 目标

把当前由 `RuntimeController.humanizePromptDeliveryError()` 合并成一句英文的四类 readiness 拒绝，恢复为可操作、可审计的分类信息。Core 的 readiness 门、输入字节栅栏、草稿保留和 fail-closed 边界不改变。

## 四类事实与处置

| code | 事实 | 面向人的下一步 |
|---|---|---|
| `AGENT_PROMPT_NOT_READY` | 当前 Run 没有可消费的 composer readiness epoch | 等待 Stop/屏幕观察完成；若持续，检查 Provider readiness marker/Hook ingress |
| `AGENT_PROMPT_READINESS_CONSUMED` | 当前 epoch 已被另一条 prompt 消费 | 等待已有交付收口；不要重复发送同一条消息 |
| `AGENT_PROMPT_SUBMISSION_BUSY` | 上一条 payload/render/submit 两阶段尚未收口 | 保留草稿，等待已有 submission 的回执 |
| `AGENT_PROMPT_READINESS_CONFLICT` | readiness 观察与 Session 代次发生 CAS 冲突 | 重新读取 canonical Session 后重试；不得绕过 Core 直接写 PTY |

## 实现边界

- Core 错误保留稳定 `code`，并在 `detail` 中只携带 Run/epoch/submission 的非敏感诊断，不携带用户正文。
- Desktop Main 是唯一按 code 产生人类文案的地方；Renderer 只剥 IPC transport 前缀，不能再按 message 正则复制一份分类器。
- 每一类文案必须同时包含：发生了什么、Agent/Run 现在按什么状态运行、下一步应做什么。
- 运行中的健康 Agent 不因这四类流程拒绝而被停止；用户草稿继续保留，失败不产生幻影 user turn。

## 验收与验证

- 四个 code 各有独立测试，断言 code、detail、面向人的 message 与建议动作；删除任一分支必须变红。
- 覆盖 Electron 包装错误穿过 IPC 后仍显示分类文案的 renderer 回归。
- 变异测试至少删除一类映射、抹掉 detail、或把四类合并为同一句，均应失败。
- 零调用者检查：分类器在 RuntimeController 的真实 submitPrompt 生产路径被调用；测试之外仍有该调用者。
