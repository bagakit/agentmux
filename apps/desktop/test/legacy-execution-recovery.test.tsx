// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div /> }))
vi.mock('../src/renderer/src/components/ActivityView', () => ({ ActivityView: () => <div /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div /> }))
import { AgentExecutionBindingService, AgentMuxError } from '@agentmux/core'
import { originalExecutionBindingId } from '../src/main/execution-binding-reference'
import { registerExecutionBindingIpc } from '../src/main/execution-binding-ipc'
import { ExecutionBindingReaders } from '../src/main/execution-binding-readers'
import { createExecutionBindingApi } from '../src/preload/execution-binding'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), sid = 'original-legacy-session', cid = 'original-legacy-create', hostId = 'local', resource = { hostId: 'project', path: '/original/project' }, coordinator = { hostId: 'local', runtimeId: 'original-coordinator' }, cause = 'Previous original launch returned an error; no new formal carrier existed.'
const release: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of release.splice(0).reverse()) await close() })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'amx-legacy-intent-')); release.push(() => rm(dir, { recursive: true, force: true }))
  const resolveHost = vi.fn(async () => { throw new AgentMuxError('Original endpoint preparation was unavailable.', 'CONTROL_UNAVAILABLE') })
  const owner = new AgentExecutionBindingService(dir, { resolveHost }); release.push(() => owner.dispose())
  const bindingId = originalExecutionBindingId(hostId, sid, cid)
  const input = { bindingId, agentHostId: hostId, agentRuntimeId: 'original-agent-runtime', resourceHostId: resource.hostId, resourceRuntimeId: 'original-project-runtime', resourceWorkspacePath: resource.path,
    resourceGrant: { scope: 'host-user' as const, bindingId }, agent: { agentSessionId: sid, createOperationId: cid, executorId: 'codex', executorRevision: 'original-executor', workspacePath: '/original/agent', prompt: 'Exact original private input' } }
  await expect(owner.create(input)).rejects.toThrow('Original endpoint preparation was unavailable.')
  const originalReads = resolveHost.mock.calls.length, inspect = vi.spyOn(owner, 'inspect'), continueOriginal = vi.spyOn(owner, 'continueOriginal')
  const handlers = new Map<string, (...values: unknown[]) => unknown>(), bus = new EventEmitter(), sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (channel: string, value: unknown) => bus.emit(channel, {}, value) })
  const readers = new ExecutionBindingReaders(id => owner.inspect(id)); release.push(() => readers.dispose())
  const target = vi.fn(async () => coordinator), assertCoordinator = vi.fn(async (value: typeof coordinator) => { if (value.runtimeId !== coordinator.runtimeId || value.hostId !== coordinator.hostId) throw Error('Wrong original Coordinator') })
  registerExecutionBindingIpc({ handle: (channel, handler) => { handlers.set(channel, (...values) => handler({ sender } as never, ...values)) }, bindings: owner, readers, coordinatorTarget: target, coordinator: assertCoordinator,
    project: async () => { throw Error('No Session creation projection during this read') } })
  const ipc = { invoke: vi.fn(async (channel: string, ...args: unknown[]) => structuredClone(await handlers.get(channel)!(...args))), on: vi.fn((channel, fn) => { bus.on(channel, fn) }), off: vi.fn((channel, fn) => { bus.off(channel, fn) }) }, bridge = createExecutionBindingApi(ipc)
  for (const method of ['resolveExecutionBinding', 'observeExecutionBinding', 'executionBinding', 'continueExecution'] as const) vi.spyOn(api.sessions, method).mockImplementation(bridge[method] as never)
  return { dir, input, owner, inspect, continueOriginal, resolveHost, originalReads, target, assertCoordinator, ipc, bridge }
}
function seed(toolWorkspace: { hostId: string; path: string } | undefined = resource) {
  const tab = createWorkbenchTab('view', { kind: 'agent', phase: 'launching', regionId: 'region', workspaceId: 'workspace', sessionId: sid })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, { id: 'changed-config', hostId: resource.hostId, path: '/edited/path', name: 'Changed config', kind: 'folder' }] },
    sessions: [composerSession('healthy-neighbor')], tabs: { view: tab }, layouts: { workspace: createWorkspaceLayout('pane', ['view']) }, activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Preserve this unsent draft' },
    pendingAgentLaunches: { [sid]: { events: [], overflowed: false, request: { executorId: 'codex', hostId, createOperationId: cid, workspacePath: '/original/agent', launcher: { tabId: 'view', regionId: 'region' }, ...(toolWorkspace ? { toolWorkspace: { ...toolWorkspace, id: 'changed-config' } } : {}), prompt: 'Exact original private input' }, requestIssue: { code: 'COMMAND_TIMEOUT', message: cause } } } })
}
const pane = (visible = true) => <SessionPane sessionId={sid} surfaceKind="agent" visible={visible} interactiveResize={false} linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'pane', tabId: 'view', regionId: 'region' }} />
async function check() { const button = [...dom.container.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Check original'); expect(button).toBeDefined(); await act(async () => button!.click()) }
it('real registered Main/preload/Core inspect enriches only the original legacy pending and never advances it', async () => {
  const f = await fixture(); seed(); const before = useAppStore.getState(), bytes = await readFile(join(f.dir, 'bindings.sqlite'))
  await dom.render(pane()); await vi.waitFor(() => expect(useAppStore.getState().pendingAgentLaunches[sid]?.requestIssue?.executionRecovery).toBeDefined())
  const after = useAppStore.getState(), recovery = after.pendingAgentLaunches[sid]!.requestIssue!.executionRecovery!
  expect(recovery).toEqual({ coordinator, reference: { bindingId: f.input.bindingId, agentSessionId: sid, createOperationId: cid } })
  expect(after.pendingAgentLaunches[sid]!.request).toBe(before.pendingAgentLaunches[sid]!.request)
  expect(after.pendingAgentLaunches[sid]!.requestIssue!.message).toBe(cause)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts); expect(after.sessions).toBe(before.sessions)
  expect(f.resolveHost.mock.calls.length).toBe(f.originalReads); expect(f.continueOriginal).not.toHaveBeenCalled()
  expect(await readFile(join(f.dir, 'bindings.sqlite'))).toEqual(bytes)
  expect(dom.container.querySelector('.surface-state__title')?.textContent).toBe('Continue the original request')
  expect(dom.container.textContent).toContain(cause)
  expect(dom.container.textContent).toContain('Continue original request')
})
it('the existing Check original can find the retained intent after an earlier lookup failed; optional Agent read cannot erase it', async () => {
  const f = await fixture(); seed(); f.inspect.mockRejectedValueOnce(new Error('Temporary original read failure'))
  const creation = vi.spyOn(api.sessions, 'creation').mockRejectedValue(new Error('Optional Agent creation read unavailable'))
  await dom.render(pane()); await vi.waitFor(() => expect(dom.container.textContent).toContain('Original intent lookup unavailable'))
  await check(); await vi.waitFor(() => expect(useAppStore.getState().pendingAgentLaunches[sid]!.requestIssue!.executionRecovery).toBeDefined())
  await vi.waitFor(() => expect(creation).toHaveBeenCalledWith(hostId, sid))
  expect(dom.container.textContent).toContain('Continue original request'); expect(f.continueOriginal).not.toHaveBeenCalled()
})
it('missing frozen tool location does not borrow an edited current configuration or parse a notice', async () => {
  const f = await fixture(); seed(undefined)
  useAppStore.setState(state => ({ pendingAgentLaunches: { ...state.pendingAgentLaunches, [sid]: { ...state.pendingAgentLaunches[sid]!, request: { ...state.pendingAgentLaunches[sid]!.request!, toolWorkspace: undefined }, requestIssue: { code: null, message: JSON.stringify({ coordinator, reference: { bindingId: f.input.bindingId, agentSessionId: sid, createOperationId: cid } }) } } } }))
  await dom.render(pane()); expect(f.inspect).not.toHaveBeenCalled(); expect(useAppStore.getState().pendingAgentLaunches[sid]!.requestIssue).not.toHaveProperty('executionRecovery')
})
it('exact original owner and resource mismatches stay unknown without continuing', async () => {
  const f = await fixture(); seed({ ...resource, path: '/edited/path' }); await dom.render(pane())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('did not confirm this retained request'))
  expect(useAppStore.getState().pendingAgentLaunches[sid]!.requestIssue).not.toHaveProperty('executionRecovery'); expect(f.continueOriginal).not.toHaveBeenCalled()
})
it('a late lookup cannot enrich an occupied slot or a replacement original request', async () => {
  const f = await fixture(); seed(); let resolve!: (v: Awaited<ReturnType<typeof f.owner.inspect>>) => void
  const observation = await f.owner.inspect(f.input.bindingId); f.inspect.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await dom.render(pane()); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  const next = createWorkbenchTab('view', { kind: 'agent', phase: 'attached', regionId: 'region', workspaceId: 'workspace', sessionId: 'replacement' })
  await act(async () => useAppStore.setState({ tabs: { view: next } })); await act(async () => resolve(observation))
  expect(useAppStore.getState().pendingAgentLaunches[sid]!.requestIssue).not.toHaveProperty('executionRecovery'); expect(f.continueOriginal).not.toHaveBeenCalled()
})
it('a wrong current Coordinator and hidden late read cannot supply an original reference', async () => {
  const f = await fixture(); seed(); f.target.mockResolvedValue({ ...coordinator, runtimeId: 'wrong-original' }); await dom.render(pane())
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Wrong original Coordinator'))
  expect(f.inspect).not.toHaveBeenCalled(); expect(useAppStore.getState().pendingAgentLaunches[sid]!.requestIssue).not.toHaveProperty('executionRecovery')
})

