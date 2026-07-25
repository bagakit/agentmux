# 启动 Agent 时注入 AgentMux 指南

## 问题

AgentMux 已经把自己的 CLI 放进受管 Agent 的 `PATH`，也提供了 `agentmux --skill`。
但“命令存在”不等于 Agent 一启动就知道它的用途。用户只说“在右边打开 Claude”时，
Agent 仍可能把它理解成普通终端操作，而不是当前 Tab 内的 AgentMux 分屏。

## 目标

- 启动 Agent 时，可以自动附带一段很短的 AgentMux 运行环境说明。
- 说明只告诉 Agent 何时读取完整 Skill，不把整份 Skill 塞进每次启动内容。
- 每个 Agent Profile 都有开关；内置 Profile 默认开启，用户可以关闭。
- 用户原本输入的任务保持独立、清楚，不和运行环境说明混成一句话。

## 启动内容

开启后，Core 把现有启动输入整理成两个明确部分：

```text
AgentMux runtime guide:
You are running inside AgentMux. For requests involving tabs, splits, directions,
or other agents, run "$AGENTMUX_CLI" --skill before acting.

User request:
<用户原本输入的内容；没有内容时明确写等待用户>
```

这不是让 App 猜用户想开 Split 还是 Tab。Agent 读完 Skill 后仍按已经确认的规则判断：
同一件事或明确方向默认在当前 Tab 内分屏；只有用户明确要求 Tab 才新建 Tab；明确是
另一件事时先询问用户。当前 Tab 已有多个 Region 时，Agent 还必须先读 `agentmux inspect --tab self`
返回的空间地图，再选择精确 Region；“左边”指整张 Tab 的左侧，不总是“在自己左边再切一刀”。

## 分层

- Desktop Config v5 只保存每个 Agent Profile 的开关，并把开关连同启动数据交给 Core。
- Core 统一组装运行环境说明和用户任务，再交给既有 Provider 启动合同。
- Provider 继续只负责各 Agent 的参数格式，不各自保存一份 AgentMux 文案。
- Control SSOT 是唯一正式规则真相；CLI Skill 是同版本的可执行投影，简短指南只负责让 Agent 发现它。

## 不做

- 不拦截或改写 Agent 收到的普通对话。
- 不让 Renderer 拼 Provider 参数或直接管理 Agent 进程。
- 不自动操作 UI，也不把布局状态放进 Core 或 ctxmux。
- 不为不同 Agent 复制多份含义相同的指南。

## 验收

- 开关开启时，Codex、Claude、Cursor 等所有既有 Provider 都收到同一份结构化指南。
- 开关关闭时，启动内容和现在一致，不出现指南。
- 用户任务只出现一次；空任务会明确要求 Agent 等待用户。
- `在右边打开 Claude` 所需的最终规则仍来自 `agentmux --skill`，Claude 仍由 Desktop
  中配置的 Profile 启动。
- 三块不对称布局中，Agent 能从 `inspect --tab self` 的 Region bounds 判断哪块占据左侧，
  并用 `--above/--below <region-id>` 把它上下分成 2×2，而不是永远切自己的 Region。
- 设置、Core 启动合同和自动化测试使用同一个开关，不存在第二套默认值。
