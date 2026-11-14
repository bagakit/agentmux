// @vitest-environment happy-dom
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { act } from 'react'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxHostedForwardRpc } from '@agentmux/core/hosted'
import { createTakeoverOwnerFixture } from '../../../packages/core/test/helpers/takeover-owner'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import type { FocusContextAccess } from '../src/renderer/src/lib/focus-context-access'
import { agentRegionLocationBindings, useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'

const cleanup: Array<() => unknown | Promise<unknown>> = []
let f: Awaited<ReturnType<typeof createTakeoverOwnerFixture>>
let sourceRpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>
beforeEach(async () => {
  f = await createTakeoverOwnerFixture(cleanup)
  const spatial = (await f.spatial.read())!, graph = spatial.graph
  const regionKey = 'region:original-region'
  graph.resources[regionKey] = { ...graph.resources[regionKey] as object,
    agentPresentation: { sessionId: f.source.agentSessionId, agentSessionId: f.source.agentSessionId, hostId: 'local' } }
  await f.spatial.commit({ expectedRevision: spatial.revision, graph })
  sourceRpc = f.rpc
  const forwardRpc: AgentMuxHostedForwardRpc = (method, params, context = {}, fence) => sourceRpc.call(method, params,
    { ...(context.signal ? { signal: context.signal } : {}), ...(fence ? { runtimeFence: fence } : {}) })
  const client = new Proxy(f.client, { get(target, key) {
    if (key === 'forwardRpc') return forwardRpc
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  }, has(target, key) { return key === 'forwardRpc' || Reflect.has(target, key) } })
  const config = { ...composerConfig, executors: { codex: { ...composerConfig.executors.codex!, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'project-a', hostId: 'local', path: f.source.workspacePath, name: 'Original Project', kind: 'folder' as const },
      { id: 'project-b', hostId: 'local', path: f.directory, name: 'Destination Project', kind: 'folder' as const }] }
  const main = await owningBridge({ client, store: f.store, config, publicCoreEndpointPath: f.endpointPath, spatialStatePath: f.spatial.path })
  cleanup.push(() => main.dispose())
})
const dom = composerDOM({ agentInformation: true })
beforeEach(async () => {
  useAppStore.setState({ config: { ...composerConfig, workspaces: [
  { id: 'project-a', hostId: 'local', path: f.source.workspacePath, name: 'Original Project', kind: 'folder' },
  { id: 'project-b', hostId: 'local', path: f.directory, name: 'Destination Project', kind: 'folder' }
] }, loading: true, sessions: [], tabs: {}, layouts: {}, mainSurface: 'agents', agentNames: {}, agentComposerDrafts: {} })
  cleanup.push(await useAppStore.getState().initialize())
  await vi.waitFor(async () => expect(await f.client.readAgentSession(f.source.agentSessionId)).toMatchObject({ continuity: { kind: 'reattachable', trigger: 'startup' } }))
  const observed = (await f.client.readAgentSession(f.source.agentSessionId))!
  expect(observed.run).toEqual(f.source.run)
  f.source = observed
})
afterEach(async () => { await useAppStore.getState().retryWorkbenchSave(); for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })

const reader = () => document.querySelector<HTMLElement>('.agent-information-reader')!
const relation = () => reader()?.querySelector<HTMLElement>('[aria-label="Recorded Takeover relationships"]')!
const button = (parent: ParentNode, name: string) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name)!
const snapshot = (id: string, run: { runId: string }, path: string) => ({ ...composerSession(id), workspacePath: path,
  control: { kind: 'agent' as const, hostId: 'local', agentSessionId: id, run } })
