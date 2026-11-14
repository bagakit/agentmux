import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { AgentMuxControlServer, AgentMuxFileAgentSessionStore, connectAgentMuxRpc, connectHostedAgentMux,
  type AgentMuxRpcCallContext, type AgentMuxRpcMethod, type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRuntimeFence } from '@agentmux/core'
import type { NodePublishingMethod, NodePublishingParams, NodePublishingResults } from '@agentmux/core/node-publishing'
import { headlessFixture } from '../../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../../packages/core/test/helpers/object-cli-rpc.js'
import { RuntimeController } from '../../src/main/runtime-controller.js'
import { registerNodePublishingIpc } from '../../src/main/node-publishing-ipc.js'
import { desktopRpcMethods } from '../../src/main/desktop-rpc-exposure.js'
import { assertAppDocumentSender } from '../../src/main/ipc-sender-trust.js'
import { createRendererNodePublishing } from '../../src/renderer/src/lib/node-publishing-client.js'
import type { AppConfig, HostConfig, AgentMuxPreloadApi } from '../../src/shared/contracts.js'

export type ClusterResourceCall = { hostId: string; method: string; params: unknown; runtimeFence?: AgentMuxRuntimeFence; result?: unknown; code?: string }
export async function clusterResourceFixture() {
  const releases: Array<() => void | Promise<void>> = []
  const originals: Awaited<ReturnType<typeof headlessFixture>>[] = []
  const calls: ClusterResourceCall[] = []
  try {
    for (let index = 0; index < 2; index++) {
      const previous = process.env.AGENTMUX_TEST_OWNER_ENTRY
      process.env.AGENTMUX_TEST_OWNER_ENTRY = resolve('apps/desktop/test/fixtures/cluster-resource-core.mjs')
      try { const original = await headlessFixture(); originals.push(original); releases.push(() => original.cleanup()) }
      finally { if (previous === undefined) delete process.env.AGENTMUX_TEST_OWNER_ENTRY; else process.env.AGENTMUX_TEST_OWNER_ENTRY = previous }
    }
    const users = await Promise.all(originals.map(original => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: original.socketPath } })))
    for (const rpc of users) releases.push(() => rpc.dispose())
    const privateA = originals[0]!, publishedB = originals[1]!
    const endpoint = JSON.parse(await readFile(join(publishedB.env.AGENTMUX_STATE_DIRECTORY!, 'cluster-device-endpoint.json'), 'utf8')) as { host: string; port: number }
    const device = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${endpoint.port}/`, token: 'private-cluster-device' } })
    releases.push(() => device.dispose())
    const transports = [users[0]!, device]
    const hostIds = ['local', 'published-device']
    const carriers = await Promise.all(transports.map(async (rpc, index) => {
      const hostId = hostIds[index]!
      const carrier = await connectHostedAgentMux({ rpc, expectedRuntimeId: originals[index]!.owner.runtimeId,
        forwardRpc: async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext = {}, expectedOwner?: AgentMuxRuntimeFence): Promise<AgentMuxRpcResult<M>> => {
          const fence = expectedOwner ?? context.runtimeFence
          const call: ClusterResourceCall = { hostId, method, params, ...(fence ? { runtimeFence: fence } : {}) }; calls.push(call)
          try {
            const result = await rpc.call(method, params, { ...(context.signal ? { signal: context.signal } : {}), ...(context.caller ? { credentials: context.caller } : {}), ...(fence ? { runtimeFence: fence } : {}) })
            call.result = result
            return result
          } catch (error) { call.code = (error as { code?: string }).code ?? 'UNKNOWN'; throw error }
        } })
      releases.push(() => carrier.dispose())
      await carrier.connect()
      return carrier
    }))
    const hosts: HostConfig[] = [
      { id: 'local', kind: 'local', label: 'Private original Core' },
      // The injected product connector below selects a private loopback carrier.
      // No SSH process, external address or real saved user config is consulted.
      { id: 'published-device', kind: 'ssh', label: 'Published original Core', hostname: 'unused-private-carrier.invalid', runtimeId: publishedB.owner.runtimeId }
    ]
    const config: AppConfig = { version: 9, hosts, executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    const runtime = new RuntimeController(new AgentMuxFileAgentSessionStore(privateA.env.AGENTMUX_AGENT_SESSION_STORE!), async host => {
      const index = hostIds.indexOf(host.id); if (index < 0) throw Error('No private original carrier for this saved Host')
      return carriers[index]!
    })
    releases.push(() => runtime.dispose())
    runtime.commit(await runtime.prepare(config))
    const desktop = new AgentMuxControlServer({ socketPath: join(privateA.env.AGENTMUX_RUNTIME_DIRECTORY!, 'cluster-desktop.sock'),
      exposedMethods: desktopRpcMethods(), coreClients: () => runtime.rpcClients(),
      hostConfiguration: id => hosts.find(host => host.id === id) ?? null,
      callOriginalCore: runtime.callOriginalCore.bind(runtime) })
    releases.push(() => desktop.stop()); await desktop.start()
    const desktopRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } }); releases.push(() => desktopRpc.dispose())
    class Sender extends EventEmitter {
      id = 79
      mainFrame = { url: 'file:///private/cluster/index.html', detached: false, isDestroyed: () => false }
      isDestroyed() { return false }
    }
    const sender = new Sender(), event = { sender, senderFrame: sender.mainFrame }
    const handlers = new Map<string, (...args: any[]) => any>()
    const owner = registerNodePublishingIpc({ handle: (name, listener) => { handlers.set(name, (e, ...args) => {
      assertAppDocumentSender(e, sender, { current: { mode: 'prod', filePath: '/private/cluster/index.html' }, loading: null })
      return listener(e, ...args as never)
    }) }, call: (method, params, context) => desktopRpc.call<NodePublishingMethod>(method, params as AgentMuxRpcParams<NodePublishingMethod>, context) as Promise<NodePublishingResults[NodePublishingMethod]>, owner: runtime.callNodeOwner.bind(runtime) })
    releases.push(() => owner.dispose())
    let sequence = 0
    let rendererTransform: ((method: NodePublishingMethod, envelope: unknown) => unknown) | undefined
    const invoke = async (channel: string, ...args: unknown[]) => await handlers.get(channel)!(event, ...args)
    const preload: AgentMuxPreloadApi['nodePublishing'] = {
      call: async (method, params, context) => {
        const token = 'cluster-resource-' + (++sequence), pending = invoke('nodePublishing:call', token, method, params)
        const release = context?.onAbort?.(() => { void invoke('nodePublishing:cancel', token) })
        try { const reply = await pending; return rendererTransform ? rendererTransform(method, reply) : reply } finally { release?.() }
      },
      owner: async (target, method, params, context) => {
        const token = 'cluster-owner-' + (++sequence), pending = invoke('nodePublishing:owner', token, target, method, params)
        const release = context?.onAbort?.(() => { void invoke('nodePublishing:cancel', token) })
        try { const reply = await pending; return rendererTransform ? rendererTransform(method, reply) : reply } finally { release?.() }
      }
    }
    const renderer = createRendererNodePublishing(preload)
    const setupPublication = async (shareResources: boolean) => {
      const current = await users[1]!.call('settings.node.inspect', {})
      return await users[1]!.call('settings.node.configure', { expectedRevision: current.policyRevision, operationId: 'cluster-publication-' + (shareResources ? 'enabled' : 'withheld'), policy: { ...current.policy, alias: 'published-original-node', shareResources } })
    }
    const env = objectCliEnvironment(privateA.root, { HOME: privateA.env.HOME! })
    const cli = (index: 0 | 1, args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + originals[index]!.socketPath, ...args], env, '', 30000)
    const close = async () => {
      const errors: unknown[] = []
      for (const release of releases.splice(0).reverse()) try { await release() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Cluster resource private cleanup')
    }
    return { originals, users, carriers, runtime, desktop, renderer, calls, hosts, cli, setupPublication, close,
      async loadedOriginalOwners(): Promise<Array<Array<{ path: string; processId: number; originalSHA256: string; loadedSHA256: string }>>> {
        return await Promise.all(originals.map(async original => (await readFile(join(original.env.AGENTMUX_STATE_DIRECTORY!, 'cluster-resources-owner-loaded.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))))
      },
      transformRendererReplies(next?: typeof rendererTransform) { rendererTransform = next } }
  } catch (error) {
    for (const release of releases.splice(0).reverse()) try { await release() } catch { /* preserve original startup failure */ }
    throw error
  }
}
