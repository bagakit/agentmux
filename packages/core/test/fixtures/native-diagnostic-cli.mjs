#!/usr/bin/env node
import { WebSocketServer } from 'ws'
import { appendFileSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0) }
if (args.includes('--help')) { console.log('codex resume --no-alt-screen'); process.exit(0) }
const witness = process.env.AGENTMUX_DIAGNOSTIC_WITNESS
if (!witness) throw new Error('A private diagnostic witness is required')
const record = value => appendFileSync(witness, JSON.stringify({ pid: process.pid, ...value }) + '\n', { mode: 0o600 })
const nativeId = '00000000-0000-4000-8000-0000000000dc'
if (args.includes('app-server')) {
  const directory = join(process.env.CODEX_HOME, 'sessions'), transcript = join(directory, 'rollout-private-diagnostic.jsonl')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const retained = existsSync(transcript), descriptor = openSync(transcript, 'a', 0o600)
  if (!retained) writeSync(descriptor, JSON.stringify({ type: 'session_meta', ordinal: 0,
    payload: { id: nativeId, source: 'cli', thread_source: 'user', cwd: process.cwd(), cli_version: '0.163.0' } }) + '\n')
  record({ kind: 'backend' })
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', (socket, request) => {
    if (request.headers.authorization !== 'Bearer ' + process.env.AGENTMUX_CODEX_ACTOR_TOKEN) return socket.close()
    socket.on('message', async bytes => {
      const message = JSON.parse(String(bytes)); if (!Object.hasOwn(message, 'id')) return
      record({ kind: 'rpc', method: message.method, params: message.params })
      if (message.method === 'thread/resume') {
        const token = process.env.AGENTMUX_CODEX_ACTOR_TOKEN, credential = process.env.AGENTMUX_AGENT_CAPABILITY
        const diagnostic = 'NATIVE_DIAGNOSTIC_BEGIN\n' + '原生诊断'.repeat(8192) + '\nactor=' + token + '\ncapability=' + credential + '\nNATIVE_DIAGNOSTIC_END\n'
        record({ kind: 'diagnostic', diagnostic })
        const split = diagnostic.indexOf(token) + 3
        await new Promise(done => process.stderr.write(diagnostic.slice(0, split), done))
        await new Promise(done => setImmediate(done))
        await new Promise(done => process.stderr.write(diagnostic.slice(split), done))
        if (process.env.AGENTMUX_DIAGNOSTIC_FAILURE === 'rpc-rejection') return socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32602, message: 'Exact original native configuration rejected; actor=' + token } }))
        if (process.env.AGENTMUX_DIAGNOSTIC_FAILURE === 'transport-close') return socket.close()
        throw new Error('Unknown private diagnostic failure')
      }
      const thread = { id: nativeId, sessionId: 'private-native-session', canAcceptDirectInput: true, status: { type: 'idle' } }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'thread/read' ? { thread } : {} }))
    })
  })
} else {
  record({ kind: 'frontend', args })
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', () => {})
}
