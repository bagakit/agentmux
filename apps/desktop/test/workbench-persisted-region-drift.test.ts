import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import { CONFIG_VERSION } from '../src/shared/contracts.js'
import { createWorkspaceLayout, groupIds, MIN_SPLIT_RATIO, EVEN_SPLIT_RATIO, clampSplitRatio, regionIds, splitWorkbenchRegion } from '@agentmux/layout'
import {
  assertRegionInvariant,
  createWorkbenchTab,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  describePersistedTabRepairs,
  projectPersistedWorkbench,
  restorePersistedWorkbench,
  type PersistedWorkbench
} from '../src/renderer/src/lib/workbench-persistence.js'

/**
 * `assertRegionInvariant`（#515）是**无条件** throw 的生产断言，而 `removeWorkbenchRegion` 在两个
 * 持久化入口上都被调用。localStorage 里的内容是用户数据，而这条断言是本轮才装上的——此前发货的版本
 * 没有任何 reducer 守着它，所以盘上完全可能已经躺着一张「树 ↔ regions 表」漂移的 Tab。
 *
 * 两条被这个测试钉住的路径，各自的爆炸半径不同：
 *   1. `restorePersistedWorkbench` —— 启动恢复。抛出即整个 Workbench 落回空白（#59/#60 那个
 *      「重启后 tab 和分屏没了」的形状）。
 *   2. `projectPersistedWorkbench` —— zustand 的 `partialize`，**每次持久化写入都会跑**。在这里抛出
 *      会把任意一次用户操作变成崩溃，且此后再也写不进去。
 *
 * 修法刻意落在**边界上**（`reconcilePersistedTab` 取两侧交集），而不是把断言削成 dev-only：削掉它就
 * 等于把守卫从唯一真正需要它的环境（生产）里拿走。所以本文件的判据有两半，缺一不可——
 *   - 抢救真的发生了（不抛、留下的 Tab 自己满足不变量、幸存那一格的内容没被换掉）；
 *   - 断言仍然是无条件的（对一张漂移的 Tab 直接调它必须抛）。
 * 后者防的是「把断言改成 no-op / dev-only」这种让前半截也一起转绿的修法。
 */

/**
 * 越界比例的锚点。写死历史字面量而不从 `MIN_SPLIT_RATIO` 派生：派生出的样本会跟着被测常量一起漂移，
 * 于是「它越界」在任何下界取值下都恒真，判据消失（本仓 expected-value-must-not-derive-from-mutation-target）。
 *
 * 0.12 与 0.1 分别是「今天越界」与「当年的下界」：region 树曾用 0.1，所以 0.12 是一条**当年合法**的
 * 磁盘记录，不是凭空构造的坏数据。这两个数一起说明了这条缺陷为什么可达（见 split-tree.ts 的说明）。
 */
const STALE_RATIO = 0.12
const LEGACY_MIN_SPLIT_RATIO = 0.1

