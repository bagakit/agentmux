import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { createJSONStorage } from 'zustand/middleware'
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
 */
const PERSISTED_PREFERENCES = {
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
