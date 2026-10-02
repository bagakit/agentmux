import { AgentMuxError } from './errors.js'
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

export class SshExecutionHost implements ExecutionHost {
  readonly id: string
  readonly kind = 'ssh' as const
  readonly label: string
  readonly hostname: string
  readonly user: string | undefined
  readonly port: number | undefined
  readonly identityFile: string | undefined
  readonly extraArgs: readonly string[]
  private readonly runner: ProcessRunner
  private readonly connectTimeoutSeconds: number

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
    this.label = options.label ?? options.hostname
    this.runner = options.runner ?? runProcess
    this.connectTimeoutSeconds = options.connectTimeoutSeconds ?? 10
    if (options.hostname.startsWith('-') || /[\0\r\n]/u.test(options.hostname) ||
        options.user && /[\0\r\n]/u.test(options.user) ||
        options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) ||
        !Number.isInteger(this.connectTimeoutSeconds) || this.connectTimeoutSeconds < 1) {
      throw new AgentMuxError('SSH destination or connection timeout is invalid.', 'INVALID_SSH_HOST')
    }
  }

  /** Transient workspace operations use system SSH; Agent Runs belong to the remote Runtime. */
  async run(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<CommandResult> {
    const quote = (value: string): string => {
      if (value.includes('\0')) throw new AgentMuxError('Remote command contains a NUL byte.', 'INVALID_COMMAND')
      return "'" + value.replaceAll("'", "'\\''") + "'"
    }
    if (!command) throw new AgentMuxError('Remote command is required.', 'INVALID_COMMAND')
    const unset: string[] = []
    const assignments: string[] = []
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new AgentMuxError('Remote environment name is invalid.', 'INVALID_COMMAND')
      if (value === undefined) unset.push('-u', key)
      else assignments.push(`${key}=${value}`)
    }
    // env options precede '--', assignments follow it, and every shell token is quoted independently.
    const remote = ['/usr/bin/env', ...unset, '--', ...assignments, command, ...args].map(quote).join(' ')
    const invocation = options.cwd === undefined ? `exec ${remote}` : `cd -- ${quote(options.cwd)} && exec ${remote}`
    const ssh = ['-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o',
      `ConnectTimeout=${this.connectTimeoutSeconds}`, ...this.extraArgs]
    if (this.port !== undefined) ssh.push('-p', String(this.port))
    if (this.identityFile) ssh.push('-i', this.identityFile)
    ssh.push('--', this.user ? `${this.user}@${this.hostname}` : this.hostname, invocation)
    const { cwd: _cwd, env: _env, ...transport } = options
    return await this.runner('ssh', ssh, transport)
  }

  async dispose(): Promise<void> {}
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

  replace(host: ExecutionHost): ExecutionHost | undefined {
    const previous = this.hosts.get(host.id)
    this.hosts.set(host.id, host)
    return previous === host ? undefined : previous
  }

  remove(id: string): ExecutionHost | undefined {
    const host = this.hosts.get(id)
    if (!host) return undefined
    this.hosts.delete(id)
    return host
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
