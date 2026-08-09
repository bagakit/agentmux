# Git 源码控制 + PR 管理 — 调研档

> 给 team-lead 的调研档。三份细节笔记（含完整 argv 表与逐条 `file:line`）在同目录：
> `a mature workbench-git-handler-notes.md`、`a mature workbench-pr-notes.md`、`agentmux-git-state-notes.md`。本文是综合与判断。
>
> **纪律**：a mature workbench 是 MIT（`/Users/bytedance/proj/github/a mature workbench/LICENSE` 已核实，commit `afd76a4df9`），
> 机制可借鉴甚至移植代码，但（1）若移植实质代码须在 `THIRD_PARTY_NOTICES.md` 登记（见文末）；
> （2）a mature workbench 之名**不进** AgentMux 代码注释或设计文档 —— 所以下面的 `git-feature-tasks.json` 里
> 所有机制都用 AgentMux 自己的语言写成"要求"，a mature workbench 的出处只留在本 `.tmp/` 档里。

---

## 1. 结论先行（TL;DR）

- **落层**：Git + PR 属于 **`apps/desktop/src/main`**，新建 `GitService` 与 `WorktreeService` 并肩，
  复用 core 的 `ExecutionHost.run('git'|'gh', argv)` 子进程缝。**不进 `packages/core`** —— AGENTS.md 明令
  core 不依赖 Electron/React 且只管 agent-runtime；三处设计文档已把 Git 归给 Desktop Main。
- **PR 走 `gh` CLI**，不是 octokit：`gh pr create --repo --base --title --body-file [--head] [--draft]`，
  非交互、60s 超时、**写操作不重试**（防重复建 PR）。认证**完全委托 `gh auth`**，AgentMux 不存 token
  —— 与项目"什么都不出机器"的隐私线天然一致，且零新增鉴权面。
- **最小竖切**：看到当前分支的改动 → stage 一个文件 → commit。一条竖切贯穿 renderer 面板 / IPC /
  main `GitService` / core 缝 / 纯 porcelain 解析器，端到端可测。
- **cupboard 是空的**：仓库里没有 simple-git / isomorphic-git / dugite / nodegit / @octokit（锁文件 grep = 0），
  GitHub 从未被联系过。所以选 **shell out 系统 `git`/`gh`**（零新依赖、与现有 `WorktreeService` 同构）是
  最低熵的路，符合原则 5/6。
- **最该照抄的结构**：a mature workbench 的 `GitExec` 回调模式 —— 所有解析/ref 运算/错误归一化都是接受一个执行器的
  纯函数，用 fake 执行器单测、绝不碰 `child_process`。它正好落在我们 `ExecutionHost.run` 缝上。

---

## 2. AgentMux 现状（FACT，均已核实）

| 事实 | 证据 |
|---|---|
| 唯一 git owner 是 `WorktreeService`（desktop **main**） | `apps/desktop/src/main/worktree-service.ts:47` |
| 它不自己 spawn，走注入的 `ExecutionHost.run('git', argv)` | 构造器 `worktree-service.ts:48-51` |
| 子进程原语在 core：`ExecutionHost`→`LocalExecutionHost.run`→`runProcess`(`child_process.spawn`) | `packages/core/src/execution-host.ts:10,37`；`process-runner.ts:38` |
| 今天的 git 动词只有：`for-each-ref` / `worktree list --porcelain -z` / `worktree add [-b]` / `status --porcelain`(仅空判) / `worktree remove [--force]` / `rev-parse --show-toplevel` | `worktree-service.ts:61,65,150-151,194,208-209,239` |
| **无** add/commit/diff/push/pull/fetch/merge/checkout/log（生产代码） | 全仓 grep 仅命中上表 |
| `status --porcelain` 只用作删 worktree 前的空判，输出被丢弃 | `worktree-service.ts:190-202` |
| Monaco 是整文件编辑、非 diff；无 diff viewer | `apps/desktop/src/renderer/src/monaco.ts:42`；`ideas/index.md:75` |
| Branches 面板只能：开已绑定分支 / 为未绑定分支建 worktree / 复制名与路径 / 刷新 | `BranchesPanel.tsx:85,99-103,112-119`；`BranchContextMenu.tsx:34-43` |
| Fan-out 只用 `createBranch`(=`worktree add -b`) + `removeWorktree` + agent launch，无新 git 动词 | `fanout-run.ts:97,114,131` |
| **无任何 git/GitHub 依赖**（锁文件 grep `simple-git\|isomorphic-git\|dugite\|nodegit\|@octokit` = 0）；GitHub 从未被联系 | `pnpm-lock.yaml`；全仓 grep 唯一命中是无关的 `TerminalView.tsx:275` 注释 |
| 现成可复用：`ExecutionHost.run` 子进程缝（可跑系统 `git`/`gh`）、`zod ^4`（typed 校验）、vitest | `execution-host.ts`；`apps/desktop/package.json:46` |
| ideas index 早已把 GitHub 集成（review/checks/auto-merge/stacked PR）、Diff Viewer、逐行批注标为"无"，并点明鉴权面巨大、diff 是"新 owner + 新 IPC + 新 surface" | `ideas/index.md:74-77,333`；fan-out v1 有意不含 diff/合并胜者 `:63` |

