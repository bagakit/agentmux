// @vitest-environment happy-dom
import { appendFile, readFile } from 'node:fs/promises'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHostedHistoryFixture } from '../../../packages/core/test/helpers/session-history-query'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import * as recordedText from '@agentmux/client-ui/input-history-text'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const dom = composerDOM(), cleanups: Array<() => Promise<unknown>> = [], sid = 'original-agent'
const body = 'resource needle · original complete text\n' + '中'.repeat(Math.ceil(2 * 1024 * 1024 / 3) + 100) + '\ncomplete final line absent from list preview'
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
const editor = () => dom.container.querySelector<HTMLElement>('[role="textbox"]')! as HTMLElement & { editor: import('@tiptap/core').Editor }
const wait = async (check: () => void) => { await vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); check() }, { timeout: 10000 }) }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function open() {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event)); await dom.click('[role="tab"][id$="-outbox-tab"]')
}
function row() {
  const original = [...panel().querySelectorAll<HTMLElement>('.composer-mailbox__row')].find(node => node.dataset.recordKey?.includes('resource-input'))
  expect(original, 'actual unified row for the original native resource').toBeDefined()
  return original!.closest('li')!
}
async function action(label: string) {
  const button = row().querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!; expect(button).not.toBeNull(); expect(button.textContent).toBe('')
  await act(async () => button.click())
}
beforeEach(() => {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const f = await createHostedHistoryFixture('claude', 2); cleanups.push(() => f.dispose())
  await appendFile(f.transcript, JSON.stringify({ type: 'user', sessionId: 'original-native', uuid: 'resource-input', timestamp: new Date().toISOString(), message: { role: 'user', content: body } }) + '\n')
  const originalBytes = await readFile(f.transcript), originalQueue = { operationId: 'original-unknown', text: 'original uncertain message', runId: 'original-run', status: 'deferred' as const, inputIntakeStarted: true as const, logId: 'original-log', errorCode: 'NO_ACK' }
  useAppStore.setState({ sessions: [composerSession(sid, 'claude'), composerSession('neighbor', 'claude')], timelines: {}, agentComposerHistory: {}, agentComposerHistoryNavigation: {}, agentComposerDrafts: { [sid]: 'left right', neighbor: 'neighbor unsent draft' }, agentSteerQueues: { [sid]: [originalQueue] } })
  const reads = vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, input, context) => f.client.readAgentSessionHistory({ ...input, ...reference }, context))
  const resource = vi.spyOn(api.sessions, 'historyResource').mockImplementation((control, input) => f.client.sessionHistoryResource(control.agentSessionId, input))
  const textReads = vi.spyOn(recordedText, 'inputHistoryText')
  const controls = ['send', 'enqueueAgentSteer', 'interrupt', 'respondInteraction'].map(name => vi.spyOn(useAppStore.getState(), name as 'send'))
  await dom.render(<AgentSessionComposer sessionId={sid} />); await open()
  await wait(() => expect(panel().querySelector('[data-record-key*="resource-input"]')).not.toBeNull())
  // This query and exact resource come from the real Unix Hosted SDK/Core Provider,
  // rather than a synthesized row preview or resource receipt.
  const page = await f.client.readAgentSessionHistory({ ...f.reference, source: 'native', kind: 'user-message', query: 'resource needle', maxBytes: 1024 * 1024, scanLimit: 200, limit: 30 })
  const message = page.userMessages!.find(message => message.rawId === 'resource-input')!
  expect(message.contentParts[0]).toMatchObject({ kind: 'resource', resourceType: 'text', content: { kind: 'text', encoding: 'json-utf8' } })
  const assertPreserved = async () => {
    expect(useAppStore.getState().agentSteerQueues[sid]).toEqual([originalQueue])
    expect((await readFile(f.transcript)).equals(originalBytes), 'Original native transcript bytes remain exactly equal').toBe(true)
    expect(f.forbidden.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    for (const control of controls) expect(control).not.toHaveBeenCalled()
    expect(api.continuousProgress.pauseForInput).not.toHaveBeenCalled()
  }
  return { ...f, reads, resource, message, textReads, assertPreserved }
}

