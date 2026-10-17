#!/usr/bin/env node
import { WebSocketServer } from 'ws'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0) }
if (args.includes('--help')) { console.log('codex resume --no-alt-screen --sandbox --ask-for-approval'); process.exit(0) }
const nativeId = '00000000-0000-4000-8000-0000000000d7', turnId = 'original-retained-turn'
const directory = join(process.env.CODEX_HOME, 'sessions'), witness = process.env.AGENTMUX_RESUMED_WITNESS
if (!witness || !process.env.AGENTMUX_AGENT_SESSION_ID) throw new Error('This fixture requires a private Core Session and witness')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const record = value => appendFileSync(witness, JSON.stringify({ pid: process.pid, agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID,
  actorId: process.env.AGENTMUX_CODEX_ACTOR_ID, ...value }) + '\n', { mode: 0o600 })
if (args.includes('app-server')) {
  const path = join(directory, 'rollout-private-resumed.jsonl'), resumed = existsSync(path), fd = openSync(path, 'a', 0o600)
  record({ kind: 'backend', resumed })
  if (!resumed) {
    const now = new Date().toISOString()
    for (const row of [
      { type: 'session_meta', ordinal: 0, payload: { id: nativeId, source: 'cli', thread_source: 'user', cwd: process.cwd(), cli_version: '0.163.0' } },
      { timestamp: now, type: 'event_msg', ordinal: 1, payload: { type: 'task_started', turn_id: turnId, thread_id: nativeId } },
      { timestamp: now, type: 'event_msg', ordinal: 2, payload: { type: 'item_completed', turn_id: turnId, thread_id: nativeId,
        item: { type: 'commandExecution', status: 'completed' } } }
    ]) writeSync(fd, JSON.stringify(row) + '\n')
  } else if (JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).payload.id !== nativeId) throw new Error('Original native source identity changed')
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  server.on('connection', (socket, request) => {
    if (request.headers.authorization !== 'Bearer ' + process.env.AGENTMUX_CODEX_ACTOR_TOKEN) return socket.close()
    socket.on('message', bytes => {
      const message = JSON.parse(String(bytes)); if (!Object.hasOwn(message, 'id')) return
      record({ kind: 'rpc', resumed, method: message.method, params: message.params })
      const reply = result => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      const thread = { id: nativeId, sessionId: 'original-private-session-tree', canAcceptDirectInput: true,
        status: { type: resumed ? 'idle' : 'active' }, turns: [] }
      if (message.method === 'initialize') return reply({})
      if (message.method === 'thread/read') return reply({ thread })
      if (message.method === 'thread/resume') return reply({ thread, cwd: process.cwd(), model: message.params.model,
        approvalPolicy: message.params.approvalPolicy,
        sandbox: { type: message.params.sandbox === 'read-only' ? 'readOnly' : message.params.sandbox === 'workspace-write' ? 'workspaceWrite' : 'dangerFullAccess' } })
      if (message.method === 'thread/turns/list') {
        if (process.env.AGENTMUX_RESUMED_OUTCOME === 'unknown') return socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32603, message: 'Private original turn observation unavailable' } }))
        return reply({ data: [{ id: turnId, status: process.env.AGENTMUX_RESUMED_OUTCOME, items: [], itemsView: 'notLoaded' }] })
      }
      if (message.method === 'thread/queue/add') {
        record({ kind: 'input', resumed, method: message.method, input: message.params.input, clientUserMessageId: message.params.clientUserMessageId })
        return reply({ queuedSubmission: { id: 'private-original-queued-input', clientUserMessageId: message.params.clientUserMessageId, input: message.params.input } })
      }
      if (message.method === 'turn/start' || message.method === 'turn/steer') {
        record({ kind: 'input', resumed, method: message.method, input: message.params.input, clientUserMessageId: message.params.clientUserMessageId })
        return reply(message.method === 'turn/start' ? { turn: { id: 'private-marker-turn' } } : { turnId: message.params.expectedTurnId })
      }
      return socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } }))
    })
  })
} else {
  record({ kind: 'frontend', args })
  process.stdin.setRawMode(true)
  process.stdin.on('data', bytes => {
    record({ kind: 'stdin', base64: Buffer.from(bytes).toString('base64') })
    if (String(bytes).includes('\x1b[?0u')) process.stdout.write('\x1b[?2026h\x1b[22;1H› \x1b[?2026l')
  })
  process.stdout.write('\x1b[?u')
}
