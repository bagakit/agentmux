import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxError, CommandExecutionError } from './errors.js'
import { quote } from 'shell-quote'
import {
  runProcess,
  type CommandResult,
  type ProcessRunner,
  type RunCommandOptions
} from './process-runner.js'
import type { ExecutionHostKind } from './types.js'

export type ExecutionHost = {
  readonly id: string
  readonly kind: ExecutionHostKind
  readonly label: string
  run(command: string, args: readonly string[], options?: RunCommandOptions): Promise<CommandResult>
  exposeLoopbackPort(localPort: number): Promise<number>
  dispose(): Promise<void>
}

export type LocalExecutionHostOptions = {
  id?: string
  label?: string
  runner?: ProcessRunner
}

export class LocalExecutionHost implements ExecutionHost {
  readonly id: string
  readonly kind = 'local' as const
  readonly label: string
  private readonly runner: ProcessRunner

  constructor(options: LocalExecutionHostOptions = {}) {
    this.id = options.id ?? 'local'
    this.label = options.label ?? 'This Mac'
    this.runner = options.runner ?? runProcess
  }

  async run(command: string, args: readonly string[], options?: RunCommandOptions): Promise<CommandResult> {
    return await this.runner(command, args, options)
  }

  async exposeLoopbackPort(localPort: number): Promise<number> {
    return localPort
  }

  async dispose(): Promise<void> {}
}

export type SshExecutionHostOptions = {
  id: string
  hostname: string
  label?: string
  user?: string
  port?: number
  identityFile?: string
  extraArgs?: readonly string[]
  connectTimeoutSeconds?: number
  runner?: ProcessRunner
}

function assertSafeSshDestination(value: string): void {
  if (!/^[A-Za-z0-9_.:@%+-]+$/.test(value)) {
    throw new AgentMuxError('SSH destination contains unsupported characters.', 'INVALID_SSH_DESTINATION')
  }
}

function environmentArgv(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> | undefined
): string[] {
  if (!env) return [command, ...args]
  const assignments = Object.entries(env).flatMap(([name, value]) => {
    if (value === undefined) return []
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new AgentMuxError(`Invalid remote environment name: ${name}`, 'INVALID_ENV_NAME')
    }
    return [`${name}=${value}`]
  })
  return assignments.length > 0 ? ['env', ...assignments, command, ...args] : [command, ...args]
}

export class SshExecutionHost implements ExecutionHost {
  readonly id: string
  readonly kind = 'ssh' as const
  readonly label: string
  readonly hostname: string
  readonly user: string | undefined
  readonly port: number | undefined
  readonly identityFile: string | undefined
  readonly extraArgs: readonly string[]
  private readonly connectTimeoutSeconds: number
  private readonly runner: ProcessRunner
  private forward: { controlDirectory: string; controlPath: string; localPort: number; remotePort: number } | null = null
  private forwardPromise: Promise<number> | null = null

  constructor(options: SshExecutionHostOptions) {
    if (!options.id.trim() || !options.hostname.trim()) {
      throw new AgentMuxError('SSH host id and hostname are required.', 'INVALID_SSH_HOST')
    }
    this.id = options.id
    this.hostname = options.hostname
    this.user = options.user
    this.port = options.port
    this.identityFile = options.identityFile
    this.extraArgs = options.extraArgs ?? []
    this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? 10
    this.label = options.label ?? options.hostname
    this.runner = options.runner ?? runProcess
  }

