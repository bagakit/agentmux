import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { ConfigStore } from '../src/main/config-store.js'

// Project Rail 密度是 durable config（DEN「Project Rail 与 Topic 行密度」：重启后仍是用户选的那一档，
// 缺席即默认档、不回写）。这条钉住存储层的三件事：
//   1. 合法档位往返落盘；
//   2. 未知字符串被拒（枚举而非裸 string——档位不许被拼错成一个静默生效的值）；
//   3. 缺席原样通过、且**不被回写**（同 appLinkSchemes：缺席即默认，补盘只是白写）。

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const baseConfig: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

async function storeFixture(): Promise<{ store: ConfigStore; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-rail-density-test-'))
  roots.push(root)
  const path = join(root, 'config.json')
  return { store: new ConfigStore(path), path }
}

describe('Project Rail density is a durable, validated preference', () => {
  it('persists a chosen tier and reads it back', async () => {
    const { store } = await storeFixture()
    const saved = await store.save({ ...baseConfig, projectRailDensity: 'compact' })
    expect(saved.projectRailDensity).toBe('compact')
    expect((await store.get()).projectRailDensity).toBe('compact')

    const dense = await store.save({ ...baseConfig, projectRailDensity: 'dense' })
    expect(dense.projectRailDensity).toBe('dense')
    expect((await store.get()).projectRailDensity).toBe('dense')
  })

  it('rejects an unknown density string rather than letting a typo silently take effect', async () => {
    // 枚举而非裸 string 的判据：把 z.enum(PROJECT_RAIL_DENSITY_IDS) 换成 z.string() 时这条当场红。
    const { store } = await storeFixture()
    await expect(
      store.save({ ...baseConfig, projectRailDensity: 'cozy' } as never)
    ).rejects.toThrow()
  })

  it('leaves an absent density absent — the default tier is not written back', async () => {
    // 缺席即默认档，get() 不补盘（同 appLinkSchemes）。一个 `.default(...)` 或补齐分支会打红这条。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify(baseConfig))
    expect('projectRailDensity' in baseConfig).toBe(false)

    const loaded = await store.get()
    expect(loaded.projectRailDensity).toBeUndefined()
    expect('projectRailDensity' in JSON.parse(await readFile(path, 'utf8'))).toBe(false)
  })
})
