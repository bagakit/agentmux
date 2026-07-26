import { describe, expect, it } from 'vitest'
import type { WorkbenchViewLayout } from '../src/renderer/src/lib/workbench-view-layout.js'
import type { WorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  adjacentRegionId,
  handleWorkbenchShortcut,
  isEditableChordTarget,
  resolveWorkbenchShortcut,
  tabIdForOrdinal,
  type WorkbenchShortcutEvent,
  type WorkbenchShortcutStore
} from '../src/renderer/src/lib/workbench-shortcuts.js'

// T-007：应用此前只有一个窗口级快捷键（QuickSwitcher）。这一层证明「哪个键是哪个动作、往哪个方向、
// 切第几张」这套判定是对的，且平台切分守住了「非 mac 不吃裸 Ctrl+字母」这条底线。接线另有一层
// （workbench-shortcut-wiring.test.tsx）——只测判定不够：删掉注册那行时判定测试全绿。

function event(overrides: Partial<WorkbenchShortcutEvent>): WorkbenchShortcutEvent {
  return { key: 'a', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides }
}

describe('选 Tab：Cmd/Ctrl+数字', () => {
  it('mac 上 Cmd+1 选第一张（绝对序号，不是相对切换）', () => {
    expect(resolveWorkbenchShortcut(event({ key: '1', metaKey: true }), true))
      .toEqual({ kind: 'select-tab', ordinal: 1 })
  })

  it('非 mac 上用裸 Ctrl+数字（数字不是 readline 键，可以裸 Ctrl）', () => {
    expect(resolveWorkbenchShortcut(event({ key: '3', ctrlKey: true }), false))
      .toEqual({ kind: 'select-tab', ordinal: 3 })
  })

  it('第 9 键恒指最后一张，而不是要求正好九张', () => {
    expect(resolveWorkbenchShortcut(event({ key: '9', metaKey: true }), true))
      .toEqual({ kind: 'select-tab', ordinal: 'last' })
  })

  it('带 Shift 的 Cmd+数字不是选 Tab', () => {
    expect(resolveWorkbenchShortcut(event({ key: '1', metaKey: true, shiftKey: true }), true)).toBeNull()
  })

  it('0 不是有效序号（只认 1..9）', () => {
    expect(resolveWorkbenchShortcut(event({ key: '0', metaKey: true }), true)).toBeNull()
  })
})

describe('关闭当前 Region', () => {
  it('mac 上是 Cmd+W', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'w', metaKey: true }), true))
      .toEqual({ kind: 'close-region' })
  })

  it('非 mac 上是 Ctrl+Shift+W——裸 Ctrl+W 是 readline 删词，绝不吃', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'w', ctrlKey: true }), false)).toBeNull()
    expect(resolveWorkbenchShortcut(event({ key: 'w', ctrlKey: true, shiftKey: true }), false))
      .toEqual({ kind: 'close-region' })
  })

  it('mac 上带 Shift 的 Cmd+W 不是关闭 Region（那不是 mac 的关闭键形状）', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'w', metaKey: true, shiftKey: true }), true)).toBeNull()
  })
})

describe('分屏', () => {
  it('mac 上 Cmd+D 向右、Cmd+Shift+D 向下', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'd', metaKey: true }), true))
      .toEqual({ kind: 'split', direction: 'right' })
    expect(resolveWorkbenchShortcut(event({ key: 'd', metaKey: true, shiftKey: true }), true))
      .toEqual({ kind: 'split', direction: 'down' })
  })

  it('非 mac 上裸 Ctrl+D 绝不分屏（那是 shell 的 EOF）', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'd', ctrlKey: true }), false)).toBeNull()
    expect(resolveWorkbenchShortcut(event({ key: 'd', ctrlKey: true, shiftKey: true }), false)).toBeNull()
  })

  it('非 mac 上用 Ctrl+Shift+E 向右、Ctrl+Shift+O 向下（基础和弦已含 Shift，改用字母区分方向）', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'e', ctrlKey: true, shiftKey: true }), false))
      .toEqual({ kind: 'split', direction: 'right' })
    expect(resolveWorkbenchShortcut(event({ key: 'o', ctrlKey: true, shiftKey: true }), false))
      .toEqual({ kind: 'split', direction: 'down' })
  })
})

describe('切换焦点格：Cmd/Ctrl+Alt+方向键', () => {
  it('mac 上 Cmd+Alt+方向 给出 focus-region 命令', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'ArrowRight', metaKey: true, altKey: true }), true))
      .toEqual({ kind: 'focus-region', direction: 'right' })
    expect(resolveWorkbenchShortcut(event({ key: 'ArrowUp', metaKey: true, altKey: true }), true))
      .toEqual({ kind: 'focus-region', direction: 'up' })
  })

  it('非 mac 上是 Ctrl+Alt+方向', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'ArrowLeft', ctrlKey: true, altKey: true }), false))
      .toEqual({ kind: 'focus-region', direction: 'left' })
    expect(resolveWorkbenchShortcut(event({ key: 'ArrowDown', ctrlKey: true, altKey: true }), false))
      .toEqual({ kind: 'focus-region', direction: 'down' })
  })

  it('方向键不带 Alt 不是焦点移动（避免与别的 Cmd+方向 惯例撞车）', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'ArrowRight', metaKey: true }), true)).toBeNull()
  })
})

