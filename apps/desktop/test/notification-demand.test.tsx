// @vitest-environment happy-dom
import { act } from 'react'
import { appendFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { NotificationItem } from '../src/renderer/src/components/NotificationItem'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import * as notificationStore from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { notificationEventRows, notificationTrigger, toggleNotificationCenter, toggleNotificationDetails, selectNotificationView } from './helpers/notification-center'

const dom = composerDOM(), prefix = 'NOTIFICATION_COST '
beforeEach(() => useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], noticeReadReceipts: {},
  error: null, lastError: null, errorNoticeContext: null, environmentWarning: undefined, runtimeOwnershipWarnings: [],
  runtimeEndpointWarnings: [], displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {} }))
function sample(value: unknown) {
  if (process.env.AGENTMUX_NOTIFICATION_SAMPLES) appendFileSync(process.env.AGENTMUX_NOTIFICATION_SAMPLES, JSON.stringify(value) + '\n')
}
function measurePreviewReads() {
  const original = String.prototype[Symbol.iterator], calls = { points: 0 }
  const spy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (this: string) {
    const iterator = original.call(this), measured = String(this).startsWith(prefix)
    return { [Symbol.iterator]() { return this }, next() {
      const result = iterator.next()
      if (measured) ++calls.points
      return result
    } } as ReturnType<typeof original>
  })
  return { calls, restore: () => spy.mockRestore() }
}

it.each([2, 32])('derives one original workflow identity across %i records and unrelated Session updates', async count => {
  const session = { ...composerSession('notification-owner-control'), status: {
    state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now()
  } }
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Keep the draft' } })
  for (let index = 0; index < count; index++) useAppStore.getState().reportError(`Original failure ${index}: ${'x'.repeat(32768)}`)
  const records = useAppStore.getState().notificationEvents
  const identity = vi.spyOn(notificationStore, 'notificationEventIdentity')
  await dom.render(<GlobalSystemNotices />)
  expect(identity).toHaveBeenCalledExactlyOnceWith(useAppStore.getState().error, useAppStore.getState().errorNoticeContext)
  identity.mockClear()
  for (let index = 0; index < 10; index++) await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: session.id, state: 'working', evidence: { source: 'native-hook', observedAt: Date.now() }
  } }))
  await dom.render(<GlobalSystemNotices />)
  expect(identity).not.toHaveBeenCalled()
  expect(useAppStore.getState().notificationEvents).toBe(records)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the draft')
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe(`System notifications: ${count} unread, 0 current, ${count} recent events`)
  await toggleNotificationCenter(dom.container, 'open'); await selectNotificationView(dom.container, 'history')
  expect(notificationEventRows(dom.container)).toHaveLength(count)
  await toggleNotificationCenter(dom.container, 'closed')
  expect(identity).not.toHaveBeenCalled()
})

it('refreshes the original workflow identity when its full error or eligible context changes', async () => {
  const original = `${prefix}${'x'.repeat(160)}`
  useAppStore.getState().reportError(`${original} first`)
  const firstRecord = useAppStore.getState().notificationEvents[0]!
  const identity = vi.spyOn(notificationStore, 'notificationEventIdentity')
  await dom.render(<GlobalSystemNotices />)
  identity.mockClear()
  await act(async () => useAppStore.getState().reportError(`${original} second`))
  expect(identity).toHaveBeenCalledExactlyOnceWith(`${original} second`, useAppStore.getState().errorNoticeContext)
  const records = useAppStore.getState().notificationEvents
  expect(records).toHaveLength(2)
  expect(records[0]).toBe(firstRecord)
  expect(records[0]!.id).not.toBe(records[1]!.id)
  identity.mockClear()
  const context = { kind: 'process-degraded' as const, summary: 'Original pending operation' }
  await act(async () => useAppStore.setState({ errorNoticeContext: context }))
  expect(identity).toHaveBeenCalledExactlyOnceWith(`${original} second`, context)
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('1 current')
  identity.mockClear()
  await act(async () => useAppStore.setState({ errorDismissed: true }))
  expect(identity).not.toHaveBeenCalled()
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('0 current')
  await act(async () => useAppStore.setState({ errorDismissed: false }))
  expect(identity).toHaveBeenCalledExactlyOnceWith(`${original} second`, context)
  expect(notificationTrigger(dom.container).getAttribute('aria-label')).toContain('1 current')
  expect(useAppStore.getState().notificationEvents).toBe(records)
})

