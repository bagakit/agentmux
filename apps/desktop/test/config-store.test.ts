import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILT_IN_AGENT_PROVIDERS } from '@agentmux/core'
import {
  SCRATCH_WORKSPACE_ID,
  SCRATCH_WORKSPACE_NAME,
  type AppConfig,
  type WorkspaceRecord
} from '../src/shared/contracts.js'
import { DEFAULT_NOTIFICATION_MODE_ID } from '../src/shared/notification-presentation.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import type { RuntimeController, RuntimePreparation } from '../src/main/runtime-controller.js'
import { saveRuntimeConfig } from '../src/main/runtime-config-transaction.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

const baseConfig: AppConfig = {
  version: 7,
  hosts: [
    { id: 'local', kind: 'local', label: 'This Mac' },
    {
      id: 'remote',
      kind: 'ssh',
      label: 'Build box',
      hostname: 'build.example.test'
    }
  ],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true },
    claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'workspace-1',
    name: 'Project',
    hostId: 'local',
    path: '/projects/agentmux',
    kind: 'folder',
    ...overrides
  }
}

async function storeFixture(): Promise<{ store: ConfigStore; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-config-test-'))
  roots.push(root)
  const path = join(root, 'config.json')
  return { store: new ConfigStore(path), path }
}

