// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { DemandAgentReference } from '@agentmux/demand/relations'
import * as avatars from '@agentmux/client-ui/components/AvatarGroup'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { api } from '../src/renderer/src/lib/api'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const goal = (patch: Partial<DemandRecord> = {}): DemandRecord => ({ id: 'team-goal', title: 'Goal with original Agents', description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  source: 'session', sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null, createdAt: 1, updatedAt: 1, ...patch })
const group = () => dom.container.querySelector<HTMLElement>('[data-goal-agent-group="team-goal"]')
const faces = () => [...group()!.querySelectorAll<HTMLElement>('[data-avatar-group-key]')]
const label = () => group()?.querySelector('[role="img"]')?.getAttribute('aria-label')
async function mount(record: DemandRecord, sessions = Array.from({ length: 5 }, (_, i) => ({ ...composerSession(`agent-${i + 1}`), label: `Original Agent ${i + 1}` }))) {
  useAppStore.setState({ demands: { [record.id]: record }, selectedDemandId: null, mainSurface: 'board', sessions })
  await dom.render(<GlobalBoardSurface />)
}
const source = (runtimeId: string): DemandAgentReference => ({ kind: 'space-member', source: { runtimeId, spaceId: 'original-space', regionId: 'original-region', admission: { kind: 'association', operationId: 'original-association' } }, execution: { runtimeId: 'execution-runtime', agentSessionId: 'agent-1' } })

it.each([0, 1, 3, 5])('the actual Goal card shows %i current Agents with exactly three visible at most and an accurate overflow', async count => {
  const delegation = vi.spyOn(api.demands, 'delegation')
  const selected = Array.from({ length: count }, (_, i) => `agent-${i + 1}`)
  await mount(goal({ supervisorSessionId: selected[0] ?? null, assigneeSessionIds: selected }))
  if (!count) expect(group()).toBeNull()
  else {
    expect(faces()).toHaveLength(Math.min(count, 3))
    expect(group()!.querySelector('.avatar-group__more')?.textContent ?? null).toBe(count > 3 ? `+${count - 3}` : null)
    for (let i = 0; i < count; i++) expect(label()).toContain(`Original Agent ${i + 1}`)
    expect(label()).toContain('Supervisor / Executor')
    expect(group()!.closest('.goals-row__footer')).not.toBeNull()
    const row = group()!.closest('[data-demand-id]')!
    expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toBe(label())
    expect(group()!.querySelectorAll('button')).toHaveLength(0)
  }
  expect(delegation).not.toHaveBeenCalled()
})

it('deduplicates the same accurate Supervisor and Executor Actor, including retained presentation aliases', async () => {
  const session = { ...composerSession('agent-1'), label: 'One original Agent' }
  const alias = { ...session, id: 'presentation-alias' }
  await mount(goal({ supervisorSessionId: 'presentation-alias', assigneeSessionIds: ['agent-1', 'presentation-alias', 'agent-1'] }), [session, alias])
  expect(faces()).toHaveLength(1)
  expect(label()).toContain('One original Agent · Supervisor / Executor')
  expect(faces()[0]!.dataset.avatarGroupKey).toBe(JSON.stringify(['actor', 'local', 'agent-1']))
})

it('keeps same-SID Source references distinct and never borrows a local namesake avatar or running state', async () => {
  const a = source('source-a'), b = source('source-b')
  await mount(goal({ supervisorSessionId: a, assigneeSessionIds: [structuredClone(a), b] }))
  expect(faces()).toHaveLength(2)
  expect(faces()[0]!.dataset.avatarGroupKey).not.toBe(faces()[1]!.dataset.avatarGroupKey)
  expect(label()).toContain('Supervisor / Executor'); expect(label()).toContain('Current presentation unconfirmed')
  expect(label()).toContain('source-a'); expect(label()).toContain('source-b')
  expect(label()).not.toContain('Original Agent 1')
  expect(group()!.querySelector('[data-executor-id]')).toBeNull()
  expect(group()!.querySelector('.status')).toBeNull()
})

it('keeps unavailable or ambiguous original references neutral and excludes historical linked Sessions from the team', async () => {
  const a = composerSession('agent-1'), b = { ...a, id: 'same-sid-another-host', hostId: 'other-host', control: { ...a.control, hostId: 'other-host' } }
  await mount(goal({ supervisorSessionId: 'missing-supervisor', assigneeSessionIds: ['agent-1'], sessionIds: ['agent-2', 'historical-only'] }), [a, b, composerSession('agent-2')])
  expect(faces()).toHaveLength(2)
  expect(label()).toContain('missing-supervisor'); expect(label()).toContain('agent-1')
  expect(label()).not.toContain('historical-only'); expect(label()).not.toContain('agent-2')
  expect(label()).toContain('Current presentation unconfirmed')
  expect(group()!.querySelector('.status--running')).toBeNull()
  expect(group()!.querySelector('[data-executor-id]')).toBeNull()
})

it('uses the original executor appearance and updates names while unrelated output causes no group rerender or RPC', async () => {
  const rendered = vi.spyOn(avatars, 'AvatarGroup')
  const rpc = vi.spyOn(api.demands, 'delegation')
  const sessions = [composerSession('agent-1'), ...Array.from({ length: 200 }, (_, i) => composerSession(`unrelated-${i}`))]
  await mount(goal({ supervisorSessionId: 'agent-1' }), sessions)
  const config = useAppStore.getState().config!
  await act(async () => useAppStore.setState({ config: { ...config, executors: { ...config.executors, codex: { ...config.executors.codex!, avatar: { tint: '#aabbcc' } } } }, agentNames: { 'agent-1': 'Accurate original name' } }))
  expect(label()).toContain('Accurate original name')
  expect(group()!.querySelector('[data-executor-id="codex"]')).not.toBeNull()
  expect(group()!.querySelector('feFlood[result="rimColor"]')?.getAttribute('flood-color')).toBe('#aabbcc')
  const calls = rendered.mock.calls.length, originalFaces = faces()
  await act(async () => { for (let i = 0; i < 12; i++) useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'unrelated-0' ? { ...session, updatedAt: i + 1, latestOutputBytes: i * 100 } : session) })) })
  expect(rendered).toHaveBeenCalledTimes(calls)
  expect(faces()).toEqual(originalFaces)
  expect(rpc).not.toHaveBeenCalled()
})
