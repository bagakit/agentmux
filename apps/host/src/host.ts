import { createHostFolderSpaceResource } from './folder-space-resource.js'
import { createHostMoteMainReader, createHostMoteDialogue } from './mote-dialogue.js'
import { MoteDialogueStore } from '@agentmux/core/mote-dialogue-store'
import { HostMoteQuickPreferences } from './mote-quick-preferences.js'
import { createHostMotePresence } from './mote-presence.js'
import { createHostContent } from './content-owner.js'
import { createHostMoteInputSource } from './mote-input-source.js'
import { createHostSettingsResourceRead } from './settings-resource-read.js'
import { readHostSettingsHosts } from './settings-hosts-read.js'
import { createHostAppearanceObservation } from './host-appearance.js'
import { createHostMobileIncidents } from './mobile-incidents.js'
import { createHostSpatialAgentControl } from './spatial-agent-control.js'
import { createHostGoals } from './goals.js'
import { projectWorkspaces } from './workspace-projects.js'
import { readPresentationConfiguration } from './presentation-configuration.js'
import { moteOwnedWorkspaceRoots, readConfiguredExecutor, readConfiguredExecutorChoices } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { createHostSnapshotObservation } from './snapshot-observation.js'
import { createHostSpatialPresentation } from './spatial-presentation.js'
import { createDesktopInputContextCaptureReader } from './input-context-capture-reader.js'
import { dirname, join } from 'node:path'
import { AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, AgentMuxError,
  startHeadlessAgentMux, connectAgentMuxRpc, spatialCatalog, rpcControlResult, defaultAgentMuxControlSocketPath, isMoteChatMethod,
  type AgentMuxAgentSessionStore, type AgentMuxRpcCallContext, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamParams, type AgentMuxRpcSubscriptionOptions,
  type AgentProvider, type AgentMuxRpcMobileAccessState, type AgentMuxRpcMobileLinkCandidate } from '@agentmux/core'
import { isConnectionMethod } from '@agentmux/core/connections'
import { isMoteConnectionMethod } from '@agentmux/core/mote-connections'
import { DeviceAuthority } from './device-authority.js'
import { networkInterfaces } from 'node:os'
import { startLocalRelay } from '@agentmux/relay/local'
import { startRelayTransport, type RelayTransportController, type RelayLogger } from '@agentmux/relay/server'
import { connectionOfferUrl } from '@agentmux/relay/offer'
import { createInterfacePortLabels, defaultRouteInterface, mobileLinkCandidates } from './mobile-link-candidates.js'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { loadOrCreateRelayKeyPair } from '@agentmux/core/relay-identity'
import { MobileAssetsOwner } from './mobile-assets-owner.js'
import { createDeviceAdministration } from './device-administration.js'
import { createCapsuleDesktopAdapters } from './capsules.js'
import { createHostConnectionOwner, type HostConnectionOptions } from './connections.js'
import { createHostAgentLearning } from './agent-learning.js'
import { FileUploadOwner } from './file-upload-owner.js'
import { createHostMoteAvatarRead } from './mote-avatar-read.js'
import { configuredTailcatListener } from './tailcat-listener.js'
import { prepareTailcatKey } from './tailcat-key.js'
import { configuredRouteEdge } from './host-route-edges.js'
export type AgentMuxHostOptions = {
  prepareExecutionEnvironment?: () => Promise<void>
  store: AgentMuxAgentSessionStore
  providers?: readonly AgentProvider[]
  socketPath?: string
  desktopSocketPath?: string
  connections?: HostConnectionOptions
  /** Reference to the original client configuration, never a Host configuration copy. */
  configurationPath?: string
  /** The saved Host record behind each served route, read by Host observations. */
  hostConfiguration?: (hostId: string) => import('./host-configuration.js').HostConfig | null
  mobileBuildDirectory?: string
  mobilePort?: number
  fileUploads?: import('@agentmux/core/files').AgentMuxRpcFileUploadsOwner
  inputContextCaptureReader?: import('@agentmux/core').AgentInputContextCaptureReader
  externalInputAuthority?: import('@agentmux/core').AgentExternalInputAuthorityPort
  shutdown?: () => void | Promise<void>
}