**三层 IPC 模板（照抄这条线）**：
`ipc.ts` 里 `handle('workspaces:...')`（helper `:130`，`WorktreeService` 装配 `:99`）
→ `preload/index.ts:45-49` 的 `ipcRenderer.invoke`
→ `shared/contracts.ts:482-486` 的 typed `AgentMuxPreloadApi.workspaces`，结果用判别联合（如
`WorkspaceBranchesSnapshot` `:186`：`git-repository` | `not-a-git-repository`）。新 `git:*` 面照此加。

---

## 3. a mature workbench 机制摘要（机制参考，出处见细节笔记）

### 3.1 Git 能力边界（`git-handler.ts:208-272` 注册表）
实现了：status(`--porcelain=v2 --branch --untracked-files=all`)、stage/unstage(±bulk)、commit、
branch list/checkout/rename、**受保护的** force-delete、push(`--force-with-lease`/`--set-upstream`)、
pull、fast-forward(`--ff-only`)、rebase-from-base(`pull --rebase`)、fetch(`--prune`)、
fetch 远程跟踪/PR/MR head、fork sync、ahead/behind、**结构化 diff**（非 unified 文本）、
branch/commit compare、history、discard(`restore`/`clean`)、conflict 探测、submodule diff、
worktree、clone、isGitRepo、白名单 `git.exec`。

**缺口（对我们有意义）**：无 `git stash` RPC；无独立 create-branch（建分支搭在 `worktree add -b` 上）；
无 accept-ours/theirs / `--continue`（冲突*完成*交给 agent，只有 `merge/rebase --abort`）；
diff 返回结构化对象不是 unified 文本。

### 3.2 调用方式
- shell out `git` 二进制（`execFile`/`spawn`），**argv 数组、绝不拼 shell 串** → 无 shell 注入；
  flag 注入靠 `-`-前缀拒绝 + `--` 终结符 + `:(literal)` pathspec 挡住。`git-handler.ts:322-351`
- 每次调用注入 env：**锁定英文 UTF-8 locale**（因为按短语/正则解析 git 输出，翻译过的 git 会解析崩）
  + **凭据提示守卫 + `ssh -o BatchMode=yes`**（无人值守 RPC 不能被 OAuth 弹窗挂住）。`relay-command-env.ts:159-186`
- **没有单一最低版本**：探测能力并回退，缓存进 `GitCapabilityCache`（30 分钟重探）。基线约 2.25。

### 3.3 PR 管理
- **GitHub PR = `gh pr create`**（`create-github-pull-request.ts:83-109`）；body 写进临时文件用 `--body-file`
  传（避开参数长度/转义）`:74-94`；runner 非交互、60s、`idempotent:false`（写不重试防重复）`gh-exec-file.ts:100-175`。
- **认证委托 `gh auth`**，只 *探测* `gh auth status`（`hosted-review-creation.ts:66-91`），不存 token；
  `gh` 继承 `process.env` 所以 `GH_TOKEN`/`GITHUB_TOKEN` 自然透传。
