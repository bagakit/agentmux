import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { regionIds, splitWorkbenchRegion } from '../src/renderer/src/lib/workbench-view-layout'
import {
  addWorkbenchRegion,
  assertRegionInvariant,
  createWorkbenchTab,
  removeWorkbenchRegion,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs'
import { promoteRegionToTab } from '../src/renderer/src/lib/promote-region-to-tab'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout'

// #494 gap：分屏树里的 regionId 集合，必须与 tab.regions 这张表的 key 集合逐一相等。此前这条只由
// addWorkbenchRegion / removeWorkbenchRegion 「两处一起改」的约定维持，没有任何守卫——树里多一格
// （画不出、回收不掉的孤儿）或 regions 表里多一格（永远画不到的死记录）都是零报错的未定义行为。
// 现在这条谓词已提升为生产断言 `assertRegionInvariant`（workbench-tabs.ts），是判定「两侧集合相等」的
// 唯一实现（SSOT）。本测试不再自带第二份拷贝：`expectInvariant` 直接调生产断言，`regionSetsAgree`
// 只作「读出两侧各自内容」的投影，供具体去向的值断言使用，不自己判等。
function regionSetsAgree(tab: WorkbenchTab): { tree: string[]; map: string[] } {
  return {
    tree: [...regionIds(tab.layout.root)].sort(),
    map: Object.keys(tab.regions).sort()
  }
}

function expectInvariant(tab: WorkbenchTab): void {
  expect(() => assertRegionInvariant(tab), 'layout 树里的 regionId 集合必须等于 tab.regions 的 key 集合').not.toThrow()
}

function launcher(regionId: string): WorkbenchSurface {
  return { regionId, kind: 'launcher', workspaceId: 'workspace' }
}

// 生产断言必须真的在违约时抛，且抛出可诊断的消息——否则它就是个恒真的空壳（把它改成开头就 return
// 的 no-op，下面这条会转绿，正是它守的东西）。两个违约方向各钉一次。
describe('assertRegionInvariant 是判定两侧集合相等的生产断言（#494 gap）', () => {
  it('regions 表里多一格（树里没有的死记录）→ 抛出，且消息点名多出的那格', () => {
    const base = createWorkbenchTab('view', launcher('r0'))
    const mapHasGhost: WorkbenchTab = { ...base, regions: { ...base.regions, ghost: launcher('ghost') } }
    expect(() => assertRegionInvariant(mapHasGhost)).toThrow(/ghost/)
    expect(() => assertRegionInvariant(mapHasGhost)).toThrow(/orphan/i)
  })

  it('树里多一叶（regions 表画不到的孤儿）→ 抛出，且消息点名多出的那格', () => {
    const base = createWorkbenchTab('view', launcher('r0'))
    // 树上分出 r0/r1 两叶，但 regions 表只留 r0——树里多一格。
    const treeHasOrphan: WorkbenchTab = {
      ...base,
      layout: splitWorkbenchRegion(base.layout, 'r0', 'right', 'r1')
    }
    expect(() => assertRegionInvariant(treeHasOrphan)).toThrow(/r1/)
    expect(() => assertRegionInvariant(treeHasOrphan)).toThrow(/orphan/i)
  })

  it('两侧逐一相等时不抛', () => {
    const tab = createWorkbenchTab('view', launcher('r0'))
    expect(() => assertRegionInvariant(tab)).not.toThrow()
  })
})

describe('tab 布局树 ↔ tab.regions 集合不变量（#494 gap）', () => {
  it('创建、追加、关闭全程两侧集合始终相等', () => {
    let tab = createWorkbenchTab('view', launcher('r0'))
    expectInvariant(tab)

    for (const id of ['r1', 'r2', 'r3']) {
      tab = addWorkbenchRegion(tab, tab.layout.activeRegionId, 'right', launcher(id))
      expectInvariant(tab)
    }
    expect(regionSetsAgree(tab).tree).toEqual(['r0', 'r1', 'r2', 'r3'])

    // 关掉中间一格：树与表都必须少掉恰好那一个 id，不多不少。
    const afterClose = removeWorkbenchRegion(tab, 'r2')!
    expectInvariant(afterClose)
    expect(regionSetsAgree(afterClose).tree).toEqual(['r0', 'r1', 'r3'])
  })

  it('关闭活动格后，剩下的树与表仍然逐一相等，且 activeRegionId 指向仍在场的格', () => {
    let tab = createWorkbenchTab('view', launcher('r0'))
    tab = addWorkbenchRegion(tab, 'r0', 'right', launcher('r1'))
    // 追加后活动格是 r1（splitWorkbenchRegion 把新格设为活动）。关掉它。
    const closed = removeWorkbenchRegion(tab, 'r1')!
    expectInvariant(closed)
    expect(regionSetsAgree(closed).map).toContain(closed.layout.activeRegionId)
  })

  // #487 promote：把一格单独变成新 Tab。这条把创建/追加/关闭那套「两侧集合相等」的纪律延伸到促升——
  // 促升同时改两张 Tab（源 Tab 少一格、新 Tab 恰一格），两侧都必须逐一相等，且跨两张 Tab 总格数守恒
  // （既不丢也不重复）。
  it('促升一格后，源 Tab 与新 Tab 两侧集合各自相等，且总格数守恒', () => {
    let tab = createWorkbenchTab('source', launcher('r0'))
    tab = addWorkbenchRegion(tab, 'r0', 'right', launcher('r1'))
    tab = addWorkbenchRegion(tab, 'r0', 'right', launcher('r2'))
    expectInvariant(tab)
    const before = regionIds(tab.layout.root).length
    expect(before).toBe(3)

    const result = promoteRegionToTab({
      tabs: { source: tab },
      layouts: { workspace: createWorkspaceLayout('group-one', ['source']) },
      workspaceId: 'workspace',
      tabId: 'source',
      regionId: 'r1',
      mint: { tabId: 'new-tab' }
    })
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('unreachable')

    const nextSource = result.tabs.source!
    const newTab = result.tabs['new-tab']!
    // 两侧各自逐一相等（不变量#1，在源 Tab 与新 Tab 上分别成立）。
    expectInvariant(nextSource)
    expectInvariant(newTab)
    // 总格数守恒：促升前 3 格 = 源剩下的 + 新 Tab 的。
    const after = Object.keys(nextSource.regions).length + Object.keys(newTab.regions).length
    expect(after).toBe(before)
    // 具体去向：源剩 r0/r2，新 Tab 恰 r1。
    expect(regionSetsAgree(nextSource).map).toEqual(['r0', 'r2'])
    expect(regionSetsAgree(newTab).map).toEqual(['r1'])
  })
})

/**
 * 接线层（#515 M13）。上面那族全是行为断言，它们钉的是「不变量成立」，而**不是**「每个改动点都过了那道
 * 闸」。这两件事的差距实测出来了：把 `addWorkbenchRegion` 尾部的 `assertRegionInvariant(next)` 整行删掉，
 * desktop 全量 3205 条与基线逐名相同（同样是那两条既有失败）——因为今天没有任何可达输入能让那个 reducer
 * 违约，它是纵深防御。纵深防御的断言不可能被行为测试杀掉，只能由结构判据守：
 *
 *   **任何一个会改变 tab 的 region-id 集合的函数，必须在同一个函数体里调一次 assertRegionInvariant。**
 *
 * 「会改变集合」不由我在这里手抄一张函数名单——那正是 forbidden-list-guard-always-leaks 那一族（换个
 * 写法就绕过，且我抄的名单会与代码一起腐烂）。改成从**布局引擎自己的导出**推导：workbench-view-layout.ts
 * 里每个导出的布局函数都必须在下面的分类表里出现，分类只有两档（`changes` / `preserves`）；漏一个新导出，
 * 分类穷举那条断言当场红，作者必须在这里回答「它会不会动集合」。然后按 `changes` 那档的调用点扫全 renderer。
 *
 * 判据落在 AST 上：`toContain('assertRegionInvariant')` 会被 import 那一行、被注释、被一个死赋值满足
 * （本仓 guard-criterion-must-be-import-relation 与 grep-guard-cannot-see-early-return 两族）。这里问的是
 * 「包住这次调用的那个函数体里，有没有一次 assertRegionInvariant 调用」。
 */
describe('每个改动 region 集合的函数都必须过那道闸（#515 接线层）', () => {
  const RENDERER = new URL('../src/renderer/src/', import.meta.url).pathname
  const DEFINER = 'lib/workbench-view-layout.ts'

  /**
   * 布局引擎每个导出函数对 region-id **集合**的作用。分两档，且必须穷举（下方有断言）：
   *   - `changes`：能让集合多一个或少一个 id。它的调用方同时要改 `tab.regions` 那张表，两侧漏一侧就是
   *     那个画不出也关不掉的孤儿，所以必须断言。
   *   - `preserves`：集合逐一不变。`balance`/`activeFirst`/`swap` 是同一个 `replaceLeafOrder` 的三种用法
   *     （在固定骨架上重排既有 id，写不进新 id——swap 还额外要求两端点都在场）；`focus`/`setSplitRatio`
   *     只动 activeRegionId 与 ratio；`regionIds`/`workbenchRegionBounds`/`workbenchRegionPresetSize` 是读。
   *
   * 分档只影响「要不要强制断言」，不影响 `preserves` 那档的调用方能不能自愿断言（arrange 的 balance /
   * active-first 两条就自愿断言了，这是好事，不是违规）。
   */
  const LAYOUT_EFFECT: Readonly<Record<string, 'changes' | 'preserves'>> = {
    createWorkbenchViewLayout: 'changes',
    splitWorkbenchRegion: 'changes',
    closeWorkbenchRegion: 'changes',
    applyWorkbenchRegionLayoutPreset: 'changes',
    balanceWorkbenchRegionLayout: 'preserves',
    placeActiveWorkbenchRegionFirst: 'preserves',
    swapWorkbenchRegions: 'preserves',
    focusWorkbenchRegion: 'preserves',
    setWorkbenchRegionSplitRatio: 'preserves',
    regionIds: 'preserves',
    workbenchRegionBounds: 'preserves',
    workbenchRegionPresetSize: 'preserves'
  }

  /**
   * 已知的、刻意不断言的调用点。每条自带**可自证的前提**——不是「今天没人抱怨」，而是一句能被下面那条
   * 前提自检当场推翻的话。空清单是目标状态；每加一条都要写清为什么这里断言不了或没意义。
   */
  const EXEMPT: ReadonlyArray<{ fn: string; file: string; because: string }> = [
    {
      fn: 'createWorkbenchTab',
      file: 'lib/workbench-tabs.ts',
      // 它是从零造一张 Tab：树恰一叶、表恰一条，两者都由这同一个字面量里的 surface.regionId 写出，
      // 不存在「两侧各写一份」的机会。前提自检：函数体里 regions 字面量的键必须就是 layout 那次调用
      // 的实参（见下方 it）。
      because: '从零造 Tab，两侧由同一个 surface.regionId 写出，无第二处可漂移'
    },
    {
      fn: 'reconcilePersistedTab',
      file: 'lib/workbench-persistence.ts',
      // 它就是那道闸的**修理工**：读回来的持久化 Tab 本来就可能违约，它的职责是把两侧拉回一致，
      // 且刻意绝不抛（它跑在 zustand 的 partialize 里，抛出即每次写入都崩）。在它自己身上断言等于
      // 让修理工先证明病人是健康的。前提自检：它的返回值必须被两个持久化入口消费，而那两个入口
      // 下游的 removeWorkbenchRegion 会替它把闸补上（见下方 it）。
      because: '它是这道闸的修理工，输入必然可能违约，且刻意不抛（跑在 partialize 里）'
    }
  ]

  function sourceFiles(): string[] {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.tsx?$/.test(full) && !full.endsWith('.d.ts')) found.push(full)
      }
    }
    walk(RENDERER)
    return found.map((full) => full.slice(RENDERER.length))
  }

  function parse(relative: string): ts.SourceFile {
    return ts.createSourceFile(
      relative,
      readFileSync(join(RENDERER, relative), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
  }

  /** 包着 `node` 的最近一个具名函数（声明式，或赋给某个变量的箭头/函数表达式）。 */
  function enclosingFunction(
    node: ts.Node,
    file: ts.SourceFile
  ): { name: string; body: ts.Node } | null {
    for (let cursor: ts.Node | undefined = node; cursor; cursor = cursor.parent) {
      if (ts.isFunctionDeclaration(cursor) && cursor.name) {
        return { name: cursor.name.text, body: cursor }
      }
      if (
        (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
        ts.isVariableDeclaration(cursor.parent) &&
        ts.isIdentifier(cursor.parent.name)
      ) {
        return { name: cursor.parent.name.text, body: cursor }
      }
    }
    return null
  }

  function callsNamed(scope: ts.Node, callee: string): number {
    let count = 0
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
        count += 1
      }
      node.forEachChild(walk)
    }
    walk(scope)
    return count
  }

  /** 每个「会动集合」的布局调用点，连同包着它的函数与该函数体里的断言次数。 */
  function callSites(): Array<{ file: string; fn: string; helper: string; asserts: number }> {
    const sites: Array<{ file: string; fn: string; helper: string; asserts: number }> = []
    for (const relative of sourceFiles()) {
      if (relative === DEFINER) continue
      const file = parse(relative)
      const walk = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          LAYOUT_EFFECT[node.expression.text] === 'changes'
        ) {
          const owner = enclosingFunction(node, file)
          sites.push({
            file: relative,
            fn: owner?.name ?? '<top-level>',
            helper: node.expression.text,
            asserts: owner ? callsNamed(owner.body, 'assertRegionInvariant') : 0
          })
        }
        node.forEachChild(walk)
      }
      walk(file)
    }
    return sites
  }

  it('布局引擎的每个导出都在分类表里（新增一个必须在这里回答「它动集合吗」）', () => {
    const file = parse(DEFINER)
    const exported: string[] = []
    file.forEachChild((node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exported.push(node.name.text)
      }
    })
    // 在场自检：扫不到导出（改名、改路径、换成 const 导出）会让下面的差集恒空而假绿。
    expect(exported.length, `${DEFINER} 里扫不到任何导出函数——判据的前提不成立`).toBeGreaterThan(5)
    const unclassified = exported.filter((name) => !(name in LAYOUT_EFFECT))
    expect(
      unclassified,
      `${DEFINER} 新增了导出 ${JSON.stringify(unclassified)}，但 LAYOUT_EFFECT 没给它定性：` +
        '它会不会改变 tab 的 region-id 集合？会 → changes（调用方必须断言不变量）；不会 → preserves。'
    ).toEqual([])
    // 反向：分类表不许留下已被删掉的名字（否则那一档会静默变空，扫不到任何调用点）。
    const stale = Object.keys(LAYOUT_EFFECT).filter((name) => !exported.includes(name))
    expect(stale, `LAYOUT_EFFECT 里 ${JSON.stringify(stale)} 已不再是 ${DEFINER} 的导出`).toEqual([])
  })

  it('每个改动 region 集合的调用点，其所在函数都调了 assertRegionInvariant', () => {
    const sites = callSites()
    // 在场自检：扫描根写错 / 分类表把 changes 那档清空，都会让 sites 为空而下面恒真。
    expect(sites.length, '扫不到任何「会动集合」的布局调用点——扫描根或分类表出了问题').toBeGreaterThan(3)

    const exempt = new Set(EXEMPT.map((entry) => `${entry.file}::${entry.fn}`))
    const unguarded = sites
      .filter((site) => site.asserts === 0)
      .filter((site) => !exempt.has(`${site.file}::${site.fn}`))
      .map((site) => `${site.file}::${site.fn}() 调了 ${site.helper}`)
    expect(
      unguarded,
      '这些函数改了分屏树的 region 集合，却没在同一个函数体里断言不变量。' +
        'tab.regions 那张表要么跟着改、要么就漂了——漂了的那一侧是画不出也关不掉的孤儿格。' +
        `修法是在 return 之前调一次 assertRegionInvariant(next)；确有理由不断言的，往 EXEMPT 加一条并写清可自证的前提。`
    ).toEqual([])

    // 豁免清单不许留下已经不存在的条目：那会让它悄悄豁免掉一个将来同名的新函数。
    const live = new Set(sites.map((site) => `${site.file}::${site.fn}`))
    const dead = [...exempt].filter((key) => !live.has(key))
    expect(dead, `EXEMPT 里 ${JSON.stringify(dead)} 已经不再调用任何「会动集合」的布局函数`).toEqual([])
  })

  it('豁免前提自检 1：createWorkbenchTab 的两侧确实由同一个 regionId 写出', () => {
    const file = parse('lib/workbench-tabs.ts')
    let checked = false
    const walk = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'createWorkbenchTab') {
        const text = node.getText(file)
        // 树那侧的实参与表那侧的键必须是同一个表达式 `surface.regionId`：一处写、两处读，没有第二个
        // 取值点可漂。若谁把其中一侧改成别的来源（比如新增一个 regionId 形参），这条当场红，
        // 豁免的理由也就随之作废。
        expect(text, 'createWorkbenchTab 的 layout 那侧不再由 surface.regionId 写出').toContain(
          'createWorkbenchViewLayout(surface.regionId)'
        )
        expect(text, 'createWorkbenchTab 的 regions 那侧不再由 surface.regionId 作键').toContain(
          '[surface.regionId]: surface'
        )
        checked = true
      }
      node.forEachChild(walk)
    }
    walk(file)
    expect(checked, 'workbench-tabs.ts 里找不到 createWorkbenchTab——豁免前提无从检验').toBe(true)
  })

  it('豁免前提自检 2：reconcilePersistedTab 的结果被两个持久化入口消费，且它自己不抛', () => {
    const file = parse('lib/workbench-persistence.ts')
    const consumers = new Set<string>()
    let throwsInside = 0
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'reconcilePersistedTab'
      ) {
        const owner = enclosingFunction(node, file)
        if (owner) consumers.add(owner.name)
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'reconcilePersistedTab') {
        const countThrows = (inner: ts.Node): void => {
          if (ts.isThrowStatement(inner)) throwsInside += 1
          inner.forEachChild(countThrows)
        }
        countThrows(node)
      }
      node.forEachChild(walk)
    }
    walk(file)
    // 两个入口都必须真的先过修理工，否则那道无条件断言会在启动路径或每一次持久化写入里抛。
    expect(
      [...consumers].sort(),
      '抢救必须发生在两个持久化入口上：启动恢复（restorePersistedWorkbench）与每次写入（projectPersistedWorkbench）'
    ).toEqual(['projectPersistedWorkbench', 'restorePersistedWorkbench'])
    // 它跑在 partialize 里，抛出即让任意一次用户操作变成崩溃且此后再也写不进去。
    expect(throwsInside, 'reconcilePersistedTab 出现了 throw——它跑在 partialize 里，抛出即让每次持久化写入崩溃').toBe(0)
  })
})
