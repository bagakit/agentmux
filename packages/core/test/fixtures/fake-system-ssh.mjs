#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const separator = process.argv.indexOf('--')
if (separator < 0 || !process.argv[separator + 1] || !process.argv[separator + 2]) {
  process.stderr.write('fake ssh expected -- <destination> <remote-command>\n')
  process.exit(255)
}

const remoteHome = process.env.AGENTMUX_FAKE_SSH_HOME
if (!remoteHome) {
  process.stderr.write('fake ssh remote home is missing\n')
  process.exit(255)
}
if (existsSync(join(remoteHome, '.agentmux-ssh-unavailable'))) {
  process.stderr.write('fixture transport unavailable\n')
  process.exit(255)
}

const remoteCommand = process.argv[separator + 2]
const child = spawn('/bin/sh', ['-c', remoteCommand], {
  env: { ...process.env, HOME: remoteHome },
  stdio: ['pipe', 'pipe', 'pipe']
})
const outputDelayMs = Number(process.env.AGENTMUX_FAKE_SSH_OUTPUT_DELAY_MS ?? 0)

process.stdin.pipe(child.stdin)
child.stdout.on('data', (chunk) => {
  if (outputDelayMs > 0) setTimeout(() => process.stdout.write(chunk), outputDelayMs)
  else process.stdout.write(chunk)
})
child.stderr.pipe(process.stderr)

const stop = (signal) => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}
process.once('SIGINT', () => stop('SIGINT'))
process.once('SIGTERM', () => stop('SIGTERM'))
process.once('SIGHUP', () => stop('SIGHUP'))
child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(255)
})
child.once('exit', (code, signal) => {
  if (outputDelayMs > 0) {
    setTimeout(() => process.exit(code ?? (signal ? 255 : 0)), outputDelayMs + 10)
  } else {
    process.exit(code ?? (signal ? 255 : 0))
  }
})
