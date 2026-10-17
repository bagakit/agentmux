#!/usr/bin/env node
// Synthetic native CLI for the private product proof. It implements only the
// Provider's declared authenticated actor protocol, never a model or a journal.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('codex-cli 0.163.0\n'); process.exit(0) }
const sid = process.env.AGENTMUX_AGENT_SESSION_ID, directory = process.env.AGENTMUX_A2A_PROOF_DIRECTORY
assert.ok(sid && directory, 'Only an explicitly isolated managed fixture may start')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const nativeHash = createHash('sha256').update(sid).digest('hex')
const nativeId = `${nativeHash.slice(0,8)}-${nativeHash.slice(8,12)}-4${nativeHash.slice(13,16)}-8${nativeHash.slice(17,20)}-${nativeHash.slice(20,32)}`
const nativeDirectory = join(process.env.CODEX_HOME, 'sessions')
mkdirSync(nativeDirectory, { recursive: true, mode: 0o700 })
const nativePath = join(nativeDirectory, 'rollout-' + nativeId + '.jsonl')
const controlPath = join(directory, sid + '.control.json'), logPath = join(directory, sid + '.requests.jsonl')
const log = value => { const fd = openSync(logPath, 'a', 0o600); try { writeSync(fd, JSON.stringify(value) + '\n') } finally { closeSync(fd) } }

if (args.includes('app-server')) {
  const require = createRequire(import.meta.url), { WebSocketServer } = require('ws')
  const token = process.env.AGENTMUX_CODEX_ACTOR_TOKEN
  assert.ok(token); assert.equal(args[args.indexOf('--ws-token-sha256') + 1], createHash('sha256').update(token).digest('hex'))
  const fd = openSync(nativePath, 'a+', 0o600)
  let ordinal = readFileSync(nativePath, 'utf8').split('\n').filter(Boolean).length
  const append = payload => writeSync(fd, JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ++ordinal, type: 'event_msg', payload }) + '\n')
  if (readFileSync(nativePath).length === 0) {
    writeSync(fd, JSON.stringify({ type: 'session_meta', payload: {
      id: nativeId, cwd: process.cwd(), source: 'vscode', thread_source: 'user', history_mode: 'paginated'
    } }) + '\n')
    // A completed original protocol turn supplies the initial idle opportunity.
    // No user/body input or hand-written Core state is used to manufacture it.
    const turnId = 'initial-' + nativeId
    append({ type: 'task_started', thread_id: nativeId, turn_id: turnId })
    append({ type: 'task_complete', thread_id: nativeId, turn_id: turnId })
  }
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket, request) => {
    if (request.headers.authorization !== 'Bearer ' + token) { socket.close(1008); return }
    socket.on('message', bytes => {
      const request = JSON.parse(String(bytes))
      log({ method: request.method, params: request.params, at: Date.now() })
      if (!Object.hasOwn(request, 'id')) return
      const reply = result => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      const reject = (code, message) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message } }))
      if (request.method === 'initialize') return reply({ userAgent: 'AgentMux private synthetic actor' })
      if (request.params?.threadId !== nativeId) return reject(-32602, 'The original native thread is required')
      if (request.method === 'thread/read' || request.method === 'thread/resume') {
        // Availability is a level, unlike the one-shot turn faults below. Core
        // may probe the same actor repeatedly before committing an input intent.
        if (existsSync(controlPath) && JSON.parse(readFileSync(controlPath, 'utf8')).effect === 'unavailable') return reply({ thread: { id: nativeId, sessionId: nativeId, canAcceptDirectInput: false } })
        return reply({ thread: { id: nativeId, sessionId: nativeId, canAcceptDirectInput: true } })
      }
      if (!['turn/start', 'turn/steer', 'thread/queue/add'].includes(request.method)) return reject(-32601, 'This private native protocol method is unsupported')
      let fault
      if (existsSync(controlPath)) { fault = JSON.parse(readFileSync(controlPath, 'utf8')); if (fault.effect !== 'unavailable') unlinkSync(controlPath) }
      if (fault?.effect === 'reject') return reject(-32602, 'Explicit private native input rejection')
      const text = request.params.input?.map(part => { assert.equal(part.type, 'text'); return part.text }).join('')
      assert.equal(typeof text, 'string'); assert.equal(typeof request.params.clientUserMessageId, 'string')
      const turnId = request.params.expectedTurnId ?? 'turn-' + randomUUID()
      append({ type: 'task_started', thread_id: nativeId, turn_id: turnId })
      append({ type: 'item_completed', thread_id: nativeId, turn_id: turnId, item: {
        type: 'UserMessage', id: 'item-' + randomUUID(), client_id: request.params.clientUserMessageId, content: [{ type: 'text', text, text_elements: [] }]
      } })
      append({ type: 'task_complete', thread_id: nativeId, turn_id: turnId })
      if (fault?.effect === 'lose-receipt') { socket.terminate(); return }
      // This actor-shaped fixture is idle throughout its accepted queue calls.
      // Provider queue races and vendor acceptance belong to the Core proofs.
      reply(request.method === 'thread/queue/add' ? { queuedSubmission: { id: 'queued-' + randomUUID(),
        clientUserMessageId: request.params.clientUserMessageId, input: request.params.input } }
        : request.method === 'turn/start' ? { turn: { id: turnId } } : { turnId })
    })
  })
  process.once('exit', () => closeSync(fd))
} else {
  // The TUI has no writable transcript descriptor; the one authenticated actor
  // above is the native record owner discovered by the actual Provider.
  const capability = process.env.AGENTMUX_AGENT_CAPABILITY
  assert.ok(capability && process.env.AGENTMUX_HOOK_URL && process.env.AGENTMUX_HOOK_TOKEN)
  writeFileSync(join(directory, sid + '.credential.json'), JSON.stringify({ agentSessionId: sid, capability }), { mode: 0o600 })
  const hook = async (eventName, payload) => {
    const response = await fetch(process.env.AGENTMUX_HOOK_URL, { method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.AGENTMUX_HOOK_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ eventName, receiptId: randomUUID(), payload }) })
    assert.equal(response.status, 204, 'The actual managed hook owner must accept this receipt')
  }
  await hook('SessionStart', { session_id: nativeId, transcript_path: nativePath })
  process.stdin.setRawMode?.(true); process.stdin.setEncoding('utf8')
  process.stdout.write('\u001b[2J\u001b[HPrivate synthetic native Agent\n')
  await hook('Stop', { session_id: nativeId, transcript_path: nativePath })
  // Ordinary manual bytes remain independently usable throughout native input.
  process.stdin.on('data', data => { log({ manualInput: data, at: Date.now() }); process.stdout.write('private-manual-input:' + data) })
  setInterval(() => {}, 1000)
}
