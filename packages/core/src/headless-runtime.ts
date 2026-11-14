import { NodePublishingOwner } from './node-publishing-owner.js'
import { AgentExecutionBindingService, type AgentExecutionHostPort } from './agent-execution-coordinator.js'
import { connectHostedAgentMux } from './hosted-client.js'
import { mintObjectId } from './object-id.js'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION } from './runtime-owner-protocol.js'
import { chmod, lstat, mkdir, open, readFile, readdir, type FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { AgentMuxClient } from './client.js';
import type { AgentMuxClientOptions } from "./client-contract.js";
import { AgentMuxFileAgentSessionStore, defaultAgentMuxAgentSessionStorePath } from './agent-session-store.js'
import { AgentMuxError } from './errors.js'
import { createAgentMuxDeviceAccess, createDeviceAdministration } from './device-access.js'
import { DeliveryAttemptStore } from './delivery-attempt-store.js'
import { immutableIdentityFile } from './immutable-identity-file.js'
import { readCurrentSessionDatabase } from './agent-session-database.js'
import { defaultAgentMuxControlSocketPath, defaultAgentMuxStateDirectory, defaultCtxmuxSocketPath,
  defaultCtxmuxStateDirectory, defaultAgentMuxHookPort } from './runtime-paths.js'
import { AgentMuxControlServer, type AgentMuxRpcHttpOptions, type AgentMuxControlServerOptions } from './public-rpc-server.js'
import type { AgentMuxRpcCoreClient, AgentMuxRpcServiceOptions } from './public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from './hosted-runtime-service.js'
import { AgentMuxHostExecutorOwner } from './executor-owner.js'
import { AgentMuxCreationAuthority } from './agent-creation-authority.js'
import { HostRouteGateway, type HostRouteGatewayOptions, type HostRouteExecutionAccess } from './host-route-gateway.js'
import { executionRouteRpc } from './host-route-rpc.js'
import type { AdoptedHostRoute } from './host-route.js'
import type { AgentMuxRuntimeOwnerIdentity, AgentMuxHostedClient, AgentMuxHostedRpcPort, AgentMuxHostedStreamEvent } from './hosted-client-contract.js'
import { CapsuleRunManager, type CapsuleDesktopAdapters } from './capsule-run-manager.js'
import { AgentMuxStorageRecovery, type RecoverySource } from './storage-recovery.js'
import { legacySessionRecoverySource, semanticRecoverySource, sessionRecoverySource } from './storage-recovery-sources.js'

export type AgentMuxHeadlessRuntimeOptions = AgentMuxClientOptions & {
  socketPath?: string
  stateDirectory?: string
  /** Borrow the same original Host configuration used by its saved Executor settings. */
  executorConfigurations?: (executorId?: string) => Promise<Readonly<Record<string, import('./types.js').AgentExecutorConfig>>>
  http?: AgentMuxRpcHttpOptions
  meshEndpoint?: import('./public-rpc-relay-gateway.js').AgentMuxMeshEndpointSource
  relayGateway?: import('./public-rpc-relay-gateway.js').AgentMuxRelayGatewaySource
  forwardingPeer?: AgentMuxControlServerOptions['forwardingPeer']
  /** Existing client-owned business ports mounted on this one public endpoint. */
  service?: Omit<AgentMuxRpcServiceOptions, 'coreClients' | 'hostedRuntime' | 'endpoint'>
  /** Borrow original remote Hosts. An exact selector may join their handle assembly; an omitted selector stays cached. */
  coreClients?: (hostId?: string, read?: { signal?: AbortSignal | undefined }) => readonly AgentMuxRpcCoreClient[] | Promise<readonly AgentMuxRpcCoreClient[]>
  /** The original Host composes only its exact configured public edge transports. */
  routeEdge?: HostRouteGatewayOptions['edge']
  routeEdges?: HostRouteGatewayOptions['edges']
  /** Borrow the original external input owner; the semantic Host never duplicates its grants or journal. */
  inputContextCaptureReader?: import('./agent-input-context-capture.js').AgentInputContextCaptureReader
  externalInputAuthority?: import('./external-author.js').AgentExternalInputAuthorityPort
  /** Live, call-scoped App capabilities; neither the App nor Core owns the HTTP service. */
  capsuleAdapters?: CapsuleDesktopAdapters
  /** The outer process owner may close its complete service after a fenced public shutdown. */
  shutdown?: () => void | Promise<void>
  /** Original local owners contribute their own snapshots; no RPC caller supplies filesystem sources. */
  recoverySources?: readonly RecoverySource[]
}
export type AgentMuxHeadlessRuntime = {
  readonly client: AgentMuxClient
  readonly hosted: AgentMuxHostedRuntimeService
  readonly server: AgentMuxControlServer
  readonly socketPath: string
  readonly hostRoutes: HostRouteGateway
  ownerIdentity(): AgentMuxRuntimeOwnerIdentity
  /** Borrow the same original configured execution route used by the coordinator. */
  executionHost(hostId: string, adoptedRoute?: AdoptedHostRoute, access?: HostRouteExecutionAccess): Promise<{ runtimeId: string; client: AgentMuxRpcCoreClient['client']; executionPort: AgentExecutionHostPort; adoptedRoute?: AdoptedHostRoute; dispose?(): Promise<void> }>
  readonly executionBindings: NonNullable<AgentMuxRpcServiceOptions['executionBindings']>
  readonly storageRecovery: AgentMuxStorageRecovery | undefined
  stop(): Promise<void>
}
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
async function acquireOwner(path: string): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'a+', 0o600)
  if (!native.tryLock(handle.fd)) { await handle.close(); throw new AgentMuxError('This semantic Runtime or endpoint has another live owner.', 'RUNTIME_OWNER_BUSY') }
  return handle
}

