// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { DemandAgentReference } from '@agentmux/demand/relations'
import * as contexts from '../src/renderer/src/lib/focus-context'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import * as avatars from '@agentmux/client-ui/components/AvatarGroup'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { api } from '../src/renderer/src/lib/api'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM({ agentInformation: true })
const goal = (patch: Partial<DemandRecord> = {}): DemandRecord => ({ id: 'team-goal', title: 'Goal with original Agents', description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  source: 'session', sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null, createdAt: 1, updatedAt: 1, ...patch })
const group = () => dom.container.querySelector<HTMLElement>('[data-goal-agent-group="team-goal"]')
const faces = () => [...group()!.querySelectorAll<HTMLElement>('[data-avatar-group-key]')]
const label = () => group()?.querySelector('.avatar-group[role="group"]')?.getAttribute('aria-label')
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
    expect(group()!.querySelectorAll('button')).toHaveLength(Math.min(count, 3) + 1 + (count > 3 ? 1 : 0))
    expect(group()!.querySelector('[aria-hidden="true"] button')).toBeNull()
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


it('enters the original Agent Reader on click without selecting the Goal and resolves detail only on intent', async () => {
  const context = vi.spyOn(contexts, 'agentContextForSession')
  const session = composerSession('agent-1')
  const source = { providerId: 'codex', nativeSessionId: 'original-native-agent' }
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ agentSessionId: 'agent-1', source, nextCursor: null, items: [{ id: 'original-reply', kind: 'assistant-message', startedAt: 1, contentParts: [{ kind: 'text', text: 'Original Agent detail' }] }] })
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source, dispose() {} })
  await mount(goal({ supervisorSessionId: 'agent-1', assigneeSessionIds: ['agent-1'] }), [session])
  await agentCardConversationFixture(() => source)
  const before = useAppStore.getState(), trigger = faces()[0]!.querySelector<HTMLButtonElement>('button')!
  expect(context).not.toHaveBeenCalled(); expect(api.sessions.historyPage).not.toHaveBeenCalled()
  await act(async () => trigger.click())
  await waitForAgentCardReading(() => expect(document.querySelector('.agent-information-reader')).not.toBeNull())
  expect(context).toHaveBeenCalled()
  expect(context.mock.calls.every(([subject]) => subject.id === 'agent-1' && subject.control.hostId === 'local')).toBe(true)
  expect(agentInformationPreview.get()?.context.id).toBe('agent-1')
  expect(agentInformationPreview.get()?.control).toEqual(session.control)
  expect(useAppStore.getState().selectedDemandId).toBeNull(); expect(useAppStore.getState().mainSurface).toBe('board')
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  const original = document.querySelector('.agent-information-reader')!
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  expect(document.querySelector('.agent-information-reader')).toBe(original)
  await act(async () => { trigger.focus(); trigger.click() })
  expect(document.querySelector('.agent-information-reader')).toBe(original)
  expect(document.activeElement?.classList.contains('agent-information-reader__reading')).toBe(true)
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('.agent-information-reader')).toBeNull(); expect(document.activeElement).toBe(trigger)
})

it('reveals all current members with roles from Agents and overflow without opening the Goal', async () => {
  await mount(goal({ supervisorSessionId: 'agent-1', assigneeSessionIds: ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'], sessionIds: ['historical-only'] }))
  const trigger = group()!.querySelector<HTMLButtonElement>('.goal-agent-group__overflow')!
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  const menu = document.querySelector('.goal-agent-menu')!
  expect(menu).not.toBeNull(); expect(menu.querySelectorAll('.goal-agent-menu__member')).toHaveLength(5)
  expect(menu.textContent).toContain('Original Agent 5'); expect(menu.textContent).toContain('Supervisor / Executor')
  expect(menu.textContent).not.toContain('historical-only'); expect(useAppStore.getState().selectedDemandId).toBeNull()
})

it('keeps unresolved Source details readable without targeting the local namesake Reader', async () => {
  await mount(goal({ supervisorSessionId: source('source-a') }))
  const trigger = faces()[0]!.querySelector<HTMLButtonElement>('button')!
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  const menu = document.querySelector('.goal-agent-menu')!
  expect(menu.textContent).toContain('source-a'); expect(menu.textContent).toContain('original-region')
  expect(menu.textContent).toContain('Current presentation unconfirmed'); expect(menu.textContent).not.toContain('Original Agent 1')
  expect(menu.querySelector('button')).toBeNull(); expect(document.querySelector('.agent-information-reader')).toBeNull()
  expect(useAppStore.getState().selectedDemandId).toBeNull()
})
