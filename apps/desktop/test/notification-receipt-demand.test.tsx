// @vitest-environment happy-dom
import { act } from 'react'
import { appendFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { useAppStore } from '../src/renderer/src/store'
import { useReadReceipts, useServiceNotices, type ServiceNoticeItem } from '../src/renderer/src/lib/use-service-notices'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { notificationEventRows, notificationTrigger, toggleNotificationCenter } from './helpers/notification-center'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], noticeReadReceipts: {},
  error: null, lastError: null, errorNoticeContext: null, environmentWarning: undefined, runtimeOwnershipWarnings: [],
  runtimeEndpointWarnings: [], displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {} }))

it.each([1, 32, 256])('reuses receipts for %i unchanged events while unrelated original Session statuses stay live', async count => {
  const session = { ...composerSession('receipt-owner-control'), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } }
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Original draft' } })
  for (let index = 0; index < count; index++) useAppStore.getState().reportError(`Original notification ${index}`)
  const records = useAppStore.getState().notificationEvents, ids = new Set(records.map(event => event.id))
  useAppStore.setState({ noticeReadReceipts: { 'global:events': Object.fromEntries(records.map(event => [event.id, 'read'])) } })
  await dom.render(<GlobalSystemNotices />)
  const originalLabel = notificationTrigger(dom.container).getAttribute('aria-label')
  expect(originalLabel).toContain(`${count} recent events`)
  const work = { eventMaps: 0, eventRows: 0, receiptSignatures: 0, signatureCharacters: 0 }
  const originalMap = records.map.bind(records), originalStringify = JSON.stringify
  const map = vi.spyOn(records, 'map').mockImplementation((callback, thisArg) => {
    work.eventMaps++; work.eventRows += records.length
    return originalMap(callback, thisArg)
  })
  const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    const output = originalStringify(value, replacer as never, space)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value)
      if (entries.length === count && entries.every(([id, read]) => ids.has(id) && read === 'read')) {
        work.receiptSignatures++; work.signatureCharacters += output.length
      }
    }
    return output
  })
  try {
    for (let index = 0; index < 5; index++) await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'agent-status', agentSessionId: session.id, state: 'working', evidence: { source: 'native-hook', observedAt: index + 2 }
    } }))
    expect(useAppStore.getState().notificationEvents).toBe(records)
    expect(useAppStore.getState().sessions[0]!.status.observedAt).toBe(6)
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original draft')
    expect(notificationTrigger(dom.container).getAttribute('aria-expanded')).toBe('false')
    expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe(originalLabel)
    expect(notificationEventRows(dom.container)).toHaveLength(0)
    if (process.env.AGENTMUX_NOTIFICATION_RECEIPT_SAMPLES) appendFileSync(process.env.AGENTMUX_NOTIFICATION_RECEIPT_SAMPLES, originalStringify({ count, statusEvents: 5, ...work }) + '\n')
    expect(work, 'Unchanged history and receipts must not redo history-sized work').toEqual({ eventMaps: 0, eventRows: 0, receiptSignatures: 0, signatureCharacters: 0 })
  } finally { map.mockRestore(); stringify.mockRestore() }
})

it('updates closed announcements and read state for new history, exact receipt changes and clearing', async () => {
  await dom.render(<GlobalSystemNotices />)
  await act(async () => useAppStore.getState().reportError('First original failure'))
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('1 unread')
  const announcement = () => dom.container.querySelector('.global-system-notices__announcement')!
  expect(announcement().textContent).toContain('First original failure')
  const first = useAppStore.getState().notificationEvents[0]!
  await act(async () => useAppStore.setState({ noticeReadReceipts: { 'global:events': { [first.id]: 'read' } } }))
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('0 unread')
  expect(announcement().textContent).toBe('')
  await act(async () => useAppStore.getState().reportError('Second original failure'))
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('1 unread')
  expect(announcement().textContent).toContain('Second original failure')
  await act(async () => useAppStore.getState().clearReadNotificationEvents())
  expect(useAppStore.getState().notificationEvents.map(event => event.message)).toEqual(['Second original failure'])
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('1 recent events')
  await toggleNotificationCenter(dom.container, 'open')
  expect(notificationEventRows(dom.container)).toHaveLength(1)
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('0 unread')
  await toggleNotificationCenter(dom.container, 'closed')
  await act(async () => useAppStore.getState().clearReadNotificationEvents())
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('0 recent events')
})