const config: AppConfig = {
  version: CONFIG_VERSION,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

/**
 * 用 `file` 面而不是 `launcher` 面：`persistedSurfaceSurvives` 让未绑定 Topic 的 launcher 面在恢复时
 * 被正当丢弃（`hasTopic` 为假），那样整张 Tab 会因「一格都不剩」而消失——测出来的就不是抢救行为了。
 * file 面在其 workspace 仍被配置时两条路径都生还，是唯一能让「抢救后还剩东西」可观测的载荷。
 */
function file(regionId: string, path: string): WorkbenchSurface {
  return { regionId, kind: 'file', workspaceId: 'workspace', path }
}

/**
 * 一张持久化 Tab，树里是 r0|r1，regions 表额外多一条树里不存在的 `ghost`。
 * 这正是 #515 之前的代码能写出来的形状：两侧各改一半、无人断言。
 */
function tabWithGhostInMap(): WorkbenchTab {
  const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
  return {
    ...base,
    layout: splitWorkbenchRegion(base.layout, 'r0', 'right', 'r1'),
    regions: { r0: file('r0', '/repo/a.ts'), r1: file('r1', '/repo/b.ts'), ghost: file('ghost', '/repo/ghost.ts') }
  }
}

/** 反方向：树里有 r0|r1 两叶，regions 表只认 r0——r1 是画成 null 的孤儿叶。 */
function tabWithOrphanLeaf(): WorkbenchTab {
  const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
  return {
    ...base,
    layout: splitWorkbenchRegion(base.layout, 'r0', 'right', 'r1'),
    regions: { r0: file('r0', '/repo/a.ts') }
  }
}

/**
 * 焦点本身就落在一条要被摘掉的死记录上：树是 r0|r1（r1 是孤儿叶），表是 r0|ghost，
 * 而 `activeRegionId`/`titleRegionId` 都指着 `ghost`。
 *
 * 这一形状专门钉住「重新落座」那一步：`closeWorkbenchRegion` 只在它关掉的正好是活动格时才交接焦点，
 * 所以摘 r1 不会碰 `ghost`；若抢救不自己兜一次，界面就会拿一个已被摘掉的 id 去 regions 表里取，
 * 得到 undefined。上面那条孤儿叶用例覆盖不到这里——它的焦点本来就在幸存格上。
 */
function tabWithFocusOnGhost(): WorkbenchTab {
  const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
  const split = splitWorkbenchRegion(base.layout, 'r0', 'right', 'r1')
  return {
    ...base,
    titleRegionId: 'ghost',
    layout: { ...split, activeRegionId: 'ghost' },
    regions: { r0: file('r0', '/repo/a.ts'), ghost: file('ghost', '/repo/ghost.ts') }
  }
}

/** 交集为空：树只认 r9，表只认 r0——没有任何一格可画，整张 Tab 不可救。 */
function tabWithDisjointSides(): WorkbenchTab {
  const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
  return {
    ...base,
    layout: { root: { type: 'leaf', regionId: 'r9' }, activeRegionId: 'r9' },
    regions: { r0: file('r0', '/repo/a.ts') }
  }
}

function persisted(tab: WorkbenchTab): PersistedWorkbench {
  return { tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('group-1') } }
}

function restore(tab: WorkbenchTab) {
  return restorePersistedWorkbench({
    config,
    sessions: [],
    persisted: persisted(tab),
    createTabGroupId: () => 'group-1'
  })
}

