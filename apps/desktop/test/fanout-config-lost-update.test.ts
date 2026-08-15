import { describe, expect, it } from 'vitest'
import { runFanOutRequest, type FanOutRequestPorts } from '../src/main/fanout-request.js'
import type {
  AppConfig,
  RunFanOutInput,
  WorkspaceBranchesSnapshot,
  WorkspaceRecord
} from '../src/shared/contracts.js'

// ---------------------------------------------------------------------------
// 并发写丢失：一次扇出把它**开始时**看到的那份 config 整个交回去。
//
// 扇出是长操作——每条 lane 都要 `git worktree add` 再起一个 Agent，几秒到几十秒。这段时间里
// 主进程照常接别的 IPC（删一个 worktree、加一个项目、改一处设置），每一个都在同一个
// `config` 闭包变量上读-改-写。扇出原来的做法是开场取一份快照、结束时 `commitConfig` 整份
// 盖回去，于是这中间发生的一切静默消失：记录回来了，目录却已经被删了。
//
// 这不是推理出来的，是这条用例真跑出来的（改回"开场快照 + 末尾整份回写"当场变红）。
//
// ## 这条用例守的是哪一段，以及哪一段还没守
//
// 逐 lane 取当前值、逐 lane 回写，关掉的是**lane 与 lane 之间**那段窗口——扇出里最长的一段，
// 因为它横跨其余每一条 lane 的建树与启动。剩下的是**单条 lane 自己**的"建完到发布"那一小段，
// 它和仓里其它每一个 handler 的形状完全一样（读 config → 干活 → 整份写回），不是扇出特有的。
// 真要关掉它，得让 config 的写入变成单写者 + 版本校验（`ConfigStore.save` 现在用 `saveTail`
// **串行化**了写，但不做合并：两个读-改-写都会落盘，后一个整份覆盖前一个）。那是另一件事，
// 不该夹带在这里做——见 `fanout-run.ts` 顶上「Why each lane re-reads the config」那段。
//
// 所以下面这条用例把干扰注入在**两条 lane 之间**，那正是它声称修好的那一段。把干扰挪到
// createWorktree 内部它会红，而那个红是如实的：那段确实还开着。
// ---------------------------------------------------------------------------

const BASE: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'repo', name: 'Main', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

const REQUEST: RunFanOutInput = {
  workspaceId: 'repo',
  prompt: 'try two ways',
  count: 2,
  baseName: 'bake',
  executorIds: ['codex']
}

function gitRepository(): WorkspaceBranchesSnapshot {
  return { kind: 'git-repository', hostId: 'local', repoPath: '/repo', branches: [] }
}

/**
 * 主进程那个共享的 config 闭包，原样模拟 ipc.ts：一个可变变量，谁都能读、谁都能整份写回。
 *
 * 关键是 `read()` 每次都取**当前**值，而扇出只在开头读一次——两者的差就是丢失窗口。
 */
function sharedConfig(initial: AppConfig) {
  let current = initial
  return {
    read: (): AppConfig => current,
    write: (next: AppConfig): void => {
      current = next
    }
  }
}

describe('扇出进行期间，别的 IPC 对 config 的改动会不会被盖掉', () => {
  it('两条 lane 之间另一个操作加了一个 workspace，扇出后续的回写不许把它抹掉', async () => {
    const shared = sharedConfig(BASE)
    let laneSeq = 0
    let interleaved = false

    const ports: FanOutRequestPorts = {
      config: () => shared.read(),
      listBranches: async () => gitRepository(),
      commitConfig: (next) => shared.write(next),
      lanes: (_source: WorkspaceRecord) => ({
        createWorktree: async (createInput, current) => {
          laneSeq += 1
          const workspace = { id: `lane-${laneSeq}`, path: createInput.path }
          return {
            config: {
              ...current,
              workspaces: [
                ...current.workspaces,
                {
                  ...workspace,
                  name: createInput.branch,
                  hostId: 'local',
                  kind: 'worktree' as const,
                  repoPath: '/repo',
                  branch: createInput.branch
                }
              ]
            },
            workspace
          }
        },
        launchAgent: async () => {
          // 第一条 lane 收尾之后、第二条开始之前，模拟另一个 IPC handler 在同一个闭包上做了一次
          // 完整的读-改-写。真实世界里这可以是 `workspaces:add`、`workspaces:removeWorktree`、
          // 改一处设置——任何一个；主进程在扇出跑着的这几十秒里照常接它们。
          if (!interleaved) {
            interleaved = true
            const now = shared.read()
            shared.write({
              ...now,
              workspaces: [
                ...now.workspaces,
                { id: 'other', name: 'Added mid-flight', hostId: 'local', path: '/other', kind: 'folder' }
              ]
            })
          }
          return { sessionId: `session-${laneSeq}` }
        },
        removeWorktree: async (_removeInput, current) => ({ config: current })
      })
    }

    const result = await runFanOutRequest(REQUEST, ports)
    expect(result.kind).toBe('fanout')

    const ids = shared.read().workspaces.map((item) => item.id)
    // 两条 lane 当然要在。
    expect(ids).toContain('lane-1')
    expect(ids).toContain('lane-2')
    // 而这一条是真正的判据：扇出开始之后、结束之前加进来的那条记录，不许被扇出的整份回写抹掉。
    expect(
      ids,
      '扇出把它开始时看到的那份 config 整个盖了回去，中途别的 IPC 写进去的改动静默消失了'
    ).toContain('other')
  })
})
