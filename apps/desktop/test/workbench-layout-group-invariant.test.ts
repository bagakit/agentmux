import { describe, expect, it } from 'vitest'
import {
  addTab,
  assertGroupInvariant,
  createWorkspaceLayout,
  groupIds,
  moveTab,
  moveTabToNewGroup,
  removeTab,
  type TabGroup,
  type TabGroupLayoutNode,
  type WorkspaceLayout
} from '../src/renderer/src/lib/workbench-layout'
import {
  activeTopicIdFromLayout,
  layoutForActiveTopic
} from '../src/renderer/src/lib/scratch-topic-layout'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

/**
 * `assertGroupInvariant` 是 region 侧 `assertRegionInvariant`（workbench-region-invariant.test.ts）在
 * **工作区这一层**的对偶：那半守「Region 树 ↔ tab.regions 表」，这半守「tab-group 树 ↔ layout.groups
 * 数组」。历史代价有据——off-tree group（记录多、树里没有对应叶）已复发两次（ad00a5e、dfd63eb），#556
 * 是同一族三连缺陷。这个文件分两块：
 *
 *   1. 断言本身在**两个违约方向上都真的抛**、消息把 id 归到正确的一侧（判据的健全性）；
 *   2. 三个会重排分屏树的 reducer（`removeTab` / `moveTab` / `moveTabToNewGroup`）在各自出口都**真的调到**
 *      那道闸（接线）——不测断言函数本身，测 reducer。本仓记过这一族失败：把守卫抽成函数，然后没人守
 *      「壳有没有真的调它」（extracting-to-lib-only-fixes-half）。
 *
 * 每条 `it` 都能被单独变红：删掉某个 reducer 的断言调用 → 对应那条接线测试红；把断言削成单向 → 相反方向
 * 那条红；在断言开头插 `return` → 所有期望抛出的都红。
 */

/**
 * 往 `groups` 里塞一个**不进 `root`** 的真分组（record-without-leaf）。没有生产 API 造得出这个状态，
 * 是刻意手工构造——它就是「把浮层做成一个不在主区分屏树里渲染的真分组」会得到的形状，也是复发过两次的
 * 那一种。与 workbench-layout-off-tree-group.test.ts 的同名构造一致。
 */
function withOffTreeGroupRecord(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string
): WorkspaceLayout {
  const group: TabGroup = { id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }
  return { ...layout, groups: [...layout.groups, group] }
}

/**
 * 往 `root` 里塞一片**没有对应记录**的叶子（leaf-without-record）。渲染层拿这个 groupId 去 `findGroup`
 * 会得到 null，画成一只永远空的破格。同样是类型合法、可构造、生产 API 造不出的防御性状态。
 *
 * 关键：这片 orphan 叶子挂在树的另一侧，reducer 针对**别的** groupId 做 `removeLeaf` / `replaceLeaf`
 * 时它原样留存——于是 reducer 重排完树、在出口断言时，这片孤儿叶仍在树里、仍无记录，闸就该抓到它。
 * 这正是用来证明「reducer 的出口真的调到了断言」的载体。
 */
function withOrphanTreeLeaf(layout: WorkspaceLayout, orphanGroupId: string): WorkspaceLayout {
  const orphanLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: orphanGroupId }
  const root: TabGroupLayoutNode = {
    type: 'split',
    direction: 'horizontal',
    first: layout.root,
    second: orphanLeaf,
    ratio: 0.5
  }
  return { ...layout, root }
}

/** 主区已分屏、两片叶子都在 `groups` 里的一致布局：g1 一张、g2 一张。 */
function splitTwoGroups(): WorkspaceLayout {
  return moveTabToNewGroup(
    createWorkspaceLayout('g1', ['tab:a', 'tab:b']),
    'tab:b',
    'g1',
    'g1',
    'right',
    'g2'
  )
}

