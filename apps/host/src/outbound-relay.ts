import { isAbsolute } from 'node:path'
import { readFile } from 'node:fs/promises'
import { AgentMuxError, type AgentMuxHeadlessRuntime, type AgentMuxRpcMobileAccessState } from '@agentmux/core'
import { startAgentMuxRpcRelayPublisher } from '@agentmux/core/relay-publisher'
import { connectionOfferUrl, parseConnectionOffer, type ConnectionOffer } from '@agentmux/relay/offer'
import { exportPublicKey, importPublicKey, type KeyPair } from '@agentmux/relay/e2ee'
import type { DeviceAuthority } from './device-authority.js'

type Configuration = { relay: { endpoint: string; useTls: boolean }; publisherToken: string; allowedClientKeys: readonly string[] }
function configuration(value: unknown): Configuration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected outbound relay configuration.')
  const c = value as Record<string, unknown>, relay = c.relay as Record<string, unknown> | undefined
  if (Object.keys(c).length !== 3 || Object.keys(c).some(key => !['relay', 'publisherToken', 'allowedClientKeys'].includes(key)) ||
      !relay || typeof relay !== 'object' || Array.isArray(relay) || Object.keys(relay).length !== 2 || Object.keys(relay).some(key => !['endpoint', 'useTls'].includes(key)) ||
      typeof relay.endpoint !== 'string' || typeof relay.useTls !== 'boolean' || typeof c.publisherToken !== 'string' || !c.publisherToken || /[\0\r\n\s]/u.test(c.publisherToken) || !Array.isArray(c.allowedClientKeys)) throw new Error('Invalid outbound relay configuration.')
  const allowedClientKeys = c.allowedClientKeys.map(key => {
    if (typeof key !== 'string') throw new Error('Expected an exact allowed client public key.')
    if (exportPublicKey(importPublicKey(key)) !== key) throw new Error('Expected a canonical client public key.')
    return key
  })
  if (new Set(allowedClientKeys).size !== allowedClientKeys.length) throw new Error('Duplicate client public key.')
  return { relay: { endpoint: relay.endpoint, useTls: relay.useTls }, publisherToken: c.publisherToken, allowedClientKeys }
}

/** One original Host's optional outbound carrier; it owns neither Core nor device identity. */
export function createOutboundRelayAccess(options: {
  configurationPath?: string
  authority(): Promise<DeviceAuthority>
  keyPair(): Promise<KeyPair>
}) {
  let started: Promise<void> | undefined, closed = false
  const shutdown = new AbortController()
  // Stop observing optional work without cancelling its owner's durable writes.
  function pending<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(shutdown.signal.reason)
      shutdown.signal.addEventListener('abort', abort, { once: true })
      work.then(resolve, reject).finally(() => shutdown.signal.removeEventListener('abort', abort))
      if (shutdown.signal.aborted) abort()
    })
  }
  let publisher: ReturnType<typeof startAgentMuxRpcRelayPublisher> | undefined
  let offer: ConnectionOffer | undefined
  let state: AgentMuxRpcMobileAccessState = { state: 'unavailable', message: '未配置主动网关连接。' }
  const accessState = (url?: string): AgentMuxRpcMobileAccessState => ({ ...state, ...(url ? { origin: new URL(url).origin } : {}) })
  const start = (server: Pick<AgentMuxHeadlessRuntime['server'], 'openAuthenticatedFrames'>): Promise<void> => started ??= (async () => {
    if (!options.configurationPath || closed) return
    state = { state: 'starting', message: '正在读取原 Host 的主动网关配置。' }
    try {
      if (!isAbsolute(options.configurationPath)) throw new Error('Configuration path must be absolute.')
      const c = configuration(JSON.parse(await readFile(options.configurationPath, { encoding: 'utf8', signal: shutdown.signal })))
      if (closed) return
      const owner = await pending(options.authority())
      if (closed) return
      const keyPair = await pending(options.keyPair())
      if (closed) return
      offer = parseConnectionOffer({ v: 2, serverId: owner.hostId, daemonPublicKeyB64: exportPublicKey(keyPair.publicKey), relay: c.relay })
      publisher = startAgentMuxRpcRelayPublisher({ server, serverId: owner.hostId, keyPair, relay: c.relay, publisherToken: c.publisherToken,
        onState: current => { if (closed) return; state = { state: current, message: current === 'connected' ? '主动网关通道已建立；目标调用和权限仍分别确认。' : current === 'starting' ? '正在连接原网关。' : '主动网关连接中断，正在重连；原会话保留。' } },
        authorize: async publicKey => {
          // Public reachability cannot turn the mobile capability-link model
          // into automatic enrollment of an arbitrary internet client.
          if (!c.allowedClientKeys.includes(publicKey)) throw new AgentMuxError('This encrypted device key is not admitted by the original Host.', 'CONTROL_PERMISSION_DENIED')
          const device = await owner.authorizeKey(publicKey)
          const observation = owner.observe(device)
          return { principal: { kind: 'device', id: `${owner.hostId}:${device.deviceId}` }, signal: observation.signal,
            assertCurrent: () => owner.assertCurrentKey(device, publicKey), dispose: () => observation.dispose() }
        } })
    } catch {
      if (closed) return
      offer = undefined
      state = { state: 'unavailable', message: '主动网关配置尚未确认；检查原配置文件、网关地址与授权。本机 Core 和原会话仍可使用。' }
    }
  })()
  return {
    start,
    accessState,
    async link() {
      await started
      if (closed) throw new AgentMuxError(state.message, 'RELAY_STOPPED')
      if (!offer) throw new AgentMuxError(state.message, options.configurationPath ? 'RELAY_CONFIGURATION_UNAVAILABLE' : 'RELAY_NOT_CONFIGURED')
      const url = connectionOfferUrl(`${offer.relay.useTls ? 'https' : 'http'}://${offer.relay.endpoint}/`, offer)
      return { url, offer: structuredClone(offer), candidates: [], access: accessState(url) }
    },
    async close() {
      closed = true
      state = { state: 'unavailable', message: '主动网关组件已停止；原会话保留。' }
      offer = undefined
      shutdown.abort()
      await publisher?.stop()
    },
  }
}
