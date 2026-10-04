import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import type { AgentCatalogEntry, AgentExecutorConfig } from './types.js'
import type {
  AgentMuxHostExecutorConfiguration, AgentMuxHostExecutorConfigureInput,
  AgentMuxHostExecutorDescriptor, AgentMuxHostExecutorInventory, AgentMuxResolvedHostExecutor
} from './executor-contract.js'

const SCHEMA = 'agentmux.host-executors.v1'
type Configurations = Record<string, AgentExecutorConfig>
type Probe = Pick<AgentMuxHostExecutorDescriptor, 'availability' | 'executable' | 'cause'>

function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    fields && Object.keys(value).some(key => !fields.includes(key))) {
    throw new AgentMuxError('Executor configuration has an invalid structure.', 'INVALID_EXECUTOR_CONFIGURATION')
  }
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value) || Buffer.byteLength(value) > max) {
    throw new AgentMuxError(`${label} is invalid.`, 'INVALID_EXECUTOR_CONFIGURATION')
  }
  return value
}
function parseConfig(value: unknown): AgentExecutorConfig {
  const input = record(value, ['label', 'providerId', 'command', 'args', 'env', 'injectAgentMuxGuide'])
  const command = text(input.command, 'Executor command').trim()
  if (!isAbsolute(command) && command.includes('/')) {
    throw new AgentMuxError('Executor command must be an absolute path or a command name on the target Host PATH. Register the wrapper with its absolute path.', 'INVALID_EXECUTOR_CONFIGURATION')
  }
  if (!Array.isArray(input.args) || input.args.length > 256 ||
    input.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 16 * 1024)) {
    throw new AgentMuxError('Executor arguments are invalid.', 'INVALID_EXECUTOR_CONFIGURATION')
  }
  const environment = record(input.env)
  if (Object.keys(environment).length > 256 || Object.entries(environment).some(([key, value]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 16 * 1024)) {
    throw new AgentMuxError('Executor environment is invalid.', 'INVALID_EXECUTOR_CONFIGURATION')
  }
  if (typeof input.injectAgentMuxGuide !== 'boolean') {
    throw new AgentMuxError('Executor guide setting is invalid.', 'INVALID_EXECUTOR_CONFIGURATION')
  }
  return { label: text(input.label, 'Executor label'), providerId: text(input.providerId, 'Executor Provider'), command,
    args: [...input.args] as string[], env: { ...environment } as Record<string, string>, injectAgentMuxGuide: input.injectAgentMuxGuide }
}
function revision(config: AgentExecutorConfig): string {
  return createHash('sha256').update(JSON.stringify({ ...config,
    env: Object.fromEntries(Object.entries(config.env).sort(([a], [b]) => a.localeCompare(b))) })).digest('hex')
}

/** One target-Host command resolver for discovery and admitted launches. It never executes a program. */
async function probeCommand(config: AgentExecutorConfig, environment: NodeJS.ProcessEnv): Promise<Probe> {
  const searchPath = config.env.PATH ?? environment.PATH
  const paths = isAbsolute(config.command) ? [config.command]
    : searchPath === undefined ? [] : searchPath.split(delimiter).map(directory => join(directory, config.command))
  if (!paths.length) return { availability: 'check-failed', cause: {
    code: 'EXECUTABLE_SEARCH_UNAVAILABLE', message: 'The target Host has no PATH candidates for this Executor. Restore its environment and refresh.'
  } }
  let unknown: Probe['cause'], missing: Probe['cause'], relative: Probe['cause']
  for (const path of paths) {
    // A relative PATH entry resolves against the eventual working directory. An inventory
    // has no launch directory, so do not guess using the semantic owner's process cwd.
    if (!isAbsolute(path)) {
      relative ??= { code: 'EXECUTABLE_WORKSPACE_REQUIRED', message: 'The target Executor PATH contains a relative candidate. Configure absolute PATH entries to check it independently of the launch workspace.' }
      continue
    }
    try {
      const metadata = await stat(path)
      if (!metadata.isFile()) {
        missing ??= { code: 'EXECUTABLE_NOT_FILE', message: `${path} is not a regular executable file.` }
        continue
      }
      await access(path, constants.X_OK)
      // An earlier relative candidate could select a different program in the launch cwd.
      // Keep that ambiguity instead of silently selecting a later absolute executable.
      if (relative) return { availability: 'check-failed', cause: relative }
      return { availability: 'available', executable: path }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'EXECUTABLE_CHECK_FAILED'
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unknown ??= {
        code, message: error instanceof Error ? error.message : 'The target executable check failed.'
      }
    }
  }
  if (relative || unknown) return { availability: 'check-failed', cause: (relative ?? unknown)! }
  return { availability: 'missing', ...(missing ? { cause: missing } : {}) }
}

