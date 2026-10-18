// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxMessageEvent, AgentMuxRpcResult, DurableAgentMuxMessage } from '@agentmux/core'
import { projectRunProcessStatus } from '@agentmux/core/run-status'
import type { RuntimeEvent, SessionHistoryReference } from '../src/shared/contracts'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import * as focusContext from '../src/renderer/src/lib/focus-context'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { AgentCollaborationMap } from '../src/renderer/src/components/AgentCollaborationMap'
import type { CollaborationMapTarget } from '../src/renderer/src/lib/collaboration-map-navigation'
import { useCollaborationReading } from '../src/renderer/src/lib/use-collaboration-reading'
import * as collaborationReading from '../src/renderer/src/lib/use-collaboration-reading'
import { COLLABORATION_ACTIVITY_MS, collaborationAgentPresentation } from '../src/renderer/src/lib/collaboration-map-presentation'

const dom = composerDOM({ agentInformation: true }), workspace = composerConfig.workspaces[0]!
const sessions = ['agent-a', 'agent-b', 'agent-c', 'agent-d'].map(id => ({ ...composerSession(id),
  status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }))
const subject = (agentSessionId: string): SessionHistoryReference => ({ hostId: 'local', agentSessionId })
const original: CollaborationMapTarget = { kind: 'focus', subject: subject('agent-a'), name: 'Task A' }
const second: CollaborationMapTarget = { kind: 'focus', subject: subject('agent-c'), name: 'Task C' }
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
const graph = () => document.querySelector<HTMLElement>('.collaboration-map')!
const bodyNode = () => graph().querySelector<HTMLElement>('.composer-mailbox__detail .log-turn__body')
async function render(request: CollaborationMapTarget | null = original) {
  await dom.render(<AgentCollaborationMap request={request} onViewInFocus={() => { throw Error("Reading cannot navigate") }} onOpen={() => { throw Error('Reading must not navigate') }} />)
  if (request) await settleCollaborationCanvas(() => {
    expect(graph()?.querySelector('.collaboration-agent'), graph()?.textContent).not.toBeNull()
    expect(graph()?.textContent).not.toContain('Reading…')
    expect(graph()?.textContent).not.toContain('Arranging map…')
  })
}
async function clickText(text: string) {
  const button = [...graph().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(button).toBeDefined(); await act(async () => button!.click())
}
async function selectRelation(sender = 'Task A', recipient = 'Task B', kind?: string) {
  let button: HTMLButtonElement | undefined
  await settleCollaborationCanvas(() => {
    button = [...graph().querySelectorAll<HTMLButtonElement>('.collaboration-relation')].find(node => (!kind || node.dataset.kind === kind) && node.getAttribute('aria-label')?.startsWith(sender + ' → ' + recipient + ' · '))
    expect(button, graph().querySelector('.collaboration-inspector')?.textContent).toBeDefined()
  })
  await act(async () => button!.click())
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
  installCollaborationLayoutLoopback()
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue({ sources: [], warnings: [] })
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
  await render(); await selectRelation()
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
  await settleCollaborationCanvas(() => {
    expect(graph().querySelector('.focus-context[data-session-id="agent-a"]')).not.toBeNull()
    expect(graph().querySelector('.focus-context[data-session-id="agent-b"]')).not.toBeNull()
  })
  const retry = graph().querySelector<HTMLButtonElement>('[aria-label="Read original message"]')!
  expect(retry).toBeDefined(); await act(async () => retry.click())
  expect(bodyNode()!.textContent).toContain('Original body'); expect(graph().textContent).not.toContain('temporarily unavailable')
  expect(api.sessions.readMessage).toHaveBeenCalledTimes(2); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})

