import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ConnectionAdapter, ConnectionIngressTransport, VerifiedIngressEvent } from '../../src/index.js'

type Message = { eventId: string; messageId: string; room: string; actor: string; body: string }
/** Two distinct local protocol servers; configured origin must answer with the authenticated account. */
export async function applicationScopeWire(appId: string) {
  const endpoints = new Map<string, { secret: string; receive?: Parameters<ConnectionIngressTransport['start']>[0]['receive']; messages: unknown[] }>()
  const servers: Array<ReturnType<typeof createServer>> = []
  const origins: string[] = []
  for (const secret of ['native-secret-one', 'native-secret-two']) {
    let origin = ''
    const server = createServer((incoming, response) => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.on('end', () => { void (async () => {
        const state = endpoints.get(origin)!, raw = Buffer.concat(chunks).toString()
        if (incoming.method === 'GET' && incoming.url === '/identity') {
          if (incoming.headers.authorization !== 'Bearer ' + state.secret) { response.writeHead(401).end(); return }
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ origin, appId })); return
        }
        if (incoming.method === 'POST' && incoming.url === '/event' && state.receive) {
          const signature = createHmac('sha256', state.secret).update(raw).digest('hex')
          try { await state.receive({ raw, transportProof: { origin, signature } }, () => { response.writeHead(202).end() }) }
          catch { if (!response.writableEnded) response.writeHead(401).end() }
          return
        }
        if (incoming.method === 'POST' && incoming.url === '/effect' && incoming.headers.authorization === 'Bearer ' + state.secret) {
          state.messages.push(JSON.parse(raw)); response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messageId: 'native-' + state.messages.length })); return
        }
        response.writeHead(404).end()
      })() })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    origins.push(origin); endpoints.set(origin, { secret, messages: [] }); servers.push(server)
  }
  const observation = { authentication: { state: 'ready' as const }, transport: { state: 'ready' as const }, intake: { state: 'ready' as const }, delivery: { state: 'ready' as const } }
  const adapter: ConnectionAdapter = { adapterId: 'issuer-fixture', test: async (config, credential) => {
    const response = await fetch(config.application.issuer + '/identity', { headers: { authorization: 'Bearer ' + credential } })
    const body = await response.json() as { origin: string; appId: string }
    if (!response.ok || body.origin !== config.application.issuer || body.appId !== config.application.appId) throw Error('Native identity mismatch')
    return observation
  }, ingress: { adapterId: 'issuer-fixture', verify: async (config, raw, proof): Promise<VerifiedIngressEvent> => {
    const witness = proof as { origin?: string; signature?: string }, state = endpoints.get(witness.origin ?? '')
    if (!state || witness.origin !== config.application.issuer || typeof witness.signature !== 'string') throw Error('Wrong native source')
    const expected = createHmac('sha256', state.secret).update(raw).digest(), actual = Buffer.from(witness.signature, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error('Wrong source proof')
    const message = JSON.parse(raw) as Message
    return { eventId: message.eventId, messageId: message.messageId, externalConversationId: message.room,
      actor: { application: config.application, idType: 'native-user', userId: message.actor }, body: message.body, selection: 'mention', conversationKind: 'group' }
  } }, transport: { start: async input => {
    const origin = input.config.application.issuer!, state = endpoints.get(origin)
    if (!state || input.credential !== state.secret) throw Error('Wrong native credential')
    const response = await fetch(origin + '/identity', { headers: { authorization: 'Bearer ' + input.credential } })
    const body = await response.json() as { origin: string; appId: string }
    if (!response.ok || body.origin !== origin || body.appId !== input.config.application.appId) throw Error('Wrong native account')
    state.receive = input.receive
    return { closed: input.signal, close: () => { state.receive = undefined }, observation: () => observation }
  } }, publication: { adapterId: 'issuer-fixture', renderVersion: 'v1', supportedRenderVersions: ['v1'], fragmentBytes: 4096,
    prepare: operation => ({ adapterId: 'issuer-fixture', renderVersion: 'v1', requestKey: operation.operationId,
      request: { method: 'POST', path: '/effect', contentType: 'application/json', body: JSON.stringify({ room: operation.target.externalConversationId, payload: operation.payload }) } }),
    dispatch: async (prepared, target, credential) => {
      const response = await fetch(target.application.issuer + prepared.request.path, { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: prepared.request.body })
      if (!response.ok) return { state: 'unknown', reason: 'effect-unconfirmed' }
      const body = await response.json() as { messageId: string }
      return { state: 'confirmed', mapping: { messageId: body.messageId } }
    }
  } }
  const post = (origin: string, message: Message) => new Promise<number>((resolve, reject) => {
    const req = request(origin + '/event', { method: 'POST' }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)) })
    req.on('error', reject); req.end(JSON.stringify(message))
  })
  return { adapter, origins, post, state: (origin: string) => endpoints.get(origin)!, close: async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } } }
}
