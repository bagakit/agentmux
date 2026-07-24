import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, normalize as normalizeLocalPath, posix } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import type { AppConfig } from '../shared/contracts.js'

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
      identityFile: z.string().min(1).optional(),
      runtime: z.object({
        buildIdentity: z.string().min(1),
        remoteNodePath: z.string().min(1),
        remoteEntrypointPath: z.string().startsWith('/'),
        remoteEndpointPath: z.string().startsWith('/')
      }).strict()
    })
    .strict()
])

const agentSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string())
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
    version: z.literal(3),
    hosts: z.array(hostSchema),
    agents: z
      .object({
        codex: agentSchema,
        claude: agentSchema,
        traex: agentSchema,
        hermes: agentSchema,
        pi: agentSchema
      })
      .strict(),
    workspaces: z.array(workspaceSchema)
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
  version: 3,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  agents: {
    codex: { command: 'codex', args: [], env: {} },
    claude: { command: 'claude', args: [], env: {} },
    traex: { command: 'traex', args: [], env: {} },
    hermes: { command: 'hermes', args: [], env: {} },
    pi: { command: 'pi', args: [], env: {} }
  },
  workspaces: []
}

export class ConfigStore {
  constructor(private readonly path = join(app.getPath('userData'), 'agentmux.config.json')) {}

  async get(): Promise<AppConfig> {
    try {
      return configSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) as AppConfig
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.save(DEFAULT_CONFIG)
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  async save(value: AppConfig): Promise<AppConfig> {
    const config = configSchema.parse(value) as AppConfig
    await mkdir(dirname(this.path), { recursive: true })
    const tempPath = `${this.path}.${process.pid}.tmp`
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    await rename(tempPath, this.path)
    return structuredClone(config)
  }
}
