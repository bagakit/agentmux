// #556 的回归守卫：**只读投影不得用来算写入坐标**，以及投影不得留下空壳格。
//
// 用户报的症状是一句话：「在一个 topic 里头调整 tab 的顺序时，有些 tab 消失了，又有其他 topic 的 tab
// 混了进来」，附带截图里三格只剩一个「Split」按钮。查下来是三个各自独立可复现的缺陷，共用同一处
// 架构裂缝——渲染层拿的是 `layoutForActiveTopic` 的**投影**产物，而 reducer 吃的是未投影的
// storedLayout。scratch-topic-layout.ts 的 JSDoc 早就点名过这一族（:68-77 那段），但当时只给
// `removeTab` 闭合了。本文件按缺陷分三个 describe，每条都能单独变红。
import { describe, expect, it } from 'vitest'
import {
  activeTopicIdFromLayout,
  layoutForActiveTopic,
  moveTabWithinActiveTopic
} from '../src/renderer/src/lib/scratch-topic-layout.js'
import {
  addTab,
  createWorkspaceLayout,
  groupIds,
  moveTabToNewGroup,
  moveTab,
  type WorkspaceLayout
} from '../src/renderer/src/lib/workbench-layout.js'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

function tab(id: string, topicId?: string): WorkbenchTab {
  const base = createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'launcher',
    workspaceId: 'scratch'
  })
  return topicId === undefined ? base : { ...base, topicId }
}

// a-* 属于 topic-a，b-* 属于 topic-b，free 不绑任何 Topic（始终可见）。
const TABS: Record<string, WorkbenchTab> = {
  'a-1': tab('a-1', 'topic-a'),
  'a-2': tab('a-2', 'topic-a'),
  'a-3': tab('a-3', 'topic-a'),
  'b-1': tab('b-1', 'topic-b'),
  'b-2': tab('b-2', 'topic-b'),
  free: tab('free')
}

function oneGroup(order: string[], activeTabId: string): WorkspaceLayout {
  let layout = createWorkspaceLayout('g', [order[0]!])
  for (const id of order.slice(1)) layout = addTab(layout, 'g', id)
  return { ...layout, groups: layout.groups.map((g) => ({ ...g, activeTabId })) }
}

const orderOf = (layout: WorkspaceLayout, groupId = 'g'): string[] =>
  layout.groups.find((g) => g.id === groupId)!.tabOrder

const shownOrderOf = (layout: WorkspaceLayout, groupId = 'g'): string[] =>
  orderOf(layoutForActiveTopic(layout, TABS, activeTopicIdFromLayout(layout, TABS)), groupId)