describe('ConfigStore workspace identity', () => {
  it('resets retired config to current default without migration or fallback', async () => {
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: 4,
      hosts: [{
        id: 'remote',
        kind: 'ssh',
        label: 'Old host',
        hostname: 'old.example.test',
        daemon: {
          buildIdentity: 'old',
          remoteNodePath: 'node',
          remoteAgentMuxdPath: '/old/agentmuxd.js',
          remoteSocketPath: '/old/agentmuxd.sock'
        }
      }]
    }))

    const loaded = await store.get()
    expect(loaded.version).toBe(7)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 7 })
  })

  it('rejects future-version config strictly and retains the file', async () => {
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: 8
    }))

    await expect(store.get()).rejects.toThrow()
    const content = JSON.parse(await readFile(path, 'utf8'))
    expect(content.version).toBe(8)
  })

  it('rejects malformed-version config strictly and retains the file', async () => {
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: '7'
    }))

    await expect(store.get()).rejects.toThrow()
    const content = JSON.parse(await readFile(path, 'utf8'))
    expect(content.version).toBe('7')
  })

  it('rejects corrupted current-version config strictly', async () => {
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      version: 7,
      invalidField: true
    }))

    await expect(store.get()).rejects.toThrow()
  })

  it('rejects duplicate workspace ids without replacing the persisted config', async () => {
    const { store, path } = await storeFixture()
    const saved = { ...baseConfig, workspaces: [workspace()] }
    await store.save(saved)
    const persisted = await readFile(path, 'utf8')

    await expect(store.save({
      ...baseConfig,
      workspaces: [
        workspace(),
        workspace({ name: 'Other', path: '/projects/other' })
      ]
    })).rejects.toThrow('Workspace id must be unique')

    expect(await readFile(path, 'utf8')).toBe(persisted)
    expect(await store.get()).toEqual({
      ...saved,
      workspaces: [
        ...saved.workspaces,
        {
          id: SCRATCH_WORKSPACE_ID,
          name: SCRATCH_WORKSPACE_NAME,
          hostId: 'local',
          path: join(tmpdir(), '.agentmux', 'scratch'),
          kind: 'folder'
        }
      ],
      // get() back-fills the notification default for a config saved before the field existed.
      notifications: { mode: DEFAULT_NOTIFICATION_MODE_ID }
    })
  })

  it('persists only a known terminal palette as desktop appearance truth', async () => {
    const { store, path } = await storeFixture()
    const saved = await store.save({
      ...baseConfig,
      appearance: { terminalTheme: 'catppuccin-mocha' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
    })

    expect(saved.appearance).toEqual({ terminalTheme: 'catppuccin-mocha' })
    expect((await store.get()).appearance).toEqual({ terminalTheme: 'catppuccin-mocha' })
    expect(await readFile(path, 'utf8')).toContain('"terminalTheme": "catppuccin-mocha"')

    await expect(store.save({
      ...baseConfig,
      appearance: { terminalTheme: 'retired-theme' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
    } as never)).rejects.toThrow()
  })

  it('materializes the notification default when a stored config has no notifications field', async () => {
    // A config written before this field existed is valid on disk (optional field), but get() must
    // resolve a concrete default tier — never undefined, and never off — and persist it once.
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify(baseConfig))
    expect('notifications' in baseConfig).toBe(false)

    const loaded = await store.get()
    expect(loaded.notifications).toEqual({ mode: DEFAULT_NOTIFICATION_MODE_ID })
    // Back-filled defaults are persisted, so the resolved value is stable across restarts.
    expect(JSON.parse(await readFile(path, 'utf8')).notifications).toEqual({ mode: DEFAULT_NOTIFICATION_MODE_ID })
  })

  it('keeps a chosen notification mode and rejects an unknown one', async () => {
    const { store } = await storeFixture()
    const saved = await store.save({ ...baseConfig, notifications: { mode: 'until-acknowledged' } })
    expect(saved.notifications).toEqual({ mode: 'until-acknowledged' })
    expect((await store.get()).notifications).toEqual({ mode: 'until-acknowledged' })

    await expect(store.save({
      ...baseConfig,
      notifications: { mode: 'forever' }
    } as never)).rejects.toThrow()
  })

  it('persists Browser bar visibility as the only toolbar preference truth', async () => {
    const { store, path } = await storeFixture()
    const saved = await store.save({
      ...baseConfig,
      browser: {
        toolbar: {
          selectElement: false,
          screenshot: true,
          devTools: false,
          viewport: true,
          more: false
        }
      }
    })

    expect(saved.browser.toolbar).toEqual({
      selectElement: false,
      screenshot: true,
      devTools: false,
      viewport: true,
      more: false
    })
    expect((await store.get()).browser).toEqual(saved.browser)
    expect(await readFile(path, 'utf8')).not.toContain('openExternal')
  })

  it('rejects obsolete v6 config instead of adding a compatibility path', async () => {
    const { store } = await storeFixture()
    await expect(store.save({ ...baseConfig, version: 6 } as never)).rejects.toThrow()
  })

  it('persists the AgentMux guide setting per Executor', async () => {
    const { store } = await storeFixture()
    const saved = await store.save({
      ...baseConfig,
      executors: {
        ...baseConfig.executors,
        codex: { ...baseConfig.executors.codex!, injectAgentMuxGuide: false }
      }
    })

    expect(saved.executors.codex?.injectAgentMuxGuide).toBe(false)
    expect((await store.get()).executors.codex?.injectAgentMuxGuide).toBe(false)
    expect((await store.get()).executors.claude?.injectAgentMuxGuide).toBe(true)
  })

  it('accepts many Executors backed by the same registered Provider', async () => {
    const { store } = await storeFixture()
    const executors = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `codex-${index + 1}`,
      { label: `Codex ${index + 1}`, providerId: 'codex', command: 'codex', args: [`--profile=${index + 1}`], env: {}, injectAgentMuxGuide: true }
    ]))

    await expect(store.save({ ...baseConfig, executors })).resolves.toMatchObject({ executors })
    await expect(store.get()).resolves.toMatchObject({ executors })
  })

  it('keeps a saved Executor bound to its Provider while allowing ordinary edits, deletion, and creation', async () => {
    const { store, path } = await storeFixture()
    await store.save(baseConfig)
    const edited = await store.save({
      ...baseConfig,
      executors: {
        codex: {
          ...baseConfig.executors.codex!,
          label: 'Review Codex',
          command: 'codex-review',
          args: ['--full-auto'],
          env: { PROFILE: 'review' }
        },
        review: {
          label: 'Claude review',
          providerId: 'claude',
          command: 'claude',
          args: ['--resume'],
          env: {},
          injectAgentMuxGuide: true
        }
      }
    })
    expect(edited.executors).toMatchObject({
      codex: { providerId: 'codex', command: 'codex-review' },
      review: { providerId: 'claude' }
    })
    const persisted = await readFile(path, 'utf8')

    await expect(store.save({
      ...edited,
      executors: {
        ...edited.executors,
        codex: { ...edited.executors.codex!, providerId: 'claude' }
      }
    })).rejects.toThrow('Agent Executor codex is already bound to Provider codex')
    expect(await readFile(path, 'utf8')).toBe(persisted)
  })

  it('serializes concurrent saves before enforcing the persisted Executor identity', async () => {
    const { store, path } = await storeFixture()
    const initial = store.save(baseConfig)
    const rebound = store.save({
      ...baseConfig,
      executors: {
        ...baseConfig.executors,
        codex: { ...baseConfig.executors.codex!, providerId: 'claude' }
      }
    })

    await expect(initial).resolves.toEqual(baseConfig)
    await expect(rebound).rejects.toThrow('Agent Executor codex is already bound to Provider codex')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(baseConfig)
  })

  it('rejects Provider rebinding through the Runtime config transaction without committing it', async () => {
    const { store, path } = await storeFixture()
    await store.save(baseConfig)
    const persisted = await readFile(path, 'utf8')
    const preparation = {
      hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: []
    } as RuntimePreparation
    const runtime = {
      prepare: vi.fn(async () => preparation),
      commit: vi.fn(),
      discard: vi.fn(async () => {})
    } as unknown as RuntimeController
    const rebound: AppConfig = {
      ...baseConfig,
      executors: {
        ...baseConfig.executors,
        codex: { ...baseConfig.executors.codex!, providerId: 'claude' }
      }
    }

    await expect(saveRuntimeConfig({
      runtime,
      configWriter: store,
      next: rebound
    })).rejects.toThrow('Agent Executor codex is already bound to Provider codex')
    expect(runtime.prepare).toHaveBeenCalledWith(rebound)
    expect(runtime.discard).toHaveBeenCalledWith(preparation)
    expect(runtime.commit).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(persisted)
  })

  it('rejects an Executor that does not select a registered Provider', async () => {
    const { store } = await storeFixture()
    await expect(store.save({
      ...baseConfig,
      executors: {
        custom: {
          label: 'Custom',
          providerId: 'missing-provider',
          command: 'custom',
          args: [],
          env: {},
          injectAgentMuxGuide: true
        }
      }
    })).rejects.toThrow('Unknown Agent Provider')
  })

  it('uses host-specific normalized paths as physical workspace identity', async () => {
    const { store } = await storeFixture()

    await expect(store.save({
      ...baseConfig,
      workspaces: [
        workspace(),
        workspace({ id: 'workspace-2', path: '/projects/agentmux/' })
      ]
    })).rejects.toThrow('Workspace path must be unique on local')

    await expect(store.save({
      ...baseConfig,
      workspaces: [
        workspace({ hostId: 'remote', path: '/srv/agentmux' }),
        workspace({ id: 'workspace-2', hostId: 'remote', path: '/srv/tools/../agentmux/' })
      ]
    })).rejects.toThrow('Workspace path must be unique on remote')

    await expect(store.save({
      ...baseConfig,
      workspaces: [
        workspace({ path: '/shared/project' }),
        workspace({ id: 'workspace-2', hostId: 'remote', path: '/shared/project' })
      ]
    })).resolves.toMatchObject({ workspaces: [{ hostId: 'local' }, { hostId: 'remote' }] })
  })
})

