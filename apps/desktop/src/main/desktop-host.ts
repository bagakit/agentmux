import { join, resolve } from 'node:path'
import { ensureMacosHostService, macosHostService, type MacosHostServiceOwner } from '@agentmux/host/macos-service'
import { AgentMuxFileAgentSessionStore, AgentMuxError, connectAgentMuxRpc,
  connectSshAgentMux, defaultAgentMuxControlSocketPath, observeRead, probeSocketLiveness,
  type AgentMuxAgentSessionStore,
  type AgentMuxRpcMethod, type AgentMuxRpcParams, type AgentMuxRpcCallContext, type AgentMuxRpcResult, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamParams, type AgentMuxRpcSubscriptionOptions, type AgentMuxRpcSubscription,
  type AgentMuxClient, type AgentMuxRuntimeFence } from '@agentmux/core'
import { connectHostedAgentMux, type AgentMuxHostedRpcPort, type AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { HostConfig } from '../shared/contracts.js'

export type DesktopRuntimeClient = AgentMuxClient | AgentMuxHostedClient
export type DesktopRuntimeConnector = (config: HostConfig, store: AgentMuxAgentSessionStore) => Promise<DesktopRuntimeClient>
const launches = new Map<string, Promise<MacosHostServiceOwner>>()
type OriginalDesktopTransport = {
  call<M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext, expectedOwner?: AgentMuxRuntimeFence): Promise<AgentMuxRpcResult<M>>
  subscribe<M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>, expectedOwner?: AgentMuxRuntimeFence): Promise<AgentMuxRpcSubscription>
}
const originalTransports = new WeakMap<DesktopRuntimeClient, OriginalDesktopTransport>()

/** Borrow the original Host transport without changing the client's local/remote routing identity. */
export async function callOriginalDesktopHost<M extends AgentMuxRpcMethod>(client: DesktopRuntimeClient, method: M,
  params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext, expectedOwner?: AgentMuxRuntimeFence): Promise<AgentMuxRpcResult<M>> {
  const call = originalTransports.get(client)?.call ?? ('forwardRpc' in client ? client.forwardRpc : undefined)
  if (!call) throw new AgentMuxError('The original Host public transport is unavailable. Original input and Sessions are retained.', 'CONTROL_UNAVAILABLE')
  return await call(method, params, context, expectedOwner)
}

export async function subscribeOriginalDesktopHost<M extends AgentMuxRpcStreamMethod>(client: DesktopRuntimeClient, method: M,
  params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>, expectedOwner?: AgentMuxRuntimeFence): Promise<AgentMuxRpcSubscription> {
  const original = originalTransports.get(client)
  if (original) return await original.subscribe(method, params, handlers, expectedOwner)
  if ('subscribeRpc' in client && client.subscribeRpc) return await client.subscribeRpc(method, params,
    { ...handlers, ...(expectedOwner === undefined ? {} : { runtimeFence: expectedOwner }) })
  throw new AgentMuxError('The original Host subscription transport is unavailable. Its connections and Agents are retained.', 'CONTROL_UNAVAILABLE')
}

async function ensureHost(storePath: string, socketPath: string, configuration?: { path: string; connectorDirectory: string }): Promise<void> {
  const liveness = await probeSocketLiveness(socketPath)
  if (liveness !== 'dead') return
  let launching = launches.get(socketPath)
  if (!launching) {
    launching = ensureMacosHostService(macosHostService({ executable: process.execPath,
      entrypoint: join(import.meta.dirname, 'agentmux-host.js'), storePath, socketPath,
      mobileBuildDirectory: join(import.meta.dirname, '../mobile'),
      workspaceMoveHelper: resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move'),
      ...(configuration ? { configuration } : {}) }))
    launches.set(socketPath, launching)
    const retire = () => { if (launches.get(socketPath) === launching) launches.delete(socketPath) }
    void launching.then(retire, retire)
  }
  try { await launching }
  catch (error) {
    // A failed platform observation cannot revoke an endpoint that became healthy.
    // Preserve the operation's log and use the original public transport, never another launcher.
    if (await probeSocketLiveness(socketPath) === 'alive') {
      console.warn('Host service registration is unconfirmed; the original endpoint remains available.', error)
      return
    }
    throw error
  }
}