describe('漂移的持久化 Tab 不得让无条件断言炸在持久化路径上（#515 边界抢救）', () => {
  // 前提自检：这些 fixture 必须真的违约。若哪天 fixture 被改成合法的，下面每条「不抛」都会退化成恒真。
  it.each([
    ['regions 表多一条死记录', tabWithGhostInMap],
    ['树里多一片孤儿叶', tabWithOrphanLeaf],
    ['焦点落在要被摘掉的死记录上', tabWithFocusOnGhost],
    ['两侧毫无交集', tabWithDisjointSides]
  ])('前提：fixture「%s」真的违反不变量（生产断言对它抛）', (_label, make) => {
    expect(
      () => assertRegionInvariant(make()),
      'fixture 不再违约——下面那些「不抛」的断言已退化成恒真'
    ).toThrow(/region invariant violated/)
  })

  it('启动恢复：不抛，且交出的 Tab 自己满足不变量', () => {
    const workbench = restore(tabWithGhostInMap())
    const restored = workbench.tabs.view
    expect(restored, '整张 Tab 被丢了——两侧还有 r0/r1 可画，不该丢').toBeDefined()
    // 交出去的东西必须自己合法，否则下游任何一次 reducer 都会在断言上炸。
    expect(() => assertRegionInvariant(restored!)).not.toThrow()
    // 抢救取交集：树认的 r0/r1 留下，表里那条树上没有的 ghost 被摘掉。
    expect(Object.keys(restored!.regions).sort()).toEqual(['r0', 'r1'])
    expect(regionIds(restored!.layout.root).sort()).toEqual(['r0', 'r1'])
  })

  it('启动恢复：孤儿叶被摘掉，幸存那一格的内容原样保留（不是重建一张空 Tab）', () => {
    const workbench = restore(tabWithOrphanLeaf())
    const restored = workbench.tabs.view
    expect(restored).toBeDefined()
    expect(() => assertRegionInvariant(restored!)).not.toThrow()
    expect(regionIds(restored!.layout.root)).toEqual(['r0'])
    // 载荷判据：抢救的是结构，不是内容。若实现改成「丢弃重建」，这条会红。
    expect(restored!.regions.r0).toEqual(file('r0', '/repo/a.ts'))
    // 焦点与标题格必须落在留存集合上，否则界面拿 activeRegionId 去 regions 表里取会得到 undefined。
    expect(restored!.layout.activeRegionId).toBe('r0')
    expect(restored!.titleRegionId).toBe('r0')
  })

  it('启动恢复：焦点落在被摘掉的死记录上时，重新落座到幸存格（否则界面取到 undefined）', () => {
    const workbench = restore(tabWithFocusOnGhost())
    const restored = workbench.tabs.view
    expect(restored).toBeDefined()
    expect(() => assertRegionInvariant(restored!)).not.toThrow()
    // 关键判据：activeRegionId 原本是 'ghost'，而 closeWorkbenchRegion 只摘 r1、不会碰它。
    // 抢救必须自己把焦点搬到留存集合上，否则 regions[activeRegionId] 是 undefined。
    expect(restored!.layout.activeRegionId).toBe('r0')
    expect(restored!.regions[restored!.layout.activeRegionId]).toBeDefined()
    // 标题格同理：它也指着 'ghost'。
    expect(restored!.titleRegionId).toBe('r0')
  })

  it('启动恢复：两侧无交集的 Tab 整张丢弃，且被报成 discarded 而不是 repaired', () => {
    const workbench = restore(tabWithDisjointSides())
    expect(workbench.tabs.view, '没有一格可画的 Tab 不该被交出去').toBeUndefined()
    expect(workbench.repairs).toEqual([
      {
        tabId: 'view',
        droppedGhostRegionIds: ['r0'],
        droppedOrphanLeafIds: ['r9'],
        // 这一类是 #571 加的第三种抢救（重复叶）。这张 fixture 里没有重复，所以是空数组——
        // 逐字写出来而不是换成 toMatchObject：这条断言的判据正是「抢救如实分类」，
        // 把比较放宽到子集就等于允许它把别的类别悄悄写满。
        droppedDuplicateLeafIds: [],
        discardedTab: true
      }
    ])
  })

  it('持久化写入（partialize）：不抛——在这里抛会让每一次写入都变成崩溃', () => {
    // projectPersistedWorkbench 跑在 zustand 的 partialize 里，所以它的失败面是「用户此后再也存不进
    // 任何布局」。这条与启动恢复那条各钉一次：两个入口各自调 removeWorkbenchRegion，缺一个就漏一半。
    expect(() => projectPersistedWorkbench(persisted(tabWithGhostInMap()))).not.toThrow()
    const projected = projectPersistedWorkbench(persisted(tabWithGhostInMap()))
    expect(() => assertRegionInvariant(projected.tabs.view!)).not.toThrow()
    expect(Object.keys(projected.tabs.view!.regions).sort()).toEqual(['r0', 'r1'])
  })

  it('干净的持久化数据不被当成需要抢救（repairs 为空，且 Tab 原样通过）', () => {
    const clean = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
    const workbench = restore(clean)
    // 没有这条，把 reconcile 写成「无论如何都重建一遍」也会让上面全部转绿。
    expect(workbench.repairs).toEqual([])
    expect(describePersistedTabRepairs(workbench.repairs)).toBeNull()
    expect(workbench.tabs.view!.regions).toEqual(clean.regions)
  })

  it('抢救过就必须有一句可见的用户向措辞，且分开数「修好的」与「丢掉的」', () => {
    const repaired = describePersistedTabRepairs(restore(tabWithGhostInMap()).repairs)
    expect(repaired, '抢救发生了却没有任何告知——静默修好等于用户无从查证').not.toBeNull()
    expect(repaired).toMatch(/1 tab repaired/)
    expect(repaired).not.toMatch(/discarded/)

    const discarded = describePersistedTabRepairs(restore(tabWithDisjointSides()).repairs)
    expect(discarded).toMatch(/1 unusable tab discarded/)
    expect(discarded).not.toMatch(/repaired/)
  })
})

