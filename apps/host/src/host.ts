import { createDesktopInputContextCaptureReader } from './input-context-capture-reader.js'
import { dirname, join } from 'node:path'
import { AgentMuxFileAgentSessionStore, AgentMuxError,
  startHeadlessAgentMux, connectAgentMuxRpc, defaultAgentMuxControlSocketPath, isMoteChatMethod,
  type AgentMuxAgentSessionStore, type AgentMuxRpcCallContext, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamParams, type AgentMuxRpcSubscriptionOptions,
  type AgentProvider, type AgentMuxRpcMobileAccessState } from '@agentmux/core'
import { isConnectionMethod } from '@agentmux/core/connections'
import { isMoteConnectionMethod } from '@agentmux/core/mote-connections'
import { DeviceAuthority } from './device-authority.js'
import { networkInterfaces } from 'node:os'
import { startLocalRelay } from '@agentmux/relay/local'
import { startRelayTransport, type RelayTransportController, type RelayLogger } from '@agentmux/relay/server'
import { connectionOfferUrl, isLocalNetworkHost } from '@agentmux/relay/offer'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { loadOrCreateRelayKeyPair } from '@agentmux/core/relay-identity'
import { loadMobileAssets } from './mobile-assets.js'
import { createDeviceAdministration } from './device-administration.js'
import { createCapsuleDesktopAdapters } from './capsules.js'
import { createHostConnectionOwner, type HostConnectionOptions } from './connections.js'
import { createHostAgentLearning } from './agent-learning.js'
import { FileUploadOwner } from './file-upload-owner.js'
import { createHostMoteAvatarRead } from './mote-avatar-read.js'
export type AgentMuxHostOptions = {
  store: AgentMuxAgentSessionStore
  providers?: readonly AgentProvider[]
  socketPath?: string
  desktopSocketPath?: string
  connections?: HostConnectionOptions
  /** Reference to the original client configuration, never a Host configuration copy. */
  configurationPath?: string
  mobileBuildDirectory?: string
  mobilePort?: number
  fileUploads?: import('@agentmux/core/files').AgentMuxRpcFileUploadsOwner
  inputContextCaptureReader?: import('@agentmux/core').AgentInputContextCaptureReader
  externalInputAuthority?: import('@agentmux/core').AgentExternalInputAuthorityPort
}