it('StrictMode setup replay keeps the same visible lookup and original recovery usable', async () => {
  const f = await fixture(); seed()
  await dom.render(<StrictMode>{pane()}</StrictMode>)
  await vi.waitFor(() => expect(useAppStore.getState().pendingAgentLaunches[sid]?.requestIssue?.executionRecovery).toBeDefined())
  await vi.waitFor(() => expect(dom.container.querySelector('.surface-state__title')?.textContent).toBe('Continue the original request'))
  expect(f.continueOriginal).not.toHaveBeenCalled()
})
it('a stored continuation for another create operation cannot become a formal reference', async () => {
  const f = await fixture(), original = await f.owner.inspect(f.input.bindingId)
  f.inspect.mockResolvedValueOnce({ ...original!, continuation: { bindingId: f.input.bindingId, agentSessionId: sid, createOperationId: 'another-create' } })
  const outcome = await f.bridge.resolveExecutionBinding({ hostId, agentSessionId: sid, createOperationId: cid, toolWorkspace: resource }).then(value => ({ value }), error => ({ error }))
  expect(outcome).toMatchObject({ error: { code: 'EXECUTION_INTENT_UNCONFIRMED' } }); expect(f.continueOriginal).not.toHaveBeenCalled()
})
it('hiding releases the visible lookup and ignores its late reference without revoking the original request', async () => {
  const f = await fixture(); seed(); const original = await f.owner.inspect(f.input.bindingId); let resolve!: (v: typeof original) => void
  f.inspect.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await dom.render(pane()); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  await dom.render(pane(false)); const request = useAppStore.getState().pendingAgentLaunches[sid]!.request
  await act(async () => resolve(original))
  expect(useAppStore.getState().pendingAgentLaunches[sid]!.request).toBe(request)
  expect(useAppStore.getState().pendingAgentLaunches[sid]!.requestIssue).not.toHaveProperty('executionRecovery'); expect(f.continueOriginal).not.toHaveBeenCalled()
})
it('an old lookup cannot attach to a new create operation at the same slot and SID', async () => {
  const f = await fixture(); seed(); const original = await f.owner.inspect(f.input.bindingId); let resolve!: (v: typeof original) => void
  f.inspect.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await dom.render(pane()); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  await act(async () => useAppStore.setState(state => ({ pendingAgentLaunches: { ...state.pendingAgentLaunches, [sid]: {
    ...state.pendingAgentLaunches[sid]!, request: { ...state.pendingAgentLaunches[sid]!.request!, createOperationId: 'new-original-create' }
  } } })))
  await act(async () => resolve(original))
  expect(useAppStore.getState().pendingAgentLaunches[sid]!.request!.createOperationId).toBe('new-original-create')
  expect(useAppStore.getState().pendingAgentLaunches[sid]!.requestIssue).not.toHaveProperty('executionRecovery'); expect(f.continueOriginal).not.toHaveBeenCalled()
})
