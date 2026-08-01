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

// 版本号从 DEFAULT_CONFIG 现取。手抄一个字面量会在下次 bump 时让整份 fixture 被 schema 拒绝，
// 而那次失败读起来像"存储坏了"而不是"fixture 没跟上"——实测这一版 bump 就打红了 8 条。
const baseConfig: AppConfig = {
  version: DEFAULT_CONFIG.version,
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
  // ── 版本升级不得销毁用户创作数据 ────────────────────────────────────────────────
  //
  // 这一族守的是一个已经发生过两次的事故：version 7→8、8→9 各清空了一次用户的项目列表。
  // 重置分支当时 `rm` 掉配置再加载 `DEFAULT_CONFIG`（其 `workspaces: []`），而重置对**任何**
  // 低于当前版本的配置都触发，所以它不是某一次 bump 的失误，是每次 bump 都会重演。
  //
  // 此前这里只有一条 `resets retired config to current default without migration or fallback`，
  // 它把「清空」断言成正确行为，且 fixture 是 `workspaces: []`——对丢失完全失明。那条已被下面
  // 几条取代：重置**派生**半边（executors/appearance/browser）仍是既定答案，重置**创作**半边不是。

  it('a version bump preserves every workspace the user registered', async () => {
    // 承重的一条。三个真实形状的项目 + 一个自定义 host，配置版本低一版。
    const { store, path } = await storeFixture()
    const registered: WorkspaceRecord[] = [
      workspace({ id: 'ws-a', name: 'Pageville', path: '/projects/pageville' }),
      workspace({ id: 'ws-b', name: 'Survivors', path: '/projects/survivors' }),
      workspace({ id: 'ws-c', name: 'Build box checkout', hostId: 'remote', path: '/srv/checkout' })
    ]
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: registered
    }))

    const loaded = await store.get()

    // 逐条按 id 比对，不是比数量：数量相等也可能是被换成了别的记录。
    for (const expected of registered) {
      expect(
        loaded.workspaces.find((candidate) => candidate.id === expected.id),
        `项目 ${expected.name} 在版本升级后消失了`
      ).toEqual(expected)
    }
    // 自定义 host 必须一起活下来——schema 的 superRefine 要求每个 workspace 的 host 在场，
    // 只留 workspace 不留 host 会产出一份存不回去的配置。
    expect(loaded.hosts.find((host) => host.id === 'remote')).toBeDefined()
    // 而且落盘了，不是只在内存里——否则下次启动再丢一次。
    const persisted = JSON.parse(await readFile(path, 'utf8')) as AppConfig
    expect(persisted.version).toBe(DEFAULT_CONFIG.version)
    expect(persisted.workspaces.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(registered.map((entry) => entry.id))
    )
  })

  it('a version bump still resets the derived half it is there to refresh', async () => {
    // 反向那一半：修复不能变成「什么都不重置」。executors 必须被刷成当前默认表——这正是
    // bump 存在的理由（v7 的 9 家配置要补齐后加入的几家），也是不做回填的那条论证仍然成立的地方。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [workspace({ id: 'ws-keep' })],
      executors: {
        codex: { ...baseConfig.executors.codex!, label: 'Stale Codex', command: 'stale' }
      },
      appearance: { terminalTheme: 'catppuccin-mocha' }
    }))

    const loaded = await store.get()

    expect(Object.keys(loaded.executors).sort()).toEqual(Object.keys(DEFAULT_CONFIG.executors).sort())
    expect(loaded.executors.codex).toEqual(DEFAULT_CONFIG.executors.codex)
    expect(loaded.appearance).toEqual(DEFAULT_CONFIG.appearance)
    // 同一次读取里创作的那半边留着——两半边的处置必须能同时被观察到，否则「全留」也能过。
    expect(loaded.workspaces.map((entry) => entry.id)).toContain('ws-keep')
  })

  it('salvages workspaces one record at a time, so one damaged entry costs one project', async () => {
    // 全有或全无的解析会让下一次「workspace 形状变了」的 bump 再清空一次全部项目——同一个 bug
    // 换个版本号重演。逐条判定的判据：一条坏记录在场时，其余的必须一条不少。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [
        workspace({ id: 'ws-ok-1', path: '/projects/one' }),
        // 未来形状：多一个当前 schema 不认识的字段（`.strict()` 会拒掉整条）。
        { ...workspace({ id: 'ws-future', path: '/projects/future' }), tags: ['x'] },
        workspace({ id: 'ws-ok-2', path: '/projects/two' })
      ]
    }))

    const loaded = await store.get()

    const ids = loaded.workspaces.map((entry) => entry.id)
    expect(ids, '坏记录旁边的好记录被一起丢掉了——salvage 不是逐条的').toContain('ws-ok-1')
    expect(ids).toContain('ws-ok-2')
    expect(ids, '当前 schema 拒绝的记录不能被留下，否则整份配置存不回去').not.toContain('ws-future')
  })

  it('refuses to launch rather than silently retire a config whose every project is unreadable', async () => {
    // salvage 覆盖不到的情形：形状变化让**每一条**都失效。此时「成功启动、列表为空」是不可逆的——
    // 下一次 save() 覆盖掉唯一的副本。响亮失败则可逆：磁盘上那份原封不动。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [
        { ...workspace({ id: 'ws-1', path: '/projects/one' }), shape: 'future' },
        { ...workspace({ id: 'ws-2', path: '/projects/two' }), shape: 'future' }
      ]
    })
    await writeFile(path, original)

    await expect(store.get()).rejects.toThrow(/2 project/)
    // 关键：文件必须还在，且还是原来那份。这是「响亮失败可恢复」的全部依据。
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('treats a config that genuinely had no projects as no projects, not as an error', async () => {
    // 上一条的边界：真的一个项目都没有（新装、或用户删空了）不能被当成损坏。判据是原始条数，
    // 不是解析后的条数——否则 `workspaces: []` 会让每个空配置启动失败。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({ ...baseConfig, version: DEFAULT_CONFIG.version - 1, workspaces: [] }))

    const loaded = await store.get()

    // 只剩 get() 自己补的 scratch 那条。
    expect(loaded.workspaces.map((entry) => entry.id)).toEqual([SCRATCH_WORKSPACE_ID])
  })

  it('back-fills the local host when a retired config damaged it, keeping workspaces resolvable', async () => {
    // local host 不是创作内容（默认表里永远有一份），所以它损坏时不该拖走依赖它的项目。
    // 这条替代了旧那条只验「带 daemon 的退役 host 形状能通过」的用例，并把结论收紧到项目存活。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [{
        id: 'local',
        kind: 'local',
        label: 'This Mac',
        daemon: { buildIdentity: 'old', remoteNodePath: 'node' }
      }],
      workspaces: [workspace({ id: 'ws-local', hostId: 'local', path: '/projects/one' })]
    }))

    const loaded = await store.get()

    expect(loaded.hosts.filter((host) => host.id === 'local')).toHaveLength(1)
    expect(loaded.workspaces.map((entry) => entry.id)).toContain('ws-local')
  })

  it('rejects future-version config strictly and retains the file', async () => {
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version + 1
    }))

    await expect(store.get()).rejects.toThrow()
    const content = JSON.parse(await readFile(path, 'utf8'))
    expect(content.version).toBe(DEFAULT_CONFIG.version + 1)
  })

  it('rejects malformed-version config strictly and retains the file', async () => {
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: String(DEFAULT_CONFIG.version)
    }))

    await expect(store.get()).rejects.toThrow()
    const content = JSON.parse(await readFile(path, 'utf8'))
    expect(content.version).toBe(String(DEFAULT_CONFIG.version))
  })

  it('rejects corrupted current-version config strictly', async () => {
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      version: DEFAULT_CONFIG.version,
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
    await expect(store.save({ ...baseConfig, version: DEFAULT_CONFIG.version - 2 } as never)).rejects.toThrow()
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

  // 上面两条只看**静态默认表**。它们对「磁盘上已有一份缺几家的旧配置」完全失明——那份配置走
  // `get()` 的 parse 分支原样返回，而 `executors` 是无数量约束的 record，于是「只有 9 家」合法通过，
  // 界面上照旧缺席。实测过这个假绿：补默认表而不动 version 时，这两条全绿而存量用户一家都没多。
  // 所以覆盖必须延伸到**加载路径**：默认表齐全只是必要条件，读出来齐全才是用户看到的东西。
  //
  // 锚点是**历史事实的字面量 7**，不是 `DEFAULT_CONFIG.version - 1`。用后者造样本会让期望值跟着
  // 被测对象一起漂：把 version 退回 7（正是那个缺陷世界）时，样本自动变成 6，照样被重置，测试
  // 照旧全绿——实测确认过这次假绿。缺陷的形状是「v7 的盘上配置 + 只有 9 家」，7 是那个已经发生过的
  // 事实，必须写死；它与当前版本的关系由下面第二条测试单独去守。
  const LEGACY_NINE_PROVIDER_VERSION = 7

  it('a v7 config holding only the original nine Providers must load with every Provider present', async () => {
    const { store, path } = await storeFixture()
    // 逐字复刻那份存量配置：v7、9 家、其余形状合法。三家后加入的 Provider 一个都没有。
    const ninePreExisting = [
      'codex', 'claude', 'traex', 'hermes', 'pi', 'grok', 'gemini', 'antigravity', 'cursor'
    ]
    const laterAdditions = BUILT_IN_AGENT_PROVIDERS
      .map((provider) => provider.id)
      .filter((id) => !ninePreExisting.includes(id))
    // 前提挡板：这条测试只在"确实有后加入的 Provider"时才有意义；若哪天九家就是全部，它必须显式变红
    // 而不是悄悄退化成一条恒真断言。
    expect(laterAdditions.length, 'v7 之后没有任何新 Provider，这条测试已无对象可守').toBeGreaterThan(0)

    const staleExecutors = Object.fromEntries(
      Object.entries(DEFAULT_CONFIG.executors).filter(([id]) => ninePreExisting.includes(id))
    )
    expect(Object.keys(staleExecutors)).toHaveLength(ninePreExisting.length)
    await writeFile(path, JSON.stringify({
      ...DEFAULT_CONFIG,
      version: LEGACY_NINE_PROVIDER_VERSION,
      executors: staleExecutors
    }))

    const loaded = await store.get()

    // 读出来必须覆盖 Core 声明的每一个 built-in Provider——包括那份磁盘配置里缺的三家。
    const loadedProviderIds = new Set(
      Object.values(loaded.executors).map((executor) => executor.providerId)
    )
    const missing = BUILT_IN_AGENT_PROVIDERS
      .map((provider) => provider.id)
      .filter((id) => !loadedProviderIds.has(id))
    expect(missing, '读出的配置缺 Provider：修复只到了默认表，没到存量用户手上').toEqual([])
    // 而且落盘了，不是只在内存里补齐——否则下次启动又缺。
    const persisted = JSON.parse(await readFile(path, 'utf8')) as AppConfig
    expect(new Set(Object.values(persisted.executors).map((executor) => executor.providerId)))
      .toEqual(loadedProviderIds)
  })

  it('the current version must be past the nine-Provider era, or that reset never triggers', async () => {
    // 上一条钉的是「v7 + 9 家要被重置」。它成立的前提是当前版本**高于** 7——否则那份 v7 样本就是
    // 「当前版本」，走 parse 原样返回，缺的三家永远补不上。这条把那个前提单独写出来，于是「补了默认表
    // 却忘了 bump version」会在这里显式变红，而不是让上一条悄悄失去意义。
    expect(DEFAULT_CONFIG.version).toBeGreaterThan(LEGACY_NINE_PROVIDER_VERSION)
  })

  it('keeps the version literal, the default and the reset threshold in one source', async () => {
    // 这个数字有五处消费者（contracts 的 AppConfig.version 类型、schema 的 z.literal、
    // DEFAULT_CONFIG.version、get() 的重置阈值、renderer 那份预览 mock），此前各写一份，必须联动。
    // 漏改任一处的后果各不相同且都很安静：漏改 schema → 默认配置被自己的校验拒绝；漏改阈值 → 旧配置
    // 带着过时形状一路通过 parse，正是本次要修的那个缺陷；漏改类型 → **2058 条测试全绿**，因为
    // vitest 只转译不查类型，只有 tsc --noEmit 会报，而且它是逐个挖的（修好一处才暴露下一处）。
    // 所以现在唯一真源在 contracts，而守这条的是 tsc，不是这个文件。
    //
    // 这条按**行为**质询同源性中测试能覆盖的那一半：低一版必须被重置，等于当前版本必须原样通过。
    const { store: resetStore, path: resetPath } = await storeFixture()
    await writeFile(resetPath, JSON.stringify({ ...baseConfig, version: DEFAULT_CONFIG.version - 1 }))
    expect((await resetStore.get()).version).toBe(DEFAULT_CONFIG.version)

    // 等于当前版本：不重置，用户自己的内容留着（这里用一个非默认 label 当指纹）。
    const { store: keepStore, path: keepPath } = await storeFixture()
    await writeFile(keepPath, JSON.stringify({
      ...baseConfig,
      executors: {
        ...baseConfig.executors,
        claude: { ...baseConfig.executors.claude!, label: 'My Claude' }
      }
    }))
    const kept = await keepStore.get()
    expect(kept.version).toBe(DEFAULT_CONFIG.version)
    expect(kept.executors.claude!.label, '当前版本的配置不该被重置，用户改的 label 必须留着')
      .toBe('My Claude')
  })
})
