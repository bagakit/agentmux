// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SessionSnapshot } from '../src/shared/contracts'
// 这个替身要**覆盖组件读的每一个 slice**，缺一个就是 `undefined`：`b3645c56` 给 ProjectActivity
// 加了 `state.timelines` 与 `state.config` 两处读，替身没跟上，于是 `timelines[session.id]` 当场抛
// TypeError——两条判据一条都没跑到，红得像组件坏了。真 store 的初值就是 `{}` 与 `null`（store.ts:1571），
// 这里照抄的是那个初值，不是为了让测试过而编的形状。
const state = vi.hoisted(() => ({
  selectSession: vi.fn(),
  providerCatalog: [],
  timelines: {},
  config: null
}))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: (select: (value: typeof state) => unknown) => select(state) }))
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'

it('hover explains which Agent needs a reply, selection navigates exactly there, and resolution removes the marker', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const session: SessionSnapshot = { id: 'a', kind: 'agent', label: 'Reviewer', providerId: 'codex', executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: '/project', createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'a', run: { runId: 'run-a' } },
    status: { state: 'waiting', source: 'run-process', observedAt: 1 },
    pendingInteraction: { kind: 'question', id: 'q', agentSessionId: 'a', questions: [{ id: 'branch', prompt: 'Which branch should I review?', options: [] }], evidence: { source: 'native-hook', observedAt: 1 } } }

  try {
    await act(async () => root.render(<ProjectActivity sessions={[session]} />))
    const button = container.querySelector('button')!
    expect(button.textContent).toContain('Needs you')
    await act(async () => button.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Unassigned')
    await act(async () => (document.querySelector('[aria-label^="Show Agents"]') as HTMLElement).click())
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Which branch should I review?')
    await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).click())
    expect(state.selectSession).toHaveBeenCalledExactlyOnceWith('a')
    const { pendingInteraction: _resolved, ...resolvedSession } = session
    await act(async () => root.render(<ProjectActivity sessions={[{ ...resolvedSession, status: { ...session.status, state: 'done' } }]} />))
    expect(container.querySelector('button')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('renders one explicit work-line row and lets its primary action open the most urgent Agent', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  state.selectSession.mockClear()
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const waiting: SessionSnapshot = {
    id: 'waiting', kind: 'agent', label: 'Reviewer', providerId: 'codex', executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: '/project', createdAt: 1, updatedAt: 4, processState: 'running', latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'waiting', run: { runId: 'run-waiting' } },
    status: { state: 'waiting', source: 'native-hook', observedAt: 4 },
    pendingInteraction: { kind: 'question', id: 'question', agentSessionId: 'waiting', questions: [{ id: 'choice', prompt: 'Choose a release lane', options: [] }], evidence: { source: 'native-hook', observedAt: 4 } }
  }
  const { pendingInteraction: _waitingPending, ...waitingBase } = waiting
  const working: SessionSnapshot = {
    ...waitingBase,
    id: 'working', label: 'Builder',
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'working', run: { runId: 'run-working' } },
    status: { state: 'working', source: 'native-hook', observedAt: 3 }
  }
  try {
    await act(async () => root.render(<ProjectActivity
      sessions={[working, waiting]}
      contexts={[{ id: 'topic-1', kind: 'topic', label: 'Release prep', hostId: 'local', path: '/project' }]}
    />))
    const trigger = container.querySelector('button')!
    await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('Topic · Release prep')
    expect(menu.querySelectorAll('.project-activity-group')).toHaveLength(1)
    expect(menu.querySelector('.project-activity-group__details')).toBeNull()
    await act(async () => (menu.querySelector('.project-activity-group__summary') as HTMLElement).click())
    expect(state.selectSession).toHaveBeenCalledExactlyOnceWith('waiting')
  } finally { await act(async () => root.unmount()); container.remove() }
})
