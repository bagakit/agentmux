# Plan Review r1 — Git Source Control and Pull Requests (f-2358f2swt)

Meta: 本文件是 `f-2358f2swt` reviewed task plan (revision 1) 的评审依据。
调研与计划草案由一位调研 Agent 产出（`.tmp/git-feature-research.md`，218 行，含 20 条 refproj 踩坑清单）；
本文件是接手本轮 goal 的 Agent（`agentmux-1d`）对该草案的审阅结论。
**这不是对实现的独立审查** —— 计划的 T-007 要求交付前必须经一位未参与实现的独立 Reviewer 审查，那一道关不由本文件代替。

## 用户原始诉求（逐字）

> 需求: Git 源码控制, PR 等管理, 可以先从 /Users/bytedance/proj/github/refproj 抄一个版本

## 解读

"抄一个版本"给了明确授权去借鉴 refproj，而不是从零发明。这与项目原则「先看成熟产品怎么解决同一个问题，
用已验证的模式」一致。审阅时我关注的不是"抄得像不像"，而是**有没有把 refproj 踩过的坑一并继承过来** ——
那才是参考一个成熟实现的真正价值。

## 许可证（已核实）

refproj 是 **MIT**（`/Users/bytedance/proj/github/refproj/LICENSE`，Copyright 2026 Lovecast Inc.），
因此可以借鉴乃至移植代码，义务是署名。计划的 T-007 已含 `THIRD_PARTY_NOTICES.md` 登记。

同时保留项目既有纪律：**参考项目不写进 AgentMux 的代码注释或设计文档**。
`THIRD_PARTY_NOTICES.md` 是许可证义务，属于该纪律的例外。

## 审阅结论：同意采纳，理由如下

**1. 分层判断正确，且有证据而非偏好。**
Git/PR 落 `apps/desktop/src/main`，不进 `packages/core`。三处独立证据：`AGENTS.md:11` 禁止 core 依赖
Electron/React；`AGENTS.md:7-9` 界定 core 域是 agent-runtime；三份设计文档已把 Git 归给 Desktop Main
（`docs/design/agentmux-desktop-interaction.md:146`、`docs/plans/mux-runtime-decision.md:68`、
`docs/plans/agentmux-core-maturity-review.md:23`）。先例 `WorktreeService` 已在 main。
core 侧只复用子进程缝（`ExecutionHost.run`），git 域逻辑不下沉 —— 这条守住了 Level A/B 边界。

**2. 依赖选择是最低熵的。**
锁文件 grep 证实仓库里没有 simple-git / isomorphic-git / dugite / nodegit / @octokit，GitHub 从未被联系过。
在这个前提下 shell out 系统 `git`/`gh` 是零新增依赖、与既有 `WorktreeService` 同构的路。
符合原则 5/6（先翻已有依赖再考虑加包）。
PR 走 `gh` CLI 而非 octokit 的附带收益：认证完全委托 `gh auth`，AgentMux 不存 token，零新增鉴权面。

**3. 最小竖切定义正确。**
T-001 = 看到改动 → stage 一个文件 → commit。它端到端贯穿 renderer / IPC / main GitService / core 缝 /
纯解析器，**交付即可用**，不是"搭框架"。这正是原则「先跑通一个最小的端到端版本」要的形状。

**4. 依赖图有真实并行，不是伪线性。**
T-002 与 T-003 都只依赖 T-001；T-005 只依赖 T-002，与 T-004 可并行。没有为了排顺序而加的边。

**5. 最该照抄的结构被识别出来了。**
refproj 的 `GitExec` 回调模式：解析、ref 运算、错误归一化全是接受一个执行器的纯函数，用 fake 执行器单测、
绝不碰 `child_process`。它正好落在 `ExecutionHost.run` 缝上，可直接借鉴。

## 从 refproj 继承的关键坑（已写进对应 task 的 acceptance）

| 坑 | 影响 | 落在 |
|---|---|---|
| intent-switch run-token | 做错会把 PR 建到错分支 | T-006 |
| 凭据擦除 + argv 硬化（`--` 终结、`:(literal)`、拒 `-` 前缀） | 从第一个 task 起就得立规矩，不能后补 | T-001 起 |
| 后端 preflight 终裁 + 失败保留 composer + 不擅自 merge | 决定 PR 创建的信任模型 | T-006 |
| 别信 exit code + 不自动解冲突 | 决定 status/diff 健壮性；冲突交给 agent 而非自动合并 | T-002 |
| 非交互 env（锁 locale、BatchMode、凭据守卫） | 无人值守下不挂死 | T-003 |

## 我提出的保留意见（不阻塞采纳，但实现时要守）

- **T-005 的 PR 正文生成必须是纯函数 + 严格 JSON 解析，带 DoS 守卫**。它要处理的是模型输出，
  即不可信输入；解析器宽容一寸，就多一寸注入面。
- **冲突取向要显式写进设计 SSOT**：v1 不自动解冲突，把冲突交给 Agent 处理。
  这是产品取向而非能力缺失，不写清会被后人当作待补的坑。
- **`gh` 缺失/未认证必须是可读的资格阶梯**，不是一个失败的按钮。这与今晚另一个 feature
  （`f-2338fu3ws` 诚实的安装状态）是同一条诚实性原则，实现时应保持措辞一致。
