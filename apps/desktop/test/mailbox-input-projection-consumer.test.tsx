// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress.js'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import type { ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM(), closes: Array<() => Promise<unknown>> = []
const system = { scope: 'original-notices', available: true, notices: [], unread: [], acknowledge: vi.fn() }
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function open() {
  const panel = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel.dispatchEvent(event))
  await dom.click('[role="tab"][id$="-user-tab"]')
}
const wait = (check: () => unknown) => vi.waitFor(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); check()
})
async function scene() {
  const f = await ingressFixture(false); closes.push(f.close)
  const operationId = 'original-local-input', text = 'Preserve the original input and operation'
  await f.client.submitAgentPrompt({ agentSessionId: f.session.agentSessionId, expectedRun: f.session.run,
    operationId, prompt: text, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  const described = composerSession(f.session.agentSessionId, 'claude')
  const session = { ...described, control: { ...described.control, run: f.session.run } }
  const key = { kind: 'prompt' as const, agentSessionId: session.id, expectedRun: f.session.run, submissionId: operationId }
  const original: ComposerQueuedMessage = { id: operationId, inputOrigin: { hostId: 'local', key }, text,
    inputControlled: true, status: 'deferred', unconfirmed: true, deliverable: true }
  const read = vi.spyOn(api.sessions, 'inputMailbox').mockImplementation((_target, options) =>
    f.client.readAgentInputMailbox({ ...options, agentSessionId: session.id }))
  const submit = vi.spyOn(f.client, 'submitAgentPrompt'), rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  return { ...f, session, original, read, submit, rejoin }
}

it('the actual Inputs reader keeps a journaled unknown local operation reachable through its original owner action', async () => {
  const f = await scene(), send = vi.fn(), stop = vi.fn()
  await dom.render(<SessionMailbox control={f.session.control} system={system} queued={[f.original]}
    onSendQueued={send} onCancelQueuedPreparation={stop} />)
  await open()
  await wait(() => expect(dom.container.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1))
  expect(dom.container.querySelector('[data-operation-id]')).toBeNull()
  await dom.click('[data-input-mailbox-key] [data-record-key]')
  await wait(() => expect(dom.container.querySelector('[data-operation-id]')).not.toBeNull())
  const local = dom.container.querySelector<HTMLElement>('[data-operation-id]')!
  expect(local.dataset.operationId).toBe(f.original.id)
  expect(local.textContent).toContain(f.original.text)
  // The original device never received a waiting receipt; the journal cannot grant its controls.
  expect(local.querySelector('[aria-label="停止等待"]')).toBeNull()
  expect(f.original.inputReceipt).toBeUndefined()
  expect(send).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
  await dom.click('[data-operation-id] [aria-label="Send queued message"]')
  expect(send).toHaveBeenCalledExactlyOnceWith(f.original.id)
  expect(stop).not.toHaveBeenCalled()
  expect(f.read).toHaveBeenCalled()
})

it('a journal from another Host cannot hide the original local action even with the same original input key', async () => {
  const f = await scene()
  await dom.render(<SessionMailbox control={{ ...f.session.control, hostId: 'other-host' }} system={system} queued={[f.original]} />)
  await open()
  await wait(() => expect(dom.container.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1))
  expect(dom.container.querySelector('[data-operation-id]')?.getAttribute('data-operation-id')).toBe(f.original.id)
  expect(f.read.mock.calls.every(([target]) => target.hostId === 'other-host')).toBe(true)
  await dom.click('[data-input-mailbox-key] [data-record-key]')
  expect(dom.container.querySelector('[data-operation-id]')).toBeNull()
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
})

it('independent archived local inputs with equal bodies stay separately readable beside the journal', async () => {
  const f = await scene()
  const { inputOrigin: _origin, ...entry } = f.original
  const archived: ComposerQueuedMessage[] = ['first-original', 'second-original'].map(id => ({ ...entry, id, archived: true }))
  await dom.render(<SessionMailbox control={f.session.control} system={system} queued={archived} />)
  await open()
  await wait(() => expect(dom.container.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1))
  expect([...dom.container.querySelectorAll('[data-operation-id]')].map(row => row.getAttribute('data-operation-id')))
    .toEqual(archived.map(entry => entry.id))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
})

it('the Composer consumes the data projection while preserving its query controls, unknown queue owner and independent draft', async () => {
  const f = await scene(), session = f.session
  useAppStore.setState({ config: composerConfig, sessions: [session], timelines: {}, demands: {},
    agentComposerDrafts: { [session.id]: 'Independent unsent draft' }, agentSteerQueues: { [session.id]: [{
      operationId: f.original.id, text: f.original.text, status: 'deferred', promptCondition: null, inputIntakeStarted: true,
      directInputBinding: { expectedRun: session.control.run, admissionIntent: { kind: 'manual-actor' } }, directInputControl: session.control
    }] } })
  await dom.render(<AgentSessionComposer sessionId={session.id} />)
  await open()
  await wait(() => expect(dom.container.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1))
  expect(dom.container.querySelector('input[aria-label="查询当前 Agent 输入历史"]')).not.toBeNull()
  expect(dom.container.querySelectorAll('[aria-label="Refresh inputs"]')).toHaveLength(1)
  await dom.click('[data-input-mailbox-key] [data-record-key]')
  await wait(() => expect(dom.container.querySelector('[data-operation-id]')).not.toBeNull())
  expect(dom.container.querySelector('[data-operation-id]')?.getAttribute('data-operation-id')).toBe(f.original.id)
  expect(dom.draft(session.id)).toBe('Independent unsent draft')
  expect(useAppStore.getState().agentSteerQueues[session.id]?.[0]?.inputReceipt).toBeUndefined()
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
})

it('a late journal association preserves the selected local editor until the reader leaves that original input', async () => {
  const f = await scene(), session = f.session
  const read = f.read.getMockImplementation()!
  let recorded = false
  f.read.mockImplementation(async (...args) => {
    const page = await read(...args)
    return recorded ? page : { ...page, items: [] }
  })
  useAppStore.setState({ config: composerConfig, sessions: [session], timelines: {}, demands: {},
    agentComposerDrafts: { [session.id]: 'Independent unsent draft' }, agentSteerQueues: { [session.id]: [{
      operationId: f.original.id, text: f.original.text, status: 'queued', promptCondition: null,
      directInputBinding: { expectedRun: session.control.run, admissionIntent: { kind: 'manual-actor' } }, directInputControl: session.control
    }] } })
  await dom.render(<AgentSessionComposer sessionId={session.id} />)
  await open()
  await wait(() => expect(f.read).toHaveBeenCalled())
  await dom.click('[data-operation-id] [aria-label="编辑这条待发消息"]')
  const editor = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="编辑待发消息"]')!
  expect(editor).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Uncommitted original edit')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  })
  recorded = true
  await act(async () => useAppStore.setState(state => ({ agentSteerQueues: { ...state.agentSteerQueues,
    [session.id]: state.agentSteerQueues[session.id]!.map(entry => ({ ...entry, inputIntakeStarted: true })) } })))
  await dom.click('[aria-label="Refresh inputs"]')
  await wait(() => expect(dom.container.textContent).toContain('Journal: 1 loaded'))
  expect(dom.container.querySelector('[aria-label="编辑待发消息"]')).toBe(editor)
  expect(editor.value).toBe('Uncommitted original edit')
  expect(dom.container.querySelector('[data-editing-id]')?.textContent).toContain('编辑稿仍保留')
  expect(dom.container.querySelector('[data-input-mailbox-key]')).toBeNull()
  expect(dom.draft(session.id)).toBe('Independent unsent draft')
  await dom.click('[role="tab"][id$="-system-tab"]')
  await dom.click('[role="tab"][id$="-user-tab"]')
  await wait(() => expect(dom.container.querySelectorAll('[data-input-mailbox-key]')).toHaveLength(1))
  expect(dom.container.querySelector('[data-operation-id]')).toBeNull()
  expect(f.submit).not.toHaveBeenCalled(); expect(f.rejoin).not.toHaveBeenCalled()
})
