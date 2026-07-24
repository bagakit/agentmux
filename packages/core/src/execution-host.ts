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

export class SshExecutionHost implements ExecutionHost {
  readonly id: string
  readonly kind = 'ssh' as const
  readonly label: string
  readonly hostname: string
  readonly user: string | undefined
  readonly port: number | undefined
  readonly identityFile: string | undefined
  readonly extraArgs: readonly string[]

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
  }

  async run(_command: string, _args: readonly string[], _options: RunCommandOptions = {}): Promise<CommandResult> {
    throw new AgentMuxError(
      'Remote execution is unavailable until the ctxmux Remote contract is delivered.',
      'REMOTE_UNSUPPORTED'
    )
  }

  async exposeLoopbackPort(_localPort: number): Promise<number> {
    throw new AgentMuxError(
      'Remote hook forwarding is unavailable until the ctxmux Remote contract is delivered.',
      'REMOTE_UNSUPPORTED'
    )
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
