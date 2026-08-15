import { describe, expect, it } from 'vitest'
import type { WorkbenchViewLayout, WorkspaceLayout } from '@agentmux/layout'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  adjacentRegionId,
  commandForWorkbenchId,
  dispatchWorkbenchCommand,
  isEditableChordTarget,
  tabIdForOrdinal,
  tabIdForStep,
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

  it('previous / next 翻译成方向相反的 step-tab', () => {
    // 两条 id 对调（previous 给 +1）是这类接线最容易出的错，而它在界面上表现为「两个键都能用，只是
    // 方向都反了」——不会崩、不会有报错。所以两个方向都锚字面量。
    expect(commandForWorkbenchId('workbench.previous-tab')).toEqual({ kind: 'step-tab', delta: -1 })
    expect(commandForWorkbenchId('workbench.next-tab')).toEqual({ kind: 'step-tab', delta: 1 })
  })

  it('previous / next 的方向键拼法与括号拼法合流到同一条命令', () => {
    // 「一个动作两个键」的落地判据。两条 .arrow id 各自翻译错（比如方向反了、或返回 null）在现有测试里
    // 完全不可观测：handler 覆盖那条只问「有没有 handler」不问它做什么。
    //
    // 先断相等再断字面量，两者都要：只断相等则两边一起错也绿；只断字面量则「合流」这件事没被表达，
    // 有人把 .arrow 改成另建一条独立命令也照样绿。
    expect(commandForWorkbenchId('workbench.previous-tab.arrow'))
      .toEqual(commandForWorkbenchId('workbench.previous-tab'))
    expect(commandForWorkbenchId('workbench.next-tab.arrow'))
      .toEqual(commandForWorkbenchId('workbench.next-tab'))
    expect(commandForWorkbenchId('workbench.previous-tab.arrow')).toEqual({ kind: 'step-tab', delta: -1 })
    expect(commandForWorkbenchId('workbench.next-tab.arrow')).toEqual({ kind: 'step-tab', delta: 1 })
  })

  it('close / split / focus 各自翻译到对的 kind 与方向', () => {
    expect(commandForWorkbenchId('workbench.close-region')).toEqual({ kind: 'close-region' })
    expect(commandForWorkbenchId('workbench.close-tab')).toEqual({ kind: 'close-tab' })
    expect(commandForWorkbenchId('workbench.new-tab')).toEqual({ kind: 'new-tab' })
    expect(commandForWorkbenchId('workbench.split.right')).toEqual({ kind: 'split', direction: 'right' })
    expect(commandForWorkbenchId('workbench.split.down')).toEqual({ kind: 'split', direction: 'down' })
    expect(commandForWorkbenchId('workbench.focus-region.left')).toEqual({ kind: 'focus-region', direction: 'left' })
    expect(commandForWorkbenchId('workbench.focus-region.right')).toEqual({ kind: 'focus-region', direction: 'right' })
    expect(commandForWorkbenchId('workbench.focus-region.up')).toEqual({ kind: 'focus-region', direction: 'up' })
    expect(commandForWorkbenchId('workbench.focus-region.down')).toEqual({ kind: 'focus-region', direction: 'down' })
  })

  it('swap-region 四个方向翻译到 swap-region kind，方向不串到 focus 那族', () => {
    // 两族由同一条正则翻译，所以最容易出的错不是「某个方向漏了」而是「kind 取错那个捕获组」——那样
    // Shift+方向键会去移焦点（看起来只是 Shift 没生效），或方向键会去换位（一按就把布局搅乱）。
    expect(commandForWorkbenchId('workbench.swap-region.left')).toEqual({ kind: 'swap-region', direction: 'left' })
    expect(commandForWorkbenchId('workbench.swap-region.right')).toEqual({ kind: 'swap-region', direction: 'right' })
    expect(commandForWorkbenchId('workbench.swap-region.up')).toEqual({ kind: 'swap-region', direction: 'up' })
    expect(commandForWorkbenchId('workbench.swap-region.down')).toEqual({ kind: 'swap-region', direction: 'down' })
  })

  it('注册表里每条方向绑定都翻译得出命令，且方向与 id 里那个词逐字相同', () => {
    // 那四个方向词在 `DIRECTION_COMMAND_ID` 里是运行期的一份手抄——`SplitDirection` 只是类型，全仓没有
    // 对应的运行期数组，所以 tsc 挡不住正则与类型分岔。这条守的正是分岔的可观测后果：正则里少一个词，
    // 那条注册表绑定就翻译成 null，按下去静默什么都不发生（handler 覆盖率测试只问 handler 在不在，
    // 不问它翻译不翻译得出）；把某个词拼错成另一个方向，就是「按左键往右走」。
    //
    // 判据不比对某张表，而是把 id 自己的后缀当期望值：kind 与 direction 都必须是 id 里的那两个词。
    const directional = SHORTCUT_BINDINGS
      .map((b) => b.id)
      .filter((id) => id.startsWith('workbench.focus-region.') || id.startsWith('workbench.swap-region.'))
    // 挡板：读成空则下面一条不跑、整条静默通过。
    expect(directional.length, '注册表必须有方向绑定，否则这条守卫是空转').toBe(8)
    for (const id of directional) {
      const [, family, direction] = id.split('.') as [string, string, string]
      expect(commandForWorkbenchId(id), `${id} 必须翻译得出命令`).toEqual({ kind: family, direction })
    }
  })

  it('非 workbench 动作（quick-switch）与未知 id 返回 null', () => {
    expect(commandForWorkbenchId('quick-switch.toggle')).toBeNull()
    expect(commandForWorkbenchId('terminal.search')).toBeNull()
    expect(commandForWorkbenchId('nope')).toBeNull()
  })
})

