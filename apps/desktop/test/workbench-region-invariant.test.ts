import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { regionIds, splitWorkbenchRegion, createWorkspaceLayout } from '@agentmux/layout'
import {
  addWorkbenchRegion,
  assertRegionInvariant,
  createWorkbenchTab,
  removeWorkbenchRegion,
  type WorkbenchSurface,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs'
import { promoteRegionToTab } from '../src/renderer/src/lib/promote-region-to-tab'

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
  // 布局引擎的实现（那些 changes 导出的定义）已抽进 @agentmux/layout（旧渲染层薄壳
  // lib/workbench-view-layout.ts 已删）。调用点扫描仍只在渲染层树上进行（workbench-tabs / control 等
  // reducer 调 changes 助手、且必须 assertRegionInvariant——那层接线没搬走）；引擎的定义现在完全在包里、
  // 不在渲染层扫描面内，故 callSites 无需再跳过引擎自身——曾经那句 `relative === DEFINER` 的跳过已随薄壳
  // 删除一并删掉（实测：把它改成任何在渲染层里不存在的名字，15 条不变；这正说明它已无可跳过之物）。
  // 别名表直接按 `@agentmux/layout` 解析（见 aliasMapFor）。DEFINER 只剩一个用处：**导出穷举**那条读
  // 引擎真实源码时的文件标签，真实字节来自 DEFINER_SOURCE（包里）。
  const DEFINER = 'packages/layout/src/workbench-view-layout.ts'
  const DEFINER_SOURCE = fileURLToPath(new URL('../../../packages/layout/src/workbench-view-layout.ts', import.meta.url))

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
   * 判「断言喂对了值 + 断言真的会跑」的两个正交 AST 判据（#687 补洞；#698/#699/#700 修三处、#727/#728 再补两处
   * 坐实的存活变异）。
   *
   * 背景：这道闸曾经只问「包住这次 changes-helper 调用的函数体里，有没有出现过一次 assertRegionInvariant
   * 调用」。它既不问断言喂进去的是哪个值，也不问那次断言在不在会真正执行的路径上——两个变异（把
   * addWorkbenchRegion 尾部那句 `assertRegionInvariant(next)` 改成 `if (import.meta.env.DEV) …` 或改成断言入参
   * `tab`）都在全绿下存活。补进 A（喂对值）/ B（真的跑）两条正交判据后又有五处坐实的存活变异，逐轮堵上：
   *
   *   F1（判据 A 按名字配对，同名兄弟分支替真正该受守的分支背书）：`flowSetFromCall` 曾返回 `Set<string>`，
   *     `assertSitesIn` 曾按操作数**名字**在整个函数体里配对。control.ts 的 arrangeWorkbenchControlTab 有三个
   *     分支、三个局部都叫 `next`：只有 preset 分支调 changes 族的 applyWorkbenchRegionLayoutPreset，另两个
   *     （balance / active-first）调 preserves 族。preset 分支的断言即使被同时改成不可达 + 喂错操作数
   *     （`if (import.meta.env.DEV) assertRegionInvariant(tab)`），另两个分支里合格的、同名 `next` 的断言也会
   *     顺手替 preset 站点满足按名字的 A——实测 `12 passed (12)` 存活。**修法**：流集与操作数都按**声明身份**
   *     （`ts.VariableDeclaration` 节点）比对，操作数标识符先按词法作用域解析到它的声明节点再比节点身份。
   *     三个 `next` 是三个不同的声明节点、在三个互斥作用域里，于是 preset 站点的 A 只认 preset 分支那次断言，
   *     兄弟分支的断言再也代偿不了它。**这是合法 TS，守卫必须学会认它，不要求生产源码改名。**
   *   F2（判据 B 只看「后面有 return」，不看「前面先 return 了没」）：B 曾只判「assert 是块内直接语句 **且它
   *     后面**同块里有 return」。在同块里 assert **之前**插一句无条件 `return`/`throw`，assert 变死代码，而它
   *     后面那条（也已死的）return 让旧 B 照旧绿——实测在 removeWorkbenchRegion 里 assert 前插 `return next`
   *     后 `12 passed (12)` 存活（tsconfig.base.json 未开 allowUnreachableCode，tsc 也只告警不报错）。**修法**：
   *     runsBeforeReturn 额外要求同块里在 assert **之前**没有无条件 return/throw 直接语句。注意 `if (…) return`
   *     那种是 IfStatement 不是块的直接 ReturnStatement，不算无条件退出，故 removeWorkbenchRegion 两处条件早退
   *     不会误伤。
   *   F3（别名 import 让调用点整体掉出扫描面）：给 helper 起别名（`splitWorkbenchRegion as splitRegionAliased`）
   *     后 callee 文本不再匹配 LAYOUT_EFFECT，那个函数静默从覆盖面消失，而判据 A 全程无察觉——旧代码里唯一
   *     抓住它的只是覆盖站点数从 3 掉到 2 触了 `toBeGreaterThan(2)` 这条**巧合地板**；仓库长到 ≥4 个站点时
   *     别名掉一个仍在地板之上，缺失的 assert 静默泄漏。**修法两层**：(1) callSites 按每个文件从 DEFINER 的
   *     named import 解析出「本地名→规范名」的别名表，用规范名查 LAYOUT_EFFECT，于是别名调用点仍留在扫描面、
   *     A/B 照常覆盖它；(2) 把覆盖站点集合按**名字**钉住（下方 REQUIRED_COVERED），并单独一条 it 检测那四个
   *     changes 助手的**别名 import specifier** 并响亮失败——裸计数地板不再承重。
   *   F4（#727：判据 B 也犯了 F1 在 A 上犯过的错——把「合格断言」绑在**函数**上而不是**站点**上）：B 曾按
   *     enclosing function 求 `.some(a => a.runsBeforeReturn)`——只问「函数里有没有一次可达断言」。把
   *     arrangeWorkbenchControlTab 的 preset 那句改成 `if (import.meta.env.DEV) assertRegionInvariant(next)`
   *     （**只改可达性、操作数不变**），balance/active-first 两个兄弟分支里**无条件**的断言仍替 preset 站点满足
   *     旧 B——实测 `14 passed (14)` 存活。对照：同一变异打在**单断言**的 addWorkbenchRegion 上，B 立刻红——
   *     正是「有兄弟可代偿」与「没有」的差别，坐实这是真缺陷而非理论形状。**修法（与 A 同构）**：B 先用 A 那把
   *     尺（操作数声明节点落在本站点流集）滤出「本站点自己的断言」，再要求其中至少一次可达。兄弟分支操作它
   *     自己 `next`（不在 preset 流集）的可达断言，不进 preset 的 in-flow 集，再也代偿不了。
   *   F5（#728：局部值别名让调用点整体逃出扫描面，是 F3 之外的第二个逃逸向量）：`const f = closeWorkbenchRegion;
   *     const layout = f(...)` 里 `f(...)` 的 callee 文本是 `f`，既不是 changes 助手、`aliasMapFor` 也看不见
   *     （它只解析 import specifier，不解析局部 const）。于是这个调用点整体从 callSites 消失，A/B 覆盖静默丢掉
   *     它——实测经局部 const 转发一个未守的 closeWorkbenchRegion 调用后 `14 passed (14)` 存活。**修法走允许
   *     清单而非禁止清单**（本仓「禁止清单必漏」）：下方「转发禁令」那条 it 扫全 renderer 里每个「文本是具名
   *     import 进来的 changes 助手本地名」的标识符，只放行两种角色——import specifier 与直接调用 callee——
   *     其余任何形状（赋给 const、当实参传出、进容器……）带着它的父节点 SyntaxKind 响亮失败，并用 callSites
   *     交叉核对「直接调用」那一面**恰好相等**。**没有为迁就守卫改生产源码**：这是给测试补一条禁止转发的约束。
   *
   * 拆成各自独立红的 it，不能合进一个：本仓 two-throws-in-one-it-mask-each-other 记过，先抛的那条断言会把
   * 后一条变成死代码。每处修复各有自己的靶子、且**只杀自己那一条**（交付前逐个跑变异证明，见交付 message）：
   *   - F1-单（只改操作数 `next`→`tab`）：只有 **A** 红。B 不红——`tab` 不在 preset 流集，preset 的 in-flow
   *     集为空，B 对该站点 vacuously 通过（「值喂错」交给 A 说，不重复报）。这正是 A 独立承重的证据。
   *   - F2 / F4（只改可达性、操作数不变）：只有 **B** 红。A 不红——操作数仍落在本站点流集里。这是 B 独立承重。
   *   - F3（别名 import）：只有 **别名禁令** 那条红。A/B 与名字锚点都仍绿（callSites 别名感知，站点没掉出扫描面）。
   *   - F5（局部 const 转发）：只有 **转发禁令** 那条红。A/B 仍绿（转发调用点本就在 callSites 之外，这正是
   *     它要堵的泄漏；堵在源头——禁止转发——而不是让 A/B 去追一个它们看不见的调用点）。
   * A 与 B 因此正交而非蕴含：A 问「本站点有没有 in-flow 断言」，B 问「本站点的 in-flow 断言有没有被全部跳过」；
   * 操作数坏→A 红、B vacuous 绿，可达性坏→B 红、A 绿。两条各自都有只杀自己的变异。
   *
   * 判据 A（喂对值）：对每个 changes-helper 调用点，求它的**流集**——从「初始化式（可传递地）引用了这次
   *   helper 调用**结果**（按 AST 节点标识）」的那个局部声明起步，闭包进「初始化式引用了已收集声明」的声明。
   *   要求函数体里至少有一次 `assertRegionInvariant(X)`、X 是裸标识符、且 X 词法解析到的**声明节点**落在流集内。
   *   入参不是由 helper 结果派生的局部声明，故解析不到流集里的节点。
   * 判据 B（真的跑）：先用 A 那把尺滤出「本站点的 in-flow 断言」（操作数声明节点落在本站点流集里的那些断言）；
   *   **若** 存在这样的断言，其中至少一次必须是某个 Block（或函数体）里的**直接**表达式语句、其后（按语句次序）
   *   同块里还有一条 return、**且其前**同块里没有任何无条件 return/throw 直接语句。若本站点一个 in-flow 断言都
   *   没有，B 对该站点 vacuously 通过——那是「值没喂对」，由 A 负责报，B 不重复。
   *
   * **自陈盲点（与断言真实强度一致，不夸大）**：
   *   - A/B 现在都按**声明身份**把合格断言绑到**站点**（F1 修了 A、F4 修了 B），兄弟分支的同名局部不再互相
   *     代偿。剩下的下限是「**同一站点**的 in-flow 集内若并列多次断言」：A 只要其一喂对、B 只要其一可达即算过，
   *     不要求逐条都合格。今天每个站点的 in-flow 集都只有一次断言，这个下限不可观测；是有意的下限，前提是
   *     「一个站点不会既写一次合格断言又写一次故意坏的」——若将来出现需收紧成逐条。
   *   - B 的可达性只看「同一个 Block 内、这条语句前后的直接语句序列」这一层线性次序，不建模更深的控制流
   *     （早退藏在更外层块、或 try/catch 语义）。这是有意的下限，不是完备可达性分析。
   *   - 逃逸面：callSites 只认「callee 是标识符、经具名 import 别名解析后是 changes 助手」的调用；下方两条
   *     禁令各堵一个逃逸向量（别名禁令堵 import `as` 改名，转发禁令堵局部 const 等值转发）。但**都**只覆盖
   *     「文本是具名 import 进来的本地名」这一层——`import * as ns` 后 `ns.closeWorkbenchRegion(...)` 的成员
   *     访问、或经二次 re-export 换名的调用点，既逃 callSites 也逃这两条禁令。今天 renderer 里没有这两种写法，
   *     若将来引入需另补守卫——此处如实点名，不假装已覆盖。
   *
   * **两处已知的「过严」（响亮假红，不是静默逃逸；如实记录，本轮不修）**：
   *   - enclosingFunction 对 class **方法**（MethodDeclaration）返回 null：方法体里的 changes 调用会因为
   *     `owner` 为 null 而流集空、asserts 空，A 当场把它算成 unguarded 而**无条件红**——哪怕它写得完全正确。
   *     今天 renderer 里没有任何方法承载的 reducer（全是函数声明或赋给 const 的箭头函数），故不影响；一旦有，
   *     这是响亮失败要求作者来处理，不是漏。
   *   - resolveVarDecl 的 isScope 不含 MethodDeclaration / Constructor / 访问器 / namespace 的 ModuleBlock：
   *     在这些作用域里声明的局部解析不到，`operandDecl` 变 null。null 操作数不落任何站点的流集，只会让 A**更
   *     严**（该断言守不了任何站点）——是响亮/安全的方向，不是让坏变异漏过的洞。
   */

  /** 一个 renderer 源文件里，从布局引擎（现居 @agentmux/layout）具名 import 出来的「本地名 → 规范名」别名表（无别名则为恒等）。 */
  function aliasMapFor(file: ts.SourceFile): Map<string, string> {
    const map = new Map<string, string>()
    file.forEachChild((node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '@agentmux/layout' &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const spec of node.importClause.namedBindings.elements) {
          map.set(spec.name.text, (spec.propertyName ?? spec.name).text)
        }
      }
    })
    return map
  }

  /** 一个标识符引用词法解析到的局部变量声明（按作用域就近，找不到则 null）。用于按**身份**而非名字比对。 */
  function resolveVarDecl(ref: ts.Identifier): ts.VariableDeclaration | null {
    const isScope = (n: ts.Node): boolean =>
      ts.isBlock(n) ||
      ts.isSourceFile(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isCaseBlock(n)
    const nearestScope = (n: ts.Node): ts.Node | null => {
      for (let c: ts.Node | undefined = n.parent; c; c = c.parent) if (isScope(c)) return c
      return null
    }
    for (let scope: ts.Node | undefined = nearestScope(ref) ?? undefined; scope; scope = nearestScope(scope) ?? undefined) {
      let hit: ts.VariableDeclaration | null = null
      const scan = (n: ts.Node): void => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === ref.text &&
          nearestScope(n) === scope
        ) {
          hit = n
        }
        n.forEachChild(scan)
      }
      scan(scope)
      if (hit) return hit
    }
    return null
  }

  const subtreeHas = (root: ts.Node, target: ts.Node): boolean => {
    let found = false
    const walk = (node: ts.Node): void => {
      if (node === target) found = true
      node.forEachChild(walk)
    }
    walk(root)
    return found
  }

  /**
   * 判据 A 的「流集」：一个函数体里，把 `anchorCall` 的结果（按节点标识）传递派生出去的全部局部**声明节点**。
   * 用声明节点（不是名字）作元素，是 F1 的核心——同名兄弟局部是不同节点，不会互相代偿。
   */
  function flowSetFromCall(ownerBody: ts.Node, anchorCall: ts.CallExpression): ts.VariableDeclaration[] {
    const decls: ts.VariableDeclaration[] = []
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) decls.push(node)
      node.forEachChild(collect)
    }
    collect(ownerBody)
    const flow = new Set<ts.VariableDeclaration>()
    for (const decl of decls) if (decl.initializer && subtreeHas(decl.initializer, anchorCall)) flow.add(decl)
    let changed = true
    while (changed) {
      changed = false
      for (const decl of decls) {
        if (flow.has(decl) || !decl.initializer) continue
        let refs = false
        const walk = (node: ts.Node): void => {
          if (ts.isIdentifier(node)) {
            const target = resolveVarDecl(node)
            if (target && flow.has(target)) refs = true
          }
          node.forEachChild(walk)
        }
        walk(decl.initializer)
        if (refs) {
          flow.add(decl)
          changed = true
        }
      }
    }
    return [...flow]
  }

  /**
   * 一个函数体里每次 assertRegionInvariant(...) 调用的两项事实：
   *   - `operandDecl`：裸标识符实参词法解析到的**声明节点**（不是裸标识符、或解析不到局部声明则 null）——
   *     喂给判据 A/B 的「本站点 in-flow」过滤（按身份比对，F1/F4）；`operandName` 仅供诊断消息。
   *   - `runsBeforeReturn`：这次调用是不是某个 Block 里的直接表达式语句、其后（按语句次序）跟着 return、
   *     **且其前**同块里没有无条件 return/throw 直接语句（F2）——喂给判据 B 的可达性那一半。
   */
  function assertSitesIn(
    ownerBody: ts.Node
  ): Array<{ operandDecl: ts.VariableDeclaration | null; operandName: string | null; runsBeforeReturn: boolean }> {
    const out: Array<{ operandDecl: ts.VariableDeclaration | null; operandName: string | null; runsBeforeReturn: boolean }> = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'assertRegionInvariant'
      ) {
        const arg = node.arguments[0]
        const operandName = arg && ts.isIdentifier(arg) ? arg.text : null
        const operandDecl = arg && ts.isIdentifier(arg) ? resolveVarDecl(arg) : null
        let runsBeforeReturn = false
        const statement = node.parent
        if (statement && ts.isExpressionStatement(statement) && statement.parent && ts.isBlock(statement.parent)) {
          const statements = statement.parent.statements
          const index = statements.indexOf(statement)
          const precededByExit =
            index >= 0 &&
            statements.slice(0, index).some((stmt) => ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt))
          const followedByReturn = index >= 0 && statements.slice(index + 1).some((stmt) => ts.isReturnStatement(stmt))
          runsBeforeReturn = index >= 0 && !precededByExit && followedByReturn
        }
        out.push({ operandDecl, operandName, runsBeforeReturn })
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
    /** 判据 A：本函数里由该 helper 调用结果传递派生出的局部**声明节点**（按身份，不按名字）。 */
    flow: ts.VariableDeclaration[]
    /** 判据 A/B：本函数里每次 assertRegionInvariant 的操作数声明节点、名字与「块内直接、前无退出、后有 return」标志。 */
    asserts: Array<{ operandDecl: ts.VariableDeclaration | null; operandName: string | null; runsBeforeReturn: boolean }>
  }

  /**
   * 每个「会动集合」的布局调用点，连同包着它的函数、该函数的流集与它体内每次断言的三项事实。
   * callee 名先经本文件的别名表解析回规范名再查 LAYOUT_EFFECT——别名调用点（`helper as alias`）仍留在扫描面（F3）。
   */
  function callSites(): ChangesHelperSite[] {
    const sites: ChangesHelperSite[] = []
    for (const relative of sourceFiles()) {
      const file = parse(relative)
      const alias = aliasMapFor(file)
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const canonical = alias.get(node.expression.text) ?? node.expression.text
          if (LAYOUT_EFFECT[canonical] === 'changes') {
            const owner = enclosingFunction(node, file)
            sites.push({
              file: relative,
              fn: owner?.name ?? '<top-level>',
              helper: canonical,
              flow: owner ? flowSetFromCall(owner.body, node) : [],
              asserts: owner ? assertSitesIn(owner.body) : []
            })
          }
        }
        node.forEachChild(walk)
      }
      walk(file)
    }
    return sites
  }

  it('布局引擎的每个导出都在分类表里（新增一个必须在这里回答「它动集合吗」）', () => {
    // 读的是引擎的真实源码（已抽进 @agentmux/layout），不是渲染层那层 `export *` 薄壳——薄壳里没有
    // 任何函数声明，按它扫会恒空假绿。
    const file = ts.createSourceFile(
      DEFINER,
      readFileSync(DEFINER_SOURCE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
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

    // 按**声明节点身份**比对（F1）：断言操作数解析到的声明必须落在本站点流集里。同名兄弟局部是不同节点，
    // 不会互相代偿——arrange 的 balance/active-first 分支里同名 `next` 的断言，替不了 preset 分支那次。
    const unguarded = sites
      .filter((site) => {
        const flow = new Set(site.flow)
        return !site.asserts.some((a) => a.operandDecl !== null && flow.has(a.operandDecl))
      })
      .map(
        (site) =>
          `${site.file}::${site.fn}() 调了 ${site.helper}；流集(声明节点)=${site.flow.length} 个；` +
          `断言操作数=[${site.asserts.map((a) => a.operandName ?? '<非标识符>').join(', ')}]`
      )
    expect(
      unguarded,
      '这些函数改了分屏树的 region 集合，但没有任何一次 assertRegionInvariant 断言的是「本函数刚算出来、' +
        '准备交出去的那个值」（即该 changes-helper 调用结果传递派生出的局部，按声明节点身份判定）。断言喂了' +
        '别的东西（比如入参，或另一个同名但属于别的分支的局部）等于让它对着一个进函数时就已合法、或根本不是' +
        '这条路径产物的对象空转，真正被交出去的新值没人校验。' +
        '修法是在 return 之前 assertRegionInvariant(那个新算出来的 tab)。'
    ).toEqual([])
  })

  it('接线层-B（真的跑）：每个 changes 调用点，凡有断言了本站点产物的 assertRegionInvariant，其中至少一次必须块内直接、其后有 return（可达）', () => {
    const sites = coveredSites()
    expect(sites.length, '扫不到任何受管的「会动集合」调用点——扫描根或分类表出了问题').toBeGreaterThan(2)
    // 在场自检：B 的合格判据用「操作数落在本站点流集」把断言绑到站点（否则又退回按函数求 some，兄弟分支
    // 代偿），故它跟 A 一样依赖 flowSetFromCall。若流集对每个站点都算成空，B 会因「本站点没有 in-flow 断言」
    // 而对所有站点 vacuously 通过、恒绿——这正是假绿方向，必须由这条自检当场推翻。
    expect(
      sites.some((site) => site.flow.length > 0),
      '所有受管调用点的流集都算成空了——flowSetFromCall 的派生失灵，判据 B 失去意义（会恒绿）'
    ).toBe(true)
    // #727：B 从前只按 enclosing function 求 `.some(a => a.runsBeforeReturn)`——问「函数里有没有一次可达断言」，
    // 不问它断言的是不是**本站点**的产物。control.ts 的 arrangeWorkbenchControlTab 有三个分支、三个同名 `next`，
    // 只有 preset 分支调 changes 族。把 preset 那句改成 `if (import.meta.env.DEV) assertRegionInvariant(next)`
    // （只改可达性、操作数不变）后，balance/active-first 两个兄弟分支里**无条件**的断言仍替 preset 站点满足了
    // 旧 B——实测 `14 passed` 存活。这与 #698 在 A 上修掉的「同名兄弟背书」同构：A 早已按声明身份把合格断言绑到
    // 站点，B 却还绑在函数上。
    //
    // 修法（保持 A/B 正交、各自独立承重）：先用 A 那把尺（操作数声明节点落在本站点流集）滤出「本站点自己的
    // 断言」inFlow，再要求——**若** inFlow 非空，其中至少一次可达。它与 A 正交而非蕴含 A：
    //   - A 问「本站点有没有 in-flow 断言」——操作数错（F1）时它红，可达性错时它绿。
    //   - B 问「本站点的 in-flow 断言有没有被全部跳过」——可达性错（#727 / F2）时它红；操作数错时 inFlow 为空、
    //     B vacuously 通过（把「值喂错」这件事让给 A 说，不重复报）。
    // 于是 #727（可达性坏、操作数不变）只红 B、A 仍绿；F1-单（操作数坏、可达性不变）只红 A、B vacuously 绿。
    // 兄弟分支操作自己 `next`（不在 preset 流集、不进 inFlow）的可达断言，再也代偿不了 preset 站点。
    const unreachable = sites
      .filter((site) => {
        const flow = new Set(site.flow)
        const inFlow = site.asserts.filter((a) => a.operandDecl !== null && flow.has(a.operandDecl))
        return inFlow.length > 0 && !inFlow.some((a) => a.runsBeforeReturn)
      })
      .map(
        (site) =>
          `${site.file}::${site.fn}() 调了 ${site.helper}；流集(声明节点)=${site.flow.length} 个；` +
          `本站点断言=[${site.asserts
            .map((a) => `${a.operandName ?? '<非标识符>'}${a.runsBeforeReturn ? '·可达' : '·被跳过'}`)
            .join(', ')}]`
      )
    expect(
      unreachable,
      '这些函数里断言了「本函数刚算出、准备交出去的那个值」（该 changes-helper 调用结果派生出的局部，按声明' +
        '节点身份）的 assertRegionInvariant，没有任何一次是「块内直接语句、其后跟着 return」的可达形状——它们' +
        '全被包进了 if / 短路 / dev-only 门里，于是在真正把值交出去的那条路径上根本不会执行。纵深断言一旦可被' +
        '某个构建或某个分支跳过，就等于没装；另一个分支里可达但断言的是别的值的断言，代偿不了本站点。' +
        '修法是让 `assertRegionInvariant(那个新算出来的 tab)` 成为本站点 return 之前的一条无条件语句。'
    ).toEqual([])
  })

  // 覆盖面按**名字**钉住（F3）：这三个受管函数必须始终在扫描面里。裸计数地板（A/B 里的 >3 / >2）
  // 是「至少还有几个站点」，别名掉一个仍可能在地板之上——那正是别名让站点静默泄漏的形状。这里点名要求
  // 每个都在，别名感知的 callSites 让别名调用点也仍以规范名出现，故起了别名它照样命中、这条不因别名而红；
  // 真正挡别名的是下一条。这条挡的是「某个受管函数被整体删掉/改名/搬走而无人再断言它」。
  const REQUIRED_COVERED: ReadonlyArray<{ file: string; fn: string; helper: string }> = [
    { file: 'lib/workbench-tabs.ts', fn: 'addWorkbenchRegion', helper: 'splitWorkbenchRegion' },
    { file: 'lib/workbench-tabs.ts', fn: 'removeWorkbenchRegion', helper: 'closeWorkbenchRegion' },
    { file: 'lib/control.ts', fn: 'arrangeWorkbenchControlTab', helper: 'applyWorkbenchRegionLayoutPreset' }
  ]

  it('覆盖面按名字钉住：三个受管的 changes 调用点必须都在扫描面里（不靠裸计数地板）', () => {
    const seen = new Set(callSites().map((site) => `${site.file}::${site.fn}::${site.helper}`))
    const missing = REQUIRED_COVERED.filter(
      (want) => !seen.has(`${want.file}::${want.fn}::${want.helper}`)
    ).map((want) => `${want.file}::${want.fn}() 调 ${want.helper}`)
    expect(
      missing,
      '这些点名必守的「会动集合」调用点从扫描面消失了（被删/改名/搬走/换了 helper）。裸计数地板挡不住' +
        '「掉一个仍在地板之上」，故这里逐名钉死；若确实合法地移除了某个，请连同 REQUIRED_COVERED 一起更新。'
    ).toEqual([])
  })

  it('别名禁令：四个 changes 助手不得以别名 import（否则调用点会掉出扫描面）', () => {
    const CHANGES = Object.keys(LAYOUT_EFFECT).filter((name) => LAYOUT_EFFECT[name] === 'changes')
    const aliased: string[] = []
    for (const relative of sourceFiles()) {
      const alias = aliasMapFor(parse(relative))
      for (const [local, canonical] of alias) {
        if (local !== canonical && CHANGES.includes(canonical)) aliased.push(`${relative}: ${canonical} as ${local}`)
      }
    }
    // 在场自检：别名检测建立在「本文件确实从 DEFINER 具名 import 了这些助手」之上。至少有一个文件应导入到
    // 某个 changes 助手（规范名映射到自身也算），否则 aliasMapFor 整体失灵会让本条恒空假绿。
    const importsAnyChanges = sourceFiles()
      .filter((relative) => relative !== DEFINER)
      .some((relative) => [...aliasMapFor(parse(relative)).values()].some((canonical) => CHANGES.includes(canonical)))
    expect(importsAnyChanges, '没有任何 renderer 文件从 DEFINER import 到 changes 助手——别名表解析失灵，本条失去意义').toBe(true)
    expect(
      aliased,
      '这些 changes 助手被起了 import 别名。别名会让 callSites 若只按 callee 文本匹配就整体漏掉该调用点，' +
        '其函数静默从 A/B 的覆盖面消失。今天 callSites 已别名感知能顶住，但别名本身没有收益、只会削弱这道闸的' +
        '可读性与其它按名字的守卫，故一律禁止：请用规范名 import。'
    ).toEqual([])
  })

  /**
   * #728：局部值别名让调用点整体逃出扫描面。
   *
   * `callSites` 只认「callee 是标识符、且其文本（经具名 import 别名解析后）是 changes 助手」的调用。
   * `const f = closeWorkbenchRegion; const layout = f(tab.layout, regionId)` 这种转发形状里，`f(...)` 的
   * callee 文本是 `f`——不是任何 changes 助手，`aliasMapFor` 也看不见（它只解析 import specifier，不解析
   * 局部 const）。于是这个调用点整体从扫描面消失，A/B 覆盖都静默丢掉它。实测：把某个 reducer 改成经
   * 局部 const 调 changes 助手且不带断言，`14 passed` 存活。
   *
   * 修法走**允许清单**（本仓「禁止清单必漏」——`||` / `?:` / `void 0 &&` / Yoda / 解构 / 下标 / 块外
   * helper 都绕过过；F3 的别名禁令也是一样的道理：与其枚举坏形状，不如只放行已知安全的几种）。
   * changes 助手是从 DEFINER import 进来的值，引用它的合法形状只有两种：作为 import specifier 的名字，
   * 或作为一次直接调用的 callee。把它当值传递给别的东西（赋给 const、当实参传出去、放进数组/对象），
   * 都是让调用点脱离 callee 文本匹配的转发向量——**一律响亮失败并打印它看到的父节点 SyntaxKind**，
   * 而不是枚举「这几种不许」。今天 renderer 里这样的引用**恰好只有** import specifier 与直接调用两种
   * （下方自检用 callSites 交叉核对直接调用那一面），所以允许清单不误伤任何合法代码。
   *
   * 盲点（如实点名，不假装覆盖）：这条只扫「文本是**具名 import 进来的** changes 助手本地名」的标识符。
   * `import * as ns` 后 `ns.closeWorkbenchRegion` 的成员访问、或经二次 re-export 换名的引用，都不经具名
   * import 本地名，故既逃 callSites 也逃这条——与文件头记的 callSites 别名盲点同源，将来引入需另补守卫。
   */
  it('转发禁令：changes 助手只可作 import specifier 或直接调用 callee 出现，其余引用形状（如 const 转发）一律响亮失败', () => {
    const CHANGES = Object.keys(LAYOUT_EFFECT).filter((name) => LAYOUT_EFFECT[name] === 'changes')
    const ACCEPT_IMPORT = 'import-specifier'
    const ACCEPT_CALL = 'direct-call-callee'
    type Occurrence = { file: string; helper: string; role: string }
    const occurrences: Occurrence[] = []
    for (const relative of sourceFiles()) {
      const file = parse(relative)
      // 本文件里「本地名 → 规范名」映射到某个 changes 助手的那些本地名。别名已被上一条禁掉，故正常树上
      // 本地名≡规范名；这里仍按本地名扫，是为了在别名（防御性）与规范名两种写法下都能对上被引用的绑定。
      const changesLocals = new Map<string, string>()
      for (const [local, canonical] of aliasMapFor(file)) {
        if (CHANGES.includes(canonical)) changesLocals.set(local, canonical)
      }
      if (changesLocals.size === 0) continue
      const walk = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && changesLocals.has(node.text)) {
          const helper = changesLocals.get(node.text)!
          const parent = node.parent
          let role: string
          if (parent && ts.isImportSpecifier(parent)) role = ACCEPT_IMPORT
          else if (parent && ts.isCallExpression(parent) && parent.expression === node) role = ACCEPT_CALL
          else role = `ESCAPE:${parent ? ts.SyntaxKind[parent.kind] : 'no-parent'}`
          occurrences.push({ file: relative, helper, role })
        }
        node.forEachChild(walk)
      }
      walk(file)
    }
    // 允许清单：只有这两种 role 放行，其余全是逃逸向量。逐条打印它看到的 SyntaxKind，
    // 这样将来一种没见过的转发写法会带着自己的形状名响亮失败，而不是被某条「不许出现」的规则悄悄漏过。
    const escapes = occurrences
      .filter((o) => o.role !== ACCEPT_IMPORT && o.role !== ACCEPT_CALL)
      .map((o) => `${o.file}: ${o.helper} 以 ${o.role} 形状被引用`)
    expect(
      escapes,
      '这些 changes 助手不是作为 import specifier 或直接调用 callee 出现，而是被当值转发了（赋给 const、' +
        '当实参传出、放进容器等）。转发会让 callSites 的 callee 文本匹配整体漏掉那个真正的调用点，其函数' +
        '静默脱离 A/B 覆盖面——正是那个画不出也关不掉的孤儿 region 的温床。请改回直接以规范名调用；若确有' +
        '不得不转发的正当理由，需连同 callSites 的解析能力一起扩展，而不是在这里开一个不受守的口子。'
    ).toEqual([])
    // 在场自检（交叉核对，恰好相等）：本条扫出的「直接调用」那一面，其 file::helper 集合必须与独立的
    // callSites 扫描器逐一相等。若本条的角色分类器把直接调用误判、或扫描根/别名表整体失灵而扫出空集，
    // 两个集合就会分岔、当场红——不是「至少一个」这种能被半失灵蒙混的软地板。callSites 自身的非空由
    // A/B 两条 it 的 >3 / >2 地板另行守，故这里的相等断言不会因 callSites 恒空而假绿。
    const callRoleSet = new Set(
      occurrences.filter((o) => o.role === ACCEPT_CALL).map((o) => `${o.file}::${o.helper}`)
    )
    const callSiteSet = new Set(callSites().map((site) => `${site.file}::${site.helper}`))
    expect(
      [...callRoleSet].sort(),
      '本条识别出的「直接调用」与 callSites 扫描器不一致——角色分类器或扫描根出了问题，本条失去意义'
    ).toEqual([...callSiteSet].sort())
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