describe('#556 缺陷 A：投影坐标必须翻译回存储坐标', () => {
  // 存储序里 topic-b 的 Tab 夹在 topic-a 的之间——这是 Scratch 的常态（所有 Topic 共用一份 layout），
  // 也是两套坐标分家的**唯一**前提。这条 fixture 就是判据的载体，先把前提本身钉住。
  const STORED = ['b-1', 'a-1', 'b-2', 'a-2', 'a-3']

  it('前提自检：可见序确实比存储序短，且落点前有一张外来 Tab', () => {
    const layout = oneGroup(STORED, 'a-1')
    expect(orderOf(layout)).toEqual(STORED)
    expect(shownOrderOf(layout)).toEqual(['a-1', 'a-2', 'a-3'])
    // 「落点前有外来 Tab」是 A 可观测的充要条件：b-1 排在 a-1 前面，所以可见的 0 号位
    // 在存储里是 1 号位。两个数字不同，这条测试才有判别力。
    expect(STORED.indexOf('a-1')).not.toBe(shownOrderOf(layout).indexOf('a-1'))
  })

  it('把 a-3 拖到可见的第 0 位：它落在 a-1 前面，不是落到 b-1 前面', () => {
    const layout = oneGroup(STORED, 'a-1')
    const moved = moveTabWithinActiveTopic(layout, TABS, {
      tabId: 'a-3',
      sourceGroupId: 'g',
      targetGroupId: 'g',
      visibleTargetIndex: 0
    })
    // 用户视角：a-3 现在排在最前。
    expect(shownOrderOf(moved)).toEqual(['a-3', 'a-1', 'a-2'])
    // 存储视角：b-1 仍在最前，一张别的 Topic 的 Tab 都没被挪动。
    expect(orderOf(moved)).toEqual(['b-1', 'a-3', 'a-1', 'b-2', 'a-2'])
  })

  it('直接把可见下标喂给未翻译的 reducer 会给出不同答案（这就是被修掉的行为）', () => {
    const layout = oneGroup(STORED, 'a-1')
    const untranslated = moveTab(layout, 'a-3', 'g', 'g', 0)
    // 未翻译时 a-3 落到了 b-1 前面——存储序被改成另一种样子。
    expect(orderOf(untranslated)).toEqual(['a-3', 'b-1', 'a-1', 'b-2', 'a-2'])
    // 判据是「翻译过的与没翻译的必须不同」：若 moveTabWithinActiveTopic 退化成直接转发，这里就红。
    const translated = moveTabWithinActiveTopic(layout, TABS, {
      tabId: 'a-3',
      sourceGroupId: 'g',
      targetGroupId: 'g',
      visibleTargetIndex: 0
    })
    expect(orderOf(translated)).not.toEqual(orderOf(untranslated))
  })

  it('拖到 tabbar 空白处（落点越过可见末尾）放到存储末尾', () => {
    const layout = oneGroup(STORED, 'a-1')
    const moved = moveTabWithinActiveTopic(layout, TABS, {
      tabId: 'a-1',
      sourceGroupId: 'g',
      targetGroupId: 'g',
      visibleTargetIndex: 3 // 可见列表只有 3 张，3 就是「末尾之后」
    })
    expect(shownOrderOf(moved)).toEqual(['a-2', 'a-3', 'a-1'])
    expect(orderOf(moved)).toEqual(['b-1', 'b-2', 'a-2', 'a-3', 'a-1'])
  })

  it('往后拖也对：`moveTab` 先摘再插，落点之后的下标全会左移一格', () => {
    // 上面几条全是往前拖。往后拖是另一条算术：`moveTab` 先把被拖那张从 tabOrder 里滤掉，
    // 才做 splice，所以源位置**之后**的每个存储下标都比翻译时看到的少一。锚点翻译天然免疫
    // 这件事（它翻译的是「谁」而不是「第几个」），而这条守的正是「不许有人替 moveTab 再补一次
    // 这个偏移」：在 anchorIndex 上加一句 `sourceIndex < anchorIndex ? anchorIndex - 1 : anchorIndex`
    // 看起来像在补偿滤除，实测只有本条会红（其余 16 条全绿），落点会差一格。
    // 反过来说明白一点：把整个翻译换成数字加减（`visibleTargetIndex + 隐藏张数`）**不**由本条抓到——
    // 实测红的是上面那条往前拖的用例。这个 fixture 在往后拖的方向上两种算法恰好同解，所以别把
    // 本条当成「数字加减法的靶子」；它的靶子是那次多余的方向性补偿。
    const layout = oneGroup(STORED, 'a-1')
    const moved = moveTabWithinActiveTopic(layout, TABS, {
      tabId: 'a-1',
      sourceGroupId: 'g',
      targetGroupId: 'g',
      visibleTargetIndex: 2 // a-1 从可见 0 号位拖到 a-3 头上
    })
    // 语义与往前拖一致：被拖那张落在锚点原来的位置上。
    expect(shownOrderOf(moved)).toEqual(['a-2', 'a-3', 'a-1'])
    // 存储视角：b-1/b-2 的相对次序一个字节没动，只有 a-1 换了位置。
    expect(orderOf(moved)).toEqual(['b-1', 'b-2', 'a-2', 'a-3', 'a-1'])
  })

  it('没有 Topic 时翻译是恒等的：与直接调 reducer 逐点一致', () => {
    // 这一条守的是「修复没有把非 Topic 场景一起改掉」。全部 Tab 都不绑 Topic，
    // 投影是恒等映射，翻译必须什么也不做。
    const tabs = { x: tab('x'), y: tab('y'), z: tab('z') }
    let layout = createWorkspaceLayout('g', ['x'])
    for (const id of ['y', 'z']) layout = addTab(layout, 'g', id)
    expect(activeTopicIdFromLayout(layout, tabs)).toBeNull()
    for (const index of [0, 1, 2, 3]) {
      const via = moveTabWithinActiveTopic(layout, tabs, {
        tabId: 'z',
        sourceGroupId: 'g',
        targetGroupId: 'g',
        visibleTargetIndex: index
      })
      const direct = moveTab(layout, 'z', 'g', 'g', index)
      expect(via.groups[0]!.tabOrder, `落点 ${index} 上翻译层必须是恒等`)
        .toEqual(direct.groups[0]!.tabOrder)
    }
  })

  it('未绑 Topic 的 Tab 参与可见序，翻译要认它', () => {
    // free 始终可见（见 layoutForActiveTopic 的规则），所以它**占一个可见下标**。
    // 只按「属于当前 Topic 的第几张」算就会错位一格。
    const layout = oneGroup(['b-1', 'free', 'a-1', 'a-2'], 'a-1')
    expect(shownOrderOf(layout)).toEqual(['free', 'a-1', 'a-2'])
    const moved = moveTabWithinActiveTopic(layout, TABS, {
      tabId: 'a-2',
      sourceGroupId: 'g',
      targetGroupId: 'g',
      visibleTargetIndex: 1 // 落在 a-1 头上
    })
    expect(shownOrderOf(moved)).toEqual(['free', 'a-2', 'a-1'])
    expect(orderOf(moved)).toEqual(['b-1', 'free', 'a-2', 'a-1'])
  })
})