describe('isEditableChordTarget：终端与其他编辑控件都放行带门的窗口快捷键', () => {
  it('Agent composer 的 textarea、Tab 重命名 input、contentEditable 都放行', () => {
    expect(isEditableChordTarget({ tagName: 'TEXTAREA', isContentEditable: false, insideTerminal: false })).toBe(true)
    expect(isEditableChordTarget({ tagName: 'INPUT', isContentEditable: false, insideTerminal: false })).toBe(true)
    expect(isEditableChordTarget({ tagName: 'DIV', isContentEditable: true, insideTerminal: false })).toBe(true)
  })

  it('终端里的元素一律不放行——capture 存在就是为了抢在 xterm 前拿到键', () => {
    // 即便 xterm 的辅助层本身是个 textarea，在终端子树内也必须让快捷键接管。
    expect(isEditableChordTarget({ tagName: 'TEXTAREA', isContentEditable: false, insideTerminal: true })).toBe(true)
    expect(isEditableChordTarget({ tagName: 'DIV', isContentEditable: true, insideTerminal: true })).toBe(true)
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

describe('tabIdForStep：相对导航，到头回绕', () => {
  const order = ['t1', 't2', 't3']

  it('往后一张 / 往前一张', () => {
    expect(tabIdForStep(order, 't1', 1)).toBe('t2')
    expect(tabIdForStep(order, 't3', -1)).toBe('t2')
  })

  it('两端都回绕——这正是它不能与 tabIdForOrdinal 共用一个函数的原因', () => {
    // `tabIdForOrdinal` 的注释明确说了绝对序号越界**不回绕**（按了不存在的序号当没按）。相对导航反过来：
    // 「下一张」在最后一张上必须回到第一张，否则末尾那张成了死胡同，用户得改用鼠标才回得去。
    // 把实现改成钳制（越界返回 null 或停在原地），这两句就红。
    expect(tabIdForStep(order, 't3', 1)).toBe('t1')
    expect(tabIdForStep(order, 't1', -1)).toBe('t3')
  })

  it('只有一张时回绕到自己，而不是 null——「只有一张」和「一张都没有」是两回事', () => {
    expect(tabIdForStep(['only'], 'only', 1)).toBe('only')
    expect(tabIdForStep(['only'], 'only', -1)).toBe('only')
  })

  it('一张都没有时返回 null：这时才该什么都不做', () => {
    expect(tabIdForStep([], null, 1)).toBeNull()
    expect(tabIdForStep([], 't1', -1)).toBeNull()
  })

  it('当前 Tab 不在序里（刚被关掉 / 活动项为 null）时，往后落到首张、往前落到末张', () => {
    // 这两个落点都必须**显式**取两端。第一版实现让 `indexOf` 的 -1 直接参与取模，往后一张恰好对
    // （-1+1=0），往前一张却算成 length-2 落到中间那张（三张时是 t2）——一张毫无道理的 Tab。
    // 若谁改成「找不到就返回 null」，这条同样红，而那会让「刚关掉一张后按下一张」变成什么都不发生。
    expect(tabIdForStep(order, null, 1)).toBe('t1')
    expect(tabIdForStep(order, null, -1)).toBe('t3')
    expect(tabIdForStep(order, 'gone', 1)).toBe('t1')
    expect(tabIdForStep(order, 'gone', -1)).toBe('t3')
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
    // 默认没有 Agent 投影：`attention.next` 的落点由 next-attention-shortcut.test.ts 单独喂 fixture，
    // 这里只让它有个空队列可读，于是覆盖率那条用例调它时不会炸在 undefined 上。
    sessions: [],
    selectSession: (id) => calls.push(`selectSession:${id}`),
    activateTab: (w, g, t) => calls.push(`activateTab:${w}:${g}:${t}`),
    openLauncher: (g) => calls.push(`openLauncher:${g ?? ''}`),
    closeRegion: (w, t, r) => { calls.push(`closeRegion:${w}:${t}:${r}`) },
    requestCloseTab: (w, g, t) => calls.push(`requestCloseTab:${w}:${g}:${t}`),
    requestCloseRegion: (w, t, r) => calls.push(`requestCloseRegion:${w}:${t}:${r}`),
    splitRegion: (w, t, r, d) => calls.push(`splitRegion:${w}:${t}:${r}:${d}`),
    focusRegion: (w, t, r) => calls.push(`focusRegion:${w}:${t}:${r}`),
    swapRegions: (w, t, a, b) => calls.push(`swapRegions:${w}:${t}:${a}:${b}`),
    ...overrides
  }
}

/** 走与 App 相同的全链：id → 命令 → dispatch。命令翻译不出来（非 workbench id）视为不吃这个键。 */
function dispatchId(id: string, store: WorkbenchShortcutStore): boolean {
  const command = commandForWorkbenchId(id)
  return command ? dispatchWorkbenchCommand(command, store) : false
}

/**
 * 默认 store 里那张活动 Tab（t2）左右分成两格，活动格由 `activeRegionId` 指定。
 *
 * 移焦点与换位共用同一份布局，是为了让「两者在同一方向上解出同一个邻格」这条断言有意义：各自造一份看起来
 * 一样的 fixture，就有可能一边写成左右分屏、另一边写成上下分屏，而两条测试各自都绿。
 */
function sideBySideTab(activeRegionId: 'r2L' | 'r2R'): WorkbenchTab {
  return {
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
      activeRegionId
    },
    regions: {
      r2L: { regionId: 'r2L', kind: 'launcher', workspaceId: 'ws' },
      r2R: { regionId: 'r2R', kind: 'launcher', workspaceId: 'ws' }
    }
  }
}

describe('接线：命令转发到 store action', () => {
  it('select-tab.2 调 activateTab，落到焦点组第二张，并吞掉这个键', () => {
    const store = spyStore()
    expect(dispatchId('workbench.select-tab.2', store)).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t2'])
  })

  it('step-tab 从活动那张往后一张调 activateTab', () => {
    // 默认 store 的组是 t1/t2/t3，活动在 t2。
    const store = spyStore()
    expect(dispatchId('workbench.next-tab', store)).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t3'])
  })

  it('step-tab 在末张按「下一张」回绕到首张，而不是什么都不做', () => {
    // 这一条守的是**接线**这一侧：纯函数会回绕，但 dispatch 若把 `!tabId` 之外又加了自己的越界判断
    // （或干脆用 tabIdForOrdinal 算），末张上按下一张就静默失效。
    const store = spyStore({
      layouts: {
        ws: {
          root: { type: 'leaf', groupId: 'g' },
          groups: [{ id: 'g', tabOrder: ['t1', 't2', 't3'], activeTabId: 't3', recentTabIds: ['t3'] }],
          activeGroupId: 'g'
        }
      }
    })
    expect(dispatchId('workbench.next-tab', store)).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t1'])
  })

  it('step-tab 往前一张的方向真的相反——两条 id 接反不会崩，只会方向全错', () => {
    const store = spyStore()
    expect(dispatchId('workbench.previous-tab', store)).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t1'])
  })

  it('step-tab 走的是 Topic 投影后的顺序，与序号切 Tab 同一份序', () => {
    // 三张 Tab，中间那张属于另一个 Topic：投影后组里只剩 t-a、t-c，活动在 t-a。「下一张」必须落到 t-c
    // ——若谁改成从未投影的 tabOrder 算，会落到用户根本看不见的 t-b 上（界面表现为按了一下什么都没变）。
    const layout: WorkspaceLayout = {
      root: { type: 'leaf', groupId: 'g' },
      groups: [
        { id: 'g', tabOrder: ['t-a', 't-b', 't-c'], activeTabId: 't-a', recentTabIds: ['t-a'] }
      ],
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
      tabs: {
        't-a': tabWithTopic('t-a', 'topic-1'),
        't-b': tabWithTopic('t-b', 'topic-2'),
        't-c': tabWithTopic('t-c', 'topic-1')
      }
    })
    expect(dispatchId('workbench.next-tab', store)).toBe(true)
    expect(store.calls).toEqual(['activateTab:ws:g:t-c'])
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

  it('close-tab 在分屏 Tab 上仍关整张 Tab，这正是它与 close-region 的区别', () => {
    // fixture 必须是分屏。单格时两条命令都走 requestCloseTab，于是「close-tab 误接成 requestCloseRegion」
    // 这个变异在单格 fixture 上完全不可观测——两个世界给同一份 calls。分屏才把两者分开。
    const store = spyStore({ tabs: { t2: sideBySideTab('r2R') } })
    expect(dispatchId('workbench.close-tab', store)).toBe(true)
    expect(store.calls).toEqual(['requestCloseTab:ws:g:t2'])
  })

  it('同一张分屏 Tab 上，close-region 与 close-tab 关的不是同一个东西', () => {
    // 上面两条各自绿，不等于两者有区别：都写成 requestCloseTab 也能各自绿。这条把「区别」本身钉住——
    // 同一份 fixture 喂两条命令，产出必须不同。任何把两条实现折成一份的改法都在这里红。
    const tabs = { t2: sideBySideTab('r2R') }
    const closeRegionStore = spyStore({ tabs })
    const closeTabStore = spyStore({ tabs })
    expect(dispatchId('workbench.close-region', closeRegionStore)).toBe(true)
    expect(dispatchId('workbench.close-tab', closeTabStore)).toBe(true)
    expect(closeTabStore.calls).not.toEqual(closeRegionStore.calls)
  })

  it('new-tab 调 openLauncher，落点是投影后的活动组，并吃下这个键', () => {
    // 落点传的是投影后的 group.id，不是让 openLauncher 自己兜底读原始 activeGroupId——Topic 过滤后
    // 两者可以不是同一个组。把 `store.openLauncher(group.id)` 改成 `store.openLauncher()` 这条就红。
    const store = spyStore()
    expect(dispatchId('workbench.new-tab', store)).toBe(true)
    expect(store.calls).toEqual(['openLauncher:g'])
  })

  it('非 Workbench 主面时 new-tab 不接管：不调 openLauncher，也不吞键', () => {
    const store = spyStore({ mainSurface: 'board' })
    expect(dispatchId('workbench.new-tab', store)).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('split.down 调 splitRegion，方向原样带过去', () => {
    const store = spyStore()
    expect(dispatchId('workbench.split.down', store)).toBe(true)
    expect(store.calls).toEqual(['splitRegion:ws:t2:r2:down'])
  })

  it('focus-region.right 调 focusRegion，落到几何相邻格', () => {
    // 活动 Tab t2 分成左右两格，活动在左格 r2L，向右应聚焦 r2R。
    const store = spyStore({ tabs: { t2: sideBySideTab('r2L') } })
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

  it('swap-region.right 调 swapRegions(活动格, 那个方向的邻格)，且不顺手改焦点', () => {
    const store = spyStore({ tabs: { t2: sideBySideTab('r2L') } })
    expect(dispatchId('workbench.swap-region.right', store)).toBe(true)
    // 两个端点的**顺序**也是判据：第一个必须是活动格。两端反了今天恰好无害（换位是对称的），但这一层
    // 的合同是「把我和那边换」，而合法性守卫（swapWorkbenchRegions 拒绝与自己换）读的是这两个位置。
    // 恰好只有一条调用：焦点必须留在原格，否则连按两下方向键的出发点就变了，同一手势第二次做别的事。
    expect(store.calls).toEqual(['swapRegions:ws:t2:r2L:r2R'])
  })

  it('swap-region 与 focus-region 在同一份布局上解出同一个邻格', () => {
    // 承重的收拢点：两者共用同一次 adjacentRegionId。若哪天换位自己算一套几何，界面上就是「方向键走到
    // A、Shift+方向键把内容换给 B」——两个手势对同一个方向给出不同答案，而各自单独看都说得通。
    // 判据不是「都等于 r2R」这个字面量，而是**两条路解出的第二个端点逐字相同**：换掉几何实现时两边一起
    // 变、这条仍绿；只改一边就红。
    const tabs = { t2: sideBySideTab('r2L') }
    const focusStore = spyStore({ tabs })
    expect(dispatchId('workbench.focus-region.right', focusStore)).toBe(true)
    const swapStore = spyStore({ tabs })
    expect(dispatchId('workbench.swap-region.right', swapStore)).toBe(true)
    const focused = focusStore.calls[0]!.split(':').at(-1)
    const swapTarget = swapStore.calls[0]!.split(':').at(-1)
    expect(swapTarget, '换位的落点必须与移焦点的落点是同一格').toBe(focused)
    // 挡板：两边都读成 undefined 时上面恒真。
    expect(focused).toBeTruthy()
  })

  it('单格 Tab 换位没有邻居：不调 swapRegions、不吞键（放行给别处）', () => {
    // 与移焦点同一条边界：到边不吃这个键。若换位在这里改成「和自己换」，store 层虽然会拒绝，但这个键就被
    // 吞掉了——用户按 Shift+→ 到了最右一格之后，浏览器/终端里那个键从此静默失效。
    const store = spyStore()
    expect(dispatchId('workbench.swap-region.right', store)).toBe(false)
    expect(store.calls).toEqual([])
  })

  it('非 Workbench 主面时换位也不接管', () => {
    const store = spyStore({ mainSurface: 'board', tabs: { t2: sideBySideTab('r2L') } })
    expect(dispatchId('workbench.swap-region.right', store)).toBe(false)
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
