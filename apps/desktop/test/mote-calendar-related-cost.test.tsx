// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { MoteCalendar } from '../src/renderer/src/components/MoteCalendar'
import * as moteMaterials from '../src/renderer/src/lib/mote-materials-actions'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { composerDOM } from './helpers/composer-dom-fixture'
import { seedMoteWorkface, defaultAgent, neighborAgent, executionAgent, defaultTab, scratchWorkspace, moteTopics } from './fixtures/mote-workface'
import { scratchTopicDirectoryName } from '../src/shared/scratch-topics'
import type { MoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'

const dom = composerDOM()
const topic = { ...moteTopics[0]!, physicalDirectoryPath: defaultAgent.workspacePath, confirmedDirectoryPaths: [defaultAgent.workspacePath] }
const scope: MoteWorkfaceScope = { workspace: scratchWorkspace, topic, rootPath: scratchTopicDirectoryName(topic.id) }
const reference = { displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: 'default-region' }
const target = { hostId: defaultAgent.hostId, providerId: defaultAgent.providerId, workspacePath: defaultAgent.workspacePath, agentSessionId: defaultAgent.control.agentSessionId }
const saved = (): ContinuousProgressLoop => ({ ...target, loopId: 'own-arrangement', afterMs: 90_000, intervalMs: 1_000,
  nextCheckAt: Date.now() + 90_000, prompt: 'Original arranged input', status: 'active', revision: 1,
  creationOperationId: 'original-create', futureIntentId: 'original-future' })
beforeEach(() => {
  seedMoteWorkface(); useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [saved()], executionScope: 'connected-host' })
  vi.spyOn(api.schedule, 'onChanged').mockReturnValue(() => {})
})
async function mounted() {
  const confirmed = vi.spyOn(moteMaterials, 'confirmedMoteReference')
  let commits = 0
  await dom.render(<Profiler id="calendar" onRender={() => { commits++ }}><MoteCalendar scope={scope} reference={reference} active /></Profiler>)
  await vi.waitFor(() => expect(dom.container.querySelector('[data-schedule-id="own-arrangement"]')).not.toBeNull())
  expect(dom.container.textContent).toContain(defaultAgent.label)
  return { confirmed, commits: () => commits }
}
async function foreignStatus(index: number) {
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: executionAgent.hostId, event: {
    type: 'agent-status', agentSessionId: executionAgent.id, state: index % 2 ? 'working' : 'done',
    evidence: { source: 'native-hook', observedAt: Date.now() + index + 1 }
  } }))
}
it('keeps original confirmation and Calendar rendering out of unrelated accepted Session updates', async () => {
  const h = await mounted(), confirmations = h.confirmed.mock.calls.length, commits = h.commits()
  const calendar = dom.container.querySelector('[aria-label="Mote calendar"]')!
  const row = dom.container.querySelector('[data-schedule-id="own-arrangement"]')!, range = document.createRange()
  range.selectNodeContents(row.querySelector('p') ?? row); const selection = document.getSelection()!
  selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString()
  expect(selected.length).toBeGreaterThan(0)
  for (let index = 0; index < 40; index++) await foreignStatus(index)
  expect(useAppStore.getState().sessions.find(session => session.id === executionAgent.id)!.status.state).toBe('working')
  expect.soft(h.confirmed.mock.calls.length - confirmations).toBe(0)
  expect.soft(h.commits() - commits).toBe(0)
  expect(dom.container.querySelector('[aria-label="Mote calendar"]')).toBe(calendar)
  expect(dom.container.querySelector('[data-schedule-id="own-arrangement"]')).toBe(row)
  expect(selection.toString()).toBe(selected); expect(selection.getRangeAt(0)).toBe(range)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})
it('updates exact discussion labels and ambiguity without rebuilding spatial confirmation', async () => {
  const h = await mounted(), confirmations = h.confirmed.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === defaultAgent.id ? { ...session, label: 'Changed original discussion' } : session) })))
  expect(dom.container.textContent).toContain('Changed original discussion')
  expect.soft(h.confirmed.mock.calls.length).toBe(confirmations)
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, { ...defaultAgent, id: 'other-presentation', label: 'Ambiguous original discussion' }] })))
  expect(dom.container.textContent).toContain('Original discussion unconfirmed')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== 'other-presentation') })))
  expect(dom.container.textContent).toContain('Changed original discussion')
})
it('invalidates original spatial membership while Session identity changes still update the selected target', async () => {
  const h = await mounted(), confirmations = h.confirmed.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ tabs: { ...state.tabs, [defaultTab.id]: { ...state.tabs[defaultTab.id]!, regions: {
    ...state.tabs[defaultTab.id]!.regions, [reference.regionId]: { ...state.tabs[defaultTab.id]!.regions[reference.regionId]!, sessionId: neighborAgent.id }
  } } } })))
  expect(h.confirmed.mock.calls.length).toBeGreaterThan(confirmations)
  const create = vi.spyOn(api.schedule, 'create').mockRejectedValue(new Error('Original request kept for consumer inspection'))
  const details = dom.container.querySelector<HTMLDetailsElement>('.schedule-create')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  const input = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Arranged message"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep the exact selected discussion')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(create).toHaveBeenCalledTimes(1)
  expect(create.mock.calls[0]![0].target.agentSessionId).toBe(neighborAgent.control.agentSessionId)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === neighborAgent.id && session.kind === 'agent'
    ? { ...session, control: { ...session.control, hostId: 'unconfirmed-control-host' } } : session) })))
  // The already edited form owns its captured target even after live context changes.
  expect(input.value).toBe('Keep the exact selected discussion')
  expect(create).toHaveBeenCalledTimes(1)
  const before = h.confirmed.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ layouts: { ...state.layouts, [scratchWorkspace.id]: { ...state.layouts[scratchWorkspace.id]!, groups: [] } } })))
  expect(h.confirmed.mock.calls.length).toBeGreaterThan(before)
  expect(h.confirmed.mock.results.at(-1)?.value).toBeNull()
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})
it('withdraws a changed control Host from the next pristine arrangement target', async () => {
  const h = await mounted(), confirmations = h.confirmed.mock.calls.length
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === defaultAgent.id && session.kind === 'agent'
    ? { ...session, control: { ...session.control, hostId: 'another-control-host' } } : session) })))
  const details = dom.container.querySelector<HTMLDetailsElement>('.schedule-create')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(dom.container.textContent).toContain('Choose an exact discussion')
  expect(h.confirmed.mock.calls.length).toBe(confirmations)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
})
