// @vitest-environment happy-dom
import { fixturePath as _hygiene_fixturePath } from '../scripts/lib/fixture-values.mjs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SessionSnapshot } from '../src/shared/contracts'

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

it('without a pending request Send still binds the direct input path', async () => {
  useAppStore.setState({ sessions: [idle] })
  useAppStore.getState().send(sid, 'plain send', undefined, 'manual')
  await useAppStore.getState().flushAgentSteerQueue(sid)
  // The direct path asks Core for the original input first; that is the binding this change withholds.
  expect(api.sessions.inspectInput).toHaveBeenCalled()
})
