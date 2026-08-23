import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceLayout,
  addTab,
  removeTab,
  activateTab,
  splitWorkbenchRegion,
  workbenchRegionBounds
} from '@agentmux/layout'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  activeTopicIdFromLayout,
  layoutForActiveTopic,
  openTopicWorkSurfaces,
  openTopicRegionMosaics,
  tabEligibilityForActiveTopic
} from '../src/renderer/src/lib/scratch-topic-layout.js'

const workspaceWorkbenchSource = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)

// 切 Branch 换掉整套 Tab 组，是因为 layouts 按 workspaceId 键控——每个 worktree 是一个
// workspace。Scratch 的所有 Topic 共用一个 workspace，所以共用一套 layout，切 Topic 时
// 别的 Topic 的 Tab 仍然留在条上。用户要的是同一种体验：切 Topic 就换那一组 Tab。
//
// 不新增数据维度：tab.topicId 已经存在，按它过滤即可。

function launcher(id: string, topicId?: string): WorkbenchTab {
  const tab = createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'launcher',
    workspaceId: 'scratch'
  })
  return topicId ? { ...tab, topicId } : tab
}

const tabs: Record<string, WorkbenchTab> = {
  'a-1': launcher('a-1', 'topic-a'),
  'a-2': launcher('a-2', 'topic-a'),
  'b-1': launcher('b-1', 'topic-b'),
  'loose': launcher('loose')
}

function fullLayout() {
  let layout = createWorkspaceLayout('group', ['a-1'])
  for (const id of ['a-2', 'b-1', 'loose']) layout = addTab(layout, 'group', id)
  return layout
}