- **PR 标题/正文由 LLM/coding-agent 生成**：纯 prompt 构造 + 严格 JSON 解析隔离在
  `pull-request-generation.ts`（strict-JSON 合同 `{base,title,body,draft}` `:84`；正文强制 `## Problem`/`## Solution`
  ELI5 `:92`；链接 issue 文本当**不可信**输入 `:96`；`JSON.parse` **之前**有结构化 DoS 守卫 `:215`，
  手写去 fence 不对模型输出跑正则 `:146-208`）。模型实际由 main 里 spawn 的 CLI agent 跑。
- 也有非 LLM 模板路径（读仓库 PR 模板）`create-github-pull-request.ts:78-82`。

### 3.4 分层（可照搬）
`src/shared` 纯逻辑（prompt/parse/types，被 renderer+main 共享单测）；`src/main` 所有 IO
（git exec、`gh` spawn、网络、LLM spawn），IPC 边界 `ipc/hosted-review.ts:125-164`；
`src/renderer` React/zustand，从不 import main，异步生成用 **request-id 守卫**防陈旧结果落地
（`store/slices/pull-request-generation.ts:97-105`）。

---

## 4. a mature workbench 踩过的坑清单（**最有价值** —— 每条注明 a mature workbench 证据 file:line + 对我们的意义）

> 这些坑要么变成 `git-feature-tasks.json` 里的 acceptance 硬要求，要么变成设计约束。

### 远程同步
1. **非 ff push 要变成可操作提示，且必须先擦掉凭据** —— raw git stderr 里嵌着 `user:token@` 的远程 URL。
   `git-handler.ts:1075-1078`；归一化 `git-remote-error.ts:119-177`；擦凭据 `:21-23`。
   *对我们*：push 失败信息进 UI 前必须 scrub，否则 token 泄进日志/界面。
2. **只有 "no upstream" 该被吞，其余错误一律上浮** —— `fatal:` 前缀 + 已知短语才算 no-upstream，
   否则 hook/进度文本会伪装成 no-upstream 而掩盖鉴权/损坏错误。`git-remote-error.ts:180-191`；测试 `remote-sync.test.ts:489-497`。
3. **ahead/behind 要对*有效*上游算，也要覆盖"上游是本地分支"** —— 分支可能 track `origin/main` 却 push 到
   `origin/<branch>`，有效上游 ≠ 配置上游。测试 `:48-96` + `:98-123`。
4. **fetch 要真的联网** —— 断言 fetch 后 `.git/FETCH_HEAD` 真被写。`:151,181`。防"空操作也能过测"。
5. **分叉分支的 pull（git 2.27+）需要自动 merge 回退**，除非调用方已 pin 策略 —— 主机没有
   `pull.rebase`/`pull.ff` 策略时裸 `git pull` 会硬失败。`git-remote-error.ts:90-105`。
6. **每个远程输入都要防 flag 注入** —— `-` 前缀的 remote/branch/ref 一律拒；ref 必须精确等于
   `refs/remotes/<remote>/<branch>`。`fetchRemoteTrackingRef:924-929`。

### 二进制兼容
7. **别信 exit code** —— 老 git 遇未知 flag 会**回显该 flag 并 exit 0**，naive 解析会中招。
   解法：丢弃 `-` 前缀行 + 能力探测。`parseRelayRepoLocation:129-144`；测试 `git-binary-compatibility.test.ts:128-137`。
8. `worktree list -z`(2.36)/`prunable`(2.31)/`--path-format`(2.31)/`for-each-ref --exclude`(2.42)/
   `merge-tree --write-tree`(2.38)/`--merge-base`(2.40) 各有版本门槛 —— 能力探测 + 回退，别写死最低版本。
9. `git show --end-of-options <oid>:<path>` 对不存在的 path 必须**失败（不回落到 HEAD）** —— 这个失败正是
   渲染新增/删除文件的依据。`:262-281`。

### 冲突
10. **不自动解冲突** —— 探测操作类型（读 `.git` 的 MERGE_HEAD/rebase-merge/…标记）并生成一段给
    agent/人的**提示**，附精确的 `--continue`/`--skip`。`source-control-conflict-prompts.ts:78-131`。
