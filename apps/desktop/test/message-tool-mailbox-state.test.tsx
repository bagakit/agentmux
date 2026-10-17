// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, type ComponentProps } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { journalMessage, mailboxJournal } from './helpers/mailbox-journal-fixture'

const dom = composerDOM(), session = composerSession()
const emptySystem = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
let journal: ReturnType<typeof mailboxJournal>
beforeEach(() => { journal = mailboxJournal(); useAppStore.setState({ noticeReadReceipts: {} }) })

/** The native port changes top layer synchronously and coalesces toggle in a later task. */
function nativePopover(panel: HTMLElement) {
  let open = false, pending: { oldState: string; newState: string } | null = null
  const originalMatches = panel.matches.bind(panel)
  panel.matches = selector => selector === ':popover-open' ? open : originalMatches(selector)
  function event(type: string, oldState: string, newState: string) {
    const result = new Event(type, { cancelable: type === 'beforetoggle' && newState === 'open' })
    Object.defineProperties(result, { oldState: { value: oldState }, newState: { value: newState } })
    return result
  }
  function change(next: boolean) {
    if (next === open) return
    const oldState = open ? 'open' : 'closed', newState = next ? 'open' : 'closed'
    if (!panel.dispatchEvent(event('beforetoggle', oldState, newState))) return
    open = next
    pending = { oldState: pending?.oldState ?? oldState, newState }
  }
  const show = vi.fn(() => change(true)), hide = vi.fn(() => change(false))
  Object.defineProperties(panel, { showPopover: { configurable: true, value: show }, hidePopover: { configurable: true, value: hide } })
  const flush = () => act(async () => {
    const next = pending; pending = null
    if (next) panel.dispatchEvent(event('toggle', next.oldState, next.newState))
  })
  return { show, hide, flush, isOpen: () => open }
}

async function fixture(props: Partial<ComponentProps<typeof SessionMailbox>> = {}) {
  const input = { system: emptySystem, queued: [], control: session.control, ...props }
  const render = (visible: boolean, changes: Partial<ComponentProps<typeof SessionMailbox>> = {}) =>
    dom.render(<div className="composer"><SessionMailbox {...input} {...changes} visible={visible} /></div>)
  await render(true)
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  const native = nativePopover(panel)
  const open = async () => { await act(async () => native.show()); await native.flush() }
  const folder = async (name: string) => {
    if (['inbox', 'outbox', 'collaboration'].includes(name)) await dom.click('[id$="-agents-tab"]')
    await dom.click(`[role="tab"][id$="-${name}-tab"]`)
  }
  return { panel, native, render, open, folder }
}

it.each([1, 128])('does not visit %i unrelated Sessions when the original control is supplied', async count => {
  const sessions = [...Array.from({ length: count }, (_, index) => composerSession(`unrelated-${index}`)), session]
  let visits = 0
  vi.spyOn(sessions, 'find').mockImplementation(predicate => {
    for (const [index, item] of sessions.entries()) {
      visits++
      if (predicate(item, index, sessions)) return item
    }
    return undefined
  })
  useAppStore.setState({ sessions })
  const h = await fixture()
  const measured: Record<string, number> = {}
  for (const visible of [true, false]) {
    await h.render(visible)
    visits = 0
    await act(async () => {
      for (let index = 0; index < 10; index++) useAppStore.setState({
        agentNames: { [`unrelated-${index % count}`]: `Updated ${index}` }
      })
    })
    measured[String(visible)] = visits
  }
  expect(measured, 'supplied control needs no fallback Session visits').toEqual({ true: 0, false: 0 })
})

it.each(['host', 'run'] as const)('keeps the original fallback control and its %s changes when no control is supplied', async changed => {
  journal.set([journalMessage({ id: 'fallback', body: 'Original fallback body' })])
  const timeline = { agentSessionId: session.id, revision: 1, items: [] }
  const h = await fixture({ control: undefined, timeline })
  expect(journal.list).toHaveBeenCalledWith({ hostId: session.control.hostId, agentSessionId: session.id }, { direction: 'incoming', limit: 25 })
  await h.open(); await dom.click('[data-record-key="a2a:fallback"]')
  expect(h.panel.textContent).toContain('Original fallback body')
  await h.render(false); await h.native.flush()
  const control = { ...session.control, ...(changed === 'host' ? { hostId: 'other-host' } : { run: { runId: 'other-run' } }) }
  await act(async () => useAppStore.setState({ sessions: [{ ...session, control }] }))
  await h.render(true); await h.native.flush()
  expect(h.native.isOpen()).toBe(false)
  expect(h.panel.querySelector('.log-turn__body')).toBeNull()
  expect(journal.list).toHaveBeenLastCalledWith({ hostId: control.hostId, agentSessionId: session.id }, { direction: 'incoming', limit: 25 })
})

