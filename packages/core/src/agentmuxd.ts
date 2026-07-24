#!/usr/bin/env node
import process from 'node:process'
import { defaultAgentMuxDaemonSocketPath } from './daemon-endpoint.js'
import { AgentMuxDaemonServer } from './daemon-server.js'

function parseSocketPath(args: readonly string[]): string {
  if (args.length === 0) return defaultAgentMuxDaemonSocketPath()
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write('Usage: agentmuxd [--socket <private-unix-socket-path>]\n')
    process.exit(0)
  }
  if (args.length === 2 && args[0] === '--socket' && args[1]) return args[1]
  throw new Error('Usage: agentmuxd [--socket <private-unix-socket-path>]')
}

async function main(): Promise<void> {
  const server = new AgentMuxDaemonServer({ socketPath: parseSocketPath(process.argv.slice(2)) })
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await server.stop()
  }
  process.once('SIGINT', () => void stop().then(() => process.exit(0)))
  process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
  await server.start()
  process.stdout.write(`${JSON.stringify({ type: 'ready', socketPath: server.socketPath })}\n`)
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
