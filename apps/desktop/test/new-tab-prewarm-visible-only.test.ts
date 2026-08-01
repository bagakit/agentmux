import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * 初始页只有在**可见**时才可以预热终端。
 *
 * `warmTerminal` 是全局单槽（一个 key、一个 session，见 store.ts 的 prewarmTerminal）。泊车的
 * （隐藏的）workspace 槽仍然挂载着；如果它们也预热，每个泊车 workspace 都会 spawn 一个 PTY 并
 * 互相踢掉对方那唯一的槽。所以不变量是：`prewarmTerminal` 的**调用只能在 `visible` 为真时发生**。
 *
 * 承载它的是 NewTabSurface.tsx 的这段 effect：
 *
 *     useEffect(() => {
 *       if (workspace && visible) prewarmTerminal(workspace.id)
 *     }, [prewarmTerminal, visible, workspace?.id])
 *
 * 本仓**没有任何 DOM 测试环境**（无 jsdom / happy-dom，vitest.config 里 `environment:` 零命中），
 * 渲染只有 `renderToStaticMarkup`，它**不跑 useEffect**。所以「组件挂载后 effect 有没有以正确极性
 * 调用 prewarm」这件事没法用行为测试守——只能守形状。
 *
 * 但守形状的旧写法是一条**文本断言**（workspace-workbench-registry.test.ts）：
 *
 *     expect(newTab).toContain('if (workspace && visible) prewarmTerminal(workspace.id)')
 *
 * 它被实测绕过：**保留那行字面量不动**，在它上面加一行 `if (workspace) prewarmTerminal(workspace.id)`
 * （无条件），结果每个泊车 workspace 都会预热，而该文件 6 条全绿、`tsc --noEmit` 也干净。这是本仓
 * 反复记录的同族洞——「数符号名守不住别的拼法」「grep 守卫看不见早退」：字面量在场 ≠ 语义正确。
 *
 * 所以这条守卫的判据改成**数出口 + 判极性**，而且用 AST 而不是文本（先例：
 * terminal-link-provider-coverage.test.ts 用 `ts.createSourceFile` 数 activate 出口个数）：
 *
 *   1. 整个文件里 `prewarmTerminal(` 的**调用点恰好只有一处**。
 *   2. 那一处调用落在一个以 `visible` 为**必要条件**的 `if` 的 then 分支里
 *      （把守护条件按 `&&` 摊平后，其中一个合取项是裸标识符 `visible`）。
 *
 * 为什么这两条能同时抓住两种变异：
 *   - 取反 `!visible`：`!visible` 是 PrefixUnary 不是裸 `visible` 合取项 → 第 2 条红。
 *   - 另加一个无条件调用：调用点变两处 → 第 1 条红。
 * 单独任一条都只抓一种；两条一起才两种都抓。
 *
 * 为什么天然免疫「把代码移进注释」这种恒真陷阱：判据读的是 AST 的**调用节点**，注释掉的代码在
 * 语法树里根本不产生 CallExpression。注释掉那行 → 调用点变 0 处 → 第 1 条红。判据不依赖「文件里
 * 出现过某个字符串」，所以没有可以被注释掉而恒真的东西。
 */

const SOURCE_PATH = new URL(
  '../src/renderer/src/components/NewTabSurface.tsx',
  import.meta.url
).pathname
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('NewTabSurface.tsx', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
}

/**
 * 文件里所有 `prewarmTerminal(...)` 的调用表达式。
 *
 * 只认「标识符 `prewarmTerminal` 直接被调用」这一形状。line 72 的
 * `const prewarmTerminal = useAppStore((state) => state.prewarmTerminal)` 里，`prewarmTerminal`
 * 一处是声明名、一处是属性访问名，都不是「被调用的标识符」，所以不会命中。
 */
function prewarmCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'prewarmTerminal'
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

/** 剥掉外层括号。`(visible)`、`((a && b))` 都还原成里面那个真表达式。 */
function unwrap(expr: ts.Expression): ts.Expression {
  let node = expr
  while (ts.isParenthesizedExpression(node)) node = node.expression
  return node
}

/** 把 `a && b && c` 这样的合取链摊平成 [a, b, c]；非 `&&` 的表达式原样单独返回。 */
function conjuncts(expr: ts.Expression): ts.Expression[] {
  const node = unwrap(expr)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...conjuncts(node.left), ...conjuncts(node.right)]
  }
  return [node]
}

/** 这个表达式是不是恰好是裸标识符 `name`（去括号后）。`!visible`、`visible === true` 都不算。 */
function isBareIdentifier(expr: ts.Expression, name: string): boolean {
  const node = unwrap(expr)
  return ts.isIdentifier(node) && node.text === name
}

