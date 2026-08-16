import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILT_IN_AGENT_PROVIDERS } from '@agentmux/core'
import {
  SCRATCH_WORKSPACE_ID,
  SCRATCH_WORKSPACE_NAME,
  type AppConfig,
  type WorkspaceRecord
} from '../src/shared/contracts.js'
import { DEFAULT_NOTIFICATION_MODE_ID, NOTIFICATION_TIERS } from '../src/shared/notification-presentation.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { authoredConfigCarryOver, ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
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
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
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

  it('a version bump resets the built-in Executor slice it is there to refresh', async () => {
    // 反向那一半：修复不能变成「什么都不重置」。内置 id 那一片必须被刷成当前默认表——这正是
    // bump 存在的理由（v7 的 9 家配置要补齐后加入的几家），也是「内置 id 的在场含糊」那条
    // 论证唯一成立的地方。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [workspace({ id: 'ws-keep' })],
      executors: {
        codex: { ...baseConfig.executors.codex!, label: 'Stale Codex', command: 'stale' }
      }
    }))

    const loaded = await store.get()

    expect(loaded.executors.codex).toEqual(DEFAULT_CONFIG.executors.codex)
    for (const executorId of Object.keys(DEFAULT_CONFIG.executors)) {
      expect(Object.keys(loaded.executors)).toContain(executorId)
    }
    // 同一次读取里创作的那半边留着——两半边的处置必须能同时被观察到，否则「全留」也能过。
    expect(loaded.workspaces.map((entry) => entry.id)).toContain('ws-keep')
  })

  it('a version bump keeps a custom Executor, whose id can never be a Provider the user deleted', async () => {
    // 这是对抗性 review 认出的第二轮同族缺陷。判据不是「authored vs derived」——自建 executor
    // 与 workspace 一样 authored——而是「这条记录的在场是否含糊」。设置面板铸的 id 形如
    // `<providerId>` 或 `<providerId>-N`，所以一个不在当前内置表里的 id 只可能是用户自己造的，
    // 绝不可能是「他删掉的某个 Provider」。含糊的只有撞上内置 id 的那一类，上一条守着它。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [workspace({ id: 'ws-1' })],
      executors: {
        // 撞内置 id：改过的字段随 bump 一起回默认（含糊那一类）。
        codex: { ...baseConfig.executors.codex!, label: 'Stale Codex', command: 'stale' },
        // 自建 id：必须逐字留下，args/env/label 一个不少。
        'claude-2': {
          label: 'Claude Reviewer',
          providerId: 'claude',
          command: 'claude',
          args: ['--permission-mode', 'plan'],
          env: { REVIEW: '1' },
          injectAgentMuxGuide: false
        }
      }
    }))

    const loaded = await store.get()

    expect(loaded.executors['claude-2']).toEqual({
      label: 'Claude Reviewer',
      providerId: 'claude',
      command: 'claude',
      args: ['--permission-mode', 'plan'],
      env: { REVIEW: '1' },
      injectAgentMuxGuide: false
    })
    // 两类处置必须在同一次读取里同时可观察，否则「全留」或「全清」都能过。
    expect(loaded.executors.codex).toEqual(DEFAULT_CONFIG.executors.codex)
  })

  it('a version bump keeps the theme, toolbar and notification mode the user chose', async () => {
    // 这三项也是 authored，只是带默认值。它们各是一个「总在场」的单值，不是成员会缺席的集合，
    // 所以在场同样不含糊。此前它们被误归进「derived」，于是每次 bump 静默复位。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [workspace({ id: 'ws-1' })],
      appearance: { terminalTheme: 'catppuccin-mocha' },
      browser: { toolbar: { selectElement: false, screenshot: true, devTools: false, viewport: true, saveBookmark: false, more: false } },
      notifications: { mode: NOTIFICATION_TIERS[NOTIFICATION_TIERS.length - 1]!.id }
    }))

    const loaded = await store.get()

    expect(loaded.appearance).toEqual({ terminalTheme: 'catppuccin-mocha' })
    expect(loaded.browser.toolbar.selectElement).toBe(false)
    expect(loaded.browser.toolbar.devTools).toBe(false)
    expect(loaded.browser.toolbar.screenshot).toBe(true)
    expect(loaded.notifications?.mode).toBe(NOTIFICATION_TIERS[NOTIFICATION_TIERS.length - 1]!.id)
    // 反向：这条断言必须能区分「真留下了」与「默认值恰好长这样」。
    expect(loaded.appearance).not.toEqual(DEFAULT_CONFIG.appearance)
    expect(loaded.browser).not.toEqual(DEFAULT_CONFIG.browser)
    expect(loaded.notifications).not.toEqual(DEFAULT_CONFIG.notifications)
  })

  it('defaults Agent browser automation to off and back-fills it as a concrete false on disk', async () => {
    // 授权位的缺省必须落成**具体的 false**，不是留一个 undefined 让每个读点自己兜底。
    // 留 undefined 的代价是判据有两种形状：任何一个新读点写成 `!== false` 或 `?? true` 就静默放行了。
    //
    // fixture 必须先把 scratch 与 notifications 两个上游 back-fill 都喂饱：它们各自也会置 persist，
    // 于是「落盘」这半边会搭它们的便车——把 `if (browserAutomation.added) persist = true` 整行删掉，
    // 文件照样被写，断言照样绿。喂饱之后，这次 get() 会写盘就只剩我这一个理由。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      workspaces: [{
        id: SCRATCH_WORKSPACE_ID,
        name: SCRATCH_WORKSPACE_NAME,
        hostId: 'local',
        path: join(tmpdir(), '.agentmux', 'scratch'),
        kind: 'folder'
      }],
      notifications: { mode: DEFAULT_NOTIFICATION_MODE_ID }
    }))

    const loaded = await store.get()
    expect(loaded.browser.agentAutomation, 'Agent 页面驱动默认必须是关的').toBe(false)

    // 补齐要真的写回磁盘——只在内存里补，下一个进程读到的还是 undefined。
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as typeof baseConfig & {
      browser: { agentAutomation?: boolean }
    }
    expect(onDisk.browser.agentAutomation, '补齐没落盘，下次冷启动又是 undefined').toBe(false)
  })

  it('keeps an authored Agent browser automation opt-in instead of resetting it to the default', async () => {
    // 反向那一半：上面那条只证明「缺席补成 false」。若补齐逻辑写成无条件覆盖，
    // 上面那条照样绿，而用户开过的开关每次读都被按回去。两条合起来才夹住。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      browser: { ...baseConfig.browser, agentAutomation: true }
    }))

    const loaded = await store.get()
    expect(loaded.browser.agentAutomation, '用户开过的授权被复位了').toBe(true)
  })

  // saveBookmark 这一项比 toolbar 另外五个晚到，而 CONFIG_VERSION 没跟着升。于是磁盘上存在
  // **写于它之前的 v9 配置**（本机 dev.agentmux.desktop 那份就是：toolbar 只有五个键）。
  // v9 不小于 CONFIG_VERSION，走不到 retiredConfigReplacement 退休路径，直接进 configSchema.parse。
  // 它当初写成必需 `z.boolean()`，parse 抛 invalid_type → get() 抛 → **应用起不来**。
  // 这不是假想：把 `.default(true)` 摘掉，下面这条立刻红。
  it('toolbar 缺 saveBookmark 的存量 v9 配置仍能加载（不是抛，应用起得来）', async () => {
    const { store, path } = await storeFixture()
    const { saveBookmark: _omitted, ...withoutSaveBookmark } = baseConfig.browser.toolbar
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      browser: { ...baseConfig.browser, toolbar: withoutSaveBookmark }
    }))

    const loaded = await store.get()
    expect(loaded.browser.toolbar.saveBookmark, '缺席该读成开着，与 DEFAULT_CONFIG 同值').toBe(true)
    // 另外五个不能被这次补齐连带改写。
    expect(loaded.browser.toolbar.more).toBe(baseConfig.browser.toolbar.more)
  })

  it('用户关掉的 saveBookmark 不被默认值吃回去', async () => {
    // `.default()` 最常见的坑：只喂缺席那一侧，把默认写成无条件覆盖也全绿，
    // 而用户关掉的按钮每次冷启动都自己亮回来。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      browser: {
        ...baseConfig.browser,
        toolbar: { ...baseConfig.browser.toolbar, saveBookmark: false }
      }
    }))

    const loaded = await store.get()
    expect(loaded.browser.toolbar.saveBookmark, '用户关掉的开关被默认值复位了').toBe(false)
  })

  it('salvages each preference on its own, so a damaged toolbar does not cost the theme', async () => {
    // 与 workspaces 同一条规矩：逐条判定，不整份判定。整份判定会让下一次「browser 形状变了」
    // 的 bump 顺手清掉主题。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [workspace({ id: 'ws-1' })],
      appearance: { terminalTheme: 'catppuccin-mocha' },
      browser: { toolbar: 'not an object' }
    }))

    const loaded = await store.get()

    expect(loaded.appearance).toEqual({ terminalTheme: 'catppuccin-mocha' })
    // 坏的那条退回默认——单值偏好按一下就能重设，不值得像项目那样把启动打红。
    expect(loaded.browser).toEqual(DEFAULT_CONFIG.browser)
  })

  it('drops a carried Executor whose Provider this build no longer ships, rather than becoming unsavable', async () => {
    // 与「host 没活下来的 workspace」同一个理由：configSchema 的 superRefine 会拒掉指向未知
    // Provider 的 Executor，留着它会让整份配置存不回去，于是连项目一起丢。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [workspace({ id: 'ws-1' })],
      executors: {
        'ghost-2': {
          label: 'Retired Provider',
          providerId: 'provider-that-no-longer-exists',
          command: 'ghost',
          args: [],
          env: {},
          injectAgentMuxGuide: true
        }
      }
    }))

    const loaded = await store.get()

    expect(loaded.executors['ghost-2']).toBeUndefined()
    // 承重：项目必须还在。这条钉住「丢掉那个 Executor」与「整份存不回去」的区别。
    expect(loaded.workspaces.map((entry) => entry.id)).toContain('ws-1')
    expect(JSON.parse(await readFile(path, 'utf8')).workspaces.map((entry: WorkspaceRecord) => entry.id))
      .toContain('ws-1')
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

  it('refuses to launch rather than silently drop intact projects whose host record is unreadable', async () => {
    // #273。上一条守的是「一条都读不出来」；这一条守**部分**丢失，而那正是原来沉默的地方：
    // 一条坏掉的 host 记录会连带丢掉挂在它上面的每个项目，而只要还剩一个本机项目，
    // `workspaces.length` 就不为零，全空那条判据永远不触发。实测一个 `port: "twenty-two"`
    // 静默吃掉 5 个项目里的 4 个外加那台 host，界面上一切正常。
    //
    // 与上一条的区别是**种类**上的，不是程度上的：被丢的这些 workspace 记录本身完好，
    // id / name / path 全读得出来，丢它们的原因在它们外面。所以判据不能只是「抛了」——
    // 错误里必须点名是哪台 host、哪几个项目，那是用户唯一能据以修那一个字节的信息。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [
        { id: 'local', kind: 'local', label: 'This Mac' },
        // port 该是 number。半截写入 / 手改 / 未来某次 schema 收紧都能造出这条。
        { id: 'remote', kind: 'ssh', label: 'Build box', hostname: 'build.example.test', port: 'twenty-two' }
      ],
      workspaces: [
        // 幸存者：它让「全空」那条判据保持沉默，这条用例的全部意义就在它在场。
        workspace({ id: 'ws-local', hostId: 'local', path: '/projects/one' }),
        workspace({ id: 'ws-r1', hostId: 'remote', path: '/srv/a' }),
        workspace({ id: 'ws-r2', hostId: 'remote', path: '/srv/b' })
      ]
    })
    await writeFile(path, original)

    // 前提自检：这份 fixture 真的会留下一个幸存者。否则本条会退化成上一条的重复，
    // 而「全空」那条判据会替真正的判据背书——删掉新守卫也照旧红。
    const survivors = authoredConfigCarryOver(JSON.parse(original)).workspaces
    expect(survivors.map((entry) => entry.id)).toEqual(['ws-local'])

    const failure = await store.get().then(
      () => undefined,
      (error: unknown) => error as Error
    )

    expect(failure, '坏掉的 host 连带丢掉两个完好项目，启动却成功了').toBeDefined()
    // 点名那台 host：只说「丢了 2 个项目」不足以让用户知道去改哪一行。
    expect(failure!.message).toContain('remote')
    // 点名那几个项目，且**只**点这几个：把幸存者也算进去会让用户以为本机项目也坏了。
    expect(failure!.message).toContain('ws-r1')
    expect(failure!.message).toContain('ws-r2')
    expect(failure!.message, '幸存的项目被算成了受害者').not.toContain('ws-local')
    // 与另一条守卫共用的机制：响亮失败之所以是对的，全部依据是磁盘上那份原封不动。
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('separates the two loss classes, so a damaged project record is not reported as a host problem', async () => {
    // 两族的边界。上一条与这一条若共用一条判据，就会把「这个项目读不出来」和
    // 「这个项目好得很、是它的 host 读不出来」说成同一件事，而用户能做的动作完全不同。
    // 判据：一条坏 workspace 记录旁边，`strandedByDamagedHost` 必须是空的——那条记录
    // 不是被 host 牵连的，它自己就读不出来。
    const carried = authoredConfigCarryOver({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      workspaces: [
        workspace({ id: 'ws-ok', hostId: 'local', path: '/projects/one' }),
        { ...workspace({ id: 'ws-damaged', hostId: 'local', path: '/projects/two' }), tags: ['x'] }
      ]
    })

    expect(carried.workspaces.map((entry) => entry.id)).toEqual(['ws-ok'])
    expect(carried.found, '原始条数必须数原始记录，否则「真的没有项目」会被当成损坏').toBe(2)
    expect(
      carried.strandedByDamagedHost,
      '自己读不出来的记录被归成了「被 host 牵连」，用户会去改一台没问题的 host'
    ).toEqual([])
  })

  it('reports every stranded project of every damaged host, not just the first', async () => {
    // 只报第一台 / 每台只报第一个项目，都能让上面那条用例通过（它只有一台 host、两个项目）。
    // 这条把两个维度都摆开：两台坏 host，各挂两个项目。
    const carried = authoredConfigCarryOver({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [
        { id: 'local', kind: 'local', label: 'This Mac' },
        { id: 'box-a', kind: 'ssh', label: 'A', hostname: 'a.test', port: 'nope' },
        { id: 'box-b', kind: 'ssh', label: 'B', hostname: 'b.test', port: -1 }
      ],
      workspaces: [
        workspace({ id: 'a1', hostId: 'box-a', path: '/a/1' }),
        workspace({ id: 'a2', hostId: 'box-a', path: '/a/2' }),
        workspace({ id: 'b1', hostId: 'box-b', path: '/b/1' }),
        workspace({ id: 'b2', hostId: 'box-b', path: '/b/2' })
      ]
    })

    expect(carried.strandedByDamagedHost).toEqual([
      { hostId: 'box-a', workspaceIds: ['a1', 'a2'] },
      { hostId: 'box-b', workspaceIds: ['b1', 'b2'] }
    ])
  })

  // -------------------------------------------------------------------------
  // 上面那几条守的都是「容器读得出来，里面某些条目坏了」。这一族守的是**容器本身**读不出来，
  // 而那是同一个事故换了一扇门：三个容器原本共用一次 outer parse 并声明了形状
  // （`z.array(...)` / `z.record(...)`），`.optional()` 只放过「键缺席」，于是任一容器写成
  // 错的类型都会让**整次** parse 失败 —— 三个容器一起坍缩成空，`found` 从已经坍缩的量派生
  // 因此读成 0，全量守卫失明，配置被判定为「本来就没有项目」并落盘。
  //
  // 实测（修复前，端到端跑 get()）：磁盘上两个完好的项目，`hosts` 写成 map，结果不抛不告警，
  // 文件被改写成只剩系统自建的 scratch 一条。`executors` 写成数组也能连带清空项目列表。
  //
  // 判据落在「谁被报告」上而不只是「抛了」：三类容器各有自己该说的话，混一条通用消息就等于
  // 把用户指向错的那个字节（见下面 stranded 与容器两条的分工）。
  // -------------------------------------------------------------------------

  it('refuses to launch when the workspaces container itself is unreadable, not just its records', async () => {
    // 这条与「每一条记录都不可读」是不同的失败：那条里 `workspaces` 还是数组，能数出条数；
    // 这里连容器都不是数组，**没有任何东西能数里面有几个项目**。所以判据不是条数对不对，
    // 而是「有没有把它当成『本来就没有项目』放过去」——放过去就会落盘覆盖。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      // 未来形状：按 id 建键的 map。合法的 JSON，完好的项目数据，当前 schema 读不出。
      workspaces: {
        'ws-1': workspace({ id: 'ws-1', path: '/projects/one' }),
        'ws-2': workspace({ id: 'ws-2', path: '/projects/two' })
      }
    })
    await writeFile(path, original)

    await expect(store.get()).rejects.toThrow(/project/)
    expect(await readFile(path, 'utf8'), '容器不可读时启动通过了——磁盘上的项目已被覆盖').toBe(original)
  })

  it('a primitive where the workspaces array belongs is evidence too, not "no projects"', async () => {
    // 上面那条用的是 map 容器（`{...}`），于是 `evidenceOfWorkspaces` 里 `typeof value === 'object'`
    // 那一支就够了——**基元那一支从来没被执行过**。实测把它的 `return 1` 改成 `return 0`，
    // 其余 41 条全绿：`workspaces` 是个字符串或数字时（截断的写、被别的工具改坏、手工编辑失手），
    // 应用会带着零个项目正常启动，然后第一次 save 把用户那份完好的文件覆盖掉。
    //
    // 判据的关键是「拿不准」而不是「读得出几个」：基元里数不出条数，但它**被什么东西写进去过**。
    // 在「拒绝启动」和「覆盖文件」之间，只有前者是可恢复的。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: 'corrupt'
    })
    await writeFile(path, original)

    await expect(store.get()).rejects.toThrow(/project/)
    expect(await readFile(path, 'utf8'), '基元容器被当成「本来就没项目」放过去了——文件已被覆盖').toBe(original)
  })

  it('an empty workspaces array really is "no projects" — the guard must not refuse a first launch', async () => {
    // 反向边界，防止上面那条被「一律拒绝」满足。空数组是**可读**的，它明确说了「没有项目」，
    // 与「读不出来」是两件事；分不开就等于新用户第一次启动直接卡死。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: []
    }))

    const loaded = await store.get()

    // scratch 那条是回填出来的，不是用户写的；列全集顺带钉住它没被这条路径连带丢掉。
    expect(loaded.workspaces.map((entry) => entry.id)).toEqual([SCRATCH_WORKSPACE_ID])
  })

  it('an empty map container is also "no projects" — 空容器那一侧同样要能启动', async () => {
    // 上面那条空数组走的是 `Array.isArray` 那一支，**map 容器的空侧从来没被执行过**。
    // 这一侧被静默改坏过一次：`Object.keys(value).length > 0 ? 1 : 0` 的 `: 0` 变成 `: 1` 时，
    // 其余 49 条全绿——一个空的 map 容器（`workspaces: {}`）会被算成「持有项目」，于是全损守卫
    // 开火，用户第一次启动就被拒，而盘上根本没有东西可丢。
    //
    // 为什么这一条与空数组那条不能合并：两者走的是 `evidenceOfWorkspaces` 里不同的分支，而
    // 判据要落在「这个分支的这一侧」。合并只会让其中一侧继续无人守。
    //
    // 方向说明：空 map 与非空 map 是同一个三元的两侧，非空侧由上面「容器不可读」那条守着。
    // 两侧都要有人守，否则改坏一侧的代价是「误拒启动」，改坏另一侧的代价是「覆盖用户配置」。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: {}
    }))

    const loaded = await store.get()

    expect(
      loaded.workspaces.map((entry) => entry.id),
      '空的 map 容器被当成「持有项目」——新用户第一次启动会被守卫拒掉'
    ).toEqual([SCRATCH_WORKSPACE_ID])
  })

  it('one damaged container does not collapse the others', async () => {
    // 三个容器共用一次 parse 时，坏一个就三个一起没。这条钉住它们各自独立：`executors` 写坏
    // 不该让项目列表读不出来。判据取 `found`（它必须仍然看见那两个项目）而不是最终 workspaces，
    // 因为下面那条 executors 守卫会先抛——两条守的是不同的事。
    const carried = authoredConfigCarryOver({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      workspaces: [
        workspace({ id: 'ws-1', path: '/projects/one' }),
        workspace({ id: 'ws-2', path: '/projects/two' })
      ],
      // 未来形状：executors 从 record 变成数组。
      executors: []
    })

    expect(carried.found, 'executors 写坏把 workspaces 一起坍缩了').toBe(2)
    expect(carried.workspaces.map((entry) => entry.id)).toEqual(['ws-1', 'ws-2'])
    expect(carried.executorsUnreadable, '坏掉的 executors 容器没被报告').toBe(true)
  })

  // 为什么这条与上面两条 bump 测试不重复（我一开始以为它是重复探测器，靠对照实验否掉了）：
  // 那两条的 fixture 只改 `label` 与 `command`，其余字段与出厂值逐字相同——按前提自检的道理，
  // 相同的那几个字段守不住任何东西。实测：往 `:492` 插一个貌似合理的「部分保留」（内置 id 仍走
  // 默认表，但把用户的 `args`/`env` 带过来），那两条**全绿**，只有这一条红。差别就在这条的
  // fixture 五个字段全部偏离出厂值，于是 `args`/`env`/`injectAgentMuxGuide` 那一片才有人守。
  it('bump 会把改过的内置 Executor 还原成出厂值——这是已知代价，钉住它不许静默变动', async () => {
    // 这条**不主张**当前行为是对的（处置在 #305 待拍板），它主张这个代价必须是写明的、有人守的。
    // 现状：carry 前那道 `!(id in DEFAULT_CONFIG.executors)`（config-store.ts:492）把所有内置 id
    // 排除在外，:514 再让 DEFAULT_CONFIG 打底，于是用户改过的内置 Executor 五个字段全部回到出厂值。
    // 实测这在 bump 前后完全静默——没有任何一条断言涉及它，所以「保住」与「还原」两侧的任何改动
    // 都不会红。
    //
    // 为什么不顺手改成「与出厂值不同就 carry」：那条判据已证伪。默认表的形状历史上真变过两次
    // （先加 label，再加 injectAgentMuxGuide），所以「这条记录不等于当前默认」同样成立于
    // 「我们自己改了出厂值」，那时 carry 会把陈旧的旧默认值搬回来，让用户永远拿不到新出厂值——
    // 正是 #103/#264 那族缺陷的反向。唯一无歧义的判据是「与**写盘那一刻**的出厂值比」，而那个值
    // 今天不在盘上：信息不存在，不是判据不够聪明（同 #182 那族）。
    //
    // 断言写成与 DEFAULT_CONFIG 现取的整条相等，而不是手抄 `command: 'codex'`：手抄的期望值会在
    // 下次改出厂值时把这条打红，而那次红读起来像回归，其实只是出厂值变了。
    const edited = {
      label: '我改过的名字',
      providerId: 'codex' as const,
      command: '/opt/custom/codex',
      args: ['--flag'],
      env: { MY_VAR: '1' },
      injectAgentMuxGuide: false
    }
    // 前提自检：这条改动必须真的与出厂值不同，否则下面「被还原」的断言恒真、什么都没守。
    expect(edited, '前提自检：fixture 与出厂值相同则这条守不住任何东西')
      .not.toEqual(DEFAULT_CONFIG.executors.codex)

    const carried = authoredConfigCarryOver({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      workspaces: [workspace({ id: 'ws-1' })],
      executors: {
        codex: edited,
        // 同一份输入里放一条自建的：它必须原样保住。两条并置才说明「还原」只落在内置 id 上，
        // 而不是 carry 整个坏掉了——只钉前者时，一个「什么都不 carry」的实现也能过。
        mine: { label: 'Mine', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true }
      }
    })

    expect(carried.executors.codex, '改过的内置 Executor 没有被还原成出厂值——行为变了，去 #305 看是哪一侧')
      .toEqual(DEFAULT_CONFIG.executors.codex)
    expect(carried.executors.mine, '自建 Executor 必须原样保住（#264 修的那条）')
      .toEqual({ label: 'Mine', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true })
    // 且这次还原**不算**「容器不可读」：那个信号是给「每一条自建的都没了」用的，不该被这条借走。
    expect(carried.executorsUnreadable, '内置 Executor 被还原不是容器损坏').toBe(false)
  })

  it('refuses to launch when the hosts container is unreadable, and says so as a host problem', async () => {
    // 这条与 stranded 那条的分工是判据的核心：**一条** host 记录坏了，stranded 能点名是哪台、
    // 哪几个项目；**整个容器**坏了则一个 id 都拿不到，报「某台 host」只会指向错的字节。
    // 而 local 回填让这类丢失在结果里无处可见：挂在 local 上的项目照旧 resolvable，
    // `hosts` 也非空（默认那条被放回来了），所以没有这道守卫就完全沉默。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: {
        local: { id: 'local', kind: 'local', label: '我改过的名字' },
        box: { id: 'box', kind: 'ssh', label: 'Box', hostname: 'b.test', port: 22 }
      },
      // 刻意全部挂在 local 上：这样没有任何项目会 stranded，唯一的丢失就是那些 host 定义。
      workspaces: [workspace({ id: 'ws-local', path: '/projects/one' })]
    })
    await writeFile(path, original)

    await expect(store.get()).rejects.toThrow(/host list/)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('refuses to launch when the Executor table itself is unreadable, not just its entries', async () => {
    // 上面那条 `one damaged container does not collapse the others` 只判了 carry-over 层那个
    // `executorsUnreadable` 布尔为 true——**没人判它真的会拒绝启动**。实测把这道守卫整段删掉，
    // 其余 39 条全绿：那个布尔可以被算得对而后被完全忽略，用户自建的 Executor 静默落盘丢掉。
    //
    // 这类丢失比项目丢失更难看出来：内置默认表铺在底下，结果长得像一张健康的 Executor 表，
    // 只是用户自己那几条不见了。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      // 未来形状：从 record 变成数组。合法 JSON，当前 schema 读不出容器。
      executors: [{ id: 'mine', label: 'Mine', providerId: 'claude' }]
    })
    await writeFile(path, original)

    await expect(store.get()).rejects.toThrow(/Executor table/)
    expect(await readFile(path, 'utf8'), 'Executor 容器不可读时启动通过了——用户自建的已被覆盖').toBe(
      original
    )
  })

  // ── 逐条全损：executors 与 hosts 两条轴 ──────────────────────────────────────
  //
  // 上面三条容器守卫（hosts 容器 / Executor 容器 / workspaces 全损）与 stranded 那条之间还留着
  // 一条缝：**容器完好，逐条 salvage 把每一条都丢掉**。
  //
  // 这不是假想的未来。三个 schema 都是 `.strict()`，所以给 Executor 或 host 加**任何**字段，
  // 存量记录当场解析失败——正是 `carriedExecutors` / `hosts` 那两处 `.filter(parsed.success)`
  // 静默扔掉的东西。workspaces 那条轴有 `found` 做证据、有响亮守卫；另两条轴只有「容器类型错」
  // 守卫，逐条全损完全沉默。
  //
  // `config-store.ts:547` 那条注释把这条缝论证成了已决之事——「个别条目因 Provider 下架被丢是
  // 刻意抢救」——可它为之背书的那个 filter 是 `parsed.success && providerIds.has(...)`：**两个
  // 原因合在一条 filter 里**，注释只覆盖其中一个。Provider 下架是含糊的（这个 build 真的不认识
  // 它了，留着会让整份配置存不下去），shape 被改坏不是（记录完好，只是新 schema 多要一个字段）。
  //
  // 判据取「原本可辨识的记录数 vs 实际带过来的数」，而不是「存活条目数」。`:391-395` 记着一次
  // 被回退的尝试：数存活条目会在两个场景误报——单条 host 坏掉（stranded 已能点名）、local 记录
  // 坏掉（回填正确修好）。所以下面四条正向/反向成对，把那两个场景都做成反向边界。
  // ---------------------------------------------------------------------------

  it('refuses to launch when every custom Executor is dropped one by one, not just when the table is unreadable', async () => {
    // 容器完好（是 record），条目也确实是 object，只是多了一个当前 schema 不认的键——这就是
    // 「下次给 Executor 加字段」在今天的等价形状。`.strict()` 让它逐条解析失败，被静默扔掉，
    // 而内置默认表铺在底下，结果长得像一张健康的 Executor 表。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      executors: {
        ...baseConfig.executors,
        'my-codex': {
          label: 'My Codex', providerId: 'codex', command: 'codex', args: [], env: {},
          injectAgentMuxGuide: true, retriesOnRateLimit: 3
        },
        'my-claude': {
          label: 'My Claude', providerId: 'claude', command: 'claude', args: [], env: {},
          injectAgentMuxGuide: true, retriesOnRateLimit: 1
        }
      }
    })
    await writeFile(path, original)

    await expect(store.get()).rejects.toThrow(/2 Executor/)
    expect(
      await readFile(path, 'utf8'),
      '自建 Executor 被逐条丢光却照旧启动了——文件已被覆盖，用户的 Executor 无处可寻'
    ).toBe(original)
  })

  it('an Executor whose Provider this build retired is silent salvage — it must not refuse the launch', async () => {
    // 反向边界，也是上面那条守卫**唯一**允许的沉默。这条记录本身完全合法，丢它的理由在它之外：
    // 这个 build 不认识那个 Provider 了，留着会让 schema 的 Provider-存在性 refinement 拒绝整份
    // 配置，`save()` 永远写不出去。含糊 vs 不含糊，是这两条测试分开的那条线。
    //
    // Provider id 现算：手抄一个「已下架」的名字会在某天真的被加进去，那天这条测试会静默变成
    // 「合法 Provider 也不抛」，与它要证的事相反。
    const retiredProviderId = `retired-${BUILT_IN_AGENT_PROVIDERS.map((p) => p.id).join('-')}`
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      workspaces: [workspace({ id: 'ws-1' })],
      executors: {
        ...baseConfig.executors,
        'my-old': {
          label: 'Old', providerId: retiredProviderId, command: 'old', args: [], env: {},
          injectAgentMuxGuide: true
        }
      }
    }))

    const loaded = await store.get()

    expect(Object.keys(loaded.executors)).not.toContain('my-old')
    expect(loaded.workspaces.map((entry) => entry.id)).toContain('ws-1')
  })

  it('refuses to launch when every authored host is dropped one by one, and the local back-fill hides it', async () => {
    // hosts 那条轴的同一形状。这里刻意让**没有任何项目**挂在远端 host 上：于是 stranded 恒空，
    // 容器是数组所以 hostsUnreadable 为假，local 被回填所以 `hosts` 非空——三道现有守卫全部沉默，
    // 而用户配的那两台机器已经不在了。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [
        { id: 'local', kind: 'local', label: 'This Mac' },
        { id: 'box', kind: 'ssh', label: 'Box', hostname: 'b.test', jumpHost: 'gw.test' },
        { id: 'gpu', kind: 'ssh', label: 'GPU', hostname: 'g.test', jumpHost: 'gw.test' }
      ],
      workspaces: [workspace({ id: 'ws-local', hostId: 'local' })]
    })
    await writeFile(path, original)

    await expect(store.get()).rejects.toThrow(/2 host/)
    expect(
      await readFile(path, 'utf8'),
      '用户配的 host 被逐条丢光却照旧启动了——文件已被覆盖'
    ).toBe(original)
  })

  it('a damaged local host record stays silent salvage — the back-fill repairs it, so it is not a loss', async () => {
    // 反向边界之一：`:391-395` 记着的第一个误报场景。local 不是创作内容（默认表里永远有一份），
    // 它坏掉时回填**正确修好**，什么都没丢，因此不能算进证据。旁边那条 `back-fills the local
    // host…` 只判了项目存活；这条判的是「不抛」——把新守卫写成数所有 host 记录就会打红这里。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [{ id: 'local', kind: 'local', label: 'This Mac', theme: 'dark' }],
      workspaces: [workspace({ id: 'ws-local', hostId: 'local' })]
    }))

    const loaded = await store.get()

    expect(loaded.hosts.filter((host) => host.id === 'local')).toHaveLength(1)
    expect(loaded.workspaces.map((entry) => entry.id)).toContain('ws-local')
  })

  it('one damaged host among several is left to the stranded guard, which can name it', async () => {
    // 反向边界之二：`:391-395` 记着的第二个误报场景。一条坏、一条好时，stranded 那条守卫能点名
    // 是哪台、哪几个项目；新守卫在这里再抛一次只会把消息从「可操作」降级成「泛泛」。判据是
    // **消息内容**而不是「不抛」——这里 stranded 必须抛，抛的得是它那条。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [
        { id: 'local', kind: 'local', label: 'This Mac' },
        { id: 'good', kind: 'ssh', label: 'Good', hostname: 'g.test' },
        { id: 'bad', kind: 'ssh', label: 'Bad', hostname: 'b.test', port: 'twenty-two' }
      ],
      workspaces: [workspace({ id: 'ws-bad', hostId: 'bad' })]
    }))

    await expect(store.get()).rejects.toThrow(/bad \(ws-bad\)/)
    await expect(store.get()).rejects.not.toThrow(/host record\(s\) that none/)
  })

  it('exposes the path it actually reads, so a startup failure can point the user at the right file', async () => {
    // `filePath` 的唯一消费者是启动失败对话框（`index.ts`），而那条路径没有任何测试执行它——
    // 现有守卫是 `startup-failure-notice.test.ts:130` 的 `toMatch(/configStore\.filePath/)`，
    // 它守的是「index.ts 里写着这个取值」，不是「getter 真的返回盘上那份路径」。实测把 getter
    // 改成返回 `'/tmp/MUTANT-….json'`，54 条全绿：对话框会把用户指向一个不存在的文件，比不给
    // 路径更糟。一行行为断言就够。
    const { store, path } = await storeFixture()

    expect(store.filePath).toBe(path)
  })

  it('a damaged hosts container is reported as the container even when it also strands every project', async () => {
    // 上一条刻意把项目全放在 local 上，于是只有一个守卫能成立——**顺序**因此无人守。这一格
    // 补的是两条同时成立：容器写成 map，项目挂在远端 host 上，于是 `hosts` 解析成空、local
    // 被回填、那些项目全部 stranded。
    //
    // 正确的消息是容器那条。stranded 的说法是「修好或删掉那条 host 记录」，可这里那条 box
    // 记录本身完全没问题——改它一个字节也救不回来，真正坏的是外面那层形状。指错字节比不说更糟。
    // （实测把容器守卫移到 stranded 之后，其余 39 条全绿：那条论证顺序的注释此前完全没有守卫。）
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: {
        local: { id: 'local', kind: 'local', label: 'This Mac' },
        box: { id: 'box', kind: 'ssh', label: 'Box', hostname: 'b.test', port: 22 }
      },
      workspaces: [workspace({ id: 'ws-remote', hostId: 'box', path: '/projects/one' })]
    })
    await writeFile(path, original)

    await expect(store.get()).rejects.toThrow(/host list/)
    // 承重：不许退化成点名 box——那条 host 记录是好的，用户照着修会白费功夫。
    await expect(store.get()).rejects.not.toThrow(/box \(ws-remote\)/)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('keeps the two host loss classes apart: one damaged record is still reported by host and project', async () => {
    // 反向：容器守卫不许把「某条记录坏了」抢过去。这条与上面 #273 那条的区别在于它**没有**
    // 本机幸存项目——`carried.workspaces` 已按 host 过滤，所以「全部项目都在坏 host 上」时
    // 全量守卫与 stranded 守卫会同时成立，而只有后者的消息是可操作的（改一个 host 字节）。
    // 顺序判错就会让用户去删他们完好的项目记录。
    const { store, path } = await storeFixture()
    const original = JSON.stringify({
      ...baseConfig,
      version: DEFAULT_CONFIG.version - 1,
      hosts: [{ id: 'box', kind: 'ssh', label: 'Box', hostname: 'b.test', port: 'twenty-two' }],
      workspaces: [workspace({ id: 'ws-only', hostId: 'box', path: '/projects/one' })]
    })
    await writeFile(path, original)

    // 承重：点名 host 与项目，而不是那条「没有一条记录能被接受」的通用消息。
    await expect(store.get()).rejects.toThrow(/box \(ws-only\)/)
    await expect(store.get()).rejects.not.toThrow(/none of the current/)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('an absent or empty container is not damage', async () => {
    // 三条容器守卫的边界。缺席与空都表示「用户没建过」，那不含糊，也不该拒绝启动——
    // 判成损坏会让每一份新装配置都起不来。这条同时覆盖三者，因为它们共用同一条判据。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      version: DEFAULT_CONFIG.version - 1,
      hosts: [],
      workspaces: [],
      executors: {}
    }))

    const loaded = await store.get()

    expect(loaded.workspaces.map((entry) => entry.id)).toEqual([SCRATCH_WORKSPACE_ID])
    expect(loaded.hosts.some((host) => host.id === 'local'), 'local 回填没发生').toBe(true)
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
      notifications: { mode: DEFAULT_NOTIFICATION_MODE_ID },
      // 同理：授权位也是后加的字段，get() 会把它补成具体的 false 再交出去。
      browser: { ...saved.browser, agentAutomation: false },
      // 同理：prompt 库也是后加的字段。**键缺席**（这个 fixture 就是）读成默认那两条；
      // 用户显式删光留下的 `[]` 不在此列，那条由本文件「用户删光之后不被回填」单独钉。
      composerShortcuts: DEFAULT_CONFIG.composerShortcuts
    })
  })

  it('persists only a known terminal palette as desktop appearance truth', async () => {
    const { store, path } = await storeFixture()
    const saved = await store.save({
      ...baseConfig,
      appearance: { terminalTheme: 'catppuccin-mocha' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
    })

    expect(saved.appearance).toEqual({ terminalTheme: 'catppuccin-mocha' })
    expect((await store.get()).appearance).toEqual({ terminalTheme: 'catppuccin-mocha' })
    expect(await readFile(path, 'utf8')).toContain('"terminalTheme": "catppuccin-mocha"')

    await expect(store.save({
      ...baseConfig,
      appearance: { terminalTheme: 'retired-theme' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
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
          saveBookmark: false,
          more: false
        }
      }
    })

    expect(saved.browser.toolbar).toEqual({
      selectElement: false,
      screenshot: true,
      devTools: false,
      viewport: true,
      saveBookmark: false,
      more: false
    })
    // save() 存的是作者写的形状，get() 交出的是补齐过的形状——这里点名差的就是授权位那一个字段。
    expect((await store.get()).browser).toEqual({ ...saved.browser, agentAutomation: false })
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

    // baseConfig 写于 prompt 库这个字段之前（它不带这个键），所以存取都会补上默认那两条。
    // 两处都按同一个来源比，而不是把默认那两条在测试里手抄一遍——手抄的那份会和 DEFAULT_CONFIG 漂开。
    const withDefaults = { ...baseConfig, composerShortcuts: DEFAULT_CONFIG.composerShortcuts }
    await expect(initial).resolves.toEqual(withDefaults)
    await expect(rebound).rejects.toThrow('Agent Executor codex is already bound to Provider codex')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(withDefaults)
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

  // The SSOT proof. The behavioral test above shows the schema normalizes, but a normalizing rule
  // hand-inlined into `superRefine` would pass it just as well — and then the schema's notion of "same
  // location" could silently drift from every write path's, which is the whole bug. This pins that the
  // refinement derives its key from the SHARED `workspaceLocationKey` and does NOT rebuild the
  // normalizer inline. A behavioral test cannot catch a correct copy, so the criterion is the import
  // relation: re-inline it and this reds.
  it('derives the uniqueness key from the shared workspaceLocationKey, not an inline copy', () => {
    const source = readFileSync(new URL('../src/main/config-store.ts', import.meta.url), 'utf8')
    const at = source.indexOf('.superRefine(')
    expect(at, 'self-check: superRefine block not found').toBeGreaterThan(-1)
    const block = source.slice(at, source.indexOf('/**', at))
    // Uses the one shared definition of "same location".
    expect(block).toContain('workspaceLocationKey(')
    // And does not re-spell the normalizer inline — the exact drift this task removes. Both spellings
    // the old inline key used (`join(..., '.')` and `posix.normalize`) must be gone from the block.
    expect(block).not.toContain("join(workspace.path, '.')")
    expect(block).not.toContain('posix.normalize')
  })
})

describe('ConfigStore 本地 prompt 库', () => {
  // 这一族守的是「删掉即永久没有」。它不是一条偏好开关：内置那两条是 DEFAULT_CONFIG 里的**默认项**，
  // 而任何「缺席即补默认」的回填都会把用户删掉的东西送回来——删了又回来比一开始不能删更糟。
  // 所以判据必须同时钉住两侧：默认要在场（否则新用户一条都没有），缺席与空列表都不许被补。

  it('默认给出那两条可改可删的 prompt，每条都能真的工作（keyword 与正文都非空）', () => {
    const prompts = DEFAULT_CONFIG.composerShortcuts ?? []
    expect(prompts.map((prompt) => prompt.id)).toEqual(['review-changes', 'summarize-progress'])
    // 空 keyword 补全不了也识别不了裸词，空 body 替换进去等于清空草稿——两者都是「这条什么都不做」。
    // 只判条数会让一条空壳 prompt 通过（本仓「声明了却静默不做的能力」）。
    for (const prompt of prompts) {
      expect(prompt.keyword.length, `${prompt.id} 没有 keyword，它既补全不了也识别不了裸词`).toBeGreaterThan(0)
      expect(prompt.body.length, `${prompt.id} 没有正文，选中它等于把草稿清空`).toBeGreaterThan(0)
      // keyword 不带 `/`：同一个字段既作 `/` 候选的补全词、也作正文里的裸词识别，带上前缀就只能服务前一处。
      expect(prompt.keyword.startsWith('/'), `${prompt.id} 的 keyword 带了 /，裸词识别永不命中`).toBe(false)
    }
  })

  it('用户删光之后不被回填——盘上是空列表，读出来仍是空列表', async () => {
    // 这是本族的题眼。fixture 先把 scratch 与 notifications 两个上游 back-fill 喂饱，否则它们各自
    // 也会置 persist、把盘重写一遍，于是「我这条没有回填」这件事会搭它们的便车被掩盖。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      workspaces: [{
        id: SCRATCH_WORKSPACE_ID,
        name: SCRATCH_WORKSPACE_NAME,
        hostId: 'local',
        path: join(tmpdir(), '.agentmux', 'scratch'),
        kind: 'folder'
      }],
      notifications: { mode: DEFAULT_NOTIFICATION_MODE_ID },
      browser: { ...baseConfig.browser, agentAutomation: false },
      composerShortcuts: []
    }))

    const loaded = await store.get()
    expect(loaded.composerShortcuts, '删光的 prompt 被默认值补回来了——删掉必须是永久的').toEqual([])
    // 内存里没补还不够：只在内存里空着、却把默认写回盘，下次冷启动它们就回来了。
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { composerShortcuts?: unknown }
    expect(onDisk.composerShortcuts, '盘上被写回了默认 prompt，下次冷启动删掉的又回来').toEqual([])
    // 反向锚点：断言不是因为「默认恰好是空」而成立。
    expect((DEFAULT_CONFIG.composerShortcuts ?? []).length).toBeGreaterThan(0)
  })

  it('字段整个缺席＝这份配置写于本功能之前，读出来是默认那两条（真机上就是这个情形）', async () => {
    // 这一条是**用户报的缺陷**：「我们要的那种自定义 command 能力似乎也没见到」。真机上
    // `~/Library/Application Support/dev.agentmux.desktop/agentmux.config.json` 是 version 9、
    // 写于本字段存在之前，一个 composerShortcuts 键都没有。此前这里按「缺席与空同义、都不回填」
    // 收口，于是旧配置的用户永远看不到任何 prompt，也不会有识别词——功能像根本没做。
    //
    // 缺席与 `[]` 必须分开：前者是「还没见过这个字段」，后者是「用户删光了」。它们只差一个键
    // 的有无，而 zod 的 `.default()` 正好只在键缺席时生效。上面那条「删光不回填」仍然成立，
    // 两条一起钉住这个分叉——单钉任何一侧，另一侧的实现都能是错的还全绿。
    const { store, path } = await storeFixture()
    await writeFile(path, JSON.stringify({
      ...baseConfig,
      workspaces: [{
        id: SCRATCH_WORKSPACE_ID,
        name: SCRATCH_WORKSPACE_NAME,
        hostId: 'local',
        path: join(tmpdir(), '.agentmux', 'scratch'),
        kind: 'folder'
      }],
      notifications: { mode: DEFAULT_NOTIFICATION_MODE_ID },
      browser: { ...baseConfig.browser, agentAutomation: false }
    }))
    // 自证：fixture 真的没这个字段，否则下面判的是别的东西。
    expect('composerShortcuts' in JSON.parse(await readFile(path, 'utf8'))).toBe(false)

    const loaded = await store.get()

    // 读出来必须是能用的那两条，而不是空列表。按 id 钉而不只数条数：一条空壳 prompt
    // （keyword 或 body 为空）条数也对，但它什么都不做。
    expect(loaded.composerShortcuts?.map((prompt) => prompt.id),
      '旧配置读出来没有 prompt：真机上这就是「自定义 command 看不到」').toEqual(['review-changes', 'summarize-progress'])
    // 反向锚点：这条断言不是因为「默认恰好是空」而成立。
    expect((DEFAULT_CONFIG.composerShortcuts ?? []).length).toBeGreaterThan(0)
  })

  it('用户写的 prompt 原样存取，包括绑定到某个 Provider 的那条', async () => {
    const { store } = await storeFixture()
    const mine = [
      { id: 'p-1', keyword: 'eli5', label: 'Explain simply', body: 'Explain this like I am five.' },
      { id: 'p-2', keyword: 'grill_me', label: 'Grill me', body: 'Attack my reasoning.', providerId: 'codex' as const }
    ]

    const saved = await store.save({ ...baseConfig, composerShortcuts: mine })

    expect(saved.composerShortcuts).toEqual(mine)
    // 重新读一遍：strict schema 漏声明这个字段的话，整块配置在这里判失败而不是静默丢字段。
    expect((await store.get()).composerShortcuts).toEqual(mine)
  })

  it('退役重置带走用户的 prompt，而不是把它们换回默认那两条', () => {
    // prompt 正文是用户**自己打的字**，不是一键能设回来的偏好。和 appearance / browser 那些不同，
    // 丢了它就是丢了用户写的内容，所以它必须落在 carry-over 那一侧。
    const carried = authoredConfigCarryOver({
      ...baseConfig,
      composerShortcuts: [{ id: 'p-1', keyword: 'eli5', label: 'Explain simply', body: 'Explain this like I am five.' }]
    })
    expect(carried.composerShortcuts).toEqual([
      { id: 'p-1', keyword: 'eli5', label: 'Explain simply', body: 'Explain this like I am five.' }
    ])
    // 空列表也要带过来：`[]` 是「用户把默认那两条都删了」这个事实，按长度判会让删光静默变回默认。
    expect(authoredConfigCarryOver({ ...baseConfig, composerShortcuts: [] }).composerShortcuts).toEqual([])
    // 而坏掉的一条让整列表不带过来（默认顶上），不是静默塞一条半截数据进去。
    expect(authoredConfigCarryOver({ ...baseConfig, composerShortcuts: [{ id: 'p-1', keyword: '' }] }).composerShortcuts)
      .toBeUndefined()
  })
})

