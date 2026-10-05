import { dirname, join } from 'node:path'
import { AgentMuxFileAgentSessionStore, AgentMuxError,
  startHeadlessAgentMux, connectAgentMuxRpc, defaultAgentMuxControlSocketPath,
  type AgentMuxAgentSessionStore, type AgentMuxRpcCallContext, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamParams, type AgentMuxRpcSubscriptionOptions,
  type AgentProvider, type AgentMuxRpcMobileAccessState } from '@agentmux/core'
import { DeviceAuthority } from './device-authority.js'
import { networkInterfaces } from 'node:os'
import { startLocalRelay } from '@agentmux/relay/local'
import { startRelayTransport, type RelayTransportController, type RelayLogger } from '@agentmux/relay/server'
import { connectionOfferUrl, isLocalNetworkHost } from '@agentmux/relay/offer'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { loadOrCreateRelayKeyPair } from '@agentmux/core/relay-identity'
import { loadMobileAssets } from './mobile-assets.js'
import { createDeviceAdministration } from './device-administration.js'
export type AgentMuxHostOptions = {
  store: AgentMuxAgentSessionStore
  providers?: readonly AgentProvider[]
  socketPath?: string
  desktopSocketPath?: string
  mobileBuildDirectory?: string
  mobilePort?: number
}

/** The Node Host owns the original Core. Desktop and phones only own client connections. */
export async function startAgentMuxHost(options: AgentMuxHostOptions) {
  const path = options.socketPath ?? defaultAgentMuxControlSocketPath()
  const desktopPath = options.desktopSocketPath ?? `${path}.desktop`
  let runtime: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined
  let authority: DeviceAuthority | undefined
  let relay: RelayTransportController | undefined
  let local: Awaited<ReturnType<typeof startLocalRelay>> | undefined
  let mobileState: AgentMuxRpcMobileAccessState = { state: 'starting', message: '正在启动手机连接' }
  let offerUrl: (() => string) | undefined
  let resolveAuthority!: (value: DeviceAuthority) => void, rejectAuthority!: (error: unknown) => void
  const authorityReady = new Promise<DeviceAuthority>((resolve, reject) => { resolveAuthority = resolve; rejectAuthority = reject })
  void authorityReady.catch(() => {})
  const desktopClient = async (context: AgentMuxRpcCallContext) => await connectAgentMuxRpc({
    endpoint: { transport: 'unix', path: desktopPath },
    ...(context.caller ? { credentials: context.caller } : {})
  })
  const mobileAccessState = (): AgentMuxRpcMobileAccessState => {
    try { return { ...mobileState, ...(offerUrl ? { origin: new URL(offerUrl()).origin } : {}) } }
    catch { return { ...mobileState, state: 'unavailable', message: '当前没有可用的局域网地址；连接记录和 Agent 会话保留。' } }
  }
  const service = {
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
      const desktop = await desktopClient(context)
      try { return await desktop.call(method, params, context.signal ? { signal: context.signal } : {}) }
      finally { await desktop.dispose() }
    },
    forwardSubscription: async <M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>, context: AgentMuxRpcCallContext) => {
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
            const device = await owner.authorizeKey(metadata.peerPublicKeyB64)
            const observation = owner.observe(device, local?.connectionInfo(metadata.relayConnectionId))
            const frames = originalServer.openAuthenticatedFrames({ authorization: { principal: { kind: 'device', id: `${owner.hostId}:${device.deviceId}` }, signal: observation.signal },
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
    runtime = await startHeadlessAgentMux({ store: options.store, socketPath: path,
      ...(options.providers ? { providers: options.providers } : {}), service })
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

  } catch (error) { rejectAuthority(error); await runtime?.stop(); throw error }
  let disposed = false
  const retryMobile = setInterval(() => { if (!disposed && !local) void initializeMobile() }, 5000)
  retryMobile.unref()

  return { client: runtime.client, hosted: runtime.hosted, server: runtime.server, mobileAccessState, deviceAuthority: () => authorityReady, async dispose() {
    if (disposed) return; disposed = true; clearInterval(retryMobile)
    await relay?.stop(); await local?.stop(); await authority?.flush(); await runtime!.stop()
  } }
}

export function agentMuxHostStore(path: string): AgentMuxFileAgentSessionStore {
  return new AgentMuxFileAgentSessionStore(path)
}