/** `node` 是否在 `container` 的子树内（含自身）。依赖 createSourceFile 建了 parent 指针。 */
function isDescendant(node: ts.Node, container: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (current === container) return true
    current = current.parent
  }
  return false
}

/** 函数边界：守护条件必须与调用**在同一个函数体内**，不能借用外层函数里的 `if (visible)`。 */
function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  )
}

/**
 * 包着这个调用的最内层函数体（就是 effect 的那个箭头函数体）。
 *
 * 用来划定「在这次调用之前」的搜索范围。找不到（调用在顶层）时返回 undefined。
 */
function enclosingFunctionBody(call: ts.CallExpression): ts.Block | undefined {
  let current: ts.Node | undefined = call.parent
  while (current) {
    if (isFunctionBoundary(current)) {
      const body = (current as ts.FunctionLikeDeclaration).body
      return body && ts.isBlock(body) ? body : undefined
    }
    current = current.parent
  }
  return undefined
}

/**
 * 在这次调用**之前**，同一个 effect 体里提前离开的出口语句（`return` / `throw`）。
 *
 * 这一条补的是上面两条判据共同的盲点，而它是实测出来的，不是想出来的：在 effect 第一行插一句
 * `if (launcherId) return`（`launcherId` 来自 warmLauncherId，恒是 `group:…` 或 `region:…` 这样的
 * 非空串，所以这是一次**无条件**早退），整条 effect 变成 no-op —— 泊车与可见的 launcher 都不再预热，
 * 而这个文件 8 条判据全绿、`tsc --noEmit` 也 exit 0。
 *
 * 两条旧判据对它天然失明：调用点仍然恰好一处，它仍然落在 `workspace && visible` 的 then 分支里。
 * 「调用存在且包在正确的 if 里」与「这次调用可达」是两件事——本仓记过这一族（grep 守卫看不见早退、
 * 抽进 lib 只解决一半）。
 *
 * 也不能指望 tsc 兜住：裸 `return` 那种写法恰好会让 `workspace` 丢掉收窄而报 TS18048，但那是**偶然**
 * ——换成上面这个保留收窄的形状，tsc 全程沉默。把「tsc 会拦」当作不写判据的理由，正是这个洞的来路。
 *
 * 判据故意收得很紧：这条 effect 的正确形状是「体内只有那一个 if」，任何提前离开都必然让预热在某些
 * 情况下不发生，而这条 effect 的语义是「可见就该有热 shell」。所以这里不区分「合法的早退」与
 * 「变异的早退」——一个都不许有。真要加守卫条件，写进那个 `if` 的合取项里（`visible` 仍是必要条件，
 * 极性那条判据照旧守着），而不是在它上面另开一个出口。
 */
