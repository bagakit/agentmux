// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxMessageEvent, AgentMuxRpcResult, DurableAgentMuxMessage } from '@agentmux/core'
import type { RuntimeEvent, SessionHistoryReference } from '../src/shared/contracts'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import * as focusContext from '../src/renderer/src/lib/focus-context'
import { AgentCollaborationDialog, type CollaborationRequest } from '../src/renderer/src/components/AgentCollaborationDialog'
import { useCollaborationReading } from '../src/renderer/src/lib/use-collaboration-reading'
import * as collaborationReading from '../src/renderer/src/lib/use-collaboration-reading'

const dom = composerDOM({ agentInformation: true }), workspace = composerConfig.workspaces[0]!
const sessions = ['agent-a', 'agent-b', 'agent-c', 'agent-d'].map(id => composerSession(id))
const subject = (agentSessionId: string): SessionHistoryReference => ({ hostId: 'local', agentSessionId })
const original: CollaborationRequest = { kind: 'focus', subject: subject('agent-a'), name: 'Task A' }
const second: CollaborationRequest = { kind: 'focus', subject: subject('agent-c'), name: 'Task C' }
let listeners: Set<(event: RuntimeEvent) => void>, records: AgentMuxMessageEvent[], verificationReads: number
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function event(sequence: number, messageId: string, sender = 'agent-a', recipient = 'agent-b'): AgentMuxMessageEvent {
  return { sequence, kind: 'message', at: fixtureEpoch(1), messages: [{ messageId, senderSessionId: sender, recipientSessionId: recipient, threadId: 'thread-' + messageId, replyTo: null }] }
}
function message(messageId: string, sender = 'agent-a', recipient = 'agent-b', body = 'Original body with a stable reading selection.'): DurableAgentMuxMessage {
  return { sequence: messageId === 'message-c' ? 8 : 7, envelope: { schema: 'agentmux.a2a.v1', messageId, operationId: 'operation-' + messageId,
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: 'run-' + sender, recipientSessionId: recipient, recipientRunId: 'run-' + recipient,
    threadId: 'thread-' + messageId, correlationId: 'correlation-' + messageId, replyTo: null, workspaceId: null, createdAt: fixtureEpoch(1), body },
    delivery: { state: 'delivered', at: fixtureEpoch(1) } }
}
const graph = () => document.querySelector<HTMLElement>('.collaboration-dialog')!
const bodyNode = () => graph().querySelector<HTMLElement>('.composer-mailbox__detail .log-turn__body')
async function render(request: CollaborationRequest | null = original) {
  await dom.render(<AgentCollaborationDialog request={request} onClose={() => {}} onOpen={() => { throw Error('Reading must not navigate') }} />)
}
async function clickText(text: string) {
  const button = [...graph().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(button).toBeDefined(); await act(async () => button!.click())
}
async function selectRelation(sender = 'Task A', recipient = 'Task B', kind?: string) {
  const button = [...graph().querySelectorAll<HTMLButtonElement>('.collaboration-relation')].find(node => (!kind || node.dataset.kind === kind) && node.querySelector('span')?.textContent === sender + ' → ' + recipient)
  expect(button).toBeDefined(); await act(async () => button!.click())
}
async function emit(event: RuntimeEvent['event']) {
  await act(async () => { for (const listener of [...listeners]) listener({ type: 'core', hostId: 'local', event }) })
}
function changed(sequence: number, sender = 'agent-a', recipient = 'agent-b'): RuntimeEvent['event'] {
  return { type: 'agent-message-changed', recordKind: 'message', messageId: 'live-' + sequence, sequence, messageSequence: sequence,
    senderSessionId: sender, recipientSessionId: recipient, live: true }
}
beforeEach(() => {
  installCollaborationCanvasGeometry()
  verificationReads = 0; listeners = new Set(); records = [event(7, 'message-a'), event(8, 'message-c', 'agent-c', 'agent-d')]
  useAppStore.setState({ config: composerConfig, sessions, tabs: {}, layouts: {}, scratchTopicSnapshots: {}, timelines: {},
    agentNames: { 'agent-a': 'Task A', 'agent-b': 'Task B', 'agent-c': 'Task C', 'agent-d': 'Task D' },
    agentComposerDrafts: { 'agent-a': 'Original A draft', 'agent-c': 'Original C draft' } })
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  vi.spyOn(api.sessions, 'messageEvents').mockImplementation(async (reference, options = {}): Promise<AgentMuxRpcResult<'message.events'>> => {
    // Original Core reads can report the already available observation state again.
    // Bound this deliberately adversarial fixture so a broken callback cannot loop forever.
    if (options.messageId && ++verificationReads > 5) throw Error('Unexpected automatic body reread')
    for (const listener of [...listeners]) listener({ type: 'core', hostId: reference.hostId, event: { type: 'agent-message-observation', state: 'available' } })
    const events = records.filter(item => item.sequence > (options.afterSequence ?? 0) && item.messages.some(ref =>
      (!options.messageId || options.messageId === ref.messageId) && (ref.senderSessionId === reference.agentSessionId || ref.recipientSessionId === reference.agentSessionId)))
    return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, afterSequence: options.afterSequence ?? 0,
      latest: options.latest ?? false, beforeSequence: options.beforeSequence ?? null, throughSequence: Math.max(...records.map(item => item.sequence)),
      incarnation: 'original-journal', messageId: options.messageId ?? null, broadcastOperationId: null, events: options.messageId ? events.slice(-1) : events,
      nextAfterSequence: null, nextBeforeSequence: null }
  })
  vi.spyOn(api.sessions, 'spawns').mockImplementation(async (reference, options) => ({ hostId: reference.hostId, participantSessionId: reference.agentSessionId,
    direction: options.direction, creatorRuntimeId: null, records: [], nextCursor: null, coverage: { scope: 'selected-owner', history: 'recorded-creations' } }))
  vi.spyOn(api.sessions, 'readMessage').mockImplementation(async (reference, id) => ({ hostId: reference.hostId, message: id === 'message-c'
    ? message(id, 'agent-c', 'agent-d', 'Current C body.') : message(id) }))
  vi.spyOn(api.sessions, 'dispatch').mockRejectedValue(Error('No supervised body demand'))
})

