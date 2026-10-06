// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi, RuntimeEvent } from '../src/shared/contracts'
const bridge = vi.hoisted(() => ({ api: undefined as AgentMuxPreloadApi | undefined,
  invoke: vi.fn(async (_channel: string, ..._args: unknown[]) => undefined) }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }
}))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { initializeAgentInputOccupation, useAppStore } from '../src/renderer/src/store'
import { agentInputOccupied, observeAgentInputOccupation, readContinuousProgressInput } from '../src/renderer/src/lib/continuous-progress-input'
import * as presentations from '../src/renderer/src/lib/session-presentation'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { moteAgent, moteConfig } from './fixtures/mote-workface'
import { observeAgent, type ContinuousProgressLoop } from '@agentmux/core'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'
import type { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store'

const initial = useAppStore.getState()
const original = { ...moteAgent('rendered-worker', null), hostId: 'original-host',
  control: { kind: 'agent' as const, hostId: 'original-host', agentSessionId: 'original-worker', run: { runId: 'original-run' } } }
let dispose: (() => void) | undefined, root: Root | undefined, container: HTMLDivElement | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, loading: false, config: moteConfig, sessions: [original],
    agentComposerDrafts: {}, agentSteerQueues: {}, agentSteerInFlight: {} }, true)
  bridge.invoke.mockReset().mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockImplementation(control => bridge.api!.sessions.notifyInputOccupation(control))
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  dispose = initializeAgentInputOccupation()
})
afterEach(async () => {
  dispose?.(); dispose = undefined
  if (root) await act(async () => root!.unmount())
  root = undefined; container?.remove(); container = undefined
  useAppStore.setState(initial, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('real Composer editing invokes the real preload with only the original Host, Session and Run', async () => {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(DesktopClientUiProvider, null,
    createElement(AgentSessionComposer, { sessionId: original.id }))))
  const editor = container.querySelector<HTMLElement>('[contenteditable="true"]')!
  expect(editor).not.toBeNull()
  bridge.invoke.mockClear()
  await act(async () => {
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { items: [], getData: (type: string) => type === 'text/plain' ? 'User draft after observation' : '' } })
    editor.dispatchEvent(paste)
  })
  expect(useAppStore.getState().agentComposerDrafts[original.id]).toBe('User draft after observation')
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:inputOccupation')).toEqual([
    ['sessions:inputOccupation', original.control]
  ])
  expect(JSON.stringify(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:inputOccupation'))).not.toContain('User draft')
})

it('reads drafts, queues and in-flight inputs from the same owner rule, skips cleared inputs and Launcher Regions', async () => {
  useAppStore.getState().setAgentComposerDraft(original.id, '   ')
  useAppStore.getState().setAgentComposerDraft('launcher-region', 'Unstarted Launcher')
  useAppStore.getState().setAgentComposerDraft(original.control.agentSessionId, 'Different presentation key')
  expect(api.sessions.notifyInputOccupation).not.toHaveBeenCalled()
  useAppStore.setState({ agentSteerInFlight: { [original.id]: 'original-operation' } })
  expect(agentInputOccupied(useAppStore.getState(), original.id)).toBe(true)
  expect(readContinuousProgressInput(useAppStore.getState(), { requestId: 'original-read', operation: 'continuous-progress.observeInput',
    control: original.control }, new AbortController().signal).occupied).toBe(true)
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledExactlyOnceWith(original.control)
  useAppStore.setState({ agentSteerInFlight: {}, agentComposerDrafts: {} })
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledTimes(1)
  useAppStore.setState({ agentSteerQueues: { [original.id]: [{ operationId: 'queued-operation' } as never] } })
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledTimes(2)
  expect(readContinuousProgressInput(useAppStore.getState(), { requestId: 'queue-read', operation: 'continuous-progress.observeInput',
    control: original.control }, new AbortController().signal).occupied).toBe(true)
  useAppStore.setState({ agentSteerQueues: {} })
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledTimes(2)
})

