// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-original-terminal /> }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div data-original-activity /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-original-composer /> }))
import type { AgentExecutionInspection } from '@agentmux/core'
import type { AgentExecutionRecoveryReference, AgentLaunchResult } from '../src/shared/contracts'
import { registerExecutionBindingIpc } from '../src/main/execution-binding-ipc'
import { ExecutionBindingReaders } from '../src/main/execution-binding-readers'
import { createExecutionBindingApi } from '../src/preload/execution-binding'
import { sessionAgentLaunchResult, unwrapSessionAgentLaunchResult, unconfirmedSessionAgentLaunch } from '../src/shared/session-agent-launch-result'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), message = 'Original frontend preparation needs the current Core. This is historical text.'
const coordinator = { hostId: 'local', runtimeId: 'original-coordinator-runtime' }
const ref = { bindingId: 'original-binding', agentSessionId: 'original-agent', createOperationId: 'original-create' }
const target: AgentExecutionRecoveryReference = { coordinator, reference: ref, failure: { reference: ref, hostId: 'farm', role: 'frontend', stage: 'prepare' } }
const observation = (): AgentExecutionInspection => ({ bindingId: ref.bindingId, agentHostId: 'local', resourceHostId: 'farm', agentSessionId: ref.agentSessionId, resourceWorkspacePath: '/project', state: 'unavailable', continuation: ref,
  helperStarts: { executor: { outcome: 'not-submitted', runId: null }, frontend: { outcome: 'not-submitted', runId: null } } })
const session = composerSession(ref.agentSessionId)
const created: AgentLaunchResult['created'] = { kind: 'agent', agentSessionId: ref.agentSessionId, hostId: 'local', providerId: 'codex', executorId: 'codex', workspacePath: session.workspacePath,
  run: session.control.run, retiredRuns: [], createdAt: 1, updatedAt: 1, creation: { createOperationId: ref.createOperationId, initialPrompt: 'confirmed' } }
const result: AgentLaunchResult = { created, creation: created.creation!, session, projectionFailures: [] }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function seed() {
  const tab = createWorkbenchTab('view', { kind: 'agent', phase: 'launching', regionId: 'region', workspaceId: 'workspace', sessionId: ref.agentSessionId })
  useAppStore.setState({ config: { ...composerConfig, hosts: [...composerConfig.hosts, { id: 'farm', kind: 'ssh', label: 'Farm', hostname: 'private.example.invalid' }] },
    sessions: [composerSession('healthy-neighbor')], tabs: { view: tab }, layouts: { workspace: createWorkspaceLayout('pane', ['view']) }, activeWorkspaceId: 'workspace',
    agentComposerDrafts: { region: 'Keep original @relative/input unsent.' }, pendingAgentLaunches: { [ref.agentSessionId]: { events: [], overflowed: false,
      request: { executorId: 'codex', hostId: 'local', workspacePath: session.workspacePath, createOperationId: ref.createOperationId, prompt: 'Exact original prompt', launcher: { tabId: 'view', regionId: 'region' }, executionWorkspaceId: 'workspace' },
      requestIssue: { code: 'REMOTE_CORE_UPGRADE_REQUIRED', message, executionRecovery: target } } } })
}
function bridge() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>(), bus = new EventEmitter()
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (channel: string, value: unknown) => bus.emit(channel, {}, value) })
  const inspect = vi.fn(async () => observation()), continuation = vi.fn(async () => ({ session: created, execution: observation() }))
  const readers = new ExecutionBindingReaders(inspect), owner = vi.fn(async (value: typeof coordinator) => { if (value.hostId !== coordinator.hostId || value.runtimeId !== coordinator.runtimeId) throw Error('Original Coordinator Runtime mismatch') })
  registerExecutionBindingIpc({ handle: (channel, handler) => { handlers.set(channel, (...values) => handler({ sender } as never, ...values)) },
    bindings: { inspect, rejoin: async () => observation(), continueOriginal: continuation }, readers, coordinator: owner, project: async () => result })
  const ipc = { invoke: vi.fn(async (channel: string, ...values: unknown[]) => structuredClone(await handlers.get(channel)!(...values))), on: vi.fn(), off: vi.fn() }
  ipc.on.mockImplementation((channel, listener) => { bus.on(channel, listener) }); ipc.off.mockImplementation((channel, listener) => { bus.off(channel, listener) })
  const apiBridge = createExecutionBindingApi(ipc)
  for (const name of ['executionBinding', 'observeExecutionBinding', 'continueExecution'] as const) vi.spyOn(api.sessions, name).mockImplementation(apiBridge[name] as never)
  return { readers, inspect, continuation, owner, apiBridge, ipc }
}
const pane = (visible = true) => <SessionPane sessionId={ref.agentSessionId} surfaceKind="agent" visible={visible} interactiveResize={false}
  linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'pane', tabId: 'view', regionId: 'region' }} />