it('keeps the original pending count when the same controlled input is read from the Core journal', async () => {
  const key = { kind: 'prompt' as const, agentSessionId: session.id, expectedRun: session.control.run, submissionId: 'waiting-input' }
  const item: AgentInputMailboxItem = { kind: 'controlled', sequence: 1, recordedAt: _tailFixtureEpoch(0, 0, 1),
    intent: { key, admissionIntent: { kind: 'manual-actor', expectedRun: session.control.run }, execution: 'immediate',
      source: { kind: 'prompt', prompt: 'Retained waiting input', authorHuman: true } }, receipt: null,
    failure: { name: 'Error', code: 'ORIGINAL_OBSERVATION_UNKNOWN', message: 'Original receipt not available' } }
  vi.spyOn(api.sessions, 'inputMailbox').mockResolvedValue({ agentSessionId: session.id, queueId: 'original-input-journal',
    cut: { incarnation: 'original', throughSequence: 1 }, budgetBytes: 128 * 1024, items: [{ kind: 'item', item }], nextCursor: null,
    coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } })
  const queued = [{ id: 'waiting-input', text: 'Retained waiting input', status: 'deferred' as const, inputControlled: true,
    deliverable: true, inputOrigin: { hostId: session.control.hostId, key } }]
  const h = await fixture({ queued })
  const label = () => dom.container.querySelector('.composer__mailbox')!.getAttribute('aria-label')
  expect(label()).toContain('Inputs 1 pending')
  await h.open(); await h.folder('user')
  expect(h.panel.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1)
  expect(h.panel.querySelector('[data-operation-id="waiting-input"]')).toBeNull()
  expect(label()).toContain('Inputs 1 pending')
  expect(h.panel.querySelector('[id$="-user-tab"]')!.getAttribute('aria-label')).toBe('Inputs: 1 pending')
  expect(queued[0]!.status).toBe('deferred')
})

it('leaves native top layer while hidden and restores the same body, Range, scroll and folder without moving focus', async () => {
  const record = journalMessage({ id: 'original', body: 'Exact original reading body' }); journal.set([record])
  const h = await fixture(); await h.open(); await dom.click('[data-record-key="a2a:original"]')
  const body = h.panel.querySelector('.log-turn__body')!, viewport = h.panel.querySelector<HTMLElement>('.composer-mailbox__content')!
  const range = document.createRange(); range.selectNodeContents(body)
  const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  viewport.scrollTop = 31
  const outside = document.createElement('button'); document.body.append(outside); outside.focus()
  try {
    await h.render(false); await h.native.flush()
    expect(h.native.isOpen()).toBe(false); expect(h.native.hide).toHaveBeenCalledTimes(1)
    expect(body.isConnected).toBe(true); expect(h.panel.querySelector('.log-turn__body')).toBe(body)
    expect(range.startContainer).toBe(body); expect(selection.getRangeAt(0)).toBe(range)
    expect(viewport.scrollTop).toBe(31); expect(document.activeElement).toBe(outside)
    const reads = journal.list.mock.calls.length, detailReads = journal.read.mock.calls.length
    await journal.changed(record)
    expect(journal.list).toHaveBeenCalledTimes(reads); expect(journal.read).toHaveBeenCalledTimes(detailReads)
    await h.render(true); await h.native.flush()
    expect(h.native.isOpen()).toBe(true); expect(h.native.show).toHaveBeenCalledTimes(2)
    expect(h.panel.querySelector('.log-turn__body')).toBe(body)
    expect(selection.getRangeAt(0)).toBe(range); expect(viewport.scrollTop).toBe(31)
    expect(h.panel.querySelector('[role="tablist"][aria-label="Agent message folders"] [aria-selected="true"]')!.id).toMatch(/-inbox-tab$/u)
    expect(document.activeElement).toBe(outside)
  } finally { outside.remove() }
})

