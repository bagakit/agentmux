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

  /**
   * 判「断言喂对了值 + 断言真的会跑」的两个正交 AST 判据（#687 补洞）。
   *
   * 背景与实测（本 session 亲手跑出来的数字，逐字记录，别凭记忆改）：此前这道闸只问「包住这次
   * changes-helper 调用的函数体里，有没有出现过一次 assertRegionInvariant 调用」（旧判据是
   * `callsNamed(owner.body, 'assertRegionInvariant') > 0`）。它既不问断言喂进去的是哪个值，也不问那次断言
   * 在不在会真正执行的路径上。于是下面两个变异都在 `10 passed (10)` 下**存活**（均施加在 workbench-tabs.ts
   * 的 addWorkbenchRegion 尾部那句 `assertRegionInvariant(next)`）：
   *
   *   M1（可达性）：`assertRegionInvariant(next)` → `if (import.meta.env.DEV) assertRegionInvariant(next)`
   *                 不变量在生产构建里根本不跑。旧判据只数「出现过」，看不见它被塞进了 dev-only 门。
   *                 实测：`10 passed (10)`——SURVIVED。
   *   M2（喂错操作数）：`assertRegionInvariant(next)` → `assertRegionInvariant(tab)`
   *                 断言的是**入参** tab（进函数时本就合法），而不是本函数刚算出来、准备交出去的 next。
   *                 旧判据不看操作数，`tab` 同样满足「出现过一次」。实测：`10 passed (10)`——SURVIVED。
   *
   * 拆成两个**各自独立红**的 it，不能合进一个：本仓 two-throws-in-one-it-mask-each-other 记过，先抛的那条
   * 断言会把后一条变成死代码，于是能在从没执行过第二条的情况下声称它守住了。实测（本 session）这两个变异
   * 命中不同的 it：
   *   - M1 只让 **接线层-B（真的跑）** 红，接线层-A 仍绿；
   *   - M2 只让 **接线层-A（喂对值）** 红，接线层-B 仍绿。
   * 「哪个 it 红」的分离，就是两条判据互不代偿的证据。
   *
   * 判据 A（喂对值）：对每个 changes-helper 调用点，求它的**流集**——从「声明的初始化式（可传递地）
   *   引用了这次 helper 调用**结果**（按 AST 节点标识，不是按名字）」的那个局部起步，再把「初始化式引用了
   *   已收集局部名」的局部闭包进来。要求函数体里至少有一次 `assertRegionInvariant(X)`、且 X 是个裸标识符、
   *   落在流集内。入参不在流集里（它不是由 helper 结果派生的局部），所以 M2 的 `tab` 过不了 A。
   * 判据 B（真的跑）：那次 `assertRegionInvariant(...)` 必须是某个 Block（或函数体）里的**直接**表达式
   *   语句，且同一个 Block 里在它之后（按语句数组次序）还有一条 return。M1 把 Block 里的那条语句从「裸调用」
   *   换成了一个 IfStatement，调用退进 if 的 then 分支，不再是 Block 的直接语句 → B 红。control.ts 那种
   *   `if (mode.kind === 'balance') { const next = …; assertRegionInvariant(next); return next }` 是对的：
   *   断言与 return 是同一个 Block 里的两条语句，B 绿。
   *
   * **自陈盲点（不夸大判据）**：两条判据都把断言绑在**函数**上，不绑在「产出被改值的那段语句序列」上。
   *   一个函数体里出现多次 assertRegionInvariant 时，A/B 都只要求**其中一次**合格。所以 arrange 那种同一函数
   *   三个分支各断言一次的形状，若某个 preserves 分支（balance / active-first，本就不被本闸强制断言）的断言
   *   被喂错了值，本闸不会红——它数的是「这个 changes-helper 函数至少有一次喂对且会跑的断言」，不是
   *   「每个出口都对」。那一层由上面两族行为断言与 arrange 自身的收敛测试补。另：只有把 helper 结果绑到
   *   具名局部再断言的写法能过 A；若某新调用点直接断言一个内联表达式而不落地成局部，它过不了 A，会被逼着
   *   引入一个具名局部——这是有意为之，也在此点名。
   */

  /** 判据 A 的「流集」：一个函数体里，把 `anchorCall` 的结果（按节点标识）传递派生出去的全部具名局部。 */
  function flowSetFromCall(ownerBody: ts.Node, anchorCall: ts.CallExpression): Set<string> {
    const decls: Array<{ name: string; init: ts.Expression }> = []
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        decls.push({ name: node.name.text, init: node.initializer })
      }
      node.forEachChild(collect)
    }
    collect(ownerBody)
    const subtreeHas = (root: ts.Node, target: ts.Node): boolean => {
      let found = false
      const walk = (node: ts.Node): void => {
        if (node === target) found = true
        node.forEachChild(walk)
      }
      walk(root)
      return found
    }
    const flow = new Set<string>()
    for (const decl of decls) if (subtreeHas(decl.init, anchorCall)) flow.add(decl.name)
    let changed = true
    while (changed) {
      changed = false
      for (const decl of decls) {
        if (flow.has(decl.name)) continue
        let refs = false
        const walk = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && flow.has(node.text)) refs = true
          node.forEachChild(walk)
        }
        walk(decl.init)
        if (refs) {
          flow.add(decl.name)
          changed = true
        }
      }
    }
    return flow
  }

  /**
   * 一个函数体里每次 assertRegionInvariant(...) 调用的两项事实：
   *   - `operand`：裸标识符实参（不是裸标识符则 null）——喂给判据 A；
   *   - `runsBeforeReturn`：这次调用是不是某个 Block 里的直接表达式语句、且其后（按语句次序）跟着 return——
   *     喂给判据 B。
   */
  function assertSitesIn(ownerBody: ts.Node): Array<{ operand: string | null; runsBeforeReturn: boolean }> {
    const out: Array<{ operand: string | null; runsBeforeReturn: boolean }> = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'assertRegionInvariant'
      ) {
        const arg = node.arguments[0]
        const operand = arg && ts.isIdentifier(arg) ? arg.text : null
        let runsBeforeReturn = false
        const statement = node.parent
        if (statement && ts.isExpressionStatement(statement) && statement.parent && ts.isBlock(statement.parent)) {
          const statements = statement.parent.statements
          const index = statements.indexOf(statement)
          runsBeforeReturn = index >= 0 && statements.slice(index + 1).some((stmt) => ts.isReturnStatement(stmt))
        }
        out.push({ operand, runsBeforeReturn })
      }
      node.forEachChild(walk)
    }
    walk(ownerBody)
    return out
  }

  type ChangesHelperSite = {
    file: string
    fn: string
    helper: string
    /** 判据 A：本函数里由该 helper 调用结果传递派生出的具名局部。 */
    flow: string[]
    /** 判据 A/B：本函数里每次 assertRegionInvariant 的操作数与「块内直接、其后有 return」标志。 */
    asserts: Array<{ operand: string | null; runsBeforeReturn: boolean }>
  }

  /** 每个「会动集合」的布局调用点，连同包着它的函数、该函数的流集与它体内每次断言的两项事实。 */
  function callSites(): ChangesHelperSite[] {
    const sites: ChangesHelperSite[] = []
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
            flow: owner ? [...flowSetFromCall(owner.body, node)] : [],
            asserts: owner ? assertSitesIn(owner.body) : []
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

  // 两条判据共用的一套：滤掉被 EXEMPT 豁免后的 changes-helper 调用点。
  function coveredSites(): ChangesHelperSite[] {
    const exempt = new Set(EXEMPT.map((entry) => `${entry.file}::${entry.fn}`))
    return callSites().filter((site) => !exempt.has(`${site.file}::${site.fn}`))
  }

  it('接线层-A（喂对值）：每个 changes 调用点，其函数里至少有一次 assertRegionInvariant 断言的正是该调用结果派生出的值', () => {
    const all = callSites()
    // 在场自检 1：扫不到任何「会动集合」的布局调用点（扫描根写错 / 分类表把 changes 那档清空）→ 恒真。
    expect(all.length, '扫不到任何「会动集合」的布局调用点——扫描根或分类表出了问题').toBeGreaterThan(3)
    // 在场自检 2：流集是本判据的派生集合。若它对每个受管调用点都算成空，判据 A 会「至少一次落在空集里」
    // 恒假、进而 unguarded 恒非空——那会变成恒红而非恒绿，但为把「流集算法整体失灵」这个前提暴露成一条
    // 响亮断言（而不是让它藏在别的失败里），这里单独钉一次：受管调用点里必须至少有一个的流集非空。
    const sites = coveredSites()
    expect(
      sites.some((site) => site.flow.length > 0),
      '所有受管调用点的流集都算成空了——flowSetFromCall 的派生失灵，判据 A 失去意义'
    ).toBe(true)

    const unguarded = sites
      .filter((site) => !site.asserts.some((a) => a.operand !== null && site.flow.includes(a.operand)))
      .map((site) => `${site.file}::${site.fn}() 调了 ${site.helper}；流集={${site.flow.join(', ')}}`)
    expect(
      unguarded,
      '这些函数改了分屏树的 region 集合，但没有任何一次 assertRegionInvariant 断言的是「本函数刚算出来、' +
        '准备交出去的那个值」（即该 changes-helper 调用结果传递派生出的局部）。断言喂了别的东西（比如入参）' +
        '等于让它对着一个进函数时就已合法的对象空转，真正被交出去的新值没人校验。' +
        '修法是在 return 之前 assertRegionInvariant(那个新算出来的 tab)。'
    ).toEqual([])
  })

  it('接线层-B（真的跑）：每个 changes 调用点，其函数里至少有一次 assertRegionInvariant 是块内直接语句、其后有 return', () => {
    const sites = coveredSites()
    expect(sites.length, '扫不到任何受管的「会动集合」调用点——扫描根或分类表出了问题').toBeGreaterThan(2)
    const unreachable = sites
      .filter((site) => !site.asserts.some((a) => a.runsBeforeReturn))
      .map((site) => `${site.file}::${site.fn}() 调了 ${site.helper}`)
    expect(
      unreachable,
      '这些函数里的 assertRegionInvariant 不是「块内直接语句、其后跟着 return」的形状——它被包进了 if / ' +
        '短路 / dev-only 门之类的条件里，于是在真正把值交出去的那条路径上根本不会执行。纵深断言一旦可被' +
        '某个构建或某个分支跳过，就等于没装。修法是让它成为 return 之前的一条无条件语句。'
    ).toEqual([])
  })

  it('豁免清单不留死条目：EXEMPT 里的每一条都仍在调用某个「会动集合」的布局函数', () => {
    const exempt = new Set(EXEMPT.map((entry) => `${entry.file}::${entry.fn}`))
    // 用「全部」调用点（含被豁免的那些）来核对 exempt 是否仍命中：那会让它悄悄豁免掉一个将来同名的新函数。
    const live = new Set(callSites().map((site) => `${site.file}::${site.fn}`))
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
