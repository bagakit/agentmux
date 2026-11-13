// @vitest-environment happy-dom
import { fixturePath as _hygiene_fixturePath } from '../scripts/lib/fixture-values.mjs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SessionSnapshot } from '../src/shared/contracts'
import { act, createElement } from 'react'
import { createClientUiRoot } from './helpers/client-ui-render'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'

// The composer's Send while a question or permission is pending. The store must hold the message
// unbound until Core settles that exact request: no Core input call while it is known to be pending,
// one delivery after it ends, and a second card keeps it waiting.
const initial = useAppStore.getState(), sid = 'pending-send-session', runId = 'pending-send-run'
const idle: Extract<SessionSnapshot, { kind: 'agent' }> = { id: sid, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local',
  workspacePath: _hygiene_fixturePath('private'), label: 'Original', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null,
  processState: 'running', status: { state: 'done', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none', promptExecution: { immediate: 'native-steer' } },
  control: { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId } } }
const pending = (id = 'first-request'): typeof idle => ({ ...idle, status: { state: 'waiting', source: 'native-hook', observedAt: 2 },
  pendingInteraction: { kind: 'permission', id, agentSessionId: sid, title: 'Allow command?', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
    evidence: { source: 'native-hook', observedAt: 2, run: { runId }, hookReceiptId: id } } } as typeof idle)
const queue = () => useAppStore.getState().agentSteerQueues[sid] ?? []

/**
 * Core's own session event for this Session, with no pending request: the exact-request-ended wake.
 * The Agent reports `working`, not a fresh `done`, so a turn-completion wake cannot stand in for it.
 */
function clearInteraction() {
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: { kind: 'agent', agentSessionId: sid,
    providerId: idle.providerId, executorId: idle.executorId, hostId: 'local', workspacePath: idle.workspacePath, run: { runId }, retiredRuns: [],
    createdAt: 1, updatedAt: Date.now(), semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now() } } } })
}

beforeEach(async () => {
  const dispose = await useAppStore.getState().initialize(); dispose(); useAppStore.setState(initial, true)
  useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [{ id: 'w', name: 'Private', hostId: 'local', path: _hygiene_fixturePath('private'), kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    sessions: [pending()], agentSteerQueues: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, timelines: {} })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(idle)
  vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null as never)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
})
afterEach(async () => { await useAppStore.getState().flushAgentSteerQueue(sid); useAppStore.setState(initial, true); vi.restoreAllMocks() })

it('Send while a request is pending keeps the message unbound in the queue and writes nothing', async () => {
  // Guard against a vacuous pass: the request really is pending in the store this send reads.
  expect(useAppStore.getState().sessions[0]?.kind === 'agent' && useAppStore.getState().sessions[0].pendingInteraction?.id).toBe('first-request')
  const failures: unknown[] = []
  expect(useAppStore.getState().send(sid, 'use the second option', error => failures.push(error), 'manual')).toBe(true)
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(queue()).toHaveLength(1)
  const [entry] = queue()
  expect(entry).toMatchObject({ text: 'use the second option', runId, origin: 'manual', freshComposerIntent: true, status: 'queued' })
  expect(entry!.directInputBinding).toBeUndefined()
  expect(entry!.execution).toBeDefined()
  expect(entry!.errorCode).toBeUndefined()
  expect(entry!.awaitingExplicitSend).toBeUndefined()
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(api.sessions.inspectInput).not.toHaveBeenCalled()
  expect(failures).toEqual([])
})

it('delivers that message once, in order, after Core reports the exact request ended', async () => {
  useAppStore.getState().send(sid, 'first thought', undefined, 'manual')
  useAppStore.getState().send(sid, 'second thought', undefined, 'manual')
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  // No manual flush: Core's request-ended event alone must wake the parked messages.
  clearInteraction()
  await vi.waitFor(() => expect(queue()).toEqual([]))
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[1])).toEqual(['first thought', 'second thought'])
})

