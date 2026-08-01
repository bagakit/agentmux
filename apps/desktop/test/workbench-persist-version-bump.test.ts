import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { createJSONStorage } from 'zustand/middleware'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  createWorkbenchTab,
  fileTabId,
  initialWorkbenchRegionId
} from '../src/renderer/src/lib/workbench-tabs.js'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence.js'
import { useAppStore } from '../src/renderer/src/store.js'

// ---------------------------------------------------------------------------
// Workbench 持久化记录跨版本升级：bump 一下版本号不得清空用户的东西。
//
// 缺陷形状（zustand 5.0.14，middleware.mjs 的 hydrate 分支实测）：磁盘上的 version 与
// `options.version` 不等而又没有 `migrate` 时，它只 `console.error` 一句，然后
// `return [false, undefined]` —— `merge(undefined, get())` 把整份状态换成内存默认值。
// 三件坏事同时发生：
//   1. 用户的 Tab / 布局 / 侧栏宽度 / 换行开关 / 自己起的 Agent 名字全部消失；
//   2. `hasHydrated()` 照旧变 true，`onRehydrateStorage` 的 error 参数是 `undefined`，
//      所以 store.ts 那两个检测点（:4073 的 error 分支、:1466 的 `!hasHydrated()` 合成检查）
//      **都看不见**它；
//   3. 于是 `persistWritesEnabled` 照旧打开，下一次写入覆盖掉唯一的副本。
//
// 这一族判据必须跑**真的** `persist.rehydrate()`，不能 mock 掉它：现有 store-persistence
// 那一族全部 mock `rehydrate` 或只查 `partialize`，对这个洞结构性失明（那是它的正当范围——
// 它守的是"哪些字段进磁盘"，不是"记录怎么被读回来"）。
//
// 注入 storage 而不是给测试环境装 jsdom：本仓 vitest 没有 environment 配置，`window` 未定义，
// 于是产品里的 `workbenchStorage()` 走 `nonBrowserWorkbenchStorage`（`getItem` 恒 null）。
// 那条路读不出任何东西，判据会恒真。
// ---------------------------------------------------------------------------

const initialState = useAppStore.getState()
const originalStorage = useAppStore.persist.getOptions().storage

