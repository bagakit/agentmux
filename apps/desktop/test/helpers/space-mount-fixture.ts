import type { AppConfig } from '../../src/shared/contracts'
import { expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxControlServer } from '../../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../../packages/core/src/public-rpc-client'
import { AgentMuxSpatialStateStore } from '../../../../packages/core/src/spatial-state'
import { createHostFolderSpaceResource } from '../../../host/src/folder-space-resource'
import { readHostSettingsHosts } from '../../../host/src/settings-hosts-read'
import { RuntimeController } from '../../src/main/runtime-controller'
import { registerSpaceMountIpc } from '../../src/main/space-mount-ipc'
import { createPreloadSpaceMount } from '../../src/preload/space-mount'
import { createRendererSpaceMount } from '../../src/renderer/src/lib/space-mount-api'
import { assertAppDocumentSender } from '../../src/main/ipc-sender-trust'
import type { AgentMuxHostedForwardRpc } from '../../../../packages/core/src/hosted-client-contract'
import type { AgentMuxRpcClient } from '../../../../packages/core/src/public-rpc-client'
import type { IpcMainInvokeEvent, IpcRenderer } from 'electron'


/** Only the configured carrier and Electron delivery are leaves. Business IO, source
 * pinning, Main methods, trusted IPC, Preload and Renderer adapters are production. */
export async function spaceMountFixture(cleanup: Array<() => unknown | Promise<unknown>>) {
  const root = await mkdtemp(join(tmpdir(), 'amx-mounted-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const cores = []
  for (const id of ['local', 'saved-b']) {
    const store = new AgentMuxSpatialStateStore(join(root, id + '.json'))
    const config = join(root, id + '-config.json')
    const workspace = { id: 'same-workspace', hostId: 'local', name: id + ' project', path: '/original/project' }
    await writeFile(config, JSON.stringify({ workspaces: [workspace], hosts: [{ id:'local',kind:'local',label:id+' original Node' },{id:id+'-original-remote',kind:'ssh',label:id+' Agent device',hostname:'private-route.example',identityFile:'/private/original-key',runtimeId:id+'-remote-runtime'}] }))
    const identity = { runtimeId: id + '-runtime', ownerInstanceId: id + '-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' as const }
    const hostChoiceReads = { calls: 0, wait: undefined as Promise<void> | undefined }
    const server = new AgentMuxControlServer({ socketPath: join(root, id + '.sock'), spatialState: store, coreClients: () => [],
      spatialFolderResource: createHostFolderSpaceResource(config),
      forwardControl: async method => { expect(method).toBe('settings.hosts.ls'); hostChoiceReads.calls++; await hostChoiceReads.wait; return { hosts: await readHostSettingsHosts(config) } as never }, snapshot: async () => ({ workspaces: [{ workspaceId: workspace.id, hostId: workspace.hostId,
        name: workspace.name, path: workspace.path, kind: 'directory', projectId: null, repoPath: null, branch: null }] }),
      hostedRuntime: () => ({ call: async (method: string) => { expect(method).toBe('runtime.owner.identity'); return { owner: identity } },
        subscribe: async () => { throw Error('Whole Host/Session observations cannot gate a mounted Space.') }, assertFence: () => {} }) as never })
    cleanup.push(() => server.stop()); await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
    const forwardRpc: AgentMuxHostedForwardRpc = (method, params, context, fence) => rpc.call(method, params, { ...context, ...(fence ? { runtimeFence: fence } : {}) })
    const carrier = { forwardRpc,
      subscribeRpc: rpc.subscribe.bind(rpc) }
    cores.push({ id, store, rpc, identity, workspace, carrier, configurationPath: config, hostChoiceReads })
  }
  return { ...spaceMountTransport(cleanup, cores), cores }
}

/** Reuse this exact trusted Main/Preload/Renderer consumer with another private original Core fixture. */
export function spaceMountTransport(cleanup: Array<() => unknown | Promise<unknown>>, configured: Array<{ id: string; carrier: { forwardRpc: AgentMuxHostedForwardRpc; subscribeRpc: AgentMuxRpcClient['subscribe'] } }>, config?: AppConfig) {
  const routes = new Map(configured.map(core => [core.id, { client: core.carrier }]))
  const runtime = Object.assign(Object.create(RuntimeController.prototype), { hosts: routes, hostReconfigurationReservations: new Map() }) as RuntimeController
  const renderer = new EventEmitter()
  class Sender extends EventEmitter {
    id = 83
    mainFrame = { url: 'file:///private/mount/index.html', detached: false, isDestroyed: () => false }
    isDestroyed() { return false }
    send(channel: string, value: unknown) { renderer.emit(channel, {}, value) }
  }
  const sender = new Sender(), event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>()
  const reader = registerSpaceMountIpc({ runtime, ...(config ? { config: () => config } : {}), handle: (channel, listener) => handlers.set(channel,
    ((event, ...values) => { assertAppDocumentSender(event, sender as never, { current: { mode: 'prod', filePath: '/private/mount/index.html' }, loading: null }); return listener(event, ...values as never) })) })
  cleanup.push(() => reader.dispose())
  const ipc = { invoke: async (channel: string, ...values: unknown[]) => await handlers.get(channel)!(event, ...values),
    on: renderer.on.bind(renderer), removeListener: renderer.removeListener.bind(renderer) } as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
  const api = createRendererSpaceMount(createPreloadSpaceMount(ipc))
  return { api, routes, sender, renderer, event, handlers }
}
