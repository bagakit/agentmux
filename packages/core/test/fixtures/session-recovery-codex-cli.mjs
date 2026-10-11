#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The production Codex Provider reads this process's real retained native file.
// This wrapper changes only the fixture's native shutdown outcome and records
// actual stdin bytes; terminal text never grants recovery or input authority.
const agentSessionId = process.env.AGENTMUX_AGENT_SESSION_ID
const witnessPath = process.env.AGENTMUX_RECOVERY_INPUT_WITNESS
if (!agentSessionId || !witnessPath) throw new Error('Private recovery fixture requires its exact Session and witness path')
const nonFlags = process.argv.slice(2).filter(arg => !arg.startsWith('-'))
const resumeIndex = nonFlags.indexOf('resume')
const isResume = resumeIndex !== -1
const record = value => appendFileSync(witnessPath, JSON.stringify({ pid: process.pid, isResume, ...value }) + '\n', { mode: 0o600 })
record({ kind: 'process', agentSessionId, cwd: process.cwd(), argv: process.argv.slice(2) })
process.stdin.on('data', data => record({ kind: 'stdin', base64: Buffer.from(data).toString('base64') }))
process.once('SIGTERM', () => {
  if (!isResume && process.env.AGENTMUX_RECOVERY_END_STATE === 'interrupted') {
    const nativePath = join(process.env.HOME, '.codex', 'sessions', `rollout-${agentSessionId}.jsonl`)
    const records = readFileSync(nativePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    const latest = records.filter(value => value.type === 'event_msg').at(-1)
    if (latest?.payload.type !== 'task_started') throw new Error('Only the exact active native turn may be interrupted')
    appendFileSync(nativePath, JSON.stringify({ timestamp: new Date().toISOString(),
      ordinal: Math.max(...records.map(value => Number.isSafeInteger(value.ordinal) ? value.ordinal : 0)) + 1,
      type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted',
        turn_id: latest.payload.turn_id, thread_id: `native-${agentSessionId}` } }) + '\n')
  }
  process.exit(143)
})
await import('./fake-codex-cli.mjs')