describe('assertGroupInvariant 是判定「tab-group 树 ↔ layout.groups 数组」两侧集合相等的生产断言', () => {
  it('两侧逐一相等时不抛', () => {
    expect(() => assertGroupInvariant(createWorkspaceLayout('g1', ['tab:a']))).not.toThrow()
    expect(() => assertGroupInvariant(splitTwoGroups())).not.toThrow()
  })

  it('记录多一条（groups 里有、树里没有的死分组）→ 抛出，且消息把它归到「无树叶」那一侧', () => {
    // 纯 record-without-leaf：树只有 g1，groups 多了一个不在树里的 floating。
    const layout = withOffTreeGroupRecord(createWorkspaceLayout('g1', ['tab:a']), 'floating', 'tab:f')
    // 前提自检：这个 fixture 只违约一个方向（否则单向变异也可能靠另一个方向的违约照旧抛，假绿）。
    expect(groupIds(layout.root)).toEqual(['g1'])
    expect(layout.groups.map((group) => group.id)).toEqual(['g1', 'floating'])

    expect(() => assertGroupInvariant(layout)).toThrow(/group records with no tree leaf: \[floating\]/)
    // 若断言被削成「只查 leaf-without-record」，这一侧不再被检查 → 上面这句不再抛 → 本条红。
  })

  it('树里多一叶（groups 表画不到的孤儿叶）→ 抛出，且消息把它归到「无记录」那一侧', () => {
    // 纯 leaf-without-record：groups 只有 g1，树里多一片 orphan。
    const layout = withOrphanTreeLeaf(createWorkspaceLayout('g1', ['tab:a']), 'orphan')
    expect(groupIds(layout.root).sort()).toEqual(['g1', 'orphan'])
    expect(layout.groups.map((group) => group.id)).toEqual(['g1'])

    expect(() => assertGroupInvariant(layout)).toThrow(/Tree leaves with no group record: \[orphan\]/)
    // 若断言被削成「只查 record-without-leaf」，这一侧不再被检查 → 上面这句不再抛 → 本条红。
  })
})

describe('三个重排分屏树的 reducer 各自在出口调到了那道闸（接线层）', () => {
  // 每条接线测试都喂一个「带一片一路留存的孤儿叶」的输入：reducer 针对别的分组重排完树后，孤儿叶仍在
  // 树里、仍无记录，出口那次 assertGroupInvariant(next) 该当场抓到。删掉那一行调用 → next 被原样返回、
  // 不再抛 → 对应这条测试红。因为每条只调它自己那个 reducer，删别的 reducer 的调用不影响本条（干净归属）。

  it('removeTab：收掉一个真分组时，出口断言抓到一路留存的孤儿叶', () => {
    // 收掉 g2（它的最后一张 Tab），走的是 removeTab 的「重排树」出口（removeLeaf + groups.filter）。
    const seeded = withOrphanTreeLeaf(splitTwoGroups(), 'orphan')
    expect(() => removeTab(seeded, 'g2', 'tab:b')).toThrow(/orphan/)
  })

  it('moveTab：跨组移动搬空源分组时，出口断言抓到一路留存的孤儿叶', () => {
    // 把 g1 的唯一那张 Tab 移进 g2，g1 被搬空，走 moveTab 的跨组出口（sourceOrder 为空 → removeLeaf + filter）。
    const seeded = withOrphanTreeLeaf(splitTwoGroups(), 'orphan')
    expect(() => moveTab(seeded, 'tab:a', 'g1', 'g2', 0)).toThrow(/orphan/)
  })

  it('moveTabToNewGroup：分裂出新分组时，出口断言抓到一路留存的孤儿叶', () => {
    // 从 g1 里把 tab:b 拆到一个新分组 g2（往树里加一片新叶 g2），走 moveTabToNewGroup 的出口。
    const seeded = withOrphanTreeLeaf(createWorkspaceLayout('g1', ['tab:a', 'tab:b']), 'orphan')
    expect(() =>
      moveTabToNewGroup(seeded, 'tab:b', 'g1', 'g1', 'right', 'g2')
    ).toThrow(/orphan/)
  })

  it('一致输入走正常路径不抛：创建→分裂→跨组移动→收组全程都合法', () => {
    // 反面担保：断言不能过度敏感，否则每次正常布局改动都会崩。这条把三个 reducer 串起来跑一遍，
    // 每步的 storedLayout 都必须通过断言。
    let layout = createWorkspaceLayout('g1', ['tab:a', 'tab:b'])
    expect(() => assertGroupInvariant(layout)).not.toThrow()

    layout = moveTabToNewGroup(layout, 'tab:b', 'g1', 'g1', 'right', 'g2')
    expect(() => assertGroupInvariant(layout)).not.toThrow()
    expect(groupIds(layout.root).sort()).toEqual(['g1', 'g2'])

    layout = moveTab(layout, 'tab:b', 'g2', 'g1', 1) // 搬回 g1，g2 被搬空并收掉
    expect(() => assertGroupInvariant(layout)).not.toThrow()
    expect(groupIds(layout.root)).toEqual(['g1'])

    layout = removeTab(layout, 'g1', 'tab:b')
    expect(() => assertGroupInvariant(layout)).not.toThrow()
  })
})

