import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import {
  launchedLanes,
  runFanOut,
  strandedLanes,
  type FanOutPorts
} from '../src/main/fanout-run.js'
import { WorktreeRetainedError } from '../src/main/worktree-service.js'

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function lane(branch: string, executorId = 'codex') {
  return { branch, path: `/repo/.worktrees/${branch}`, executorId }
}

/**
 * 主进程那个共享的 config 单元，原样对应 ipc.ts 的可变闭包。
 *
 * runFanOut 不再自己攒一份 config 最后整份交回——那样会把扇出进行期间别的 IPC 写进去的东西
 * 静默盖掉（见 fanout-config-lost-update.test.ts）。现在它逐 lane 取当前值、逐 lane 回写，
 * 所以"每条 lane 的注册都活到最后"这条性质要在**这个单元**上验，而不是在返回值上。
 */
function configCell(initial: AppConfig = config) {
  let current = initial
  return {
    read: () => current,
    commit: (next: AppConfig) => {
      current = next
    },
    get value() {
      return current
    }
  }
}

// Ports that succeed, threading a config that visibly accumulates one workspace per lane so the tests
// can prove the config was carried forward rather than reset per lane.
function ports(overrides: Partial<FanOutPorts> = {}): FanOutPorts {
  return {
    createWorktree: vi.fn(async (input, current) => ({
      config: {
        ...current,
        workspaces: [
          ...current.workspaces,
          {
            id: `ws-${input.branch}`,
            name: input.branch,
            hostId: 'local',
            path: input.path,
            kind: 'worktree' as const
          }
        ]
      },
      workspace: { id: `ws-${input.branch}`, path: input.path }
    })),
    launchAgent: vi.fn(async (input) => ({ sessionId: `session-${input.workspacePath.split('/').at(-1)}` })),
    ...overrides
  }
}