it.each([[1, 262144], [32, 1024]])('keeps closed history out of presentation and reads only short previews: %i events, %i characters', async (count, size) => {
  const session = { ...composerSession('unrelated'), status: { state: 'working' as const,
    source: 'native-hook' as const, observedAt: Date.now() } }
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Keep the original draft' } })
  await act(async () => {
    for (let index = 0; index < count; index++) useAppStore.getState().reportError(`${prefix}${index} ` + 'x'.repeat(size))
  })
  const records = useAppStore.getState().notificationEvents, measured = measurePreviewReads()
  try {
    await dom.render(<GlobalSystemNotices />)
    expect(notificationTrigger(dom.container).getAttribute('aria-label')).toBe(`System notifications: ${count} unread, 0 current, ${count} recent events`)
    expect(notificationEventRows(dom.container)).toEqual([])
    expect(dom.container.querySelector('.notification-item__original')).toBeNull()
    expect(measured.calls.points).toBeGreaterThan(0)
    expect(measured.calls.points).toBeLessThanOrEqual(101)
    expect(dom.container.querySelector('.global-system-notices__announcement')!.textContent).toContain(prefix)
    measured.calls.points = 0
    await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'agent-status', agentSessionId: session.id, state: 'working', evidence: { source: 'native-hook', observedAt: Date.now() }
    } }))
    expect(measured.calls.points).toBe(0)
    expect(useAppStore.getState().notificationEvents).toBe(records)
    expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the original draft')
    await toggleNotificationCenter(dom.container, 'open'); await selectNotificationView(dom.container, 'history')
    const rows = notificationEventRows(dom.container)
    expect(rows).toHaveLength(count)
    expect(dom.container.querySelector('.notification-item__original')).toBeNull()
    expect(measured.calls.points).toBeLessThanOrEqual(101 * count)
    await toggleNotificationDetails(rows[0]!)
    expect(rows[0]!.querySelector('.notification-item__original')!.textContent).toContain(records.at(-1)!.message)
    expect(rows[0]!.querySelector('.notification-item__original')!.getAttribute('aria-label')!.length).toBeLessThan(130)
    await toggleNotificationCenter(dom.container, 'closed')
    expect(notificationEventRows(dom.container)).toEqual([])
    expect(useAppStore.getState().notificationEvents).toBe(records)
    expect(notificationTrigger(dom.container).getAttribute('data-unread')).toBe(count === 1 ? 'false' : 'true')
    sample({ kind: 'history-demand', count, size, rowsWhenOpen: rows.length, measuredPreviewPoints: measured.calls.points,
      sameRecords: useAppStore.getState().notificationEvents === records })
  } finally { measured.restore() }
})

it('keeps children lazy until the original native Details opens', async () => {
  const content = vi.fn(() => <p>Complete original child body</p>)
  const Content = content
  await dom.render(<NotificationItem title="Original operation" kind="indeterminate" detail="Complete original child body"><Content /></NotificationItem>)
  const row = dom.container.querySelector('.notification-item')!
  expect(content).not.toHaveBeenCalled()
  await toggleNotificationDetails(row)
  expect(content).toHaveBeenCalledOnce()
  expect(row.textContent).toContain('Complete original child body')
  await toggleNotificationDetails(row, false)
  expect(row.querySelector('.notification-item__original')).toBeNull()
})

it('bounds explicit summary announcements, reveals the complete original summary and copies only the original message', async () => {
  const summary = prefix + '😀'.repeat(160), message = 'Original exact diagnostic body'
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await act(async () => useAppStore.getState().reportError(message, { kind: 'indeterminate', summary }))
  const records = useAppStore.getState().notificationEvents
  await dom.render(<GlobalSystemNotices />)
  expect(dom.container.querySelector('.global-system-notices__announcement')!.textContent).toBe(
    `${Array.from(summary).slice(0, 100).join('')}. Review system notifications for details.`)
  await toggleNotificationCenter(dom.container, 'open'); await selectNotificationView(dom.container, 'history')
  const row = notificationEventRows(dom.container)[0]!
  expect(row.querySelector('.notification-item__original')).toBeNull()
  await toggleNotificationDetails(row)
  expect(row.querySelector('.notification-item__original')!.textContent).toContain(summary)
  expect(row.querySelector('.notification-item__original')!.textContent).toContain(message)
  expect(row.querySelector('.notification-item__original')!.getAttribute('aria-label')).not.toContain(summary)
  await act(async () => row.querySelector<HTMLButtonElement>('.notification-item__original button')!.click())
  expect(copy).toHaveBeenCalledExactlyOnceWith(message)
  expect(useAppStore.getState().notificationEvents).toBe(records)
})

it('keeps same-preview records distinct and does not replay a pending copy through close and reopen', async () => {
  const beginning = prefix + 'x'.repeat(150)
  await act(async () => { useAppStore.getState().reportError(beginning + 'first'); useAppStore.getState().reportError(beginning + 'second') })
  const records = useAppStore.getState().notificationEvents
  expect(new Set(records.map(record => record.id)).size).toBe(2)
  let finish!: () => void
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<GlobalSystemNotices />)
  await toggleNotificationCenter(dom.container, 'open'); await selectNotificationView(dom.container, 'history')
  const rows = notificationEventRows(dom.container)
  expect(rows.map(row => row.querySelector('.notification-item__title')!.textContent)).toEqual([beginning.slice(0, 100) + '…', beginning.slice(0, 100) + '…'])
  await toggleNotificationDetails(rows[0]!)
  await act(async () => rows[0]!.querySelector<HTMLButtonElement>('.notification-item__original button')!.click())
  await toggleNotificationCenter(dom.container, 'closed')
  await act(async () => finish())
  await toggleNotificationCenter(dom.container, 'open'); await selectNotificationView(dom.container, 'history')
  await toggleNotificationDetails(notificationEventRows(dom.container)[0]!)
  expect(copy).toHaveBeenCalledExactlyOnceWith(records[1]!.message)
  expect(notificationEventRows(dom.container)[0]!.textContent).not.toContain('Copied')
  expect(useAppStore.getState().notificationEvents).toBe(records)
})
