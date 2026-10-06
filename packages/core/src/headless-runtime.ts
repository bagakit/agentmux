import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { AgentMuxClient, type AgentMuxClientOptions } from './client.js'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxAgentSessionStorePath } from './agent-session-store.js'
import { AgentMuxError } from './errors.js'
import { DeliveryAttemptStore } from './delivery-attempt-store.js'
import { durableWriteFile } from './durable-write.js'
import { defaultAgentMuxControlSocketPath, defaultAgentMuxStateDirectory, defaultCtxmuxSocketPath,
  defaultCtxmuxStateDirectory, defaultAgentMuxHookPort } from './runtime-paths.js'
import { AgentMuxControlServer, type AgentMuxRpcHttpOptions } from './public-rpc-server.js'
import type { AgentMuxRpcServiceOptions } from './public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from './hosted-runtime-service.js'
import { AgentMuxHostExecutorOwner } from './executor-owner.js'
import { AgentMuxCreationAuthority } from './agent-creation-authority.js'
import type { AgentMuxRuntimeOwnerIdentity } from './hosted-client-contract.js'

export type AgentMuxHeadlessRuntimeOptions = AgentMuxClientOptions & {
  socketPath?: string
  stateDirectory?: string
  http?: AgentMuxRpcHttpOptions
  /** Existing client-owned business ports mounted on this one public endpoint. */
  service?: Omit<AgentMuxRpcServiceOptions, 'coreClients' | 'hostedRuntime' | 'endpoint'>
}
export type AgentMuxHeadlessRuntime = {
  readonly client: AgentMuxClient
  readonly hosted: AgentMuxHostedRuntimeService
  readonly server: AgentMuxControlServer
  readonly socketPath: string
  ownerIdentity(): AgentMuxRuntimeOwnerIdentity
  stop(): Promise<void>
}
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
async function acquireOwner(path: string): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'a+', 0o600)
  if (!native.tryLock(handle.fd)) { await handle.close(); throw new AgentMuxError('This semantic Runtime or endpoint has another live owner.', 'RUNTIME_OWNER_BUSY') }
  return handle
}
/** The one explicitly launched semantic owner, usable independently of any UI or client Host. */
export async function startHeadlessAgentMux(options: AgentMuxHeadlessRuntimeOptions = {}): Promise<AgentMuxHeadlessRuntime> {
  const store = options.store ?? new AgentMuxFileAgentSessionStore(defaultAgentMuxAgentSessionStorePath())
  const storePath = store instanceof AgentMuxFileAgentSessionStore ? store.path : null
  const stateDirectory = options.stateDirectory ?? (options.store && storePath !== null ? dirname(storePath) : defaultAgentMuxStateDirectory())
  const socketPath = options.socketPath ?? defaultAgentMuxControlSocketPath()
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 }); await chmod(stateDirectory, 0o700)
  const authority = createHash('sha256').update(JSON.stringify({ stateDirectory, storePath,
    ctxmuxSocket: defaultCtxmuxSocketPath(), ctxmuxState: defaultCtxmuxStateDirectory(), hookPort: defaultAgentMuxHookPort() })).digest('hex')
  const semanticLease = await acquireOwner(join(stateDirectory, 'semantic-owner.lock'))
  let endpointLease: FileHandle | undefined, client: AgentMuxClient | undefined, server: AgentMuxControlServer | undefined
  let hosted: AgentMuxHostedRuntimeService | undefined, stopping: Promise<void> | undefined
  try {
    endpointLease = await acquireOwner(socketPath + '.owner.lock')
    const identityPath = join(stateDirectory, 'semantic-runtime.json')
    // Explicit non-file Stores keep the existing Unix Host capability. Their owner
    // is ephemeral: no durable identity file can claim continuity for that data.
    let runtimeId: string = randomUUID()
    if (storePath !== null) try {
      const state = JSON.parse(await readFile(identityPath, 'utf8')) as { schema?: unknown; runtimeId?: unknown; authority?: unknown }
      if (state.schema !== 'agentmux.semantic-runtime.v1' || typeof state.runtimeId !== 'string' || !state.runtimeId || state.authority !== authority) throw new AgentMuxError(
        'Durable semantic Runtime authority does not match this Store/Hook/ctxmux binding. Existing Runs were preserved.', 'RUNTIME_AUTHORITY_MISMATCH')
      runtimeId = state.runtimeId
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      runtimeId = randomUUID()
      await durableWriteFile(identityPath, JSON.stringify({ schema: 'agentmux.semantic-runtime.v1', runtimeId, authority }) + '\n')
    }
    const ownerInstanceId = randomUUID()
    const ownerIdentity = (): AgentMuxRuntimeOwnerIdentity => {
      let ctxmux: AgentMuxRuntimeOwnerIdentity['ctxmux'] = null
      try { ctxmux = client!.runtimeIdentity() }
      catch (error) { if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_DISCONNECTED') throw error }
      return { runtimeId, ownerInstanceId, protocolVersion: 2, processId: process.pid, ctxmux, availability: 'connected' }
    }
    const stop = (): Promise<void> => stopping ??= (async () => {
      try { await server?.stop() }
      finally { try { try { await hosted?.dispose() } finally { await client?.dispose() } }
        finally { await endpointLease?.close(); await semanticLease.close() } }
    })()
    // Both namespace leases are already held. One Client owns metadata and Native observation;
    // a caller's unconfirmed Native startup must not dispose this semantic authority.
    client = new AgentMuxClient({ ...options, store, controlSocketPath: socketPath,
      hostExecutorOwner: options.hostExecutorOwner ?? new AgentMuxHostExecutorOwner({
        path: join(stateDirectory, 'host-executors.json'), runtimeId, catalog: () => client!.catalog()
      }),
      creationAuthority: options.creationAuthority ?? new AgentMuxCreationAuthority({ stateDirectory, runtimeId }) })
    hosted = new AgentMuxHostedRuntimeService(client, storePath, ownerIdentity, stop)
    server = new AgentMuxControlServer({ ...options.service, socketPath, ...(options.http ? { http: options.http } : {}),
      deliveryAttempts: options.service?.deliveryAttempts ?? { hostId: 'local', store: new DeliveryAttemptStore(join(stateDirectory, 'client-delivery-attempts'), { clientJournal: true }) },
      diagnosticCoreAuthority: options.service?.diagnosticCoreAuthority ?? (() => ({ authority: { kind: 'core-runtime', id: runtimeId, lifetime: storePath === null ? 'instance' : 'durable' }, status: 'verified', causeCode: null })),
      coreClients: () => [{ hostId: 'local', client: client! }],
      hostedRuntime: () => hosted!,
      onControlEndpointState: state => hosted?.publishControlEndpointState(state) })
    await server.start()
    hosted.publishControlEndpointState(server.controlEndpointState())
    // The Client publishes scoped failures and continues its original observation. Metadata
    // and the public semantic owner are available before this independent Native work settles.
    void client.connect().catch(() => {})
    return { client, hosted, server, socketPath, ownerIdentity, stop }
  } catch (error) {
    await server?.stop().catch(() => {}); await hosted?.dispose().catch(() => {}); await client?.dispose().catch(() => {})
    await endpointLease?.close().catch(() => {}); await semanticLease.close().catch(() => {})
    throw error
  }
}
