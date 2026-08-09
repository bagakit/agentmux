import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import {
  REGION_FOCUS_CAUSES,
  regionCaretFocusTargets,
  regionFocusClaimsCaret,
  type RegionFocusCause
} from '../src/renderer/src/lib/region-focus.js'
import {
  commandForWorkbenchId,
  dispatchWorkbenchCommand,
  type WorkbenchShortcutStore
} from '../src/renderer/src/lib/workbench-shortcuts.js'
import { createWorkspaceLayout, regionIds } from '@agentmux/layout'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'

/**
 * 键盘移焦点必须**连带把打字光标（DOM caret）搬进目标格**，而不是只挪绿框。
 *
 * 缺陷（提交 39db592 的连坐）：`Cmd+Alt+方向` 走 `store.focusRegion` 只改 `activeRegionId`（绿框），而看不见的
 * DOM 焦点仍停在上一格的 xterm/Monaco 上——用户切到右格接着打字，字全进了左格那个 agent。隐蔽处在「一半是
 * 对的」：后续布局命令读已更新的 `activeRegionId` 落点正确，只有敲键盘这一件事错。
 *
 * 修法：一次落焦除了搬绿框，要不要抢 caret 由这次落焦的**因**（cause）决定——键盘导航要抢，指针点击不抢
 * （原生 mousedown 已把焦点放对）。判定是纯的；机制是一条按 regionId 定位的一次性意图（store.regionCaretFocus，
 * consume-and-clear），承载被点名那格的表面消费它把 .focus() 搬过来。
 *
 * 本文件三层：纯判定（cause→抢不抢 / 意图匹配器）、store（键盘投意图、指针不投、清除只认自己）、以及键盘
 * dispatch 真的把 cause='keyboard' 传下去。表面消费侧那条 effect 在 node 环境跑不到，由 region-caret-focus-wiring
 * 用可达性 AST 判据守。
 */

const initialState = useAppStore.getState()
afterEach(() => useAppStore.setState(initialState, true))

describe('regionFocusClaimsCaret：谁触发的落焦决定抢不抢 caret', () => {
  it('键盘导航抢 caret，指针点击不抢', () => {
    expect(
      regionFocusClaimsCaret('keyboard'),
      '键盘导航不抢 caret——绿框移了、键入没移，字进上一格（本缺陷本体）'
    ).toBe(true)
    expect(
      regionFocusClaimsCaret('pointer'),
      '指针点击抢 caret——原生 mousedown 已把焦点放对，再抢一次会打断选择/原生行为'
    ).toBe(false)
  })

  it('穷举全部 cause：恰好一种抢 caret，且是键盘那种', () => {
    // 判据落在「果」的分布上而不是逐个字面量：把决策取反（`=== 'pointer'`）会让抢/不抢整体对调，
    // 这里立刻红；把两种都判成抢（`true`）或都不抢（`false`）也红——恰好一个为真且是 keyboard。
    const claiming = REGION_FOCUS_CAUSES.filter((cause) => regionFocusClaimsCaret(cause))
    expect(claiming, `抢 caret 的 cause 应恰好一种，实测 [${claiming.join(', ')}]`).toEqual(['keyboard'])
    // 自检：cause 表本身覆盖了两种值，否则上面那条在「只有一种 cause」的表下恒真。
    expect(new Set<RegionFocusCause>(REGION_FOCUS_CAUSES).size).toBe(2)
  })
})

describe('regionCaretFocusTargets：一条意图是否精确点名这一格', () => {
  it('regionId 相等才算点名；null 意图 / null 本格 / 不同 id 都不算', () => {
    const request = { regionId: 'r-2', nonce: 3 }
    expect(regionCaretFocusTargets(request, 'r-2'), '同一 regionId 竟然不匹配').toBe(true)
    expect(regionCaretFocusTargets(request, 'r-1'), '别的格的意图匹配到了本格——每格都抢焦点').toBe(false)
    expect(regionCaretFocusTargets(null, 'r-2'), '没有意图时也匹配——会凭空抢焦点').toBe(false)
    expect(regionCaretFocusTargets(undefined, 'r-2')).toBe(false)
    expect(regionCaretFocusTargets(request, null), '本格没有 regionId（如 browser 无 origin）时匹配了').toBe(false)
    expect(regionCaretFocusTargets(request, undefined)).toBe(false)
  })
})

