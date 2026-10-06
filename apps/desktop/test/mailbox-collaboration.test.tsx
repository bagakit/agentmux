// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcResult, DurableAgentMuxMessage } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { ConversationReadingProps } from '@agentmux/client-ui/components/ConversationMessage'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), control = composerSession('owner-agent').control
const noticeActions = vi.hoisted(() => [] as { title: string; run(): void }[])
vi.mock('../src/renderer/src/components/MailboxReading', async original => {
  const module = await original<typeof import('../src/renderer/src/components/MailboxReading')>(), { createElement } = await import('react')
  return { ...module, MailboxSourceNotice: (props: Parameters<typeof module.MailboxSourceNotice>[0]) => { noticeActions.push({ title: props.title, run: props.onAction }); return createElement(module.MailboxSourceNotice, props) } }
})
const system = { notices: [], unread: [], acknowledge: vi.fn(), available: true } as never
type Observation = AgentMuxRpcResult<'message.dispatch.read'>
function message(id: string, sender = 'owner-agent', recipient = 'worker-agent', replyTo: string | null = null): DurableAgentMuxMessage {
  return { sequence: 1, envelope: { schema: 'agentmux.a2a.v1', messageId: id, operationId: 'operation-' + id, createdAt: fixtureEpoch(1),
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: 'original-run-' + sender, recipientSessionId: recipient, recipientRunId: 'original-run-' + recipient,
    threadId: 'original-thread', correlationId: 'correlation-' + id, replyTo, workspaceId: null, body: 'Original opaque content ' + id }, delivery: { state: 'delivered', at: fixtureEpoch(1) } }
}
const observation = (id = 'source-one'): Observation => ({ hostId: 'local', dispatch: { sourceMessageId: id, ownerAgentSessionId: 'owner-agent', workerAgentSessionId: 'worker-agent',
  threadId: 'original-thread', openedAt: fixtureEpoch(1), originAwaits: true, events: [] }, source: message(id), replies: [message('reply-one', 'worker-agent', 'owner-agent', id)],
  identityDiagnostics: [{ agentSessionId: 'worker-agent', runId: 'original-run-worker-agent', code: 'DISPATCH_IDENTITY_UNAVAILABLE', message: 'Current Run observation is unavailable.' }] })
const page = (ids = ['source-one', 'source-two'], cursor: string | null = null) => ({ hostId: 'local', participantSessionId: 'owner-agent', dispatches: ids.map(id => observation(id).dispatch), nextSourceMessageId: cursor })
beforeEach(() => { noticeActions.length = 0; vi.spyOn(api.sessions, 'dispatches').mockResolvedValue(page()); vi.spyOn(api.sessions, 'dispatch').mockImplementation(async (_ref, id) => observation(id)) })
async function render(visible = true, current = control, reading?: ConversationReadingProps) { await dom.render(<SessionMailbox control={current} visible={visible} system={system} queued={[]} reading={reading} />) }
async function toggle(newState: 'open' | 'closed') { const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: newState }); await act(async () => dom.container.querySelector('.composer-mailbox')!.dispatchEvent(event)) }
async function start() { await render(); await toggle('open'); await dom.click('[role="tab"][id$="-collaboration-tab"]') }
const textButton = (text: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!
async function clickText(text: string) { await act(async () => textButton(text).click()) }
async function select(id = 'source-one') { await dom.click(`[data-source-message="${id}"]`) }
async function expand(id = 'source-one') { const details = dom.container.querySelector<HTMLDetailsElement>(`[data-message-id="${id}"]`)!; await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) }); return details }

