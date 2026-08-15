# fan-out 不再在用户仓库里留下未忽略的 .worktrees

Contract: `bagakit.feature-goal.v1`
Feature: `f-25f8ffrme`

## 状态：已落地（2026-09-14 逐条核对）

**这份 Feature 停在 `proposal`、`tasks: []`，但它要的行为已经在生产代码里，并有真 git 用例守着。**
照着原文再做一遍，等于重写一个已经在跑的机制。本文档的作用就是挡住那次重写。

落点：`apps/desktop/src/main/worktree-service.ts` 的 `excludeWorktreeRootFromStatus()`，
由 `createForBranch` 在 git 创建成功之后调用。

判别命令（问 git，不问工作区——文件在本机磁盘上恒在，那证明不了它入了库）：

| 原文要的东西 | 判别命令 |
| --- | --- |
| 建 worktree 后用户仓的 `git status` 不因它变脏 | `git grep -n excludeWorktreeRootFromStatus HEAD -- apps/desktop/src` |
| 有真 git 判据，不是只断言"我们发了那条命令" | `git grep -n "'status', '--porcelain'" HEAD -- apps/desktop/test/worktree-service.test.ts` |
| lane 落在仓库根下，与 exclude 的锚定对齐 | `git grep -n "join(branches.repoPath, '.worktrees')" HEAD -- apps/desktop/src` |

第二条最初写的是 `git grep -n "git status --porcelain" …`，**它一条都匹配不到**：测试是按实参数组调
git（`['-C', repoPath, 'status', '--porcelain']`），那个空格分隔的字面量根本不存在。照着跑的人会
得出与本文档相反的结论——"没有真 git 判据"。判别命令自己必须先跑一遍，否则这份文档在它最该被
相信的地方骗人。

测试：`pnpm exec vitest run apps/desktop/test/worktree-service.test.ts` → **Test Files 1 passed,
Tests 40 passed**。

> 一处措辞更正，留在这里因为它写进过提交信息（不可改）：36c2991c 的 Follow-up 把四个待补
> stop-doc 的 Feature 记作 `f-25s, f-23z8, f-24k, f-2548`，其中 `f-25s`（= `f-25s8fqvvr`，
> Agent 原生浏览器调试）**没有入库**——它只在本机磁盘上，`git ls-tree HEAD` 查不到。只读提交历史
> 的人找不到它。另外三个是真的：`f-23z8fgsw3`、`f-24k8ftgmm`、`f-2548fr8qc`。

## 原文列的三个待决策项，各自的答案

1. **「写 .gitignore 是不是正确的动作？还是把 worktree 放到仓外？」——两个都没选，走
   `.git/info/exclude`。**
   `.gitignore` 是用户**已跟踪**的文件：写进去会出现在他即将提交的 diff 里、传给同事、和他自己的
   内容冲突。而把 worktree 挪到仓外（`~/.agentmux/worktrees/...`）会丢掉"在仓内"的那些好处
   （见 workspace-projects.ts：仓外的目录落在项目的忽略规则、移动和文件树之外）。
   `info/exclude` 是 per-clone、不跟踪的，正是 git 给"我的工具生成了这个目录，仓库不必关心"
   准备的答案——**本仓自己早就用它来挡 `ideas/`**，所以这是既有惯例，不是新发明。

2. **「若写 exclude：必须幂等、必须处理文件不存在 / 末尾无换行 / 被别的模式覆盖」——四种都处理了。**
   - 幂等：`grep -qxF` 先查在不在，跑两次只有一行。
   - 文件不存在：`mkdir -p "$(dirname …)"`，随后 `>>` 自建。
   - **末尾无换行：这一条最初写漏了，2026-09-14 补上。** 裸 `>>` 会把新行**粘**在最后一行后面，
     `notes.txt` + `/.worktrees/` 变成一条 `notes.txt/.worktrees/`——**两条规则同时失效**，
     用户自己的忽略项也被吃掉，而 git 不报任何错。现在先探 `tail -c 1`，需要时补一个换行。
     这一条有专门的真 git 用例（「已有的 exclude 末尾没有换行时…」），它在修复前确实是红的。
   - 被别的模式覆盖：判据不查文件内容，直接跑 `git status --porcelain` 问 git 自己。

3. **「手工建单个 worktree 的路径由用户在 BranchesPanel 自己填，别让两边各长一套规则」——
   排除只写一处，但根一度**没有**统一，2026-09-14 补齐。**
   排除写在 `createForBranch` 里，fan-out 和手工创建都经过它，这一半从一开始就是对的。
   但**根**当时是两处各拼各的：手工侧 `defaultWorktreePath(repoPath, …)` 拼在仓根，
   fan-out 侧 `fanout-request.ts` 拼的是 `workspace.path`。两者在多数 workspace 上是同一个字符串，
   所以分岔不可见——直到文件树的「Open as Project」把仓库的一个**子目录**注册成 workspace：
   lane 落到 `<repo>/sub/.worktrees/`，而锚定在仓根的 `/.worktrees/` 盖不住它，仓根
   `git status --porcelain` 照旧吐 `?? sub/.worktrees/`。**本 Feature 对最需要它的那类 workspace
   恰好静默失效。** 现在 fan-out 也从 `branches.repoPath` 取根，两侧同落仓根。
   判据：`git grep -n "join(branches.repoPath, '.worktrees')" HEAD -- apps/desktop/src`。

## 既定决策

- **锚定 + 尾斜杠：写的是 `/.worktrees/`，不是 `.worktrees`。** 不锚定的那种写法同样能让
  "status 干净"这条断言变绿，却会把用户在任意深度自己建的同名文件一并吞掉——**那是把用户的
  东西弄丢，比留点噪音严重得多**。测试里专门建了一个 `docs/.worktrees` 来钉住这一点
  （变异体活过了第一版测试，加了这个用例才被杀掉）。
  这条锚定也决定了子目录那一档的修法方向：**目录去就规则，不是规则去就目录**（见上面第 3 条）。
- **写失败绝不让创建失败。** 用户要的是 worktree，他拿到了；因为一次便利写入没成功就把它判成
  失败，是把用户真正要的那件事拿走（原则 11 class 2：我方这一步降级了，能力本身好好的）。
  只读的 `.git`、写不进去的 host，结果只是"噪音照旧"，不是"建不出来"。
- **`--git-common-dir` 而不是 `--git-dir`。** 从一个 worktree 里再建 worktree 时，必须写进
  那**唯一**一份共享 exclude，而不是链接工作树自己的私有 git 目录——写那儿没人读。
- **路径和内容作为 `sh` 的实参传，绝不拼进脚本文本。** 带引号或空格的仓库路径因此不可能变成
  shell 语法。

## 边界

这个 Feature 只管**建 worktree 之后仓库的卫生**。"worktree 该放哪"（仓内 vs 仓外）由
workspace-projects 那一侧裁决，本 Feature 不参与；"删除 worktree 时怎么判脏"也另有归属
（见 worktree-service 的 removal 那一段）。
