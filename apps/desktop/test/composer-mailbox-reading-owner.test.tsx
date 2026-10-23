// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { api } from '../src/renderer/src/lib/api'
import * as nativeReader from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import type { ConversationObservation, ConversationObservationHandle } from '@agentmux/core/conversation'

const closes: Array<() => unknown | Promise<unknown>> = [], dom = composerDOM()
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const rows = () => [...panel().querySelectorAll<HTMLElement>('[id$="-user"] [data-record-key]')]
const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }); check() }, { timeout: 6000 })
beforeEach(() => {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function click(label: string) {
  const button = [...panel().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  expect(button, label).toBeDefined(); await act(async () => button!.click())
}
async function inspectOriginal(owner: ReturnType<typeof nativeReader.useSessionUserMessages>) {
  const snapshot = owner.conversation.snapshot!, record = snapshot.units.flatMap(unit => unit.records)[0]!
  await act(async () => { await owner.conversation.reveal({ record: record.reference!, revision: record.revision, frontier: snapshot.window.checkpoint }) })
}
async function fixture(composer = true) {
  const f = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 145 }, (_, index) => ({ type: 'user', uuid: `original-${index}`,
    sessionId: 'native-main', message: { role: 'user', content: `Original input ${index}` } }))))
  closes.push(f.close)
  const bridge = await desktopConversationReadBridge(f, closes)
  const windows = new Map<string, string>()
  vi.mocked(api.conversation.readAgentConversation).mockImplementation(async (input, options) => {
    const page = await bridge.readAgentConversation(input, options)
    if (page.window.view) windows.set(page.window.view, page.window.id)
    return page
  })
  const observations: Array<{ view: string | undefined; listener(value: ConversationObservation): void; handle: ConversationObservationHandle }> = []
  vi.mocked(api.conversation.observeConversation).mockImplementation(async (reference, listener, options) => {
    const handle = await bridge.observeConversation(reference, listener, options)
    observations.push({ view: reference.view, listener, handle })
    return handle
  })
  const session = { ...composerSession(f.session.agentSessionId, 'claude'), control: { kind: 'agent' as const,
    hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  useAppStore.setState({ sessions: [session], timelines: {}, agentComposerHistory: {}, agentComposerHistoryNavigation: {}, agentComposerDrafts: { [session.id]: 'Unfinished original draft' } })
  const query = vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, options) => f.client.readAgentSessionHistory({ ...input, ...reference }, options))
  // Observe the real hook result so the test can move its original window.
  // Its reader, projection, watch and transport remain production code.
  let owner: ReturnType<typeof nativeReader.useSessionUserMessages> | undefined
  const read = nativeReader.useSessionUserMessages
  vi.spyOn(nativeReader, 'useSessionUserMessages').mockImplementation((control, options) => {
    const value = read(control, options); if (options?.enabled) owner = value; return value
  })
  await dom.render(composer ? <AgentSessionComposer sessionId={session.id} /> : <SessionMailbox control={session.control}
    system={{ available: true, notices: [], unread: [], acknowledge: vi.fn() }} queued={[]} />)
  expect(api.conversation.readAgentConversation).not.toHaveBeenCalled()
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event)); await dom.click('[role="tab"][id$="-user-tab"]')
  // A current read may acquire a discovery watch before handing it to the
  // accepted view. Count live ownership after admission, not past openings.
  const activeObservations = () => observations.filter(observation => !observation.handle.closed.aborted)
  const assertOriginalOwner = () => {
    expect(owner?.loading).toBe(false)
    const active = activeObservations()
    expect(active, 'Exactly one native reader owns this scope after admission').toHaveLength(1)
    expect(windows.get(active[0]!.view!), 'The live watch belongs to the accepted window').toBe(owner!.conversation.snapshot!.window.id)
    expect(owner!.conversation.inspect().watch.windowId).toBe(owner!.conversation.snapshot!.window.id)
    expect(observations.filter(observation => !observation.view).every(observation => observation.handle.closed.aborted),
      'Original discovery handles release their ownership after view admission').toBe(true)
  }
  await wait(() => { expect(rows().length).toBeGreaterThan(0); assertOriginalOwner(); expect(owner?.hasMore).toBe(true) })
  const heads = () => vi.mocked(api.conversation.readAgentConversation).mock.calls.filter(([input]) => !input.cursor)
  return { f, session, query, heads, owner: () => owner!, assertOriginalOwner, activeObservations }
}

