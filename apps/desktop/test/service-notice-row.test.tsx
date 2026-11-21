// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { composerDOM } from './helpers/composer-dom-fixture'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM()
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const notice = (kind: 'indeterminate' | 'process-degraded', action?: { label: string; run(): void }) => ({
  id: 'delivery', cause: 'original', observedAt: 1000,
  notice: { kind, notice: { step: 'Input delivery needs confirmation', mode: 'The original input remains retained.', restore: 'Check the original delivery receipt.' } },
  ...(action ? { action } : {})
})
async function open() {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
}
async function chooseNotices() { await dom.click('[role="tab"][id$="-system-tab"]') }
beforeEach(() => useAppStore.setState({ sessions: [], noticeReadReceipts: {} }))

it('separates unread and unconfirmed state from the exact original action and detail', async () => {
  const action = vi.fn(), acknowledge = vi.fn()
  await dom.render(<SessionMailbox system={{ available: true, notices: [notice('indeterminate', { label: 'Check delivery', run: action })], unread: ['delivery'], acknowledge }} queued={[]} />)
  await open(); await chooseNotices()
  await act(async () => panel().dispatchEvent(new Event('pointerdown', { bubbles: true })))
  expect(acknowledge).toHaveBeenCalledWith(['delivery'])
  expect(panel().querySelector('.composer-mailbox__heading-icon')).not.toBeNull()
  expect(panel().querySelector('.composer-mailbox__folders > .liquid-selection')).not.toBeNull()
  const row = panel().querySelector<HTMLButtonElement>('.composer-mailbox__row')!
  expect(row.querySelector('.composer-mailbox__record-body')).not.toBeNull()
  expect(row.querySelector('.composer-mailbox__avatar')).not.toBeNull()
  expect(panel().querySelector('.composer-notice__state')!.textContent).toBe('Result unconfirmed')
  expect(panel().querySelector('.composer-notice__unread')!.getAttribute('aria-label')).toBe('Unread')
  expect(row.textContent).toContain('Input delivery needs confirmation')
  expect(row.textContent).toContain('The original input remains retained.')
  expect(action).not.toHaveBeenCalled()
  await dom.click('.composer-notice__action')
  expect(action).toHaveBeenCalledTimes(1)
  expect(panel().querySelector('.service-window')).toBeNull()
  await act(async () => row.click())
  expect(panel().querySelector('.service-window__restore')!.textContent).toBe('Check the original delivery receipt.')
  expect(panel().textContent).toContain('Check delivery')
  await dom.click('.composer-notice__action')
  expect(action).toHaveBeenCalledTimes(2)
  await dom.click('[role="tab"][id$="-user-tab"]')
  expect(panel().querySelector<HTMLElement>('[id$="-user"]')!.hidden).toBe(false)
  await dom.click('[role="tab"][id$="-agents-tab"]')
  expect(panel().querySelector<HTMLElement>('[id$="-agents"]')!.hidden).toBe(false)
  expect(panel().querySelector('[role="tab"][id$="-inbox-tab"]')).not.toBeNull()
  await chooseNotices()
  expect(panel().querySelector<HTMLElement>('[id$="-system"]')!.hidden).toBe(false)
})

it('keeps a degraded notice readable without inventing a recovery action', async () => {
  await dom.render(<SessionMailbox system={{ available: true, notices: [notice('process-degraded')], unread: [], acknowledge: vi.fn() }} queued={[]} />)
  await open(); await chooseNotices()
  expect(panel().querySelector('.composer-notice__state')!.textContent).toBe('Needs attention')
  expect(panel().querySelector('.composer-notice__action')).toBeNull()
  expect(panel().querySelector('.composer-notice__unread')).toBeNull()
  expect(panel().textContent).not.toContain('Retry')
  await act(async () => panel().querySelector<HTMLButtonElement>('.composer-mailbox__row')!.click())
  expect(panel().querySelector('.service-window__mode')!.textContent).toBe('The original input remains retained.')
  expect(panel().querySelector('.service-window__restore')!.textContent).toBe('Check the original delivery receipt.')
})
