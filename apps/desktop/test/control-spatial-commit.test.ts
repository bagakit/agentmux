import { describe, expect, it } from 'vitest'
import {
  resolveSpatialCommit,
  selectDisplacedAgentNotices,
  displacedAgentStepOutcome
} from '../src/renderer/src/lib/control-spatial-commit'
import {
  addWorkbenchRegion,
  createWorkbenchTab,
  removeWorkbenchRegion,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs'
import { classifyServiceNotice, serviceNoticeToRender } from '../src/renderer/src/lib/service-window-notice'
import type { SessionSnapshot } from '../src/shared/contracts'

// T-005 「异步创建回执与实际布局一致」的纯判定层。异步 open.agent/open.terminal 完成时，回执的落点必须
// 对**当前**布局重新解析，绝不回放 plan 里的坐标；已健康启动却错位的 Agent 仍可发现、且带一条持续告示。
// 这一层被单测直接钉住；store.ts 里只剩一层薄调用（受争用，交由集成方接线）。

function agentSurface(regionId: string, sessionId: string): WorkbenchSurface {
  return { regionId, kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId }
}
function terminalSurface(regionId: string, sessionId: string): WorkbenchSurface {
  return { regionId, kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId }
}
function launcherSurface(regionId: string): WorkbenchSurface {
  return { regionId, kind: 'launcher', workspaceId: 'workspace' }
}

function agentSession(id: string, label: string): SessionSnapshot {
  return {
    id, kind: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: '/repo', label, createdAt: 1, updatedAt: 1,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function terminalSession_(id: string, label: string): SessionSnapshot {
  return {
    id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/repo', label,
    createdAt: 1, updatedAt: 1, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } }
  }
}

describe('resolveSpatialCommit — 回执落点对当前布局重新解析', () => {
  it('lands on the region’s CURRENT Tab, not where the plan put it', () => {
    // 计划把这一格放在 planned-tab；启动期间用户把它搬到 moved-tab。回执必须报 moved-tab。
    // 期望坐标来自本测试自己的 setup（moved-tab），绝不从被测机制里回读——否则恒真。
    const planned = createWorkbenchTab('planned-tab', agentSurface('r1', 's1'))
    void planned
    const moved = createWorkbenchTab('moved-tab', agentSurface('r1', 's1'))
    const commit = resolveSpatialCommit({ 'moved-tab': moved }, 'r1', { kind: 'agent', sessionId: 's1' })
    expect(commit).toEqual({ kind: 'landed', tabId: 'moved-tab' })
  })

  it('reports displaced when the region is gone entirely (closed during launch)', () => {
    const other = createWorkbenchTab('other-tab', launcherSurface('r-other'))
    const commit = resolveSpatialCommit({ 'other-tab': other }, 'r1', { kind: 'agent', sessionId: 's1' })
    expect(commit).toEqual({ kind: 'displaced' })
  })

  it('reports displaced when the regionId was recycled by a different session', () => {
    // regionId 被回收：同一格现在承载别的 sessionId。身份闸门必须拦住，绝不把别人的落点当成回执。
    const tab = createWorkbenchTab('t', agentSurface('r1', 'someone-else'))
    const commit = resolveSpatialCommit({ t: tab }, 'r1', { kind: 'agent', sessionId: 's1' })
    expect(commit).toEqual({ kind: 'displaced' })
  })

  it('reports displaced when the surface kind changed (terminal expected, agent found)', () => {
    const tab = createWorkbenchTab('t', agentSurface('r1', 's1'))
    const commit = resolveSpatialCommit({ t: tab }, 'r1', { kind: 'terminal', sessionId: 's1' })
    expect(commit).toEqual({ kind: 'displaced' })
  })

  it('lands a terminal on its current Tab too (the twin path 589ab7bf left returning plan.tabId)', () => {
    const moved = createWorkbenchTab('moved-term-tab', terminalSurface('rt', 'st'))
    const commit = resolveSpatialCommit({ 'moved-term-tab': moved }, 'rt', { kind: 'terminal', sessionId: 'st' })
    expect(commit).toEqual({ kind: 'landed', tabId: 'moved-term-tab' })
  })
})

describe('selectDisplacedAgentNotices — 已健康启动但错位的持续告示', () => {
  it('surfaces a displaced agent that is alive but has no region', () => {
    const tab = createWorkbenchTab('t', launcherSurface('r-other'))
    const notices = selectDisplacedAgentNotices([agentSession('s1', 'Builder')], { t: tab }, ['s1'])
    // 扫描断言非空——这是「持续告示确实产出」的判据，不是空数组静默通过。
    expect(notices.length).toBeGreaterThan(0)
    expect(notices).toEqual([{ agentSessionId: 's1', label: 'Builder' }])
  })

  it('self-heals: an agent that regained a region drops out of the notice', () => {
    const tab = createWorkbenchTab('t', agentSurface('r1', 's1'))
    const notices = selectDisplacedAgentNotices([agentSession('s1', 'Builder')], { t: tab }, ['s1'])
    expect(notices).toEqual([])
  })

  it('drops a displaced id whose session has ended (no longer discoverable or placeable)', () => {
    const tab = createWorkbenchTab('t', launcherSurface('r-other'))
    const notices = selectDisplacedAgentNotices([], { t: tab }, ['s1'])
    expect(notices).toEqual([])
  })

  it('ignores a displaced id whose session is a terminal, not an agent', () => {
    // 这条告示只说 Agent。同一个 id 若指向一个 terminal session，绝不能被报成 agent 告示——
    // 删掉 kind === 'agent' 这道过滤会让本条红。
    const tab = createWorkbenchTab('t', launcherSurface('r-other'))
    const terminalSession = terminalSession_('s1', 'Shell')
    const notices = selectDisplacedAgentNotices([terminalSession], { t: tab }, ['s1'])
    expect(notices).toEqual([])
  })

  it('deduplicates repeated displaced ids', () => {
    const tab = createWorkbenchTab('t', launcherSurface('r-other'))
    const notices = selectDisplacedAgentNotices([agentSession('s1', 'Builder')], { t: tab }, ['s1', 's1'])
    expect(notices).toEqual([{ agentSessionId: 's1', label: 'Builder' }])
  })
})

describe('displacedAgentStepOutcome — 文案归到「流程降级：放行 + 提醒」，永不阻断', () => {
  it('classifies as process-degraded (alive) and renders a non-null service notice', () => {
    const outcome = displacedAgentStepOutcome('Builder')
    const classification = classifyServiceNotice(outcome)
    // 进程是好的：必须归到 process-degraded（放行），绝不是 agent-broken（阻断）。
    expect(classification.kind).toBe('process-degraded')
    const rendered = serviceNoticeToRender(classification)
    expect(rendered).not.toBeNull()
    // 告示点名了这个 agent，且文案说清进程还在跑——不是否定式的「没落上」。
    expect(rendered?.notice.step).toContain('Builder')
    expect(rendered?.notice.mode).toContain('still running')
    // 恢复动作也要被断言，否则那行文案是可以被静默换掉的（评审 GAP A）。
    expect(rendered?.notice.restore).toContain('session list')
  })
})

// 三格分屏里搬动一格：证明落点判定用的是 regionId 的**当前**归属，不是 plan 的静态坐标。
describe('resolveSpatialCommit — 分屏搬动的端到端布局形状', () => {
  it('follows a region promoted out of a shared Tab into its own Tab', () => {
    // 源 Tab 三格；把 r2 摘出去（用真的 removeWorkbenchRegion），落到一张新 Tab。
    let source = createWorkbenchTab('source', agentSurface('r1', 's1'))
    source = addWorkbenchRegion(source, 'r1', 'right', agentSurface('r2', 's2'))
    source = addWorkbenchRegion(source, 'r2', 'right', agentSurface('r3', 's3'))
    const detached = removeWorkbenchRegion(source, 'r2')
    if (!detached) throw new Error('setup: r2 should detach from a 3-region tab')
    const promoted = createWorkbenchTab('promoted', agentSurface('r2', 's2'))
    const commit = resolveSpatialCommit({ source: detached, promoted }, 'r2', { kind: 'agent', sessionId: 's2' })
    expect(commit).toEqual({ kind: 'landed', tabId: 'promoted' })
  })
})