/**
 * 取值归一化（#530/#531）。与上面那族的分工是**结构 vs 取值**，两者的报告纪律相反：
 * 结构抢救丢过东西，所以留一条用户可见的 repair；取值归一化对用户不构成损失（一个越界的比例、
 * 一个指向空处的焦点），说出来只是噪音，所以必须**静默**。
 *
 * 为什么这一族的 fixture 必须**结构干净**：这两件事此前都搭在结构抢救的车上，而
 * `reconcilePersistedTab` 开头就有一处早退（两侧无差异时原样返回）。于是结构干净的记录整批跳过归一化。
 * 上面那族的 fixture 全都同时结构漂移，所以它们只走抢救分支，对本族这条路径完全失明——这正是
 * 「焦点重座」明明已有实现却仍能带着陈旧 id 交到界面的原因（本仓 guard-must-check-reachability-not-presence）。
 *
 * 覆盖面是**两棵树 × 两件事**（split-tree.ts 说明了它们是同一棵树，只有叶子载荷不同）：
 * region 树的 ratio 与指针、tab-group 树的 ratio 与指针；且 region 侧的两个入口（启动恢复与
 * partialize 写入）各钉一次——两个入口各自调一遍归一化，只接一个就漏一半。
 */
describe('结构干净但取值陈旧的持久化记录必须被无条件归一化（#530/#531）', () => {
  /** 结构完全一致（树与表都是 r0|r1），只有根 ratio 是旧下界时代（0.1）写下的 0.12。 */
  function tabWithStaleRatio(): WorkbenchTab {
    const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
    const split = splitWorkbenchRegion(base.layout, 'r0', 'right', 'r1')
    return {
      ...base,
      layout: { ...split, root: { ...(split.root as never), ratio: STALE_RATIO } as never },
      regions: { r0: file('r0', '/repo/a.ts'), r1: file('r1', '/repo/b.ts') }
    }
  }

  /** 结构完全一致，但根节点**根本没有** ratio 这个键——比越界更早的一代磁盘记录。 */
  function tabWithAbsentRatio(): WorkbenchTab {
    const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
    const split = splitWorkbenchRegion(base.layout, 'r0', 'right', 'r1')
    const root = { ...(split.root as Record<string, unknown>) }
    delete root.ratio
    return {
      ...base,
      layout: { ...split, root: root as never },
      regions: { r0: file('r0', '/repo/a.ts'), r1: file('r1', '/repo/b.ts') }
    }
  }

  /** 结构完全一致，但 activeRegionId / titleRegionId 都指向树里根本没有的格。 */
  function tabWithStalePointer(): WorkbenchTab {
    const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
    const split = splitWorkbenchRegion(base.layout, 'r0', 'right', 'r1')
    return {
      ...base,
      titleRegionId: 'gone',
      layout: { ...split, activeRegionId: 'gone' },
      regions: { r0: file('r0', '/repo/a.ts'), r1: file('r1', '/repo/b.ts') }
    }
  }

  function rootRatio(root: unknown): number {
    const node = root as { type: string; ratio?: number }
    // 判据的前提：拿到的必须真是个 split。叶子没有 ratio，读出 undefined 会让下面的比较恒假地"通过"。
    expect(node.type, '这棵树的根不是 split——比例判据没有落点').toBe('split')
    return node.ratio!
  }

  // 前提自检：0.12 必须真的越界，否则每条「被夹回界内」都退化成恒真。锚点写死历史字面量而不从
  // MIN_SPLIT_RATIO 派生——派生会让样本跟着被测常量一起漂移（本仓 expected-value-must-not-derive-from-mutation-target）。
  it('前提：0.12 在今天的界外，且它正是旧下界 0.1 时代的合法值', () => {
    expect(STALE_RATIO).toBeLessThan(MIN_SPLIT_RATIO)
    expect(STALE_RATIO).toBeGreaterThan(LEGACY_MIN_SPLIT_RATIO)
    // 若哪天下界被调回 0.1，上面两条仍成立而这条会红——它钉的是「今天的界是 0.15」这个前提本身。
    expect(MIN_SPLIT_RATIO).toBe(0.15)
  })

  // 前提自检：这些 fixture 必须结构干净。若哪天它们变成漂移的，就会绕道走抢救分支，
  // 而本族测的那条早退后面的路径重新变得无人守——且四条断言照旧全绿。
  it.each([
    ['ratio 越界', tabWithStaleRatio],
    ['指针指向不存在的格', tabWithStalePointer]
  ])('前提：fixture「%s」结构是干净的（不走抢救分支）', (_label, make) => {
    expect(
      () => assertRegionInvariant(make()),
      'fixture 结构漂移了——它会走抢救分支，本族守的那条路径重新无人守'
    ).not.toThrow()
    expect(restore(make()).repairs, '结构干净却报出了抢救记录').toEqual([])
  })

  it('启动恢复：越界的 ratio 被夹回今天的界', () => {
    const restored = restore(tabWithStaleRatio()).tabs.view
    expect(restored).toBeDefined()
    expect(rootRatio(restored!.layout.root)).toBe(MIN_SPLIT_RATIO)
  })

  it('partialize 写入：同一件事在写入侧也要做（两个入口各调一次，只接一个就漏一半）', () => {
    const projected = projectPersistedWorkbench(persisted(tabWithStaleRatio())).tabs.view
    expect(projected).toBeDefined()
    expect(rootRatio(projected!.layout.root)).toBe(MIN_SPLIT_RATIO)
  })

  /**
   * #552：ratio **完全缺席**（不是越界）时，归一化必须给出均分，而不是把缺席算成一个坏数。
   *
   * 这是我自己 #533 的回归，也是「无条件归一化」这个正确决定的一个未想到的输入：裸的
   * `Math.max(min, Math.min(max, undefined))` 是 `NaN`，而 `NaN` 会沿写入路径一路传播——
   * `clampSplitTreeRatios` 的身份早退比 `ratio === root.ratio`，`NaN === undefined` 为假，
   * 于是它**主动重建**一棵带 NaN 的树并交给 `partialize` 落盘。渲染侧那道 `?? 0.5`
   * （workbench-layout.ts:20-22 写明是给缺 ratio 的历史数据留的防线）接不住 NaN，因为
   * `??` 只认 null/undefined。所以缺省值必须由**边界**给出，不能留给下游兜。
   *
   * 判据落在「恰好是均分」而不是「是个有限数」：后者对 `return MIN_SPLIT_RATIO` 这类
   * 把两个面板画成 15/85 的实现也会通过，而那同样是一次可见的布局损坏。
   */
  describe('#552 ratio 完全缺席时归一化成均分（不是 NaN，也不是夹到下界）', () => {
    // 前提自检：fixture 真的没有这个键。少了这条，删掉 delete 之后下面两条会拿一个
    // 合法的 0.5 去比 EVEN_SPLIT_RATIO，恒真。
    it('前提：fixture 的根节点确实没有 ratio 键', () => {
      const root = tabWithAbsentRatio().layout.root as Record<string, unknown>
      expect(root.type).toBe('split')
      expect('ratio' in root, 'fixture 带着 ratio——本族要测的缺席形状不在场').toBe(false)
    })

    it('启动恢复：缺席的 ratio 变成均分', () => {
      const restored = restore(tabWithAbsentRatio()).tabs.view
      expect(restored).toBeDefined()
      expect(rootRatio(restored!.layout.root)).toBe(EVEN_SPLIT_RATIO)
    })

    it('partialize 写入：落盘的那份也是均分（NaN 会被 JSON 写成 null，此后永久跑偏）', () => {
      const projected = projectPersistedWorkbench(persisted(tabWithAbsentRatio())).tabs.view
      expect(projected).toBeDefined()
      const ratio = rootRatio(projected!.layout.root)
      expect(ratio).toBe(EVEN_SPLIT_RATIO)
      // 显式钉住「它经得起一次序列化往返」：NaN 在这一步会变成 null，而 null 是个
      // 类型上不合法、且下游只能靠兜底救回的值。判 Number.isFinite 不够——见本族标题。
      expect(JSON.parse(JSON.stringify({ ratio })).ratio).toBe(EVEN_SPLIT_RATIO)
    })

    it('缺席与越界走同一个出口，但答案不同（缺席→均分，越界→夹到界上）', () => {
      expect(clampSplitRatio(undefined as unknown as number)).toBe(EVEN_SPLIT_RATIO)
      expect(clampSplitRatio(Number.NaN)).toBe(EVEN_SPLIT_RATIO)
      expect(clampSplitRatio(STALE_RATIO)).toBe(MIN_SPLIT_RATIO)
      // 这一对不许相等，否则「缺席」与「越界」两类被折成一个答案，上面那条就分不出它们。
      expect(EVEN_SPLIT_RATIO).not.toBe(MIN_SPLIT_RATIO)
    })
  })

  it('启动恢复：陈旧的焦点与标题格落回树上（否则界面拿它取 regions 得到 undefined）', () => {
    const restored = restore(tabWithStalePointer()).tabs.view
    expect(restored).toBeDefined()
    const live = regionIds(restored!.layout.root)
    expect(live).toEqual(['r0', 'r1'])
    // 判据落在「取得到东西」上，而不是某个具体 id：兜底取读序首格是实现选择，不是合同。
    expect(live).toContain(restored!.layout.activeRegionId)
    expect(restored!.regions[restored!.layout.activeRegionId]).toBeDefined()
    expect(live).toContain(restored!.titleRegionId)
    expect(restored!.regions[restored!.titleRegionId]).toBeDefined()
  })

  it('归一化是静默的：修了取值不留 repair（那会把无损的修正报成数据丢失）', () => {
    for (const make of [tabWithStaleRatio, tabWithStalePointer]) {
      const workbench = restore(make())
      expect(workbench.repairs).toEqual([])
      expect(describePersistedTabRepairs(workbench.repairs)).toBeNull()
    }
  })

  it('tab-group 树：同一对毛病（它与 region 树是同一棵分屏树，只有叶子载荷不同）', () => {
    const base = createWorkspaceLayout('group-1')
    const stale: typeof base = {
      ...base,
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-1' },
        second: { type: 'leaf', groupId: 'group-2' },
        ratio: STALE_RATIO
      },
      groups: [...base.groups, { id: 'group-2', activeTabId: null, tabOrder: [], recentTabIds: [] }],
      activeGroupId: 'gone'
    }
    const restored = restorePersistedWorkbench({
      config,
      sessions: [],
      persisted: { tabs: {}, layouts: { workspace: stale } },
      createTabGroupId: () => 'group-1'
    }).layouts.workspace
    expect(restored).toBeDefined()
    expect(rootRatio(restored!.root)).toBe(MIN_SPLIT_RATIO)
    // 这一半的在场判据是**两侧都认**：只在树里的 id 交出去，下游 groups.find 得到 undefined；
    // 只在表里的交出去，Tab 会被挂到一个画不出来的分组上。所以两个集合都要质询。
    expect(groupIds(restored!.root)).toContain(restored!.activeGroupId)
    expect(restored!.groups.map((group) => group.id)).toContain(restored!.activeGroupId)
  })

  it('干净的记录原样返回同一个引用（省一次分配；这不是不变量，见 clampSplitTreeRatios 的说明）', () => {
    // 没有这条，把归一化写成「无论如何重建一遍」也会让上面全部转绿。
    // 但它守的是那个优化，不是正确性：本仓今天没有消费者按引用比较这棵树，所以若将来有正当理由
    // 放弃引用稳定，该改的是这条断言与那两段注释，而不是绕着它写。
    const clean = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
    const split = splitWorkbenchRegion(clean.layout, 'r0', 'right', 'r1')
    const tab: WorkbenchTab = {
      ...clean,
      layout: split,
      regions: { r0: file('r0', '/repo/a.ts'), r1: file('r1', '/repo/b.ts') }
    }
    // 前提：这棵树的比例本就在界内，否则「原样返回」是错的期望而非优化。
    expect(rootRatio(tab.layout.root)).toBeGreaterThanOrEqual(MIN_SPLIT_RATIO)
    expect(projectPersistedWorkbench(persisted(tab)).tabs.view!.layout.root).toBe(tab.layout.root)
  })
})