async function click(text: string) { const button = [...dom.container.querySelectorAll('button')].find(node => node.textContent === text); expect(button).toBeDefined(); await act(async () => button!.click()) }
it('formal Main carrier and native partializer retain the original reference; a stripped transport cannot invent one', async () => {
  seed()
  const carrier = structuredClone(await sessionAgentLaunchResult(ref, async () => { throw Object.assign(new Error(message), { executionRecovery: target }) }))
  expect(() => unwrapSessionAgentLaunchResult(carrier)).toThrow(expect.objectContaining({ executionRecovery: target }))
  const partial = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(partial).toHaveProperty(['pendingAgentLaunches', ref.agentSessionId, 'requestIssue', 'executionRecovery'], target)
  expect(partial).not.toHaveProperty(['pendingAgentLaunches', ref.agentSessionId, 'events'])
  expect(unconfirmedSessionAgentLaunch(ref, Object.assign(new Error(message), { executionRecovery: target }))).not.toHaveProperty('executionRecovery')
})
it('real SessionPane reads through registered Main IPC and preload; current facts lead, no passive continuation, exact explicit original adoption', async () => {
  seed(); const original = useAppStore.getState(), b = bridge()
  await dom.render(pane()); await vi.waitFor(() => expect(b.inspect).toHaveBeenCalled())
  expect(dom.container.querySelector('.surface-state__title')?.textContent).toBe('Continue the original request')
  expect(dom.container.querySelector('details')?.textContent).toContain('frontend · prepare · Farm')
  expect([...dom.container.querySelectorAll('details')].find(node => node.textContent?.includes('Last attempt'))?.textContent).toContain(message)
  expect(b.continuation).not.toHaveBeenCalled()
  await click('Refresh original status'); expect(b.continuation).not.toHaveBeenCalled()
  await act(async () => b.readers.publish({ ...observation(), state: 'connected' }))
  expect(dom.container.querySelector('.surface-state__title')?.textContent).toBe('Original tools are connected')
  expect(dom.container.querySelector('.surface-state__description')?.textContent).not.toContain(message)
  await click('Continue original request')
  expect(b.continuation).toHaveBeenCalledExactlyOnceWith(ref)
  expect(useAppStore.getState().sessions.find(value => value.id === ref.agentSessionId)?.control).toEqual(session.control)
  expect(useAppStore.getState().agentComposerDrafts).toBe(original.agentComposerDrafts)
  expect(useAppStore.getState().sessions.find(value => value.id === 'healthy-neighbor')).toEqual(original.sessions[0])
  b.readers.dispose()
})
it('optional exact-Host update check failure does not gate the original action or trigger it automatically', async () => {
  seed(); const b = bridge(), update = vi.spyOn(api.hosts, 'upgradeCheck').mockRejectedValue(new Error('Optional deployment read unavailable'))
  await dom.render(pane()); await vi.waitFor(() => expect(b.inspect).toHaveBeenCalled())
  await click('Check Core update')
  expect(update.mock.calls[0]![0].id).toBe('farm')
  expect(dom.container.textContent).toContain('Core update check unavailable')
  expect([...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Continue original request')?.disabled).toBe(false)
  expect(b.continuation).not.toHaveBeenCalled(); b.readers.dispose()
})
it('a late continuation cannot replace an occupied original slot or a newer healthy original Session', async () => {
  seed(); const b = bridge(), response = deferred<Awaited<ReturnType<typeof b.continuation>>>()
  b.continuation.mockReturnValue(response.promise)
  await dom.render(pane()); await vi.waitFor(() => expect(b.inspect).toHaveBeenCalled()); await click('Continue original request')
  const next = createWorkbenchTab('view', { kind: 'agent', phase: 'attached', regionId: 'region', workspaceId: 'workspace', sessionId: 'healthy-replacement' })
  const healthy = composerSession('healthy-replacement')
  await act(async () => useAppStore.setState(state => ({ tabs: { view: next }, sessions: [...state.sessions, healthy] })))
  const before = useAppStore.getState(); await act(async () => { response.resolve({ session: created, execution: observation() }); await response.promise })
  expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(b.continuation).toHaveBeenCalledOnce(); b.readers.dispose()
})
it('hidden pending work releases its own reader and ignores old observations without stopping the owner', async () => {
  seed(); const b = bridge(); await dom.render(pane()); await vi.waitFor(() => expect(b.inspect).toHaveBeenCalled())
  await dom.render(pane(false)); expect(b.ipc.invoke).toHaveBeenCalledWith('sessions:releaseExecutionBinding', expect.any(String))
  await act(async () => b.readers.publish({ ...observation(), state: 'connected' }))
  expect(dom.container.querySelector('.surface-state__title')?.textContent).not.toBe('Original tools are connected')
  expect(b.continuation).not.toHaveBeenCalled(); b.readers.dispose()
})
it('the original Coordinator Runtime fence rejects only a wrong-target continuation', async () => {
  seed(); const b = bridge()
  await expect(b.apiBridge.continueExecution({ ...target, coordinator: { ...coordinator, runtimeId: 'another-runtime' } })).rejects.toThrow('Original Coordinator Runtime mismatch')
  expect(b.continuation).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions[0]?.id).toBe('healthy-neighbor'); b.readers.dispose()
})

it('an unavailable binding read keeps the acknowledged original continuation usable', async () => {
  seed(); const b = bridge(); b.inspect.mockRejectedValue(new Error('Optional original observation unavailable'))
  await dom.render(pane()); await vi.waitFor(() => expect(dom.container.textContent).toContain('Latest observation: Optional original observation unavailable'))
  expect(b.continuation).not.toHaveBeenCalled()
  await click('Continue original request'); expect(b.continuation).toHaveBeenCalledExactlyOnceWith(ref)
  expect(useAppStore.getState().sessions.some(value => value.id === ref.agentSessionId)).toBe(true); b.readers.dispose()
})
it('a late original result cannot replace a newer healthy Run at the same SID', async () => {
  seed(); const b = bridge(), response = deferred<Awaited<ReturnType<typeof b.continuation>>>(); b.continuation.mockReturnValue(response.promise)
  await dom.render(pane()); await vi.waitFor(() => expect(b.inspect).toHaveBeenCalled()); await click('Continue original request')
  const healthy = { ...session, control: { ...session.control, run: { runId: 'newer-healthy-original-run' } } }
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, healthy] })))
  const before = useAppStore.getState(); await act(async () => { response.resolve({ session: created, execution: observation() }); await response.promise })
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().sessions.find(value => value.id === ref.agentSessionId)?.control.run.runId).toBe('newer-healthy-original-run'); b.readers.dispose()
})
it('hiding releases observation without revoking the already-authorized exact result or moving focus', async () => {
  seed(); const b = bridge(), response = deferred<Awaited<ReturnType<typeof b.continuation>>>(); b.continuation.mockReturnValue(response.promise)
  await dom.render(pane()); await vi.waitFor(() => expect(b.inspect).toHaveBeenCalled()); await click('Continue original request')
  await dom.render(pane(false)); const selection = useAppStore.getState().workbenchSpaceSelection, draft = useAppStore.getState().agentComposerDrafts
  await act(async () => { response.resolve({ session: created, execution: observation() }); await response.promise })
  expect(useAppStore.getState().sessions.find(value => value.id === ref.agentSessionId)?.control).toEqual(session.control)
  expect(useAppStore.getState().workbenchSpaceSelection).toBe(selection); expect(useAppStore.getState().agentComposerDrafts).toBe(draft); b.readers.dispose()
})
it('JSON-looking error prose never becomes a formal original Coordinator reference in the real launch surface', async () => {
  seed(); const b = bridge()
  const launcher = createWorkbenchTab('view', { kind: 'launcher', regionId: 'region', workspaceId: 'workspace' })
  useAppStore.setState({ tabs: { view: launcher }, pendingAgentLaunches: {} })
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    const prose = JSON.stringify({ ...target, reference: { ...ref, agentSessionId: input.agentSessionId, createOperationId: input.createOperationId } })
    return unwrapSessionAgentLaunchResult(await sessionAgentLaunchResult(input, async () => { throw new Error(prose) }))
  })
  await useAppStore.getState().launchAgent('codex', 'Exact original prompt', 'pane', { tabId: 'view', regionId: 'region' }).catch(() => {})
  const [id, pending] = Object.entries(useAppStore.getState().pendingAgentLaunches)[0]!
  expect(pending.requestIssue).not.toHaveProperty('executionRecovery')
  await dom.render(<SessionPane sessionId={id} surfaceKind="agent" visible interactiveResize={false} linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'pane', tabId: 'view', regionId: 'region' }} />)
  expect(b.inspect).not.toHaveBeenCalled(); expect(b.continuation).not.toHaveBeenCalled(); b.readers.dispose()
})
it('a replacement original reference cannot inherit the previous request helper facts when its reader fails', async () => {
  seed(); const b = bridge()
  b.inspect.mockResolvedValue({ ...observation(), helperStarts: { executor: { outcome: 'confirmed', runId: 'old-helper' }, frontend: { outcome: 'confirmed', runId: 'old-frontend' } } })
  await dom.render(pane()); await vi.waitFor(() => expect(dom.container.textContent).toContain('Start receipt confirmed'))
  b.inspect.mockRejectedValue(new Error('Replacement original observation unavailable'))
  const nextRef = { ...ref, bindingId: 'replacement-binding', createOperationId: 'replacement-operation' }
  await act(async () => useAppStore.setState(state => ({ pendingAgentLaunches: { ...state.pendingAgentLaunches, [ref.agentSessionId]: {
    ...state.pendingAgentLaunches[ref.agentSessionId]!, request: { ...state.pendingAgentLaunches[ref.agentSessionId]!.request!, createOperationId: nextRef.createOperationId },
    requestIssue: { message: 'Replacement original request is unconfirmed.', code: null, executionRecovery: { ...target, reference: nextRef, failure: { ...target.failure!, reference: nextRef } } }
  } } })))
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Replacement original observation unavailable'))
  expect(dom.container.textContent).not.toContain('Start receipt confirmed')
  expect(b.continuation).not.toHaveBeenCalled(); b.readers.dispose()
})
