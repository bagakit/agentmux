#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.163.0\n'); process.exit(0) }
const path = process.env.AGENTMUX_QUEUE_FIXTURE
const config = () => JSON.parse(readFileSync(path, 'utf8'))
appendFileSync(config().trace, JSON.stringify({ launch: process.argv.slice(2) }) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line), c = config()
  appendFileSync(c.trace, JSON.stringify(value) + '\n')
  if (!Object.hasOwn(value, 'id')) return
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }) + '\n')
  if (value.method === 'initialize') return reply({})
  if (value.method === 'thread/read') return reply({ thread: { id: c.thread, path: c.sourcePath ?? c.path,
    source: c.source ?? 'cli', threadSource: null, ephemeral: false, canAcceptDirectInput: c.denied ? false : null } })
  if (value.method === 'thread/queue/add') {
    if (c.failure === 'reject') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: value.id,
      error: { code: -32600, message: 'Original native queue rejected this input' } }) + '\n')
    if (c.failure === 'lost-ack') return process.exit(0)
    return reply({ queuedSubmission: { id: 'original-native-queue-item',
      input: c.failure === 'wire' ? [{ type: 'text', text: 'changed input' }] : value.params.input,
      clientUserMessageId: c.failure === 'correlation' ? 'foreign-correlation' : value.params.clientUserMessageId } })
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Unsupported operation' } }) + '\n')
})
