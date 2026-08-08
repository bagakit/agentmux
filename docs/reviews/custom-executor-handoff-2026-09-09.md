# 自定义 Executor 的 Agent 交接

Review: approved

用户证据：Agent 自己交接时返回 `AGENT_EXECUTOR_NOT_CONFIGURED`，用户指向自定义名称 `CodexAllDisk`；尚未读取用户当前配置，不能断言该名称等于稳定 ID 或配置一定存在。

约束：Executor id 是开放字符串；校验只检查当前配置是否存在及 Provider 绑定是否有效，不得依赖内置 id 清单。Agent 发起新 Agent 必须走与桌面端相同的 Runtime owner，结果保留 Provider、Executor、Host、Workspace、Session、Run 与能力元信息。流程失败不能停止健康的发起方。

验收：自定义 id 可以创建并进入目标 Region；返回与内置 Executor 同构的完整元信息；不存在的 id 仍明确失败；变异把开放字符串校验改回内置清单时测试变红；生产调用检查排除定义文件后非空。

后续以 `agent-spatial-control-2026-09-09.md` 的整合审查为准。代码已使用开放字符串，并无内置 Executor 白名单；优先验证名称/ID 混淆和发现信息不足。
