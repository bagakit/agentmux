import { describe, expect, it } from 'vitest'
import type { WorkbenchViewLayout } from '../src/renderer/src/lib/workbench-view-layout.js'
import type { WorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  adjacentRegionId,
  commandForWorkbenchId,
  dispatchWorkbenchCommand,
  isEditableChordTarget,
  tabIdForOrdinal,
  windowShortcutHandlers,
  workbenchWindowBindingIds,
  type WorkbenchShortcutStore
} from '../src/renderer/src/lib/workbench-shortcuts.js'
import { SHORTCUT_BINDINGS } from '../src/renderer/src/lib/shortcut-registry.js'

// 哪个键是哪个动作（含平台切分、非 mac 底线、门）由 shortcut-registry.test.ts 守。这里守的是本层的三件
// 事：1) id → 命令的翻译；2) 命令 → 落点 → store action 的转发（接线，删掉任一转发都要红）；3) window
// handler map 覆盖注册表里每一条 window 绑定（「路由一半」的补法）。

// ---------------------------------------------------------------------------
// id → 命令翻译。改错某条的方向/序号、把两条 id 对调，都要红。期望值锚字面量。
// ---------------------------------------------------------------------------
describe('commandForWorkbenchId：绑定 id 翻译成命令', () => {
  it('select-tab.1..8 是绝对序号，.9 恒指最后一张', () => {
    expect(commandForWorkbenchId('workbench.select-tab.1')).toEqual({ kind: 'select-tab', ordinal: 1 })
    expect(commandForWorkbenchId('workbench.select-tab.8')).toEqual({ kind: 'select-tab', ordinal: 8 })
    expect(commandForWorkbenchId('workbench.select-tab.9')).toEqual({ kind: 'select-tab', ordinal: 'last' })
  })

  it('close / split / focus 各自翻译到对的 kind 与方向', () => {
    expect(commandForWorkbenchId('workbench.close-region')).toEqual({ kind: 'close-region' })
    expect(commandForWorkbenchId('workbench.split.right')).toEqual({ kind: 'split', direction: 'right' })
    expect(commandForWorkbenchId('workbench.split.down')).toEqual({ kind: 'split', direction: 'down' })
    expect(commandForWorkbenchId('workbench.focus-region.left')).toEqual({ kind: 'focus-region', direction: 'left' })
    expect(commandForWorkbenchId('workbench.focus-region.right')).toEqual({ kind: 'focus-region', direction: 'right' })
    expect(commandForWorkbenchId('workbench.focus-region.up')).toEqual({ kind: 'focus-region', direction: 'up' })
    expect(commandForWorkbenchId('workbench.focus-region.down')).toEqual({ kind: 'focus-region', direction: 'down' })
  })

  it('非 workbench 动作（quick-switch）与未知 id 返回 null', () => {
    expect(commandForWorkbenchId('quick-switch.toggle')).toBeNull()
    expect(commandForWorkbenchId('terminal.search')).toBeNull()
    expect(commandForWorkbenchId('nope')).toBeNull()
  })
})

describe('isEditableChordTarget：非终端可编辑控件放行，终端焦点仍接管', () => {
  it('Agent composer 的 textarea、Tab 重命名 input、contentEditable 都放行', () => {
    expect(isEditableChordTarget({ tagName: 'TEXTAREA', isContentEditable: false, insideTerminal: false })).toBe(true)
    expect(isEditableChordTarget({ tagName: 'INPUT', isContentEditable: false, insideTerminal: false })).toBe(true)
    expect(isEditableChordTarget({ tagName: 'DIV', isContentEditable: true, insideTerminal: false })).toBe(true)
  })

  it('终端里的元素一律不放行——capture 存在就是为了抢在 xterm 前拿到键', () => {
    // 即便 xterm 的辅助层本身是个 textarea，在终端子树内也必须让快捷键接管。
    expect(isEditableChordTarget({ tagName: 'TEXTAREA', isContentEditable: false, insideTerminal: true })).toBe(false)
    expect(isEditableChordTarget({ tagName: 'DIV', isContentEditable: true, insideTerminal: true })).toBe(false)
  })

  it('普通非可编辑元素不放行（快捷键照常接管）', () => {
    expect(isEditableChordTarget({ tagName: 'BUTTON', isContentEditable: false, insideTerminal: false })).toBe(false)
    expect(isEditableChordTarget({ tagName: 'DIV', isContentEditable: false, insideTerminal: false })).toBe(false)
  })
})