/** Product connector: the Desktop never constructs a local semantic Core owner. */
async function connectOriginalDesktopHost(config: HostConfig, store: AgentMuxAgentSessionStore, configuration?: { path: string; connectorDirectory: string }): Promise<DesktopRuntimeClient> {
  if (config.kind === 'ssh') return await connectSshAgentMux({ waitForReady: false,
    ...(config.runtimeId ? { expectedRuntimeId: config.runtimeId } : {}), target: { hostId: config.id,
    hostname: config.hostname, ...(config.user ? { user: config.user } : {}),
    ...(config.port ? { port: config.port } : {}), ...(config.identityFile ? { identityFile: config.identityFile } : {}),
    ...(config.remoteCommand ? { remoteCommand: config.remoteCommand } : {}),
    ...(config.remoteSocketPath ? { remoteSocketPath: config.remoteSocketPath } : {}) } })
  if (!(store instanceof AgentMuxFileAgentSessionStore)) throw new AgentMuxError('The Desktop Host requires the original durable File Store.', 'INVALID_CONTROL_REQUEST')
  const socketPath = defaultAgentMuxControlSocketPath()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  const prepare = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    await observeRead(ensureHost(store.path, socketPath, configuration), signal)
  }
  const port: AgentMuxHostedRpcPort = {
    call: async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, options?: { signal?: AbortSignal }) => {
      await prepare(options?.signal); return await rpc.call(method, params, options)
    },
    subscribe: async <M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>) => {
      await prepare(handlers.signal); return await rpc.subscribe(method, params, handlers)
    }
  }
  // Return the connection projection while handshake/retry proceeds. The durable UI can hydrate
  // when the Host is unavailable; each actual operation still requires a confirmed identity.
  const client = await connectHostedAgentMux({ rpc: port, waitForReady: false, expectedStorePath: store.path,
    subscribeRpc: async (method, params, handlers) => { await prepare(handlers.signal); return await rpc.subscribe(method, params, handlers) } })
  const originalOwner = async (signal?: AbortSignal) => {
    await prepare(signal)
    const owner = client.runtimeOwnerIdentity()
    if (!owner || owner.availability !== 'connected') await client.readAgentSessions()
    const confirmed = client.runtimeOwnerIdentity()
    if (!confirmed || confirmed.availability !== 'connected') throw new AgentMuxError('The original semantic Host identity is unconfirmed. Its Runs and frozen input remain available.', 'CONTROL_UNAVAILABLE')
    return { runtimeId: confirmed.runtimeId, ownerInstanceId: confirmed.ownerInstanceId }
  }
  originalTransports.set(client, {
    call: async (method, params, context, expectedOwner) => {
      if (context.principal?.kind === 'device' && !context.forwarding) throw new AgentMuxError(
        'The original device forwarding authority is unavailable. Its saved input and Sessions are retained.', 'CONTROL_UNAVAILABLE')
      const confirmed = await originalOwner(context.signal)
      return await rpc.call(method, params, { ...(context.signal ? { signal: context.signal } : {}),
        ...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {}),
        ...(context.caller ? { credentials: context.caller } : {}), runtimeFence: expectedOwner ?? confirmed })
    },
    subscribe: async (method, params, handlers, expectedOwner) => {
      const confirmed = await originalOwner(handlers.signal)
      return await client.subscribeRpc!(method, params, { ...handlers, runtimeFence: expectedOwner ?? confirmed })
    }
  })
  const dispose = client.dispose.bind(client)
  client.dispose = async () => { originalTransports.delete(client); await dispose(); await rpc.dispose() }
  return client
}

export const connectDesktopAgentMuxHost: DesktopRuntimeConnector = (config, store) => connectOriginalDesktopHost(config, store)
export function configuredDesktopAgentMuxHost(configurationPath: string, connectorDirectory: string): DesktopRuntimeConnector {
  return (config, store) => connectOriginalDesktopHost(config, store, { path: configurationPath, connectorDirectory })
}

export function desktopBusinessSocketPath(): string {
  return `${defaultAgentMuxControlSocketPath()}.desktop`
}
