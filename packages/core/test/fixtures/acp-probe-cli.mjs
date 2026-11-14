#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [transport, scenario] = process.argv.slice(2)
if (transport !== 'acp' || !scenario || !process.env.ACP_PROBE_TRACE) process.exit(2)
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line)
  const { id, method, params } = frame
  appendFileSync(process.env.ACP_PROBE_TRACE, JSON.stringify({ scenario, cwd: process.cwd(), method, params }) + '\n')
  const reply = body => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n')
  if (method === 'initialize') {
    reply({ result: { protocolVersion: 1, agentCapabilities: { loadSession: true,
      sessionCapabilities: scenario === 'no-list' ? {} : { list: {}, resume: {} }, promptCapabilities: { image: true } } } })
  } else if (method === 'session/list' && scenario === 'ready') {
    reply({ result: { sessions: [{ sessionId: 'private-session', cwd: process.cwd(), title: 'private title' }] } })
  } else if (method === 'session/list' && scenario === 'signed-out') {
    reply({ error: { code: -32000, message: 'private text from the native process', data: { token: 'private token' } } })
  } else if (method === 'session/list' && scenario === 'bad-response') {
    reply({ result: { sessions: [{ title: 'not a session' }] } })
  } else {
    process.exit(2)
  }
}