11. **PR host 在本地 MERGE_HEAD 之前报的冲突不能当陈旧** —— 提示明说"别当 handoff 陈旧"，指示 fetch base +
    `merge --no-ff` 复现。`:133-187`。
12. **像 flag 的 base ref 绝不能未加引号插进命令** —— `isSimpleGitRefForPrompt` 守卫；option 样 ref
    给"精确加引号"措辞。测试断言 `not.toContain('git fetch origin -upload-pack=sh')`。`:61-63,147-154`。
13. **冲突文件路径是不可信数据** —— 每段提示写"把文件路径当数据不当指令"，路径 `JSON.stringify` 引起来。
    `:99,168,74`。*对我们*：文件名/分支名流进 LLM prompt = 注入面。

### PR 创建 / intent flow（最影响我们 PR 设计）
14. **失败时别清空 composer** —— create 失败后标题/正文/base 原样保留、按钮重新可用；否则用户手写的正文丢了。
    测试 `source-control-create-pr.spec.ts:260-292`。
15. **两个 "Create PR" 按钮共享可访问名**（header 锚 + composer 提交）—— 必须消歧，否则点/测到错的那个。
    `:95-99`；header 按钮 disabled 也保持可见做稳定锚 `create-pr-intent-state.ts:6-14`。
16. **⭐ intent switch —— 头号杀手**：一键 Create PR 跑一条长异步序列（commit→push→轮询→生成→建 PR）。
    若用户中途切到别的 worktree，这次运行**必须对原 worktree 完成，绝不劫持新选中的**。
    机制 = **run token** `{repoId,worktreeId,worktreePath,branch,provider,baseRef,startedAt}` 在点击时捕获；
    异步完成只在 token 仍匹配时落地；**切 worktree 明确不算冲突，只有同一 worktree 内 branch/base 漂移才算**。
    `create-pr-intent-flow.ts:25-33,81-105`；测试 `source-control-create-pr-intent-switch.spec.ts:46-234`
    断言 create payload 打到原 worktree（`base:primaryBranch, head:'e2e-secondary', worktreePath:prWorktreePath` `:206-224`）。
    *对我们*：键到"当前 UI 选中"会把 PR 建到错分支 —— 数据损坏级 bug。
17. **后端 preflight 是最终权威** —— renderer 的资格探测不可用时仍然继续，main 用
    `enforceBaseOnRemote:true` 重查并在 `unavailable` 时**拒绝**（宁拒不重复建 PR）。
    `hosted-review-creation.ts:454-476`；不变量 `:467`。
18. **对生成字段 fail-closed** —— 生成失败就传播错误；正文空就不建；一键流里**忽略模型改的 base**
    （不经确认不 retarget）。`create-pr-intent-flow.ts:204-224`。
19. **准备分支时绝不擅自 merge** —— `needs_sync` 只对"纯落后"分支 `--ff-only`，真分叉就 `blocked` 停下。`:146-182`。

### 跨领域硬化（值得照搬机制）
20. **argv 不拼 shell** + `--` 终结 + `:(literal)` pathspec + `-`-前缀拒绝，一次封死 shell 与 flag 注入。
21. **每条 worktree 相对路径都过 `assertInWorktree`** 防穿越。`git-handler.ts:651-665`。
22. **每个变更 RPC 前后清读缓存**（in-flight diff/`.gitmodules` 读不会并进陈旧结果）。`:305-320`。
23. **compare-and-swap 删分支**（`update-ref -d <ref> <expectedHead>`）—— 删 workspace 后分支移动过就不会被误毁。
24. **review-head durable ref**（`refs/a mature workbench/pull/<remote>-<hash(url)>/<n>`）解决 `FETCH_HEAD` 竞争 +
    PR 身份混淆（repointed origin 的 #42 不能解析到另一项目的 head）。—— 我们 v1 不做 PR review checkout，暂不需要，
    但**日后要做 PR head fetch 时照此**，别用裸 `FETCH_HEAD`。

---

## 5. 分层建议（判断）