it('the original Mailbox reads only its visible collaboration folder and exact Host participant', async () => {
  await render(); expect(api.sessions.dispatches).not.toHaveBeenCalled(); await toggle('open'); expect(api.sessions.dispatches).not.toHaveBeenCalled()
  await dom.click('[role="tab"][id$="-collaboration-tab"]')
  expect(api.sessions.dispatches).toHaveBeenCalledExactlyOnceWith({ hostId: 'local', agentSessionId: 'owner-agent' }, { limit: 20 })
  await select(); expect(api.sessions.dispatch).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: 'owner-agent' }, 'source-one')
  await expand(); expect(dom.container.textContent).toContain('original-run-owner-agent'); expect(dom.container.textContent).toContain('operation-source-one')
  expect(dom.container.textContent).toContain('Delivery and supervision do not confirm execution or Goal acceptance')
  expect(dom.container.textContent).toContain('Current identity observation is unconfirmed'); expect(dom.container.textContent).not.toContain('Execution complete')
})
it('same-source refresh and failure retain the original node, body selection and expanded details', async () => {
  await start(); await select(); const details = await expand(), body = details.querySelector('.message-content') ?? details.querySelector('.message-body') ?? details.querySelector('p')!
  const range = document.createRange(); range.selectNodeContents(body); getSelection()!.removeAllRanges(); getSelection()!.addRange(range); const selection = getSelection()!.toString()
  expect(selection.length).toBeGreaterThan(0)
  vi.mocked(api.sessions.dispatch).mockResolvedValueOnce({ ...observation(), replies: [...observation().replies, message('reply-two', 'worker-agent', 'owner-agent', 'source-one')] })
  await clickText('Refresh records'); expect(dom.container.querySelector('[data-message-id="source-one"]')).toBe(details); expect(details.open).toBe(true); expect(getSelection()!.toString()).toBe(selection)
  vi.mocked(api.sessions.dispatch).mockRejectedValueOnce(new Error('Original read unavailable')); await clickText('Refresh records')
  expect(dom.container.querySelector('[data-message-id="source-one"]')).toBe(details); expect(getSelection()!.toString()).toBe(selection)
  expect(dom.container.textContent).toContain('Original record read is unconfirmed'); await dom.click('[aria-label="Retry original record"]'); expect(dom.container.textContent).not.toContain('Original record read is unconfirmed')
})
it('late reads after selection, hiding and Run changes cannot replace the current source', async () => {
  let resolve!: (value: Observation) => void
  vi.mocked(api.sessions.dispatch).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await start(); await select(); await clickText('Back to collaboration'); await select('source-two')
  await act(async () => resolve(observation())); expect(dom.container.querySelector('[data-dispatch-source]')?.getAttribute('data-dispatch-source')).toBe('source-two')
  await expand('source-two')
  vi.mocked(api.sessions.dispatch).mockImplementationOnce(() => new Promise(done => { resolve = done })); await clickText('Refresh records'); await render(false)
  await act(async () => resolve({ ...observation('source-two'), source: { ...message('source-two'), envelope: { ...message('source-two').envelope, body: 'STALE HIDDEN BODY' } } }))
  expect(dom.container.textContent).not.toContain('STALE HIDDEN BODY')
  await render(true, { ...control, run: { runId: 'new-original-run' } }); expect(dom.container.querySelector('[data-dispatch-source]')).toBeNull()
})
it('a superseded same-participant list response cannot change the current reading window', async () => {
  await start(); let resolve!: (value: ReturnType<typeof page>) => void
  vi.mocked(api.sessions.dispatches).mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce(page(['source-three']))
  await clickText('Refresh records'); await clickText('Refresh records')
  await act(async () => resolve(page(['STALE-list-source'])))
  expect(dom.container.querySelector('[data-source-message="source-three"]')).not.toBeNull(); expect(dom.container.querySelector('[data-source-message="STALE-list-source"]')).toBeNull()
})
it('wrong source and participant reads remain unknown instead of fabricating a record', async () => {
  vi.mocked(api.sessions.dispatches).mockResolvedValueOnce({ ...page(), participantSessionId: 'another-agent' }); await start()
  expect(dom.container.querySelector('[data-source-message]')).toBeNull(); expect(dom.container.textContent).toContain('Collaboration list is unconfirmed')
  await dom.click('[aria-label="Retry collaboration list"]'); vi.mocked(api.sessions.dispatch).mockResolvedValueOnce(observation('different-source')); await select()
  expect(dom.container.querySelector('[data-dispatch-source]')).toBeNull(); expect(dom.container.textContent).toContain('Original record read is unconfirmed')
})
it('loads original participant pages without polling and restores the selected keyboard row', async () => {
  vi.mocked(api.sessions.dispatches).mockResolvedValueOnce(page(['source-one'], 'source-one')).mockResolvedValueOnce(page(['source-two']))
  await start(); await clickText('Load more collaboration records')
  expect(api.sessions.dispatches).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: 'owner-agent' }, { limit: 20, afterSourceMessageId: 'source-one' })
  const row = dom.container.querySelector<HTMLButtonElement>('[data-source-message="source-two"]')!; row.focus(); await select('source-two')
  expect(document.activeElement).toBe(textButton('Back to collaboration')); await clickText('Back to collaboration'); expect((document.activeElement as HTMLElement).dataset.sourceMessage).toBe('source-two')
  expect(api.sessions.dispatches).toHaveBeenCalledTimes(2)
})
it('refresh preserves the loaded window and failed pagination retries its original cursor', async () => {
  vi.mocked(api.sessions.dispatches).mockResolvedValueOnce(page(['source-one'], 'source-one')).mockRejectedValueOnce(new Error('Later page unavailable')).mockResolvedValueOnce(page(['source-two']))
  await start(); const first = dom.container.querySelector('[data-source-message="source-one"]')
  await clickText('Load more collaboration records'); await dom.click('[aria-label="Retry collaboration list"]')
  expect(api.sessions.dispatches).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: 'owner-agent' }, { limit: 20, afterSourceMessageId: 'source-one' })
  const second = dom.container.querySelector('[data-source-message="source-two"]')
  vi.mocked(api.sessions.dispatches).mockResolvedValueOnce(page(['source-one'], 'source-one')).mockResolvedValueOnce(page(['source-two']))
  await clickText('Refresh records')
  expect(dom.container.querySelector('[data-source-message="source-one"]')).toBe(first); expect(dom.container.querySelector('[data-source-message="source-two"]')).toBe(second)
  expect(api.sessions.dispatches).toHaveBeenCalledTimes(5)
})
it('an old record retry cannot cancel another selection or leave its read busy', async () => {
  vi.mocked(api.sessions.dispatch).mockRejectedValueOnce(new Error('First record unavailable')); await start(); await select()
  const retry = noticeActions.findLast(item => item.title === 'Original record read is unconfirmed')!.run
  await clickText('Back to collaboration')
  let resolve!: (value: Observation) => void; vi.mocked(api.sessions.dispatch).mockImplementationOnce(() => new Promise(done => { resolve = done })); await select('source-two')
  await act(async () => retry()); expect(api.sessions.dispatch).toHaveBeenCalledTimes(2)
  await act(async () => resolve(observation('source-two')))
  expect(dom.container.querySelector('[data-dispatch-source]')?.getAttribute('data-dispatch-source')).toBe('source-two')
  expect(textButton('Refresh records').getAttribute('aria-busy')).toBe('false')
})
it('old retry handlers stay expired after A-B-A selection and hide-show of the same record', async () => {
  vi.mocked(api.sessions.dispatch).mockRejectedValueOnce(new Error('Original A read unavailable')); await start(); await select()
  const originalRetry = noticeActions.findLast(item => item.title === 'Original record read is unconfirmed')!.run
  await clickText('Back to collaboration'); await select('source-two'); await clickText('Back to collaboration'); await select()
  const before = vi.mocked(api.sessions.dispatch).mock.calls.length; await act(async () => originalRetry()); expect(api.sessions.dispatch).toHaveBeenCalledTimes(before)
  vi.mocked(api.sessions.dispatch).mockRejectedValueOnce(new Error('Next A read unavailable')); await clickText('Refresh records')
  const hiddenRetry = noticeActions.findLast(item => item.title === 'Original record read is unconfirmed')!.run
  await render(false); await render(true); const after = vi.mocked(api.sessions.dispatch).mock.calls.length
  await act(async () => hiddenRetry()); expect(api.sessions.dispatch).toHaveBeenCalledTimes(after)
})
it('navigation failure belongs to its original selection and entering details resets only the original reading viewport', async () => {
  let reject!: (error: Error) => void; vi.spyOn(api.ui, 'openObjectLink').mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await start(); const viewport = dom.container.querySelector<HTMLElement>('.composer-mailbox__content')!; viewport.scrollTop = 280
  await select(); expect(viewport.scrollTop).toBe(0); await clickText('owner-agent')
  await clickText('Back to collaboration'); expect(viewport.scrollTop).toBe(280); await select('source-two')
  await act(async () => reject(new Error('OLD NAVIGATION FAILURE'))); expect(dom.container.textContent).not.toContain('OLD NAVIGATION FAILURE')
})
it('empty supervision, unknown reads and worker reports do not claim that other messages or tasks are complete', async () => {
  vi.mocked(api.sessions.dispatches).mockResolvedValueOnce(page([])); await start(); expect(dom.container.textContent).toContain('No supervised collaboration recorded')
  expect(dom.container.textContent).toContain('This does not describe other Agent messages or execution status')
  await clickText('Refresh records'); vi.mocked(api.sessions.dispatch).mockResolvedValueOnce({ ...observation(), dispatch: { ...observation().dispatch, originAwaits: false,
    events: [{ kind: 'worker_done', replyMessageId: 'reply-one', at: fixtureEpoch(1) }] } }); await select()
  expect(dom.container.textContent).toContain('Worker report recorded; review is separate'); expect(dom.container.textContent).toContain('worker_done')
  expect(dom.container.querySelector('button[aria-label*="Resend"]')).toBeNull()
})
it('original message file references cannot inherit the current reader workspace or fetch its images', async () => {
  const openWorkspaceFile = vi.fn(), readPastedImage = vi.fn(), openHttpLink = vi.fn()
  const original = observation()
  vi.mocked(api.sessions.dispatch).mockResolvedValueOnce({ ...original, source: { ...original.source, envelope: { ...original.source.envelope,
    body: '[Original file](evidence.txt) ![Original image](resource.png) [Web evidence](https://example.test/evidence)' } } })
  await render(true, control, { workspaceRoot: fixturePath('workspace/reader'), openWorkspaceFile, readPastedImage, openHttpLink }); await toggle('open'); await dom.click('[id$="-collaboration-tab"]'); await select(); await expand()
  expect(dom.container.querySelector('.md-link--file')).toBeNull(); expect(openWorkspaceFile).not.toHaveBeenCalled(); expect(readPastedImage).not.toHaveBeenCalled()
  const web = [...dom.container.querySelectorAll<HTMLElement>('button,a')].find(node => node.textContent === 'Web evidence')!; expect(web).toBeDefined(); await act(async () => web.click())
  expect(openHttpLink).toHaveBeenCalled(); expect(dom.container.textContent).toContain('Recorded Workspace')
})