describe('#556 缺陷 B：投影到空的格不许留在分屏树里', () => {
  // 两格分屏：g1 放 topic-a 的 Tab，g2 放 topic-b 的两张。
  function twoGroups(): { layout: WorkspaceLayout; otherId: string } {
    let layout = createWorkspaceLayout('g1', ['a-1'])
    for (const id of ['b-1', 'b-2']) layout = addTab(layout, 'g1', id)
    layout = moveTabToNewGroup(layout, 'b-1', 'g1', 'g1', 'right', 'g2')
    const otherId = layout.groups.find((g) => g.id !== 'g1')!.id
    layout = moveTab(layout, 'b-2', 'g1', otherId, 99)
    return { layout, otherId }
  }

  it('前提自检：g2 确实只装别的 Topic 的 Tab，且两片叶子都在树里', () => {
    const { layout, otherId } = twoGroups()
    expect(layout.groups.find((g) => g.id === otherId)!.tabOrder).toEqual(['b-1', 'b-2'])
    expect(groupIds(layout.root).sort()).toEqual(['g1', otherId].sort())
  })

  it('投影后 g2 从树里消失（否则渲染成只有 Split 按钮的空壳格）', () => {
    const { layout, otherId } = twoGroups()
    const shown = layoutForActiveTopic(layout, TABS, 'topic-a')
    expect(groupIds(shown.root)).toEqual(['g1'])
    // groups 数组**保留** g2：那是存储真相的投影，删了切回 topic-b 就找不回来了。
    expect(shown.groups.map((g) => g.id).sort()).toEqual(['g1', otherId].sort())
    expect(shown.groups.find((g) => g.id === otherId)!.tabOrder).toEqual([])
  })

  it('切回 topic-b 时反过来：g1 从树里消失、g2 回来', () => {
    // 这一条让「摘掉哪一片」必须真的按当前 Topic 取值。写成恒摘某一片就红。
    const { layout, otherId } = twoGroups()
    const shown = layoutForActiveTopic(layout, TABS, 'topic-b')
    expect(groupIds(shown.root)).toEqual([otherId])
  })

  it('活动格被摘掉时 activeGroupId 落到还在树里的格上', () => {
    // 留一个指向已不在屏上的格的指针，会让 activeTopicIdFromLayout 读到不可见的东西——
    // 那正是缺陷 C 的入口，两条不能互相喂食。
    const { layout, otherId } = twoGroups()
    const focusedOnOther = { ...layout, activeGroupId: otherId }
    const shown = layoutForActiveTopic(focusedOnOther, TABS, 'topic-a')
    expect(shown.activeGroupId).toBe('g1')
    expect(groupIds(shown.root)).toContain(shown.activeGroupId)
  })

  it('当前 Topic 一张 Tab 都没开时树里仍留恰好一片叶子（不返回空布局）', () => {
    const { layout } = twoGroups()
    // topic-c 没有任何 Tab：两格都投影到空。这一层表达不了「没有布局」，所以最后一次摘除被撤销。
    // 判据是「恰好一片」而不是「至少一片」：`> 0` 对「原样保留两片」也成立，而那不是实现做的事，
    // 也就守不住 `?? root` 只兜住最后一步这件事。留下的是循环走到最后时还剩的那片。
    const shown = layoutForActiveTopic(layout, TABS, 'topic-c')
    expect(groupIds(shown.root)).toHaveLength(1)
    // 前提自检：原树真的有两片，否则「摘到只剩一片」与「什么都没摘」不可区分。
    expect(groupIds(layout.root)).toHaveLength(2)
  })
})

