#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout } from 'node:timers/promises'

if (process.argv[2] !== 'acp' || !process.env.ACP_RUN_TRACE || !process.env.ACP_RUN_RELEASE) process.exit(2)
if (process.env.AGENTMUX_ACP_ACTOR_TOKEN || process.env.AGENTMUX_HOOK_TOKEN) process.exit(3)
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  appendFileSync(process.env.ACP_RUN_TRACE, JSON.stringify({ pid: process.pid, method, params }) + '\n')
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  if (method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } })
  else if (method === 'session/new') {
    while (!existsSync(process.env.ACP_RUN_RELEASE)) await setTimeout(20)
    reply({ sessionId: 'fixture-original-acp-session' })
  } else if (method === 'session/resume' && params.sessionId === 'fixture-original-acp-session' && process.env.ACP_RUN_RESUME_RELEASE) {
    while (!existsSync(process.env.ACP_RUN_RESUME_RELEASE)) await setTimeout(20)
    reply(readFileSync(process.env.ACP_RUN_RESUME_RELEASE, 'utf8') === 'mismatch' ? { sessionId: 'fixture-foreign-acp-session' } : {})
  } else process.exit(2)
}