```
renderer (React/zustand)
  └─ SourceControl 面板 / Create-PR composer
     · 纯 UI 状态 + request-id / run-token 守卫（防陈旧 & intent-switch）
     · 只调 window.api.git.* ，从不 import main
        │  IPC (contracts.ts 判别联合 → preload invoke → ipc.ts handle)
        ▼
apps/desktop/src/main
  ├─ GitService        —— git 域逻辑（status/stage/commit/diff/push/pull/fetch/ahead-behind）
  │    · 调 host.run('git', argv)（照 WorktreeService）
  │    · env: 锁 locale + 凭据守卫 + BatchMode（无人值守不挂）
  │    · argv 数组 + -- 终结 + :(literal) + -前缀拒绝
  ├─ GhService / PrService —— gh 域逻辑（auth 探测 / eligibility / pr create）
  └─ 纯模块（用 fake 执行器单测，绝不碰 child_process）：
       git-status-porcelain 解析、diff 构造、pr-fields prompt+JSON 解析(带 DoS 守卫)、
       eligibility 阶梯、run-token 匹配、错误归一化+凭据擦除
        │
        ▼
packages/core   ← 只复用 ExecutionHost.run / process-runner（子进程原语），不加 git 域逻辑
```

**为什么 main 不 core**：`AGENTS.md:11` 禁 core 依赖 Electron/React；core 域是 agent-runtime
（`:7-9`）不含 git；三处设计文档把 Git 归 Desktop Main
（`docs/design/agentmux-desktop-interaction.md:146`、`docs/plans/mux-runtime-decision.md:68`、
`docs/plans/agentmux-core-maturity-review.md:23`）；先例 `WorktreeService` 已在 main。
core 侧唯一被复用的是子进程缝 —— git 域逻辑留在 main，子进程原语留在 core。

---

## 6. Milestone 切分 + 最小竖切（判断）

- **最小可行竖切（T-001）**：**看到当前分支的文件改动 → stage 一个文件 → commit**。
  一条竖切端到端串起 renderer 面板 + IPC + main `GitService.status/stage/commit` + core 缝 +
  纯 porcelain 解析器。不是"搭框架"—— 交付即可用。

- **M1 本地源码控制**：T-001（status/stage/commit 竖切）→ T-002（结构化 diff + unstage + discard）
- **M2 远程同步**：T-003（push/pull/fetch + ahead/behind + 错误归一化/凭据擦除/非交互 env）
- **M3 PR 管理**：T-004（`gh` 探测 + auth 探测 + eligibility 阶梯）、T-005（PR 正文生成：纯 prompt+JSON 解析）、
  T-006（`gh pr create` + run-token intent flow + 失败保留 composer + 后端 preflight 终裁）
- **M4 收口**：T-007（统一门禁 + THIRD_PARTY_NOTICES 登记 + 独立 reviewer + 设计 SSOT）

**直接影响我们设计的坑**（挑最关键的）：
- **#16 intent-switch run-token** —— 决定 PR 状态如何 keying；做错会把 PR 建到错分支。→ 写进 T-006 acceptance。
- **#1 凭据擦除 + #20 argv 硬化** —— 决定 GitService 的边界处理，从 T-001 起就得立规矩。
- **#17 后端 preflight 终裁 + #14 失败保留 composer + #19 不擅自 merge** —— 决定 PR 创建的信任模型。→ T-006。
- **#7 别信 exit code + #10 不自动解冲突** —— 决定 diff/status 的健壮性与冲突的产品取向（交给 agent 而非自动合并）。

---

## 7. THIRD_PARTY_NOTICES 登记（MIT 义务）

`THIRD_PARTY_NOTICES.md` 已有一条 a mature workbench 的登记（Browser 截图标注模型，commit `4fd93ead…`），格式可循。
**判断**：若最终实现是从零按 AgentMux 结构写（大概率如此 —— 我们的缝、类型、IPC 都不同），只借鉴机制，
则 MIT 不强制登记（未复制实质代码）；**若移植了实质代码**（如某个解析器逐行照搬），则**必须**新增一条
a mature workbench 登记（git-handler 相关，commit `afd76a4df9`），照现有条目格式。这一判断落在 T-007 的 acceptance 里。
