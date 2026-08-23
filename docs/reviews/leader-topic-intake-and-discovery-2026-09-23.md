# Leader Topic Demand / Idea intake and global discovery review

日期：2026-09-23

## 用户确认的目标

- Board 的 `New Demand` 不让人先填空白卡，而是直接把 Leader Topic 浮窗打开到中央，注入本次 Demand 的上下文提示，让 Leader Topic Agent 先和人聊天澄清。
- Ideas 的 `New Idea` 使用同一条入口：先在 Leader Topic 对话里形成 Idea，再由用户确认是否写成 Idea 或 Demand。
- Leader Topic Agent 可以通过 `agentmux` CLI 查询当前所有 Project/Workspace、项目中的活跃 Agent/Session，以及 Provider/Executor、Run 状态、最近活动和 Demand/Idea 关联。

## 保护边界

- Leader Topic 仍是固定的 `launcher:leader` Topic，不创建第二个聊天产品或第二个 Runtime。
- New Demand / New Idea 只创建对话上下文，不自动产生空 Demand；写入必须由 Agent 通过公开 API 完成，并保留 receipt。
- 全局发现默认返回摘要、稳定 ID、来源和观察时间；完整 transcript 只能按权限按需下钻。
- Core/ctxmux 继续拥有 Agent、Session、Run、PTY 和 ordered bytes 事实；Demand 包拥有 Demand 文件事实；CLI 不复制任一事实源。

## 决定

状态：approved。

本需求与现有 `Filesystem Demand package and Leader Topic CLI` Feature 属于同一 Closure：它补齐 Leader Topic 的入口编排和 CLI 只读发现面，作为该 Feature 的后续任务加入，不创建并行 Feature。