/** Durable Executor configurations belong to the semantic Host that will run them. */
/** The semantic Host owner injects one instance per registry; its write tail is the sole writer. */
export class AgentMuxHostExecutorOwner {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly options: {
    path: string
    runtimeId: string
    catalog(): readonly AgentCatalogEntry[]
    environment?(): NodeJS.ProcessEnv
  }) {}

  private async read(): Promise<Configurations> {
    let contents: string
    try {
      const metadata = await stat(this.options.path)
      if (!metadata.isFile()) throw new Error('Executor configuration file is not a regular file.')
      contents = await readFile(this.options.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new AgentMuxError('The original Host Executor configuration could not be read. Its file and existing Agents are retained.', 'EXECUTOR_CONFIGURATION_UNAVAILABLE')
    }
    try {
      const state = record(JSON.parse(contents), ['schema', 'runtimeId', 'executors'])
      if (state.schema !== SCHEMA || state.runtimeId !== this.options.runtimeId) throw new Error('Executor configuration belongs to another semantic Host.')
      const values = record(state.executors)
      return Object.fromEntries(Object.entries(values).map(([id, value]) => [text(id, 'Executor ID', 512), parseConfig(value)]))
    } catch {
      throw new AgentMuxError('The original Host Executor configuration is invalid or belongs to another semantic Host. Restore the original file; existing Agents are retained.', 'EXECUTOR_CONFIGURATION_UNAVAILABLE')
    }
  }

  private entries(configurations: Configurations): Map<string, { config: AgentExecutorConfig; source: AgentMuxHostExecutorDescriptor['source'] }> {
    const entries = new Map(this.options.catalog().map(provider => [provider.id, {
      config: { label: provider.label, providerId: provider.id, command: provider.executable,
        args: [], env: {}, injectAgentMuxGuide: true } as AgentExecutorConfig,
      source: 'provider-default' as AgentMuxHostExecutorDescriptor['source']
    }]))
    for (const [id, config] of Object.entries(configurations)) entries.set(id, { config, source: 'registered' })
    return entries
  }

  private descriptor(executorId: string, config: AgentExecutorConfig, source: AgentMuxHostExecutorDescriptor['source']): AgentMuxHostExecutorDescriptor {
    return { executorId, label: config.label, providerId: config.providerId, command: config.command,
      source, configRevision: revision(config), availability: 'unknown' }
  }

  private async observe(config: AgentExecutorConfig): Promise<Probe> {
    if (!this.options.catalog().some(provider => provider.id === config.providerId)) return {
      availability: 'check-failed', cause: { code: 'UNKNOWN_PROVIDER', message: 'This target Host does not currently support the registered Executor Provider. Its configuration and existing Agents are retained.' }
    }
    return await probeCommand(config, this.options.environment?.() ?? process.env)
  }

  async list(input: { refresh?: boolean } = {}): Promise<AgentMuxHostExecutorInventory> {
    const entries = this.entries(await this.read())
    const executors = await Promise.all([...entries].map(async ([id, { config, source }]) => ({
      ...this.descriptor(id, config, source),
      ...(input.refresh ? await this.observe(config) : {})
    })))
    return { runtimeId: this.options.runtimeId, executors }
  }

  async resolve(executorId: string): Promise<AgentMuxResolvedHostExecutor> {
    const selected = this.entries(await this.read()).get(text(executorId, 'Executor ID', 512))
    if (!selected) throw new AgentMuxError('The requested Executor is not registered on this target Host. Register its existing command or choose a discovered Executor.', 'HOST_EXECUTOR_NOT_FOUND')
    const { config, source } = selected
    const observation = await this.observe(config)
    return { config: structuredClone({ ...config, ...(observation.executable ? { command: observation.executable } : {}) }),
      descriptor: { ...this.descriptor(executorId, config, source), ...observation } }
  }

  async configure(input: AgentMuxHostExecutorConfigureInput): Promise<AgentMuxHostExecutorConfiguration> {
    const executorId = text(input.executorId, 'Executor ID', 512), config = parseConfig(input.config)
    const expectedRevision = input.expectedRevision === undefined ? undefined : text(input.expectedRevision, 'Expected Executor revision', 512)
    const operation = this.tail.then(async () => {
      const current = await this.read(), selected = this.entries(current).get(executorId)
      if (!this.options.catalog().some(provider => provider.id === config.providerId)) {
        throw new AgentMuxError('Executor Provider is not supported by this target Host.', 'UNKNOWN_PROVIDER')
      }
      if (selected && selected.config.providerId !== config.providerId) {
        throw new AgentMuxError('Executor Provider identity is immutable. Register another Executor ID for a different Provider.', 'EXECUTOR_IDENTITY_IMMUTABLE')
      }
      const currentRevision = selected ? revision(selected.config) : undefined
      if (expectedRevision !== undefined && expectedRevision !== currentRevision ||
        expectedRevision === undefined && Object.hasOwn(current, executorId) && currentRevision !== revision(config)) {
        throw new AgentMuxError('Executor configuration changed. Read its current revision before replacing it.', 'EXECUTOR_CONFIGURATION_CONFLICT')
      }
      if (!Object.hasOwn(current, executorId) || currentRevision !== revision(config)) {
        const executors = { ...current, [executorId]: config }
        const contents = JSON.stringify({ schema: SCHEMA, runtimeId: this.options.runtimeId, executors }) + '\n'
        await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
        await durableWriteFile(this.options.path, contents)
      }
      return { runtimeId: this.options.runtimeId, executor: this.descriptor(executorId, config, 'registered') }
    })
    this.tail = operation.then(() => {}, () => {})
    return await operation
  }
}
