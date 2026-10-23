#!/usr/bin/env node
// A private native protocol peer. The managed worker, Core, FileStore and Runtime are production code.
import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0) }
if (args.includes('--help')) { console.log('codex resume --no-alt-screen --sandbox --ask-for-approval'); process.exit(0) }
const root = process.env.AGENTMUX_TEST_RECOVERY_PROTOCOL_ROOT
if (!root) throw new Error('The private native peer requires its test-owned protocol root.')
const nativeId = '00000000-0000-4000-8000-000000000005'
const append = (name, value) => appendFileSync(join(root, name), JSON.stringify(value) + '\n')
if (args.includes('app-server')) {
  const { WebSocketServer } = await import('ws')
  const heartbeat = () => {
    writeFileSync(join(root, 'backend.json.next'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    renameSync(join(root, 'backend.json.next'), join(root, 'backend.json'))
  }
  heartbeat(); setInterval(heartbeat, 40)
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', (socket, request) => {
    if (request.headers.authorization !== 'Bearer ' + process.env.AGENTMUX_CODEX_ACTOR_TOKEN) return socket.close()
    socket.on('message', async bytes => {
      const packet = JSON.parse(String(bytes)); append('native-rpc.ndjson', packet)
      if (!Object.hasOwn(packet, 'id')) return
      const reply = result => { if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result })) }
      const failure = (code, message) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: packet.id, error: { code, message } }))
      if (packet.method === 'initialize') return reply({})
      if (packet.method === 'account/read') return existsSync(join(root, 'account-failure'))
        ? failure(-32041, 'Private original account routing failure') : reply({ account: null, requiresOpenaiAuth: false })
      const thread = { id: nativeId, sessionId: 'private-native-runtime', canAcceptDirectInput: true }
      if (packet.method === 'thread/start' || packet.method === 'thread/resume') {
        while (existsSync(join(root, 'native-gate'))) await new Promise(resolve => setTimeout(resolve, 10))
        return reply({ thread, cwd: packet.params.cwd, model: packet.params.model ?? 'private-model',
          approvalPolicy: packet.params.approvalPolicy ?? 'on-request',
          sandbox: { type: packet.params.sandbox === 'read-only' ? 'readOnly' : packet.params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' } })
      }
      if (packet.method === 'thread/read') return reply({ thread })
      if (packet.method === 'turn/start' || packet.method === 'turn/steer') {
        append('native-input.ndjson', packet)
        if (existsSync(join(root, 'input-unknown'))) return socket.close()
        return reply(packet.method === 'turn/start' ? { turn: { id: 'private-original-turn' } } : { turnId: packet.params.expectedTurnId })
      }
      return failure(-32601, 'Unexpected private protocol method: ' + packet.method)
    })
  })
} else {
  append('frontends.ndjson', { pid: process.pid, args })
  process.stdin.setRawMode(true)
  process.stdin.on('data', bytes => {
    if (String(bytes).includes('\x1b[?0u')) process.stdout.write('\x1b[?2026h› \x1b[?2026l')
    else append('terminal-input.ndjson', { pid: process.pid, data: String(bytes) })
  })
  setTimeout(() => process.stdout.write('\x1b[?u'), 80)
  setInterval(() => { if (existsSync(join(root, 'detach-frontend'))) process.exit(1) }, 50)
}