describe('平台底线', () => {
  it('mac 上不吃 Cmd+Ctrl 同按的混合和弦', () => {
    expect(resolveWorkbenchShortcut(event({ key: '1', metaKey: true, ctrlKey: true }), true)).toBeNull()
  })

  it('没有主修饰键时任何键都不是本层的键', () => {
    expect(resolveWorkbenchShortcut(event({ key: '1' }), true)).toBeNull()
    expect(resolveWorkbenchShortcut(event({ key: 'w' }), true)).toBeNull()
  })

  it('Alt 单独作用于非方向键时不解析成任何命令', () => {
    expect(resolveWorkbenchShortcut(event({ key: 'd', metaKey: true, altKey: true }), true)).toBeNull()
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

// 接线层：只测判定不够——删掉 handleWorkbenchShortcut 里任一条 store 调用时，上面的判定测试全绿。
// 这一层证明每条判定真的接到了对应的 store action 上，且不该动手时（非 Workbench 面、落点解析失败）
// 一个 action 都不调、也不吞掉这个键。

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
    splitRegion: (w, t, r, d) => calls.push(`splitRegion:${w}:${t}:${r}:${d}`),
    focusRegion: (w, t, r) => calls.push(`focusRegion:${w}:${t}:${r}`),
    ...overrides
  }
}

describe('接线：handleWorkbenchShortcut 把每条键接到 store', () => {
  it('Cmd+2 调 activateTab，落到焦点组第二张，并吞掉这个键', () => {
    const store = spyStore()
    const handled = handleWorkbenchShortcut(event({ key: '2', metaKey: true }), true, store)
    expect(handled).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t2'])
  })

  it('Cmd+W 在单 Region Tab 上关整张 Tab（走确认流的意图），不是空关 Region', () => {
    // 默认 store 的 t2 是单格 r2——这是最常见的 Tab 状态。任务头号诉求「关不掉」正出在这里：
    // 若还调 closeRegion，removeWorkbenchRegion 见只剩一格会静默不动，键却被吞。改成投 requestCloseTab。
    const store = spyStore()
    const handled = handleWorkbenchShortcut(event({ key: 'w', metaKey: true }), true, store)
    expect(handled).toBe(true)
    // 焦点组活动 Tab 是 t2；关 Tab 要带上组 id 交给组件的确认流。
    expect(store.calls).toEqual(['requestCloseTab:ws:g:t2'])
  })

  it('Cmd+W 在多 Region Tab 上只关活动格，不关整张 Tab', () => {
    // 分屏后的 Tab（t2 分成左右两格，活动在右格 r2R）：Cmd+W 关的是那一格，不是整张 Tab。
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
    const handled = handleWorkbenchShortcut(event({ key: 'w', metaKey: true }), true, store)
    expect(handled).toBe(true)
    expect(store.calls).toEqual(['closeRegion:ws:t2:r2R'])
  })

  it('Cmd+D 调 splitRegion，方向原样带过去', () => {
    const store = spyStore()
    const handled = handleWorkbenchShortcut(event({ key: 'd', metaKey: true, shiftKey: true }), true, store)
    expect(handled).toBe(true)
    expect(store.calls).toEqual(['splitRegion:ws:t2:r2:down'])
  })

  it('Cmd+Alt+方向 调 focusRegion，落到几何相邻格', () => {
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
    const handled = handleWorkbenchShortcut(
      event({ key: 'ArrowRight', metaKey: true, altKey: true }), true, store
    )
    expect(handled).toBe(true)
    expect(store.calls).toEqual(['focusRegion:ws:t2:r2R'])
  })

  it('不是本层的键：一个 action 都不调，也不吞键', () => {
    const store = spyStore()
    const handled = handleWorkbenchShortcut(event({ key: 'z', metaKey: true }), true, store)
    expect(handled).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('非 Workbench 主面时不接管：Cmd+2 原样放行', () => {
    const store = spyStore({ mainSurface: 'board' })
    const handled = handleWorkbenchShortcut(event({ key: '2', metaKey: true }), true, store)
    expect(handled).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('序号越界：解析成命令但落点为空，不调 action、不吞键', () => {
    const store = spyStore()
    const handled = handleWorkbenchShortcut(event({ key: '5', metaKey: true }), true, store)
    expect(handled).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('单格 Tab 向右移焦点没有邻居：不调 focusRegion、不吞键', () => {
    // 默认 store 的 t2 是单格 r2，向右无邻居。
    const store = spyStore()
    const handled = handleWorkbenchShortcut(
      event({ key: 'ArrowRight', metaKey: true, altKey: true }), true, store
    )
    expect(handled).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('序号切 Tab 用的是 Topic 投影后的顺序，与用户所见对齐', () => {
    // 两张 Tab 属于不同 Topic：活动 Tab t-b 绑 topic-b，t-a 绑 topic-a。投影后只剩 topic-b 的 Tab，
    // 于是 Cmd+1 应落到 t-b（投影后的第一张），而不是未过滤时的 t-a。
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
    const handled = handleWorkbenchShortcut(event({ key: '1', metaKey: true }), true, store)
    expect(handled).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t-b'])
  })
})
