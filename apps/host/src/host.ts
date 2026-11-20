import { createHostMoteChat } from './mote-chat.js'
import { createHostMoteGroups } from './mote-group.js'
import { MoteGroupStore } from './mote-group-store.js'
import { createHostWorkspaceResources } from './workspace-resources.js'
import { createDesktopStorageRecoverySource } from './desktop-storage-recovery.js'
import { createHostFolderDirectoryOwner } from './folder-directory-owner.js'
import { createHostFolderSpaceResource } from './folder-space-resource.js'
import { createHostMoteMainReader, createHostMoteDialogue } from './mote-dialogue.js'
import { createHostMoteDirect } from './mote-direct.js'
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
import { moteOwnedWorkspaceRoots, readConfiguredExecutor, readConfiguredExecutors, readConfiguredExecutorChoices } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { createHostSnapshotObservation } from './snapshot-observation.js'
import { createHostSpatialPresentation } from './spatial-presentation.js'
import { createDesktopInputContextCaptureReader } from './input-context-capture-reader.js'
import { dirname, join } from 'node:path'
import { AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, AgentMuxError,
  startHeadlessAgentMux, connectAgentMuxRpc, spatialCatalog, rpcControlResult, defaultAgentMuxControlSocketPath, isMoteChatMethod,
  type AgentMuxAgentSessionStore, type AgentMuxClientOptions, type AgentMuxRpcCallContext, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamParams, type AgentMuxRpcSubscriptionOptions,
  type AgentProvider, type AgentMuxRpcMobileAccessState, type AgentMuxRpcMobileLinkCandidate } from '@agentmux/core'