afterEach(() => {
  // storage 是全局选项，必须还原：漏掉会让同一进程里后跑的测试读到这里的假记录。
  useAppStore.persist.setOptions({ storage: originalStorage })
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

/**
 * 用户设过的一整套东西，逐项都取**非默认**值——否则「带过来了」与「重置成默认」无法区分。
 * 数值刻意不取整数默认附近的值，布尔逐项与默认相反。
 *
 * 这份 fixture 必须覆盖 `partialize` 写出去的**每一个**键，而不只是好写的那几个。原先它只有
 * 下面第二组（7 项表面偏好），于是 `restoredWorkbench` 这个整族的主角从来没进过记录：实测让
 * migrate 剥掉它（`const { restoredWorkbench, ...rest } = persisted; return rest`），那 7 条
 * 断言一条不红——而症状恰好就是这一族存在的理由（#59/#79「重启后 tab 和分屏没了」）。
 * 同形的还有另外 4 个键，共 5 个在 42 条全绿下不可见。
 *
 * 键的清单由 `partialize` 在运行期派生（见下面那条覆盖率自检），不手抄：手抄的清单会在下一个
 * 人往 `partialize` 里加字段时静默落后，而那正是这次的失败方式。
 */
const PERSISTED_TAB_ID = fileTabId('workspace-alpha', 'notes/kept.md')

/** 一个真实形状的 file tab + 布局。file 面是唯一必须活过重启的持久面（见 workbench-persistence.ts:49）。 */
const PERSISTED_WORKBENCH = projectPersistedWorkbench({
  tabs: {
    [PERSISTED_TAB_ID]: createWorkbenchTab(PERSISTED_TAB_ID, {
      regionId: initialWorkbenchRegionId(PERSISTED_TAB_ID),
      kind: 'file',
      workspaceId: 'workspace-alpha',
      path: 'notes/kept.md'
    })
  },
  layouts: { 'workspace-alpha': createWorkspaceLayout('group-alpha', [PERSISTED_TAB_ID]) }
})

const PERSISTED_PREFERENCES = {
  // 第一组：Workbench 拓扑与启动期取值。这五项是这次补上的——它们此前一个都不在记录里。
  restoredWorkbench: PERSISTED_WORKBENCH,
  unclaimedTerminalSessionIds: ['orphan-terminal-1', 'orphan-terminal-2'],
  activeWorkspaceId: 'workspace-alpha',
  mainSurface: 'board',
  workspaceTool: 'agents',
  // 第二组：表面偏好。
  toolDockWidth: 421,
  editorWordWrap: true,
  projectRailOpen: false,
  toolsOpen: true,
  agentNames: { 'sess-1': '我给它起的名字' },
  scratchTopicOrder: ['topic-9', 'topic-3'],
  collapsedProjectGroups: { '/repo/group': true }
} as const

/**
 * 把一份「上一版」的记录摆进注入的 storage，真跑一次 rehydrate。
 *
 * 版本号从 `getOptions().version - 1` 派生而**不写字面量**：写死 0 的话，下一次 bump 到 2
 * 之后这份 fixture 就变成"低两版"，仍然不等，判据看起来照旧成立——但它已经不再检验"上一版"
 * 这个真实场景了。派生还顺带保证了「前提是版本不等」这件事永远为真。
 */
async function rehydrateFromPreviousVersion(state: Record<string, unknown>): Promise<{
  consoleErrors: unknown[][]
}> {
  const options = useAppStore.persist.getOptions()
  const name = options.name
  const previousVersion = (options.version as number) - 1
  const backing = new Map<string, string>([
    [name, JSON.stringify({ state, version: previousVersion })]
  ])

  const consoleErrors: unknown[][] = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args)
  })

  useAppStore.persist.setOptions({
    storage: createJSONStorage(() => ({
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value) },
      removeItem: (key: string) => { backing.delete(key) }
    }))
  })
  await useAppStore.persist.rehydrate()
  return { consoleErrors }
}