describe('切 Topic 就换那一组 Tab', () => {
  it('只留下当前 Topic 的 Tab', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-a')
    // loose 未绑定 Topic，按下面那条规则始终可见。
    expect(shown.groups[0]!.tabOrder).toEqual(['a-1', 'a-2', 'loose'])
  })

  it('切到另一个 Topic 就换成它的那一组', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-b')
    expect(shown.groups[0]!.tabOrder).toEqual(['b-1', 'loose'])
  })

  it('未绑定 Topic 的 Tab 始终可见——它不属于任何 Topic，藏起来就找不回了', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-b')
    // loose 没有 topicId：它不该因为你正看着某个 Topic 就消失。
    expect(layoutForActiveTopic(fullLayout(), tabs, null).groups[0]!.tabOrder).toContain('loose')
    expect(shown.groups[0]!.tabOrder).not.toContain('a-1')
  })

  it('product-owned PMO teams topic can isolate unbound Scratch tabs', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'launcher:leader', false)
    expect(shown.groups[0]!.tabOrder).toEqual([])
  })

  it('没有选中 Topic 时显示全部——不做无谓的隐藏', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, null)
    expect(shown.groups[0]!.tabOrder).toEqual(['a-1', 'a-2', 'b-1', 'loose'])
  })

  it('活动 Tab 被过滤掉时改为该组第一个可见的 Tab', () => {
    // 原本活动的是 a-1（topic-a）；切到 topic-b 后它不可见，活动项必须跟着走，
    // 否则界面会指向一个已经不在条上的 Tab。
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-b')
    // a-1 不可见了，活动项落到过滤后 tabOrder 的第一个。原序是 a-1,a-2,b-1,loose，
    // 过滤 topic-b 后是 b-1,loose——所以是 b-1。
    expect(shown.groups[0]!.tabOrder[0]).toBe('b-1')
    expect(shown.groups[0]!.activeTabId).toBe(shown.groups[0]!.tabOrder[0])
  })

  it('该 Topic 一个 Tab 都没有时不留下空组的假活动项', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-none')
    // loose 无 topicId 故仍可见，活动项落到它身上而不是一个不存在的 Tab。
    expect(shown.groups[0]!.tabOrder).toEqual(['loose'])
    expect(shown.groups[0]!.activeTabId).toBe('loose')
  })

  // 活动项的取值是**两个**独立机制，而上面两条只守住其中一个的一半：「活动 Tab 被过滤掉时改为
  // 该组第一个可见的 Tab」里，过滤后第一张恰好就是本 Topic 的那张；「该 Topic 一个 Tab 都没有时」
  // 里根本没有本 Topic 的 Tab 可选。于是三个候选答案（原活动项 / 第一张本 Topic 的 / 第一张可见的）
  // 在既有 fixture 里两两重合，任一机制被拆掉都全绿——实测：把 `stays` 改成恒假、或把
  // `find(本 Topic)` 换成 `tabOrder[0]`，三个相关 suite 51 条一条不红。
  // 下面两条各自钉一个机制，各自带前提自检让候选真正分开。

  it('活动 Tab 属于本 Topic 时留在原位，不被换成第一张', () => {
    // 用户症状：这条不成立就等于「一个 Topic 里除了第一张，哪张 Tab 都点不进去」——
    // 每次渲染都把活动项拽回 tabOrder 的第一张。
    const layout = fullLayout()
    const onSecond = {
      ...layout,
      groups: layout.groups.map((group) => ({ ...group, activeTabId: 'a-2' }))
    }
    const shown = layoutForActiveTopic(onSecond, tabs, 'topic-a')
    // 前提自检：a-2 不能是过滤后的第一张，否则「留在原位」与「换成第一张」给出同一个答案。
    expect(shown.groups[0]!.tabOrder[0], 'a-2 必须不是首张，这条才有判别力').not.toBe('a-2')
    expect(shown.groups[0]!.activeTabId).toBe('a-2')
  })

  it('必须换活动项时，选本 Topic 的第一张而不是可见列表的第一张', () => {
    // 未绑定 Topic 的 Tab 始终可见（见上面那条规则），所以它可以排在本 Topic 的 Tab 前面。
    // 落到它身上就等于切过去却什么也没发生——你看到的仍是刚才那张外来 Tab。
    let layout = createWorkspaceLayout('group', ['loose'])
    for (const id of ['b-1', 'a-1']) layout = addTab(layout, 'group', id)
    const onForeign = {
      ...layout,
      groups: layout.groups.map((group) => ({ ...group, activeTabId: 'a-1' }))
    }
    const shown = layoutForActiveTopic(onForeign, tabs, 'topic-b')
    // 前提自检：可见首张是那张未绑定的，与「本 Topic 的第一张」不是同一个答案。
    expect(shown.groups[0]!.tabOrder).toEqual(['loose', 'b-1'])
    expect(shown.groups[0]!.activeTabId).toBe('b-1')
  })

  it('是纯函数：不改动传入的 layout', () => {
    const original = fullLayout()
    const before = JSON.stringify(original)
    layoutForActiveTopic(original, tabs, 'topic-a')
    expect(JSON.stringify(original)).toBe(before)
  })

  it('renders the projected layout instead of reading the unfiltered Store layout again', () => {
    // The Topic projection was already correct, but SplitNode/PaneGroup re-read Store.layouts and
    // silently replaced it with the full layout. Keep this owner-boundary contract close to the
    // projection tests so a future refactor cannot reintroduce the mixed-tab regression.
    const splitNode = workspaceWorkbenchSource.slice(
      workspaceWorkbenchSource.indexOf('function SplitNode('),
      workspaceWorkbenchSource.indexOf('function SplitBranch(')
    )
    const paneGroup = workspaceWorkbenchSource.slice(
      workspaceWorkbenchSource.indexOf('function PaneGroup('),
      workspaceWorkbenchSource.indexOf('function SplitNode(')
    )

    expect(splitNode).toContain('layout: WorkspaceLayout')
    expect(splitNode).toContain('layout={layout}')
    expect(splitNode).not.toContain('state.layouts[workspaceId]')
    expect(paneGroup).toContain('layout: WorkspaceLayout')
    expect(paneGroup).not.toContain('state.layouts[workspaceId]')
    expect(workspaceWorkbenchSource).toContain('layout={layout}')
  })
})

