#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { WebSocketServer } = require(process.env.AGENTMUX_TEST_WS_MODULE)
const root = process.env.AGENTMUX_STARTUP_FIXTURE_DIRECTORY
const id = '00000000-0000-4000-8000-000000000041', runtime = 'original-runtime'
const log = (file, value) => appendFileSync(join(root, file), JSON.stringify(value) + '\n')
const args = process.argv.slice(2)
if (args.includes('app-server')) {
  let materialized = false, seen = 0
  const sockets = new Set(), server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const notify = (method, params) => { for (const socket of sockets) socket.send(JSON.stringify({ jsonrpc: '2.0', method, params })) }
  setInterval(() => {
    const file = join(root, 'commands.jsonl')
    const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
    for (const line of lines.slice(seen)) {
      const command = JSON.parse(line)
      if (command.materialized !== undefined) materialized = command.materialized
      if (command.close) { for (const socket of sockets) socket.close(); continue }
      if (command.method) notify(command.method, { threadId: command.threadId ?? id, turn: { id: 'original-turn' } })
    }
    seen = lines.length
  }, 10)
  server.on('connection', (socket, request) => {
    if (request.headers.authorization !== 'Bearer ' + process.env.AGENTMUX_CODEX_ACTOR_TOKEN) return socket.close()
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.on('message', async bytes => {
      const request = JSON.parse(String(bytes)); if (!Object.hasOwn(request, 'id')) return
      log('calls.jsonl', { method: request.method, params: request.params })
      const send = value => { if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...value })) }
      const reply = result => send({ result }), error = (code, message) => send({ error: { code, message } })
      const thread = { id, sessionId: existsSync(join(root, 'wrong-runtime')) ? 'different-runtime' : runtime, canAcceptDirectInput: true, status: { type: 'idle' } }
      if (request.method === 'initialize') return reply({})
      if (request.method === 'account/read') return reply({ account: null, requiresOpenaiAuth: false })
      if (request.method === 'thread/start') return reply({ thread: { ...thread, sessionId: runtime }, cwd: request.params.cwd,
        model: request.params.model, approvalPolicy: request.params.approvalPolicy, sandbox: { type: 'readOnly' } })
      if (request.method === 'thread/read') return reply({ thread })
      if (request.method === 'thread/resume') {
        while (existsSync(join(root, 'join-gate'))) await new Promise(resolve => setTimeout(resolve, 10))
        if (!materialized) return error(-32600, 'Original source is not resumable')
        return reply({ thread: { ...thread, ...(existsSync(join(root, 'wrong-joined-runtime')) ? { sessionId: 'different-joined-runtime' } : {}) } })
      }
      if (request.method === 'turn/start') {
        log('input.jsonl', request.params); materialized = true
        reply({ turn: { id: 'original-turn' } }); notify('turn/started', { threadId: id, turn: { id: 'original-turn' } }); return
      }
      error(-32601, 'Unexpected fixture method')
    })
  })
} else {
  log('tui.jsonl', { args, pid: process.pid })
  setInterval(() => {}, 1000)
}
