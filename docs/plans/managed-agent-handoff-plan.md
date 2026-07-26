# Managed Agent Handoff and Conversation Entry

## 规划边界

这个 Feature 只承接人触发的、受管 Agent 可发现并可精确寻址的
Discussion/Handoff/Fork 入口。它不把完整 autonomous A2A、Inbox ledger、coordinator
loop 或跨主机 Remote transport 偷渡进来；那些能力只有在产品决策明确后才另立
Feature。

已有 P0 核心竖切（`T-019-p0-core-slice.md`）证明了 capability、author、单向
Delivery 与幂等的底座，但 CLI、Desktop 投影、重启集成证据仍未交付。因此已实现
部分在本 Feature 中以“准备并核验”任务出现，不伪装成全部完成。

## 拓扑

```text
H-001  准备并核验 Discussion 核心竖切
  ├── H-002  准备并核验 Session/Region/View 精确地址合同
  ├── H-003  准备 AgentMux context/preflight 自发现
  │     └── H-004  补齐 send receipt 与失败恢复命令
  └── H-005  实现对话消息 Fork/Handoff，并继承 Topic/Workspace
        └── H-006  验证重启、权限、失败与 Topic 投影

H-007  等待决策：是否引入完整 autonomous A2A/Inbox（独立等待卡点）
```

H-001/H-002 是准备与核验，不等于宣称 P0 已完成；H-007 不阻塞人触发的
Handoff/Fork 路径。H-003、H-004、H-005 可在 H-001 后并行，H-006 是收口集成验证。

## 现有证据与剩余风险

- `T-019-p0-core-slice.md`：核心通信模块和安全不变量已有变异验证，缺 CLI、Inbox
  投影与重启端到端证据。
- `docs/plans/agent-communication.md`：消息证据等级、权限、幂等和非目标是上游约束；
  不得把 Terminal output 或模型服从性当作 reply。
- `docs/design/agentmux-desktop-interaction.md` 与现有 Region/Topic 解析代码：
  地址与上下文必须复用已有 owner，不另造第二份身份解析。
- 所有交付任务必须包含可执行 command gate；artifact 只补充语义证据。

