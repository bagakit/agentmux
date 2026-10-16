// Test-owned app-server protocol + real fake CLI TTY/hook/transcript consumer.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const args = process.argv.slice(2), root = process.env.AGENTMUX_FIXTURE_ROOT
if (args.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0) }
const sid = process.env.AGENTMUX_AGENT_SESSION_ID
if (!root || !sid) throw Error('Private managed fixture identity missing')
const log = value => appendFileSync(root + '/managed-native.jsonl', JSON.stringify({ ...value, pid: process.pid, sid, actorId: process.env.AGENTMUX_CODEX_ACTOR_ID, at: Date.now() }) + '\n')
const file = root + '/codex/sessions/rollout-' + sid + '.jsonl'
const original = () => {
  if (!existsSync(file)) throw Error('Original native conversation missing')
  return readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find(one => one.type === 'session_meta').payload.id
}
if (args.includes('app-server')) {
  const require = createRequire(root + '/core/package.json'), { WebSocketServer } = require('ws')
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  log({ kind: 'backend-start' })
  server.on('connection', (ws, request) => {
    if (request.headers.authorization !== 'Bearer ' + process.env.AGENTMUX_CODEX_ACTOR_TOKEN) { ws.close(1008); return }
    ws.on('message', bytes => {
      const packet = JSON.parse(String(bytes)); log({ kind: 'rpc', method: packet.method, params: packet.params })
      if (!Object.hasOwn(packet, 'id')) return
      let result = {}
      if (['thread/read', 'thread/resume'].includes(packet.method)) {
        const id = original()
        if (packet.params.threadId !== id) { ws.send(JSON.stringify({ jsonrpc: '2.0', id: packet.id, error: { code: -32602, message: 'Exact retained thread required' } })); return }
        result = { thread: { id, sessionId: 'loaded-' + process.pid, canAcceptDirectInput: true }, cwd: process.cwd(),
          approvalPolicy: packet.params.approvalPolicy ?? 'never', sandbox: { type: packet.params.sandbox === 'read-only' ? 'readOnly' : packet.params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess' }, model: packet.params.model ?? 'fixture-model' }
      }
      if (['turn/start', 'turn/steer'].includes(packet.method) && packet.params.input?.some(one => one.text === 'Managed unknown delivery sentinel')) {
        // The actual actor consumed this original input, then loses its response.
        // No Provider admission ACK is returned and no terminal fallback is permitted.
        log({ kind: 'applied-input-response-lost', method: packet.method, params: packet.params })
        ws.terminate(); return
      }
      if (packet.method === 'turn/start') result = { turn: { id: 'fixture-native-input-turn' } }
      if (packet.method === 'turn/steer') result = { turnId: packet.params.expectedTurnId }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }))
    })
  })
  process.on('SIGTERM', () => { log({ kind: 'backend-stop' }); for (const client of server.clients) client.terminate(); server.close(() => process.exit(0)) })
} else {
  const remote = args.indexOf('--remote')
  if (remote < 0) throw Error('Private managed TUI must use original app-server')
  const actual = args.slice(remote + 4)
  log({ kind: 'frontend-start', args: actual })
  writeFileSync(root + '/frontend-' + sid + '.json', JSON.stringify({ pid: process.pid, args: actual }))
  const hex = createHash('sha256').update(sid).digest('hex')
  process.env.AGENTMUX_FIXTURE_NATIVE_ID = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
  process.argv.splice(2, process.argv.length - 2, ...actual)
  await import(pathToFileURL(root + '/fake-codex-cli.mjs').href)
}
