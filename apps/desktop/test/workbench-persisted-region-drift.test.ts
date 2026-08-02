import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/shared/contracts.js'
import { CONFIG_VERSION } from '../src/shared/contracts.js'
import { createWorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import {
  regionIds,
  splitWorkbenchRegion
} from '../src/renderer/src/lib/workbench-view-layout.js'
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

const config: AppConfig = {
  version: CONFIG_VERSION,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
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
 * 接线层。上面那族全在 lib 里跑，所以「措辞算出来了」和「用户看得见」是两件事——本仓
 * extracting-to-lib-only-fixes-half：搬进 lib 只让内容可测，壳有没有把它接上照旧无人守。
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
