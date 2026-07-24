import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
      identityFile: z.string().min(1).optional()
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
    version: z.literal(1),
    hosts: z.array(hostSchema),
    agents: z.record(z.string(), agentSchema),
    workspaces: z.array(workspaceSchema)
  })
  .strict()

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  agents: {
    codex: { command: 'codex', args: [], env: {} },
    claude: { command: 'claude', args: [], env: {} },
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