/** The Node Host owns the original Core. Desktop and phones only own client connections. */
export async function startAgentMuxHost(options: AgentMuxHostOptions) {
  const path = options.socketPath ?? defaultAgentMuxControlSocketPath()
  const desktopPath = options.desktopSocketPath ?? `${path}.desktop`
  let moteMain: import('@agentmux/core/mote-dialogue').MoteMainReader | undefined
  const connectionOwner = options.connections ? createHostConnectionOwner({ ...options.connections, moteMain: () => moteMain }) : undefined
  const fileUploads = options.fileUploads ?? new FileUploadOwner()
  let runtime: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined
  let authority: DeviceAuthority | undefined
  let authorityOpening: Promise<DeviceAuthority> | undefined, authorityAttempted = false
  let initializingMobile: Promise<void> | undefined, disposal: Promise<void> | undefined
  let relay: RelayTransportController | undefined
  let local: Awaited<ReturnType<typeof startLocalRelay>> | undefined
  let goals: ReturnType<typeof createHostGoals> | undefined
  let motePresence: ReturnType<typeof createHostMotePresence> | undefined
  let mobileIncidents: ReturnType<typeof createHostMobileIncidents> | undefined
  let tailcat: ReturnType<typeof configuredTailcatListener> | undefined
  const closeResources = async () => {
    const errors: unknown[] = []
    for (const close of [() => initializingMobile, () => authorityOpening?.catch(() => {}), () => tailcat?.close(), () => relay?.stop(), () => local?.stop(), () => authority?.flush(),
      () => mobileIncidents?.flush(), () => motePresence?.dispose(), () => goals?.dispose(), () => connectionOwner?.close(), () => runtime?.stop()]) {
      try { await close() } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Host shutdown has unconfirmed resource releases. Original Agent Runs are retained.')
  }
  const mobileAssets = new MobileAssetsOwner('local')
  let mobileState: AgentMuxRpcMobileAccessState = { state: 'starting', message: '正在启动手机连接' }
  // The link for one chosen local address; candidates are read when a link is requested.
  const interfacePortLabels = createInterfacePortLabels()
  let offerUrl: ((address?: string) => Promise<{ url: string; candidates: AgentMuxRpcMobileLinkCandidate[] }>) | undefined
  const getAuthority = (): Promise<DeviceAuthority> => {
    if (disposal) return Promise.reject(new AgentMuxError('This Host device owner is closed. Original Agents are retained.', 'CONTROL_CANCELLED'))
    if (authority) return Promise.resolve(authority)
    if (!(options.store instanceof AgentMuxFileAgentSessionStore)) return Promise.reject(new AgentMuxError(
      'Mobile access requires the original durable File Store.', 'CONTROL_UNAVAILABLE'))
    if (!authorityOpening) {
      // Only the initial attempt may create a new identity. A failed read/write
      // cannot turn a later missing original file into first-time enrollment.
      const createIfMissing = !authorityAttempted
      authorityAttempted = true
      authorityOpening = DeviceAuthority.open(join(dirname(options.store.path), 'agentmux-devices.json'), Date.now, { createIfMissing })
        .then(value => { authority = value; return value })
        .finally(() => { authorityOpening = undefined })
    }
    return authorityOpening
  }
  const desktopClient = async (context: AgentMuxRpcCallContext) => {
    if (context.principal?.kind === 'device' && !context.forwarding) throw new AgentMuxError(
      'The original device forwarding authority is unavailable. Keep this operation and reconnect to its original Host.', 'CONTROL_UNAVAILABLE')
    return await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopPath },
      ...(context.caller ? { credentials: context.caller } : {}),
      ...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {}) })
  }
  const configurationPath = options.configurationPath ?? options.connections?.moteConfigurationPath
  tailcat = configuredTailcatListener(configurationPath, { socketPath: path,
    ...(options.prepareExecutionEnvironment ? { prepareEnvironment: options.prepareExecutionEnvironment } : {}) })
  if (options.store instanceof AgentMuxFileAgentSessionStore) mobileIncidents = createHostMobileIncidents({
    directory: join(dirname(options.store.path), 'mobile-web-incidents'), desktop: desktopClient,
    ...(configurationPath ? { originalMainDirectory: join(dirname(configurationPath), 'client-incidents') } : {}) })
  const avatarConfigurationPath = options.connections?.moteConfigurationPath ?? configurationPath
  const moteAvatars = avatarConfigurationPath ? createHostMoteAvatarRead({ configurationPath: avatarConfigurationPath }) : undefined
  const agentLearning = configurationPath && options.store instanceof AgentMuxFileAgentSessionStore ? createHostAgentLearning({
    configurationPath, directory: join(dirname(options.store.path), 'agent-learning'),
    ...(connectionOwner ? { spatial: connectionOwner.spatial } : {}),
    runtime: () => { if (!runtime) throw new AgentMuxError('The original Host is not yet available. Learning operations and existing Agents are retained.', 'CONTROL_UNAVAILABLE'); return runtime },
    desktop: desktopClient
  }) : undefined
  // Whether a phone can be given an address at all is read synchronously from the OS adapters, so a Mac
  // with no local-network address reports unavailable here instead of only when a link is requested.
  const mobileAccessState = (url?: string): AgentMuxRpcMobileAccessState => {
    if (local && !mobileLinkCandidates(networkInterfaces(), null).length) {
      return { ...mobileState, state: 'unavailable', message: '这台 Mac 当前没有局域网地址，手机暂时连不上；Agent 会话不受影响。' }
    }
    try { return { ...mobileState, ...(url ? { origin: new URL(url).origin } : {}) } }
    catch { return { ...mobileState, state: 'unavailable', message: '当前没有可用的局域网地址；连接记录和 Agent 会话保留。' } }
  }
  const spatialState = connectionOwner?.spatial ?? new AgentMuxSpatialStateStore()
  const content = configurationPath ? createHostContent({ configurationPath, spatial: spatialState }) : undefined
  const originalRuntime = () => {
    if (!runtime) throw new AgentMuxError('The original Host is not yet available. Original operations and healthy Agents are retained.', 'CONTROL_UNAVAILABLE')
    return runtime
  }
  if (configurationPath) goals = createHostGoals({ configurationPath, spatial: spatialState, runtime: originalRuntime,
    ...(options.connections?.clients ? { clients: options.connections.clients } : {}),
    ...(options.connections?.subscribeClients ? { subscribeClients: options.connections.subscribeClients } : {}),
    ...(content?.files ? { files: input => content.files!.read(input) } : {}),
    projects: async () => projectWorkspaces((await readPresentationConfiguration(configurationPath)).workspaces.filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID))
      .map(project => ({ projectId: project.id, name: project.name })),
    coreCall: async (hostId, method, params, context) => {
      if (hostId === 'local') return await originalRuntime().server.callRpc(method, params, context)
      const matches = options.connections?.clients?.().filter(value => value.hostId === hostId) ?? []
      const client = matches.length === 1 ? matches[0]!.client : undefined
      if (!client || !('forwardRpc' in client) || !client.forwardRpc) throw new AgentMuxError('The exact original Goal message Host is unavailable or ambiguous. Original messages and Agents are retained.', 'CONTROL_UNAVAILABLE')
      return await client.forwardRpc(method, params, context)
    } })
  moteMain = configurationPath && content?.files ? createHostMoteMainReader({ configurationPath, spatial: spatialState, files: content.files }) : undefined
  const moteDialogue = moteMain && options.store instanceof AgentMuxFileAgentSessionStore ? createHostMoteDialogue({
    main: moteMain, spatial: spatialState, store: new MoteDialogueStore(join(dirname(options.store.path), 'mote-dialogue.sqlite')),
    clientForHost: hostId => {
      if (hostId === 'local') return originalRuntime().client
      const matches = options.connections?.clients?.().filter(value => value.hostId === hostId) ?? []
      if (matches.length !== 1) throw new AgentMuxError('The exact original message Host is unavailable or ambiguous. Its source is retained.', 'CONTROL_UNAVAILABLE')
      return matches[0]!.client
    }
  }) : undefined
  if (configurationPath && content?.files && moteMain && goals) motePresence = createHostMotePresence({ configurationPath, spatial: spatialState, files: content.files, main: moteMain, schedules: goals.schedules, ...(options.connections?.subscribeClients ? { subscribeClients: options.connections.subscribeClients } : {}),
    clients: () => [...(runtime ? [{ hostId: 'local', client: runtime.client }] : []), ...(options.connections?.clients?.() ?? [])] })
  const moteQuickPreferences = content?.files && moteMain ? new HostMoteQuickPreferences({ files: content.files, main: moteMain,
    ...(moteDialogue ? { recordMainSource: moteDialogue.recordMainSource, prepareMainSource:moteDialogue.prepareMainSource } : {}),
    catalog: async () => { const state = await spatialState.read(); return state ? spatialCatalog(state.graph) : null },
    executors: () => readConfiguredExecutorChoices(configurationPath!),
    ...(motePresence ? { maintenance: motePresence.read, changed: motePresence.invalidate } : {}) }) : undefined
  const service = {
    spatialState,
    ...(configurationPath ? { spatialFolderResource: createHostFolderSpaceResource(configurationPath) } : {}),
    hostTailcat: (hostId: string) => hostId === 'local' ? tailcat!.inspect() : undefined,
    hostTailcatKey: (input: Parameters<typeof prepareTailcatKey>[0], signal?: AbortSignal) => prepareTailcatKey(input, { ...(signal ? { signal } : {}),
      ...(options.prepareExecutionEnvironment ? { prepareEnvironment: options.prepareExecutionEnvironment } : {}) }),
    ...(options.hostConfiguration ? { hostConfiguration: options.hostConfiguration } : {}),
    ...(moteDialogue ? { moteDialogue } : {}),
    ...(moteQuickPreferences ? { moteQuickPreferences } : {}),
    ...(configurationPath ? { spatialFolderResource: createHostFolderSpaceResource(configurationPath) } : {}),
    ...(configurationPath ? { spatialAgentControl: createHostSpatialAgentControl({ configurationPath, spatial: spatialState, runtime: originalRuntime, agentMuxContext: async request => await goals?.contextForSpatialOpen(request) }) } : {}),
    ...(mobileIncidents ? { clientIncidents: mobileIncidents.clientIncidents, mobileWebReports: mobileIncidents.mobileWebReports } : {}),
    ...(configurationPath ? { settingsResources: createHostSettingsResourceRead(configurationPath), appearance: createHostAppearanceObservation(configurationPath) } : {}),
    ...content,
    ...(goals ? { goalControl: goals.execute, goalParticipation: goals.participation, nameHistory: goals.nameHistory, goalChanges: goals.goalChanges, progress: goals.progress, schedules: goals.schedules, goalDelegations: goals.goalDelegations, automaticInput: goals.automaticInput } : {}),
    snapshot: createHostSnapshotObservation(configurationPath, () => [...(runtime ? [{ hostId: 'local', client: runtime.client }] : []), ...(options.connections?.clients?.() ?? [])]),
    spatialPresentation: createHostSpatialPresentation({ ...(configurationPath ? { configurationPath } : {}), clients: () => [...(runtime ? [{ hostId: 'local', client: runtime.client }] : []), ...(options.connections?.clients?.() ?? [])] }),
    mobileAssets,
    fileUploads,
    ...(agentLearning ? { agentLearning } : {}),
    ...(connectionOwner ? { connections: connectionOwner.connections,
      ...(connectionOwner.moteChat ? { moteChat: connectionOwner.moteChat } : {}),
      ...(connectionOwner.moteConnections ? { moteConnections: connectionOwner.moteConnections, motePreferences: connectionOwner.motePreferences } : {}) } : {}),
    operationSource: (context: AgentMuxRpcCallContext) => context.caller || context.routeDelegation ? undefined : authority?.operationSource(context.principal),
    recordDeviceOperation: async (source: import('@agentmux/core').AgentOperationDevice, method: string, args: unknown[], result: 'confirmed' | 'failed' | 'unknown', operationId: string) => {
      if (authority) {
        try { await authority.recordOperation(source, method, args, result, operationId) }
        catch { authority.noteActivityIssue(source.deviceId) }
      }
    },
    deviceAdministration: createDeviceAdministration(getAuthority, mobileAccessState, address => {
      if (!offerUrl) throw new AgentMuxError(mobileState.message, 'CONTROL_UNAVAILABLE')
      return offerUrl(address)
    }),
    forwardControl: async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>> => {
      if (method === 'settings.hosts.ls') return rpcControlResult(method, { operation: 'settings.hosts.list',
        hosts: (await readHostSettingsHosts(configurationPath)).map(host => ({ ...host })) }) as AgentMuxRpcResult<M>
      if (method.startsWith('goal.') && method !== 'goal.focus' || method.startsWith('schedule.') || method.startsWith('agent.progress.') || method.startsWith('agent.automation.')) throw new AgentMuxError('The original background automation owner is unavailable. Retain the exact Goal, Session and operation; healthy manual input remains available.', 'CONTROL_UNAVAILABLE')
      if (method === 'space.mote.avatar.read') {
        if (!moteAvatars) throw new AgentMuxError('The original Mote configuration is unavailable on this Host. Saved appearances and healthy Agents are retained.', 'MOTE_AVATAR_SOURCE_UNCONFIRMED')
        const input = params as AgentMuxRpcParams<'space.mote.avatar.read'>
        return await moteAvatars.read(input.target, input.operationId) as AgentMuxRpcResult<M>
      }
      if (isConnectionMethod(method) || isMoteConnectionMethod(method) || isMoteChatMethod(method) ||
          ((method === 'space.mote.preferences.read' || method === 'space.mote.preferences.save') &&
            (params as AgentMuxRpcParams<'space.mote.preferences.read'>).kind === 'connection')) {
        throw new AgentMuxError('The original connection owner is not registered on this Host. Configure its original Host owner; existing Agents and client editing capabilities remain available.', 'CONTROL_UNAVAILABLE')
      }
      const desktop = await desktopClient(context)
      try { return await desktop.call(method, params, context.signal ? { signal: context.signal } : {}) }
      finally { await desktop.dispose() }
    },
    forwardSubscription: async <M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>, context: AgentMuxRpcCallContext) => {
      if (method === 'goal.watch') throw new AgentMuxError('The original Goal change owner is unavailable. Keep its last confirmed records and reconnect this reader.', 'CONTROL_UNAVAILABLE')
      if (method === 'connection.metadata.watch') throw new AgentMuxError('The original Channel metadata owner is not registered on this Host. Saved profiles and healthy Agents remain available.', 'CONTROL_UNAVAILABLE')
      const desktop = await desktopClient(context)
      try {
        const subscription = await desktop.subscribe(method, params, { ...handlers,
          ...(context.signal ? { signal: context.signal } : {}) })
        let closed = false
        return { ...subscription, dispose: async () => {
          if (closed) return; closed = true
          try { await subscription.dispose() }
          finally { await desktop.dispose() }
        } }
      } catch (error) { await desktop.dispose(); throw error }
    }
  }
  const initializeMobile = (): Promise<void> => {
    if (initializingMobile) return initializingMobile
    if (disposal || local) return Promise.resolve()
    initializingMobile = (async () => {
    if (options.store instanceof AgentMuxFileAgentSessionStore) {
      try {
        const owner = await getAuthority()
        const keyPair = await loadOrCreateRelayKeyPair(join(dirname(options.store.path), 'agentmux-relay-keypair.json'))
        await mobileAssets.initialize(options.mobileBuildDirectory!)
        local = await startLocalRelay({ serverId: owner.hostId, port: options.mobilePort ?? 8443, route: mobileAssets.route })
        const originalServer = runtime!.server
        offerUrl = async address => {
          const interfaces = networkInterfaces()
          const [route, labels] = await Promise.all([defaultRouteInterface(), interfacePortLabels(mobileLinkCandidates(interfaces, null).map(candidate => candidate.interface))])
          const candidates = mobileLinkCandidates(interfaces, route, labels)
          if (!candidates.length) throw new AgentMuxError('当前没有可用的局域网地址；Agent 会话仍可使用。', 'CONTROL_UNAVAILABLE')
          const chosen = address === undefined ? candidates[0]! : candidates.find(candidate => candidate.address === address)
          if (!chosen) throw new AgentMuxError('这个地址不是这台 Mac 当前的局域网地址；请从候选地址中选择。', 'INVALID_CONTROL_REQUEST')
          const endpoint = `${chosen.address}:${local!.port}`
          return { url: connectionOfferUrl(`http://${endpoint}/`, { v: 2, serverId: owner.hostId, daemonPublicKeyB64: exportPublicKey(keyPair.publicKey), relay: { endpoint, useTls: false } }), candidates }
        }
        const logger: RelayLogger = { child: () => logger, info: () => {}, debug: () => {}, warn: () => {} }
        relay = startRelayTransport({ logger, serverId: owner.hostId, daemonKeyPair: keyPair,
          relayEndpoint: `127.0.0.1:${local.port}`, relayUseTls: false, createWebSocket: local.hostWebSocket,
          onState: state => { mobileState = { state, message: state === 'connected' ? '手机连接已就绪' : state === 'starting' ? '正在连接，自动重试中' : '连接中断，自动重连中；原会话保留。' } },
          attachSocket: async (socket, metadata) => {
            if (!metadata?.peerPublicKeyB64) throw new AgentMuxError('Encrypted peer identity is unavailable.', 'CONTROL_PERMISSION_DENIED')
            const publicKey = metadata.peerPublicKeyB64
            const device = await owner.authorizeKey(publicKey)
            const author = { deviceId: device.deviceId, createdAt: device.createdAt }
            const observation = owner.observe(device, local?.connectionInfo(metadata.relayConnectionId))
            const frames = originalServer.openAuthenticatedFrames({ authorization: { principal: { kind: 'device', id: `${owner.hostId}:${device.deviceId}` }, signal: observation.signal,
              assertCurrent: () => owner.assertCurrentKey(author, publicKey) },
              send: async frame => { await socket.send(JSON.stringify(frame)) }, close: () => socket.close() })
            let queue = Promise.resolve(), queuedBytes = 0, queuedCount = 0
            socket.on('message', data => {
              const text = typeof data === 'string' ? data : data instanceof ArrayBuffer ? new TextDecoder('utf-8', { fatal: true }).decode(data) : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
              const bytes = Buffer.byteLength(text)
              if (queuedBytes + bytes > 8 * 1024 * 1024 || queuedCount >= 128) { socket.close(4008, 'Device request budget exceeded'); return }
              queuedBytes += bytes; queuedCount++
              queue = queue.then(async () => { await frames.receive(JSON.parse(text)) })
                .catch(() => { socket.close(4002, 'Invalid RPC frame') })
                .finally(() => { queuedBytes -= bytes; queuedCount-- })
            })
            socket.once('close', () => { frames.dispose(); observation.dispose() })
            socket.on('error', () => socket.close())
          } })
      } catch (error) {
        await relay?.stop(); await local?.stop(); relay = undefined; local = undefined; offerUrl = undefined
        mobileState = { state: 'unavailable', message: authority
          ? `手机连接暂不可用：${error instanceof Error ? error.message : String(error)}。原 Agent 会话可继续使用。`
          : '原设备身份文件无法读取；文件与 Agent 会话保留，请恢复原身份。' }
      }
    } else mobileState = { state: 'unavailable', message: '手机连接需要原持久化存储；现有 Agent 会话可继续使用。' }
    })().finally(() => { initializingMobile = undefined })
    return initializingMobile
  }
  try {
    // Reserve the public endpoint before constructing/loading any Core owner. A live old owner
    // is never displaced or adopted by speculative workflow probes.
    const externalInputAuthority = options.externalInputAuthority ?? connectionOwner?.authority
    runtime = await startHeadlessAgentMux({ inputResources: { inspect: identity => fileUploads.inspect(identity), read: (identity, maxBytes) => fileUploads.read?.(identity, maxBytes) ?? Promise.resolve(null) }, ...(options.prepareExecutionEnvironment ? { prepareExecutionEnvironment: options.prepareExecutionEnvironment } : {}), store: options.store, socketPath: path, shutdown: options.shutdown ?? closeResources,
      ...(configurationPath ? { sessionExecutorConfiguration: (executorId: string) => readConfiguredExecutor(configurationPath, executorId) } : {}),
      ...(configurationPath ? { ownedWorkspaceRoots: () => moteOwnedWorkspaceRoots(configurationPath) } : {}),
      ...(configurationPath && content?.files ? { moteInputResolver: createHostMoteInputSource({configurationPath,spatial:spatialState,files:content.files}) } : {}),
      ...(options.connections?.clients ? { coreClients: options.connections.clients } : {}),
      routeEdge: edgeId => configuredRouteEdge(hostId => options.connections?.clients?.(hostId) ?? [], edgeId),
      ...(options.providers ? { providers: options.providers } : {}), service,
      forwardingPeer: { authoritySocketPath: desktopPath, bindAuthority: async principal => principal.kind === 'device'
        ? await (await getAuthority()).bindForwardedDevice(principal) : undefined },
      capsuleAdapters: createCapsuleDesktopAdapters({ connect: context => desktopClient(context ?? { transport: 'unix' }) }),
      inputContextCaptureReader: options.inputContextCaptureReader ?? createDesktopInputContextCaptureReader({ desktopSocketPath: desktopPath, captureHostId: 'local', executionHostId: 'local' }),
      ...(externalInputAuthority ? { externalInputAuthority } : {}) })
    // The Core endpoint is already serving before this optional listener can accept a peer.
    void tailcat.start()
    await connectionOwner?.start(runtime)
    await motePresence?.start()
    if (goals) void goals.start().catch(error => process.emitWarning(`Starting original Goal automation is unconfirmed: ${error instanceof Error ? error.message : String(error)}. Goal records and manual Agent input remain available.`, { code: 'GOAL_AUTOMATION_UNCONFIRMED' }))
    await initializeMobile()

  } catch (error) {
    try { await closeResources() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Host startup failed and some resource releases are unconfirmed. Original Agent Runs are retained.') }
    throw error
  }
  const retryMobile = setInterval(() => { if (!disposal && !local) void initializeMobile() }, 5000)
  retryMobile.unref()

  return { client: runtime.client, hosted: runtime.hosted, server: runtime.server, mobileAccessState,
    /** The local Relay port once the phone page is served; tests reach the page on loopback with it. */
    mobilePort: () => local?.port ?? null, deviceAuthority: getAuthority, dispose(): Promise<void> {
    return disposal ??= (async () => { clearInterval(retryMobile); await closeResources() })()
  } }
}

export function agentMuxHostStore(path: string): AgentMuxFileAgentSessionStore {
  return new AgentMuxFileAgentSessionStore(path)
}