describe('Workbench 持久化记录跨一次版本升级', () => {
  it('前提自检：fixture 覆盖了 partialize 写出去的每一个键', () => {
    // 这一条是这族的**覆盖率**判据，位置在最前面：它红了说明有人往 `partialize` 加了字段
    // 而没有给它非默认值，于是那个字段的丢失从这一刻起对整族不可见。
    //
    // 清单从 `partialize` 运行期派生而不手抄：手抄的那一份会静默落后，正是这次的失败方式
    //（原 fixture 只有 7 项表面偏好，5 个键从来没进过记录）。
    const partialize = useAppStore.persist.getOptions().partialize as
      | ((state: unknown) => Record<string, unknown>)
      | undefined
    expect(typeof partialize, 'partialize 取不到了，本条自检失去意义').toBe('function')
    const persistedKeys = Object.keys(partialize!(useAppStore.getState())).sort()
    expect(
      Object.keys(PERSISTED_PREFERENCES).sort(),
      'fixture 与 partialize 的键不一致——差集里的字段丢失时整族不会红'
    ).toEqual(persistedKeys)
  })

  it('前提自检：注入的 storage 真的被读到了（否则整族恒真）', async () => {
    // 不经过这一条，「偏好还在」可能只是因为 rehydrate 什么都没做而内存里本来就有值。
    // 这里刻意摆一个与默认不同的值，且**不**经过 migrate 之外的任何路径。
    await rehydrateFromPreviousVersion({ toolDockWidth: PERSISTED_PREFERENCES.toolDockWidth })
    expect(
      useAppStore.getState().toolDockWidth,
      '注入的 storage 没有被读到——本文件其余判据全部失去意义'
    ).toBe(PERSISTED_PREFERENCES.toolDockWidth)
  })

  it('前提自检：这份 fixture 的版本确实与当前不等', () => {
    // 若哪天 fixture 与当前版本相同，整族会走「版本相等」那条完全不同的路，
    // 而 migrate 根本不会被调用——绿得毫无意义。
    const options = useAppStore.persist.getOptions()
    expect((options.version as number) - 1).not.toBe(options.version)
  })

  it('每一项用户偏好都活着过来，一项都不重置', async () => {
    await rehydrateFromPreviousVersion({ ...PERSISTED_PREFERENCES })

    const state = useAppStore.getState()
    // 逐项判而不是 toMatchObject 一次：少带一项时，只判其中几项的断言会替其余项背书。
    expect(state.toolDockWidth, '侧栏宽度被重置了').toBe(PERSISTED_PREFERENCES.toolDockWidth)
    expect(state.editorWordWrap, '换行开关被重置了').toBe(PERSISTED_PREFERENCES.editorWordWrap)
    expect(state.projectRailOpen, '项目栏开合被重置了').toBe(PERSISTED_PREFERENCES.projectRailOpen)
    expect(state.toolsOpen, '工具面板开合被重置了').toBe(PERSISTED_PREFERENCES.toolsOpen)
    expect(state.agentNames, '用户自己起的 Agent 名字丢了').toEqual(PERSISTED_PREFERENCES.agentNames)
    expect(state.scratchTopicOrder, 'Topic 顺序丢了').toEqual(PERSISTED_PREFERENCES.scratchTopicOrder)
    expect(state.collapsedProjectGroups, '折叠状态丢了').toEqual(
      PERSISTED_PREFERENCES.collapsedProjectGroups
    )
  })

  // -------------------------------------------------------------------------
  // 下面五条是这一族原先整体缺失的那半边。上面那条只判表面偏好，于是记录里根本没有
  // `restoredWorkbench`——实测让 migrate 把它剥掉（`const { restoredWorkbench, ...rest } =
  // persisted; return rest`），上面 7 条断言一条不红，而用户看到的正是这一族要防的那个症状：
  // 重启后 Tab 与分屏全没了（#59/#79）。同形的还有另外四个键。
  //
  // 分成五条而不是一条 toMatchObject：少带任意一项时，判据必须指出**是哪一项**没过来，
  // 否则失败信息会退化成「记录不对」，而这五项各自对应完全不同的用户症状。
  // -------------------------------------------------------------------------

  it('Tab 与分屏拓扑活着过来——这一族原先根本没在记录里放过它', async () => {
    // 症状：重启后编辑器区域空白，用户开的文件与分屏全部消失。这是 #59/#79 用户原报的那个 bug。
    await rehydrateFromPreviousVersion({ ...PERSISTED_PREFERENCES })

    const restored = useAppStore.getState().restoredWorkbench
    expect(restored, '整份 Workbench 拓扑没过来——重启后 Tab 和分屏全没了').not.toBeNull()
    expect(
      Object.keys(restored!.tabs),
      '持久化的 file Tab 不在了'
    ).toEqual([PERSISTED_TAB_ID])
    expect(
      restored!.layouts['workspace-alpha']?.groups[0]?.tabOrder,
      '布局里那个 Tab 的位置丢了——Tab 在但分屏塌了'
    ).toEqual([PERSISTED_TAB_ID])
  })

  it('未认领的终端 session id 活着过来', async () => {
    // 症状：这些 id 是「上次退出时没能清理掉的 PTY」的台账。丢了它们，那些进程变成孤儿，
    // 既不会被复用也不会被清理。
    await rehydrateFromPreviousVersion({ ...PERSISTED_PREFERENCES })

    expect(
      useAppStore.getState().unclaimedTerminalSessionIds,
      '未认领终端台账丢了——上次遗留的 PTY 变成永久孤儿'
    ).toEqual(PERSISTED_PREFERENCES.unclaimedTerminalSessionIds)
  })

  it('上次停留的 Workspace 活着过来', async () => {
    // 症状：重启后落到别的项目（或没有项目）上，而不是用户上次在看的那个。
    await rehydrateFromPreviousVersion({ ...PERSISTED_PREFERENCES })

    expect(
      useAppStore.getState().activeWorkspaceId,
      '上次停留的项目丢了——重启后落到别处'
    ).toBe(PERSISTED_PREFERENCES.activeWorkspaceId)
  })

  it('主视图与工具槽位活着过来', async () => {
    // 两项都是 enum，取值刻意都不是默认（默认是 'workbench' / 'files-branches'）：
    // 取默认值时「带过来了」与「重置了」无法区分。
    await rehydrateFromPreviousVersion({ ...PERSISTED_PREFERENCES })

    const state = useAppStore.getState()
    expect(state.mainSurface, '主视图被重置回 workbench').toBe(PERSISTED_PREFERENCES.mainSurface)
    expect(state.workspaceTool, '工具槽位被重置回 files-branches').toBe(
      PERSISTED_PREFERENCES.workspaceTool
    )
  })

  it('前提自检：这五项的 fixture 值都与默认不同', () => {
    // 上面四条若哪天 fixture 漂到默认值上，它们会在实现被改坏时照旧全绿。
    // 判据落在**初始 state**（即默认）上，与 fixture 逐项对比。
    const defaults = initialState as unknown as Record<string, unknown>
    for (const key of [
      'restoredWorkbench',
      'unclaimedTerminalSessionIds',
      'activeWorkspaceId',
      'mainSurface',
      'workspaceTool'
    ] as const) {
      expect(
        JSON.stringify(PERSISTED_PREFERENCES[key]),
        `${key} 的 fixture 值等于默认值——那一条断言已经恒真`
      ).not.toBe(JSON.stringify(defaults[key]))
    }
  })

  it('升级不是"读到了旧记录就报错"——那句 zustand 的抱怨不许出现', async () => {
    // 判据落在 zustand 自己的诊断上，而不是我们的代码：那句话**只**在
    // 「版本不等且没有 migrate」时打印，所以它在场等价于「整份状态刚被丢掉」。
    // 这条与上面那条判的是不同的事：有人写出一个返回 `{}` 的 migrate 时，
    // 上面那条会红而这条会绿，两条一起才说清是哪种坏法。
    const { consoleErrors } = await rehydrateFromPreviousVersion({ ...PERSISTED_PREFERENCES })

    const complaint = consoleErrors
      .flat()
      .filter((entry): entry is string => typeof entry === 'string')
      .find((entry) => entry.includes("couldn't be migrated"))
    expect(complaint, `zustand 说它没法升级这份记录：${String(complaint)}`).toBeUndefined()
  })

  it('声明了 migrate——没有它，上面几条会因为 zustand 静默换成默认值而全红', () => {
    // 一条直白的在场判据，位置在行为断言**之后**：行为断言先红时，失败信息读起来是
    // 「偏好丢了」（症状），这一条补上「因为根本没有 migrate」（原因）。
    expect(typeof useAppStore.persist.getOptions().migrate).toBe('function')
  })

  it('版本相同的记录照旧原样读回（升级路径没有拖累正常路径）', async () => {
    // 边界：绝大多数启动走的是版本相等那条路。migrate 只在不等时被调用，
    // 但一个写坏的 migrate（比如它其实是 merge 的位置）会连带弄坏这条。
    const options = useAppStore.persist.getOptions()
    const backing = new Map<string, string>([
      [options.name, JSON.stringify({ state: { ...PERSISTED_PREFERENCES }, version: options.version })]
    ])
    useAppStore.persist.setOptions({
      storage: createJSONStorage(() => ({
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => { backing.set(key, value) },
        removeItem: (key: string) => { backing.delete(key) }
      }))
    })

    await useAppStore.persist.rehydrate()

    expect(useAppStore.getState().toolDockWidth).toBe(PERSISTED_PREFERENCES.toolDockWidth)
    expect(useAppStore.getState().agentNames).toEqual(PERSISTED_PREFERENCES.agentNames)
  })
})
