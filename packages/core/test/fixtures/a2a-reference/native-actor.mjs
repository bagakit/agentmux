import { createRequire } from 'node:module'
import { writeFile, appendFile } from 'node:fs/promises'
const { WebSocketServer } = createRequire(import.meta.url)('ws')
const [root, _sessionId, lostAcknowledgement] = process.argv.slice(2), session = process.env.AGENTMUX_AGENT_SESSION_ID
const path = name => `${root}/${session}-${name}`
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
let ordinal = 1, state = 'working', turn = 'initial-turn'
const status = () => ({ recordId: 'record-' + ordinal, sequence: ordinal, nativeTurnId: turn, state,
  ...(state === 'done' ? { endReason: 'completed' } : {}) })
server.on('connection', (socket, request) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.REFERENCE_ACTOR_TOKEN) { socket.close(); return }
  socket.on('message', async bytes => {
    const request = JSON.parse(String(bytes)), respond = result => socket.send(JSON.stringify({ id: request.id, result }))
    if (request.method === 'status/subscribe') { socket.subscribed = true; await writeFile(path('subscribed'), 'ready'); respond({ ...status(), initialSnapshot: true }); return }
    if (request.method === 'proof/working' || request.method === 'proof/complete') {
      ordinal++; state = request.method === 'proof/working' ? 'working' : 'done'
      if (state === 'working') turn = 'turn-' + ordinal
      for (const peer of server.clients) if (peer.subscribed) peer.send(JSON.stringify({ method: 'status/changed', params: status() }))
      respond(status()); return
    }
    if (request.method === 'queue/add') {
      await appendFile(path('requests.jsonl'), JSON.stringify({ ...request, processId: process.pid, stateAtReceipt: state }) + '\n', { mode: 0o600 })
      if (lostAcknowledgement === 'lost') { socket.close(); return }
      respond({ queuedSubmissionId: 'queued-' + request.params.clientUserMessageId }); return
    }
    respond({})
  })
})
await new Promise(resolve => server.once('listening', resolve))
await writeFile(path('identity.json'), JSON.stringify({ processId: process.pid, nativeSessionId: 'native-' + session,
  endpoint: `ws://127.0.0.1:${server.address().port}`, capability: process.env.AGENTMUX_AGENT_CAPABILITY }), { mode: 0o600 })
process.stdin.setRawMode?.(true)
process.stdin.on('data', bytes => { void appendFile(path('terminal.bytes'), bytes, { mode: 0o600 }) })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const socket of server.clients) socket.terminate(); server.close(() => process.exit(0)) })