  async run(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
    const destination = this.destination()
    const remoteArgv = environmentArgv(command, args, options.env)
    const remoteCommand = quote(remoteArgv)
    const sshArgs = [
      ...this.connectionArgs(),
      '--',
      destination,
      remoteCommand
    ]
    return await this.runner('ssh', sshArgs, {
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {})
    })
  }

  async exposeLoopbackPort(localPort: number): Promise<number> {
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      throw new AgentMuxError(`Invalid local forward port: ${localPort}`, 'INVALID_FORWARD_PORT')
    }
    if (this.forward) {
      if (this.forward.localPort !== localPort) {
        throw new AgentMuxError('SSH host already forwards a different hook server.', 'HOOK_FORWARD_CONFLICT')
      }
      return this.forward.remotePort
    }
    if (this.forwardPromise) return await this.forwardPromise
    this.forwardPromise = this.createLoopbackForward(localPort)
    try {
      return await this.forwardPromise
    } finally {
      this.forwardPromise = null
    }
  }

  async dispose(): Promise<void> {
    const forward = this.forward
    this.forward = null
    if (!forward) return
    await this.runner(
      'ssh',
      ['-S', forward.controlPath, '-O', 'exit', '--', this.destination()],
      { timeoutMs: 8_000 }
    ).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }))
    await rm(forward.controlDirectory, { recursive: true, force: true })
  }

  private destination(): string {
    const destination = this.user ? `${this.user}@${this.hostname}` : this.hostname
    assertSafeSshDestination(destination)
    return destination
  }

  private connectionArgs(): string[] {
    return [
      '-T',
      '-o',
      `ConnectTimeout=${this.connectTimeoutSeconds}`,
      ...(this.port ? ['-p', String(this.port)] : []),
      ...(this.identityFile ? ['-i', this.identityFile] : []),
      ...this.extraArgs
    ]
  }

  private async createLoopbackForward(localPort: number): Promise<number> {
    const controlDirectory = await mkdtemp(join(tmpdir(), 'agentmux-ssh-'))
    const controlPath = join(controlDirectory, 'control')
    const destination = this.destination()
    const masterArgs = [
      '-M',
      '-S',
      controlPath,
      '-f',
      '-N',
      ...this.connectionArgs(),
      '--',
      destination
    ]
    const master = await this.runner('ssh', masterArgs, { timeoutMs: 15_000 })
    if (master.exitCode !== 0) {
      await rm(controlDirectory, { recursive: true, force: true })
      throw new CommandExecutionError('Failed to open SSH hook bridge.', 'ssh', masterArgs, master.exitCode, master.stderr)
    }

    const forwardSpec = `127.0.0.1:0:127.0.0.1:${localPort}`
    const forwardArgs = ['-S', controlPath, '-O', 'forward', '-R', forwardSpec, '--', destination]
    const result = await this.runner('ssh', forwardArgs, { timeoutMs: 15_000 })
    const remotePort = Number(result.stdout.trim())
    if (result.exitCode !== 0 || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      await this.runner('ssh', ['-S', controlPath, '-O', 'exit', '--', destination], { timeoutMs: 8_000 })
        .catch(() => ({ stdout: '', stderr: '', exitCode: 1 }))
      await rm(controlDirectory, { recursive: true, force: true })
      throw new CommandExecutionError(
        'Failed to allocate remote SSH hook port.',
        'ssh',
        forwardArgs,
        result.exitCode || 1,
        result.stderr || result.stdout
      )
    }
    this.forward = { controlDirectory, controlPath, localPort, remotePort }
    return remotePort
  }
}

export class ExecutionHostRegistry {
  private readonly hosts = new Map<string, ExecutionHost>()

  constructor(hosts: readonly ExecutionHost[] = [new LocalExecutionHost()]) {
    for (const host of hosts) this.register(host)
  }

  register(host: ExecutionHost): void {
    if (this.hosts.has(host.id)) {
      throw new AgentMuxError(`Execution host already registered: ${host.id}`, 'DUPLICATE_HOST')
    }
    this.hosts.set(host.id, host)
  }

  async replace(host: ExecutionHost): Promise<void> {
    const previous = this.hosts.get(host.id)
    if (previous && previous !== host) await previous.dispose()
    this.hosts.set(host.id, host)
  }

  get(id: string): ExecutionHost {
    const host = this.hosts.get(id)
    if (!host) throw new AgentMuxError(`Unknown execution host: ${id}`, 'UNKNOWN_HOST')
    return host
  }

  list(): ExecutionHost[] {
    return [...this.hosts.values()]
  }

  async dispose(): Promise<void> {
    await Promise.all(this.list().map(async (host) => await host.dispose()))
    this.hosts.clear()
  }
}
