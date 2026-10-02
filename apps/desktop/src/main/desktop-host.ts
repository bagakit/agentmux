import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentMuxFileAgentSessionStore, AgentMuxError, connectAgentMuxRpc,
  connectSshAgentMux, defaultAgentMuxControlSocketPath, probeSocketLiveness,
  type AgentMuxAgentSessionStore,
  type AgentMuxRpcMethod, type AgentMuxRpcParams, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamParams, type AgentMuxRpcSubscriptionOptions,
  type AgentMuxClient } from '@agentmux/core'
import { connectHostedAgentMux, type AgentMuxHostedRpcPort, type AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { HostConfig } from '../shared/contracts.js'

export type DesktopRuntimeClient = AgentMuxClient | AgentMuxHostedClient
export type DesktopRuntimeConnector = (config: HostConfig, store: AgentMuxAgentSessionStore) => Promise<DesktopRuntimeClient>
const launches = new Map<string, Promise<void>>()

async function ensureHost(storePath: string, socketPath: string): Promise<void> {
  const liveness = await probeSocketLiveness(socketPath)
  if (liveness !== 'dead') return
  let launching = launches.get(socketPath)
  if (!launching) {
    launching = (async () => {
      await mkdir(dirname(storePath), { recursive: true, mode: 0o700 })
      const log = await open(join(dirname(storePath), 'agentmux-host.log'), 'a', 0o600)
      try {
        const child = spawn(process.execPath, [join(import.meta.dirname, 'agentmux-host.js'), '--store', storePath], {
          detached: true, stdio: ['ignore', log.fd, log.fd],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENTMUX_AGENT_SESSION_STORE: storePath }
        })
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject); child.once('spawn', resolve)
        })
        child.unref()
        // A request owns its ordinary RPC deadline. Unknown readiness is never a dead-owner fact.
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          if (await probeSocketLiveness(socketPath) === 'alive') return
          if (child.exitCode !== null || child.signalCode !== null) throw new AgentMuxError('The semantic Host exited during startup; its log remains beside the original Store.', 'CONTROL_UNAVAILABLE')
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw new AgentMuxError('The semantic Host startup has not been confirmed; original Runs and workbench remain retained.', 'CONTROL_TIMEOUT')
      } finally { await log.close() }
    })().finally(() => { launches.delete(socketPath) })
    launches.set(socketPath, launching)
  }
  await launching
}

/** Product connector: the Desktop never constructs a local semantic Core owner. */
export const connectDesktopAgentMuxHost: DesktopRuntimeConnector = async (config, store) => {
  if (config.kind === 'ssh') return await connectSshAgentMux({ waitForReady: false,
    ...(config.runtimeId ? { expectedRuntimeId: config.runtimeId } : {}), target: { hostId: config.id,
    hostname: config.hostname, ...(config.user ? { user: config.user } : {}),
    ...(config.port ? { port: config.port } : {}), ...(config.identityFile ? { identityFile: config.identityFile } : {}),
    ...(config.remoteCommand ? { remoteCommand: config.remoteCommand } : {}),
    ...(config.remoteSocketPath ? { remoteSocketPath: config.remoteSocketPath } : {}) } })
  if (!(store instanceof AgentMuxFileAgentSessionStore)) throw new AgentMuxError('The Desktop Host requires the original durable File Store.', 'INVALID_CONTROL_REQUEST')
  const socketPath = defaultAgentMuxControlSocketPath()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  const prepare = async () => await ensureHost(store.path, socketPath)
  const port: AgentMuxHostedRpcPort = {
    call: async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, options?: { signal?: AbortSignal }) => {
      await prepare(); return await rpc.call(method, params, options)
    },
    subscribe: async <M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>) => {
      await prepare(); return await rpc.subscribe(method, params, handlers)
    }
  }
  // Return the connection projection while handshake/retry proceeds. The durable UI can hydrate
  // when the Host is unavailable; each actual operation still requires a confirmed identity.
  const client = await connectHostedAgentMux({ rpc: port, waitForReady: false, expectedStorePath: store.path })
  const dispose = client.dispose.bind(client)
  client.dispose = async () => { await dispose(); await rpc.dispose() }
  return client
}

export function desktopBusinessSocketPath(): string {
  return `${defaultAgentMuxControlSocketPath()}.desktop`
}
