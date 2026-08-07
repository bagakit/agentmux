import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import { CONFIG_VERSION } from '../src/shared/contracts.js'
import {
  assertGroupInvariant,
  createWorkspaceLayout,
  groupIds,
  type WorkspaceLayout
} from '../src/renderer/src/lib/workbench-layout.js'
import { EVEN_SPLIT_RATIO } from '../src/renderer/src/lib/split-tree.js'
import { regionIds } from '../src/renderer/src/lib/workbench-view-layout.js'
import {
  assertRegionInvariant,
  createWorkbenchTab,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import {
  projectPersistedWorkbench,
  restorePersistedWorkbench,
  type PersistedWorkbench
} from '../src/renderer/src/lib/workbench-persistence.js'

/**
 * 同一个 id 在一棵分屏树里出现两次，是持久化数据能长出来、而两条不变量断言**曾经**判得不一样的一种形状。
 * 这个文件专钉它，不重测「树 ↔ 记录表」那两个方向（那是 workbench-persisted-region-drift.test.ts 与
 * workbench-layout-group-invariant.test.ts 的地盘）。
 *
 * 为什么它可达：两棵树的 reducer 都产不出重复叶（tab-group id 现造，`splitWorkbenchRegion` 显式拒绝
 * 已在场的 regionId），但 localStorage 里的是**用户数据**，可以是任何类型合法的形状。而
 * `removeLeaf` 的前置条件亲口写着「叶子 id 在一棵树内唯一」。
 *
 * 那条不对称（#571 的内容）已经收敛掉了：两条断言此前各自手抄一份比较，region 侧排序逐元素 + 比长度、
 * group 侧用两个方向的 `Set` 差集，而差集对重复完全失明（`[g1]` 配 `[g1, g1]` 两个方向的差都是空），
 * 于是同一种违约在一侧抛、在另一侧沉默。现在判据只有一份（`split-tree.ts` 的 `leafIdsMatchRecords`），
 * 两侧同抛。收敛的顺序不能反：先收紧闸、后补抢救，等于把 region 侧已经发生过的崩溃路径复制到 group 侧
 *（那条路径实测在 partialize 与启动恢复**两个入口**都抛，而抛在 partialize 里意味着任意一次用户操作
 * 变成崩溃、此后再也写不进盘）。所以本文件的每条判据都成对：抢救真的发生了 + 输入真的违约。
 *
 * 判据两半，缺一不可：
 *   1. 抢救真的发生了——两个入口都不抛，交出来的东西自己满足不变量，且**留下的是读序首片**；
 *   2. 前提仍然成立——构造出来的输入确实违约（直接对它调断言必须抛）。
 * 第 2 半防的是「哪天 fixture 被改成合法的」，那会让第 1 半整批退化成恒真。
 */

const config: AppConfig = {
  version: CONFIG_VERSION,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: {
    toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true }
  }
}

/**
 * 用 `file` 面：`persistedSurfaceSurvives` 会正当地丢掉未绑定 Topic 的 launcher 面，那样整张 Tab 会因
 * 「一格都不剩」而消失——测出来的就不是抢救行为了。file 面在其 workspace 仍被配置时两条路径都生还。
 */
function file(regionId: string, path: string): WorkbenchSurface {
  return { regionId, kind: 'file', workspaceId: 'workspace', path }
}

/**
 * 树里 `r0 | r0`（同一个 id 两片），regions 表只有一条 r0——记录表对一个 id 只存一条，所以「哪一片
 * 是真的」在数据里没有答案，这也正是抢救只能按读序保留首片的原因。
 *
 * 两侧的 id 集合完全相等（都是 {r0}），所以任何基于 `Set` 的判据都看不见这里有问题。
 */
function tabWithDuplicateLeaf(): WorkbenchTab {
  const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
  return {
    ...base,
    layout: {
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: EVEN_SPLIT_RATIO,
        first: { type: 'leaf', regionId: 'r0' },
        second: { type: 'leaf', regionId: 'r0' }
      },
      activeRegionId: 'r0'
    },
    regions: { r0: file('r0', '/repo/a.ts') }
  }
}