/** dispatch 的落点解析要一份最小 store：单张活动 Tab 左右两格，活动在左格。 */
function spyStoreSideBySide(): WorkbenchShortcutStore & { caretCauses: string[] } {
  const caretCauses: string[] = []
  const noop = (): void => {}
  return {
    caretCauses,
    mainSurface: 'workbench',
    activeWorkspaceId: 'ws',
    layouts: {
      ws: {
        root: { type: 'leaf', groupId: 'g' },
        groups: [{ id: 'g', tabOrder: ['t'], activeTabId: 't', recentTabIds: ['t'] }],
        activeGroupId: 'g'
      }
    },
    tabs: {
      t: {
        id: 't',
        workspaceId: 'ws',
        titleRegionId: 'rL',
        layout: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', regionId: 'rL' },
            second: { type: 'leaf', regionId: 'rR' },
            ratio: 0.5
          },
          activeRegionId: 'rL'
        },
        regions: {
          rL: { regionId: 'rL', kind: 'launcher', workspaceId: 'ws' },
          rR: { regionId: 'rR', kind: 'launcher', workspaceId: 'ws' }
        }
      }
    },
    activateTab: noop,
    openLauncher: noop,
    closeRegion: noop,
    requestCloseTab: noop,
    requestCloseRegion: noop,
    splitRegion: noop,
    focusRegion: (_w, _t, _r, cause) => caretCauses.push(cause),
    swapRegions: noop
  }
}

describe('键盘 dispatch 把 cause=keyboard 传进 focusRegion', () => {
  it('focus-region.right 调 focusRegion 时 cause 是 keyboard，不是 pointer/缺省', () => {
    // 这是本修复的接线关键：dispatch 若漏传 cause，store 的缺省是最保守的 'pointer'（不抢 caret），
    // 于是绿框移了而键入没移——缺陷原样，且 vitest 只转译不查类型不会报。这条钉住传的就是 'keyboard'。
    const store = spyStoreSideBySide()
    const command = commandForWorkbenchId('workbench.focus-region.right')
    expect(command, 'focus-region.right 翻译不出命令').not.toBeNull()
    expect(dispatchWorkbenchCommand(command!, store)).toBe(true)
    expect(store.caretCauses, 'focus-region 没有以 keyboard 触发落焦——不会抢 caret').toEqual(['keyboard'])
  })
})