describe('ConfigStore recoverability', () => {
  // 这一族守的是本 lane 的题眼：一次 config 写入要么可逆，要么响亮拒绝——不许静默。
  // 两条独立机制：
  //   1. 覆盖前把旧字节留到 `.prev` 单文件（当前版本下每次 save 都过这条路，退役守卫看不到这里）。
  //   2. 读不出来的 config 在 get() 抛之前把原始字节抄到 `.corrupt`，这样用户为脱困删掉主文件也不销毁证据。

  async function fileText(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  it('keeps the pre-save bytes in a single previous-version sidecar, replaced each write', async () => {
    // 判据不是「有个 .prev」，而是「.prev 恰好等于**上一次**落盘的那份字节」——不是更旧的，也不是刚写的。
    // 变异实测：把 `durableWriteFile(this.previousVersionPath, previousText)` 里的 previousText 改成
    // 新配置的序列化，这条立刻红（第二个断言：.prev 会等于 B 而不是 A）。删掉整行也红（.prev 缺席）。
    const { store, path } = await storeFixture()

    const savedA = await store.save({ ...baseConfig, workspaces: [workspace({ id: 'ws-a' })] })
    const bytesAfterA = await readFile(path, 'utf8')
    // 第一次写之前盘上什么都没有，所以此刻还不该有 .prev（否则就是把自己刚写的当成了旧值）。
    expect(await fileText(store.previousVersionPath), '第一次写就冒出了 .prev——它把新字节当旧值了')
      .toBeNull()

    const savedB = await store.save({ ...savedA, workspaces: [workspace({ id: 'ws-b', path: '/projects/b' })] })
    const bytesAfterB = await readFile(path, 'utf8')
    // 承重：.prev 现在必须逐字等于 A 落盘的那份，而不是 B。
    expect(await fileText(store.previousVersionPath), '.prev 不是上一次落盘的字节')
      .toBe(bytesAfterA)
    // 反向锚点：确认 A 与 B 的字节确实不同，否则上面那条恒真、什么都没守。
    expect(bytesAfterA, '前提自检：A 与 B 的落盘字节必须不同').not.toBe(bytesAfterB)

    // 单文件、每次替换：第三次写后 .prev 前进到 B，A 那份不再保留（这是一步撤销，不是历史）。
    await store.save({ ...savedB, workspaces: [workspace({ id: 'ws-c', path: '/projects/c' })] })
    expect(await fileText(store.previousVersionPath), '.prev 没有前进到 B——它不是单步撤销就是没在替换')
      .toBe(bytesAfterB)
  })

  it('quarantines the exact bytes of a corrupt config before get() throws, surviving deletion of the main file', async () => {
    // 语法坏掉的 JSON 走 get() 的 catch。判据有两层：quarantine 抄的是**原始字节**（不是重新序列化的），
    // 且它在主文件被删后依然在——那正是「用户删文件脱困」时唯一剩下的证据。
    // 变异实测：删掉 get() catch 里的 quarantineUnreadable 调用，第二个断言红（.corrupt 缺席）。
    const { store, path } = await storeFixture()
    const corrupt = '{ this is not : json,,, '
    await writeFile(path, corrupt)

    await expect(store.get()).rejects.toThrow()

    expect(await fileText(store.quarantinePath), 'corrupt 配置没有被抄到隔离区').toBe(corrupt)
    // 主文件原封不动（响亮失败可恢复的全部依据），且隔离区独立于它存在。
    expect(await readFile(path, 'utf8')).toBe(corrupt)
    await rm(path)
    expect(await fileText(store.quarantinePath), '删掉主文件后隔离区也没了——证据随之销毁').toBe(corrupt)
  })

  it('quarantines a config the schema refuses to launch on, keeping the original bytes verbatim', async () => {
    // 不只是语法错：走到「拒绝启动」守卫（如整份 workspaces 不可读）的那几条也必须留证据。
    // 判据是隔离区逐字等于原始输入，而不是被 carry-over 改写过的东西。
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

    await expect(store.get()).rejects.toThrow(/project/)
    expect(await fileText(store.quarantinePath), '拒绝启动的 config 没留下隔离证据').toBe(original)
    expect(await readFile(path, 'utf8'), '主文件被动了').toBe(original)
  })

  it('does not quarantine when there is simply no config file yet', async () => {
    // 反向边界：全新安装（ENOENT）不是损坏，绝不能留下一个假的 .corrupt——否则每次首启都像出过事。
    // 变异实测：若把 ENOENT 分支也导向 quarantine，这条红。
    const { store } = await storeFixture()

    const loaded = await store.get()

    expect(loaded.workspaces.map((entry) => entry.id)).toEqual([SCRATCH_WORKSPACE_ID])
    expect(await fileText(store.quarantinePath), '首次启动不该冒出 .corrupt').toBeNull()
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

  // 上面那条只守「越过 9 家时代」这一个历史门槛。它今天恒真（当前是 v9 > 7），所以**再加一家
  // Provider 而忘了 bump**，它照旧全绿——这正是 #304 那个静默漏点，而 v7→v8 的事故说明它会重演。
  //
  // 前提已实测坐实：同版本加载走的是纯 `configSchema.parse`（config-store.ts:694），没有任何
  // executor 回填（`get()` 里只有 scratch 与 notification 两个 additive helper）。造一份「当前版本、
  // 但少一家内置 executor」的配置读进来，那家就是不在，落盘后也仍然不在，全程无任何告知。于是
  // 「加了 Provider 却没 bump」对存量用户等于这家 Provider 不存在，而且他们无从知道。
  //
  // 判据不能是「记住 executor 有几家」——那又是一个手抄的数字，且加一家减一家会互相抵消。这条把
  // **当前 key 集合**与**当前版本号**绑成一对写死的锚点：动了表就必须回来动这行，而动这行的人会
  // 读到下面那句话，于是「要不要 bump」被强制成一次显式判断，而不是一次遗漏。
  //
  // 为什么锚点是写死的字面量而不是从 DEFAULT_CONFIG 现取：现取会跟着被测对象一起漂（加一家时两侧
  // 同步变大、恒真），那是本文件 `LEGACY_NINE_PROVIDER_VERSION` 上方那段注释已经踩过并写下的同一个陷阱。
  it('内置 executor 的 key 集合与 CONFIG_VERSION 绑成一对锚点——改了表就必须回来判断要不要 bump', () => {
    // 这两个值必须一起改。如果你新增/删除了内置 executor：
    //   - 存量用户要看到这次变化 ⇒ bump CONFIG_VERSION（代价见「bump 会把改过的内置 Executor
    //     还原成出厂值」那条：用户改过的内置 Executor 会被还原；自建的与偏好不受影响）；
    //   - 确定不需要送到存量用户手上（例如只是重命名一个内部 id）⇒ 不 bump，但要在这里写明为什么。
    // 两种情况都要把下面的清单与版本号同步到当前值。
    const ANCHORED_EXECUTOR_IDS = [
      'antigravity', 'claude', 'codex', 'copilot', 'cursor', 'droid',
      'gemini', 'grok', 'hermes', 'kimi', 'opencode', 'pi', 'traex'
    ]
    const ANCHORED_AT_VERSION = 9

    expect(
      Object.keys(DEFAULT_CONFIG.executors).sort(),
      `内置 executor 的清单变了，但这条锚点还停在 v${ANCHORED_AT_VERSION}。` +
        '先决定这次变化要不要送到存量用户手上：要，就 bump CONFIG_VERSION（同版本加载不回填，' +
        '不 bump 等于这家 Provider 对他们不存在）；不要，就在这条测试里写明理由。' +
        '然后把清单与 ANCHORED_AT_VERSION 一起同步到当前值。'
    ).toEqual(ANCHORED_EXECUTOR_IDS)
    expect(
      DEFAULT_CONFIG.version,
      `CONFIG_VERSION 变了而这条锚点没跟上：把 ANCHORED_AT_VERSION 同步到 ${DEFAULT_CONFIG.version}。` +
        '这条与上面的清单是一对——只同步一半，下一次改表时它就守不住了。'
    ).toBe(ANCHORED_AT_VERSION)
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
