// @vitest-environment happy-dom
import { fixtureEpoch as _privacyFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { useAppStore, type ErrorNoticeContext } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { notificationTrigger, toggleNotificationCenter, toggleNotificationDetails } from './helpers/notification-center'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], noticeReadReceipts: {},
  error: null, lastError: null, errorNoticeContext: null, environmentWarning: undefined, runtimeOwnershipWarnings: [],
  runtimeEndpointWarnings: [], displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {},
  sessionNameMetadataWarning: null, workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null,
  desktopNavigationNotice: null, startupAgentAvailability: undefined } as never))
const rows = () => [...dom.container.querySelectorAll<HTMLElement>('.notification-item')]
const groups = () => [...dom.container.querySelectorAll<HTMLElement>('.notification-group[data-group-id]')]
const unread = () => Number(notificationTrigger(dom.container).getAttribute('aria-label')?.match(/(\d+) unread/u)?.[1])
async function history() {
  await dom.render(<GlobalSystemNotices />)
  await toggleNotificationCenter(dom.container, 'open')
  await dom.click('[role="tab"][data-section="history"]')
}

it('event metadata: explicit source and original object select the category while equal prose retains distinct targets', async () => {
  const session = { ...composerSession('original-agent'), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }
  useAppStore.setState({ sessions: [session] })
  const common = 'The original observation is unavailable.'
  for (const id of ['first-document', 'second-document']) useAppStore.getState().reportError(common, {
    kind: 'indeterminate', event: { source: 'operation', key: 'same-source-operation', object: { kind: 'document', id, hostId: 'local', workspaceId: 'workspace' } }
  })
  useAppStore.getState().reportError(common, { kind: 'process-degraded', event: {
    source: 'desktop-notifications', key: 'original-platform-receipt', object: { kind: 'application', id: 'desktop' }
  } })
  useAppStore.getState().reportError(common, { kind: 'indeterminate', event: {
    source: 'operation', key: 'original-host-receipt', object: { kind: 'host', id: 'original-remote-host' }
  } })
  useAppStore.getState().reportError(common, { kind: 'indeterminate', subject: session.control,
    event: { source: 'agent-attention', key: 'original-attention-receipt' } })
  const original = useAppStore.getState().notificationEvents
  await history()
  expect(rows()).toHaveLength(5)
  expect(groups()).toHaveLength(5)
  for (const [category, expected] of [['system', 1], ['connections', 1], ['agents', 1], ['operations', 2]] as const) {
    await dom.click(`button[data-category="${category}"]`)
    expect(rows(), category).toHaveLength(expected)
    expect(groups().every(group => group.dataset.category === category)).toBe(true)
  }
  expect(new Set(groups().map(group => group.dataset.groupId)).size).toBe(2)
  for (const [index, id] of ['first-document', 'second-document'].entries()) {
    const row = rows().find(item => item.dataset.eventId === original[index]!.id)!
    await toggleNotificationDetails(row)
    const detail = row.querySelector('.notification-item__original')!.textContent!
    for (const originalIdentity of [id, 'operation', 'same-source-operation', 'local', 'workspace']) expect(detail).toContain(originalIdentity)
  }
  expect(unread()).toBe(3)
  expect(useAppStore.getState().notificationEvents).toBe(original)
  expect(useAppStore.getState().sessions[0]).toBe(session)
})

it('event metadata: repeat receipt time and observations render without restarting the original unread identity', async () => {
  const firstTime = _privacyFixtureEpoch(20746, 29700), lastTime = firstTime + 90000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(firstTime)
  const context: ErrorNoticeContext = { kind: 'process-degraded', summary: 'Desktop banner duration is controlled by the platform',
    event: { source: 'desktop-notifications', key: 'duration-presentation', object: { kind: 'application', id: 'desktop' } } }
  useAppStore.getState().reportError('Original delivery receipt.', context)
  await history()
  const originalId = rows()[0]!.dataset.eventId
  const firstReceipt = rows()[0]!.querySelector('time')
  expect(firstReceipt, 'The original receipt time reaches the actual notification row').not.toBeNull()
  expect(firstReceipt?.getAttribute('datetime')).toBe(new Date(firstTime).toISOString())
  expect(firstReceipt?.textContent).toMatch(/Received/i)
  await toggleNotificationDetails(rows()[0]!)
  expect(unread()).toBe(0)
  clock.mockReturnValue(lastTime)
  await act(async () => useAppStore.getState().reportError('The same limitation was observed by the second original consumer.', context))
  expect(rows()).toHaveLength(1)
  expect(rows()[0]!.dataset.eventId).toBe(originalId)
  expect(rows()[0]!.textContent).toContain('2 observations')
  expect(rows()[0]!.querySelector('time')!.getAttribute('datetime')).toBe(new Date(lastTime).toISOString())
  expect(rows()[0]!.querySelector('time')!.textContent).toMatch(/received/i)
  const detail = rows()[0]!.querySelector('.notification-item__original')!.textContent!
  for (const value of ['desktop-notifications', 'duration-presentation', 'desktop', new Date(firstTime).toISOString(), new Date(lastTime).toISOString()]) expect(detail).toContain(value)
  expect(unread()).toBe(0)
  expect(useAppStore.getState().notificationEvents[0]).toMatchObject({ firstObservedAt: firstTime, lastObservedAt: lastTime, occurrences: 2 })
})