// 上面那组守的是**显示**：知道当前 Topic 之后只把它的 Tab 画出来。
// 下面这组守的是**改动**：关掉/移走一张 Tab 之后谁接任活动项。
//
// 为什么显示侧的投影兜不住这件事：`layoutForActiveTopic` 是只读派生，服务渲染、内存预算、冷泊车、
// 快捷键取值这几个读取面。真正改 layout 的 reducer 吃的是未投影的 storedLayout，它看到的
// `recentTabIds` 里混着别的 Topic 的 Tab。于是关掉当前 Topic 的最后一张 Tab 时，下一活动项会落到
// 另一个 Topic 上——用户没要求切 Topic，眼前的东西却全换了。

describe('关掉一张 Tab 之后不许跳到别的 Topic', () => {
  it('候选谓词放行当前 Topic 与未绑定的 Tab，挡住别的 Topic', () => {
    const eligible = tabEligibilityForActiveTopic(tabs, 'topic-a')
    // 判据逐个列出而不是抽一两个：三类 Tab（本 Topic / 未绑定 / 别的 Topic）各有独立答案，
    // 只抽其中一对的话，把「未绑定」误判成不合格这种错会活下来。
    expect(eligible?.('a-1')).toBe(true)
    expect(eligible?.('a-2')).toBe(true)
    expect(eligible?.('loose')).toBe(true)
    expect(eligible?.('b-1')).toBe(false)
  })

  it('不在任何 Topic 里时返回 undefined，而不是一个恒真函数', () => {
    // 恒真函数也能跑对，但它让「没有约束」和「有约束且恰好全放行」在类型上无法区分，
    // 调用方也就必须无条件传参。undefined 让 reducer 走它自己的缺省，语义更诚实。
    expect(tabEligibilityForActiveTopic(tabs, null)).toBeUndefined()
  })

  it('removeTab 认这个谓词：最近一张属于别的 Topic 时不选它', () => {
    // 这就是那个真缺陷的形状。a-2 是活动项，但 recent 里 b-1 更近（用户先看 b-1 再回 a-2）。
    // 关掉 a-2 时，不带谓词会选中 b-1——那是 topic-b 的 Tab。
    let layout = createWorkspaceLayout('group', ['a-1'])
    for (const id of ['a-2', 'b-1']) layout = addTab(layout, 'group', id)
    layout = activateTab(layout, 'group', 'b-1')
    layout = activateTab(layout, 'group', 'a-2')
    expect(layout.groups[0]!.recentTabIds).toEqual(['a-1', 'b-1', 'a-2'])

    // 不带谓词：最近的合格者是 b-1，跨了 Topic。这一条钉住「缺陷确实存在」，
    // 否则下面那条可能只是因为 fixture 恰好没有跨 Topic 的候选而绿。
    expect(removeTab(layout, 'group', 'a-2').groups[0]!.activeTabId).toBe('b-1')

    // 带谓词：b-1 被挡掉，落回同 Topic 的 a-1。
    const eligible = tabEligibilityForActiveTopic(tabs, 'topic-a')
    expect(removeTab(layout, 'group', 'a-2', eligible).groups[0]!.activeTabId).toBe('a-1')
  })

  it('本 Topic 一个候选都不剩时给 null，不退回别的 Topic 的 Tab', () => {
    // 「挡住别的 Topic」必须挡到底。若在无候选时悄悄放宽，症状就退化成原来那个——
    // 只是变得更难复现（要恰好关掉最后一张）。
    let layout = createWorkspaceLayout('group', ['a-1'])
    layout = addTab(layout, 'group', 'b-1')
    layout = activateTab(layout, 'group', 'a-1')
    const eligible = tabEligibilityForActiveTopic(tabs, 'topic-a')
    expect(removeTab(layout, 'group', 'a-1', eligible).groups[0]!.activeTabId).toBeNull()
    // 对照：不带谓词时它会选 b-1，所以上面的 null 是谓词挣来的，不是 layout 本来就空。
    expect(removeTab(layout, 'group', 'a-1').groups[0]!.activeTabId).toBe('b-1')
  })

  it('关 Tab 的生产路径真的把谓词传下去了——helper 写好了没人调等于没修', () => {
    // 为什么要质询源码：上面几条测的是 removeTab「如果收到谓词」会怎么做，而缺陷是「没人给它」。
    // 只测纯函数的话，把 workbench-view-close.ts 里那个参数删掉，前面每一条照旧全绿。
    const closeSource = readFileSync(
      new URL('../src/renderer/src/lib/workbench-view-close.ts', import.meta.url),
      'utf8'
    )
    // 挡板：读错文件时下面的断言会因为「不含手抄」而恒真，所以先确认它真是那个调用方。
    expect(closeSource, 'workbench-view-close.ts 不再调 removeTab，这条守卫钉错了文件')
      .toContain('removeTab(')
    expect(closeSource, '关 Tab 时必须限定候选在当前 Topic 内').toContain('tabEligibilityForActiveTopic(')

    // 判据按**语义分区**而不是按出现次数：这个文件里有三类 removeTab 相关的文本，只有一类承重。
    // - `closeTabWithinActiveTopic` 是那个唯一出处，它当然要调 removeTab。
    // - `planWorkbenchViewClose` 里那处只用来算 `closesView`（这张移除后还开着吗），结果被丢掉，
    //   谓词影响不了那个判断，裸调是对的。
    // - `applyWorkbenchViewCloseTopology` 产出用户真正看到的 layout —— 它的两条出口都必须走那个
    //   出处，自己不许再碰 removeTab。
    //
    // 计数上限那种写法在这里是错的形状：它把 import 行、把只读探测都算进来，数字一变就要改测试，
    // 而真正的漂移（某条改动出口悄悄绕过收口）反而可能仍在上限之内。
    const applyAt = closeSource.indexOf('export function applyWorkbenchViewCloseTopology(')
    expect(applyAt, 'applyWorkbenchViewCloseTopology 不在了，这条守卫钉错了函数').toBeGreaterThan(-1)
    const applySection = closeSource.slice(applyAt)
    // 右界必须给：只取左界会让文件尾巴顶上来，本节的结论被邻节的文本掩盖而恒绿。
    const nextDecl = applySection.indexOf('\nfunction ')
    const applyBody = nextDecl === -1 ? applySection : applySection.slice(0, nextDecl)
    expect(
      applyBody.includes('removeTab('),
      '产出用户可见 layout 的那个函数里不许自己调 removeTab；两条出口必须共用 closeTabWithinActiveTopic，' +
        '否则只给一处补谓词，另一处会静默保留旧行为且全绿'
    ).toBe(false)
    // 而它必须真的调了那个收口 —— 否则「没有裸调」也可能是因为它压根不改 layout 了。
    const viaHelper = applyBody.match(/closeTab\(\)/g) ?? []
    expect(viaHelper.length, '两条改动出口都应通过 closeTab() 收口').toBeGreaterThanOrEqual(2)
    // 收口自己要认谓词。它和上面那条合起来才完整：一个证「都走这里」，一个证「这里做对了」。
    expect(
      closeSource.slice(closeSource.indexOf('function closeTabWithinActiveTopic('), applyAt),
      '唯一出处必须限定候选在当前 Topic 内'
    ).toContain('tabEligibilityForActiveTopic(')
  })
})