describe('#556 缺陷 C：当前 Topic 由焦点回答，不由 groups 数组顺序回答', () => {
  it('groups 数组顺序颠倒不改变答案（树与焦点都没变）', () => {
    let layout = createWorkspaceLayout('g1', ['a-1'])
    layout = addTab(layout, 'g1', 'b-1')
    layout = moveTabToNewGroup(layout, 'b-1', 'g1', 'g1', 'right', 'g2')
    const reversed = { ...layout, groups: [...layout.groups].reverse() }
    // 前提自检：两个 group 各自绑着不同 Topic，否则这条测试不含判别力。
    const topics = layout.groups.map((g) => TABS[g.activeTabId!]?.topicId)
    expect(new Set(topics).size).toBe(2)
    expect(activeTopicIdFromLayout(reversed, TABS)).toBe(activeTopicIdFromLayout(layout, TABS))
  })

  it('答案就是被聚焦那一格的活动 Tab 的 Topic', () => {
    let layout = createWorkspaceLayout('g1', ['a-1'])
    layout = addTab(layout, 'g1', 'b-1')
    layout = moveTabToNewGroup(layout, 'b-1', 'g1', 'g1', 'right', 'g2')
    const other = layout.groups.find((g) => g.id !== 'g1')!
    expect(activeTopicIdFromLayout({ ...layout, activeGroupId: 'g1' }, TABS)).toBe('topic-a')
    expect(activeTopicIdFromLayout({ ...layout, activeGroupId: other.id }, TABS)).toBe('topic-b')
  })

  it('把最后一张 Tab 拖进邻格不会静默切走 Topic', () => {
    // 这是用户报的那次操作的最小形状：g1 只剩 a-1，把它拖进 g2（装着 topic-b 的 Tab）。
    // 旧实现里 g1 被从 groups 数组里删掉，数组只剩 g2，当前 Topic 于是翻成 topic-b——
    // topic-a 的东西整批消失、topic-b 的整批出现。
    let layout = createWorkspaceLayout('g1', ['a-1'])
    layout = addTab(layout, 'g1', 'b-1')
    layout = moveTabToNewGroup(layout, 'b-1', 'g1', 'g1', 'right', 'g2')
    const other = layout.groups.find((g) => g.id !== 'g1')!
    layout = { ...layout, activeGroupId: 'g1' }
    expect(activeTopicIdFromLayout(layout, TABS)).toBe('topic-a')

    const moved = moveTabWithinActiveTopic(layout, TABS, {
      tabId: 'a-1',
      sourceGroupId: 'g1',
      targetGroupId: other.id,
      visibleTargetIndex: 0
    })
    // 前提自检：g1 真的被摘掉了（否则这条测的不是它要测的那件事）。
    expect(moved.groups.map((g) => g.id)).not.toContain('g1')
    expect(activeTopicIdFromLayout(moved, TABS)).toBe('topic-a')
  })

  it('聚焦格的活动 Tab 是游离 id 时退回扫描，答案来自还开着的那一格', () => {
    // 焦点不含信息（活动 id 已从 tabs 里清掉）时才允许退回按文档序扫。
    // 注意这里**不**断言「跳过聚焦格」：本函数只读 activeTabId、从不看 tabOrder，
    // 聚焦格在循环里必然被「activeTabId 不在 tabs 里」滤掉，那条 continue 是死条件（已删）。
    let layout = createWorkspaceLayout('g1', ['a-1'])
    layout = addTab(layout, 'g1', 'b-1')
    layout = moveTabToNewGroup(layout, 'b-1', 'g1', 'g1', 'right', 'g2')
    const other = layout.groups.find((g) => g.id !== 'g1')!
    const stale = {
      ...layout,
      activeGroupId: 'g1',
      groups: layout.groups.map((g) => (g.id === 'g1' ? { ...g, activeTabId: 'gone' } : g))
    }
    expect(TABS['gone']).toBeUndefined()
    expect(activeTopicIdFromLayout(stale, TABS)).toBe('topic-b')
    expect(other.activeTabId).toBe('b-1')
  })

  it('活动 Tab 不绑 Topic 时返回 null（不去别的格里找一个）', () => {
    // 「现在不在任何 Topic 里」是一个真答案，不是「还没找到」。若退回扫描无条件生效，
    // 打开一张普通 workspace tab 就会被算进某个 Topic，整条 Tab 条被莫名过滤。
    let layout = createWorkspaceLayout('g1', ['free'])
    layout = addTab(layout, 'g1', 'b-1')
    layout = moveTabToNewGroup(layout, 'b-1', 'g1', 'g1', 'right', 'g2')
    expect(activeTopicIdFromLayout({ ...layout, activeGroupId: 'g1' }, TABS)).toBeNull()
  })
})