/**
 * 接线层。前面那些族全在 lib 里跑，所以「措辞算出来了」和「用户看得见」是两件事——本仓
 * `store.ts` 完全可以算出那句话然后丢掉（原缺陷正是「静默修好」），而上面 11 条一条都不会红。
 *
 * 判据落在 AST 上而不是文本上：文本 `toContain('describePersistedTabRepairs')` 被注释、被死变量、
 * 被 import 那一行本身满足（本仓 guard-criterion-must-be-import-relation 那族的反面）。这里问的是
 * 「那次调用的返回值最终流进了 `error:` 这个 store 字段」。
 *
 * 「最终」两个字是要紧的：措辞不必**直接**写进 `error:`，中间垫一个局部量是正常写法
 * （`const repairNotice = describe…(…)` → 汇入 `startupError` → `error: startupError || null`）。
 * 所以判据顺着**赋值链**走，而不是只看一跳——只看一跳会把一次纯粹的可读性重构误判成断线
 * （这条实测发生过：把重复调用提成一个局部量，一跳模型当场假红）。链式追踪并不会放松判据：
 * 链的起点仍必须是那次调用，终点仍必须是 `error:` 真读的那个名字，中间每一环都得是真的赋值。
 */
describe('抢救措辞必须真的接到用户可见的 store 字段上（#515 接线层）', () => {
  const STORE = new URL('../src/renderer/src/store.ts', import.meta.url)

  function sourceFile(): ts.SourceFile {
    return ts.createSourceFile(
      STORE.pathname,
      readFileSync(STORE.pathname, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
  }

  /** 包着 `node` 的最近一个变量声明的名字（用来判「这次调用喂给了哪个局部量」）。 */
  function enclosingVariableName(node: ts.Node): string | null {
    for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
      if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name)) return cursor.name.text
    }
    return null
  }

  /**
   * 把「谁的初始化里读了谁」建成一张边表：`const a = f(b, c)` 记下 a ← {b, c}。
   * 顺着它从措辞的落点向前传播，就能回答「这个名字有没有流进 error 读的那个量」。
   */
  function assignmentEdges(file: ts.SourceFile): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>()
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const reads = new Set<string>()
        const collect = (expr: ts.Node): void => {
          if (ts.isIdentifier(expr)) reads.add(expr.text)
          expr.forEachChild(collect)
        }
        collect(node.initializer)
        edges.set(node.name.text, reads)
      }
      node.forEachChild(walk)
    }
    walk(file)
    return edges
  }

  /** 从 `seeds` 出发，沿赋值链正向传播：谁的初始化读了链上的名字，谁也在链上。 */
  function reachableFrom(seeds: Iterable<string>, edges: Map<string, Set<string>>): Set<string> {
    const reached = new Set(seeds)
    for (let grew = true; grew; ) {
      grew = false
      for (const [target, reads] of edges) {
        if (reached.has(target)) continue
        if ([...reads].some((read) => reached.has(read))) {
          reached.add(target)
          grew = true
        }
      }
    }
    return reached
  }

  it('describePersistedTabRepairs 的返回值汇入了写进 error 的那个局部量', () => {
    const file = sourceFile()

    // 1) 找出全部 `describePersistedTabRepairs(...)` 调用，并记下它们各自落在哪个局部量里。
    const sinks = new Set<string>()
    let calls = 0
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'describePersistedTabRepairs'
      ) {
        calls += 1
        const sink = enclosingVariableName(node)
        if (sink !== null) sinks.add(sink)
      }
      node.forEachChild(walk)
    }
    walk(file)

    // 在场自检：没有这条，把整段接线删掉会让下面的断言集合双双为空而"通过"。
    expect(calls, 'store.ts 里没有任何 describePersistedTabRepairs 调用——抢救结果被算出来就丢了').toBeGreaterThan(0)

    // 2) 找出 `set({...})` 里 `error` 那一项，看它读的是谁。
    const errorSources = new Set<string>()
    const walkSet = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : null
        if (name === 'set' || name === 'setState') {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue
              if (!ts.isIdentifier(prop.name) || prop.name.text !== 'error') continue
              // `error: startupError || null` / `error: startupError` 都要认出 startupError。
              const collect = (expr: ts.Node): void => {
                if (ts.isIdentifier(expr)) errorSources.add(expr.text)
                expr.forEachChild(collect)
              }
              collect(prop.initializer)
            }
          }
        }
      }
      node.forEachChild(walkSet)
    }
    walkSet(file)

    expect(errorSources.size, 'store.ts 里没有任何 set({ error: ... })——判据的前提不成立').toBeGreaterThan(0)

    // 3) 关键判据：从措辞落点出发沿赋值链正向传播，必须够得到某次 `error:` 真读的那个名字。
    const downstream = reachableFrom(sinks, assignmentEdges(file))
    const wired = [...errorSources].some((source) => downstream.has(source))
    expect(
      wired,
      `抢救措辞落在 ${JSON.stringify([...sinks])}，沿赋值链能到 ${JSON.stringify([...downstream])}，` +
        `而 error 读的是 ${JSON.stringify([...errorSources])}` +
        '——两者不相交，说明那句话算出来了却送不到用户眼前'
    ).toBe(true)
  })
})