// 上面那组测投影：知道当前 Topic 是谁之后，只显示它的 Tab。
// 下面这组测**当前 Topic 是谁**——投影再对，喂给它一个 null 也什么都不会发生。
//
// 用户看到的症状：「现在选择 topic , 没有像 branch 那样只展示自己的 tabs, 而是展示所有」。
// 根因不在投影，在于当前 Topic 曾经存在 store 的一个字段里，而只有 Topic 面板的点击会写它。
// 从别的路径进入一个 Topic，那个字段还是 null，于是 `if (!activeTopicId) return layout`
// 原样返回——所有 Topic 的 Tab 混在一起。

describe('当前 Topic 由活动 Tab 的绑定派生', () => {
  function withActive(tabId: string) {
    const layout = fullLayout()
    return {
      ...layout,
      groups: layout.groups.map((group) => ({ ...group, activeTabId: tabId }))
    }
  }

  it('点该 Topic 自己的 Tab 进入，也只看到它的 Tab', () => {
    // 这条路径不经过 openScratchTopic：用户直接点了 Tab 条上属于 topic-b 的那张。
    const layout = withActive('b-1')
    const topicId = activeTopicIdFromLayout(layout, tabs)
    expect(topicId).toBe('topic-b')
    expect(layoutForActiveTopic(layout, tabs, topicId).groups[0]!.tabOrder).toEqual(['b-1', 'loose'])
  })

  it('会话恢复后落在某张 Tab 上，同样只看到它所属 Topic 的 Tab', () => {
    // 恢复时没有任何人调用 openScratchTopic，活动 Tab 是持久化下来的。
    const layout = withActive('a-2')
    const topicId = activeTopicIdFromLayout(layout, tabs)
    expect(topicId).toBe('topic-a')
    expect(layoutForActiveTopic(layout, tabs, topicId).groups[0]!.tabOrder).toEqual(['a-1', 'a-2', 'loose'])
  })

  it('从 Board 的 Topic 行跳过去，看到的也只有那个 Topic', () => {
    // Board 走 openScratchTopic 绑定，落点是该 Topic 的 launcher Tab——派生同样成立，
    // 不需要它额外写一个字段。
    const layout = withActive('a-1')
    expect(activeTopicIdFromLayout(layout, tabs)).toBe('topic-a')
  })

  it('活动 Tab 不属于任何 Topic 时不隐藏任何东西', () => {
    // 普通 workspace tab 意味着"现在不在任何 Topic 里"，此时藏起别的 Tab 是错的。
    const layout = withActive('loose')
    expect(activeTopicIdFromLayout(layout, tabs)).toBeNull()
    expect(layoutForActiveTopic(layout, tabs, null).groups[0]!.tabOrder)
      .toEqual(['a-1', 'a-2', 'b-1', 'loose'])
  })

  it('没有活动 Tab 时诚实地回答"不知道"', () => {
    const layout = fullLayout()
    const empty = { ...layout, groups: layout.groups.map((group) => ({ ...group, activeTabId: null })) }
    expect(activeTopicIdFromLayout(empty, tabs)).toBeNull()
  })

  it('Workbench 从 layout 派生当前 Topic，而不是读那个只有面板会写的字段', () => {
    // 这条钉住接线：派生函数本身全绿，也证明不了渲染面真的用了它。改回读 store 字段会红。
    expect(workspaceWorkbenchSource).toContain('activeTopicIdFromLayout(storedLayout, tabs)')
    expect(workspaceWorkbenchSource).not.toContain('state.activeScratchTopicId')
  })
})

