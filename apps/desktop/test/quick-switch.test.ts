import { describe, expect, it } from 'vitest'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  buildQuickSwitchIndex,
  fuzzyScore,
  rankQuickSwitchItems,
  type QuickSwitchItem
} from '../src/renderer/src/lib/quick-switch.js'

function agent(id: string, label: string, state: SessionSnapshot['status']['state'], observedAt: number): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'streaming',
      permission: 'respond',
      providerResume: true,
      replyCorrelation: 'native-turn-id'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label,
    createdAt: 1,
    updatedAt: observedAt,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function item(overrides: Partial<QuickSwitchItem> & Pick<QuickSwitchItem, 'id'>): QuickSwitchItem {
  return {
    kind: 'session',
    title: overrides.id,
    subtitle: '',
    providerId: null,
    state: null,
    observedAt: 0,
    target: { kind: 'session', sessionId: overrides.id },
    ...overrides
  }
}

describe('fuzzyScore', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'WorkspaceBoard')).toBeNull()
  })

  it('scores an empty query as a neutral zero so the natural order survives', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('rewards a contiguous run and word-boundary hits over a scattered match', () => {
    // "wb" hits the two word starts of "Workspace Board"; a scattered subsequence scores lower.
    const boundary = fuzzyScore('wb', 'Workspace Board')!
    const scattered = fuzzyScore('wb', 'shows below')!
    expect(boundary).toBeGreaterThan(scattered)
  })
})

describe('rankQuickSwitchItems', () => {
  it('floats needs-you above error above working above idle, regardless of input order', () => {
    const ranked = rankQuickSwitchItems(
      [
        item({ id: 'idle', state: 'done', observedAt: 1 }),
        item({ id: 'work', state: 'working', observedAt: 2 }),
        item({ id: 'err', state: 'error', observedAt: 3 }),
        item({ id: 'wait', state: 'waiting', observedAt: 4 })
      ],
      ''
    )
    expect(ranked.map((row) => row.id)).toEqual(['wait', 'err', 'work', 'idle'])
  })

  it('treats waiting and blocked as one needs-you class, earliest observed first', () => {
    const ranked = rankQuickSwitchItems(
      [
        item({ id: 'late-block', state: 'blocked', observedAt: 300 }),
        item({ id: 'early-wait', state: 'waiting', observedAt: 100 })
      ],
      ''
    )
    // Both are top-rung; the one waiting longest (earliest observedAt) leads — matching the status bar.
    expect(ranked[0]!.id).toBe('early-wait')
  })

  it('filters to matches and keeps the best match above the fold within one attention class', () => {
    const ranked = rankQuickSwitchItems(
      [
        item({ id: 'a', title: 'Workspace Board', state: null }),
        item({ id: 'b', title: 'random notes', state: null }),
        item({ id: 'c', title: 'web bundle', state: null })
      ],
      'wb'
    )
    // "random notes" has no "wb" subsequence and is dropped; the boundary hit ranks first.
    expect(ranked.map((row) => row.id)).toEqual(['a', 'c'])
  })

  it('lets attention outrank match quality so a weakly-matching waiting agent still leads', () => {
    const ranked = rankQuickSwitchItems(
      [
        item({ id: 'strong', title: 'deploy', state: null }),
        item({ id: 'waiting', title: 'daily standup', state: 'waiting', observedAt: 5 })
      ],
      'd'
    )
    expect(ranked[0]!.id).toBe('waiting')
  })
})

describe('buildQuickSwitchIndex', () => {
  const config = {
    workspaces: [
      { id: 'ws1', name: 'repo-one', hostId: 'local', path: '/repo', kind: 'folder', branch: 'main' }
    ]
  } as unknown as AppConfig

  it('projects agent sessions as rows carrying provider, state and workspace/branch subtitle', () => {
    const index = buildQuickSwitchIndex({
      config,
      sessions: [agent('s1', 'Codex on auth', 'waiting', 42)],
      tabs: {},
      tabGroupOf: () => 'group-1'
    })
    expect(index).toHaveLength(1)
    expect(index[0]).toMatchObject({
      kind: 'session',
      title: 'Codex on auth',
      subtitle: 'repo-one · main',
      providerId: 'codex',
      state: 'waiting',
      observedAt: 42,
      target: { kind: 'session', sessionId: 's1' }
    })
  })

  it('omits agent/terminal tabs (the session row already routes there) but keeps file tabs', () => {
    const fileTab: WorkbenchTab = {
      id: 'file:ws1:/repo/src/index.ts',
      workspaceId: 'ws1',
      titleRegionId: 'r1',
      layout: { root: { type: 'leaf', regionId: 'r1' }, activeRegionId: 'r1' },
      regions: {
        r1: { regionId: 'r1', kind: 'file', workspaceId: 'ws1', path: '/repo/src/index.ts' }
      }
    }
    const agentTab: WorkbenchTab = {
      id: 'session:s1',
      workspaceId: 'ws1',
      titleRegionId: 'r2',
      layout: { root: { type: 'leaf', regionId: 'r2' }, activeRegionId: 'r2' },
      regions: {
        r2: { regionId: 'r2', kind: 'agent', phase: 'attached', workspaceId: 'ws1', sessionId: 's1' }
      }
    }
    const index = buildQuickSwitchIndex({
      config,
      sessions: [],
      tabs: { [fileTab.id]: fileTab, [agentTab.id]: agentTab },
      tabGroupOf: () => 'group-1'
    })
    expect(index).toHaveLength(1)
    expect(index[0]).toMatchObject({
      kind: 'tab',
      title: 'index.ts',
      subtitle: 'repo-one',
      target: { kind: 'tab', tabId: fileTab.id, workspaceId: 'ws1', tabGroupId: 'group-1' }
    })
  })

  it('drops a tab whose group cannot be resolved so activation always has a real target', () => {
    const fileTab: WorkbenchTab = {
      id: 'file:ws1:/repo/x.ts',
      workspaceId: 'ws1',
      titleRegionId: 'r1',
      layout: { root: { type: 'leaf', regionId: 'r1' }, activeRegionId: 'r1' },
      regions: { r1: { regionId: 'r1', kind: 'file', workspaceId: 'ws1', path: '/repo/x.ts' } }
    }
    const index = buildQuickSwitchIndex({
      config,
      sessions: [],
      tabs: { [fileTab.id]: fileTab },
      tabGroupOf: () => null
    })
    expect(index).toHaveLength(0)
  })
})