import { isConnectionMethod } from '@agentmux/core/connections'
import { observeRead } from '@agentmux/core/observation-read'
import { isMoteConnectionMethod } from '@agentmux/core/mote-connections'
import { createAgentMuxDeviceAccess, createDeviceAdministration } from '@agentmux/core/device-access'
import { networkInterfaces } from 'node:os'
import { startLocalRelay } from '@agentmux/relay/local'
import { startRelayTransport, type RelayTransportController, type RelayLogger } from '@agentmux/relay/server'
import { connectionLinkUrl, CONNECTION_METADATA_PATH, type ConnectionOffer } from '@agentmux/relay/offer'
import { createInterfacePortLabels, defaultRouteInterface, mobileLinkCandidates } from './mobile-link-candidates.js'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { attachAgentMuxRpcRelaySocket } from '@agentmux/core/relay-publisher'
import { createOutboundRelayAccess } from './outbound-relay.js'
import { MobileAssetsOwner } from './mobile-assets-owner.js'
import { createCapsuleDesktopAdapters } from './capsules.js'
import { createHostConnectionOwner, type HostConnectionOptions } from './connections.js'
import { createHostAgentLearning } from './agent-learning.js'
import { FileUploadOwner } from './file-upload-owner.js'
import { createHostMoteAvatarRead } from './mote-avatar-read.js'
import { configuredTailcatListener } from './tailcat-listener.js'
import { prepareTailcatKey } from './tailcat-key.js'
import { configuredRouteEdge, configuredRouteEdges } from './host-route-edges.js'
export type AgentMuxHostOptions = {
  prepareExecutionEnvironment?: AgentMuxClientOptions['prepareExecutionEnvironment']
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
  /** Explicit private configuration, read once by this original Host after Core is serving. */
  outboundRelayConfigurationPath?: string
  relayGateway?: import('@agentmux/core/relay-gateway').AgentMuxRelayGatewaySource
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
  const deviceAccess = createAgentMuxDeviceAccess(options.store)
  let initializingMobile: Promise<void> | undefined, disposal: Promise<void> | undefined
  let closing = false
  const resourceShutdown = new AbortController()
  function observeOptional<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new AgentMuxError('The original Host optional observation stopped.', 'CONTROL_CANCELLED'))
      resourceShutdown.signal.addEventListener('abort', abort, { once: true })
      work.then(resolve, reject).finally(() => resourceShutdown.signal.removeEventListener('abort', abort))
      if (resourceShutdown.signal.aborted) abort()
    })
  }
  let relay: RelayTransportController | undefined
  let outbound: ReturnType<typeof createOutboundRelayAccess> | undefined
  let local: Awaited<ReturnType<typeof startLocalRelay>> | undefined
  let goals: ReturnType<typeof createHostGoals> | undefined
  let motePresence: ReturnType<typeof createHostMotePresence> | undefined
  let mobileIncidents: ReturnType<typeof createHostMobileIncidents> | undefined
  let tailcat: ReturnType<typeof configuredTailcatListener> | undefined
  const closeResources = async () => {
    closing = true; resourceShutdown.abort(); deviceAccess.close()
    mobileState = { state: 'unavailable', message: '原 Host 可选连接已停止；Agent 会话保留。' }
    const errors: unknown[] = []
    for (const close of [() => outbound?.close(), () => tailcat?.close(), () => relay?.stop(), () => local?.stop(), () => deviceAccess.flush(),
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
  let offerUrl: ((address?: string) => Promise<{ url: string; offer: ConnectionOffer; candidates: AgentMuxRpcMobileLinkCandidate[] }>) | undefined
  const getAuthority = deviceAccess.authority
  const getDaemonKey = deviceAccess.keyPair
  outbound = createOutboundRelayAccess({ ...(options.outboundRelayConfigurationPath ? { configurationPath: options.outboundRelayConfigurationPath } : {}),
    authority: getAuthority, keyPair: async () => {
      if (!(options.store instanceof AgentMuxFileAgentSessionStore)) throw new AgentMuxError('Outbound access requires the original durable Host identity.', 'CONTROL_UNAVAILABLE')
      return await getDaemonKey()
    } })
  const desktopClient = async (context: AgentMuxRpcCallContext) => {
    if (context.principal?.kind === 'device' && !context.forwarding) throw new AgentMuxError(
      'The original device forwarding authority is unavailable. Keep this operation and reconnect to its original Host.', 'CONTROL_UNAVAILABLE')
    return await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopPath },
      ...(context.caller ? { credentials: context.caller } : {}),
      ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}),
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
  const workspaceResources = configurationPath ? createHostWorkspaceResources(configurationPath,spatialState,()=>originalRuntime().ownerIdentity().runtimeId) : undefined
  const content = configurationPath ? createHostContent({ configurationPath, spatial: spatialState,
    ...(workspaceResources ? { resources: workspaceResources } : {}),
    directoryScope: isRelated => {
      if (!runtime) throw new AgentMuxError('The original Core directory admission is not yet available. Original files and Agents are retained.', 'CONTROL_UNAVAILABLE')
      return runtime.client.retainExecutionDirectoryMutation(isRelated)
    }
  }) : undefined
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
    qualifyHeartbeatSource: (source, main, context) => {
      if (!motePresence) throw new AgentMuxError('The original heartbeat source owner is unavailable. Retain its source and report.', 'CONTROL_UNAVAILABLE')
      return motePresence.qualifyHeartbeatSource(source, main, context)
    },
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
    ...(motePresence ? { maintenance: motePresence.read, changed: motePresence.invalidate, adoptGuidance: motePresence.adoptGuidance } : {}) }) : undefined
  const conversationAgents = configurationPath && options.store instanceof AgentMuxFileAgentSessionStore
    ? createHostMoteChat({ configurationPath, spatial: spatialState, runtime: originalRuntime }).agents : undefined
  const moteGroups = conversationAgents && options.store instanceof AgentMuxFileAgentSessionStore ? createHostMoteGroups({
    store: new MoteGroupStore(join(dirname(options.store.path), 'mote-groups.sqlite')),
    agents: conversationAgents,
    ...(moteMain ? { main: moteMain } : {}),
    ...(content ? { files: content.moteGroupFiles } : {}),
    client: hostId => {
      if (hostId !== 'local') throw new AgentMuxError('The original built-in Group member Host is unavailable.', 'MOTE_GROUP_MEMBER_UNCONFIRMED')
      return originalRuntime().client
    }
  }) : undefined
  const moteDirect = conversationAgents && moteMain && options.store instanceof AgentMuxFileAgentSessionStore
    ? createHostMoteDirect(createHostMoteGroups({
      store: new MoteGroupStore(join(dirname(options.store.path), 'mote-direct.sqlite'), 'direct'),
      agents: conversationAgents,
      main: moteMain,
      client: hostId => {
        if (hostId !== 'local') throw new AgentMuxError('The original private thread Host is unavailable.', 'CONTROL_UNAVAILABLE')
        return originalRuntime().client
      }
    })) : undefined
  const service = {
    spatialState,
    ...(moteGroups ? { moteGroups } : {}),
    ...(moteDirect ? { moteDirect } : {}),
    ...(workspaceResources ? { spatialFolderDirectory: createHostFolderDirectoryOwner(workspaceResources,spatialState) } : {}),
    ...(configurationPath ? { spatialFolderResource: createHostFolderSpaceResource(configurationPath,workspaceResources) } : {}),
    hostTailcat: (hostId: string) => hostId === 'local' ? tailcat!.inspect() : undefined,
    hostTailcatKey: (input: Parameters<typeof prepareTailcatKey>[0], signal?: AbortSignal) => prepareTailcatKey(input, { ...(signal ? { signal } : {}),
      ...(options.prepareExecutionEnvironment ? { prepareEnvironment: options.prepareExecutionEnvironment } : {}) }),
    ...(options.hostConfiguration ? { hostConfiguration: options.hostConfiguration } : {}),
    ...(moteDialogue ? { moteDialogue } : {}),
    ...(moteQuickPreferences ? { moteQuickPreferences } : {}),
    ...(configurationPath ? { spatialAgentControl: createHostSpatialAgentControl({ configurationPath, spatial: spatialState, runtime: originalRuntime, agentMuxContext: async request => await goals?.contextForSpatialOpen(request) }) } : {}),
    ...(mobileIncidents ? { clientIncidents: mobileIncidents.clientIncidents, mobileWebReports: mobileIncidents.mobileWebReports } : {}),
    ...(configurationPath ? { settingsResources: createHostSettingsResourceRead(configurationPath), appearance: createHostAppearanceObservation(configurationPath) } : {}),
    ...content,
    ...(goals ? { goalControl: goals.execute, goalInputEpoch: goals.inputEpoch, goalParticipation: goals.participation, nameHistory: goals.nameHistory, goalChanges: goals.goalChanges, progress: goals.progress, schedules: goals.schedules, goalDelegations: goals.goalDelegations, automaticInput: goals.automaticInput } : {}),
    snapshot: createHostSnapshotObservation(configurationPath, () => [...(runtime ? [{ hostId: 'local', client: runtime.client }] : []), ...(options.connections?.clients?.() ?? [])],workspaceResources),
    spatialPresentation: createHostSpatialPresentation({ ...(configurationPath ? { configurationPath } : {}), clients: () => [...(runtime ? [{ hostId: 'local', client: runtime.client }] : []), ...(options.connections?.clients?.() ?? [])] }),
    mobileAssets,
    fileUploads,
    ...(agentLearning ? { agentLearning } : {}),
    ...(connectionOwner ? { connections: connectionOwner.connections,
      ...(connectionOwner.moteChat ? { moteChat: connectionOwner.moteChat } : {}),
      ...(connectionOwner.moteConnections ? { moteConnections: connectionOwner.moteConnections, motePreferences: connectionOwner.motePreferences } : {}) } : {}),
    operationSource: deviceAccess.operationSource,
    recordDeviceOperation: deviceAccess.recordDeviceOperation,
    deviceAdministration: createDeviceAdministration(getAuthority, mobileAccessState, (address, via) => {
      if (via === 'gateway') return outbound!.link()
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
    if (closing || disposal || local) return Promise.resolve()
    initializingMobile = (async () => {
    if (options.store instanceof AgentMuxFileAgentSessionStore) {
      try {
        const owner = await getAuthority()
        if (closing) return
        const keyPair = await getDaemonKey()
        if (closing) return
        await observeOptional(mobileAssets.initialize(options.mobileBuildDirectory!))
        if (closing) return
        const linkFor = (address: string) => {
          const endpoint = new URL(`http://${address}:${local!.port}/`).host
          const offer: ConnectionOffer = { v: 2, serverId: owner.hostId, daemonPublicKeyB64: exportPublicKey(keyPair.publicKey), relay: { endpoint, useTls: false } }
          return { offer, url: connectionLinkUrl(`http://${endpoint}/`, offer) }
        }
        const localOpening = startLocalRelay({ serverId: owner.hostId, port: options.mobilePort ?? 8443, route: (request, response) => {
          let path: URL
          try { path = new URL(request.url ?? '/', 'http://localhost') } catch { mobileAssets.route(request, response); return }
          if (path.pathname !== CONNECTION_METADATA_PATH) { mobileAssets.route(request, response); return }
          response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer')
          if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }); response.end(); return }
          try {
            const target = new URL('http://' + request.headers.host)
            const current = Object.values(networkInterfaces()).flat().some(value => value?.family === 'IPv4' && value.address === target.hostname)
            if (!local || path.search || Number(target.port || 80) !== local!.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash || !current) throw new Error('Original listener address is unavailable')
            const { offer } = linkFor(target.hostname)
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(offer))
          } catch { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Original mobile connection description is unavailable.') }
        } })
        const localListener = await observeOptional(localOpening.then(async value => {
          if (closing) { await value.stop(); throw new AgentMuxError('The original Host closed before its local listener was acquired.', 'CONTROL_CANCELLED') }
          // Register ownership before resolving the optional observation, so
          // shutdown cannot pass this listener between acquisition and adoption.
          local = value; return value
        }))
        local = localListener
        if (closing) return
        const originalServer = runtime!.server
        offerUrl = async address => {
          const interfaces = networkInterfaces()
          const [route, labels] = await Promise.all([defaultRouteInterface(), interfacePortLabels(mobileLinkCandidates(interfaces, null).map(candidate => candidate.interface))])
          const candidates = mobileLinkCandidates(interfaces, route, labels)
          if (!candidates.length) throw new AgentMuxError('当前没有可用的局域网地址；Agent 会话仍可使用。', 'CONTROL_UNAVAILABLE')
          const chosen = address === undefined ? candidates[0]! : candidates.find(candidate => candidate.address === address)
          if (!chosen) throw new AgentMuxError('这个地址不是这台 Mac 当前的局域网地址；请从候选地址中选择。', 'INVALID_CONTROL_REQUEST')
          return { ...linkFor(chosen.address), candidates }
        }
        const logger: RelayLogger = { child: () => logger, info: () => {}, debug: () => {}, warn: () => {} }
        relay = startRelayTransport({ logger, serverId: owner.hostId, daemonKeyPair: keyPair,
          relayEndpoint: `127.0.0.1:${localListener.port}`, relayUseTls: false, createWebSocket: localListener.hostWebSocket,
          onState: state => { if (closing) return; mobileState = { state, message: state === 'connected' ? '手机连接已就绪' : state === 'starting' ? '正在连接，自动重试中' : '连接中断，自动重连中；原会话保留。' } },
          attachSocket: (socket, metadata) => attachAgentMuxRpcRelaySocket({ socket, ...(metadata ? { metadata } : {}), server: originalServer,
            authorize: async (publicKey, source) => {
              const device = await owner.authorizeKey(publicKey)
              const observation = owner.observe(device, local?.connectionInfo(source.relayConnectionId))
              return { principal: { kind: 'device', id: `${owner.hostId}:${device.deviceId}` }, signal: observation.signal,
                assertCurrent: () => owner.assertCurrentKey(device, publicKey), dispose: () => observation.dispose() }
            } }) })
      } catch (error) {
        if (closing) return
        await relay?.stop(); await local?.stop(); relay = undefined; local = undefined; offerUrl = undefined
        mobileState = { state: 'unavailable', message: deviceAccess.current()
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
      recoverySources: [createDesktopStorageRecoverySource(() => desktopClient({ transport: 'unix' }))],
      ...(options.relayGateway === undefined ? {} : { relayGateway: options.relayGateway }),
      meshEndpoint: deviceAccess.endpoint,
      ...(configurationPath ? { sessionExecutorConfiguration: (executorId: string) => readConfiguredExecutor(configurationPath, executorId) } : {}),
      ...(configurationPath ? { executorConfigurations: (id?: string) => readConfiguredExecutors(configurationPath, id) } : {}),
      ...(configurationPath ? { ownedWorkspaceRoots: workspacePath => moteOwnedWorkspaceRoots(configurationPath, workspacePath) } : {}),
      ...(configurationPath && content?.files ? { moteInputResolver: createHostMoteInputSource({configurationPath,spatial:spatialState,files:content.files}) } : {}),
      ...(options.connections?.clients ? { coreClients: async (hostId?: string, read?: { signal?: AbortSignal | undefined }) => {
        if (hostId !== undefined && hostId !== 'local') {
          await observeRead(Promise.resolve().then(() => options.connections!.clientsReady?.()), read?.signal)
          read?.signal?.throwIfAborted()
        }
        return options.connections!.clients!(hostId)
      } } : {}),
      routeEdge: async edgeId => {
        await options.connections?.clientsReady?.()
        return configuredRouteEdge(hostId => options.connections?.clients?.(hostId) ?? [], edgeId)
      },
      routeEdges: () => configuredRouteEdges(configurationPath),
      ...(options.providers ? { providers: options.providers } : {}), service,
      forwardingPeer: { authoritySocketPath: desktopPath, bindAuthority: async principal => principal.kind === 'device'
        ? await (await getAuthority()).bindForwardedDevice(principal) : undefined },
      capsuleAdapters: createCapsuleDesktopAdapters({ connect: context => desktopClient(context ?? { transport: 'unix' }) }),
      inputContextCaptureReader: options.inputContextCaptureReader ?? createDesktopInputContextCaptureReader({ desktopSocketPath: desktopPath, captureHostId: 'local', executionHostId: 'local' }),
      ...(externalInputAuthority ? { externalInputAuthority } : {}) })
    // The Core endpoint is already serving before this optional listener can accept a peer.
    void outbound.start(runtime.server)
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
  const retryMobile = setInterval(() => { if (!closing && !disposal && !local) void initializeMobile() }, 5000)
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
