import { join } from 'node:path'
import type {
  AppConfig,
  RunFanOutInput,
  RunFanOutResult,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../shared/contracts.js'
import { planFanOut } from './fanout-plan.js'
import { runFanOut, type FanOutPorts } from './fanout-run.js'

/**
 * 从一次 IPC 请求走到扇出结果：认领 workspace、要分支清单、过 planFanOut、跑 runFanOut。
 *
 * 这一整段此前长在 `registerIpc` 内部的 handler 里，而它唯一的守卫是 fanout-wiring.test.ts 的
 * `readFileSync` + `toContain('runFanOut(')` 一族。文本断言看不见这一段有没有被执行到：在
 * handler 第一行插一句 `return { kind: 'rejected', reason: ... }`，planFanOut / runFanOut /
 * 整段编排全部变成死代码、扇出对用户**永久返回 rejected**，而 5 条断言全绿（实测；死代码里
 * 那些标识符照旧存在）。handler 长在 registerIpc 的闭包里，本仓没有任何测试 import 得到它。
 *
 * 所以编排搬到这里，用注入的 ports 表达它对外界的全部需求。handler 那侧退化成一个转发表达式，
 * 连插一句早退的语句位置都不剩（同 terminalInputSender / moveSessionViewMenu 的收法）。
 *
 * 命名仍然只有 planFanOut 一个来源：分支名与 worktree 路径在别处不许再拼一份，否则同一个请求
 * 重跑两次会得到两套名字。
 */
export type FanOutRequestPorts = {
  /** 当前 config——它在 handler 那侧是可变的，所以按需取而不是传快照。 */
  config(): AppConfig
  listBranches(workspaceId: string, config: AppConfig): Promise<WorkspaceBranchesSnapshot>
  /**
   * lane 级 ports，按**已解析的源 workspace** 构造。
   *
   * 传工厂而不是现成的对象：启动 Agent 要用源仓库的 hostId，而"哪个 workspace"这件事只在这里
   * 判一次。让 handler 自己再查一遍就等于同一个概念两处判定，两处的失败文案还会不一样。
   */
  lanes(workspace: WorkspaceRecord): FanOutPorts
  /** 成功的 lane 会注册 worktree，config 因此前进——回写由调用方负责。 */
  commitConfig(config: AppConfig): void
}

export async function runFanOutRequest(
  input: RunFanOutInput,
  ports: FanOutRequestPorts
): Promise<RunFanOutResult> {
  const config = ports.config()
  const workspace = config.workspaces.find((item) => item.id === input.workspaceId)
  if (!workspace) throw new Error('Fan-out needs an existing workspace')
  const branches = await ports.listBranches(input.workspaceId, config)
  if (branches.kind !== 'git-repository') {
    return { kind: 'rejected', reason: 'A fan-out needs a git repository.' }
  }  const plan = planFanOut({
    count: input.count,
    baseName: input.baseName,
    // 仓库根，不是 `workspace.path`。两者在多数 workspace 上是同一个字符串，所以取错不会当场出事——
    // 但文件树的「Open as Project」会把仓库里的一个子目录注册成 workspace（open-directory-as-project
    // 用 joinWorkspacePath 往下拼），此时两者分岔：lane 会落到 `<repo>/sub/.worktrees/`，而
    // worktree-service 写进 `info/exclude` 的 `/.worktrees/` 是**锚定**在仓根的，盖不住深一层的那个
    // 目录（真 git 验过：仓根的 `git status --porcelain` 照旧吐 `?? sub/.worktrees/`）。于是「扇出不
    // 再弄脏用户的 git status」这件事，恰恰对最需要它的那类 workspace 静默失效。
    //
    // 反过来把锚定那一侧放宽成通配不行：不锚定的规则会连用户自己在任意深度建的同名目录一起吞掉，
    // 那是把用户的东西弄丢，比留点噪音严重得多。所以是目录去就规则，不是规则去就目录。
    worktreeRoot: join(branches.repoPath, '.worktrees'),
    executorIds: input.executorIds,
    existingBranches: branches.branches.map((branch) => branch.name),
    existingWorktreePaths: branches.branches.flatMap((branch) =>
      branch.worktreePath ? [branch.worktreePath] : []
    )
  })
  // 被拒的计划原样返回，不吞掉理由；单 lane 也原样交还——一条 lane 不是 bake-off，它属于普通
  // 启动路径，不该为"和空无一物比较"付出编排代价。
  if (plan.kind !== 'fanout') return plan
  // 每条 lane 各自取当前 config、各自立刻回写，而不是开头快照一份、末尾整份盖回去。理由见
  // runFanOut 的「Why each lane re-reads the config」那段：扇出是长操作，期间主进程照常接别的 IPC，
  // 整份回写会把中途别人写进去的东西静默抹掉（fanout-config-lost-update.test.ts 真跑出来过）。
  const result = await runFanOut({
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    lanes: plan.lanes,
    readConfig: () => ports.config(),
    commitConfig: (next) => ports.commitConfig(next),
    ports: ports.lanes(workspace)
  })
  return { kind: 'fanout', lanes: result.lanes }
}
