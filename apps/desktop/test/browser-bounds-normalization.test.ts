import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { normalizeBrowserBounds } from '../src/shared/browser-bounds.js'

// ---------------------------------------------------------------------------
// 原生 Browser 视图的几何归一化：一次判定，两层共用（#703）。
//
// 被守的是什么：`shared/browser-bounds.ts` 里那一个 `normalizeBrowserBounds`。它此前是两份逐字节相同
// 的取值拷贝——renderer 在 `observe` 里一份，main 在 `setBounds` 里一份，互相没有任何编译期联系，
// `tsc` 看不见。抽成一份之后**必须**同时守三件互相独立的事，缺任一条都留下一个静默的洞：
//
//   1. 行为层：那份判定本身对不对（哪些矩形被拒、被接受的怎么归一）。
//   2. 接线层（行为）：两个调用点**真的执行到**它。本仓 extracting-to-lib-only-fixes-half 的教训：
//      抽完之后「壳里那句到底跑没跑」照旧无人守——把 `observe` 改回 `this.pending = bounds`，
//      纯函数的测试一条都不会红。这两条断言走真实调用路径，不是读源码。
//   3. 接线层（结构）：两个调用点**没有各自重抄一份**。行为断言分不出「调了共用的那份」和
//      「自己抄了一份一模一样的」——而后者正是 #703 要消除的东西。所以这一层判 import 关系
//      （不是裸标识符文本，见本仓 guard-criterion-must-be-import-relation）加「方法体里没有自己的
//      `Math.` 运算」。
//
// 已声明的盲点（写在这里而不是让读者自己发现）：
//   - 结构层只看这两个方法体。若有人在**别的**方法里重抄一份夹取并让 `observe`/`setBounds` 转发过去，
//     结构层看不见。行为层仍能钉住取值正确，代价是重复回来了而无人报警。
//   - 结构层的「没有 `Math.` 运算」是按 `Math.xxx()` 这个形状判的。`const M = Math; M.round(...)` 或
//     `import { round } from …` 能绕过。这不是"禁止清单"式的穷举（那必漏，见
//     forbidden-list-guard-always-leaks），而是配合「恰好一次共用调用」一起用：绕过它的写法要么
//     让共用调用数不为 1，要么产出与共用判定不同的取值而被行为层抓住。
//   - 「宽高地板 `Math.max(1, …)` 已删」不用禁止形状去守（那种守卫既漏又误伤）。改成守它当初想买的
//     **性质**：接受的矩形归一后宽高恒 >= 1。把任一维的拒绝阈值改宽一点点，那条性质立刻破——注意
//     那一族判据必须**每次只动一个维度**扫，理由写在那条用例上面。
// ---------------------------------------------------------------------------

