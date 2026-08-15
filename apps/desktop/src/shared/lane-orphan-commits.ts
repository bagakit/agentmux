/**
 * 一条 lane 分支上，有没有只存在于它自己身上的提交。
 *
 * 这是「移除这个 worktree，用户会不会失联一份产出」唯一诚实的问法。移除 worktree **不删分支**
 * （真 git 验过：`git worktree remove` 之后 `git rev-parse` 仍给得出 sha，`git branch` 里也还在），
 * 所以提交不会丢；但那条分支会从产品叙事里消失——记录撤下、行没了，用户得自己敲 git 才找得回来。
 * **找得回 ≠ 会去找。**
 *
 * ## 为什么不用现成的 `aheadBehind`
 *
 * `git-service.ts` 已有 `aheadBehind`，看起来正好。它不行，而且是**恰好在最危险的那一档上**不行：
 * 它先解析 `@{push}`、再退回 `@{upstream}`，两个都解析不出时返回 `{ upstream: null, ahead: 0 }`。
 * 而 fan-out 新建的 lane 分支**常态就是没有 upstream**——于是最该提示的那种分支，ahead 恰好是 0。
 * 照它判，守卫会对自己最该守的东西沉默。
 *
 * ## 判据取的是「除了它自己，还有谁够得着这些提交」
 *
 * 形如 `git rev-list --count <lane> --not <base> --remotes`：从 lane 可达、而从 base 和任何远端
 * 都不可达的提交数。五种形态实测（一次性 repo，事后删除）：
 *
 * | 形态 | 期望 | 实测 |
 * | --- | --- | --- |
 * | 有未推送提交、无 upstream | 提示 | 1 |
 * | 已并进 base | 不提示 | 0 |
 * | 已推到远端 | 不提示 | 0 |
 * | 自己没有提交 | 不提示 | 0 |
 * | **两条 lane 指向同一批提交** | **两条都提示** | **两条都是 1** |
 *
 * 最后一行是这套写法存在的理由。我先写的是「排除自己之外的**所有分支**」
 * （`--not $(其余每条 refs/heads) --remotes`），它在前四种上全对，第五种上**两条 lane 互相遮蔽**、
 * 双双读 0：两条都指着那批提交，于是对彼此而言"另有人够得着"。而 bake-off 正是同时开好几条 lane 的
 * 玩法，互相遮蔽等于在它最常见的场景下全盘失明。给定一个**明确的 base** 就没有这个洞——兄弟 lane
 * 不在 `--not` 里。
 *
 * 还有一个更隐蔽的坑：`--exclude=<name>` 的 glob 是相对 `refs/heads/` 解析的，写成
 * `--exclude=refs/heads/x` 会**一条都排不掉**且不报错，于是所有形态一律读 0——一个恒真的守卫。
 * 本函数因此完全不依赖 `--exclude`。
 *
 * ## base 必须是传进来的，不许在这里猜
 *
 * 猜 `main` 的代价是不对称的：猜错成"存在的别的分支"会静默少报（用户以为安全，其实会失联），
 * 猜错成"不存在的名字"会让 git 直接 fatal。仓里已经有一个会回答这件事、并且**如实标注答案来不来自
 * 权威**的地方（`gh-service.ts` 的 `resolveBaseRef`：`origin/HEAD` 才是真答案，缺席是常态，退路必须
 * 被标成猜测）。同一个概念不在这里长第二套判定。
 *
 * ## 为什么在 `shared/` 而不在 `renderer/src/lib/`
 *
 * 这件事有两个落点，分属两侧：**跑 git** 只能在 main（renderer 是沙箱，没有 node 内置模块，也没有
 * 进程），而**那句话给谁看**在 renderer。所以它既不属于任何一侧，只能是共享的纯函数——`shared/` 里
 * 的 `fanout-naming.ts` / `fanout-limits.ts` 是同一个形状。本仓 main **从不** import
 * `renderer/src/lib/`（`grep -rl "renderer/src/lib/" apps/desktop/src/main/` 为空），所以放在那边
 * 等于让接线时被迫再抄一份判据出来——那正是这个模块要避免的事。
 */

/** 构造那条 rev-list 的实参。调用方自己跑 git——本模块不碰进程，好让它能被纯函数地测。 */
export function orphanCommitCountArgs(input: {
  repoPath: string
  branch: string
  baseRef: string
}): string[] {
  // `--not <base> --remotes`：base 与任何远端可达的都不算。`--` 终止选项，否则以 `-` 开头的分支名
  // 会被当成开关（本仓在 `worktree add` 上栽过同一个坑）。
  return [
    '-C',
    input.repoPath,
    'rev-list',
    '--count',
    input.branch,
    '--not',
    input.baseRef,
    '--remotes',
    '--'
  ]
}

/**
 * rev-list 的输出转成条数。
 *
 * **读不懂一律当 null，绝不当 0。** 这两者在产品上是相反的意思：0 是"查过了，没有独有提交，删得
 * 放心"，null 是"没查出来"。把查不出来说成 0，就是在用户最需要警告的时候给他一句安心话——而
 * git 失败最可能的原因（base 名字不存在、仓不可达）恰恰伴随着仓库状态本身不正常。
 */
export function parseOrphanCommitCount(stdout: string, exitCode: number): number | null {
  if (exitCode !== 0) return null
  const value = Number.parseInt(stdout.trim(), 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 确认框里那句关于分支的话。
 *
 * 三种状态三句话，**没有共用实词**——本仓的教训是措辞近似会吃掉分类（见 worktree-removal-request
 * 顶部）。这里尤其要紧：三句话说的是三件事，而用户只会读一遍。
 *
 * - `null`（没查出来）：不假装知道。不说"安全"，也不说"有风险"，只说没查到——用户至少知道这一条
 *   信息缺席，而不是把沉默读成"没问题"。
 * - `0`：如实说分支留着、内容在别处也有。这是原来那句话，它对这一档一直是对的。
 * - `>0`：说清**数量**和**分支名**。数量把"有点东西"变成可判断的量；分支名是用户事后唯一的抓手，
 *   因为记录撤下之后，产品里再没有别的地方会提到它。
 */
export function branchRetentionNote(branch: string, orphanCommits: number | null): string {
  if (orphanCommits === null) {
    return `Branch ${branch} stays in the repository. Whether it holds work that exists nowhere else could not be checked.`
  }
  if (orphanCommits === 0) {
    return `Branch ${branch} stays in the repository, and its commits are already reachable elsewhere.`
  }
  const commits = orphanCommits === 1 ? '1 commit' : `${orphanCommits} commits`
  return `Branch ${branch} keeps ${commits} that exist nowhere else — not on any remote, not on the base branch. Removing this checkout leaves them reachable only by name.`
}