async function findLoaded(value: string) {
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Find loaded collaboration records"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function communication(value: string) {
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Filter collaboration communication"]')!
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false })) })
  const option = document.querySelector<HTMLElement>(`[role="menuitemradio"][data-value="${value}"]`)!
  expect(option).not.toBeNull(); await act(async () => option.click())
}
it('finds only loaded source and participant facts, never prefetches bodies, and keeps pagination on an empty match', async () => {
  vi.mocked(api.sessions.dispatches).mockResolvedValueOnce(page(['source-one'], 'source-one')).mockResolvedValueOnce(page(['source-two']))
  await start(); await findLoaded('source-two')
  expect(dom.container.querySelector('[data-source-message]')).toBeNull(); expect(dom.container.textContent).toContain('0 of 1 loaded records')
  expect(dom.container.textContent).toContain('No loaded records match'); expect(api.sessions.dispatch).not.toHaveBeenCalled()
  await clickText('Load more collaboration records')
  expect(dom.container.querySelector('[data-source-message="source-two"]')).not.toBeNull(); expect(dom.container.textContent).toContain('1 of 2 loaded records')
  await findLoaded('OPERATION-source-two'); expect(dom.container.querySelector('[data-source-message]')).toBeNull()
  await findLoaded(' OWNER-AGENT '); expect(dom.container.querySelectorAll('[data-source-message]')).toHaveLength(2)
  expect(api.sessions.dispatches).toHaveBeenCalledTimes(2); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})