it('event metadata: original launcher targets remain separate and retain every independent operation within one object', async () => {
  useAppStore.setState({ layouts: { workspace: createWorkspaceLayout('present-group') } })
  const before = useAppStore.getState()
  for (const tabGroupId of ['first-missing-group', 'second-missing-group', 'first-missing-group'])
    useAppStore.getState().openLauncher({ workspaceId: 'workspace', tabGroupId, reveal: false })
  const records = useAppStore.getState().notificationEvents
  expect(records).toHaveLength(3)
  expect(records.map(record => record.context?.event?.object?.id)).toEqual(['first-missing-group', 'second-missing-group', 'first-missing-group'])
  await history(); await dom.click('button[data-category="operations"]')
  expect(groups()).toHaveLength(2)
  expect(rows()).toHaveLength(2)
  const more = dom.container.querySelector<HTMLButtonElement>('.notification-group__more')!
  expect(more).toBeTruthy()
  await act(async () => more.click())
  expect(rows()).toHaveLength(3)
  expect(new Set(rows().map(item => item.dataset.eventId)).size).toBe(3)
  expect(useAppStore.getState().notificationEvents).toBe(records)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

it('event metadata: an explicit spatial target owns grouping while associated Sessions retain exact navigation', async () => {
  const sessions = ['source-agent-one', 'source-agent-two'].map(id => ({ ...composerSession(id),
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }))
  const select = vi.fn()
  useAppStore.setState({ sessions, selectSession: select })
  for (const session of sessions) useAppStore.getState().reportError('The requested original Tab Group is unavailable.', {
    kind: 'indeterminate', subject: session.control, event: { source: 'spatial', key: `navigate-${session.id}`,
      object: { kind: 'tab-group', id: 'same-original-group', workspaceId: 'workspace' } }
  })
  const original = useAppStore.getState().notificationEvents
  await history(); await dom.click('button[data-category="agents"]')
  expect(rows()).toHaveLength(0)
  await dom.click('button[data-category="operations"]')
  expect(groups()).toHaveLength(1)
  expect(groups()[0]!.textContent).toContain('same-original-group')
  const more = dom.container.querySelector<HTMLButtonElement>('.notification-group__more')!
  expect(more).toBeTruthy()
  await act(async () => more.click())
  expect(rows()).toHaveLength(2)
  const row = rows().find(item => item.dataset.eventId === original[0]!.id)!
  const action = row.querySelector<HTMLButtonElement>('.notification-item__action')
  expect(action).not.toBeNull()
  await act(async () => action!.click())
  expect(select).toHaveBeenCalledExactlyOnceWith(sessions[0]!.id)
  expect(useAppStore.getState().notificationEvents).toBe(original)
  expect(useAppStore.getState().sessions).toBe(sessions)
})

it('event metadata: legacy missing identity and time stay independent without fabricated source or receipt time', async () => {
  const original = ['legacy-first', 'legacy-second'].map(id => ({ id, message: 'Same preserved original diagnostic.', context: null }))
  useAppStore.setState({ notificationEvents: original })
  await history()
  expect(groups()).toHaveLength(2)
  expect(rows()).toHaveLength(2)
  expect(dom.container.querySelectorAll('.notification-item time')).toHaveLength(0)
  expect(rows().every(row => !row.textContent!.includes('observations'))).toBe(true)
  expect(groups().every(group => group.textContent!.includes('Object not recorded'))).toBe(true)
  await toggleNotificationDetails(rows()[0]!)
  const detail = rows()[0]!.querySelector('.notification-item__original')!.textContent!
  expect(detail).toContain(original[0]!.message)
  expect(detail).not.toContain('Source: operation')
  expect(useAppStore.getState().notificationEvents).toBe(original)
})
