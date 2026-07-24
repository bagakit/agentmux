#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { agentMuxDaemonStatePath, defaultAgentMuxDaemonSocketPath } from './daemon-endpoint.js'
import {
  AGENTMUX_DAEMON_BUILD_IDENTITY,
  AGENTMUX_DAEMON_MAX_FRAME_BYTES,
  AGENTMUX_DAEMON_PROTOCOL_VERSION,
  AGENTMUX_LOCAL_HOST_ID,
  encodeAgentMuxDaemonFrame,
  parseAgentMuxDaemonFrame,
  type AgentMuxDaemonHello
} from './daemon-protocol.js'
import { AgentMuxDaemonServer } from './daemon-server.js'
import { AgentMuxError } from './errors.js'

type DaemonCommand = 'serve' | 'activate' | 'connect' | 'status' | 'shutdown'

type DaemonCommandOptions = {
  command: DaemonCommand
  socketPath: string
  statePath: string
  hostId: string
  buildIdentity: string
}

const USAGE = [
  'Usage:',
  '  agentmuxd serve [--socket <path>] [--state <path>] [--host-id <id>] [--build-id <id>]',
  '  agentmuxd activate [--socket <path>] [--state <path>] [--host-id <id>] [--build-id <id>]',
  '  agentmuxd connect [--socket <path>]',
  '  agentmuxd status [--socket <path>] [--host-id <id>] [--build-id <id>]',
  '  agentmuxd shutdown [--socket <path>] [--host-id <id>] [--build-id <id>]'
].join('\n')

function parseCommand(args: readonly string[]): DaemonCommandOptions {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  const command = args[0]
  if (command !== 'serve' && command !== 'activate' && command !== 'connect' && command !== 'status' && command !== 'shutdown') {
    throw new AgentMuxError(USAGE, 'INVALID_DAEMON_COMMAND')
  }
  let socketPath = defaultAgentMuxDaemonSocketPath()
  let statePath: string | undefined
  let hostId = AGENTMUX_LOCAL_HOST_ID
  let buildIdentity = AGENTMUX_DAEMON_BUILD_IDENTITY
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!value) throw new AgentMuxError(USAGE, 'INVALID_DAEMON_COMMAND')
    if (flag === '--socket') socketPath = value
    else if (flag === '--state' && (command === 'serve' || command === 'activate')) statePath = value
    else if (flag === '--host-id' && command !== 'connect') hostId = value
    else if (flag === '--build-id' && command !== 'connect') buildIdentity = value
    else throw new AgentMuxError(USAGE, 'INVALID_DAEMON_COMMAND')
  }
  return {
    command,
    socketPath,
    statePath: statePath ?? agentMuxDaemonStatePath(socketPath),
    hostId,
    buildIdentity
  }
}