// 行尾那枚 Region 缩略图的门禁：只在一个 Topic 真的开着一张 Tab 时才画。
// 「开着」= 那张 Tab 落在某个 group 的 tabOrder 里（findGroupForTab !== null），不是「tab 对象还在
// tabs 记录里」——一个已从所有 group 移除、却还没从 tabs 里清掉的游离 Tab 不该让缩略图发亮，那正是
// 裸扫 tabs 会犯的错。缩略图与门禁是同一份投影（openTopicRegionMosaics）的两半。

describe('哪些 Topic 有 Tab 开着（行尾缩略图的门禁）', () => {
  it('projects every visible Tab and its Region layout for Topic presence details', () => {
    const first = launcher('detail-a', 'topic-a')
    const second = launcher('detail-b', 'topic-a')
    const layout = createWorkspaceLayout('group', [first.id, second.id])
    const projected = openTopicWorkSurfaces(layout, { [first.id]: first, [second.id]: second })
    const details = projected.get('topic-a')
    expect(details?.map((entry) => entry.tabId)).toEqual(['detail-a', 'detail-b'])
    expect(details?.every((entry) => entry.cells.length === 1)).toBe(true)
    expect(details?.[0]?.active).toBe(true)
    expect(details?.[0]?.cells[0]?.surfaceKind).toBe('launcher')
  })

  it('恰好是有 Tab 落在某个 group 里的那些 Topic', () => {
    // fullLayout 里 a-1/a-2(topic-a)、b-1(topic-b)、loose(无 Topic) 全在 group 中。
    expect([...openTopicRegionMosaics(fullLayout(), tabs).keys()].sort()).toEqual(['topic-a', 'topic-b'])
  })

  it('一张存在于 tabs、却不在任何 group 里的 Tab，不让它的 Topic 算作开着', () => {
    // 这正是裸扫 `Object.values(tabs)` 会答错的那一格：orphan 绑着 topic-orphan、在 tabs 记录里，
    // 但从未加入任何 group（findGroupForTab === null）。门禁必须挡住它。
    const withOrphan: Record<string, WorkbenchTab> = {
      ...tabs,
      orphan: launcher('orphan', 'topic-orphan')
    }
    const open = openTopicRegionMosaics(fullLayout(), withOrphan)
    expect(open.has('topic-orphan'), '一个不在任何 group 里的 Tab 被算成了开着').toBe(false)
    // 对照：它确实在 tabs 记录里，所以上面的 false 是门禁挣来的，不是 fixture 里根本没有它。
    expect(withOrphan.orphan.topicId).toBe('topic-orphan')
    // 而真正开着的那些照旧在。
    expect(open.has('topic-a')).toBe(true)
  })

  it('没有 layout 时谁都不开', () => {
    expect(openTopicRegionMosaics(undefined, tabs).size).toBe(0)
  })

  it('缩略图几何取那张 Tab 的 Region 分屏，单区就是一整块', () => {
    const mosaics = openTopicRegionMosaics(fullLayout(), tabs)
    const single = mosaics.get('topic-b')
    expect(single).toBeDefined()
    // launcher 建的是单 Region 的 Tab：一块占满 0–1。
    expect(single).toEqual([{ regionId: 'region:b-1', bounds: { x: 0, y: 0, width: 1, height: 1 } }])
  })

  it('分屏的 Tab 缩略图铺出多块，几何来自 workbenchRegionBounds 而非另发明一套', () => {
    // 把 topic-b 那张 Tab 竖切成左右两半，缩略图应铺出两块、各占半宽。
    const split = { ...launcher('b-1', 'topic-b') }
    split.layout = splitWorkbenchRegion(split.layout, 'region:b-1', 'right', 'region:b-1b')
    const splitTabs: Record<string, WorkbenchTab> = { ...tabs, 'b-1': split }
    const bounds = openTopicRegionMosaics(fullLayout(), splitTabs).get('topic-b')
    expect(bounds).toHaveLength(2)
    // 与 workbenchRegionBounds 逐字一致——这是它的缩影，不是第二套布局模型。
    expect(bounds).toEqual(workbenchRegionBounds(split.layout.root))
    // 左右两半各占半宽，合起来铺满。
    expect(bounds!.map((region) => region.bounds.width)).toEqual([0.5, 0.5])
  })

  it('一个 Topic 开着多张 Tab 时取当前活动那张的几何', () => {
    // topic-a 有 a-1、a-2 两张。让**先**出现在 tabs 迭代序里的 a-1 分屏成两块并成为活动项，
    // a-2 保持单块且**后**出现。这样「取活动那张」得 a-1 的两块，而「取最后一张（覆盖式）」会得
    // a-2 的一块——两者答案不同，能把「谁优先」这条判据单独钉出来（否则活动项恰好最后时二者重合）。
    const a1 = { ...launcher('a-1', 'topic-a') }
    a1.layout = splitWorkbenchRegion(a1.layout, 'region:a-1', 'down', 'region:a-1b')
    // 展开保留插入序：a-1 在 a-2 之前。
    const multiTabs: Record<string, WorkbenchTab> = { ...tabs, 'a-1': a1 }
    let layout = createWorkspaceLayout('group', ['a-1'])
    for (const id of ['a-2', 'b-1', 'loose']) layout = addTab(layout, 'group', id)
    layout = activateTab(layout, 'group', 'a-1')
    const bounds = openTopicRegionMosaics(layout, multiTabs).get('topic-a')
    expect(bounds).toHaveLength(2)
    expect(bounds).toEqual(workbenchRegionBounds(a1.layout.root))
  })
})
