# f-22q8f25qd 计划评审

Feature: `f-22q8f25qd` — Parallel Worktree Fan-Out
计划修订: 1 · 评审结论: **approved**
依据: 用户确认账本方案，并要求"都放进 feature 做了，Task 搞细一点"

## 为什么是它

产品前提的逐字版：并行跑多个 coding agent 且不丢追踪。九个候选项评估后，它是唯一被判定
"值得规划"的新工作（对抗复核同意）。

## 已核实的两个真实缺口（我自己打开代码确认，非转述）

1. **无法从 HEAD 起新分支建 worktree**。`worktree-service.ts:137` 是
   `git worktree add -- <path> <branchName>`，**没有 `-b`**；第 130 行还要求分支必须已存在
   （`if (!branch) throw new Error('Unknown branch')`）。而扇出的自然工作流正是"为这次比稿开 N 个
   新分支"——当前做不到。
2. **零拆除能力**。全文件 grep `worktree remove|worktree prune` = **0**。不补则每次扇出泄漏 N 个
   worktree 与 N 条 workspace 记录。

## 已具备的（不重复造）

- worktree 创建/注册事务：`worktree-service.ts:createForBranch`
- 单 Agent 启动：`client.ts:720 createAgent`（单输入）
- Board 的 Branch×状态矩阵与 grid tab：`project-board.ts`、`WorkspaceBoard`
- 全窗口名册与注意力汇总：本轮交付的 `agent-roster.ts` / `AgentStatusBar`

## v1 明确不做

**比稿用 diff、自动合并胜者**。二者需要新的 git-diff owner 与第二套批注模型，评估已判不做（见
ideas 卸载表）。v1 的"比较"= 读 N 条 board 行与 N 个终端；"留胜者"= 在该 worktree 继续，其余拆除。

## 编排放在哪

**Desktop main，不是 Core**。`docs/plans/agent-communication.md:36` 明确 Core 不拥有 coordinator
loop。扇出是把已有单输入 `createAgent` 循环 N 次，属 Desktop 编排，不是新 Core 合同。

## Task 粒度与 gate 约束

按"能独立实现且能独立验证"切成 6 个，T-001 闭合最小端到端路径（从 HEAD 起一个新分支 worktree）。
T-001 ⟂ T-002 可并行。

每个 task 的 gate 都带一条**只有该 task 做完才会绿**的具体断言（指定测试文件），而非仅靠
`pnpm check`——本轮已确认仓库里 11 个开放 task 的 gate 是通用命令，几乎证明不了该 task 特有的事实。
