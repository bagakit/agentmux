import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { Duplex } from 'node:stream'
import { quote } from 'shell-quote'
import type { AgentMuxDaemonConnector } from './daemon-connector.js'
import { AgentMuxError } from './errors.js'

const MAX_SSH_STDERR_BYTES = 64 * 1024

export type AgentMuxSshTarget = {
  hostId: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
  extraArgs?: readonly string[]
  connectTimeoutSeconds?: number
}

export type AgentMuxSshDaemonConnectorOptions = {
  target: AgentMuxSshTarget
  remoteNodePath: string
  remoteAgentMuxdPath: string
  remoteSocketPath: string
  expectedBuildIdentity: string
  sshCommand?: string
  spawnProcess?: AgentMuxSshSpawn
}

export type AgentMuxSshSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: 'pipe' }
) => ChildProcessWithoutNullStreams

function safeDestination(target: AgentMuxSshTarget): string {
  const destination = target.user ? `${target.user}@${target.hostname}` : target.hostname
  if (!target.hostId.trim() || !/^[A-Za-z0-9_.:@%+-]+$/.test(destination)) {
    throw new AgentMuxError('SSH target contains unsupported characters.', 'INVALID_SSH_DESTINATION')
  }
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)) {
    throw new AgentMuxError('SSH port must be an integer from 1 to 65535.', 'INVALID_SSH_PORT')
  }
  return destination
}

export function buildAgentMuxSshArgs(options: AgentMuxSshDaemonConnectorOptions): string[] {
  return buildAgentMuxSshCommandArgs(options.target, [
    options.remoteNodePath,
    options.remoteAgentMuxdPath,
    'connect',
    '--socket',
    options.remoteSocketPath
  ])
}

export function buildAgentMuxSshCommandArgs(
  target: AgentMuxSshTarget,
  remoteArgv: readonly string[]
): string[] {
  return [
    '-T',
    '-o',
    `ConnectTimeout=${target.connectTimeoutSeconds ?? 10}`,
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...(target.port ? ['-p', String(target.port)] : []),
    ...(target.identityFile ? ['-i', target.identityFile] : []),
    ...(target.extraArgs ?? []),
    '--',
    safeDestination(target),
    quote(remoteArgv)
  ]
}

export class SshAgentMuxDaemonConnector implements AgentMuxDaemonConnector {
  readonly expectedHostId: string
  readonly expectedBuildIdentity: string

  constructor(private readonly options: AgentMuxSshDaemonConnectorOptions) {
    this.expectedHostId = options.target.hostId
    this.expectedBuildIdentity = options.expectedBuildIdentity
  }

  async connect(): Promise<Duplex> {
    const spawnProcess = this.options.spawnProcess ?? nodeSpawn
    const child = spawnProcess(
      this.options.sshCommand ?? 'ssh',
      buildAgentMuxSshArgs(this.options),
      { stdio: 'pipe', windowsHide: true }
    )
    let connection: Duplex | null = null
    let terminalError: AgentMuxError | null = null
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (Buffer.byteLength(stderr) <= MAX_SSH_STDERR_BYTES) return
      terminalError = new AgentMuxError(
        'System SSH stderr exceeded its limit.',
        'SSH_TRANSPORT_OUTPUT_LIMIT'
      )
      child.kill()
      connection?.destroy(terminalError)
    })
    child.on('exit', (code, signal) => {
      const detail = stderr.trim()
      terminalError ??= new AgentMuxError(
        `System SSH transport exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : '.'}`,
        'SSH_TRANSPORT_FAILED'
      )
      connection?.destroy(terminalError)
    })
    child.on('error', (error) => {
      terminalError = new AgentMuxError(`System SSH failed: ${error.message}`, 'SSH_TRANSPORT_FAILED')
      connection?.destroy(terminalError)
    })
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn)
        reject(new AgentMuxError(`Could not start system SSH: ${error.message}`, 'SSH_TRANSPORT_UNAVAILABLE'))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
    if (terminalError) throw terminalError
    connection = Duplex.from({ readable: child.stdout, writable: child.stdin })
    connection.once('close', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    })
    return connection
  }
}