it('keeps an already opened original body when the known map world grows', async () => {
  await render(); await selectRelation(); await clickText('Read original message')
  const body = bodyNode()!, range = document.createRange(); expect(body).not.toBeNull()
  range.selectNodeContents(body); getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
  const selected = getSelection()!.toString()
  await act(async () => useAppStore.setState({ sessions: [...sessions, composerSession('new-known-agent')] }))
  expect(bodyNode()).toBe(body); expect(getSelection()!.toString()).toBe(selected)
  expect(api.sessions.readMessage).toHaveBeenCalledTimes(1)
  expect(graph().querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('5 Agents')
})

it('retains the opened original message while inspecting its map sources', async () => {
  await render(); await selectRelation(); await clickText('Read original message')
  const body = bodyNode()!, source = graph().querySelector<HTMLButtonElement>('[aria-label="Map sources"]')!
  expect(body).not.toBeNull()
  await act(async () => source.click())
  expect(bodyNode()).toBe(body); expect(body.closest('[hidden]')).not.toBeNull()
  expect(api.sessions.readMessage).toHaveBeenCalledTimes(1)
  expect(graph().querySelector('.collaboration-sources')).not.toBeNull()
  await act(async () => source.click())
  expect(bodyNode()).toBe(body); expect(body.closest('[hidden]')).toBeNull()
  expect(api.sessions.readMessage).toHaveBeenCalledTimes(2)
  expect(api.sessions.readMessage).toHaveBeenLastCalledWith(subject('agent-a'), 'message-a')
  expect(graph().querySelector('.collaboration-endpoints')?.textContent).toContain('Task B')
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
    await settleCollaborationCanvas(() => expect(graph().textContent).toContain('hidden-update'))
    expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
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
  const pulseScope = { current: new Set(['agent-a', 'agent-c'].map(id => JSON.stringify(['local', id]))) }
  function PulseProbe() { reading = useCollaborationReading([subject('agent-a'), subject('agent-c')], true, pulseScope); return null }
  try {
    await dom.render(<PulseProbe />)
    records.push(event(9, 'live-9')); await emit(changed(9)); expect(reading.pulses.map(pulse => pulse.sender)).toEqual(['agent-a'])
    await act(async () => { vi.advanceTimersByTime(1000) })
    records.push(event(10, 'live-10', 'agent-c', 'agent-d')); await emit(changed(10, 'agent-c', 'agent-d'))
    expect(reading.pulses.map(pulse => pulse.sender)).toEqual(['agent-a', 'agent-c'])
    await act(async () => { vi.advanceTimersByTime(COLLABORATION_ACTIVITY_MS - 1000 + 1) })
    expect(reading.pulses.map(pulse => pulse.sender)).toEqual(['agent-c'])
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(reading.pulses).toEqual([])
  } finally { vi.useRealTimers() }
})


it('consumes retained incremental facts in the real Map without redecoding status or rebuilding unchanged cards', async () => {
  useAppStore.setState({ sessions: [...sessions, { ...sessions[0]!, id: 'alias-a' }] })
  const originalHook = collaborationReading.useCollaborationReading
  vi.spyOn(collaborationReading, 'useCollaborationReading').mockImplementation((_subjects, enabled, scope) => originalHook([subject('agent-a')], enabled, scope))
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
  await settleCollaborationCanvas(() => expect(graph().querySelectorAll('.focus-context')).toHaveLength(4))
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
  expect(context).not.toHaveBeenCalled()
  expect(api.sessions.readMessage).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
})


it('keeps the original Map body mounted while real reading demand leaves and returns to its source', async () => {
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

it('keeps a confirmed exited Agent a closed map point while preserving its original error and Focus attention', async () => {
  const exited = { ...sessions[0]!, processState: 'exited' as const,
    status: projectRunProcessStatus({ state: 'exited', source: 'run-process', observedAt: fixtureEpoch(2), exitCode: 17, exitSignal: 'SIGSEGV' }) }
  const runningError = { ...sessions[1]!, status: { state: 'error' as const, source: 'native-hook' as const, observedAt: fixtureEpoch(2) } }
  const unobserved = { ...sessions[2]!, processState: 'exited' as const, runUnobserved: true as const,
    status: projectRunProcessStatus({ state: 'exited', source: 'run-process', observedAt: fixtureEpoch(1), exitCode: 0 }) }
  useAppStore.setState({ sessions: [exited, runningError, unobserved, sessions[3]!] })
  await render()
  const closedPoint = () => graph().querySelector<HTMLButtonElement>('.collaboration-agent__mark[data-tier="closed"][data-session-id="agent-a"]')
  await settleCollaborationCanvas(() => expect(closedPoint()).not.toBeNull())
  expect(graph().querySelector('.focus-context[data-session-id="agent-a"]')).toBeNull()
  expect(focusContext.focusBucketForSession(exited, false)).toBe('attention')
  expect(collaborationAgentPresentation(runningError).tier).toBe('active')
  expect(collaborationAgentPresentation(unobserved).tier).toBe('unknown')
  const control = exited.control
  for (let index = 0; index < 4; ++index) await act(async () => graph().querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click())
  await settleCollaborationCanvas(() => expect(closedPoint()?.closest('.collaboration-agent')?.classList.contains('collaboration-agent--overview')).toBe(true))
  expect(graph().querySelector('.focus-context[data-session-id="agent-a"]')).toBeNull()
  await act(async () => closedPoint()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await settleCollaborationCanvas(() => expect(document.querySelector('.agent-information-reader')).not.toBeNull())
  expect(agentInformationPreview.get()).toMatchObject({ context: { id: 'agent-a', hostId: 'local', runId: 'run-agent-a', state: 'error', processState: 'exited', bucket: 'attention' } })
  expect(document.querySelector('.agent-information-reader')?.textContent).toContain('SIGSEGV')
  expect(useAppStore.getState().sessions[0]!.status).toEqual(exited.status)
  expect(useAppStore.getState().sessions[0]!.control).toBe(control)
  expect(graph().querySelectorAll('.collaboration-edge').length).toBeGreaterThan(0)
  expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})

it('opens the shared reader for a retired map point without inventing a live Session or control', async () => {
  const retired = { hostId: 'local', agentSessionId: 'retained-task', state: 'retired' as const }
  vi.mocked(api.sessions.historySources).mockResolvedValue({ sources: [retired], warnings: [] })
  await render({ kind: 'focus', subject: subject(retired.agentSessionId), name: 'Retained task' })
  let point: HTMLButtonElement | null = null
  await settleCollaborationCanvas(() => {
    point = graph().querySelector<HTMLButtonElement>('.collaboration-agent__mark[data-tier="closed"][data-session-id="retained-task"]')
    expect(point).not.toBeNull()
  })
  await act(async () => { point!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await settleCollaborationCanvas(() => expect(document.querySelector('.agent-information-reader')).not.toBeNull())
  expect(agentInformationPreview.get()).toMatchObject({ context: { id: retired.agentSessionId, hostId: retired.hostId, actionable: false, liveAgent: false }, session: undefined, control: undefined })
  expect(document.querySelector('.agent-information-reader')?.textContent).toContain('Retained Session')
  expect(useAppStore.getState().sessions.some(session => session.id === retired.agentSessionId)).toBe(false)
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})

it('keeps an active catalogue identity missing from the current snapshot readable as unknown on its exact Host', async () => {
  const source = { hostId: 'other-host', agentSessionId: 'unobserved-task', state: 'active' as const }
  vi.mocked(api.sessions.historySources).mockResolvedValue({ sources: [source], warnings: [] })
  await render({ kind: 'focus', subject: { hostId: source.hostId, agentSessionId: source.agentSessionId }, name: 'Unobserved task' })
  let point: HTMLButtonElement | null = null
  await settleCollaborationCanvas(() => {
    point = graph().querySelector<HTMLButtonElement>('.collaboration-agent__mark[data-tier="unknown"][data-session-id="unobserved-task"]')
    expect(point).not.toBeNull()
  })
  await act(async () => point!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await settleCollaborationCanvas(() => expect(document.querySelector('.agent-information-reader')).not.toBeNull())
  expect(agentInformationPreview.get()).toMatchObject({ context: { id: source.agentSessionId, hostId: source.hostId, actionable: false, liveAgent: false }, session: undefined, control: undefined })
  expect(graph().querySelector('.collaboration-inspector')?.textContent).toContain('Current Run unconfirmed')
  expect(useAppStore.getState().sessions.some(session => session.id === source.agentSessionId)).toBe(false)
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})

it('keeps the exact map identity through live removal unknown observation and source-confirmed retirement', async () => {
  const current = { hostId: 'local', agentSessionId: 'agent-a', state: 'active' as const }, closed = { ...current, state: 'retired' as const }
  const retirement = deferred<(typeof closed)[]>()
  vi.mocked(api.sessions.historySources).mockResolvedValueOnce({ sources: [current], warnings: [] }).mockReturnValueOnce(retirement.promise.then(sources => ({ sources, warnings: [] })))
  await render()
  expect(graph().querySelector('.focus-context[data-session-id="agent-a"]')).not.toBeNull()
  await act(async () => {
    useAppStore.setState({ sessions: sessions.filter(session => session.id !== current.agentSessionId) })
    for (const listener of [...listeners]) listener({ type: 'core', hostId: current.hostId,
      event: { type: 'run-removed', agentSessionId: current.agentSessionId, run: { runId: 'run-agent-a' }, evidence: { source: 'run-process', observedAt: 1 } } })
  })
  await settleCollaborationCanvas(() => expect(graph().querySelector('.collaboration-agent__mark[data-tier="unknown"][data-session-id="agent-a"]')).not.toBeNull())
  expect(api.sessions.historySources).toHaveBeenCalledTimes(2)
  expect(graph().querySelector('.collaboration-inspector')?.textContent).toContain(current.agentSessionId)
  expect(graph().querySelector('.collaboration-agent__mark[data-tier="closed"][data-session-id="agent-a"]')).toBeNull()
  await act(async () => retirement.resolve([closed]))
  let point: HTMLButtonElement | null = null
  await settleCollaborationCanvas(() => {
    point = graph().querySelector<HTMLButtonElement>('.collaboration-agent__mark[data-tier="closed"][data-session-id="agent-a"]')
    expect(point).not.toBeNull()
  })
  await act(async () => point!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  await settleCollaborationCanvas(() => expect(document.querySelector('.agent-information-reader')).not.toBeNull())
  expect(agentInformationPreview.get()).toMatchObject({ context: { id: current.agentSessionId, hostId: current.hostId, actionable: false, liveAgent: false }, session: undefined, control: undefined })
  expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})

it('surfaces original catalogue failure with no selection and recovers through its owner while keeping the world usable', async () => {
  const retained = [{ hostId: 'local', agentSessionId: 'retained-task', state: 'retired' as const }]
  vi.mocked(api.sessions.historySources).mockResolvedValueOnce({ sources: retained, warnings: [] })
    .mockRejectedValueOnce(Error('Original catalogue temporarily unavailable')).mockResolvedValueOnce({ sources: retained, warnings: [] })
  await render()
  const card = graph().querySelector('.focus-context[data-session-id="agent-a"]')
  expect(card).not.toBeNull()
  expect(graph().querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('5 Agents')
  await act(async () => graph().querySelector<HTMLButtonElement>('[aria-label="Close map details"]')!.click())
  const inspector = graph().querySelector<HTMLElement>('.collaboration-inspector')!
  expect(inspector.hidden).toBe(true)
  await act(async () => graph().querySelector<HTMLButtonElement>('[aria-label="Refresh graph sources"]')!.click())
  const sourceButton = graph().querySelector<HTMLButtonElement>('[aria-label="Map sources"]')!
  expect(sourceButton.dataset.issue).toBe('true')
  expect(graph().querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('1 source issues')
  expect(graph().querySelector('[aria-label="Map sources"]')?.getAttribute('title')).toContain('5 Agents')
  expect(inspector.hidden).toBe(true)
  expect(graph().querySelector('.focus-context[data-session-id="agent-a"]')).toBe(card)
  expect(graph().querySelector<HTMLInputElement>('[aria-label="Find Agent in map"]')?.disabled).toBe(false)
  await act(async () => sourceButton.click())
  expect(inspector.hidden).toBe(false); expect(inspector.textContent).toContain('Original catalogue temporarily unavailable')
  await clickText('Retry history')
  expect(api.sessions.historySources).toHaveBeenCalledTimes(3)
  expect(inspector.textContent).not.toContain('Original catalogue temporarily unavailable')
  expect(sourceButton.textContent).toBe('Sources')
  expect(graph().querySelector('.focus-context[data-session-id="agent-a"]')).toBe(card)
  expect(useAppStore.getState().agentComposerDrafts['agent-a']).toBe('Original A draft')
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})


it('shows live activity between original referenced Agents outside the catalogue without extending history demand', async () => {
  useAppStore.setState({ sessions: [sessions[0]!] })
  records = [event(7, 'reference-b', 'agent-a', 'external-b'), event(8, 'reference-c', 'agent-a', 'external-c')]
  vi.spyOn(api.sessions, 'historySource').mockImplementation(async reference => ({ reference, source: null, issue: null }))
  await render()
  const referenced = (id: string) => [...graph().querySelectorAll<HTMLElement>('[data-collaboration-agent]')].find(node => node.dataset.collaborationAgent === JSON.stringify(['local', id]))
  await settleCollaborationCanvas(() => { expect(referenced('external-b')).toBeDefined(); expect(referenced('external-c')).toBeDefined() })
  const reads = vi.mocked(api.sessions.messageEvents).mock.calls.length
  await emit(changed(9, 'external-b', 'external-c'))
  expect(referenced('external-b')?.querySelector('[aria-label="Message sent"]')).not.toBeNull()
  expect(referenced('external-c')?.querySelector('[aria-label="Message received"]')).not.toBeNull()
  expect(api.sessions.messageEvents).toHaveBeenCalledTimes(reads)
  expect(vi.mocked(api.sessions.messageEvents).mock.calls.every(([reference]) => reference.agentSessionId === 'agent-a')).toBe(true)
  expect(api.sessions.readMessage).not.toHaveBeenCalled(); expect(api.sessions.dispatch).not.toHaveBeenCalled()
})