describe('tabIdForOrdinal', () => {
  const order = ['t1', 't2', 't3']

  it('1 基取序号', () => {
    expect(tabIdForOrdinal(order, 1)).toBe('t1')
    expect(tabIdForOrdinal(order, 3)).toBe('t3')
  })

  it('last 取末尾', () => {
    expect(tabIdForOrdinal(order, 'last')).toBe('t3')
  })

  it('越界不回绕，返回 null', () => {
    expect(tabIdForOrdinal(order, 5)).toBeNull()
    expect(tabIdForOrdinal([], 'last')).toBeNull()
  })
})

describe('adjacentRegionId：按屏幕几何找相邻格', () => {
  // 左右并排两格，活动在左。
  function twoAcross(activeRegionId: string): WorkbenchViewLayout {
    return {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', regionId: 'L' },
        second: { type: 'leaf', regionId: 'R' },
        ratio: 0.5
      },
      activeRegionId
    }
  }

  it('单格没有邻居', () => {
    expect(adjacentRegionId({ root: { type: 'leaf', regionId: 'only' }, activeRegionId: 'only' }, 'right'))
      .toBeNull()
  })

  it('左格向右找到右格；已在最右向右无邻居', () => {
    expect(adjacentRegionId(twoAcross('L'), 'right')).toBe('R')
    expect(adjacentRegionId(twoAcross('R'), 'right')).toBeNull()
  })

  it('右格向左找到左格', () => {
    expect(adjacentRegionId(twoAcross('R'), 'left')).toBe('L')
  })

  it('三列并排时取最近的一格，不是最远的——距离比较真的在起作用', () => {
    // A | B | C 三列。从 A 向右应到相邻的 B（而不是更远的 C）；从 C 向左应到 B。
    // 单候选的双格布局证明不了这点：reduce 只有一个候选时，距离公式写反也照样返回它。
    const threeAcross = (activeRegionId: string): WorkbenchViewLayout => ({
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', regionId: 'A' },
        second: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', regionId: 'B' },
          second: { type: 'leaf', regionId: 'C' },
          ratio: 0.5
        },
        ratio: 1 / 3
      },
      activeRegionId
    })
    expect(adjacentRegionId(threeAcross('A'), 'right')).toBe('B')
    expect(adjacentRegionId(threeAcross('C'), 'left')).toBe('B')
  })

  it('三行叠放时上下取最近的一行，不是最远的', () => {
    // A / B / C 三行。从 A 向下应到相邻的 B（而不是更远的 C）；从 C 向上应到 B。
    const threeStacked = (activeRegionId: string): WorkbenchViewLayout => ({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', regionId: 'A' },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', regionId: 'B' },
          second: { type: 'leaf', regionId: 'C' },
          ratio: 0.5
        },
        ratio: 1 / 3
      },
      activeRegionId
    })
    expect(adjacentRegionId(threeStacked('A'), 'down')).toBe('B')
    expect(adjacentRegionId(threeStacked('C'), 'up')).toBe('B')
  })

  it('左右布局里上下方向没有邻居——不把水平邻居错当成上下', () => {
    expect(adjacentRegionId(twoAcross('L'), 'down')).toBeNull()
    expect(adjacentRegionId(twoAcross('L'), 'up')).toBeNull()
  })

  it('2x2 网格里向右只到同一行的邻居，斜对角那格不算相邻——另一轴必须重叠', () => {
    // 上排 TL|TR，下排 BL|BR。活动在 TL：向右应到 TR（同一行），绝不越到斜对角的 BR；
    // 向下应到 BL（同一列），绝不到 TR。关掉「另一轴重叠」判定，斜对角会被误算成相邻。
    const grid = (activeRegionId: string): WorkbenchViewLayout => ({
      root: {
        type: 'split',
        direction: 'vertical',
        first: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', regionId: 'TL' },
          second: { type: 'leaf', regionId: 'TR' },
          ratio: 0.5
        },
        second: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', regionId: 'BL' },
          second: { type: 'leaf', regionId: 'BR' },
          ratio: 0.5
        },
        ratio: 0.5
      },
      activeRegionId
    })
    expect(adjacentRegionId(grid('TL'), 'right')).toBe('TR')
    expect(adjacentRegionId(grid('TL'), 'down')).toBe('BL')
    expect(adjacentRegionId(grid('BR'), 'up')).toBe('TR')
    expect(adjacentRegionId(grid('BR'), 'left')).toBe('BL')
  })

  it('嵌套分屏里方向是几何的，不是树深度的：右上格向下找到右下格', () => {
    // 左边一整格 A；右边上下再分成 B(上)/C(下)。活动在 B，向下应到 C。
    const layout: WorkbenchViewLayout = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', regionId: 'A' },
        second: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', regionId: 'B' },
          second: { type: 'leaf', regionId: 'C' },
          ratio: 0.5
        },
        ratio: 0.5
      },
      activeRegionId: 'B'
    }
    expect(adjacentRegionId(layout, 'down')).toBe('C')
    // B 向左应到 A（纵向有重叠），向上没有邻居。
    expect(adjacentRegionId(layout, 'left')).toBe('A')
    expect(adjacentRegionId(layout, 'up')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 接线层：只测翻译不够——删掉 dispatchWorkbenchCommand 里任一条 store 调用时，上面的翻译测试全绿。
// 这一层证明每条命令真的接到了对应的 store action 上，且不该动手时（非 Workbench 面、落点解析失败）
// 一个 action 都不调、也不吞掉这个键。落点用 id → 命令 → dispatch 全链跑，与 App 走同一条路。
// ---------------------------------------------------------------------------

function spyStore(overrides: Partial<WorkbenchShortcutStore> = {}): WorkbenchShortcutStore & {
  calls: string[]
} {
  const calls: string[] = []
  const singleGroupLayout: WorkspaceLayout = {
    root: { type: 'leaf', groupId: 'g' },
    groups: [{ id: 'g', tabOrder: ['t1', 't2', 't3'], activeTabId: 't2', recentTabIds: ['t2'] }],
    activeGroupId: 'g'
  }
  const tab = (id: string, activeRegionId: string): WorkbenchTab => ({
    id,
    workspaceId: 'ws',
    titleRegionId: activeRegionId,
    layout: { root: { type: 'leaf', regionId: activeRegionId }, activeRegionId },
    regions: { [activeRegionId]: { regionId: activeRegionId, kind: 'launcher', workspaceId: 'ws' } }
  })
  return {
    calls,
    mainSurface: 'workbench',
    activeWorkspaceId: 'ws',
    layouts: { ws: singleGroupLayout },
    tabs: { t1: tab('t1', 'r1'), t2: tab('t2', 'r2'), t3: tab('t3', 'r3') },
    activateTab: (w, g, t) => calls.push(`activateTab:${w}:${g}:${t}`),
    closeRegion: (w, t, r) => { calls.push(`closeRegion:${w}:${t}:${r}`) },
    requestCloseTab: (w, g, t) => calls.push(`requestCloseTab:${w}:${g}:${t}`),
    requestCloseRegion: (w, t, r) => calls.push(`requestCloseRegion:${w}:${t}:${r}`),
    splitRegion: (w, t, r, d) => calls.push(`splitRegion:${w}:${t}:${r}:${d}`),
    focusRegion: (w, t, r) => calls.push(`focusRegion:${w}:${t}:${r}`),
    ...overrides
  }
}

/** 走与 App 相同的全链：id → 命令 → dispatch。命令翻译不出来（非 workbench id）视为不吃这个键。 */
function dispatchId(id: string, store: WorkbenchShortcutStore): boolean {
  const command = commandForWorkbenchId(id)
  return command ? dispatchWorkbenchCommand(command, store) : false
}

describe('接线：命令转发到 store action', () => {
  it('select-tab.2 调 activateTab，落到焦点组第二张，并吞掉这个键', () => {
    const store = spyStore()
    expect(dispatchId('workbench.select-tab.2', store)).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t2'])
  })

  it('close-region 在单 Region Tab 上关整张 Tab（走确认流的意图），不是空关 Region', () => {
    // 默认 store 的 t2 是单格 r2——这是最常见的 Tab 状态。任务头号诉求「关不掉」正出在这里：
    // 若还调 closeRegion，removeWorkbenchRegion 见只剩一格会静默不动，键却被吞。改成投 requestCloseTab。
    const store = spyStore()
    expect(dispatchId('workbench.close-region', store)).toBe(true)
    expect(store.calls).toEqual(['requestCloseTab:ws:g:t2'])
  })

  it('close-region 在多 Region Tab 上投「关这一格」的意图，不裸调 closeRegion', () => {
    // 分屏后的 Tab（t2 分成左右两格，活动在右格 r2R）：关的是那一格，不是整张 Tab。但不能裸调
    // closeRegion——那条路没有脏检查，会静默弃掉那一格未保存的编辑器改动，而鼠标点这一格的 X 会先弹
    // 「未保存确认」。同一个「关这一格」只能有一个决定出口。把这行改回 `void store.closeRegion(...)`
    // （只接了一侧出口），这条断言就红。
    const splitTab: WorkbenchTab = {
      id: 't2',
      workspaceId: 'ws',
      titleRegionId: 'r2L',
      layout: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', regionId: 'r2L' },
          second: { type: 'leaf', regionId: 'r2R' },
          ratio: 0.5
        },
        activeRegionId: 'r2R'
      },
      regions: {
        r2L: { regionId: 'r2L', kind: 'launcher', workspaceId: 'ws' },
        r2R: { regionId: 'r2R', kind: 'launcher', workspaceId: 'ws' }
      }
    }
    const store = spyStore({ tabs: { t2: splitTab } })
    expect(dispatchId('workbench.close-region', store)).toBe(true)
    expect(store.calls).toEqual(['requestCloseRegion:ws:t2:r2R'])
  })

  it('split.down 调 splitRegion，方向原样带过去', () => {
    const store = spyStore()
    expect(dispatchId('workbench.split.down', store)).toBe(true)
    expect(store.calls).toEqual(['splitRegion:ws:t2:r2:down'])
  })

  it('focus-region.right 调 focusRegion，落到几何相邻格', () => {
    // 活动 Tab t2 分成左右两格，活动在左格 r2L，向右应聚焦 r2R。
    const splitTab: WorkbenchTab = {
      id: 't2',
      workspaceId: 'ws',
      titleRegionId: 'r2L',
      layout: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', regionId: 'r2L' },
          second: { type: 'leaf', regionId: 'r2R' },
          ratio: 0.5
        },
        activeRegionId: 'r2L'
      },
      regions: {
        r2L: { regionId: 'r2L', kind: 'launcher', workspaceId: 'ws' },
        r2R: { regionId: 'r2R', kind: 'launcher', workspaceId: 'ws' }
      }
    }
    const store = spyStore({ tabs: { t2: splitTab } })
    expect(dispatchId('workbench.focus-region.right', store)).toBe(true)
    expect(store.calls).toEqual(['focusRegion:ws:t2:r2R'])
  })

  it('非 Workbench 主面时不接管：一个 action 都不调，也不吞键', () => {
    const store = spyStore({ mainSurface: 'board' })
    expect(dispatchId('workbench.select-tab.2', store)).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('序号越界：翻译成命令但落点为空，不调 action、不吞键', () => {
    const store = spyStore()
    expect(dispatchId('workbench.select-tab.5', store)).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('单格 Tab 向右移焦点没有邻居：不调 focusRegion、不吞键', () => {
    // 默认 store 的 t2 是单格 r2，向右无邻居。
    const store = spyStore()
    expect(dispatchId('workbench.focus-region.right', store)).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('序号切 Tab 用的是 Topic 投影后的顺序，与用户所见对齐', () => {
    // 两张 Tab 属于不同 Topic：活动 Tab t-b 绑 topic-b，t-a 绑 topic-a。投影后只剩 topic-b 的 Tab，
    // 于是 select-tab.1 应落到 t-b（投影后的第一张），而不是未过滤时的 t-a。
    const layout: WorkspaceLayout = {
      root: { type: 'leaf', groupId: 'g' },
      groups: [{ id: 'g', tabOrder: ['t-a', 't-b'], activeTabId: 't-b', recentTabIds: ['t-b'] }],
      activeGroupId: 'g'
    }
    const tabWithTopic = (id: string, topicId: string): WorkbenchTab => ({
      id,
      workspaceId: 'ws',
      topicId,
      titleRegionId: `r-${id}`,
      layout: { root: { type: 'leaf', regionId: `r-${id}` }, activeRegionId: `r-${id}` },
      regions: { [`r-${id}`]: { regionId: `r-${id}`, kind: 'launcher', workspaceId: 'ws' } }
    })
    const store = spyStore({
      layouts: { ws: layout },
      tabs: { 't-a': tabWithTopic('t-a', 'topic-a'), 't-b': tabWithTopic('t-b', 'topic-b') }
    })
    expect(dispatchId('workbench.select-tab.1', store)).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t-b'])
  })
})

// ---------------------------------------------------------------------------
// window handler map 覆盖率：「路由一半」的补法。这份 map 必须为注册表里每一条 window scope 绑定都提供
// handler——漏一条（比如新增一个 workbench 绑定却忘了接线），那个键按了就静默什么都不发生。
// ---------------------------------------------------------------------------
describe('windowShortcutHandlers 覆盖注册表每一条 window 绑定', () => {
  it('每条 window scope 绑定 id 在 handler map 里都有 handler', () => {
    const store = spyStore()
    let toggled = 0
    let helpToggled = 0
    const handlers = windowShortcutHandlers(store, {
      toggleQuickSwitch: () => { toggled += 1 },
      toggleShortcutsHelp: () => { helpToggled += 1 }
    })
    const windowIds = SHORTCUT_BINDINGS.filter((b) => b.scope === 'window').map((b) => b.id)
    for (const id of windowIds) {
      expect(typeof handlers[id], `no handler for window binding ${id}`).toBe('function')
    }
    // 反向自证：map 里没有多出注册表以外的 window id（除 quick-switch/help 外全部来自 workbench 定义域）。
    expect(new Set(Object.keys(handlers))).toEqual(new Set(windowIds))
    // quick-switch handler 真的接到了 toggle 上，且返回吃下（纯切换恒 true）。
    expect(handlers['quick-switch.toggle']!()).toBe(true)
    expect(toggled).toBe(1)
    // help handler 同样接到了自己的 toggle 上——它是 quick-switch 之外第二条非 workbench 的 window 绑定，
    // 接错到别的 action 上（或漏接）这里就红。
    expect(handlers['help.shortcuts']!()).toBe(true)
    expect(helpToggled).toBe(1)
    expect(toggled).toBe(1)
  })

  it('workbench handler 转发到 dispatch：select-tab.2 打到 activateTab', () => {
    const store = spyStore()
    const handlers = windowShortcutHandlers(store, { toggleQuickSwitch: () => {}, toggleShortcutsHelp: () => {} })
    expect(handlers['workbench.select-tab.2']!()).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t2'])
  })

  it('workbenchWindowBindingIds 恰好是注册表里能翻译成命令的 window 绑定', () => {
    // SSOT 自证：从注册表过滤出来的 id 集合，与「scope window 且 commandForWorkbenchId 认得」一致。
    const expected = SHORTCUT_BINDINGS
      .filter((b) => b.scope === 'window' && commandForWorkbenchId(b.id) !== null)
      .map((b) => b.id)
    expect(new Set(workbenchWindowBindingIds())).toEqual(new Set(expected))
    // 且不含 quick-switch（它不是 workbench 命令）。
    expect(workbenchWindowBindingIds()).not.toContain('quick-switch.toggle')
  })
})
