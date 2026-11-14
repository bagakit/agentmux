import { WebSocket } from 'ws'
import { exportPublicKey, type KeyPair } from '@agentmux/relay/e2ee'
import { parseConnectionOffer } from '@agentmux/relay/offer'
import { startRelayTransport, type ExternalSocketMetadata, type RelayLogger, type RelaySocketLike } from '@agentmux/relay/server'
import { AgentMuxError } from './errors.js'
import type { AgentMuxControlServer, AgentMuxRpcHttpAuthorization } from './public-rpc-server.js'

export type AgentMuxRelayDeviceAuthorization = (publicKey: string, metadata: ExternalSocketMetadata) => Promise<AgentMuxRpcHttpAuthorization>

/** Lend only this authenticated device connection to the original dispatcher. */
export async function attachAgentMuxRpcRelaySocket(options: {
  socket: RelaySocketLike
  metadata?: ExternalSocketMetadata
  server: Pick<AgentMuxControlServer, 'openAuthenticatedFrames'>
  authorize: AgentMuxRelayDeviceAuthorization
}): Promise<void> {
  const { socket, metadata } = options
  if (!metadata?.peerPublicKeyB64) throw new AgentMuxError('The encrypted peer identity is unavailable.', 'CONTROL_PERMISSION_DENIED')
  let closed = false
  let frames: ReturnType<AgentMuxControlServer['openAuthenticatedFrames']> | undefined
  let authorization: AgentMuxRpcHttpAuthorization | undefined
  const dispose = () => {
    if (closed) return
    closed = true; frames?.dispose()
    // The dispatcher owns disposal once attached; a close during authorization
    // must still release the exact original device observation.
    if (!frames) void Promise.resolve().then(() => authorization?.dispose?.()).catch(() => {})
  }
  socket.once('close', dispose)
  socket.on('error', () => { dispose(); socket.close() })
  try {
    authorization = await options.authorize(metadata.peerPublicKeyB64, metadata)
    if (closed) { await authorization.dispose?.(); return }
    frames = options.server.openAuthenticatedFrames({ authorization,
      send: async frame => { await socket.send(JSON.stringify(frame)) }, close: () => socket.close() })
    let queue = Promise.resolve(), queuedBytes = 0, queuedCount = 0
    socket.on('message', data => {
      if (closed) return
      let text: string
      try {
        text = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(
          data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : new Uint8Array())
      } catch { socket.close(4002, 'Invalid RPC frame'); return }
      const bytes = Buffer.byteLength(text)
      // Existing Host admission budget: queued requests on this device only.
      if (queuedBytes + bytes > 8 * 1024 * 1024 || queuedCount >= 128) { socket.close(4008, 'Device request budget exceeded'); return }
      queuedBytes += bytes; queuedCount++
      queue = queue.then(async () => { if (!closed) await frames!.receive(JSON.parse(text)) })
        .catch(() => { socket.close(4002, 'Invalid RPC frame') })
        .finally(() => { queuedBytes -= bytes; queuedCount-- })
    })
  } catch (error) { dispose(); socket.close(4003, 'Device authorization unavailable'); throw error }
}

/** Outbound transport only. Runtime, device grants and every RPC effect stay with the original owner. */
export function startAgentMuxRpcRelayPublisher(options: {
  server: Pick<AgentMuxControlServer, 'openAuthenticatedFrames'>
  serverId: string
  keyPair: KeyPair
  relay: { endpoint: string; useTls: boolean }
  publisherToken: string
  authorize: AgentMuxRelayDeviceAuthorization
  onState?(state: 'starting' | 'connected' | 'disconnected'): void
}) {
  const offer = parseConnectionOffer({ v: 2, serverId: options.serverId,
    daemonPublicKeyB64: exportPublicKey(options.keyPair.publicKey), relay: options.relay })
  if (typeof options.publisherToken !== 'string' || !options.publisherToken || /[\0\r\n\s]/u.test(options.publisherToken)) throw new AgentMuxError('The original publisher credential is invalid.', 'INVALID_CONTROL_REQUEST')
  const logger: RelayLogger = { child: () => logger, info: () => {}, warn: () => {}, debug: () => {} }
  return startRelayTransport({ logger, serverId: offer.serverId, daemonKeyPair: options.keyPair,
    relayEndpoint: offer.relay.endpoint, relayUseTls: offer.relay.useTls,
    createWebSocket: url => new WebSocket(url, { headers: { Authorization: `Bearer ${options.publisherToken}` }, handshakeTimeout: 10000, perMessageDeflate: false }),
    ...(options.onState ? { onState: options.onState } : {}),
    attachSocket: (socket, metadata) => attachAgentMuxRpcRelaySocket({ socket, ...(metadata ? { metadata } : {}), server: options.server, authorize: options.authorize }) })
}
