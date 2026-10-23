import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
const launches = new Map<string, Promise<ChildProcess>>()
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
    let child: ChildProcess | undefined
    const retire = () => { if (launches.get(socketPath) === launching) launches.delete(socketPath) }
    launching = (async () => {
      await mkdir(dirname(storePath), { recursive: true, mode: 0o700 })
      const log = await open(join(dirname(storePath), 'agentmux-host.log'), 'a', 0o600)
      try {
        child = spawn(process.execPath, [join(import.meta.dirname, 'agentmux-host.js'), '--store', storePath], {
          detached: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_MOBILE_BUILD_DIRECTORY: join(import.meta.dirname, '../mobile'),
            AGENTMUX_WORKSPACE_MOVE_HELPER: resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move'),
            ...(configuration === undefined ? {} : { AGENTMUX_HOST_CONFIGURATION_PATH: configuration.path,
              AGENTMUX_MOTE_CONFIGURATION_PATH: configuration.path, AGENTMUX_CONNECTOR_DIRECTORY: configuration.connectorDirectory }) }
        })
        child.once('exit', retire)
        await new Promise<void>((resolve, reject) => {
          child!.on('error', error => {
            // A failed kill/send can emit error while the original process is alive.
            // Only failure to spawn has no child identity to retain.
            if (child!.pid === undefined) { retire(); reject(error) }
          })
          child!.once('spawn', resolve)
        })
        child.unref()
        return child
      } finally { await log.close() }
    })().catch(error => { if (child?.pid === undefined) retire(); throw error })
    launches.set(socketPath, launching)
  }
  const child = await launching
  // Each reader owns this wait, while the launch record belongs to the child until exit.
  // A slow endpoint cannot turn a later observation into another owner launch.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await probeSocketLiveness(socketPath) === 'alive') return
    if (child.exitCode !== null || child.signalCode !== null) throw new AgentMuxError('The semantic Host exited during startup; its log remains beside the original Store.', 'CONTROL_UNAVAILABLE')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new AgentMuxError('The semantic Host startup has not been confirmed; original Runs and workbench remain retained.', 'CONTROL_TIMEOUT')
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
      const confirmed = await originalOwner(context.signal)
      return await rpc.call(method, params, { ...(context.signal ? { signal: context.signal } : {}),
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