/**
 * **非相邻**重复：`r0 | (r1 | r0)`，中间夹着一片别的叶。这是「保留首片 vs 保留末片」唯一能分家的形状，
 * 而上面两张 fixture 都分不了家——实测四种形状里只有这一种两个方向读序不同
 * （相邻 `r0|r0`、`r0 | (r0|orphan)`、`(a|r0) | (r0|b)` 三种，两个方向逐字相同）。
 *
 * 分家的不是「id 顺序」这种内部细节，是**用户看得见的几何**：保留首片得到 `r0 | r1`（r0 在左，
 * 右半塌缩成 r1 那一格），保留末片得到 `r1 | r0`——同一份持久化数据，两格左右颠倒。所以下面那条
 * 断言比的是读序数组本身，它同时是几何断言。
 */
function tabWithNonAdjacentDuplicate(): WorkbenchTab {
  const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
  return {
    ...base,
    layout: {
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: EVEN_SPLIT_RATIO,
        first: { type: 'leaf', regionId: 'r0' },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: EVEN_SPLIT_RATIO,
          first: { type: 'leaf', regionId: 'r1' },
          second: { type: 'leaf', regionId: 'r0' }
        }
      },
      activeRegionId: 'r0'
    },
    regions: { r0: file('r0', '/repo/a.ts'), r1: file('r1', '/repo/b.ts') }
  }
}

/** 重复叶与一条真孤儿叶同时在场：摘重复之后，孤儿那一步照旧要走。 */
function tabWithDuplicateAndOrphan(): WorkbenchTab {
  const base = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
  return {
    ...base,
    layout: {
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: EVEN_SPLIT_RATIO,
        first: { type: 'leaf', regionId: 'r0' },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: EVEN_SPLIT_RATIO,
          first: { type: 'leaf', regionId: 'r0' },
          second: { type: 'leaf', regionId: 'orphan' }
        }
      },
      activeRegionId: 'r0'
    },
    regions: { r0: file('r0', '/repo/a.ts') }
  }
}

/** tab-group 树里同一个 groupId 两片，`groups` 数组只有一条。 */
function layoutWithDuplicateGroupLeaf(): WorkspaceLayout {
  const base = createWorkspaceLayout('g1', ['tab:a'])
  return {
    ...base,
    root: {
      type: 'split',
      direction: 'horizontal',
      ratio: EVEN_SPLIT_RATIO,
      first: { type: 'leaf', groupId: 'g1' },
      second: { type: 'leaf', groupId: 'g1' }
    }
  }
}

/**
 * 重复**记录**：树只有一片 `g1`，而 `groups` 数组里两条 `g1`。
 *
 * 这条轴是 group 侧独有的，region 侧结构上就不存在：`tab.regions` 是对象表，一个 id 只存得下一条；
 * `layout.groups` 是**数组**，同一个 id 塞两条完全类型合法。所以「重复」在两侧不是同一个概念，
 * group 侧要抢救的是两条轴（重复叶 + 重复记录），region 侧只有一条。
 *
 * 两条记录各自认一张**真实在场**的 Tab，这是刻意的：`keepTabsInLayout` 会把不在场的 tabId 从
 * `tabOrder` 里摘掉，所以拿虚构的 tab id 当区分符，两条记录会被洗成一样，「保留第一条 vs 保留最后
 * 一条」逐字相同、断言退化成恒真（实测：拿 `tab:a`/`tab:b` 写这张 fixture 时，两个方向都得到
 * `tabOrder: ['view']`）。用两张真 Tab，区分符落在**用户看得见的东西**上：哪张 Tab 是活动项、
 * Tab 条上谁在前面。
 */
function layoutWithDuplicateGroupRecord(): WorkspaceLayout {
  const base = createWorkspaceLayout('g1', ['view'])
  return {
    ...base,
    groups: [
      ...base.groups,
      { id: 'g1', activeTabId: 'second', tabOrder: ['second'], recentTabIds: ['second'] }
    ]
  }
}

function persisted(tab: WorkbenchTab, layout?: WorkspaceLayout): PersistedWorkbench {
  return {
    tabs: { [tab.id]: tab },
    layouts: { workspace: layout ?? createWorkspaceLayout('group-1') }
  }
}

function restore(tab: WorkbenchTab, layout?: WorkspaceLayout) {
  return restorePersistedWorkbench({
    config,
    sessions: [],
    persisted: persisted(tab, layout),
    createTabGroupId: () => 'group-1'
  })
}