it('keeps the original body DOM and selection through another source update and repeated available reports', async () => {
  await render(); await clickText('All areas'); await selectRelation()
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); await clickText('Read original message')
  const detail = graph().querySelector('[data-message-id="message-a"]')!, body = bodyNode()!
  expect(body).not.toBeNull(); expect(body.textContent).toContain('Original body')
  const range = document.createRange(); range.selectNodeContents(body); getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
  const selection = getSelection()!.toString(); expect(selection.length).toBeGreaterThan(0)
  expect(api.sessions.readMessage).toHaveBeenCalledExactlyOnceWith(subject('agent-a'), 'message-a')
  records.push(event(9, 'message-c-progress', 'agent-c', 'agent-d'))
  await emit(changed(9, 'agent-c', 'agent-d'))
  for (let index = 0; index < 3; ++index) await emit({ type: 'agent-message-observation', state: 'available' })
  expect(graph().querySelector('[data-message-id="message-a"]')).toBe(detail); expect(bodyNode()).toBe(body)
  expect(getSelection()!.toString()).toBe(selection); expect(api.sessions.readMessage).toHaveBeenCalledTimes(1)
  expect(verificationReads).toBe(1); expect(graph().querySelector('.focus-context[data-session-id="agent-a"]')).not.toBeNull()
  expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
})

it('starts body reading only on demand and keeps a failed original read local and retryable', async () => {
  vi.mocked(api.sessions.readMessage).mockRejectedValueOnce(Error('Original body temporarily unavailable'))
  await render(); await selectRelation(); expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
  await clickText('Read original message')
  expect(graph().textContent).toContain('Original body temporarily unavailable')
  expect(graph().querySelector('.focus-context[data-session-id="agent-a"]')).not.toBeNull()
  expect(graph().querySelector('.focus-context[data-session-id="agent-b"]')).not.toBeNull()
  const retry = graph().querySelector<HTMLButtonElement>('[aria-label="Read original message"]')!
  expect(retry).toBeDefined(); await act(async () => retry.click())
  expect(bodyNode()!.textContent).toContain('Original body'); expect(graph().textContent).not.toContain('temporarily unavailable')
  expect(api.sessions.readMessage).toHaveBeenCalledTimes(2); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})

it('keeps an already opened original body when broadening the observed participant set', async () => {
  await render(); await selectRelation(); await clickText('Read original message')
  const body = bodyNode()!, range = document.createRange(); expect(body).not.toBeNull()
  range.selectNodeContents(body); getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
  const selected = getSelection()!.toString()
  await clickText('All areas')
  expect(bodyNode()).toBe(body); expect(getSelection()!.toString()).toBe(selected)
  expect(api.sessions.readMessage).toHaveBeenCalledTimes(1)
  expect(graph().querySelector('.focus-context[data-session-id="agent-c"]')).not.toBeNull()
})