describe('layoutForActiveTopic 的超集投影是合法的只读派生，绝不走这道闸', () => {
  function tab(id: string, topicId?: string): WorkbenchTab {
    const base = createWorkbenchTab(id, { regionId: `region:${id}`, kind: 'launcher', workspaceId: 'scratch' })
    return topicId === undefined ? base : { ...base, topicId }
  }

  // g1 装 topic-a 的 Tab，g2 装 topic-b 的 Tab；两片叶子都在树里。
  const TABS: Record<string, WorkbenchTab> = {
    'a-1': tab('a-1', 'topic-a'),
    'b-1': tab('b-1', 'topic-b')
  }

  function twoTopicGroups(): WorkspaceLayout {
    let layout = createWorkspaceLayout('g1', ['a-1'])
    layout = addTab(layout, 'g1', 'b-1')
    return moveTabToNewGroup(layout, 'b-1', 'g1', 'g1', 'right', 'g2')
  }

  it('投影出一个 groups ⊇ 树叶 的超集，且这一步本身不抛（投影路径不含断言）', () => {
    const stored = twoTopicGroups()
    // 前提自检：存储布局是一致的（投影不是从一个已损坏的树里长出来的）。
    expect(() => assertGroupInvariant(stored)).not.toThrow()

    // scratch-topic-layout.ts:188-197 的原话：投影到空的分组用 removeLeaf 摘出树，但 groups 数组
    // **不删**——那是存储真相的投影，别的 Topic 的 Tab 还在里面，删了切回去就找不回来了。
    // 于是 topic-a 视图里 g2 从树上消失、却留在 groups 数组里，形成一个 record-without-leaf 的超集。
    expect(() => layoutForActiveTopic(stored, TABS, 'topic-a')).not.toThrow()
    const projection = layoutForActiveTopic(stored, TABS, 'topic-a')
    expect(groupIds(projection.root)).toEqual(['g1'])
    expect(projection.groups.map((group) => group.id).sort()).toEqual(['g1', 'g2'])
  })

  it('正因为它是超集，双向断言会拒绝它——所以断言只贴在 reducer 出口的 storedLayout 上、且必须保持双向', () => {
    // 这条把「为什么不能把断言加在投影上」「为什么不能把断言削成单向」两件事一次钉死：
    //   - 若真把 assertGroupInvariant 套在投影路径上，它会对一个**刻意的、合法的**超集报错（下面这句就是
    //     证据：投影确实会被现在这个双向断言拒绝）。所以断言绝不碰投影，只贴在 storedLayout 的 reducer 出口。
    //   - 若为了「容纳这个超集」把断言削成单向（只查 leaf-without-record），那么这句 `.toThrow` 不再成立
    //     → 本条红；而那样一削，off-tree-group（record-without-leaf，复发过两次的那一种）就被放行了。
    const projection = layoutForActiveTopic(twoTopicGroups(), TABS, 'topic-a')
    expect(() => assertGroupInvariant(projection)).toThrow(/group records with no tree leaf: \[g2\]/)
  })

  it('moveTabWithinActiveTopic 喂给 reducer 的是 storedLayout 而不是投影（投影绝不回流）', () => {
    // 接线层的另一半：投影是只读的，写路径吃的是未投影的存储布局。这里直接跑一次正常拖动，验证结果
    // 仍是一致布局（若哪天有人把投影回流进 reducer，reducer 出口的双向断言会当场抓到）。
    const stored = twoTopicGroups()
    // moveTabToNewGroup 收尾把 activeGroupId 落到新分组 g2（装 b-1），故当前 Topic 是 topic-b。
    expect(activeTopicIdFromLayout(stored, TABS)).toBe('topic-b')
    // 在 g1 内正常挪动它的 Tab：结果必须仍是一致的 storedLayout。
    const moved = moveTab(stored, 'a-1', 'g1', 'g1', 0)
    expect(() => assertGroupInvariant(moved)).not.toThrow()
  })
})