async function retainedSessionRecovery(stateDirectory: string, storePath: string): Promise<boolean> {
  const directory = join(stateDirectory, 'recovery', 'generations')
  let names: string[]
  try { names = await readdir(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  for (const name of names.filter(name => /^[A-Za-z0-9_-]{1,100}\.json$/u.test(name))) {
    const path = join(directory, name), attributes = await lstat(path)
    if (!attributes.isFile() || (attributes.mode & 0o077) !== 0) throw new AgentMuxError('The retained original recovery namespace is unconfirmed.', 'AGENT_SESSION_STORE_UNAVAILABLE')
    let manifest: { schema?: unknown; sources?: Array<{ id?: string; members?: Array<{ id?: string; target?: string }> }> }
    try { manifest = JSON.parse(await readFile(path, 'utf8')) } catch { throw new AgentMuxError('The retained original recovery namespace is unreadable.', 'AGENT_SESSION_STORE_UNAVAILABLE') }
    if (manifest.schema !== 'agentmux.recovery-generation.v1' || !Array.isArray(manifest.sources)) throw new AgentMuxError('The retained original recovery namespace is unconfirmed.', 'AGENT_SESSION_STORE_UNAVAILABLE')
    if (manifest.sources.some(source => source.id === 'core.sessions' && source.members?.some(member => member.id === 'database' && member.target === storePath))) return true
  }
  return false
}
async function priorSemanticNamespace(stateDirectory: string, storePath: string): Promise<boolean> {
  for (const path of [join(stateDirectory, 'agent-creation-identity.json'), join(stateDirectory, 'agent-creation-identity.json.original')]) {
    try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const database = await readCurrentSessionDatabase(storePath, { readOnly: true })
  if (database) try {
    // An empty catalog created by first-launch observation is not a previous
    // semantic Runtime. Existing user/lifecycle facts are a different case.
    for (const table of ['sessions', 'retired_sessions', 'reservations', 'prompt_admissions']) {
      if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) continue
      if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return true
    }
  } finally { database.close() }
  if (!database) {
    // A retained original import is positive evidence of a used namespace,
    // never permission to import it again or silently initialize an empty one.
    try { if ((await readdir(dirname(storePath))).some(name => name.startsWith(basename(storePath) + '.original-'))) return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return await retainedSessionRecovery(stateDirectory, storePath)
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
  let producerLeaseActive = true
  let endpointLease: FileHandle | undefined, client: AgentMuxClient | undefined, server: AgentMuxControlServer | undefined
  let hosted: AgentMuxHostedRuntimeService | undefined, stopping: Promise<void> | undefined
  let capsules: CapsuleRunManager | undefined
  let executionBindings: AgentExecutionBindingService | undefined
  let executionReader: Promise<AgentMuxHostedClient> | undefined
  let hostRoutes: HostRouteGateway | undefined
  let storageRecovery: AgentMuxStorageRecovery | undefined
  // A supplied endpoint/administration borrows its original owner (e.g. Host).
  // Only the durable standalone entry composes its own portable device owner.
  const deviceAccess = storePath !== null && !options.meshEndpoint && !options.service?.deviceAdministration ? createAgentMuxDeviceAccess(store) : undefined
  try {
    endpointLease = await acquireOwner(socketPath + '.owner.lock')
    const identityPath = join(stateDirectory, 'semantic-runtime.json')
    // Explicit non-file Stores keep the existing Unix Host capability. Their owner
    // is ephemeral: no durable identity file can claim continuity for that data.
    let runtimeId: string = mintObjectId()
    let originalCreationIdentity: { runtimeId: string; publicKey: string; privateKey: string } | null = null
    if (storePath !== null) {
      const state = await immutableIdentityFile(identityPath, {
        parse: bytes => {
          let value: { schema?: unknown; runtimeId?: unknown; authority?: unknown; creationIdentity?: unknown }
          try { value = JSON.parse(bytes) } catch { throw new AgentMuxError('The original semantic identity is unreadable. Its sources and Runs were retained.', 'RUNTIME_AUTHORITY_MISMATCH') }
          if (value.schema !== 'agentmux.semantic-runtime.v1' || typeof value.runtimeId !== 'string' || !value.runtimeId || value.authority !== authority) throw new AgentMuxError(
            'Durable semantic Runtime authority does not match this Store/Hook/ctxmux binding. Existing Runs were preserved.', 'RUNTIME_AUTHORITY_MISMATCH')
          let creationIdentity: typeof originalCreationIdentity = null
          if (value.creationIdentity !== undefined) {
            const seed = value.creationIdentity as Record<string, unknown>
            if (!seed || typeof seed !== 'object' || seed.runtimeId !== value.runtimeId || typeof seed.publicKey !== 'string' || typeof seed.privateKey !== 'string' ||
              !/^[A-Za-z0-9_-]{1,512}$/u.test(seed.publicKey) || !/^[A-Za-z0-9_-]{1,512}$/u.test(seed.privateKey)) throw new AgentMuxError(
              'The original namespace signing preparation is unreadable. Its sources and Runs were retained.', 'RUNTIME_AUTHORITY_MISMATCH')
            creationIdentity = { runtimeId: value.runtimeId, publicKey: seed.publicKey, privateKey: seed.privateKey }
          }
          return { schema: 'agentmux.semantic-runtime.v1' as const, runtimeId: value.runtimeId, authority, ...(creationIdentity ? { creationIdentity } : {}) }
        },
        create: () => {
          const id = mintObjectId(), pair = generateKeyPairSync('ed25519')
          // Freeze all original initialization material before publishing the
          // namespace. A crash before lazy signer materialization can therefore
          // continue that exact identity without generating a second key.
          return { schema: 'agentmux.semantic-runtime.v1' as const, runtimeId: id, authority, creationIdentity: {
            runtimeId: id, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
            privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') } }
        },
        encode: value => JSON.stringify(value) + '\n',
        priorIdentity: () => priorSemanticNamespace(stateDirectory, storePath),
        onRecoveryIssue: issue => process.emitWarning('The semantic identity is readable, but its original recovery copy is unavailable. Original Runs remain available; retry storage recovery.', { code: issue.code })
      })
      runtimeId = state.runtimeId
      originalCreationIdentity = state.creationIdentity ?? null
      try { await lstat(storePath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (await retainedSessionRecovery(stateDirectory, storePath)) throw new AgentMuxError('The original Session database is missing and its retained recovery source is available. Use the original storage recovery owner; no empty database was initialized.', 'AGENT_SESSION_STORE_UNAVAILABLE')
      }
    }
    const ownerInstanceId = mintObjectId()
    const ownerIdentity = (): AgentMuxRuntimeOwnerIdentity => {
      let ctxmux: AgentMuxRuntimeOwnerIdentity['ctxmux'] = null
      try { ctxmux = client!.runtimeIdentity() }
      catch (error) { if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_DISCONNECTED') throw error }
      return { runtimeId, ownerInstanceId, protocolVersion: AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION, processId: process.pid, ctxmux, availability: 'connected' }
    }
    const stop = (): Promise<void> => {
      deviceAccess?.close()
      producerLeaseActive = false // revoke borrowing synchronously, before any close/observer await
      return stopping ??= (async () => {
      try { await server?.stop() }
      finally { try { try { await storageRecovery?.dispose(); hostRoutes?.dispose(); await executionBindings?.dispose(); await (await executionReader)?.dispose(); await capsules?.dispose(); await hosted?.dispose() } finally { await client?.dispose() } }
        finally { try { await deviceAccess?.flush() } finally { await endpointLease?.close(); await semanticLease.close() } } }
      })()
    }
    // Both namespace leases are already held. One Client owns metadata and Native observation;
    // a caller's unconfirmed Native startup must not dispose this semantic authority.
    const creationAuthority = options.creationAuthority ?? new AgentMuxCreationAuthority({ stateDirectory, runtimeId,
      ...(storePath === null ? {} : { requireOriginalIdentity: true, recoveryIdentity: async () => originalCreationIdentity }) })
    client = new AgentMuxClient({ ...options, store, controlSocketPath: socketPath,
      retainedServiceExecutionDirectories: async () => [
        ...await options.retainedServiceExecutionDirectories?.() ?? [],
        ...await capsules?.retainedExecutionDirectories() ?? []
      ],
      spawnFiniteFileProducer: spawn => {
        // Never cache a scalar fd across awaits: close/reuse must be observed at
        // the actual spawn in this same turn. Only scoped finite Files uses it.
        if (!producerLeaseActive || semanticLease.fd < 0) throw new AgentMuxError('The original semantic owner is closing. This finite Files producer was not spawned.', 'RUNTIME_OWNER_CLOSING')
        return spawn(semanticLease.fd)
      },
      diagnosticOwner: { authority: { kind: 'core-runtime', id: runtimeId, lifetime: storePath === null ? 'instance' : 'durable' }, ownerInstanceId },
      ...(options.externalInputAuthority?.resolveConversationMessage ? { externalConversationAuthority: { resolveConversationMessage: ref => options.externalInputAuthority!.resolveConversationMessage!(ref) } } : {}),
      hostExecutorOwner: options.hostExecutorOwner ?? new AgentMuxHostExecutorOwner({
        path: join(stateDirectory, 'host-executors.json'), runtimeId, catalog: () => client!.catalog(),
        ...(options.executorConfigurations ? { configurations: options.executorConfigurations } : {})
      }),
      creationAuthority })
    hostRoutes = options.service?.hostRoutes ? undefined : new HostRouteGateway({ stateDirectory, authority: creationAuthority,
      ...(options.routeEdges ? { edges: options.routeEdges } : {}),
      edge: options.routeEdge ?? (() => { throw new AgentMuxError('The original Host has no configured route edge transport. Keep the exact route; other Core capabilities remain available.', 'HOST_ROUTE_EDGE_UNAVAILABLE') }),
      call: (method, params, context) => server!.callRpc(method, params, context),
      subscribe: (method, params, emit, context) => server!.subscribeRpc(method, params, emit, context),
    })
    hosted = new AgentMuxHostedRuntimeService(client, storePath, ownerIdentity, options.shutdown ?? stop, options.externalInputAuthority, options.inputContextCaptureReader)
    capsules = new CapsuleRunManager(client, stateDirectory, options.capsuleAdapters)
    const executionHost: AgentMuxHeadlessRuntime['executionHost'] = async (hostId, adoptedRoute, access) => {
        if (adoptedRoute) {
          if (!access) throw new AgentMuxError('This exact route needs its original admission authority. Existing Sessions and intent remain retained.', 'HOST_ROUTE_AUTHORITY_INVALID')
          const gateway = options.service?.hostRoutes ?? hostRoutes!
          const target = adoptedRoute.hops.at(-1)!.target.runtimeId
          const authorization = 'authorization' in access ? access.authorization : 'observation' in access ? await gateway.authorizeObservation(access.observation, access.context) : await gateway.authorizePreparation(target, access.context, access.call)
          const rpc = executionRouteRpc(gateway, adoptedRoute, authorization, 'authorization' in access ? access.helper : undefined, 'authorization' in access ? undefined : access.context)
          const routeClient = await connectHostedAgentMux({ connectOnDemand: true, expectedRuntimeId: target, rpc })
          try {
            const identity = 'observation' in access ? (await rpc.call('runtime.owner.identity', {})).owner : await routeClient.agentCreationAuthority()
            if (identity.runtimeId !== target) throw new AgentMuxError('The original adopted route answers for another Runtime.', 'HOST_ROUTE_TARGET_MISMATCH')
            return { runtimeId: identity.runtimeId, client: routeClient, executionPort: routeClient, adoptedRoute: structuredClone(adoptedRoute), dispose: () => routeClient.dispose() }
          } catch (error) { await routeClient.dispose().catch(() => {}); throw error }
        }
        if (access && 'observation' in access && access.observation.targetRuntimeId === runtimeId) {
          // Original source-qualified local identity wins over a mutable carrier
          // label. This read neither creates signing material nor connects Native.
          return { runtimeId, client: client!, executionPort: client! }
        }
        const scopes = hostId === 'local' ? [{ hostId: 'local', client: client! }]
          : (await options.coreClients?.(hostId) ?? []).filter(scope => scope.hostId === hostId)
        if (scopes.length !== 1) throw new AgentMuxError('Execution requires one exact configured Host route.', 'UNKNOWN_HOST')
        let original = scopes[0]!.client
        if (access && 'observation' in access) {
          if (access.context.caller || access.context.routeDelegation) throw new AgentMuxError('This foreign observation needs original receiver delegation for the current viewer. Its Session and saved request remain retained.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
          const cached = 'runtimeOwnerIdentity' in original ? original.runtimeOwnerIdentity?.() : null
          const observed = cached ?? ('forwardRpc' in original && original.forwardRpc ? (await original.forwardRpc('runtime.owner.identity', {}, access.context)).owner : null)
          if (!observed) throw new AgentMuxError('The original semantic owner identity is unconfirmed; no Native identity or creation key was substituted.', 'RUNTIME_OWNER_UNCONFIRMED')
          if (observed.runtimeId !== access.observation.targetRuntimeId) throw new AgentMuxError('This observation answers for another original semantic Runtime. Its Session and original request remain retained.', 'RUNTIME_OWNER_MISMATCH')
          return { runtimeId: observed.runtimeId, client: original, executionPort: original }
        }
        // Hosted control RPCs carry their own exact owner fence; unrelated event
        // subscription availability cannot become creation admission.
        if (!('runtimeOwnerIdentity' in original) || typeof original.runtimeOwnerIdentity !== 'function') await original.connect()
        const identity = await original.agentCreationAuthority()
        if (original !== client && access && ('context' in access ? access.context.routeDelegation : access.authorization.parent)) {
          const localIdentity = await creationAuthority.identity()
          if (identity.runtimeId !== localIdentity.runtimeId || identity.publicKey !== localIdentity.publicKey || identity.fingerprint !== localIdentity.fingerprint)
            throw new AgentMuxError('This foreign transport has no adopted receiver delegation for the original actor. Keep its target and request; no transport account was substituted.', 'HOST_ROUTE_AUTHORIZATION_REQUIRED')
          // An authenticated self carrier is still this original owner, regardless
          // of its configured alias. Keep the canonical local reader namespace.
          original = client!
        }
        if (original !== client) return { runtimeId: identity.runtimeId, client: original, executionPort: original }
        // The local SDK's attachment is shared by this Core. Borrow its existing
        // Hosted RunReaders owner, so closing this bridge cannot detach another
        // consumer of the same Run. This private transport carries only reads:
        // it supplies no principal/caller and cannot issue Runtime control.
        const reader = await (executionReader ??= connectHostedAgentMux({ connectOnDemand: true, expectedRuntimeId: runtimeId, rpc: {
          call: async (method: string, params: unknown, context?: { signal?: AbortSignal }) => {
            if (method !== 'runtime.owner.identity') throw new AgentMuxError('The execution reader transport accepts only owner observation.', 'INVALID_CONTROL_REQUEST')
            return await hosted!.call(method, params, context)
          },
          subscribe: async (method: string, params: unknown, handlers: { onInitial(value: unknown): void; onEvent(value: AgentMuxHostedStreamEvent): void; signal?: AbortSignal }) => {
            if (method !== 'runtime.attachment-watch' && method !== 'runtime.replay-watch') throw new AgentMuxError('The execution reader transport accepts only exact Run observations.', 'INVALID_CONTROL_REQUEST')
            const watch = await hosted!.subscribe(method, params, event => handlers.onEvent(event), handlers.signal ? { signal: handlers.signal } : {})
            try { handlers.onInitial(watch.initial); await watch.start?.(); return { dispose: watch.dispose } }
            catch (error) { await watch.dispose().catch(() => {}); throw error }
          }
        } as AgentMuxHostedRpcPort }))
        const scoped: AgentExecutionHostPort = {
          onRunEvent: reader.onRunEvent.bind(reader), attachTerminal: reader.attachTerminal.bind(reader), releaseRunAttachment: reader.releaseRunAttachment.bind(reader),
          runtimeIdentity: original.runtimeIdentity.bind(original), readRunReplay: original.readRunReplay.bind(original), writeTerminal: original.writeTerminal.bind(original),
          prepareAgentExecutionHelper: original.prepareAgentExecutionHelper.bind(original), inspectPreparedTerminal: original.inspectPreparedTerminal.bind(original),
          createPreparedTerminal: original.createPreparedTerminal.bind(original), createHostAgentWithDelivery: original.createHostAgentWithDelivery.bind(original),
          listHostExecutors: original.listHostExecutors.bind(original), readAgentSession: original.readAgentSession.bind(original)
        }
        return { runtimeId: identity.runtimeId, client: original, executionPort: scoped }
    }
    executionBindings = options.service?.executionBindings ? undefined : new AgentExecutionBindingService(join(stateDirectory, 'execution-bindings'), {
      authorize: (input, context, retained, existing) => (options.service?.hostRoutes ?? hostRoutes!).retainExecution(input, context, retained, existing),
      resolveHost: async (hostId, route, access) => { const host = await executionHost(hostId, route, access); return { runtimeId: host.runtimeId, client: host.executionPort,
        ...(host.adoptedRoute ? { adoptedRoute: host.adoptedRoute } : {}), ...(host.dispose ? { dispose: host.dispose } : {}) } }
    }, options.service?.spatialState ? { spatial: options.service.spatialState, runtimeId: () => runtimeId } : undefined)
    if (store instanceof AgentMuxFileAgentSessionStore) {
      const directory = join(stateDirectory, 'recovery')
      storageRecovery = new AgentMuxStorageRecovery(directory, runtimeId, [sessionRecoverySource(store),
        legacySessionRecoverySource(store.path), semanticRecoverySource(stateDirectory, directory, [identityPath, identityPath + '.original', ...creationAuthority.recoveryPaths(), join(stateDirectory, 'host-executors.json')]), ...client.storageRecoverySources(),
        ...(options.service?.spatialState ? [options.service.spatialState.storageRecoverySource()] : []),
        ...(options.recoverySources ?? [])], 5, { admit: input => store.admitRecoveryInputCut(input) })
    }
    server = new AgentMuxControlServer({ ...options.service, socketPath, meshState: { directory: stateDirectory, owner: { runtimeId, ownerInstanceId } }, ...(options.http ? { http: options.http } : {}),
      ...(storageRecovery ? { storageRecovery } : {}),
      ...(options.relayGateway === undefined ? {} : { relayGateway: options.relayGateway }),
      ...((options.meshEndpoint ?? deviceAccess?.endpoint) ? { meshEndpoint: options.meshEndpoint ?? deviceAccess!.endpoint } : {}),
      ...(deviceAccess ? {
        deviceAdministration: createDeviceAdministration(deviceAccess.authority, () => ({ state: 'unavailable', message: 'This Core has no mobile page. Use its original Mesh endpoint offer.' }),
          async () => { throw new AgentMuxError('This Core has no mobile page. Use mesh.inspect and mesh.link for its original encrypted endpoint.', 'CONTROL_UNAVAILABLE') }),
        operationSource: options.service?.operationSource ?? deviceAccess.operationSource,
        recordDeviceOperation: options.service?.recordDeviceOperation ?? deviceAccess.recordDeviceOperation
      } : {}),
      ...(options.forwardingPeer ? { forwardingPeer: options.forwardingPeer } : {}),
      capsules: options.service?.capsules ?? capsules,
      executionBindings: options.service?.executionBindings ?? executionBindings!,
      hostRoutes: options.service?.hostRoutes ?? hostRoutes!,
      capsuleRuntime: options.service?.capsuleRuntime ?? capsules.runtime,
      deliveryAttempts: options.service?.deliveryAttempts ?? { hostId: 'local', store: new DeliveryAttemptStore(join(stateDirectory, 'client-delivery-attempts'), { clientJournal: true }) },
      diagnosticCoreAuthority: options.service?.diagnosticCoreAuthority ?? (() => ({ authority: { kind: 'core-runtime', id: runtimeId, lifetime: storePath === null ? 'instance' : 'durable' }, status: 'verified', causeCode: null })),
      nodePublishing: new NodePublishingOwner({ stateDirectory, runtimeId, ownerInstanceId }),
      coreClients: async (hostId, read) => [{ hostId: 'local', client: client! }, ...(await (read === undefined
        ? options.coreClients?.(hostId) : options.coreClients?.(hostId, read)) ?? [])],
      hostedRuntime: () => hosted!,
      onControlEndpointState: state => hosted?.publishControlEndpointState(state) })
    await server.start()
    storageRecovery?.start()
    capsules.start()
    hosted.publishControlEndpointState(server.controlEndpointState())
    // The Client publishes scoped failures and continues its original observation. Metadata
    // and the public semantic owner are available before this independent Native work settles.
    void client.connect().then(() => executionBindings?.restoreReaders()).catch(() => {
      // The original binding remains inspectable as unavailable. A reader
      // failure does not close the public owner or another healthy capability.
    })
    return { client, hosted, server, socketPath, hostRoutes: options.service?.hostRoutes ?? hostRoutes!, ownerIdentity, executionHost,
      executionBindings: options.service?.executionBindings ?? executionBindings!, storageRecovery, stop }
  } catch (error) {
    deviceAccess?.close()
    producerLeaseActive = false
    await server?.stop().catch(() => {}); await storageRecovery?.dispose().catch(() => {}); hostRoutes?.dispose(); await executionBindings?.dispose().catch(() => {}); await capsules?.dispose().catch(() => {}); await hosted?.dispose().catch(() => {}); await client?.dispose().catch(() => {})
    await deviceAccess?.flush().catch(() => {})
    await endpointLease?.close().catch(() => {}); await semanticLease.close().catch(() => {})
    throw error
  }
}
