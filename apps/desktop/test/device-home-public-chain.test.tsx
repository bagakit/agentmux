// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { HostConfig, WorkspaceRecord } from '../src/shared/contracts'
import { registerHostRuntimeObservationIpc } from '../src/main/host-runtime-observation-ipc'
import { createRendererHostObservation } from '../src/renderer/src/lib/host-observation'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), host: HostConfig = { id: 'original-device', kind: 'ssh', label: 'Before name', hostname: 'never-contacted.invalid', runtimeId: 'original-runtime' }
const home: WorkspaceRecord = { id: 'original-device-home', hostId: host.id, name: 'Home', path: homedir(), kind: 'folder' }
const cleanup: Array<() => unknown | Promise<unknown>> = []
class Sender extends EventEmitter { id = 43; isDestroyed() { return false } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(() => {
  useAppStore.setState({ config: { ...structuredClone(composerConfig), hosts: [...composerConfig.hosts, host] }, activeWorkspaceId: 'workspace', mainSurface: 'workbench', workbenchSpaceSelection: null,
    layouts: { workspace: createWorkspaceLayout('original-group') }, tabs: {}, sessions: [composerSession('original-agent')], projectGroups: [], collapsedProjectGroups: {},
    agentComposerDrafts: { 'original-agent': 'Keep the original draft' } })
  vi.spyOn(api.git, 'projectIdentity').mockResolvedValue({ kind: 'not-repository', hostId: 'local', workspacePath: composerConfig.workspaces[0]!.path })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function changeHost(change: (original: HostConfig) => HostConfig) {
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, hosts: state.config!.hosts.map(item => item.id === host.id ? change(item) : item) } })))
}
const rename = () => changeHost(original => { const { label: _label, ...route } = original; return { label: 'After name', ...route } })
async function fixture(beforeRead?: () => Promise<void>) {
  const original = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] })
  const replacement = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] })
  cleanup.push(() => original.dispose(), () => replacement.dispose())
  let currentClient = original
  const connect = vi.spyOn(original, 'connect').mockRejectedValue(new Error('Home must not connect Sessions'))
  const native = vi.spyOn(original, 'connectRuntime').mockRejectedValue(new Error('Home must not prepare Native'))
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: host.id, client: currentClient }],
    hostConfiguration: id => useAppStore.getState().config!.hosts.find(item => item.id === id) ?? null })
  cleanup.push(() => service.dispose())
  const handlers = new Map<string, (...args: any[]) => any>(), sender = new Sender()
  const owner = registerHostRuntimeObservationIpc({ handle: (channel, listener) => { handlers.set(channel, listener) },
    call: (method, params, context) => service.call(method, params, { ...context, transport: 'unix', principal: { kind: 'user', id: 'original-reader' } }) })
  cleanup.push(() => owner.dispose())
  let request = 0
  const bridge = createRendererHostObservation<Awaited<ReturnType<typeof api.hosts.home>>>(async (target, context) => {
    const token = 'original-home-reader-' + ++request, detach = context?.onAbort?.(() => handlers.get('hosts:cancelInspect')!({ sender }, token))
    try { await beforeRead?.(); return await handlers.get('hosts:home')!({ sender }, token, target) } finally { detach?.() }
  })
  const read = vi.spyOn(api.hosts, 'home').mockImplementation(bridge)
  return { original, read, connect, native, replaceClient: () => { currentClient = replacement } }
}
const clickHome = () => act(async () => dom.container.querySelector<HTMLButtonElement>(`[data-folder-host="${host.id}"] .space-section-label`)!.click())

it.each(['before-read', 'during-read', 'during-register'] as const)('actual public Home service → Main read owner → Renderer → Sidebar survives rename %s', async phase => {
  const f = await fixture(phase === 'before-read' ? rename : undefined), gate = deferred<void>(), originalHome = f.original.hostEnvironment.bind(f.original)
  const environment = vi.spyOn(f.original, 'hostEnvironment').mockImplementation(async () => { if (phase === 'during-read') await gate.promise; return originalHome() })
  const registration = deferred<WorkspaceRecord>(), add = vi.spyOn(api.workspaces, 'add').mockReturnValue(phase === 'during-register' ? registration.promise : Promise.resolve(home))
  const launch = vi.spyOn(api.sessions, 'launchAgent'), stop = vi.spyOn(api.sessions, 'stop')
  await dom.render(<WorkspaceSidebar />)
  const before = useAppStore.getState(), layout = before.layouts.workspace
  await clickHome()
  if (phase === 'during-read') { await vi.waitFor(() => expect(environment).toHaveBeenCalled()); await rename(); await act(async () => gate.resolve()) }
  if (phase === 'during-register') { await vi.waitFor(() => expect(add).toHaveBeenCalled()); await rename(); await act(async () => registration.resolve(home)) }
  await vi.waitFor(() => expect(useAppStore.getState().activeWorkspaceId).toBe(home.id))
  expect(f.read).toHaveBeenCalledExactlyOnceWith(host)
  expect(add).toHaveBeenCalledExactlyOnceWith({ hostId: host.id, path: home.path })
  expect(useAppStore.getState().layouts.workspace).toBe(layout)
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(dom.container.querySelector('.space-device-home-status')).toBeNull()
  expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled()
})

it.each(['route', 'client'] as const)('actual public Home service still rejects a changed %s during read and retains the original workface', async change => {
  const f = await fixture(), gate = deferred<void>(), originalHome = f.original.hostEnvironment.bind(f.original)
  const environment = vi.spyOn(f.original, 'hostEnvironment').mockImplementation(async () => { await gate.promise; return originalHome() })
  const add = vi.spyOn(api.workspaces, 'add')
  await dom.render(<WorkspaceSidebar />); const before = useAppStore.getState()
  await clickHome(); await vi.waitFor(() => expect(environment).toHaveBeenCalled())
  if (change === 'route') await changeHost(original => ({ ...original, hostname: 'changed-route.invalid' } as HostConfig)); else f.replaceClient()
  await act(async () => gate.resolve())
  await vi.waitFor(() => expect(dom.container.querySelector('.space-device-home-status')).not.toBeNull())
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace'); expect(add).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toBe(before.sessions); expect(useAppStore.getState().layouts.workspace).toBe(before.layouts.workspace)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})
