// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { notificationEventRows, toggleNotificationCenter } from './helpers/notification-center'

const dom = composerDOM()
beforeEach(() => useAppStore.setState({ loading: false, sessions: [], notificationEvents: [], noticeReadReceipts: {},
  environmentWarning: undefined, runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [], displacedAgentSessionIds: [] }))

it.each([
  [undefined, 'polite', 'status'],
  ['healthy', 'polite', 'status'],
  ['process-degraded', 'polite', 'status'],
  ['indeterminate', 'polite', 'status'],
  ['agent-broken', 'assertive', 'alert']
] as const)('uses the same severity volume for a %s event in the real notification inbox', async (kind, live, role) => {
  await dom.render(<GlobalSystemNotices />)
  await act(async () => useAppStore.getState().reportError('Document operation failed', kind ? { kind } : undefined))
  const row = notificationEventRows(dom.container)[0]!
  expect(row, 'The actual reportError event must reach its window consumer').toBeDefined()
  expect(row.getAttribute('aria-live')).toBe(live)
  expect(row.getAttribute('role')).toBe(role)
  expect(row.querySelector<HTMLDetailsElement>('.notification-item__details')!.open).toBe(false)
  expect(row.querySelector('[aria-label^="Complete details:"]')?.textContent).toContain('Document operation failed')
})

it('retains the original details and read event through collapse and deliberate reopen', async () => {
  await dom.render(<GlobalSystemNotices />)
  await act(async () => useAppStore.getState().reportError('Prompt could not be sent'))
  await toggleNotificationCenter(dom.container, 'open'); await toggleNotificationCenter(dom.container, 'closed')
  const before = useAppStore.getState()
  expect(notificationEventRows(dom.container)).toHaveLength(1)
  expect(dom.container.querySelector('.global-system-notices__trigger')!.getAttribute('data-unread')).toBe('false')
  await toggleNotificationCenter(dom.container, 'open')
  expect(notificationEventRows(dom.container)[0]!.textContent).toContain('Prompt could not be sent')
  expect(useAppStore.getState().notificationEvents).toBe(before.notificationEvents)
})

it('keeps a clipboard failure on the original details with an explicit retry and no recursive global event', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('Original clipboard unavailable')).mockResolvedValueOnce(undefined)
  await dom.render(<GlobalSystemNotices />)
  await act(async () => useAppStore.getState().reportError('Complete original diagnostic'))
  const row = notificationEventRows(dom.container)[0]!
  await dom.click('.notification-item__original button')
  expect(row.textContent).toContain('Copy failed: Original clipboard unavailable')
  expect(notificationEventRows(dom.container)).toHaveLength(1)
  await dom.click('.notification-item__original button')
  expect(copy.mock.calls).toEqual([['Complete original diagnostic'], ['Complete original diagnostic']])
  expect(row.textContent).toContain('Copied')
  expect(notificationEventRows(dom.container)).toHaveLength(1)
})