describe('持久化数据里的重复叶不得让两条不变量断言炸在持久化路径上（#571）', () => {
  it('前提自检（region 侧）：两张 fixture 真的违约，未经抢救喂给断言必须抛', () => {
    for (const [label, build] of [
      ['纯重复叶', tabWithDuplicateLeaf],
      ['重复叶 + 孤儿叶', tabWithDuplicateAndOrphan]
    ] as const) {
      const tab = build()
      const ids = regionIds(tab.layout.root)
      expect(new Set(ids).size, `${label}：fixture 必须真的带重复，否则下面每条「不抛」都恒真`)
        .toBeLessThan(ids.length)
      // region 侧那条断言认得出重复（排序逐元素 + 比长度），所以未经抢救直接喂给它必须抛。
      expect(() => assertRegionInvariant(tab), `${label}：断言若不抛，抢救就没有被测的理由`).toThrow()
    }
  })

  // 下面两条**分开写**，不是一条里两个 for。它们是共享谓词 `leafIdsMatchRecords` 两半各自的检测器：
  // 重复叶只被「不是 Set 差集」这一半认出，重复记录只被「比长度」这一半认出。挤在一条 `it` 里，先
  // 抛的那个 expect 会让后一个变成死代码，于是删掉长度检查那次变异会被前一条的红掩盖成「已被守住」。
  it('前提自检（group 侧·重复叶）：与 region 侧判得一样，故判据不能是 Set 差集', () => {
    const dupLeaf = layoutWithDuplicateGroupLeaf()
    const leafTreeIds = groupIds(dupLeaf.root)
    expect(new Set(leafTreeIds).size, '这张 fixture 必须真的带重复叶').toBeLessThan(leafTreeIds.length)
    expect(dupLeaf.groups.map((group) => group.id), '记录侧必须只有一条，才能与下一条那轴分开').toEqual(['g1'])
    // `[g1, g1]` 配 `[g1]`：两个方向的 `Set` 差都是空。把判据换回差集，这条就绿——这正是 #571 记的
    // 那条不对称，也是 region 侧已经发生过、不能复制到这一侧的崩溃路径的另一半。
    expect(
      () => assertGroupInvariant(dupLeaf),
      'group 侧必须与 region 侧判得一样：重复叶要抛（判据是排序逐元素，不是 Set 差集）'
    ).toThrow()
  })

  it('前提自检（group 侧·重复记录）：只有「比长度」那一半认得出它', () => {
    const dupRecord = layoutWithDuplicateGroupRecord()
    expect(groupIds(dupRecord.root), '这张 fixture 的重复必须在记录侧，树侧只有一片').toEqual(['g1'])
    expect(dupRecord.groups.map((group) => group.id)).toEqual(['g1', 'g1'])
    // 逐元素比较比到短的一侧就停，长出来的尾巴无人看见；两个方向的 `Set` 差同样都是空。所以删掉
    // `leafIdsMatchRecords` 里的长度检查，只有这条会红。
    expect(
      () => assertGroupInvariant(dupRecord),
      '重复记录只有「比长度」那一半认得出：逐元素比较比到短的一侧就停，长出来的尾巴无人看见'
    ).toThrow()
  })

  it('启动恢复：重复叶被摘成一片，留下的是读序首片的内容', () => {
    const workbench = restore(tabWithDuplicateLeaf())
    const restored = workbench.tabs.view
    expect(restored, '整张 Tab 不该被丢弃：r0 两侧都认，是可画的').toBeDefined()
    expect(() => assertRegionInvariant(restored!)).not.toThrow()
    expect(regionIds(restored!.layout.root)).toEqual(['r0'])
    // 内容判据：摘的是重复的那一片，不是把 r0 整个删掉（`removeLeaf` 会删掉所有同名叶，所以这条
    // 断言正是「没有拿 removeLeaf 凑」的检测器）。
    expect(restored!.regions.r0).toBeDefined()
    expect(restored!.layout.activeRegionId).toBe('r0')
  })

  it('持久化写入（partialize）：重复叶同样不抛——在这里抛会让每一次写入都变成崩溃', () => {
    const projected = projectPersistedWorkbench(persisted(tabWithDuplicateLeaf()))
    expect(() => assertRegionInvariant(projected.tabs.view!)).not.toThrow()
    expect(regionIds(projected.tabs.view!.layout.root)).toEqual(['r0'])
  })

  it('重复叶与孤儿叶同时在场：两步都走完，剩下的树与表逐一对应', () => {
    const workbench = restore(tabWithDuplicateAndOrphan())
    const restored = workbench.tabs.view
    expect(restored).toBeDefined()
    expect(() => assertRegionInvariant(restored!)).not.toThrow()
    expect(regionIds(restored!.layout.root)).toEqual(['r0'])
    expect(Object.keys(restored!.regions)).toEqual(['r0'])
  })

  it('非相邻重复：留下的是读序首片，两格的左右次序不许颠倒', () => {
    // 前提自检与上面同构，但要单独钉一次：这张 fixture 的重复叶隔着 r1，正是「首 vs 末」的判别器。
    const tab = tabWithNonAdjacentDuplicate()
    const ids = regionIds(tab.layout.root)
    expect(ids, '重复必须是非相邻的，否则这条断言退化成上面那条').toEqual(['r0', 'r1', 'r0'])

    const restored = restore(tab).tabs.view
    expect(restored).toBeDefined()
    expect(() => assertRegionInvariant(restored!)).not.toThrow()
    // 保留首片 → ['r0','r1']；保留末片 → ['r1','r0']。两格都还在，只是左右调换，所以
    // 「剩几格」「有没有抛」这类判据全看不见这次变异，只有读序（＝几何）能看见。
    expect(regionIds(restored!.layout.root), '保留末片会让两格左右颠倒').toEqual(['r0', 'r1'])
    expect(Object.keys(restored!.regions).sort()).toEqual(['r0', 'r1'])
  })

  it('抢救如实上报：重复被记成 droppedDuplicateLeafIds，而不是混进另外两类', () => {
    const workbench = restore(tabWithDuplicateLeaf())
    expect(workbench.repairs).toEqual([
      {
        tabId: 'view',
        droppedGhostRegionIds: [],
        droppedOrphanLeafIds: [],
        droppedDuplicateLeafIds: ['r0'],
        discardedTab: false
      }
    ])
  })

  it('tab-group 树的重复叶也被摘掉：两个入口都不抛，且 groups 记录不受影响', () => {
    const dup = layoutWithDuplicateGroupLeaf()
    const tab = createWorkbenchTab('view', file('r0', '/repo/a.ts'))

    const restored = restore(tab, dup).layouts.workspace!
    expect(groupIds(restored.root), 'tab-group 树里的重复叶必须被摘成一片').toEqual(['g1'])
    expect(restored.groups.map((group) => group.id)).toEqual(['g1'])
    expect(() => assertGroupInvariant(restored)).not.toThrow()

    const projected = projectPersistedWorkbench(persisted(tab, dup)).layouts.workspace!
    expect(groupIds(projected.root)).toEqual(['g1'])
    expect(() => assertGroupInvariant(projected)).not.toThrow()
  })

  it('重复的 group 记录被收成一条，留下的是数组里第一条（含它认的那张 Tab）', () => {
    const dup = layoutWithDuplicateGroupRecord()
    // 前提自检两半：记录真的重复，且树侧**没有**重复——否则这条用例测的是上面那条轴。
    expect(dup.groups.map((group) => group.id), '记录必须重复').toEqual(['g1', 'g1'])
    expect(groupIds(dup.root), '树侧必须只有一片，才能把这条轴与重复叶分开').toEqual(['g1'])

    const first = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
    const second = createWorkbenchTab('second', file('r1', '/repo/b.ts'))
    const input: PersistedWorkbench = {
      tabs: { view: first, second },
      layouts: { workspace: dup }
    }
    for (const [entry, layout] of [
      [
        '启动恢复',
        restorePersistedWorkbench({
          config,
          sessions: [],
          persisted: input,
          createTabGroupId: () => 'group-1'
        }).layouts.workspace!
      ],
      ['持久化写入', projectPersistedWorkbench(input).layouts.workspace!]
    ] as const) {
      expect(layout.groups.map((group) => group.id), `${entry}：重复记录必须收成一条`).toEqual(['g1'])
      // 内容判据：留下的是**第一条**。两条记录认的活动 Tab 不同，而这是用户看得见的东西（Tab 条上
      // 哪张亮着）。只数「剩几条」的话两个方向都是 1 条，那次变异全绿。
      expect(layout.groups[0]!.activeTabId, `${entry}：留下的必须是数组里第一条`).toBe('view')
      expect(() => assertGroupInvariant(layout), `${entry}：交出来的东西自己要满足不变量`).not.toThrow()
    }
  })

  it('干净的持久化数据不被当成需要抢救（否则上面每条都会因「无论如何重建一遍」而转绿）', () => {
    const clean = createWorkbenchTab('view', file('r0', '/repo/a.ts'))
    const workbench = restore(clean)
    expect(workbench.repairs).toEqual([])
    expect(workbench.tabs.view!.regions).toEqual(clean.regions)
  })
})