it('Composer and Mailbox own one native window and recover its observation by refreshing both native and query readers', async () => {
  const h = await fixture()
  expect(h.heads(), 'Mailbox must reuse the Composer window').toHaveLength(1)
  await wait(() => expect(h.query).toHaveBeenCalledTimes(2))
  const observation = h.activeObservations()[0]!.listener
  await act(async () => observation({ hostId: 'local', agentSessionId: h.session.id, sourceHostId: 'local',
    source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main' }, kind: 'unavailable', message: 'Original observer temporarily unavailable' }))
  await wait(() => expect(panel().textContent).toContain('Original observer temporarily unavailable'))
  await click('Refresh source')
  await wait(() => { expect(h.heads()).toHaveLength(2); expect(h.query).toHaveBeenCalledTimes(4); expect(panel().textContent).not.toContain('Original observer temporarily unavailable') })
  await wait(() => expect(panel().querySelector<HTMLButtonElement>('[aria-label="Refresh inputs"]')!.disabled).toBe(false))
  await click('Refresh inputs')
  await wait(() => { expect(h.heads()).toHaveLength(3); expect(h.query).toHaveBeenCalledTimes(6) })
  await wait(h.assertOriginalOwner)
  expect(dom.draft(h.session.id)).toBe('Unfinished original draft')
  expect(h.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('the shared owner retains search and an opened original while its historical native window returns to latest', async () => {
  const h = await fixture()
  await wait(() => expect(h.query).toHaveBeenCalledTimes(2))
  const input = panel().querySelector<HTMLInputElement>('input[type="search"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, 'Original input 20'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await wait(() => expect(h.query.mock.calls.slice(-2).map(([, value]) => value.query)).toEqual(['Original input 20', 'Original input 20']))
  await inspectOriginal(h.owner())
  await wait(() => expect(panel().textContent).toContain('The native source changed'))
  await click('Read latest records')
  await wait(() => expect(panel().textContent).not.toContain('The native source changed'))
  await wait(h.assertOriginalOwner)
  expect(input.value).toBe('Original input 20')
  expect(h.query.mock.calls.slice(-2).map(([, value]) => value.query)).toEqual(['Original input 20', 'Original input 20'])
  const row = rows().find(node => node.textContent?.includes('Original input 20'))!
  expect(row).toBeDefined(); await act(async () => row.click())
  const body = panel().querySelector<HTMLElement>('.log-turn__body')!
  expect(body.textContent).toBe('Original input 20')
  await act(async () => { await h.owner().refresh() })
  expect(panel().querySelector('.log-turn__body')).toBe(body)
  expect(dom.draft(h.session.id)).toBe('Unfinished original draft')
})

it('a failed canonical owner remains visible when source queries succeed and Retry recovers the same readable inputs', async () => {
  const h = await fixture()
  await wait(() => expect(h.query).toHaveBeenCalledTimes(2))
  const original = rows().find(row => row.textContent?.includes('Original input 120'))!
  expect(original).toBeDefined()
  vi.mocked(api.conversation.readAgentConversation).mockRejectedValueOnce(new Error('Original canonical reader could not refresh'))
  await act(async () => { await h.owner().refresh() })
  await wait(() => expect(panel().textContent).toContain('Original canonical reader could not refresh'))
  expect(h.query).toHaveBeenCalledTimes(2)
  expect(rows()).toContain(original)
  await click('Retry')
  await wait(() => { expect(h.query).toHaveBeenCalledTimes(4); expect(panel().textContent).not.toContain('Original canonical reader could not refresh') })
  await wait(h.assertOriginalOwner)
  expect(rows()).toContain(original)
  expect(dom.draft(h.session.id)).toBe('Unfinished original draft')
  expect(h.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('Mailbox without Composer keeps its own native reader and historical recovery action', async () => {
  const h = await fixture(false)
  expect(h.heads()).toHaveLength(1); expect(h.query).not.toHaveBeenCalled()
  await click('Load earlier messages')
  await wait(() => expect(h.owner().sourceMessages).toHaveLength(145))
  await inspectOriginal(h.owner())
  await wait(() => expect(panel().textContent).toContain('The native source changed'))
  await click('Read latest records')
  await wait(() => { expect(h.heads()).toHaveLength(3); expect(panel().textContent).not.toContain('The native source changed') })
  await wait(h.assertOriginalOwner)
  expect(h.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
