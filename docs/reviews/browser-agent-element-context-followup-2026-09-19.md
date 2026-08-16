# Browser Agent element context follow-up

Review: approved for follow-up

依据：Browser drive 需求的 R7 明列 Agent 可发起的元素上下文，但已归档 Feature 的 12 个 Task 没有覆盖它。当前实现的 `event.isTrusted` 门禁仍然正确保护人工选择，因此本项不能通过删除门禁来“补齐”。

范围：增加一条显式、可审计的 Agent 入口，复用现有 `extract()` 结构化结果；人工选择继续只接受真实事件。入口必须定义授权边界、失败结果和 Composer/脚本消费路径，并以行为测试证明网页脚本不能伪造人工选择。

当前状态：未实现，作为独立 P2 Feature 跟踪；不把已归档 Browser drive Feature 标为全需求完成。