it('current presentation names help find original identities without changing the exact detail source or author', async () => {
  const readDetails = vi.fn()
  await render(true, control, { describeSpeaker: speaker => ({ name: speaker.id === 'owner-agent' ? 'Review owner' : 'Implementation colleague', readDetails }) })
  await toggle('open'); await dom.click('[id$="-collaboration-tab"]'); await findLoaded('COLLEAGUE')
  expect(dom.container.querySelectorAll('[data-source-message]')).toHaveLength(2); expect(dom.container.textContent).toContain('Review owner → Implementation colleague')
  expect(dom.container.textContent).toContain('owner-agent → worker-agent'); expect(readDetails).not.toHaveBeenCalled()
  await select('source-two'); expect(api.sessions.dispatch).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: 'owner-agent' }, 'source-two')
  await expand('source-two'); expect(dom.container.textContent).toContain('original-run-owner-agent')
})
it('communication filters never imply execution, and clearing filters returns focus without writing the draft', async () => {
  const reported = observation('source-two').dispatch; reported.originAwaits = false
  vi.mocked(api.sessions.dispatches).mockResolvedValueOnce({ ...page(), dispatches: [observation().dispatch, reported] })
  await start(); await communication('reported')
  expect(dom.container.querySelector('[data-source-message="source-one"]')).toBeNull(); expect(dom.container.querySelector('[data-source-message="source-two"]')).not.toBeNull()
  expect(dom.container.textContent).toContain('Report recorded · review separate'); expect(dom.container.textContent).not.toContain('Execution complete')
  await communication('waiting'); expect(dom.container.querySelector('[data-source-message="source-one"]')).not.toBeNull(); expect(dom.container.querySelector('[data-source-message="source-two"]')).toBeNull()
  await findLoaded('missing'); await clickText('Clear filters')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Find loaded collaboration records')
  expect(dom.container.querySelectorAll('[data-source-message]')).toHaveLength(2); expect(dom.draft()).toBe('Keep my draft')
})
it('query and communication choice survive original detail reading, refresh, and Back with the original list position', async () => {
  await start(); await findLoaded('source-two'); await communication('waiting')
  const viewport = dom.container.querySelector<HTMLElement>('.composer-mailbox__content')!; viewport.scrollTop = 150
  await select('source-two'); const details = await expand('source-two'); await clickText('Refresh records')
  expect(dom.container.querySelector('[data-message-id="source-two"]')).toBe(details)
  await clickText('Back to collaboration'); expect(viewport.scrollTop).toBe(150)
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Find loaded collaboration records"]')!.value).toBe('source-two')
  expect(dom.container.querySelector('[aria-label="Filter collaboration communication"]')!.getAttribute('data-value')).toBe('waiting')
  expect(dom.container.querySelectorAll('[data-source-message]')).toHaveLength(1)
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Find loaded collaboration records"]')!
  const parent = vi.fn(); document.addEventListener('keydown', parent)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })))
  expect(parent).not.toHaveBeenCalled(); document.removeEventListener('keydown', parent)
  await render(true, { ...control, hostId: 'other-host', run: { runId: 'other-run' } })
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Find loaded collaboration records"]')).toBeNull()
  expect(dom.draft()).toBe('Keep my draft')
})
it('one Escape closes only the original communication menu, preserving Mailbox and its trigger focus', async () => {
  await start(); const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Filter collaboration communication"]')!
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!, hide = vi.fn()
  Object.defineProperty(panel, 'hidePopover', { configurable: true, value: hide })
  trigger.focus(); await act(async () => trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', ctrlKey: false })))
  const menu = document.querySelector<HTMLElement>('.selection-field__menu')!; expect(menu).not.toBeNull(); menu.focus()
  await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await new Promise(done => setTimeout(done, 0)) })
  expect(hide).not.toHaveBeenCalled(); expect(document.querySelector('.selection-field__menu')).toBeNull(); await act(async () => { await new Promise(done => setTimeout(done, 0)) }); expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(hide).toHaveBeenCalledOnce()
})
