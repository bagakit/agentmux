import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ConnectionAdapter, ConnectionIngressTransport, PublicationAdapter, VerifiedIngressEvent } from '../../src/index.js'

export type SignedRoomMessage = { deliveryKey: string; recordKey: string; roomKey: string; person: string; text: string; addressing: 'broadcast' | 'response' }
const observation = (authenticated: boolean) => ({ authentication: authenticated ? { state: 'ready' as const } : { state: 'unknown' as const, reason: 'not-tested' as const },
  transport: { state: 'ready' as const }, intake: { state: 'ready' as const }, delivery: { state: 'unknown' as const, reason: 'not-started' as const } })

/** Test protocol leaves: an actual signed HTTP receiver and an idempotent replay ledger. No platform claim. */
export function signedRoomAdapter() {
  const trace: string[] = [], effects: Array<{ key: string; room: string; text: string }> = []
  const ledger = new Map<string, { messageId: string }>()
  let endpoint: string | undefined, server: Server | undefined, signingKey: string | undefined, authenticated = false, latestReceive: Parameters<ConnectionIngressTransport['start']>[0]['receive'] | undefined
  const publication: PublicationAdapter = { adapterId: 'signed-room', renderVersion: 'replay-text-v1', supportedRenderVersions: ['replay-text-v1'], fragmentBytes: 8_192,
    prepare: operation => ({ adapterId: 'signed-room', renderVersion: 'replay-text-v1', requestKey: operation.operationId,
      request: { method: 'POST', path: '/replay-records', contentType: 'application/json', body: JSON.stringify({ room: operation.target.externalConversationId, text: operation.payload.text }) } }),
    dispatch: async (prepared, target, credential) => {
      if (!credential) throw new Error('Missing fixture credential')
      const body = JSON.parse(prepared.request.body!)
      if (body.room !== target.externalConversationId) throw new Error('Frozen audience mismatch')
      const previous = ledger.get(prepared.requestKey)
      if (previous) return { state: 'confirmed', mapping: previous }
      effects.push({ key: prepared.requestKey, room: body.room, text: body.text })
      const mapping = { messageId: 'replay/message/' + effects.length }
      ledger.set(prepared.requestKey, mapping)
      return { state: 'confirmed', mapping }
    },
    inspect: async prepared => { const mapping = ledger.get(prepared.requestKey); return mapping ? { state: 'confirmed', mapping } : null }
  }
  const adapter: ConnectionAdapter = { adapterId: 'signed-room', publication,
    test: async () => observation(authenticated),
    ingress: { adapterId: 'signed-room', verify: async (config, raw, proof): Promise<VerifiedIngressEvent> => {
      if (!signingKey) throw new Error('Original Host receiver has not resolved its credential')
      const expected = createHmac('sha256', signingKey).update(raw).digest()
      if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/u.test(proof) || !timingSafeEqual(expected, Buffer.from(proof, 'hex'))) throw new Error('Private signature mismatch')
      const message = JSON.parse(raw) as SignedRoomMessage
      if (!['broadcast', 'response'].includes(message.addressing)) throw new Error('Unknown addressing fact')
      authenticated = true
      return { eventId: message.deliveryKey, messageId: message.recordKey, externalConversationId: message.roomKey,
        actor: { application: config.application, idType: 'email', userId: message.person }, body: message.text,
        selection: message.addressing === 'response' ? 'reply' : 'message' }
    } },
    transport: { start: async ({ credential, signal, receive }) => {
      if (credential !== 'fixture-signing-key') throw new Error('Wrong original credential')
      signingKey = credential
      latestReceive = receive
      server = createServer((incoming, response) => {
        const chunks: Buffer[] = []
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
        incoming.on('end', () => { void (async () => {
          try {
            trace.push('callback')
            await receive({ raw: Buffer.concat(chunks).toString(), transportProof: incoming.headers['x-room-signature'] }, () => {
              trace.push('ack'); response.writeHead(202); response.end('retained')
            })
            trace.push('callback-returned')
          } catch { if (!response.writableEnded) { response.writeHead(401); response.end('not-retained') } }
        })() })
      })
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
      endpoint = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
      const original = server
      const close = () => { original.close(); if (server === original) endpoint = undefined }
      signal.addEventListener('abort', close, { once: true })
      return { close, observation: () => observation(authenticated) }
    } }
  }
  const encode = (message: SignedRoomMessage) => { const raw = JSON.stringify(message); return { raw, transportProof: createHmac('sha256', 'fixture-signing-key').update(raw).digest('hex') } }
  return { adapter, trace, effects, ledger, get endpoint() { return endpoint }, get receive() { return latestReceive }, encode,
    async post(message: SignedRoomMessage, valid = true): Promise<number> {
      if (!endpoint) throw new Error('Original Host did not start its registered receiver')
      const event = encode(message)
      return await new Promise((resolve, reject) => {
        const outgoing = request(endpoint!, { method: 'POST', headers: { 'x-room-signature': valid ? event.transportProof : 'invalid' }, timeout: 3_000 }, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode!))
        })
        outgoing.once('error', reject); outgoing.once('timeout', () => outgoing.destroy(new Error('Signed fixture deadline'))); outgoing.end(event.raw)
      })
    }
  }
}