it('does no additional Session-index work for one hundred unrelated Runtime events or unchanged input entries', () => {
  const index = vi.spyOn(presentations, 'agentSessionPresentationIndex')
  for (let i = 0; i < 100; i++) {
    useAppStore.getState().applyEvent({ hostId: original.hostId,
      event: { type: 'terminal-output', run: original.control.run, data: 'output', sequence: i } } as unknown as RuntimeEvent)
    useAppStore.setState({ sessions: [original, moteAgent('unrelated-' + i, null)] })
  }
  expect(index).not.toHaveBeenCalled()
  expect(api.sessions.notifyInputOccupation).not.toHaveBeenCalled()
  useAppStore.setState({ agentComposerDrafts: { ...useAppStore.getState().agentComposerDrafts } })
  expect(index).not.toHaveBeenCalled()
})

it('notifies only actual changed Session controls while retaining ambiguous or loading input as unknown', () => {
  const neighbor = moteAgent('unrelated-worker', null)
  useAppStore.setState({ sessions: [original, neighbor], agentComposerDrafts: { [neighbor.id]: 'Already present' } })
  vi.mocked(api.sessions.notifyInputOccupation).mockClear()
  useAppStore.getState().setAgentComposerDraft(original.id, 'New input')
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledExactlyOnceWith(original.control)
  vi.mocked(api.sessions.notifyInputOccupation).mockClear()
  useAppStore.setState({ loading: true, agentComposerDrafts: { ...useAppStore.getState().agentComposerDrafts, [original.id]: '' } })
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledExactlyOnceWith(original.control)
  vi.mocked(api.sessions.notifyInputOccupation).mockClear()
  const second = { ...original, hostId: 'another-host', control: { ...original.control, hostId: 'another-host', run: { runId: 'another-original-run' } } }
  useAppStore.setState({ loading: false, sessions: [original, second], agentComposerDrafts: { [original.id]: ' ' } })
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledTimes(2)
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledWith(original.control)
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledWith(second.control)
})

it('reports unavailable notification without deleting the original draft, stopping the Agent or feeding back into the subscription', async () => {
  vi.mocked(api.sessions.notifyInputOccupation).mockRejectedValue(new Error('Original observation unavailable'))
  const stop = vi.spyOn(api.sessions, 'interrupt')
  useAppStore.getState().setAgentComposerDraft(original.id, 'Kept draft')
  await vi.waitFor(() => expect(useAppStore.getState().errorNoticeContext?.kind).toBe('indeterminate'))
  expect(useAppStore.getState().agentComposerDrafts[original.id]).toBe('Kept draft')
  expect(useAppStore.getState().sessions[0]).toBe(original)
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledTimes(1)
  expect(stop).not.toHaveBeenCalled()
  dispose?.(); dispose = undefined
  useAppStore.getState().setAgentComposerDraft(original.id, 'Still usable after disposal')
  expect(api.sessions.notifyInputOccupation).toHaveBeenCalledTimes(1)
})

it('registers one subscription and catches synchronous transport failure without hidden input state', () => {
  const failure = vi.fn(), subscribe = vi.fn()
  observeAgentInputOccupation({ subscribe }, () => { throw new Error('Disconnected') }, failure)
  expect(subscribe).toHaveBeenCalledTimes(1)
  const listener = subscribe.mock.calls[0]![0]
  const state = useAppStore.getState()
  listener({ ...state, agentComposerDrafts: { [original.id]: 'Draft' } }, state)
  expect(failure).toHaveBeenCalledTimes(1)
})

const historicalRef = { key: { kind: 'prompt' as const, agentSessionId: original.control.agentSessionId,
  expectedRun: original.control.run, submissionId: 'original-history' }, waitGeneration: 1 }