async function inspectDaemon(options: DaemonCommandOptions): Promise<AgentMuxDaemonHello> {
  const socket = createConnection(options.socketPath)
  socket.setEncoding('utf8')
  const requestId = `agentmuxd-inspect-${process.pid}`
  return await new Promise<AgentMuxDaemonHello>((resolve, reject) => {
    let input = ''
    const timer = setTimeout(() => finish(new AgentMuxError('Daemon inspection timed out.', 'DAEMON_DISCONNECTED')), 3_000)
    timer.unref?.()
    const finish = (error?: Error, hello?: AgentMuxDaemonHello): void => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else if (hello) resolve(hello)
    }
    socket.once('error', (error) => finish(error))
    socket.once('connect', () => {
      socket.write(encodeAgentMuxDaemonFrame({
        type: 'request',
        id: requestId,
        method: 'hello',
        params: {}
      }))
    })
    socket.on('data', (chunk: string) => {
      input += chunk
      if (Buffer.byteLength(input) > AGENTMUX_DAEMON_MAX_FRAME_BYTES) {
        finish(new AgentMuxError('Daemon inspection response is too large.', 'DAEMON_FRAME_TOO_LARGE'))
        return
      }
      const newline = input.indexOf('\n')
      if (newline < 0) return
      try {
        const frame = parseAgentMuxDaemonFrame(input.slice(0, newline))
        if (frame.type !== 'response' || frame.id !== requestId || !frame.ok) {
          throw new AgentMuxError('Daemon inspection returned an invalid response.', 'INVALID_DAEMON_RESPONSE')
        }
        const hello = frame.result as AgentMuxDaemonHello
        if (hello.protocolVersion !== AGENTMUX_DAEMON_PROTOCOL_VERSION) {
          throw new AgentMuxError('Daemon protocol identity does not match.', 'DAEMON_PROTOCOL_MISMATCH')
        }
        if (hello.buildIdentity !== options.buildIdentity) {
          throw new AgentMuxError('Daemon build identity does not match.', 'DAEMON_BUILD_MISMATCH')
        }
        if (hello.hostId !== options.hostId) {
          throw new AgentMuxError('Daemon host identity does not match.', 'DAEMON_HOST_MISMATCH')
        }
        finish(undefined, hello)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

async function serve(options: DaemonCommandOptions): Promise<void> {
  const server = new AgentMuxDaemonServer({
    socketPath: options.socketPath,
    statePath: options.statePath,
    hostId: options.hostId,
    buildIdentity: options.buildIdentity
  })
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await server.stop()
  }
  process.once('SIGINT', () => void stop().then(() => process.exit(0)))
  process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
  await server.start()
  process.stdout.write(`${JSON.stringify({
    type: 'ready',
    socketPath: server.socketPath,
    hostId: options.hostId,
    buildIdentity: options.buildIdentity
  })}\n`)
}

function isIdentityMismatch(error: unknown): boolean {
  return error instanceof AgentMuxError && [
    'DAEMON_PROTOCOL_MISMATCH',
    'DAEMON_BUILD_MISMATCH',
    'DAEMON_HOST_MISMATCH'
  ].includes(error.code)
}

async function activate(options: DaemonCommandOptions): Promise<void> {
  try {
    const existing = await inspectDaemon(options)
    process.stdout.write(`${JSON.stringify({ type: 'active', started: false, ...existing })}\n`)
    return
  } catch (error) {
    if (isIdentityMismatch(error)) throw error
  }

  const entry = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [
    entry,
    'serve',
    '--socket',
    options.socketPath,
    '--state',
    options.statePath,
    '--host-id',
    options.hostId,
    '--build-id',
    options.buildIdentity
  ], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()

  const deadline = Date.now() + 8_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const hello = await inspectDaemon(options)
      process.stdout.write(`${JSON.stringify({ type: 'active', started: true, ...hello })}\n`)
      return
    } catch (error) {
      if (isIdentityMismatch(error)) throw error
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new AgentMuxError(
    `Daemon activation timed out${lastError instanceof Error ? `: ${lastError.message}` : '.'}`,
    'DAEMON_ACTIVATION_FAILED'
  )
}

async function connect(options: DaemonCommandOptions): Promise<void> {
  const socket = createConnection(options.socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
  await new Promise<void>((resolve, reject) => {
    socket.once('close', resolve)
    socket.once('error', reject)
    process.stdout.once('error', reject)
  })
}

async function status(options: DaemonCommandOptions): Promise<void> {
  process.stdout.write(`${JSON.stringify({ type: 'status', ...(await inspectDaemon(options)) })}\n`)
}

async function shutdown(options: DaemonCommandOptions): Promise<void> {
  const hello = await inspectDaemon(options)
  process.kill(hello.daemonPid, 'SIGTERM')
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      await inspectDaemon(options)
    } catch (error) {
      if (isIdentityMismatch(error)) throw error
      process.stdout.write(`${JSON.stringify({ type: 'shutdown', daemonInstanceId: hello.daemonInstanceId })}\n`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new AgentMuxError('Daemon shutdown timed out.', 'DAEMON_SHUTDOWN_FAILED')
}

async function main(): Promise<void> {
  const options = parseCommand(process.argv.slice(2))
  if (options.command === 'serve') await serve(options)
  else if (options.command === 'activate') await activate(options)
  else if (options.command === 'connect') await connect(options)
  else if (options.command === 'status') await status(options)
  else await shutdown(options)
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
