// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it } from 'vitest'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { ACTIVITY_RETENTION_LIMIT, useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { notificationEventRows, notificationTrigger, selectNotificationView, toggleNotificationCenter } from './helpers/notification-center'

/**
 * Activity keeps a bounded window of the newest events so its cost grows with that window, not
 * with uptime. Over the limit the oldest read events go first, then the oldest unread ones; the
 * list says how many older events were not kept, and eviction is never reported as read or
 * resolved. Current problems that their owner has not settled are outside this bound.
 */
const dom = composerDOM()
beforeEach(() => useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], notificationEventsNotRetained: 0,
  noticeReadReceipts: {}, error: null, lastError: null, errorNoticeContext: null, errorDismissed: false, environmentWarning: undefined,
  runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [], displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {} }))

const report = (index: number) => useAppStore.getState().reportError(`Independent failure ${index}.`,
  { kind: 'indeterminate', summary: `Failure ${index}`, event: { source: 'operation', key: `failure-${index}` } })
const ids = () => useAppStore.getState().notificationEvents.map(event => event.message)

it('keeps the newest window of events and counts the ones it did not keep', () => {
  expect(ACTIVITY_RETENTION_LIMIT).toBe(256)
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + 10; index++) report(index)
  expect(useAppStore.getState().notificationEvents).toHaveLength(ACTIVITY_RETENTION_LIMIT)
  expect(ids()[0]).toBe('Independent failure 10.')
  expect(ids().at(-1)).toBe(`Independent failure ${ACTIVITY_RETENTION_LIMIT + 9}.`)
  expect(useAppStore.getState().notificationEventsNotRetained).toBe(10)
})

it('evicts the oldest read events before any unread one', () => {
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT; index++) report(index)
  const events = useAppStore.getState().notificationEvents
  // Read three events in the middle; they go before the oldest unread events.
  const read = Object.fromEntries([100, 101, 102].map(index => [events[index]!.id, 'read']))
  useAppStore.setState({ noticeReadReceipts: { 'global:events': read } })
  for (let index = ACTIVITY_RETENTION_LIMIT; index < ACTIVITY_RETENTION_LIMIT + 4; index++) report(index)
  const kept = ids()
  expect(kept).toHaveLength(ACTIVITY_RETENTION_LIMIT)
  for (const index of [100, 101, 102]) expect(kept).not.toContain(`Independent failure ${index}.`)
  // Only one unread event had to go: the oldest one.
  expect(kept).not.toContain('Independent failure 0.')
  expect(kept).toContain('Independent failure 1.')
  expect(useAppStore.getState().notificationEventsNotRetained).toBe(4)
  // Eviction is not reading: the released read receipts go with their records.
  expect(Object.keys(useAppStore.getState().noticeReadReceipts['global:events'] ?? {})).toEqual([])
})

it('never evicts a current problem that its owner has not settled', () => {
  useAppStore.getState().reportError('A lifecycle failure that is still current.', { kind: 'indeterminate', summary: 'Launch failed',
    lifecycle: { step: 'launch', tabId: 'tab', regionId: 'region' } })
  const current = useAppStore.getState().notificationEvents[0]!
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + 5; index++) report(index)
  expect(useAppStore.getState().notificationEvents).toContain(current)
  expect(useAppStore.getState().notificationEvents.filter(event => event !== current)).toHaveLength(ACTIVITY_RETENTION_LIMIT)
})

it('a repeat of a kept event takes no new place', () => {
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT; index++) report(index)
  for (let index = 0; index < 20; index++) report(5)
  expect(useAppStore.getState().notificationEvents).toHaveLength(ACTIVITY_RETENTION_LIMIT)
  expect(useAppStore.getState().notificationEventsNotRetained).toBe(0)
})

it('the Activity list says how many older events were not kept, without calling them read', async () => {
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + 3; index++) report(index)
  await dom.render(<GlobalSystemNotices />)
  await toggleNotificationCenter(dom.container, 'open')
  await selectNotificationView(dom.container, 'history')
  expect(notificationEventRows(dom.container).length).toBeGreaterThan(0)
  const note = dom.container.querySelector('.global-system-notices__retention')
  expect(note?.textContent).toBe(`3 older events were not kept. Activity keeps the newest ${ACTIVITY_RETENTION_LIMIT}.`)
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain(`${ACTIVITY_RETENTION_LIMIT} unread`)
  await act(async () => { useAppStore.setState({ notificationEventsNotRetained: 0 }) })
  expect(dom.container.querySelector('.global-system-notices__retention')).toBeNull()
})

it('the CLI reader reports the same not-kept count with an Activity read', async () => {
  const { observeNotifications } = await import('../src/renderer/src/lib/notification-observation')
  const { parseClientNotificationsObservation } = await import('@agentmux/core/control')
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + 2; index++) report(index)
  await dom.render(<GlobalSystemNotices />)
  const target = { domain: 'client.notifications' as const, hostId: 'local', list: { section: 'activity' as const, limit: 4 } }
  const observation = observeNotifications({ schemaVersion: 1, requestId: 'retention-read', operation: 'inspect.notifications',
    target, includeRaw: false, maxBytes: 64 * 1024 } as never)
  const parsed = parseClientNotificationsObservation(observation, target, false)
  expect(parsed.data?.total).toBe(ACTIVITY_RETENTION_LIMIT)
  expect(parsed.data?.activityNotRetained).toBe(2)
  const current = parseClientNotificationsObservation(observeNotifications({ schemaVersion: 1, requestId: 'current-read', operation: 'inspect.notifications',
    target: { ...target, list: { section: 'current', limit: 4 } }, includeRaw: false, maxBytes: 64 * 1024 } as never), { ...target, list: { section: 'current', limit: 4 } }, false)
  expect(current.data?.activityNotRetained, 'a Current read does not report Activity retention').toBeUndefined()
})
