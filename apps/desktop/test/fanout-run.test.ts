import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import {
  launchedLanes,
  runFanOut,
  strandedLanes,
  type FanOutPorts
} from '../src/main/fanout-run.js'

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function lane(branch: string, executorId = 'codex') {
  return { branch, path: `/repo/.worktrees/${branch}`, executorId }
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
    const result = await runFanOut({
      workspaceId: 'repo',
      prompt: 'Add retry to the uploader',
      lanes: [lane('retry-1'), lane('retry-2'), lane('retry-3')],
      config,
      ports: ports()
    })

    expect(result.lanes.map((entry) => entry.status)).toEqual(['launched', 'launched', 'launched'])
    // Each lane's worktree registration must survive into the final config; a lane that overwrote the
    // config it was handed would silently drop the earlier lanes' workspaces.
    expect(result.config.workspaces.map((workspace) => workspace.name))
      .toEqual(['retry-1', 'retry-2', 'retry-3'])
  })

  it('carries the same prompt down every lane, with each lane on its own worktree', async () => {
    const io = ports()
    await runFanOut({
      workspaceId: 'repo',
      prompt: 'One prompt, three ways',
      lanes: [lane('a'), lane('b')],
      config,
      ports: io
    })

    const calls = (io.launchAgent as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map((call) => call[0].prompt)).toEqual(['One prompt, three ways', 'One prompt, three ways'])
    expect(calls.map((call) => call[0].workspacePath))
      .toEqual(['/repo/.worktrees/a', '/repo/.worktrees/b'])
  })

  it('always creates the branch: a bake-off opens fresh branches, it does not adopt existing ones', async () => {
    const io = ports()
    await runFanOut({ workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], config, ports: io })

    expect((io.createWorktree as ReturnType<typeof vi.fn>).mock.calls[0]![0])
      .toMatchObject({ createBranch: true, branch: 'a' })
  })

  it('keeps going when one lane fails — the point of a bake-off is the lanes that worked', async () => {
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
      config,
      ports: io
    })

    expect(result.lanes.map((entry) => entry.status)).toEqual(['launched', 'launch-failed', 'launched'])
    expect(launchedLanes(result).map((entry) => entry.branch)).toEqual(['a', 'c'])
  })

  it('says where a failed lane left its worktree, so no directory becomes an orphan', async () => {
    // A worktree with no agent in it is the state a person has to decide about. Reporting it as merely
    // "failed" would leave a real directory nobody knows to claim.
    const io = ports({
      launchAgent: vi.fn(async () => { throw new Error('launch exploded') }),
      removeWorktree: undefined
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], config, ports: io
    })

    expect(result.lanes[0]).toMatchObject({
      status: 'launch-failed',
      branch: 'a',
      error: 'launch exploded',
      worktreeRetained: true
    })
    expect(strandedLanes(result).map((entry) => entry.branch)).toEqual(['a'])
  })

  it('hands a failed lane its worktree back when teardown is available', async () => {
    const removeWorktree = vi.fn(async (_input: { workspaceId: string }, current: AppConfig) => ({
      config: { ...current, workspaces: [] }
    }))
    const io = ports({
      launchAgent: vi.fn(async () => { throw new Error('nope') }),
      removeWorktree
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], config, ports: io
    })

    expect(removeWorktree).toHaveBeenCalledWith({ workspaceId: 'ws-a' }, expect.anything())
    expect(result.lanes[0]).toMatchObject({ status: 'launch-failed', worktreeRetained: false })
    // Nothing stranded, so nothing for the user to decide about.
    expect(strandedLanes(result)).toEqual([])
  })

  it('does not let a cleanup failure hide the launch failure that caused it', async () => {
    // The user needs the original reason AND the truth that the directory is still there.
    const io = ports({
      launchAgent: vi.fn(async () => { throw new Error('the real problem') }),
      removeWorktree: vi.fn(async () => { throw new Error('cleanup also failed') })
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], config, ports: io
    })

    expect(result.lanes[0]).toMatchObject({
      status: 'launch-failed',
      error: 'the real problem',
      worktreeRetained: true
    })
  })

  it('distinguishes a lane that created nothing from one that created a worktree', async () => {
    // worktree-failed has nothing to clean up; launch-failed might. Collapsing them would either invent
    // an orphan or hide one.
    const io = ports({
      createWorktree: vi.fn(async () => { throw new Error('branch already exists') })
    })

    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a')], config, ports: io
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
    const io = ports({ createWorktree: vi.fn(async () => { throw new Error('no') }) })
    const result = await runFanOut({
      workspaceId: 'repo', prompt: 'p', lanes: [lane('a'), lane('b')], config, ports: io
    })

    expect(launchedLanes(result)).toEqual([])
    expect(result.lanes.every((entry) => entry.status === 'worktree-failed')).toBe(true)
    // The config is unchanged: nothing registered, so nothing to unregister later.
    expect(result.config.workspaces).toEqual([])
  })

  it('runs lanes sequentially, because they contend on one git repository', async () => {
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

    await runFanOut({ workspaceId: 'repo', prompt: 'p', lanes: [lane('a'), lane('b')], config, ports: io })

    expect(order).toEqual(['create:a', 'created:a', 'create:b', 'created:b'])
  })

  it('handles an empty lane list without inventing work', async () => {
    const io = ports()
    const result = await runFanOut({ workspaceId: 'repo', prompt: 'p', lanes: [], config, ports: io })

    expect(result.lanes).toEqual([])
    expect(result.config).toBe(config)
    expect(io.createWorktree).not.toHaveBeenCalled()
  })
})