it('preserves reading when native hide and return coalesce before the close toggle is delivered', async () => {
  journal.set([journalMessage({ id: 'original' })])
  const h = await fixture(); await h.open(); await dom.click('[data-record-key="a2a:original"]')
  const body = h.panel.querySelector('.log-turn__body')!, viewport = h.panel.querySelector<HTMLElement>('.composer-mailbox__content')!
  viewport.scrollTop = 19
  await h.render(false)
  expect(h.native.isOpen()).toBe(false)
  await h.render(true)
  expect(h.native.isOpen()).toBe(true)
  await h.native.flush()
  expect(h.panel.querySelector('.log-turn__body')).toBe(body); expect(viewport.scrollTop).toBe(19)
  expect(h.panel.querySelector('[aria-label="Back to Received"]')).not.toBeNull()
})

it('suspends an already native-open mailbox before its first toggle is delivered and acknowledges only after return', async () => {
  journal.set([journalMessage({ id: 'original' })])
  const h = await fixture()
  await act(async () => h.native.show())
  await h.render(false); await h.native.flush()
  expect(h.native.isOpen()).toBe(false)
  expect(useAppStore.getState().noticeReadReceipts[`mail:${session.id}`]).toBeUndefined()
  await h.render(true); await h.native.flush()
  expect(h.native.isOpen()).toBe(true)
  expect(h.panel.querySelector('[data-record-key="a2a:original"]')).not.toBeNull()
  expect(useAppStore.getState().noticeReadReceipts[`mail:${session.id}`]).toEqual({ '["local","original"]': '1' })
})

it.each(['outside', 'Escape', 'during-return'] as const)('keeps a real %s close closed through the next workface hide and return', async kind => {
  journal.set([journalMessage({ id: 'original' })])
  const h = await fixture(); await h.open(); await dom.click('[data-record-key="a2a:original"]')
  if (kind === 'during-return') { await h.render(false); await h.native.flush(); await h.render(true) }
  if (kind === 'Escape') await act(async () => h.panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  else await act(async () => h.native.hide())
  await h.native.flush()
  expect(h.native.isOpen()).toBe(false); expect(h.panel.querySelector('.log-turn__body')).toBeNull()
  const shows = h.native.show.mock.calls.length
  await h.render(false); await h.render(true); await h.native.flush()
  expect(h.native.isOpen()).toBe(false); expect(h.native.show).toHaveBeenCalledTimes(shows)
})

it('does not reopen the previous exact Host/Run reading after its scope changes while hidden', async () => {
  journal.set([journalMessage({ id: 'original', body: 'Body on the previous Host' })])
  const h = await fixture(); await h.open(); await dom.click('[data-record-key="a2a:original"]')
  await h.render(false); await h.native.flush()
  const control = { ...session.control, hostId: 'other-host', run: { runId: 'other-run' } }
  await h.render(false, { control }); await h.render(true, { control }); await h.native.flush()
  expect(h.native.isOpen()).toBe(false); expect(h.native.show).toHaveBeenCalledTimes(1)
  expect(h.panel.textContent).not.toContain('Body on the previous Host')
})

it('does not acknowledge hidden notices or consume Escape from another workface during a retained hover preview', async () => {
  const h = await fixture()
  await act(async () => dom.container.querySelector('.composer__mailbox')!.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true })))
  await h.native.flush(); expect(h.native.isOpen()).toBe(true)
  await act(async () => h.panel.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'mouse', bubbles: true })))
  await h.folder('system')
  await h.render(false); await h.native.flush()
  const notice = { id: 'new-notice', notice: { kind: 'indeterminate' as const, notice: { step: 'New original notice', mode: 'Not yet viewed', restore: 'Return to read it' } } }
  const acknowledge = vi.fn(), system = { available: true, notices: [notice], unread: [notice], acknowledge }
  await h.render(false, { system })
  expect(acknowledge).not.toHaveBeenCalled()
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => document.body.dispatchEvent(escape))
  expect(escape.defaultPrevented).toBe(false); expect(h.native.hide).toHaveBeenCalledTimes(1)
  await h.render(true, { system }); await h.native.flush()
  expect(h.panel.querySelector('[role="tab"][aria-selected="true"]')!.id).toMatch(/-system-tab$/u)
  expect(acknowledge).toHaveBeenCalledWith([notice])
})