describe('fan-out run', () => {
  it('launches one agent per lane and threads the config through every registration', async () => {
    const cell = configCell()
    const result = await runFanOut({
      workspaceId: 'repo',
      prompt: 'Add retry to the uploader',
      lanes: [lane('retry-1'), lane('retry-2'), lane('retry-3')],
      readConfig: cell.read,
      commitConfig: cell.commit,
      ports: ports()
    })

    expect(result.lanes.map((entry) => entry.status)).toEqual(['launched', 'launched', 'launched'])
    // Each lane's worktree registration must survive into the shared config; a lane that started from
    // anything other than what the previous lane published would silently drop the earlier workspaces.
    // Read on the cell, not on the return value: runFanOut no longer carries a config out, because
    // carrying one out is exactly what let it overwrite concurrent writers.
    expect(cell.value.workspaces.map((workspace) => workspace.name))
      .toEqual(['retry-1', 'retry-2', 'retry-3'])
  })

  it('carries the same prompt down every lane, with each lane on its own worktree', async () => {
    const cell = configCell()
    const io = ports()
    await runFanOut({
      workspaceId: 'repo',
      prompt: 'One prompt, three ways',
      lanes: [lane('a'), lane('b')],
      readConfig: cell.read,
      commitConfig: cell.commit,
      ports: io
    })

    const calls = (io.launchAgent as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map((call) => call[0].prompt)).toEqual(['One prompt, three ways', 'One prompt, three ways'])
    expect(calls.map((call) => call[0].workspacePath))
      .toEqual(['/repo/.worktrees/a', '/repo/.worktrees/b'])
  })

  it('always creates the branch: a bake-off opens fresh branches, it does not adopt existing ones', async () => {
    const cell = configCell()
    const io = ports()
    await runFanOut({ workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], readConfig: cell.read, commitConfig: cell.commit, ports: io })

    expect((io.createWorktree as ReturnType<typeof vi.fn>).mock.calls[0]![0])
      .toMatchObject({ createBranch: true, branch: 'a' })
  })

  it('keeps going when one lane fails — the point of a bake-off is the lanes that worked', async () => {
    const cell = configCell()
    // Throwing on first failure would abandon the lanes that already succeeded with no record of them.
    const io = ports({
      launchAgent: vi.fn(async (input) => {
        if (input.workspacePath.endsWith('b')) throw new Error('executor not found')
        return { sessionId: `session-${input.workspacePath.split('/').at(-1)}` }
      })
    })

    const result = await runFanOut({
      workspaceId: 'repo',
      prompt: 'p',
      lanes: [lane('a'), lane('b'), lane('c')],
      readConfig: cell.read,
      commitConfig: cell.commit,
      ports: io
    })

    expect(result.lanes.map((entry) => entry.status)).toEqual(['launched', 'launch-failed', 'launched'])
    expect(launchedLanes(result).map((entry) => entry.branch)).toEqual(['a', 'c'])
  })

  it('says where a failed lane left its worktree, so no directory becomes an orphan', async () => {
    const cell = configCell()
    // A worktree with no agent in it is the state a person has to decide about. Reporting it as merely
    // "failed" would leave a real directory nobody knows to claim.
    const io = ports({
      launchAgent: vi.fn(async () => { throw new Error('launch exploded') }),
      removeWorktree: undefined
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], readConfig: cell.read, commitConfig: cell.commit, ports: io
    })

    expect(result.lanes[0]).toMatchObject({
      status: 'launch-failed',
      branch: 'a',
      error: 'launch exploded'
    })
    // 没有 teardown 端口时归到 `git-failed`：什么都没被尝试、什么都没被丢弃，目录还站着。这一档的
    // 承诺恰好就是那句话，而它不给「丢弃」按钮——对「根本没试过」是对的。
    const [first] = result.lanes
    expect(first?.status === 'launch-failed' ? first.cleanup?.retention : null).toBe('git-failed')
    expect(strandedLanes(result).map((entry) => entry.branch)).toEqual(['a'])
  })

  it('hands a failed lane its worktree back when teardown is available', async () => {
    const cell = configCell()
    const removeWorktree = vi.fn(async (_input: { workspaceId: string }, current: AppConfig) => ({
      config: { ...current, workspaces: [] }
    }))
    const io = ports({
      launchAgent: vi.fn(async () => { throw new Error('nope') }),
      removeWorktree
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], readConfig: cell.read, commitConfig: cell.commit, ports: io
    })

    expect(removeWorktree).toHaveBeenCalledWith({ workspaceId: 'ws-a' }, expect.anything())
    // `null` 是「交回去了」——没有任何东西留给人决定。用 null 而不是某一档保留，是因为三档保留说的都是
    // 「还有东西在」，而这里没有。
    expect(result.lanes[0]).toMatchObject({ status: 'launch-failed', cleanup: null })
    // Nothing stranded, so nothing for the user to decide about.
    expect(strandedLanes(result)).toEqual([])
  })

  it('does not let a cleanup failure hide the launch failure that caused it', async () => {
    const cell = configCell()
    // The user needs the original reason AND the truth that the directory is still there.
    const io = ports({
      launchAgent: vi.fn(async () => { throw new Error('the real problem') }),
      removeWorktree: vi.fn(async () => { throw new Error('cleanup also failed') })
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], readConfig: cell.read, commitConfig: cell.commit, ports: io
    })

    expect(result.lanes[0]).toMatchObject({
      status: 'launch-failed',
      error: 'the real problem'
    })
    // 两句话都要在：启动为什么挂了，以及那个目录现在怎么样。压成一句就会丢掉其中一件。
    const [first] = result.lanes
    expect(first?.status === 'launch-failed' ? first.cleanup : null).toEqual({
      retention: 'git-failed',
      reason: 'cleanup also failed'
    })
  })

  it('清理时 git 已经删掉目录、只是记录没撤下：不算搁浅，也不许说目录还在', async () => {
    const cell = configCell()
    // 这是 `worktreeRetained: boolean` 唯一**答错**的那一档，也是它必须不再是布尔的理由：清理抛出时
    // 旧代码记 `retained = true`，即「目录还在」——而这一档 git 恰好已经把目录删了。
    //
    // 判据分两条，因为它们各自能漂移：分类要如实带出（下游据它选措辞），且这条 lane 不许进搁浅清单
    // （那份清单的语义是「还有个签出等你决定」，而这里没有签出可决定，指过去就是指向一个不存在的路径）。
    const io = ports({
      launchAgent: vi.fn(async () => { throw new Error('launch exploded') }),
      removeWorktree: vi.fn(async () => {
        throw new WorktreeRetainedError('record-not-withdrawn', 'removed it, could not update the list')
      })
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], readConfig: cell.read, commitConfig: cell.commit, ports: io
    })

    const [first] = result.lanes
    expect(first?.status === 'launch-failed' ? first.cleanup?.retention : null).toBe(
      'record-not-withdrawn'
    )
    expect(
      strandedLanes(result),
      '目录已经被删的 lane 被列成「搁浅」：用户会被指去处理一个不存在的签出'
    ).toEqual([])
  })

  it('脏树的清理拒绝仍然算搁浅：那个签出真的还在，等人决定', async () => {
    const cell = configCell()
    // 与上一条成对。同样是「清理没成功」，但这一档目录还在，所以它**必须**进搁浅清单——只钉上面
    // 那条时，把整个 strandedLanes 改成恒空也照旧全绿。
    const io = ports({
      launchAgent: vi.fn(async () => { throw new Error('launch exploded') }),
      removeWorktree: vi.fn(async () => {
        throw new WorktreeRetainedError('uncommitted-changes', 'Worktree has uncommitted changes: a')
      })
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], readConfig: cell.read, commitConfig: cell.commit, ports: io
    })

    expect(strandedLanes(result).map((entry) => entry.branch)).toEqual(['a'])
  })

  it('distinguishes a lane that created nothing from one that created a worktree', async () => {
    const cell = configCell()
    // worktree-failed has nothing to clean up; launch-failed might. Collapsing them would either invent
    // an orphan or hide one.
    const io = ports({
      createWorktree: vi.fn(async () => { throw new Error('branch already exists') })
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], readConfig: cell.read, commitConfig: cell.commit, ports: io
    })

    expect(result.lanes[0]).toEqual({
      status: 'worktree-failed',
      branch: 'a',
      path: '/repo/.worktrees/a',
      error: 'branch already exists'
    })
    // No agent launch was attempted for a lane with no worktree.
    expect(io.launchAgent).not.toHaveBeenCalled()
  })

  it('reports an all-failed fan-out as empty rather than successful', async () => {
    const cell = configCell()
    const io = ports({ createWorktree: vi.fn(async () => { throw new Error('no') }) })
    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a'), lane('b')], readConfig: cell.read, commitConfig: cell.commit, ports: io
    })

    expect(launchedLanes(result)).toEqual([])
    expect(result.lanes.every((entry) => entry.status === 'worktree-failed')).toBe(true)
    // The config is unchanged: nothing registered, so nothing to unregister later.
    expect(cell.value.workspaces).toEqual([])
  })

  it('runs lanes sequentially, because they contend on one git repository', async () => {
    const cell = configCell()
    // Concurrent `git worktree add` calls fight over the same index and metadata, and the config is
    // threaded through each registration — parallel lanes would race on both. The agents run
    // concurrently once launched, which is where the parallelism the user wants actually lives.
    const order: string[] = []
    const io = ports({
      createWorktree: vi.fn(async (input, current) => {
        order.push(`create:${input.branch}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push(`created:${input.branch}`)
        return {
          config: current,
          workspace: { id: `ws-${input.branch}`, path: input.path }
        }
      })
    })

    await runFanOut({ workspaceId: 'repo', prompt: 'p', lanes: [lane('a'), lane('b')], readConfig: cell.read, commitConfig: cell.commit, ports: io })

    expect(order).toEqual(['create:a', 'created:a', 'create:b', 'created:b'])
  })

  it('handles an empty lane list without inventing work', async () => {
    const cell = configCell()
    const io = ports()
    const result = await runFanOut({ workspaceId: 'repo', prompt: 'p', lanes: [], readConfig: cell.read, commitConfig: cell.commit, ports: io })

    expect(result.lanes).toEqual([])
    // Identity, not deep equality: no lane ran, so nothing was ever published — the cell still holds
    // the very object it started with. A `toEqual` here would also pass on a gratuitous copy, and a
    // gratuitous copy is precisely the write that clobbers a concurrent one.
    expect(cell.value).toBe(config)
    expect(io.createWorktree).not.toHaveBeenCalled()
  })
})
