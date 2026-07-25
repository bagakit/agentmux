import { describe, expect, it } from 'vitest'
import { MAX_FANOUT, planFanOut, laneDirectoryName } from '../src/main/fanout-plan.js'

function request(overrides: Partial<Parameters<typeof planFanOut>[0]> = {}) {
  return {
    count: 3,
    baseName: 'Add retry to the uploader',
    worktreeRoot: '/repo/.worktrees',
    executorIds: ['codex'],
    existingBranches: [],
    existingWorktreePaths: [],
    ...overrides
  }
}

describe('fan-out plan', () => {
  it('turns one prompt into N readable, non-colliding lanes', () => {
    const plan = planFanOut(request())
    if (plan.kind !== 'fanout') throw new Error(`expected fanout, got ${plan.kind}`)

    expect(plan.lanes.map((lane) => lane.branch)).toEqual([
      'add-retry-to-the-uploader-1',
      'add-retry-to-the-uploader-2',
      'add-retry-to-the-uploader-3'
    ])
    expect(plan.lanes.map((lane) => lane.path)).toEqual([
      '/repo/.worktrees/add-retry-to-the-uploader-1',
      '/repo/.worktrees/add-retry-to-the-uploader-2',
      '/repo/.worktrees/add-retry-to-the-uploader-3'
    ])
  })

  it('is deterministic: the same request always yields the same plan', () => {
    // The point of the rule against clocks and randomness in the names. A fan-out that named itself
    // from Date.now() could not be re-run, and a test could only assert its shape, not its content.
    expect(planFanOut(request())).toEqual(planFanOut(request()))
  })

  it('steps past branches that already exist instead of overwriting them', () => {
    const plan = planFanOut(request({
      count: 2,
      existingBranches: ['add-retry-to-the-uploader-1', 'add-retry-to-the-uploader-2']
    }))
    if (plan.kind !== 'fanout') throw new Error('expected fanout')

    expect(plan.lanes.map((lane) => lane.branch))
      .toEqual(['add-retry-to-the-uploader-3', 'add-retry-to-the-uploader-4'])
  })

  it('steps past occupied worktree directories, trailing slash included', () => {
    // A registered path with a trailing separator is the same directory; treating it as different
    // would plan a lane straight into an occupied worktree.
    const plan = planFanOut(request({
      count: 1 + 1,
      existingWorktreePaths: ['/repo/.worktrees/add-retry-to-the-uploader-1/']
    }))
    if (plan.kind !== 'fanout') throw new Error('expected fanout')

    expect(plan.lanes.map((lane) => lane.path)).toEqual([
      '/repo/.worktrees/add-retry-to-the-uploader-2',
      '/repo/.worktrees/add-retry-to-the-uploader-3'
    ])
  })

  it('never lets two lanes of one plan claim the same name', () => {
    // The lanes claimed within this call must also be taken into account, not just pre-existing ones.
    const plan = planFanOut(request({ count: MAX_FANOUT }))
    if (plan.kind !== 'fanout') throw new Error('expected fanout')

    expect(new Set(plan.lanes.map((lane) => lane.branch)).size).toBe(MAX_FANOUT)
    expect(new Set(plan.lanes.map((lane) => lane.path)).size).toBe(MAX_FANOUT)
  })

  it('calls one lane what it is — an ordinary single launch, not a fan-out', () => {
    // Grouping, teardown and comparison cost something; paying it to compare one result with nothing
    // would be pure ceremony.
    expect(planFanOut(request({ count: 1 }))).toEqual({ kind: 'single', executorId: 'codex' })
  })

  it('refuses past the ceiling rather than silently trimming', () => {
    // Handing someone 8 lanes when they asked for 40 is worse than telling them the limit.
    const plan = planFanOut(request({ count: MAX_FANOUT + 1 }))
    expect(plan.kind).toBe('rejected')
    if (plan.kind === 'rejected') expect(plan.reason).toContain(String(MAX_FANOUT))
  })

  it('refuses a request it cannot name or staff', () => {
    expect(planFanOut(request({ count: 0 })).kind).toBe('rejected')
    expect(planFanOut(request({ count: -2 })).kind).toBe('rejected')
    expect(planFanOut(request({ executorIds: [] })).kind).toBe('rejected')
    expect(planFanOut(request({ executorIds: ['   '] })).kind).toBe('rejected')
    // A prompt of pure punctuation slugifies to nothing; refusing beats inventing a name.
    expect(planFanOut(request({ baseName: '!!! ???' })).kind).toBe('rejected')
    expect(planFanOut(request({ baseName: '   ' })).kind).toBe('rejected')
  })

  it('spreads lanes across executors in a stable cycle', () => {
    const plan = planFanOut(request({ count: 4, executorIds: ['codex', 'claude'] }))
    if (plan.kind !== 'fanout') throw new Error('expected fanout')

    expect(plan.lanes.map((lane) => lane.executorId)).toEqual(['codex', 'claude', 'codex', 'claude'])
  })

  it('keeps branch names usable as directory names', () => {
    // The branch name doubles as the directory name, so the alphabet has to be safe for both.
    const plan = planFanOut(request({ count: 2, baseName: 'Fix: OAuth/token refresh (urgent!)' }))
    if (plan.kind !== 'fanout') throw new Error('expected fanout')

    for (const lane of plan.lanes) {
      expect(lane.branch).toMatch(/^[a-z0-9-]+$/u)
      expect(laneDirectoryName(lane)).toBe(lane.branch)
    }
  })

  it('bounds an overlong prompt instead of producing an unusable name', () => {
    const plan = planFanOut(request({ count: 2, baseName: 'a'.repeat(200) }))
    if (plan.kind !== 'fanout') throw new Error('expected fanout')

    for (const lane of plan.lanes) expect(lane.branch.length).toBeLessThanOrEqual(48)
  })
})