it('actual unified icon actions copy the full Hosted/Core native resource and insert at the original caret while later typing survives and Undo restores it', async () => {
  const f = await fixture()
  expect(f.message.content).not.toBe(body); expect(row().textContent).not.toContain('complete final line absent from list preview')
  await action('复制全文'); await wait(() => expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(body))
  expect(dom.draft(sid)).toBe('left right')
  const gate = deferred(), realResource = f.client.sessionHistoryResource.bind(f.client)
  f.resource.mockImplementationOnce(async (control, input) => { const receipt = await realResource(control.agentSessionId, input); await gate.promise; return receipt })
  await act(async () => editor().editor.commands.setTextSelection(5))
  const readCount = f.resource.mock.calls.length; await action('填入草稿'); await wait(() => expect(f.resource.mock.calls.length).toBe(readCount + 1))
  await act(async () => { editor().editor.commands.setTextSelection(editor().editor.state.doc.content.size - 1); editor().editor.commands.insertContent(' + later edit') })
  expect(dom.draft(sid)).toBe('left right + later edit')
  await act(async () => gate.resolve())
  await wait(() => expect(dom.draft(sid) === 'left ' + body + ' right + later edit', 'Complete resource inserts at the original mapped caret and keeps later typing').toBe(true))
  const request = f.resource.mock.calls[readCount]!
  expect(request[0]).toMatchObject({ hostId: 'local', agentSessionId: sid })
  expect(request[1]).toMatchObject({ source: { providerId: 'claude', nativeSessionId: 'original-native' }, recordId: 'resource-input', partIndex: 0, offsetBytes: 0 })
  await act(async () => { expect(editor().editor.commands.undo()).toBe(true) })
  expect(dom.draft(sid)).toBe('left right + later edit')
  await f.assertPreserved()
})

it.each(['host', 'session', 'read-only', 'mailbox-close', 'editor-close'] as const)('actual Composer rejects a late original resource result after %s without changing either draft or original queue', async boundary => {
  const f = await fixture(), gate = deferred(), realResource = f.client.sessionHistoryResource.bind(f.client)
  f.resource.mockImplementationOnce(async (control, input) => { const receipt = await realResource(control.agentSessionId, input); await gate.promise; return receipt })
  await act(async () => editor().editor.commands.setTextSelection(5)); await action('填入草稿')
  await wait(() => expect(f.resource).toHaveBeenCalledOnce())
  const originalTextRead = f.textReads.mock.results.at(-1)!.value
  expect(originalTextRead).toBeInstanceOf(Promise)
  const originalEditor = editor().editor
  if (boundary === 'host') await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === sid && session.kind === 'agent' ? { ...session, control: { ...session.control, hostId: 'other-host' } } : session) })))
  else if (boundary === 'session') await dom.render(<AgentSessionComposer sessionId="neighbor" />)
  else if (boundary === 'read-only') await dom.render(<AgentSessionComposer sessionId={sid} readOnly />)
  else if (boundary === 'mailbox-close') { const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'closed' }); await act(async () => panel().dispatchEvent(event)) }
  else await dom.render(<div>Original editor closed</div>)
  // Wait the real complete reader, including all subsequent Hosted fragments, not only
  // the first delayed API receipt or an arbitrary number of microtasks.
  await act(async () => { gate.resolve(); await originalTextRead.catch(() => undefined); for (let i = 0; i < 4; i++) await Promise.resolve() })
  expect(dom.draft(sid) === 'left right', 'Late original resource must not change the original draft after its action owner changed').toBe(true); expect(dom.draft('neighbor')).toBe('neighbor unsent draft')
  if (!originalEditor.isDestroyed) expect(originalEditor.getText() === 'left right', 'The retained old editor did not accept a stale resource').toBe(true)
  await f.assertPreserved()
})

it('actual Composer displays Clipboard failure from the complete resource without false success or draft/queue changes', async () => {
  const f = await fixture(); vi.mocked(api.ui.writeClipboardText).mockRejectedValueOnce(new Error('Original clipboard denied'))
  await action('复制全文'); await wait(() => expect(row().textContent).toContain('Original clipboard denied'))
  expect(row().textContent).not.toContain('已复制全文'); expect(dom.draft(sid)).toBe('left right')
  await f.assertPreserved()
})
