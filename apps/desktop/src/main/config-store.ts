import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize as normalizeLocalPath, posix } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { BUILT_IN_AGENT_PROVIDERS } from '@agentmux/core'
import type { AppConfig, WorkspaceRecord } from '../shared/contracts.js'
import { SCRATCH_WORKSPACE_ID, SCRATCH_WORKSPACE_NAME } from '../shared/contracts.js'

const hostSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.literal('local'), kind: z.literal('local'), label: z.string().min(1) }).strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('ssh'),
      label: z.string().min(1),
      hostname: z.string().min(1),
      user: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      identityFile: z.string().min(1).optional()
    })
    .strict()
])

const providerIds = new Set(BUILT_IN_AGENT_PROVIDERS.map((provider) => provider.id))
const executorIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)

const executorSchema = z
  .object({
    label: z.string().min(1),
    providerId: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    injectAgentMuxGuide: z.boolean()
  })
  .strict()

const workspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    hostId: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(['folder', 'worktree']),
    repoPath: z.string().min(1).optional(),
    branch: z.string().min(1).optional()
  })
  .strict()

const configSchema = z
  .object({
    version: z.literal(7),
    hosts: z.array(hostSchema),
    executors: z.record(executorIdSchema, executorSchema),
    workspaces: z.array(workspaceSchema),
    appearance: z.object({ terminalTheme: z.enum(['graphite', 'catppuccin-mocha']) }).strict(),
    browser: z.object({
      toolbar: z.object({
        selectElement: z.boolean(),
        screenshot: z.boolean(),
        devTools: z.boolean(),
        viewport: z.boolean(),
        more: z.boolean()
      }).strict()
    }).strict()
  })
  .strict()
  .superRefine((config, context) => {
    const hostIds = new Set(config.hosts.map((host) => host.id))
    const hostsById = new Map(config.hosts.map((host) => [host.id, host]))
    if (hostIds.size !== config.hosts.length) {
      context.addIssue({ code: 'custom', path: ['hosts'], message: 'Host ids must be unique' })
    }
    if (!hostIds.has('local')) {
      context.addIssue({ code: 'custom', path: ['hosts'], message: 'Local host is required' })
    }
    for (const [executorId, executor] of Object.entries(config.executors)) {
      if (!providerIds.has(executor.providerId)) {
        context.addIssue({
          code: 'custom',
          path: ['executors', executorId, 'providerId'],
          message: `Unknown Agent Provider: ${executor.providerId}`
        })
      }
    }
    const workspaceIds = new Set<string>()
    const workspaceLocations = new Set<string>()
    for (const [index, workspace] of config.workspaces.entries()) {
      if (workspaceIds.has(workspace.id)) {
        context.addIssue({
          code: 'custom',
          path: ['workspaces', index, 'id'],
          message: `Workspace id must be unique: ${workspace.id}`
        })
      }
      workspaceIds.add(workspace.id)
      if (!hostIds.has(workspace.hostId)) {
        context.addIssue({
          code: 'custom',
          path: ['workspaces', index, 'hostId'],
          message: `Unknown workspace host: ${workspace.hostId}`
        })
        continue
      }
      const host = hostsById.get(workspace.hostId)!
      const normalizedPath = host.kind === 'local'
        ? normalizeLocalPath(join(workspace.path, '.'))
        : posix.normalize(posix.join(workspace.path, '.'))
      const location = `${workspace.hostId}\0${normalizedPath}`
      if (workspaceLocations.has(location)) {
        context.addIssue({
          code: 'custom',
          path: ['workspaces', index, 'path'],
          message: `Workspace path must be unique on ${workspace.hostId}: ${normalizedPath}`
        })
      }
      workspaceLocations.add(location)
    }
  })

const DEFAULT_CONFIG: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true },
    claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true },
    traex: { label: 'TraeX', providerId: 'traex', command: 'traex', args: [], env: {}, injectAgentMuxGuide: true },
    hermes: { label: 'Hermes', providerId: 'hermes', command: 'hermes', args: [], env: {}, injectAgentMuxGuide: true },
    pi: { label: 'Pi', providerId: 'pi', command: 'pi', args: [], env: {}, injectAgentMuxGuide: true },
    grok: {
      label: 'Grok',
      providerId: 'grok',
      command: 'grok',
      args: ['--permission-mode', 'bypassPermissions'],
      env: {},
      injectAgentMuxGuide: true
    },
    gemini: { label: 'Gemini', providerId: 'gemini', command: 'gemini', args: [], env: {}, injectAgentMuxGuide: true },
    antigravity: { label: 'Antigravity', providerId: 'antigravity', command: 'agy', args: [], env: {}, injectAgentMuxGuide: true },
    cursor: { label: 'Cursor', providerId: 'cursor', command: 'cursor-agent', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: {
    toolbar: {
      selectElement: true,
      screenshot: true,
      devTools: true,
      viewport: true,
      more: true
    }
  }
}

