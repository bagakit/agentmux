import { missingExecutableCause } from './executable-diagnostics.js'
import { mintObjectId } from './object-id.js'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import type { AgentCatalogEntry, AgentExecutorConfig } from './types.js'
import type {
  AgentMuxHostExecutorConfiguration, AgentMuxHostExecutorConfigureInput,
  AgentMuxHostExecutorDescriptor, AgentMuxHostExecutorInventory, AgentMuxResolvedHostExecutor, AgentMuxHostExecutorRemoveInput, AgentMuxHostExecutorRemoval
} from './executor-contract.js'

const SCHEMA = 'agentmux.host-executors.v1'
type Configurations = Record<string, AgentExecutorConfig>
type Registry = { executors: Configurations; registrationRevisions: Record<string, string>; validRegistrationMetadata: boolean }
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
  return { availability: 'missing', cause: missing ?? missingExecutableCause(config.command) }
}

/** Durable Executor configurations belong to the semantic Host that will run them. */
/** The semantic Host owner injects one instance per registry; its write tail is the sole writer. */
export class AgentMuxHostExecutorOwner {
  private tail: Promise<void> = Promise.resolve()
  private readonly launches = new Map<string, number>()

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(work)
    this.tail = operation.then(() => {}, () => {})
    return operation
  }

  /** A short local admission turn; the lease holds no queue across Provider/Native awaits. */
  async retainLaunch(executorId: string): Promise<() => void> {
    const id = text(executorId, 'Executor ID', 512)
    return await this.serialized(async () => {
      this.launches.set(id, (this.launches.get(id) ?? 0) + 1)
      let retained = true
      return () => { if (retained) { retained = false; const count = this.launches.get(id)! - 1; if (count) this.launches.set(id, count); else this.launches.delete(id) } }
    })
  }
  constructor(private readonly options: {
    path: string
    runtimeId: string
    catalog(): readonly AgentCatalogEntry[]
    environment?(): NodeJS.ProcessEnv
  }) {}

  private async read(): Promise<Registry> {
    let contents: string
    try {
      const metadata = await stat(this.options.path)
      if (!metadata.isFile()) throw new Error('Executor configuration file is not a regular file.')
      contents = await readFile(this.options.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { executors: {}, registrationRevisions: {}, validRegistrationMetadata: true }
      const failure = new AgentMuxError('The original Host Executor configuration could not be read. Its file and existing Agents are retained.', 'EXECUTOR_CONFIGURATION_UNAVAILABLE')
      Object.defineProperty(failure, 'cause', { value: error })
      throw failure
    }
    try {
      const state = record(JSON.parse(contents), ['schema', 'runtimeId', 'executors', 'registrationRevisions'])
      if (state.schema !== SCHEMA || state.runtimeId !== this.options.runtimeId) throw new Error('Executor configuration belongs to another semantic Host.')
      const values = record(state.executors)
      const executors = Object.fromEntries(Object.entries(values).map(([id, value]) => [text(id, 'Executor ID', 512), parseConfig(value)]))
      // Legacy observation is not a forged historic registration ACK. Reads never save.
      const documentDigest = createHash('sha256').update(contents).digest('hex')
      const legacy = (id: string) => 'legacy-observation:' + createHash('sha256').update(JSON.stringify([documentDigest, this.options.runtimeId, id])).digest('hex')
      let registrationRevisions: Record<string, string> = {}
      let validRegistrationMetadata = true
      if (state.registrationRevisions === undefined) registrationRevisions = Object.fromEntries(Object.keys(executors).map(id => [id, legacy(id)]))
      else {
        const metadata = state.registrationRevisions
        validRegistrationMetadata = !!metadata && typeof metadata === 'object' && !Array.isArray(metadata) &&
          Object.keys(metadata).every(id => Object.hasOwn(executors, id)) && Object.keys(executors).every(id => {
            const token = (metadata as Record<string, unknown>)[id]
            return typeof token === 'string' && !!token.trim() && !/[\0\r\n]/u.test(token) && token.length <= 512
          })
        if (validRegistrationMetadata) registrationRevisions = { ...metadata as Record<string, string> }
      }
      return { executors, registrationRevisions, validRegistrationMetadata }
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

  private descriptor(executorId: string, config: AgentExecutorConfig, source: AgentMuxHostExecutorDescriptor['source'], registrationRevision?: string): AgentMuxHostExecutorDescriptor {
    return { executorId, label: config.label, providerId: config.providerId, command: config.command,
      source, configRevision: revision(config), ...(registrationRevision ? { registrationRevision } : {}), availability: 'unknown' }
  }

  private async observe(config: AgentExecutorConfig): Promise<Probe> {
    if (!this.options.catalog().some(provider => provider.id === config.providerId)) return {
      availability: 'check-failed', cause: { code: 'UNKNOWN_PROVIDER', message: 'This target Host does not currently support the registered Executor Provider. Its configuration and existing Agents are retained.' }
    }
    return await probeCommand(config, this.options.environment?.() ?? process.env)
  }

  async list(input: { refresh?: boolean; executorId?: string } = {}): Promise<AgentMuxHostExecutorInventory> {
    const state = await this.read(), entries = this.entries(state.executors)
    const id = input.executorId === undefined ? undefined : text(input.executorId, 'Executor ID', 512)
    const declarations = id === undefined ? undefined : new Map(this.options.catalog().map(provider => [provider.id, provider.launchOptions]))
    const selected = id === undefined ? [...entries] : entries.has(id) ? [[id, entries.get(id)!] as const] : []
    const executors = await Promise.all(selected.map(async ([id, { config, source }]) => ({
      ...this.descriptor(id, config, source, state.registrationRevisions[id]),
      ...(declarations?.has(config.providerId) ? { launchOptions: structuredClone(declarations.get(config.providerId)!) } : {}),
      ...(input.refresh ? await this.observe(config) : {})
    })))
    return { runtimeId: this.options.runtimeId, executors }
  }

  async resolve(executorId: string): Promise<AgentMuxResolvedHostExecutor> {
    const state = await this.read(), selected = this.entries(state.executors).get(text(executorId, 'Executor ID', 512))
    if (!selected) throw new AgentMuxError('The requested Executor is not registered on this target Host. Register its existing command or choose a discovered Executor.', 'HOST_EXECUTOR_NOT_FOUND')
    const { config, source } = selected
    const observation = await this.observe(config)
    return { config: structuredClone({ ...config, ...(observation.executable ? { command: observation.executable } : {}) }),
      descriptor: { ...this.descriptor(executorId, config, source, state.registrationRevisions[executorId]), ...observation } }
  }

  async configure(input: AgentMuxHostExecutorConfigureInput): Promise<AgentMuxHostExecutorConfiguration> {
    const executorId = text(input.executorId, 'Executor ID', 512), config = parseConfig(input.config)
    const expectedRevision = input.expectedRevision === undefined ? undefined : text(input.expectedRevision, 'Expected Executor revision', 512)
    return await this.serialized(async () => {
      const state = await this.read(), current = state.executors, selected = this.entries(current).get(executorId)
      if (!state.validRegistrationMetadata) throw new AgentMuxError('Original Executor registration metadata is unavailable. Restore its original file before changing it; existing configurations remain readable.', 'EXECUTOR_REGISTRATION_UNAVAILABLE')
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
      let registrationRevision = state.registrationRevisions[executorId]
      if (!Object.hasOwn(current, executorId) || currentRevision !== revision(config)) {
        registrationRevision = mintObjectId()
        const executors = { ...current, [executorId]: config }
        const contents = JSON.stringify({ schema: SCHEMA, runtimeId: this.options.runtimeId, executors, registrationRevisions: { ...state.registrationRevisions, [executorId]: registrationRevision } }) + '\n'
        await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
        await durableWriteFile(this.options.path, contents)
      }
      return { runtimeId: this.options.runtimeId, executor: this.descriptor(executorId, config, 'registered', registrationRevision) }
    })
  }

  /** Same publication turn as registration/admission. No Native/Provider work enters it. */
  async remove(input: AgentMuxHostExecutorRemoveInput, assertUnreferenced: () => Promise<void>): Promise<AgentMuxHostExecutorRemoval> {
    const executorId = text(input.executorId, 'Executor ID', 512)
    const expected = text(input.expectedRegistrationRevision, 'Expected registration revision', 512)
    return await this.serialized(async () => {
      const state = await this.read()
      if (!Object.hasOwn(state.executors, executorId)) throw new AgentMuxError('This Host has no registered override for that Executor. Its Provider default, if present, cannot be removed.', 'HOST_EXECUTOR_NOT_REGISTERED')
      if (!state.validRegistrationMetadata) throw new AgentMuxError('The original registration witness is unavailable. Restore its metadata before an explicit removal; existing configuration and Agents are retained.', 'EXECUTOR_REGISTRATION_UNAVAILABLE')
      if (state.registrationRevisions[executorId] !== expected) throw new AgentMuxError('The original registration changed. Discover its current registrationRevision before deciding a new removal.', 'EXECUTOR_REGISTRATION_CONFLICT')
      if (this.launches.has(executorId)) throw new AgentMuxError('An admitted launch still uses this Executor. Keep its registration and inspect the original creation before deciding a later removal.', 'EXECUTOR_REFERENCED')
      await assertUnreferenced()
      const { [executorId]: _config, ...executors } = state.executors
      const { [executorId]: _token, ...registrationRevisions } = state.registrationRevisions
      await durableWriteFile(this.options.path, JSON.stringify({ schema: SCHEMA, runtimeId: this.options.runtimeId, executors, registrationRevisions }) + '\n')
      const effective = this.entries(executors).get(executorId)
      return { runtimeId: this.options.runtimeId, executorId, removedRegistration: true, registrationRevision: expected,
        effectiveExecutor: effective ? this.descriptor(executorId, effective.config, effective.source) : null }
    })
  }
}