describe('行为层：这份判定本身', () => {
  it('没有矩形就是没有——`null` 原样穿过，不变成一个假的零矩形', () => {
    expect(normalizeBrowserBounds(null)).toBeNull()
  })

  it.each([
    { field: 'x', bounds: { x: Number.NaN, y: 0, width: 10, height: 10 } },
    { field: 'y', bounds: { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 } },
    { field: 'width', bounds: { x: 0, y: 0, width: Number.NaN, height: 10 } },
    { field: 'height', bounds: { x: 0, y: 0, width: 10, height: Number.NEGATIVE_INFINITY } }
  ])('$field 是非有限数时整个矩形不可用（不是把那一个字段悄悄补成 0）', ({ bounds }) => {
    expect(normalizeBrowserBounds(bounds)).toBeNull()
  })

  it.each([
    { why: '宽为 0（卸载中量到的瞬时零几何）', bounds: { x: 0, y: 0, width: 0, height: 500 } },
    { why: '高为 0', bounds: { x: 0, y: 0, width: 800, height: 0 } },
    { why: '宽不足 1 物理像素', bounds: { x: 0, y: 0, width: 0.9, height: 500 } },
    { why: '高为负（Region 反向折叠时求交能得出负高）', bounds: { x: 0, y: 0, width: 800, height: -3 } }
  ])('$why 时不可用', ({ bounds }) => {
    expect(normalizeBrowserBounds(bounds)).toBeNull()
  })

  it('负原点被夹回 0——这是唯一真正承重的那道钳位', () => {
    // 为什么 x/y 需要夹而宽高不需要：x/y **没有**下界拒绝，负坐标是合法输入（Region 滚出视口上方，
    // 求交得到负的左/上沿），而原生视图不接受负原点。`-0.6` 会 `Math.round` 成 `-1`，必须夹。
    // 删掉这两个 `Math.max(0, …)`，这一条红。
    expect(normalizeBrowserBounds({ x: -0.6, y: -5, width: 10, height: 10 }))
      .toEqual({ x: 0, y: 0, width: 10, height: 10 })
  })

  it('四个字段各自取整到最近的整数像素', () => {
    expect(normalizeBrowserBounds({ x: 10.4, y: 20.6, width: 800.2, height: 500.8 }))
      .toEqual({ x: 10, y: 21, width: 800, height: 501 })
  })

  // 两侧原来各带一份 `Math.max(1, Math.round(w))`。它是**死代码**：上面那条拒绝已保证 `w >= 1`，
  // 而 `w >= 1` 时 `Math.round(w) >= 1` 恒成立，所以那道 `max` 一次都改不了结果——Reviewer 的变异
  // （地板 `1`→`7`）在两侧都全绿存活，不是判据弱，是没有输入能走到那里。删死代码而不是给不可达分支
  // 补测试，但**必须**把它当初想买的性质接管过来：「被接受 ⇒ 归一后 >= 1」。
  //
  // 为什么按维度各扫一遍、而不是让宽高一起动：一起动时另一侧那条**还没被改坏**的拒绝会把样本挡在
  // 门外，于是这条判据观测不到被放宽的那一侧。这不是假设——第一版就是同时动的，把 `width < 1` 改成
  // `width < 0` 之后它全绿存活（红的只有另外两条点名用例）。所以每次只动一个维度，另一维固定在安全值。
  it.each([
    { dimension: 'width' as const, other: 'height' as const },
    { dimension: 'height' as const, other: 'width' as const }
  ])('接受的矩形归一后 $dimension 恒 >= 1（宽高地板删得掉的前提）', ({ dimension, other }) => {
    for (let step = 0; step <= 40; step += 1) {
      const size = 0.8 + step * 0.02 // 0.80 … 1.60，跨过 1 这个阈值
      const result = normalizeBrowserBounds({ x: 0, y: 0, [dimension]: size, [other]: 10 } as never)
      if (size < 1) {
        expect(result, `${dimension} ${size} 不足 1 物理像素却被接受了`).toBeNull()
        continue
      }
      expect(result, `${dimension} ${size} 该被接受`).not.toBeNull()
      expect(result![dimension], `${dimension} ${size} 归一后掉到 1 以下`).toBeGreaterThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 结构层：两个调用点各走一次共用判定，且**没有**自己那份夹取。
//
// 为什么这一层不能省：行为层分不出「调了共用的那份」和「自己抄了一份一模一样的」。#703 要消除的正是
// 后者，所以判据必须落在「那次调用解析到的是不是共用模块的具名 import」上。
// ---------------------------------------------------------------------------

const SHARED_MODULE = 'shared/browser-bounds'

interface CallSiteFacts {
  /** 方法体里解析到共用模块具名 import 的调用次数。 */
  sharedCalls: number
  /** 方法体里 `Math.xxx()` 形状的调用次数——自己重抄一份夹取的迹象。 */
  mathCalls: number
  /** 找到的同名方法声明个数。0 表示判据落空（方法改名/搬走），不能当成"通过"。 */
  declarations: number
}

/**
 * 在一段源码里量一个方法的接线事实。
 *
 * `moduleHint` 只用来匹配 import 的**路径**（renderer 侧写 `../../../shared/browser-bounds`，main 侧写
 * `../shared/browser-bounds.js`，两边路径不同但都以同一段结尾），本地名从那条 import 的具名列表里取，
 * 所以改名 import（`as normalize`）照样认得，而同名的本地声明认不出来——那正是要区分的。
 */
function callSiteFacts(source: string, fileName: string, method: string): CallSiteFacts {
  const ast = ts.createSourceFile(source, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  void fileName

  const importedLocals = new Set<string>()
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text.replace(/\.js$/u, '')
    if (!specifier.endsWith(SHARED_MODULE)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) importedLocals.add(element.name.text)
  }

  const facts: CallSiteFacts = { sharedCalls: 0, mathCalls: 0, declarations: 0 }

  const measureBody = (body: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && importedLocals.has(node.expression.text)) {
          facts.sharedCalls += 1
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'Math'
        ) {
          facts.mathCalls += 1
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
  }

  const findMethod = (node: ts.Node): void => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === method &&
      node.body
    ) {
      facts.declarations += 1
      measureBody(node.body)
    }
    ts.forEachChild(node, findMethod)
  }
  findMethod(ast)

  return facts
}

const CALL_SITES = [
  {
    layer: 'renderer',
    file: '../src/renderer/src/lib/browser-bounds-sync.ts',
    method: 'observe'
  },
  {
    layer: 'main',
    file: '../src/main/browser-view-manager.ts',
    method: 'setBounds'
  }
] as const

describe.each(CALL_SITES)('结构层：$layer 侧的 $method 走共用判定', ({ file, method }) => {
  const path = new URL(file, import.meta.url).pathname
  const facts = callSiteFacts(readFileSync(path, 'utf8'), file, method)

  it('判据没有落空——这个方法确实还在这儿（否则下面两条恒真）', () => {
    expect(facts.declarations, `${file} 里找不到恰好一个 ${method} 方法声明，判据失效`).toBe(1)
  })

  it('方法体里恰好一次调用解析到共用模块的具名 import', () => {
    // 恰好一次而不是"至少一次"：多于一次意味着同一个矩形被归一了两遍（幂等所以行为层看不出来），
    // 那是接线出错的迹象。零次意味着这一层根本没走共用判定——把 `observe` 改回
    // `this.pending = bounds`、或 main 改回 `entry.bounds = bounds`，这一条红。
    expect(facts.sharedCalls).toBe(1)
  })

  it('方法体里没有自己那份 `Math.` 夹取（重复没有偷偷回来）', () => {
    expect(facts.mathCalls).toBe(0)
  })
})

describe('结构层的自检：判据认得出它要防的那两种写法', () => {
  // 为什么要这一组：上面三条是"计数等于某个值"，而计数器本身可能因为写错而恒定返回期望值。这里用
  // **合成的**源码质询它——每一段都是合法 TS、都在真实文件里出现过或极可能出现，且都必须被判成违规。
  const PRELUDE = "import { normalizeBrowserBounds } from '../shared/browser-bounds.js'\n"

  it('本地同名函数冒充不了那条 import（裸标识符文本判据会被它骗过）', () => {
    // 这是 guard-criterion-must-be-import-relation 那条记忆的靶子：`toContain('normalizeBrowserBounds(')`
    // 会全绿，而运行期用的是本地那份拷贝。判 import 关系才认得出来。
    const source = [
      'function normalizeBrowserBounds(b: unknown): unknown { return b }',
      'class Probe {',
      '  observe(bounds: unknown): void { this.pending = normalizeBrowserBounds(bounds) }',
      '  pending: unknown',
      '}'
    ].join('\n')
    expect(callSiteFacts(source, 'probe.ts', 'observe').sharedCalls).toBe(0)
  })

  it('重抄回来的一份夹取会被数到', () => {
    const source = [
      PRELUDE,
      'class Probe {',
      '  observe(bounds: { x: number }): void {',
      '    this.pending = { x: Math.max(0, Math.round(bounds.x)) }',
      '  }',
      '  pending: unknown',
      '}'
    ].join('\n')
    const facts = callSiteFacts(source, 'probe.ts', 'observe')
    expect(facts.mathCalls).toBe(2)
    expect(facts.sharedCalls, '这段里根本没调共用函数，却被数成调了').toBe(0)
  })

  it('方法不在场时 declarations 为 0，而不是让另两条判据静默通过', () => {
    const facts = callSiteFacts(`${PRELUDE}class Probe { other(): void {} }`, 'probe.ts', 'observe')
    expect(facts.declarations).toBe(0)
    expect(facts.sharedCalls).toBe(0)
  })

  it('改名 import 仍算共用调用（判的是来源不是拼法）', () => {
    const source = [
      "import { normalizeBrowserBounds as normalize } from '../shared/browser-bounds.js'",
      'class Probe {',
      '  observe(bounds: unknown): void { this.pending = normalize(bounds) }',
      '  pending: unknown',
      '}'
    ].join('\n')
    expect(callSiteFacts(source, 'probe.ts', 'observe').sharedCalls).toBe(1)
  })
})
