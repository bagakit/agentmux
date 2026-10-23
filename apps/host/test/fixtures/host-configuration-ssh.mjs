#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const separator = process.argv.indexOf('--'), destination = process.argv[separator + 1]
const trace = process.env.HOST_CONFIG_SSH_TRACE
if (trace) appendFileSync(trace, JSON.stringify({ phase: 'opened', destination, pid: process.pid }) + '\n')
process.once('exit', () => { if (trace) appendFileSync(trace, JSON.stringify({ phase: 'closed', destination, pid: process.pid }) + '\n') })
if (destination === 'pending.fixture') {
  // Controlled system-SSH leaf: the original RPC still owns cancellation/deadline.
  process.stdin.resume()
} else {
  const write = process.stdout.write.bind(process.stdout); let pending = ''
  process.stdout.write = (chunk, ...args) => {
    pending += String(chunk)
    let end
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1)
      try { const response = JSON.parse(line); if (trace && (response.result?.owner || response.error)) appendFileSync(trace, JSON.stringify({ phase: 'response', destination, response }) + '\n') } catch { /* Other native stream bytes are not identity facts. */ }
    }
    return write(chunk, ...args)
  }
  await import('../../../../packages/core/test/fixtures/fake-system-ssh.mjs')
}