it('retains the actual original body and selection while the document is hidden and resumes in place', async () => {
  await render(); await selectRelation(); await clickText('Read original message')
  const body = bodyNode()!, range = document.createRange(), hidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  expect(body).not.toBeNull(); range.selectNodeContents(body); getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
  const selected = getSelection()!.toString(), sourceReads = vi.mocked(api.sessions.messageEvents).mock.calls.length
  try {
    await act(async () => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    expect(bodyNode()).toBe(body); expect(getSelection()!.toString()).toBe(selected)
    records.push(event(9, 'hidden-update')); await emit(changed(9))
    expect(api.sessions.messageEvents).toHaveBeenCalledTimes(sourceReads); expect(api.sessions.readMessage).toHaveBeenCalledTimes(1)
    expect(bodyNode()).toBe(body)
    await act(async () => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    expect(bodyNode()).toBe(body); expect(getSelection()!.toString()).toBe(selected)
    expect(graph().textContent).toContain('hidden-update'); expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
  } finally {
    if (hidden) Object.defineProperty(document, 'hidden', hidden)
    else Reflect.deleteProperty(document, 'hidden')
  }
})

it('cannot publish an old body into a new scope or reopen its closed reading surface', async () => {
  const oldBody = deferred<AgentMuxRpcResult<'message.read'>>()
  vi.mocked(api.sessions.readMessage).mockImplementationOnce(() => oldBody.promise)
  await render(); await selectRelation(); await clickText('Read original message')
  await render(second); await selectRelation('Task C', 'Task D'); await clickText('Read original message')
  expect(bodyNode()!.textContent).toBe('Current C body.')
  await act(async () => oldBody.resolve({ hostId: 'local', message: message('message-a', 'agent-a', 'agent-b', 'STALE A BODY') }))
  expect(bodyNode()!.textContent).toBe('Current C body.'); expect(graph().textContent).not.toContain('STALE A BODY')
  await render(null); expect(graph()).toBeNull()
  const count = vi.mocked(api.sessions.readMessage).mock.calls.length
  await emit(changed(10)); expect(api.sessions.readMessage).toHaveBeenCalledTimes(count)
})

it.each(['message', 'graph', 'reopened-message'] as const)('does not begin an expired body fetch after its qualification returns to a closed %s', async closed => {
  await render(); await selectRelation()
  const qualification = deferred<AgentMuxRpcResult<'message.events'>>()
  vi.mocked(api.sessions.messageEvents).mockImplementationOnce(() => qualification.promise)
  await clickText('Read original message')
  if (closed === 'graph') await render(null)
  else { await clickText('Close message'); if (closed === 'reopened-message') await clickText('Read original message') }
  await act(async () => qualification.resolve({ hostId: 'local', participantSessionId: 'agent-a', afterSequence: 0, latest: true, beforeSequence: null,
    throughSequence: 8, incarnation: 'original-journal', messageId: 'message-a', broadcastOperationId: null, events: [records[0]!], nextAfterSequence: null, nextBeforeSequence: null }))
  if (closed === 'reopened-message') expect(api.sessions.readMessage).toHaveBeenCalledExactlyOnceWith(subject('agent-a'), 'message-a')
  else expect(api.sessions.readMessage).not.toHaveBeenCalled()
  if (closed === 'graph') expect(graph()).toBeNull()
  else if (closed === 'message') expect(bodyNode()).toBeNull()
  else expect(bodyNode()!.textContent).toContain('Original body')
})

it('does not begin a supervised request body read after its qualification returns to a closed graph', async () => {
  records = [records[0]!, { ...records[0]!, sequence: 8, kind: 'dispatch-open' }]
  await render(); await selectRelation('Task A', 'Task B', 'supervision')
  expect(api.sessions.dispatch).not.toHaveBeenCalled()
  const qualification = deferred<AgentMuxRpcResult<'message.events'>>()
  vi.mocked(api.sessions.messageEvents).mockImplementationOnce(() => qualification.promise)
  await clickText('Read supervised request'); await render(null)
  await act(async () => qualification.resolve({ hostId: 'local', participantSessionId: 'agent-a', afterSequence: 0, latest: true, beforeSequence: null,
    throughSequence: 8, incarnation: 'original-journal', messageId: 'message-a', broadcastOperationId: null, events: [records[1]!], nextAfterSequence: null, nextBeforeSequence: null }))
  expect(api.sessions.dispatch).not.toHaveBeenCalled(); expect(graph()).toBeNull()
})

it('expires each real live pulse independently while later traffic continues on another relation', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(fixtureEpoch(1))
  let reading!: ReturnType<typeof useCollaborationReading>
  function PulseProbe() { reading = useCollaborationReading([subject('agent-a'), subject('agent-c')], true); return null }
  try {
    await dom.render(<PulseProbe />)
    records.push(event(9, 'live-9')); await emit(changed(9)); expect(reading.pulses.map(pulse => pulse.sender)).toEqual(['agent-a'])
    await act(async () => { vi.advanceTimersByTime(1000) })
    records.push(event(10, 'live-10', 'agent-c', 'agent-d')); await emit(changed(10, 'agent-c', 'agent-d'))
    expect(reading.pulses.map(pulse => pulse.sender)).toEqual(['agent-a', 'agent-c'])
    await act(async () => { vi.advanceTimersByTime(801) })
    expect(reading.pulses.map(pulse => pulse.sender)).toEqual(['agent-c'])
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(reading.pulses).toEqual([])
  } finally { vi.useRealTimers() }
})


it('consumes retained incremental facts in the real Dialog without redecoding status or rebuilding unchanged cards', async () => {
  useAppStore.setState({ sessions: [...sessions, { ...sessions[0]!, id: 'alias-a' }] })
  let decoded = 0
  const row = event(7, 'message-a'), refs = row.messages
  Object.defineProperty(row, 'messages', { get() { decoded++; return refs } })
  let currentRows = [row]
  vi.mocked(api.sessions.messageEvents).mockImplementation(async (reference, options = {}) => ({
    hostId: reference.hostId, participantSessionId: reference.agentSessionId, afterSequence: options.afterSequence ?? 0,
    latest: options.latest ?? false, beforeSequence: options.beforeSequence ?? null, throughSequence: currentRows.at(-1)!.sequence,
    incarnation: 'original-journal', messageId: null, broadcastOperationId: null,
    events: currentRows.filter(item => item.sequence > (options.afterSequence ?? 0)), nextAfterSequence: null, nextBeforeSequence: null
  }))
  const context = vi.spyOn(focusContext, 'agentContextForSession')
  await render()
  expect(decoded).toBe(1); expect(graph().querySelectorAll('.collaboration-agent')).not.toHaveLength(0)
  const contextCalls = context.mock.calls.length
  expect(contextCalls).toBeGreaterThan(0)
  await selectRelation()
  await emit({ type: 'agent-message-observation', state: 'unavailable', message: 'Original observer is unavailable' })
  expect(decoded).toBe(1); expect(context).toHaveBeenCalledTimes(contextCalls)
  const next = event(8, 'second-a'), nextRefs = next.messages
  Object.defineProperty(next, 'messages', { get() { decoded++; return nextRefs } })
  currentRows = [row, next]
  await emit(changed(8))
  expect(decoded).toBe(2); expect(context).toHaveBeenCalledTimes(contextCalls)
  expect(graph().querySelector('.collaboration-evidence')?.textContent).toContain('second-a')
  context.mockClear()
  await act(async () => useAppStore.setState({ agentNames: { ...useAppStore.getState().agentNames, 'agent-b': 'Updated task B' } }))
  expect(context).toHaveBeenCalled()
  expect([...new Set(context.mock.calls.map(([session]) => session.id))]).toEqual(['agent-b'])
  expect(graph().textContent).toContain('Updated task B')
  context.mockClear()
  currentRows = [row, next, event(9, 'new-endpoint', 'agent-a', 'agent-c')]
  await emit(changed(9))
  expect(context).toHaveBeenCalled()
  expect([...new Set(context.mock.calls.map(([session]) => session.id))]).toEqual(['agent-c'])
  expect(api.sessions.readMessage).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
})


it('keeps the original Dialog body mounted while real reading demand leaves and returns to its source', async () => {
  // Inject demand at the original hook argument boundary; the hook, store, projection, Card and Reader remain real.
  const originalHook = collaborationReading.useCollaborationReading
  let demand = [subject('agent-a')]
  vi.spyOn(collaborationReading, 'useCollaborationReading').mockImplementation((_subjects, enabled) => originalHook(demand, enabled))
  await render(); await selectRelation(); await clickText('Read original message')
  const body = bodyNode()!, detail = graph().querySelector('[data-message-id="message-a"]')!
  expect(body.textContent).toContain('Original body with a stable reading selection.')
  const metadataA = () => vi.mocked(api.sessions.messageEvents).mock.calls.filter(([reference, options]) => reference.agentSessionId === 'agent-a' && !options?.messageId)
  const before = metadataA().length
  expect(before).toBe(1); expect(api.sessions.readMessage).toHaveBeenCalledTimes(1)
  demand = [subject('agent-c')]; await render()
  expect(metadataA()).toHaveLength(before); expect(bodyNode()).toBe(body)
  expect(graph().querySelector('[data-message-id="message-a"]')).toBe(detail)
  demand = [subject('agent-a')]; await render()
  expect(metadataA().at(-1)![1]).toEqual({ afterSequence: 8, incarnation: 'original-journal', limit: 50 })
  expect(metadataA().filter(([, options]) => options?.latest)).toHaveLength(1)
  expect(bodyNode()).toBe(body); expect(api.sessions.readMessage).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
})