describe('DEFAULT_CONFIG built-in Provider coverage', () => {
  // 期望值永远从 Core 现取，绝不在测试里手抄一份 id 清单——手抄的清单会和它要守的东西一起漂。
  // 这道门守的正是本次修复的缺陷：Core 新增/改名一个 built-in Provider 而默认表没跟上时，新建 Tab
  // 界面（config.executors → configuredExecutors）会静默漏掉那家，此前 kimi/droid/copilot 就这样缺席。
  it('ships one default Executor for every built-in Provider Core declares', () => {
    const builtInIds = new Set(BUILT_IN_AGENT_PROVIDERS.map((provider) => provider.id))
    const coveredProviderIds = new Set(
      Object.values(DEFAULT_CONFIG.executors).map((executor) => executor.providerId)
    )
    // 覆盖：每个 Core built-in id 都必须有一条默认 Executor 指向它。删掉任意一家会让这里变红。
    const missing = [...builtInIds].filter((id) => !coveredProviderIds.has(id))
    expect(missing).toEqual([])
    // 反向：默认表里绝不出现 Core 不认识的 providerId（否则 schema 的 superRefine 会在运行时拒绝整份
    // 默认配置）。把某家的 providerId 改成 Core 不认识的值会让这里变红。
    const unknown = [...coveredProviderIds].filter((id) => !builtInIds.has(id))
    expect(unknown).toEqual([])
  })

  it("binds every default Executor's command and label to its Provider catalog", () => {
    // command/label 是 Core catalog 的 executable/label（SSOT）。变异任意一家的 command 或 label
    // 会让对应断言变红——默认表不得从 catalog 漂走。
    const catalogById = new Map(
      BUILT_IN_AGENT_PROVIDERS.map((provider) => [provider.id, provider.catalog])
    )
    for (const executor of Object.values(DEFAULT_CONFIG.executors)) {
      const catalogEntry = catalogById.get(executor.providerId)
      expect(catalogEntry).toBeDefined()
      expect(executor.command).toBe(catalogEntry!.executable)
      expect(executor.label).toBe(catalogEntry!.label)
    }
  })
})