it('keeps the message waiting when the next card is already open after the first one ends', async () => {
  useAppStore.getState().send(sid, 'after the requests', undefined, 'manual')
  await useAppStore.getState().flushAgentSteerQueue(sid)
  // The first request ends, but Core's fresh read shows a second request already open.
  vi.mocked(api.sessions.refresh).mockResolvedValue(pending('second-request'))
  clearInteraction()
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(queue()).toHaveLength(1)
  expect(queue()[0]!.errorCode).toBeUndefined()
  expect(queue()[0]!.awaitingExplicitSend).toBeUndefined()
  // The second request ends as well; now the message goes out exactly once.
  vi.mocked(api.sessions.refresh).mockResolvedValue(idle)
  useAppStore.setState({ sessions: [pending('second-request')] })
  clearInteraction()
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[1])).toEqual(['after the requests'])
  expect(queue()).toEqual([])
})

it('a request that opens after the client check leaves the direct message in Core\'s explicit-rejoin wait, never resent', async () => {
  // The store sees no request, so this Send binds the direct manual input. Core saves it and, finding a
  // request that opened meanwhile, holds it as a wait that only an explicit rejoin continues.
  useAppStore.setState({ sessions: [idle] })
  vi.mocked(api.sessions.submitPrompt).mockImplementationOnce(async (_control, _text, submissionId, binding) => {
    const key = { kind: 'prompt' as const, agentSessionId: sid, expectedRun: { ...binding!.expectedRun }, submissionId: submissionId! }
    const ref = { key, waitGeneration: 1 }
    return { key, ref, persistence: 'confirmed', status: 'waiting', observation: 'rejoin-needed', admission: null,
      control: { ref, state: 'enabled', at: 3, waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin',
        failure: { name: 'AgentMuxError', message: 'Answer the pending Agent interaction before submitting another prompt.', code: 'AGENT_INTERACTION_PENDING' } } } } as never
  })
  const rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting')
  useAppStore.getState().send(sid, 'raced a new card', () => {}, 'manual')
  await vi.waitFor(() => expect(queue()[0]?.inputReceipt?.status).toBe('waiting'))
  expect(queue()[0]).toMatchObject({ text: 'raced a new card', inputIntakeStarted: true })
  // That request ends. Neither the queue nor the receipt wakes the message; the person continues it.
  useAppStore.setState({ sessions: [pending('late-request')] })
  clearInteraction()
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
  expect(rejoin).not.toHaveBeenCalled()
  expect(queue()).toHaveLength(1)
  expect(queue()[0]!.inputReceipt?.control.waiting?.wake).toBe('explicit-rejoin')
})

it('a queued message refused by a request Core saw first is paused, not retried when that request ends', async () => {
  // Bare Enter queues without a direct binding. The drain's fresh read shows no request, then Core
  // refuses because one opened. The queue pauses that message; the request ending does not resend it.
  useAppStore.setState({ sessions: [idle] })
  const late = Object.assign(new Error('Answer the pending Agent interaction before submitting another prompt.'), { code: 'AGENT_INTERACTION_PENDING' })
  vi.mocked(api.sessions.submitPrompt).mockRejectedValueOnce(late)
  expect(useAppStore.getState().enqueueAgentSteer(sid, 'queued before the card', () => {}, undefined, 'manual')).toBeTruthy()
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(queue()[0]).toMatchObject({ text: 'queued before the card', status: 'deferred', awaitingExplicitSend: true, errorCode: 'AGENT_INTERACTION_PENDING' })
  const attempts = vi.mocked(api.sessions.submitPrompt).mock.calls.length
  useAppStore.setState({ sessions: [pending('late-request')] })
  clearInteraction()
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls.length).toBe(attempts)
  expect(queue()[0]!.awaitingExplicitSend).toBe(true)
})

it('the public message.pending.send of a never-sent composer message waits for the request instead of writing', async () => {
  // A composer message queued with bare Enter, then sent by a trusted CLI or device while a card is open.
  expect(useAppStore.getState().enqueueAgentSteer(sid, 'from the outbox', () => {}, undefined, 'manual')).toBeTruthy()
  const pendingId = queue()[0]!.operationId
  const receipt = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'pending-send', operation: 'message.pending.send', agentSessionId: sid, pendingId })
  expect(receipt).toMatchObject({ operation: 'message.pending.send', pendingId, disposition: 'unconfirmed', message: { delivery: 'not-submitted' } })
  expect(queue()[0]!.directInputBinding).toBeUndefined()
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(api.sessions.inspectInput).not.toHaveBeenCalled()
  clearInteraction()
  await vi.waitFor(() => expect(queue()).toEqual([]))
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[1])).toEqual(['from the outbox'])
})

