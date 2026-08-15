# f-2358f2swt 许可证义务判定（T-007）

日期：2026-08-29
判定者：主 session
结论：**未移植参考项目的实质代码，无需在 `THIRD_PARTY_NOTICES.md` 新增条目。**

## 判定依据

T-007 验收要求：若实现移植了参考项目的实质代码，必须按既有条目格式登记
（git-handler 相关）；若只借鉴机制、从零按 AgentMux 结构重写，则记录该判断依据。

### 1. 代码里没有参考项目的痕迹

对本 Feature 的全部实现文件 grep `refproj` / `refpeer` / `traexon` / `deepseek` /
`refhrd` / `refmsh`：

- `apps/desktop/src/main/git-service.ts`
- `apps/desktop/src/main/gh-service.ts`
- `apps/desktop/src/main/pr-fields.ts`
- `apps/desktop/src/renderer/src/lib/pr-eligibility.ts`

**零命中。** 设计文档 `docs/design/*.md` 同样零命中。

### 2. 实现形态是 AgentMux 自己的结构，不是移植

判断"是否移植"不能只看有没有署名，要看结构是否是对方的：

- 所有 git 调用走 **AgentMux 自己的 `ExecutionHost.run('git', argv)` 注入缝**
  （与 WorktreeService 同一条子进程缝），不是任何外部库或移植来的 spawn 层。
  这是本项目既有的分层决定，早于本 Feature。
- 三层接线（`contracts.ts` 判别联合 → `preload` → `ipc.ts` handler）是
  **本仓库既有的 IPC 范式**，Git 面只是又一次套用它。
- 解析走 `--porcelain=v1 -z`，结构化 diff 走**读 blob** 而非解析 unified-diff 文本；
  这些是对着 git 自身文档做的选择，不是抄某个实现。
- `scrubGitCredentials`、`assertSafeRef`、`assertInWorktree` 是为本项目的
  安全不变量新写的纯函数，各自有对应断言。

### 3. 与已登记条目的对比

`THIRD_PARTY_NOTICES.md` 现有唯一条目（Refproj Browser screenshot markup）登记的是
**确有改编**的情形：drawing model、Canvas renderer、PNG composition 等
逐块改写自对方某个 commit。那是真正需要署名的形态。

Git 这条不属于同类：ideas 里对该能力的记载只提供了"应该有源码控制与 PR 管理"
这一**方向**，实现路径、分层、argv 硬化规则、凭据擦除策略均为本仓库自行决定。

## 处置

不新增 `THIRD_PARTY_NOTICES.md` 条目。本文件即为该判断的记录，
以便日后审查可追溯"为什么没登记"。

若将来有人确实从参考项目移植了 git-handler 的实质代码，须按上述既有条目格式补登。