it('keeps same-ID original message, summary and announcement urgency current', async () => {
  useAppStore.getState().reportError('Original message')
  const event = useAppStore.getState().notificationEvents[0]!
  await dom.render(<GlobalSystemNotices />)
  const announcement = () => dom.container.querySelector('.global-system-notices__announcement')!
  await act(async () => useAppStore.setState({ notificationEvents: [{ ...event, message: 'Updated original message' }] }))
  expect(announcement().textContent).toContain('Updated original message')
  await act(async () => useAppStore.setState({ notificationEvents: [{ ...event, message: 'Updated original message', context: { kind: 'agent-broken', summary: 'Original urgent summary' } }] }))
  expect(announcement().textContent).toContain('Original urgent summary')
  expect(announcement().getAttribute('aria-live')).toBe('assertive')
  expect(useAppStore.getState().notificationEvents[0]!.id).toBe(event.id)
  await toggleNotificationCenter(dom.container, 'open')
  expect(notificationEventRows(dom.container)[0]!.textContent).toContain('Original urgent summary')
})

it('prunes only complete available owner receipts and keeps exact scope acknowledgements distinct', async () => {
  const current = { retained: 'original-cause', changed: 'current-cause' }
  useAppStore.setState({ noticeReadReceipts: { first: { retained: 'original-cause', changed: 'old-cause', absent: 'retained-until-complete' }, second: { changed: 'current-cause' } } })
  let read!: ReturnType<typeof useReadReceipts>
  function Consumer({ scope = 'first', available = true, complete = true }: { scope?: string; available?: boolean; complete?: boolean }) {
    read = useReadReceipts(scope, current, available, complete)
    return <output>{read.unread.join(',')}</output>
  }
  await dom.render(<Consumer available={false} />)
  expect(read.unread).toEqual(['changed'])
  expect(useAppStore.getState().noticeReadReceipts.first).toHaveProperty('absent')
  await dom.render(<Consumer complete={false} />)
  expect(useAppStore.getState().noticeReadReceipts.first).toHaveProperty('absent')
  await dom.render(<Consumer />)
  expect(useAppStore.getState().noticeReadReceipts.first).toEqual({ retained: 'original-cause' })
  await act(async () => read.acknowledge(['changed']))
  expect(read.unread).toEqual([])
  await dom.render(<Consumer scope="second" />)
  expect(read.unread).toEqual(['retained'])
  expect(useAppStore.getState().noticeReadReceipts.first).toEqual(current)
})

it('reevaluates a mutable service notice cause without treating changed display text as a new occurrence', async () => {
  const notice: ServiceNoticeItem = { id: 'original-service', cause: 'original-cause', notice: { kind: 'indeterminate', notice: {
    step: 'Original operation', mode: 'Unconfirmed receipt', restore: 'Keep the original operation' }
  } }
  const notices = [notice]
  let inbox!: ReturnType<typeof useServiceNotices>
  function Consumer({ tick }: { tick: number }) {
    inbox = useServiceNotices('original-service-owner', notices)
    return <output data-tick={tick}>{notice.notice.notice.mode} · {inbox.unread.length}</output>
  }
  await dom.render(<Consumer tick={0} />)
  await act(async () => inbox.acknowledge(inbox.unread))
  expect(inbox.unread).toEqual([])
  const prior = useAppStore.getState().noticeReadReceipts['original-service-owner']!['original-service']
  notice.notice.notice.mode = 'Updated explanation of the same cause'
  await dom.render(<Consumer tick={1} />)
  expect(inbox.unread).toEqual([])
  expect(dom.container.textContent).toContain('Updated explanation')
  notice.cause = 'changed-original-cause'
  await dom.render(<Consumer tick={2} />)
  expect(inbox.unread).toEqual([notice])
  await act(async () => inbox.acknowledge(inbox.unread))
  expect(useAppStore.getState().noticeReadReceipts['original-service-owner']!['original-service']).not.toBe(prior)
  expect(inbox.unread).toEqual([])
})