it('a message already bound to direct input before the request opened goes to Core, not into the queue wait', async () => {
  // Bound with no request in sight, then a card opens before the drain reaches it. Only Core can now say
  // what happened to that input, so the queue must not park it as if it would wake by itself.
  useAppStore.setState({ sessions: [idle] })
  let opened = false
  vi.mocked(api.sessions.inspectInput).mockImplementation(async () => { opened = true; return null as never })
  useAppStore.getState().send(sid, 'bound before the card', () => {}, 'manual')
  useAppStore.setState({ sessions: [pending('opened-after-bind')] })
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(opened).toBe(true)
  expect(queue()[0]?.directInputBinding).toBeDefined()
})

it('without a pending request Send still binds the direct input path', async () => {
  useAppStore.setState({ sessions: [idle] })
  useAppStore.getState().send(sid, 'plain send', undefined, 'manual')
  await useAppStore.getState().flushAgentSteerQueue(sid)
  // The direct path asks Core for the original input first; that is the binding this change withholds.
  expect(api.sessions.inspectInput).toHaveBeenCalled()
})

const queuedNative = (): typeof idle => ({ ...pending(), nativeHandle: { kind: 'provider', providerId: idle.providerId, sessionId: 'original-native' },
  capabilities: { ...idle.capabilities, nativeConversationInput: { managedRuns: true, interactionQueue: true, idleQueue: false } } })

it('the mounted native queue composer keeps its empty input prompt consistent with fresh Send', async () => {
  useAppStore.setState({ sessions: [queuedNative()], agentComposerDrafts: {} })
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(AgentSessionComposer, { sessionId: sid, visible: true })))
    expect(container.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe('Message the Agent; the request stays open…')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('fresh Send uses the exact native queue without settling the request; unknown input releases the next Send', async () => {
  useAppStore.setState({ sessions: [queuedNative()] })
  vi.mocked(api.sessions.submitPrompt).mockImplementation(async (_control, _text, submissionId, binding) => {
    const key = { kind: 'prompt' as const, agentSessionId: sid, expectedRun: binding!.expectedRun, submissionId: submissionId! }
    const ref = { key, waitGeneration: 1 }
    return { key, ref, persistence: 'confirmed', status: 'unknown', observation: 'unknown', admission: null,
      control: { ref, state: 'disabled', at: 3 } } as never
  })
  useAppStore.getState().send(sid, 'first native message', undefined, 'manual')
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(queue()[0]).toMatchObject({ text: 'first native message', inputIntakeStarted: true, inputReceipt: { status: 'unknown' },
    directInputBinding: { expectedRun: { runId }, admissionIntent: { kind: 'native-conversation', source: { providerId: idle.providerId, nativeSessionId: 'original-native' } } } })
  expect(useAppStore.getState().agentSteerInFlight[sid]).toBeUndefined()
  const original = queue()[0]!
  useAppStore.getState().send(sid, 'independent next message', undefined, 'manual')
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map(call => call[1])).toEqual(['first native message', 'independent next message'])
  expect(queue()[0]).toEqual(original)
  expect(useAppStore.getState().sessions[0]).toMatchObject({ pendingInteraction: { id: 'first-request' }, control: idle.control })
})

it('new native queue capability never drains old after-request messages in the background', async () => {
  useAppStore.getState().send(sid, 'old parked message', undefined, 'manual')
  await useAppStore.getState().flushAgentSteerQueue(sid)
  useAppStore.setState({ sessions: [queuedNative()] })
  await useAppStore.getState().flushAgentSteerQueue(sid)
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(queue()[0]!.directInputBinding).toBeUndefined()
  await useAppStore.getState().sendQueuedAgentSteer(sid, queue()[0]!.operationId)
  // The existing attempt already owns its after-request condition; even explicit resend
  // cannot silently replace that frozen plan with the new carrier.
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})
