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
  }
  const plan = planFanOut({
    count: input.count,
    baseName: input.baseName,
    worktreeRoot: join(workspace.path, '.worktrees'),
    executorIds: input.executorIds,
    existingBranches: branches.branches.map((branch) => branch.name),
    existingWorktreePaths: branches.branches.flatMap((branch) =>
      branch.worktreePath ? [branch.worktreePath] : []
    )
  })
  // 被拒的计划原样返回，不吞掉理由；单 lane 也原样交还——一条 lane 不是 bake-off，它属于普通
  // 启动路径，不该为"和空无一物比较"付出编排代价。
  if (plan.kind !== 'fanout') return plan
  const result = await runFanOut({
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    lanes: plan.lanes,
    config,
    ports: ports.lanes(workspace)
  })
  ports.commitConfig(result.config)
  return { kind: 'fanout', lanes: result.lanes }
}