const settledHistory = { operationId: 'original-history', archived: true as const,
  inputReceipt: { status: 'admitted' as const, control: { ref: historicalRef, state: 'dispatch-authorized' as const, at: 1, gateId: 'original-gate' } } }

it('does not occupy input for confirmed archived history, including its late observer reply, while preserving unknown originals', () => {
  const state = useAppStore.getState()
  const withEntry = (entry: Parameters<typeof agentInputOccupied>[0]['agentSteerQueues'][string][number]) =>
    ({ ...state, agentSteerQueues: { [original.id]: [entry] }, agentSteerInFlight: { [original.id]: entry.operationId } })
  expect(agentInputOccupied(withEntry(settledHistory), original.id)).toBe(false)
  expect(agentInputOccupied(withEntry({ operationId: 'archived-unknown', archived: true }), original.id)).toBe(true)
  const earlierUnknown = { operationId: 'original-unknown-with-later-preparation-refusal', archived: true as const,
    preparationInputNotApplied: true as const, promptCondition: { expectedRun: original.control.run, afterSubmissionId: null } }
  expect(agentInputOccupied(withEntry(earlierUnknown), original.id)).toBe(true)
  expect(agentInputOccupied(withEntry({ ...settledHistory, inputReceipt: { ...settledHistory.inputReceipt, status: 'unknown' } }), original.id)).toBe(true)
  expect(agentInputOccupied(withEntry({ ...settledHistory, inputReceipt: { status: 'stopped', control: {
    ...settledHistory.inputReceipt.control, state: 'stopped-before-dispatch' } } }), original.id)).toBe(false)
  expect(agentInputOccupied(withEntry({ operationId: 'archived-local', archived: true, promptCondition: null }), original.id)).toBe(false)
  expect(agentInputOccupied({ ...withEntry(settledHistory), agentComposerDrafts: { [original.id]: 'current draft' } }, original.id)).toBe(true)
  expect(agentInputOccupied({ ...withEntry(settledHistory), agentSteerInFlight: { [original.id]: 'another-in-flight' } }, original.id)).toBe(true)
  expect(agentInputOccupied(withEntry({ operationId: 'active-local', promptCondition: null }), original.id)).toBe(true)
})

it('feeds archived history through the actual input projection and Loop scheduler without treating admission as completion', async () => {
  const target = { hostId: original.hostId, agentSessionId: original.control.agentSessionId,
    providerId: original.providerId, workspacePath: original.workspacePath }
  const state = { ...useAppStore.getState(), agentSteerQueues: { [original.id]: [settledHistory] } }
  const input = readContinuousProgressInput(state, { requestId: 'history-read', operation: 'continuous-progress.observeInput',
    control: original.control }, new AbortController().signal)
  expect(input.occupied).toBe(false)
  const run = async (semantic: 'done' | 'working', inputByte: number | null) => {
    let rows: ContinuousProgressLoop[] = [{ loopId: 'original-due-loop', ...target, intervalMs: 10000,
      prompt: 'next original step', nextCheckAt: 0, status: 'active' }]
    const store = { load: async () => structuredClone(rows), save: async (next: ContinuousProgressLoop[]) => { rows = structuredClone(next) } } satisfies Pick<ContinuousProgressLoopStore, 'load' | 'save'>
    const send = vi.fn(async () => 'sent' as const)
    const status = { state: semantic, source: 'native-hook' as const, observedAt: 1 }
    const manager = new ContinuousProgressLoopManager(store as ContinuousProgressLoopStore, send, () => 1, async (_loop, tickId, now) => ({
      session: { ...target, run: original.control.run, semanticStatus: status }, inputByte, inputOccupied: input.occupied,
      observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now), tickId, now }))
    try { await manager.start(); await manager.check(1); return send.mock.calls.length }
    finally { await manager.stop() }
  }
  expect(await run('done', 0)).toBe(1)
  expect(await run('working', 0)).toBe(0)
  expect(await run('done', null)).toBe(0)
})