describe('store.focusRegion：键盘投 caret 意图，指针不投，清除只认自己', () => {
  function twoRegionFixture(): { tabId: string; rootRegionId: string; addedRegionId: string } {
    const tabId = 'view-caret'
    const rootRegionId = initialWorkbenchRegionId(tabId)
    useAppStore.setState({
      tabs: {
        [tabId]: createWorkbenchTab(tabId, { regionId: rootRegionId, kind: 'launcher', workspaceId: 'workspace' })
      },
      layouts: { workspace: createWorkspaceLayout('group-one', [tabId]) }
    })
    useAppStore.getState().splitRegion('workspace', tabId, rootRegionId, 'right')
    const tab = useAppStore.getState().tabs[tabId]!
    const addedRegionId = regionIds(tab.layout.root).find((id) => id !== rootRegionId)!
    return { tabId, rootRegionId, addedRegionId }
  }

  it('cause=keyboard：既把活动格切过去，又投出点名那格的 caret 意图', () => {
    const { tabId, rootRegionId, addedRegionId } = twoRegionFixture()
    // 前提自检：活动格现在在被加出来那格上（split 会激活新格），我们要往回切到 root。
    expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(addedRegionId)

    useAppStore.getState().focusRegion('workspace', tabId, rootRegionId, 'keyboard')

    const state = useAppStore.getState()
    // 判别器：真的搬了绿框（activeRegionId），证明这不是一次静默 no-op——否则「投了意图」也没意义。
    expect(state.tabs[tabId]!.layout.activeRegionId, '键盘落焦没搬活动格').toBe(rootRegionId)
    expect(
      state.regionCaretFocus,
      '键盘落焦没投出 caret 意图——绿框移了、caret 没搬，字进上一格'
    ).toMatchObject({ regionId: rootRegionId })
  })

  it('cause=pointer：搬活动格但**不**投 caret 意图（原生已把焦点放对）', () => {
    const { tabId, rootRegionId } = twoRegionFixture()

    useAppStore.getState().focusRegion('workspace', tabId, rootRegionId, 'pointer')

    const state = useAppStore.getState()
    expect(state.tabs[tabId]!.layout.activeRegionId, '指针落焦也该搬活动格').toBe(rootRegionId)
    expect(
      state.regionCaretFocus,
      '指针点击也抢了 caret——会打断原生选择/在文本选择中途夺焦'
    ).toBeNull()
  })

  it('缺省 cause（不传）保守地不投 caret 意图', () => {
    const { tabId, rootRegionId } = twoRegionFixture()
    useAppStore.getState().focusRegion('workspace', tabId, rootRegionId)
    expect(
      useAppStore.getState().regionCaretFocus,
      '缺省 cause 竟然抢了 caret——默认该是最保守的一路'
    ).toBeNull()
  })

  it('连按（同一格再次键盘落焦）nonce 递增，让重复导航也各触发一次', () => {
    const { tabId, rootRegionId, addedRegionId } = twoRegionFixture()
    useAppStore.getState().focusRegion('workspace', tabId, rootRegionId, 'keyboard')
    const first = useAppStore.getState().regionCaretFocus
    useAppStore.getState().focusRegion('workspace', tabId, addedRegionId, 'keyboard')
    const second = useAppStore.getState().regionCaretFocus
    expect(second?.regionId).toBe(addedRegionId)
    expect(second?.nonce, 'nonce 没递增——selector 会因对象/值相等忽略重复导航').toBe((first?.nonce ?? 0) + 1)
  })

  it('无效落点（workspace 不匹配）不投 caret 意图', () => {
    const { tabId, rootRegionId } = twoRegionFixture()
    useAppStore.getState().focusRegion('other-workspace', tabId, rootRegionId, 'keyboard')
    expect(
      useAppStore.getState().regionCaretFocus,
      '落点都无效（跨项目）却投了 caret 意图'
    ).toBeNull()
  })

  it('does not reuse a nonce after consumption', () => {
    const { tabId, rootRegionId, addedRegionId } = twoRegionFixture()
    const state = useAppStore.getState()
    state.focusRegion('workspace', tabId, rootRegionId, 'keyboard')
    const first = useAppStore.getState().regionCaretFocus!
    state.clearRegionCaretFocus(first.nonce)
    state.focusRegion('workspace', tabId, addedRegionId, 'keyboard')
    const second = useAppStore.getState().regionCaretFocus!
    expect(second.nonce).toBeGreaterThan(first.nonce)
    state.clearRegionCaretFocus(first.nonce)
    expect(useAppStore.getState().regionCaretFocus).toBe(second)
  })

  it('pointer navigation cancels a pending keyboard request before its editor loads', () => {
    const { tabId, rootRegionId, addedRegionId } = twoRegionFixture()
    useAppStore.getState().focusRegion('workspace', tabId, rootRegionId, 'keyboard')
    expect(useAppStore.getState().regionCaretFocus).not.toBeNull()
    useAppStore.getState().focusRegion('workspace', tabId, addedRegionId, 'pointer')
    expect(useAppStore.getState().regionCaretFocus).toBeNull()
  })

  it('clearRegionCaretFocus 只清自己那条 nonce', () => {
    const { tabId, rootRegionId, addedRegionId } = twoRegionFixture()
    useAppStore.getState().focusRegion('workspace', tabId, rootRegionId, 'keyboard')
    const first = useAppStore.getState().regionCaretFocus!
    // 更晚一次导航覆盖成新 nonce。
    useAppStore.getState().focusRegion('workspace', tabId, addedRegionId, 'keyboard')
    const second = useAppStore.getState().regionCaretFocus!
    // 用过时 nonce 清：不该抹掉新意图。
    useAppStore.getState().clearRegionCaretFocus(first.nonce)
    expect(useAppStore.getState().regionCaretFocus, '用过时 nonce 清掉了更晚的意图').toBe(second)
    // 用当前 nonce 清：归零。
    useAppStore.getState().clearRegionCaretFocus(second.nonce)
    expect(useAppStore.getState().regionCaretFocus).toBeNull()
  })
})