/**
 * Dedicated on-disk directory that backs the "no project" scratch workspace. A hidden
 * subdirectory of home keeps it out of the way (vs. exposing the whole home to the file
 * explorer) while giving terminals/agents a real, stable cwd.
 */
const SCRATCH_BACKING_PATH = join(app.getPath('home'), '.agentmux', 'scratch')

function normalizedLocalPath(path: string): string {
  return normalizeLocalPath(join(path, '.'))
}

function scratchWorkspace(): WorkspaceRecord {
  return {
    id: SCRATCH_WORKSPACE_ID,
    name: SCRATCH_WORKSPACE_NAME,
    hostId: 'local',
    path: SCRATCH_BACKING_PATH,
    kind: 'folder'
  }
}

/**
 * Ensure the always-present scratch workspace is in the config. Guarded by both the
 * reserved id and the backing path so we never violate the unique-id / unique-path
 * refinements (e.g. if a user manually registered the same folder).
 */
function withScratchWorkspace(config: AppConfig): { config: AppConfig; added: boolean } {
  const scratchLocation = normalizedLocalPath(SCRATCH_BACKING_PATH)
  const present = config.workspaces.some(
    (workspace) =>
      workspace.id === SCRATCH_WORKSPACE_ID ||
      (workspace.hostId === 'local' && normalizedLocalPath(workspace.path) === scratchLocation)
  )
  if (present) return { config, added: false }
  return {
    config: { ...config, workspaces: [...config.workspaces, scratchWorkspace()] },
    added: true
  }
}

export class ConfigStore {
  private saveTail: Promise<void> = Promise.resolve()

  constructor(private readonly path = join(app.getPath('userData'), 'agentmux.config.json')) {}

  async get(): Promise<AppConfig> {
    await mkdir(SCRATCH_BACKING_PATH, { recursive: true })
    let loaded: AppConfig
    let persist = false
    try {
      const rawText = await readFile(this.path, 'utf8')
      const rawJson = JSON.parse(rawText)
      const isOlderVersion =
        typeof rawJson === 'object' &&
        rawJson !== null &&
        'version' in rawJson &&
        typeof (rawJson as { version: unknown }).version === 'number' &&
        Number.isInteger((rawJson as { version: number }).version) &&
        (rawJson as { version: number }).version > 0 &&
        (rawJson as { version: number }).version < 7
      if (isOlderVersion) {
        await rm(this.path, { force: true })
        loaded = structuredClone(DEFAULT_CONFIG)
        persist = true
      } else {
        loaded = configSchema.parse(rawJson) as AppConfig
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      loaded = structuredClone(DEFAULT_CONFIG)
      persist = true
    }
    const scratch = withScratchWorkspace(loaded)
    if (scratch.added) persist = true
    if (persist) return await this.save(scratch.config)
    return scratch.config
  }

  async save(value: AppConfig): Promise<AppConfig> {
    const config = configSchema.parse(value) as AppConfig
    let saved!: AppConfig
    const operation = this.saveTail.catch(() => {}).then(async () => {
      let current: AppConfig | null = null
      try {
        current = configSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) as AppConfig
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      for (const [executorId, executor] of Object.entries(current?.executors ?? {})) {
        const next = config.executors[executorId]
        if (next && next.providerId !== executor.providerId) {
          throw new Error(
            `Agent Executor ${executorId} is already bound to Provider ${executor.providerId}. ` +
            'Create a new Executor to choose another Provider.'
          )
        }
      }
      await mkdir(dirname(this.path), { recursive: true })
      const tempPath = `${this.path}.${process.pid}.tmp`
      await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
      await rename(tempPath, this.path)
      saved = structuredClone(config)
    })
    this.saveTail = operation.then(() => {}, () => {})
    await operation
    return saved
  }
}
