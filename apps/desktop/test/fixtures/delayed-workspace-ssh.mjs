#!/usr/bin/env node
// Task-local system-SSH executable substitute: real stdio/shell/filesystem, no network or Runtime.
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const invocation = process.argv.at(-1)
const directory = invocation.includes('agentmux-directory')
const trace = process.env.AGENTMUX_TEST_DIRECTORY_SSH_TRACE
const connectTimeout = Number(process.argv.find(arg => arg.startsWith('ConnectTimeout='))?.split('=')[1])
if (trace) appendFileSync(trace, JSON.stringify({ directory, connectTimeout, pid: process.pid, at: Date.now() }) + '\n')
if (directory && process.env.AGENTMUX_TEST_DIRECTORY_SSH_OUTPUT_LIMIT === '1') {
  process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1024, 120));
} else {
  const connect = directory ? Number(process.env.AGENTMUX_TEST_DIRECTORY_SSH_CONNECT_DELAY ?? 0) : 0
  const execute = directory ? Number(process.env.AGENTMUX_TEST_DIRECTORY_SSH_EXEC_DELAY ?? 0) : 0
  setTimeout(() => {
    if (connect > connectTimeout * 1000) {
      process.stderr.write('SSH connection timed out before command delivery.\n'); process.exitCode = 255; return
    }
    // Separately delay before transport delivery and within the delivered command.
    const child = spawn('/bin/sh', ['-c', `sleep ${execute / 1000}; ${invocation}`], { stdio: 'inherit', detached: true })
    child.once('error', () => { process.exitCode = 255 })
    child.once('exit', code => { process.exitCode = code ?? 255 })
    process.once('SIGTERM', () => { try { process.kill(-child.pid, 'SIGTERM') } catch {} process.exitCode = 143 })
  }, Math.min(connect, connectTimeout * 1000))
}