async function create(operationId: string) {
  const opened = await api.spatial.openAgent({ operationId, content: { kind: 'takeover-agent', executorId: 'codex', source: {
    hostId: 'local', expectedRuntimeId: f.owner.runtimeId, agentSessionId: f.source.agentSessionId, expectedRun: f.source.run,
    organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId }
  } }, destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group', newTab: true }, focus: false })
  expect(opened.outcome, JSON.stringify(opened)).toBe('opened')
  return opened.agent!
}
async function openSource(session: ReturnType<typeof snapshot>, access?: FocusContextAccess) {
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Keep the original unsent input.' } })
  const base = agentContextForSession(session, undefined, 'Original Agent', useAppStore.getState().config!.workspaces[0])
  await dom.render(<WorkspaceAgentRow context={access ? { ...base, access } : base} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={() => { throw Error('Reading cannot start an Agent') }} />)
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.focus-context')!.focus())
  await vi.waitFor(() => expect(reader()).not.toBeNull())
  await act(async () => reader().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!.click())
  await act(async () => button(reader().querySelector('.agent-information-details__tabs')!, 'Source').click())
  await vi.waitFor(() => { expect(relation()).not.toBeNull(); expect(relation().textContent).not.toContain('Reading recorded Takeovers…') })
  if (!access) expect(agentRegionLocationBindings()?.find(region => region.agentSessionId === session.control.agentSessionId)?.execution?.runtimeId).toBe(f.owner.runtimeId)
}
async function refresh() {
  await act(async () => button(relation(), 'Refresh Takeover records').click())
  await vi.waitFor(() => expect(relation().textContent).not.toContain('Reading recorded Takeovers…'))
}
async function originalPreserved() {
  const after = (await f.client.readAgentSession(f.source.agentSessionId))!
  const changed = Object.keys({ ...f.source, ...after }).filter(key => JSON.stringify(Reflect.get(after, key)) !== JSON.stringify(Reflect.get(f.source, key)))
  expect(after, JSON.stringify({ changed, added: changed.filter(key => !Object.hasOwn(f.source, key)).map(key => [key, Reflect.get(after, key)]) })).toEqual(f.source)
}

it('the original Source reader consumes real paged Core records through complete Main registration and preload', async () => {
  const starts = f.started.length
  const created = []
  for (let index = 0; index < 11; index++) created.push(await create('source-page-' + index))
  const session = snapshot(f.source.agentSessionId, f.source.run, f.source.workspacePath)
  await openSource(session)
  expect(relation().querySelectorAll('ul:last-of-type li'), relation().textContent ?? '').toHaveLength(10)
  expect(button(relation(), 'More destinations')).toBeDefined()
  await act(async () => button(relation(), 'More destinations').click())
  await vi.waitFor(() => expect(relation().querySelectorAll('ul:last-of-type li')).toHaveLength(11))
  expect(button(relation(), 'More destinations')).toBeUndefined()
  for (const child of created) expect(relation().textContent).toContain(child.agentSessionId)
  const queries = bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:takeovers').map(call => call[1])
  expect(queries).toEqual([
    { expectedRuntimeId: f.owner.runtimeId, direction: 'outgoing', subject: { runtimeId: f.owner.runtimeId, agentSessionId: f.source.agentSessionId }, limit: 10 },
    { expectedRuntimeId: f.owner.runtimeId, direction: 'incoming', subject: { runtimeId: f.owner.runtimeId, agentSessionId: f.source.agentSessionId }, limit: 10 },
    expect.objectContaining({ expectedRuntimeId: f.owner.runtimeId, direction: 'outgoing', subject: { runtimeId: f.owner.runtimeId, agentSessionId: f.source.agentSessionId }, cursor: expect.any(String), limit: 10 })
  ])
  expect(f.started).toHaveLength(starts + 11)
  await originalPreserved()
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the original unsent input.')
})

it('incoming reads use the actual admission index when the receiving access has no creation provenance', async () => {
  const starts = f.started.length
  const child = await create('incoming-without-projection'), session = snapshot(child.agentSessionId, { runId: child.runId! }, f.directory)
  const access: FocusContextAccess = { identity: { runtimeId: f.owner.runtimeId, agentSessionId: child.agentSessionId }, locations: [], session,
    select: vi.fn(), open: vi.fn(), refresh: vi.fn(), isCurrent: () => true }
  expect(session).not.toHaveProperty('creation')
  await openSource(session, access)
  const incoming = relation().querySelector('ul')!
  expect(incoming.textContent).toContain(f.source.agentSessionId)
  expect(incoming.textContent).toContain('Transfer')
  expect(relation().textContent).toContain('Creation metadata has not been read')
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:creation')).toEqual([])
  expect(f.started).toHaveLength(starts + 1)
  await originalPreserved()
})

it('retirement and owner observation failures stay visible and converge through the same real Source read', async () => {
  const starts = f.started.length
  const child = await create('outgoing-retained'), session = snapshot(f.source.agentSessionId, f.source.run, f.source.workspacePath)
  await openSource(session)
  expect(relation().textContent, relation().textContent ?? '').toContain('Created Agent recorded')
  f.inner.kernel.prepareStop = async (runId: string, operationKey: string) => ({ daemonInstance: 'fixture-runtime', operationKey, runId })
  f.inner.kernel.remove = async () => {}
  await f.client.stopAgent(child.agentSessionId, { runId: child.runId! }, { operationId: 'retire-created-for-source' })
  await refresh(); expect(relation().textContent).toContain('Created, then closed')
  const read = f.client.readAgentSession.bind(f.client)
  const unavailable = vi.spyOn(f.client, 'readAgentSession').mockImplementation(async id => {
    if (id === child.agentSessionId) throw Error('The original created Agent observation is unavailable.')
    return read(id)
  })
  await refresh()
  expect(relation().textContent).toContain('Creation result unconfirmed')
  expect(relation().textContent).toContain('The original created Agent observation is unavailable.')
  expect(relation().textContent).toContain(child.agentSessionId)
  unavailable.mockRestore(); await refresh()
  expect(relation().textContent).toContain('Created, then closed')
  expect(f.started).toHaveLength(starts + 1)
  await originalPreserved()
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the original unsent input.')
})

it('the accepted original Region rejects another actual Core with the same Session and Run before relationship lookup', async () => {
  const starts = f.started.length, other = await rpcOwnerFixture([f.source.agentSessionId]); cleanup.push(other.close)
  const sameSid = (await other.store.load()).find(session => session.agentSessionId === f.source.agentSessionId)!
  await other.store.compareAndSwap(sameSid, { ...sameSid, run: f.source.run })
  const reboundOwner = { ...f.owner, runtimeId: 'rebound-source-runtime', ownerInstanceId: 'rebound-source-instance' }
  const hosted = new AgentMuxHostedRuntimeService(other.client, null, () => reboundOwner); cleanup.push(() => hosted.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(other.root, 'rebound.sock'), coreClients: () => [{ hostId: 'local', client: other.client }], hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  sourceRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sourceRpc.dispose())
  expect((await other.client.readAgentSession(f.source.agentSessionId))!.run).toEqual(f.source.run)
  bridge.invoke.mockClear()
  const session = snapshot(f.source.agentSessionId, f.source.run, f.source.workspacePath)
  expect(session).not.toHaveProperty('creation')
  await openSource(session)
  expect(bridge.invoke).toHaveBeenCalledWith('sessions:owner', 'local', f.owner.runtimeId)
  expect(bridge.invoke.mock.calls.some(call => call[0] === 'sessions:takeovers')).toBe(false)
  expect(relation().textContent).toContain('another semantic Runtime')
  expect(useAppStore.getState().sessions[0]!.control.run).toEqual(f.source.run)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the original unsent input.')
  expect(f.started).toHaveLength(starts)
})

it('a newly admitted Agent also reads its incoming original record from the accepted Core binding', async () => {
  const starts = f.started.length, child = await create('source-admitted-child')
  await useAppStore.getState().refreshSpatialState()
  expect(agentRegionLocationBindings()?.find(region => region.agentSessionId === child.agentSessionId)?.execution?.runtimeId).toBe(f.owner.runtimeId)
  await openSource(snapshot(child.agentSessionId, { runId: child.runId! }, f.directory))
  expect(relation().textContent).toContain('Original Agent ' + f.source.agentSessionId)
  expect(relation().textContent).toContain('Transfer')
  expect(f.started).toHaveLength(starts + 1)
  await originalPreserved()
})
