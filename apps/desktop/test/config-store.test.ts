import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SCRATCH_WORKSPACE_ID,
  SCRATCH_WORKSPACE_NAME,
  type AppConfig,
  type WorkspaceRecord
} from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { ConfigStore } from '../src/main/config-store.js'
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
  it('rejects retired config without migration or fallback', async () => {
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

    await expect(store.get()).rejects.toBeInstanceOf(Error)
    expect(await readFile(path, 'utf8')).toContain('"version":4')
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
      ]
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