function earlyExitsBefore(call: ts.CallExpression): ts.Node[] {
  const body = enclosingFunctionBody(call)
  if (!body) return []
  const exits: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    // 嵌套函数（回调、cleanup 里的 setTimeout 等）里的 return 属于**那个**函数，不是这条 effect 的
    // 出口，跳过整棵子树。cleanup 那个 `return () => …` 本身在调用之后，不会落进这里。
    if (node !== body && isFunctionBoundary(node)) return
    if ((ts.isReturnStatement(node) || ts.isThrowStatement(node)) && node.end <= call.getStart()) {
      exits.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return exits
}

/**
 * 这个调用是否被「以 `visible` 为必要条件」的分支守住。
 *
 * 从调用向上找 `if`，直到撞上函数边界（撞上就说明这个调用所在的函数里没有任何守护，返回 false）。
 * 一个 `if` 算数，需要同时满足：
 *   - 调用落在它的 then 分支里，而**不**在 else 分支里（`if (visible) {} else { prewarm() }`
 *     意味着不可见时才跑，极性正好相反）；
 *   - 它的条件按 `&&` 摊平后，含有裸 `visible` 合取项（于是「visible 为真」是这个 `if` 进入的必要条件）。
 * 允许嵌套：只要向上任意一层这样的 `if` 成立即可（`visible` 仍是必要条件）。
 */
function callGuardedByVisible(call: ts.CallExpression): boolean {
  let current: ts.Node | undefined = call.parent
  while (current) {
    if (isFunctionBoundary(current)) return false
    if (ts.isIfStatement(current)) {
      const inElse = current.elseStatement ? isDescendant(call, current.elseStatement) : false
      const inThen = isDescendant(call, current.thenStatement)
      if (inThen && !inElse && conjuncts(current.expression).some((c) => isBareIdentifier(c, 'visible'))) {
        return true
      }
    }
    current = current.parent
  }
  return false
}

describe('创建页只在可见时预热终端（否则每个泊车 workspace 都会抢那唯一的热终端槽）', () => {
  it('整个文件里 prewarmTerminal 的调用点恰好只有一处', () => {
    // 数出口，不数字面量。多一处（无条件预热）或少一处（删空 effect）都在这里红。
    const calls = prewarmCalls(parse(SOURCE))
    expect(calls, `实测调用点：${calls.length} 处，应为 1 处`).toHaveLength(1)
  })

  it('那一处调用以 `visible` 为必要条件（落在 if (… && visible) 的 then 分支里）', () => {
    const [call] = prewarmCalls(parse(SOURCE))
    expect(call, '找不到 prewarmTerminal 调用——上一条会先红').toBeDefined()
    expect(callGuardedByVisible(call!)).toBe(true)
  })

  it('那一处调用之前，effect 体里没有任何提前离开的出口（否则整条 effect 是 no-op）', () => {
    const [call] = prewarmCalls(parse(SOURCE))
    expect(call, '找不到 prewarmTerminal 调用——第一条会先红').toBeDefined()
    const exits = earlyExitsBefore(call!).map((node) => node.getText().trim())
    expect(exits, `调用之前有提前离开的出口：${exits.join(' / ')}`).toEqual([])
  })

  // ---- 下面是「守卫的守卫」：证明上面两条判据对每种变异各自独立变红，且不是恒真的。 ----
  //
  // 这些自检**不**改真文件读来的 SOURCE，而是变异一段硬编码的干净 fixture。理由：真文件被人
  // 施加变异做验收时（本任务要求逐个施加 M1–M4），若自检也 `SOURCE.replace()`，那个 replace 会
  // 因为「要替换的原串已经不在了」而 no-op，于是自检自己红成一片噪音，盖过「哪条**真判据**红了」
  // 这个才是要看的信号。fixture 与真 effect 同形，所以它照样证明分析器认得每种形状。

  /** 与真 effect 同形的干净样本：单一调用，落在 `workspace && visible` 的 then 分支里。 */
  const CLEAN = [
    'const C = () => {',
    '  useEffect(() => {',
    '    if (workspace && visible) prewarmTerminal(workspace.id)',
    '  }, [prewarmTerminal, visible, workspace?.id])',
    '}'
  ].join('\n')

  it('干净 fixture 上两条判据都成立（否则自检自身恒假）', () => {
    const calls = prewarmCalls(parse(CLEAN))
    expect(calls).toHaveLength(1)
    expect(callGuardedByVisible(calls[0]!)).toBe(true)
    expect(earlyExitsBefore(calls[0]!)).toEqual([])
  })

  it('自检 M5：在 effect 第一行插一句无条件早退，出口判据翻红（另两条纹丝不动）', () => {
    // 这就是那个实测出来的洞的精确形状。用 `if (launcherId) return` 而不是裸 `return`：
    // launcherId 恒是非空串（warmLauncherId 返回 `group:…` 或 `region:…`），所以语义上等价于
    // 无条件早退，但**保留了 workspace 的收窄**——裸 return 会让 workspace.id 报 TS18048，
    // 于是给人一种「tsc 会拦住这种事」的错觉。真实的坏形状不报错。
    const mutated = CLEAN.replace(
      '    if (workspace && visible) prewarmTerminal(workspace.id)',
      '    if (launcherId) return\n    if (workspace && visible) prewarmTerminal(workspace.id)'
    )
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    const calls = prewarmCalls(parse(mutated))
    // 前提自检：另两条判据对这次变异**完全失明**——这正是为什么需要第三条。
    expect(calls).toHaveLength(1)
    expect(callGuardedByVisible(calls[0]!)).toBe(true)
    // 只有出口那条认得出来。
    expect(earlyExitsBefore(calls[0]!)).toHaveLength(1)
  })

  it('自检 M6：throw 也算出口（把早退写成抛异常同样让预热不发生）', () => {
    const mutated = CLEAN.replace(
      '    if (workspace && visible) prewarmTerminal(workspace.id)',
      '    if (launcherId) throw new Error("nope")\n    if (workspace && visible) prewarmTerminal(workspace.id)'
    )
    expect(mutated).not.toBe(CLEAN)
    expect(earlyExitsBefore(prewarmCalls(parse(mutated))[0]!)).toHaveLength(1)
  })

  it('出口分析器本身可被直接质询：调用之后的 return 与嵌套函数里的 return 都不算', () => {
    const exitsBefore = (body: string): number => {
      const src = `const C = () => { useEffect(() => {\n${body}\n}, []) }`
      const [call] = prewarmCalls(parse(src))
      return earlyExitsBefore(call!).length
    }
    // cleanup 那个 `return () => …` 排在调用**之后**，不是这次调用的出口——否则每个带 cleanup 的
    // effect 都会被误判，这条判据就得靠例外清单活着。
    expect(exitsBefore('  prewarmTerminal(x)\n  return () => stop()')).toBe(0)
    // 嵌套回调里的 return 属于那个回调，不影响外层能不能走到调用。
    expect(exitsBefore('  const f = () => { return 1 }\n  prewarmTerminal(x)')).toBe(0)
    // 真正的早退：调用之前、同一个 effect 体内。
    expect(exitsBefore('  if (a) return\n  prewarmTerminal(x)')).toBe(1)
    expect(exitsBefore('  return\n  prewarmTerminal(x)')).toBe(1)
    expect(exitsBefore('  if (a) throw new Error("x")\n  prewarmTerminal(x)')).toBe(1)
    // 两个出口都数出来，报错信息里能看到全部（而不是只报第一个让人以为只有一处）。
    expect(exitsBefore('  if (a) return\n  if (b) return\n  prewarmTerminal(x)')).toBe(2)
  })

  it('自检 M1：把守护改成 !visible，极性判据翻红（计数不变）', () => {
    const mutated = CLEAN.replace('workspace && visible', 'workspace && !visible')
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    const calls = prewarmCalls(parse(mutated))
    // 调用点仍是一处（M1 不加不减），所以计数那条不会红——只有极性那条能认出这次变异。
    expect(calls).toHaveLength(1)
    expect(callGuardedByVisible(calls[0]!)).toBe(false)
  })

  it('自检 M2：在原行上面加一行无条件预热，计数判据翻红', () => {
    const mutated = CLEAN.replace(
      '    if (workspace && visible) prewarmTerminal(workspace.id)',
      '    if (workspace) prewarmTerminal(workspace.id)\n    if (workspace && visible) prewarmTerminal(workspace.id)'
    )
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    // 原字面量原封不动地留着——这正是文本断言绕不过去的地方；AST 数出口能看见两处。
    expect(prewarmCalls(parse(mutated))).toHaveLength(2)
  })

  it('自检 M3：把 effect 体删空，计数判据翻红', () => {
    const mutated = CLEAN.replace('    if (workspace && visible) prewarmTerminal(workspace.id)\n', '')
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    expect(prewarmCalls(parse(mutated))).toHaveLength(0)
  })

  it('自检 M4：把那行代码移进注释，判据不被骗（AST 里注释不产生调用节点）', () => {
    const mutated = CLEAN.replace(
      '    if (workspace && visible) prewarmTerminal(workspace.id)',
      '    // if (workspace && visible) prewarmTerminal(workspace.id)'
    )
    expect(mutated, '注入必须真的改动了 fixture').not.toBe(CLEAN)
    // 若判据靠「文件里出现过这行字符串」恒真，这里会被骗成绿；靠 AST 则调用点变 0 处。
    expect(prewarmCalls(parse(mutated))).toHaveLength(0)
  })

  it('极性分析器本身可被直接质询：裸 visible 合取项通过，取反/缺席/在 else 里都不通过', () => {
    const guarded = (cond: string): boolean => {
      const src = `const C = () => { useEffect(() => { if (${cond}) prewarmTerminal(x) }, []) }`
      const [call] = prewarmCalls(parse(src))
      return callGuardedByVisible(call!)
    }
    expect(guarded('workspace && visible')).toBe(true)
    expect(guarded('visible && workspace')).toBe(true) // 顺序无关
    expect(guarded('(workspace && visible)')).toBe(true) // 去括号
    expect(guarded('workspace && !visible')).toBe(false) // 取反
    expect(guarded('workspace')).toBe(false) // 根本没有 visible
    expect(guarded('workspace || visible')).toBe(false) // visible 不是必要条件（OR）
    expect(guarded('visible === false')).toBe(false) // 不是裸标识符

    // 调用落在 if(visible) 的 else 分支里：不可见时才跑，极性相反，不算被守住。
    const inElse = 'const C = () => { if (visible) {} else { prewarmTerminal(x) } }'
    const [elseCall] = prewarmCalls(parse(inElse))
    expect(callGuardedByVisible(elseCall!)).toBe(false)

    // 完全没有 if 包裹（无条件调用）：向上撞到函数边界前找不到守护，返回 false。
    const bare = 'const C = () => { useEffect(() => { prewarmTerminal(x) }, []) }'
    const [bareCall] = prewarmCalls(parse(bare))
    expect(callGuardedByVisible(bareCall!)).toBe(false)
  })
})