/** The Node Host owns the original Core. Desktop and phones only own client connections. */
export async function startAgentMuxHost(options: AgentMuxHostOptions) {
  const path = options.socketPath ?? defaultAgentMuxControlSocketPath()
  const desktopPath = options.desktopSocketPath ?? `${path}.desktop`
  const connectionOwner = options.connections ? createHostConnectionOwner(options.connections) : undefined
  let runtime: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined
  let authority: DeviceAuthority | undefined
  let relay: RelayTransportController | undefined
  let local: Awaited<ReturnType<typeof startLocalRelay>> | undefined
  const closeResources = async () => {
    const errors: unknown[] = []
    for (const close of [() => relay?.stop(), () => local?.stop(), () => authority?.flush(),
      () => connectionOwner?.close(), () => runtime?.stop()]) {
      try { await close() } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Host shutdown has unconfirmed resource releases. Original Agent Runs are retained.')
  }
  let mobileState: AgentMuxRpcMobileAccessState = { state: 'starting', message: '正在启动手机连接' }
  let offerUrl: (() => string) | undefined
  let resolveAuthority!: (value: DeviceAuthority) => void, rejectAuthority!: (error: unknown) => void
  const authorityReady = new Promise<DeviceAuthority>((resolve, reject) => { resolveAuthority = resolve; rejectAuthority = reject })
  void authorityReady.catch(() => {})
  const desktopClient = async (context: AgentMuxRpcCallContext) => {
    if (context.principal?.kind === 'device' && !context.forwarding) throw new AgentMuxError(
      'The original device forwarding authority is unavailable. Keep this operation and reconnect to its original Host.', 'CONTROL_UNAVAILABLE')
    return await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopPath },
      ...(context.caller ? { credentials: context.caller } : {}),
      ...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {}) })
  }
  const configurationPath = options.configurationPath ?? options.connections?.moteConfigurationPath
  const moteAvatars = configurationPath ? createHostMoteAvatarRead({ configurationPath }) : undefined
  const agentLearning = configurationPath && options.store instanceof AgentMuxFileAgentSessionStore ? createHostAgentLearning({
    configurationPath, directory: join(dirname(options.store.path), 'agent-learning'),
    ...(connectionOwner ? { spatial: connectionOwner.spatial } : {}),
    runtime: () => { if (!runtime) throw new AgentMuxError('The original Host is not yet available. Learning operations and existing Agents are retained.', 'CONTROL_UNAVAILABLE'); return runtime },
    desktop: desktopClient
  }) : undefined
  const mobileAccessState = (): AgentMuxRpcMobileAccessState => {
    try { return { ...mobileState, ...(offerUrl ? { origin: new URL(offerUrl()).origin } : {}) } }
    catch { return { ...mobileState, state: 'unavailable', message: '当前没有可用的局域网地址；连接记录和 Agent 会话保留。' } }
  }
  const service = {
    fileUploads: options.fileUploads ?? new FileUploadOwner(),
    ...(agentLearning ? { agentLearning } : {}),
    ...(connectionOwner ? { connections: connectionOwner.connections, spatialState: connectionOwner.spatial,
      ...(connectionOwner.moteChat ? { moteChat: connectionOwner.moteChat } : {}),
      ...(connectionOwner.moteConnections ? { moteConnections: connectionOwner.moteConnections, motePreferences: connectionOwner.motePreferences } : {}) } : {}),
    operationSource: (context: AgentMuxRpcCallContext) => context.caller ? undefined : authority?.operationSource(context.principal),
    recordDeviceOperation: async (source: import('@agentmux/core').AgentOperationDevice, method: string, args: unknown[], result: 'confirmed' | 'failed' | 'unknown', operationId: string) => {
      if (authority) {
        try { await authority.recordOperation(source, method, args, result, operationId) }
        catch { authority.noteActivityIssue(source.deviceId) }
      }
    },
    deviceAdministration: createDeviceAdministration(authorityReady, mobileAccessState, () => {
      if (!offerUrl || mobileState.state !== 'connected') throw new AgentMuxError(mobileState.message, 'CONTROL_UNAVAILABLE')
      return offerUrl()
    }),
    forwardControl: async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>> => {
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
  let initializingMobile = false
  const initializeMobile = async () => {
    if (initializingMobile || local) return
    initializingMobile = true
    try {
    if (authority && options.store instanceof AgentMuxFileAgentSessionStore) {
      try {
        const keyPair = await loadOrCreateRelayKeyPair(join(dirname(options.store.path), 'agentmux-relay-keypair.json'))
        const assets = await loadMobileAssets(options.mobileBuildDirectory!)
        local = await startLocalRelay({ serverId: authority.hostId, port: options.mobilePort ?? 8443, route: assets.route })
        const owner = authority, originalServer = runtime!.server
        offerUrl = () => {
          const addresses = Object.entries(networkInterfaces()).sort(([a], [b]) => Number(!/^(en|eth|wlan)/.test(a)) - Number(!/^(en|eth|wlan)/.test(b))).flatMap(([, list]) => list ?? []).filter(a => a.family === 'IPv4' && !a.internal && isLocalNetworkHost(a.address))
          const address = addresses.find(a => !a.address.startsWith('169.254.')) ?? addresses[0]
          if (!address) throw new AgentMuxError('当前没有可用的局域网地址；Agent 会话仍可使用。', 'CONTROL_UNAVAILABLE')
          const endpoint = `${address.address}:${local!.port}`
          return connectionOfferUrl(`http://${endpoint}/`, { v: 2, serverId: owner.hostId, daemonPublicKeyB64: exportPublicKey(keyPair.publicKey), relay: { endpoint, useTls: false } })
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
        mobileState = { state: 'unavailable', message: `手机连接暂不可用：${error instanceof Error ? error.message : String(error)}。原 Agent 会话可继续使用。` }
      }
    }
    } finally { initializingMobile = false }
  }
  try {
    // Reserve the public endpoint before constructing/loading any Core owner. A live old owner
    // is never displaced or adopted by speculative workflow probes.
    const externalInputAuthority = options.externalInputAuthority ?? connectionOwner?.authority
    runtime = await startHeadlessAgentMux({ store: options.store, socketPath: path,
      ...(options.providers ? { providers: options.providers } : {}), service,
      forwardingPeer: { authoritySocketPath: desktopPath, bindAuthority: async principal => principal.kind === 'device'
        ? await (await authorityReady).bindForwardedDevice(principal) : undefined },
      capsuleAdapters: createCapsuleDesktopAdapters({ connect: context => desktopClient(context ?? { transport: 'unix' }) }),
      inputContextCaptureReader: options.inputContextCaptureReader ?? createDesktopInputContextCaptureReader({ desktopSocketPath: desktopPath, captureHostId: 'local', executionHostId: 'local' }),
      ...(externalInputAuthority ? { externalInputAuthority } : {}) })
    await connectionOwner?.start(runtime)
    if (options.store instanceof AgentMuxFileAgentSessionStore) {
      try {
        authority = await DeviceAuthority.open(join(dirname(options.store.path), 'agentmux-devices.json'))
        resolveAuthority(authority)
      } catch (error) {
        mobileState = { state: 'unavailable', message: '原设备身份文件无法读取；文件与 Agent 会话保留，请恢复原身份。' }
        rejectAuthority(error)
      }
    } else {
      rejectAuthority(new AgentMuxError('Mobile access requires the original durable File Store.', 'CONTROL_UNAVAILABLE'))
      mobileState = { state: 'unavailable', message: '手机连接需要原持久化存储；现有 Agent 会话可继续使用。' }
    }
    await initializeMobile()

  } catch (error) {
    rejectAuthority(error)
    try { await closeResources() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Host startup failed and some resource releases are unconfirmed. Original Agent Runs are retained.') }
    throw error
  }
  let disposed = false
  const retryMobile = setInterval(() => { if (!disposed && !local) void initializeMobile() }, 5000)
  retryMobile.unref()

  return { client: runtime.client, hosted: runtime.hosted, server: runtime.server, mobileAccessState, deviceAuthority: () => authorityReady, async dispose() {
    if (disposed) return; disposed = true; clearInterval(retryMobile)
    await closeResources()
  } }
}

export function agentMuxHostStore(path: string): AgentMuxFileAgentSessionStore {
  return new AgentMuxFileAgentSessionStore(path)
}
