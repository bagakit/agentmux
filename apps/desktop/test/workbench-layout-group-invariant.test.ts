import { describe, expect, it } from 'vitest'
import {
  addTab,
  assertGroupInvariant,
  createWorkspaceLayout,
  findGroupForTab,
  groupIds,
  moveTab,
  moveTabToNewGroup,
  removeTab,
  type TabGroup,
  type TabGroupLayoutNode,
  type WorkspaceLayout
} from '../src/renderer/src/lib/workbench-layout'
import {
  projectPersistedWorkbench,
  restorePersistedWorkbench
} from '../src/renderer/src/lib/workbench-persistence'
import type { AppConfig } from '../src/shared/contracts'
import {
  activeTopicIdFromLayout,
  layoutForActiveTopic
} from '../src/renderer/src/lib/scratch-topic-layout'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

/** 一张能活过持久化投影的 Tab：file 面在其 workspace 仍被配置时生还（见 persistedSurfaceSurvives）。 */
function fileTab(id: string): WorkbenchTab {
  return createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'file',
    workspaceId: 'ws',
    path: `${id}.ts`
  })
}

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

  /**
   * 上面三条都喂「入场就带一片孤儿叶」的输入，于是断言的**操作数**不可观测：`assertGroupInvariant(next)`
   * 与 `assertGroupInvariant(layout)` 都会抛，因为那片孤儿叶在输入里、也在输出里。实测把三处全改成
   * 判 `layout` → 15 条全绿（#576）。而守卫存在的意义恰是抓「reducer **自己算出来的** 输出坏了」。
   *
   * 补法不是「造一个干净输入让输出违约」——那不可达：三个 reducer 对合法输入恒产出合法输出（要让输出坏
   * 必须先把实现改坏，那时判哪个操作数都红，仍分不开）。可达的是**反过来**：输入违约、而 reducer 正当地
   * 把它清掉，于是输出干净。这一对世界就分开了：
   *   - 判 `next`（正确）→ 输出干净 → 不抛 → 本条绿；
   *   - 判 `layout`（把操作数换成输入）→ 输入违约 → 抛 → 本条红。
   *
   * 载体是 off-tree group：`floating` 只在 `groups` 里、不在树里（record-without-leaf，复发过两次的那种）。
   * 把它名下唯一那张 Tab 移进 g1，`moveTab` 走「源被搬空」出口，`removeLeaf` 因它不在树里而不动树、
   * `groups.filter` 把那条鬼影记录摘掉——正好把两侧拉回相等。这同时是一条有价值的行为断言：从鬼影分组
   * 里搬走最后一张 Tab 应当**回收**那条记录，而不是在出口炸掉。
   */
  it('输入违约、reducer 把它清干净时不抛（判据落在输出上，换成判输入即红）', () => {
    const seeded = withOffTreeGroupRecord(createWorkspaceLayout('g1', ['tab:a']), 'floating', 'tab:f')

    // 前提自检 1：输入**真的**违约，且只违约「记录多、树里没有」这一个方向。否则本条退化成一条
    // 普通的「合法输入不抛」，与上面那条重复，且对操作数不再敏感。
    expect(groupIds(seeded.root)).toEqual(['g1'])
    expect(seeded.groups.map((group) => group.id)).toEqual(['g1', 'floating'])
    expect(() => assertGroupInvariant(seeded)).toThrow(/group records with no tree leaf: \[floating\]/)

    // 判据本体：出口断言看的是算出来的 next，故这次调用必须走完、不抛。
    const moved = moveTab(seeded, 'tab:f', 'floating', 'g1', 1)

    // 前提自检 2：真的走了「源被搬空」那条**带断言**的出口（而不是别的早退），证据是鬼影记录被回收了。
    expect(moved.groups.map((group) => group.id)).toEqual(['g1'])
    expect(findGroupForTab(moved, 'tab:f')?.id).toBe('g1')
    // 前提自检 3：输出确实干净——否则「不抛」是因为断言没被调到，而不是因为它判的是干净的输出。
    expect(() => assertGroupInvariant(moved)).not.toThrow()
  })

  /**
   * 同一个反向判据用在 `moveTabToNewGroup` 上：它的出口也自己算 `next`，操作数同样此前不可观测。
   *
   * 载体与上一条相同（off-tree `floating`），路径不同：把 `floating` 名下唯一那张 Tab 拆成一个新分组 `g2`
   * ——`replaceLeaf` 把目标格 g1 换成含 g2 的 split（树里新增一片有记录的叶），源被搬空于是
   * `removeLeaf` + `groups.filter` 把 `floating` 摘掉。`removeLeaf` 对不在树里的 groupId 是 no-op
   * （split-tree.ts:185-196），所以树只多了 g2；`groups` 少了鬼影、多了 g2。两侧回到相等。
   *
   * 第三个 reducer `removeTab` **不在这条判据的射程内**，这是机制事实不是遗漏：它的两个违约方向都构造在
   * 被收的那个 groupId 上，而 `sourceOrder.length > 0 || !leafIds.includes(groupId) || leafIds.length === 1`
   * 这道三项闸会在断言之前提前返回（实测：off-tree 记录 + 收别的真分组 → 鬼影留存于输出，判 next 也抛；
   * 树里孤儿叶 + 收那个孤儿 id → `findGroup` 得 null，第一行就原样返回）。故 `removeTab` 出口的操作数
   * （workbench-layout.ts:422）今天仍不可观测——#576 应据此收窄，不许当成三处都盯住了。
   */
  it('moveTabToNewGroup 同样把违约输入清干净：判据落在输出上，换成判输入即红', () => {
    const seeded = withOffTreeGroupRecord(createWorkspaceLayout('g1', ['tab:a']), 'floating', 'tab:f')

    // 前提自检 1：输入真的违约，且只违约「记录多、树里没有」这一个方向。
    expect(groupIds(seeded.root)).toEqual(['g1'])
    expect(() => assertGroupInvariant(seeded)).toThrow(/group records with no tree leaf: \[floating\]/)

    // 判据本体：出口断言看的是算出来的 next，故这次调用必须走完、不抛。
    const split = moveTabToNewGroup(seeded, 'tab:f', 'floating', 'g1', 'right', 'g2')

    // 前提自检 2：真的走了「replaceLeaf 加新叶 + 源被搬空摘掉」这条**带断言**的出口。证据有两条：
    // 树里多了 g2（replaceLeaf 生效），且鬼影记录被回收（filter 生效）。
    expect(groupIds(split.root).sort()).toEqual(['g1', 'g2'])
    expect(split.groups.map((group) => group.id).sort()).toEqual(['g1', 'g2'])
    expect(findGroupForTab(split, 'tab:f')?.id).toBe('g2')
    // 前提自检 3：输出确实干净——否则「不抛」是因为断言没被调到。
    expect(() => assertGroupInvariant(split)).not.toThrow()
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

describe('持久化边界先把「树 ↔ groups」漂移抢救掉，两个入口都不许让断言炸出来', () => {
  /**
   * 与 region 侧 workbench-persisted-region-drift.test.ts 完全同构的一族。
   *
   * `assertGroupInvariant` 是无条件 throw 的生产断言，而 `removeTab` 在**两个持久化入口**上都会被
   * 调用（`keepTabsInLayout` 的两个调用点）。localStorage 里的内容是用户数据，这道断言是本轮才装上
   * 的，所以盘上完全可能已经躺着一个漂移的布局。爆炸半径两个入口不同：
   *   - `projectPersistedWorkbench`（zustand `partialize`，**每次写入都跑**）→ 抛在 `set()` 里，
   *     任意一次用户操作变成崩溃，且此后再也写不进去；
   *   - `restorePersistedWorkbench`（启动恢复）→ 整个 Workbench 落回空白。
   *
   * 漂移**不必**由持久化数据自己带来，这是本族最容易被漏掉的一半：`removeTab` 那条 within-record
   * 出口**刻意容忍**入场时就在的 off-tree group（workbench-layout.ts:407-411 明写这条容忍）。于是
   * 一个今天完全合法的运行时状态存下来，下一次写入只要在**另一个**分组上触发收组，就连带炸掉。
   *
   * 判据有两半，缺一不可（与 region 侧同一条理由）：
   *   - 抢救真的发生了（不抛、交出来的布局自己满足不变量、幸存分组的 Tab 没被换掉）；
   *   - 断言仍然是**无条件**的（直接拿漂移布局调它必须抛，见上面那个 describe）。
   * 后者防的是「把断言削成 no-op / dev-only」这种让前半截也一起转绿的假修法。
   */

  /** 两个分组各一张 Tab，外加一条 off-tree 的 `floating` 记录（探针实测的那个形状）。 */
  function driftedPersistedLayout(): WorkspaceLayout {
    return withOffTreeGroupRecord(splitTwoGroups(), 'floating', 'tab:f')
  }

  it('partialize 路径：漂移布局 + 一张 Tab 已不在场，不抛且把死记录摘掉', () => {
    const layout = driftedPersistedLayout()
    // 前提自检：这个 fixture 真的漂移了，否则本条退化成「干净输入不抛」而测不到抢救。
    expect(() => assertGroupInvariant(layout)).toThrow(/floating/)

    // tabs 为空 ⇒ keepTabsInLayout 会摘掉每个分组的每张 Tab，g2 被收组 → 触发 removeTab 的断言出口。
    const projected = projectPersistedWorkbench({ tabs: {}, layouts: { ws: layout } })

    const next = projected.layouts.ws!
    expect(() => assertGroupInvariant(next), '抢救后的布局自己仍然违约').not.toThrow()
    expect(next.groups.map((group) => group.id)).not.toContain('floating')
  })

  it('启动恢复路径：同一个漂移布局也不许抛，且幸存分组保住它那张 Tab', () => {
    const layout = driftedPersistedLayout()
    const config = { workspaces: [{ id: 'ws', name: 'ws', path: '/ws' }] } as unknown as AppConfig

    const restored = restorePersistedWorkbench({
      config,
      sessions: [],
      // tabs 表里留下 tab:a（属于 g1）：它必须活下来，g2/floating 的 Tab 没有记录故被摘。
      persisted: { tabs: { 'tab:a': fileTab('tab:a') }, layouts: { ws: layout } },
      createTabGroupId: () => 'fresh'
    })

    const next = restored.layouts.ws!
    expect(() => assertGroupInvariant(next), '抢救后的布局自己仍然违约').not.toThrow()
    expect(next.groups.map((group) => group.id)).not.toContain('floating')
    // 抢救不是「清空重来」：留存那张 Tab 还在它原来的分组里。
    expect(findGroupForTab(next, 'tab:a')?.id).toBe('g1')
  })

  it('抢救必须排在 removeTab 之前——把顺序调过来，上面两条就是断言直接炸出来的样子', () => {
    // 这一条钉的是**顺序**，而不是「抢救存在」。上面两条只要抢救在场就绿，无论它排在收组前还是后；
    // 而排在后面时 `removeTab` 先跑、先抛，抢救永远等不到。这里用一次显式的「先收组」证明那个世界
    // 真的会抛，从而说明前两条的绿是顺序买来的，不是巧合。
    const layout = driftedPersistedLayout()
    expect(() => removeTab(layout, 'g2', 'tab:b'), '先收组竟然没抛，那前两条的绿就不是顺序买来的')
      .toThrow(/group records with no tree leaf: \[floating\]/)
  })

  it('另一个方向也要摘：树上的孤儿叶必须从树里删掉，不能只清 groups 表', () => {
    // 上面三条全是 record-without-leaf。抢救的两个方向是**各自独立**的代码：只清 ghost 记录、
    // 完全不动树，上面每一条照旧全绿（实测：在本条存在**之前**删掉那行 `removeLeaf` 循环，当时
    // 全部 14 条全过；本条加进来后同一个变异立刻 1 红）。所以这一条是那半边唯一的靶子。
    //
    // 孤儿叶对用户的样子不是「不可见」而是「一只画不出内容的破格」：渲染层拿 `orphan` 去 findGroup
    // 得到 null。留着它还有第二层代价——它让整个布局**永久违约**，于是下一次任何触发收组的写入
    // 都会在 removeTab 出口抛，即抢救没有真的把布局带回可写状态。
    const layout = withOrphanTreeLeaf(splitTwoGroups(), 'orphan')
    // 前提自检：只违约这一个方向（记录不多，树多一片），否则本条会被 ghost 那半边的修复顺带变绿。
    expect(groupIds(layout.root)).toContain('orphan')
    expect(layout.groups.map((group) => group.id)).toEqual(['g1', 'g2'])
    expect(() => assertGroupInvariant(layout)).toThrow(/orphan/)

    const projected = projectPersistedWorkbench({ tabs: {}, layouts: { ws: layout } })

    const next = projected.layouts.ws!
    expect(() => assertGroupInvariant(next), '抢救后的布局自己仍然违约').not.toThrow()
    expect(groupIds(next.root), '孤儿叶还在树里').not.toContain('orphan')
  })

  it('两侧毫无交集时原样交出，不编一棵树出来', () => {
    // 树只有 g1、记录只有 floating：一个可画的分组都没有。此时**编**一个 id 交出去比留着可识别的
    // 坏数据更坏（与 normalizePersistedLayout 的同款判断一致），所以原样返回、让它继续被识别成漂移。
    const layout: WorkspaceLayout = {
      root: { type: 'leaf', groupId: 'g1' },
      groups: [{ id: 'floating', tabOrder: ['tab:f'], activeTabId: 'tab:f', recentTabIds: ['tab:f'] }],
      activeGroupId: 'floating'
    }
    // tabs 为空，但 floating 的 tabOrder 非空 → keepTabsInLayout 会对它调 removeTab；那条 within-record
    // 出口刻意不套断言（它不动树），所以这一路不抛，抢救的「不动手」也不该把它变成抛。
    const projected = projectPersistedWorkbench({ tabs: {}, layouts: { ws: layout } })

    const next = projected.layouts.ws!
    expect(groupIds(next.root)).toEqual(['g1'])
    expect(next.groups.map((group) => group.id)).toEqual(['floating'])
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
