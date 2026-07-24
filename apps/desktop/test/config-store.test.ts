import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { ConfigStore } from '../src/main/config-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

const baseConfig: AppConfig = {
  version: 3,
  hosts: [
    { id: 'local', kind: 'local', label: 'This Mac' },
    {
      id: 'remote',
      kind: 'ssh',
      label: 'Build box',
      hostname: 'build.example.test'
    }
  ],
  agents: {
    codex: { command: 'codex', args: [], env: {} },
    claude: { command: 'claude', args: [], env: {} },
    traex: { command: 'traex', args: [], env: {} },
    hermes: { command: 'hermes', args: [], env: {} },
    pi: { command: 'pi', args: [], env: {} }
  },
  workspaces: []
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
  it('rejects retired v2 daemon config without migration or fallback', async () => {
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: 2,
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
    expect(await readFile(path, 'utf8')).toContain('"version":2')
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
    expect(await store.get()).toEqual(saved)
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
