import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import ts from 'typescript'

/**
 * 「这条 effect / 事件处理器里的那句关键调用**跑得到吗**」的 AST 判据。
 *
 * 为什么这个文件必须存在（本仓反复记录的同族洞）：desktop 包**没有任何 DOM 测试环境**
 * （vitest.config 里 `environment:` 零命中，无 jsdom / happy-dom），渲染只有 `renderToStaticMarkup`，
 * 它**不跑 useEffect**，也不派发事件。所以「组件挂载后 effect 到底有没有做那件事」这类不变量
 * 没法用行为测试守——只能守形状。而守形状的旧写法是文本断言（`readFileSync` + `toContain`）：
 *
 *     expect(source).toContain('prewarmTerminal(workspace.id)')
 *
 * 这条断言**不执行代码**。于是在 effect 第一行插一句 `return`（或 `if (someNonEmptyString) return`），
 * 整条 effect 塌成 no-op，而被 `toContain` 的那行字面量原封不动地留在下面——断言照旧命中，套件全绿。
 * 「字面量在场」与「那句调用可达」是两件事：本仓记过「grep 守卫看不见早退」「数符号名守不住别的拼法」
 * 「抽进 lib 只解决一半」。
 *
 * 判据因此改成**可达性**而不是**在场**：解析 AST，找到那句关键调用，检查在它之前、同一个函数体内
 * 有没有任何提前离开控制流的语句（`return` / `throw`）。有，就说明存在一条让这句调用跑不到的路径。
 *
 * ─── 这条判据**只**保证什么，**不**保证什么（docstring 不许承诺断言不做的事，这本身是本仓的一族缺陷）───
 *
 *   保证（真会红的变异）：
 *     - 在目标调用之前插入**任何** `return` / `throw`，无论它裸着还是包在 `if (…)` 里——包括
 *       `if (someNonEmptyString) return` 这种「语法上有条件、语义上恒真」的早退。`assertReachable` 要求
 *       目标之前**一个出口都没有**；`assertEarlyExitGuards` 要求目标之前的早退守护**恰好等于**声明的白名单
 *       （给本来就有合法 guard clause 的 effect 用）。两者都会因「另插一句早退」而红，后者还会因「删掉一句
 *       本应在场的合法守护」而红。这正是「数出口 + 判极性」那种守卫的盲点（它只认 `if (!cond) return`，
 *       认不出 `if (nonEmpty) return`，也不管合法守护被换成了别的单出口早退）。
 *
 *   **不**保证（这条判据看不见的事，调用方别指望它兜）：
 *     - 它是**词法保守**判据，不是完整控制流分析。它对「目标之前有没有早退」只按源码位置与词法结构判，
 *       不做条件可满足性推理。副作用是它会把**合法的** guard-clause（真有意义的提前返回）也判成危害——
 *       这对「正确形状就是『守护 if + 那句调用，之前什么都没有』」的 effect 恰好是想要的：真要加守护，
 *       写进那个 `if` 的条件里，而不是在它上面另开一个出口。用在别处前先确认这个形状假设成立。
 *     - 它只认 `return` / `throw` 这两种提前离开。把整个体包进 `if (false) { … }`、或用其他方式让调用
 *       不可达，它看不见。
 *     - 它证明的是「**若** effect 体被执行，这句调用可达」。它**证明不了** effect 本身会被挂载、会以正确
 *       依赖重跑、事件会被派发——那要真正的 DOM 测试环境，本仓目前没有。别把这条判据当成行为测试。
 *     - 「之前」按源码位置算（`node.end <= target.getStart()`）。目标调用**之后**的 `return`（例如 effect
 *       结尾那句 `return () => cleanup()`）不算，嵌套函数（回调 / cleanup）里的 `return` 归那个函数、也不算。
 */

/**
 * 从若干候选调用里挑出「参数文本归一化后**包含** `argSubstring`」的那一个，并断言恰好命中一个。
 *
 * 用于关键调用的被调用名在文件里不唯一、但那次特定调用可由实参区分的情形（例如 FileExplorer 里
 * `createSingleFileExplorerSelection(...)` 出现多处，只有 reveal effect 那次传的是 `revealRequest.path`）。
 * `label` 进报错信息。
 */
export function pickCallByArgument(
  calls: ts.CallExpression[],
  argSubstring: string,
  label: string
): ts.CallExpression {
  const needle = normalizeWhitespace(argSubstring)
  const matches = calls.filter((call) =>
    call.arguments.some((arg) => normalizeWhitespace(arg.getText()).includes(needle))
  )
  expect(
    matches,
    `${label}：应恰有 1 处调用的实参含 “${argSubstring}”，实测 ${matches.length} 处`
  ).toHaveLength(1)
  return matches[0]!
}

/** 建带 parent 指针的 SourceFile（可达性分析要向上遍历，所以 setParentNodes 必须为 true）。 */
export function parseTsx(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
}

/** 读一个源文件并解析。`fileName` 只用于 AST 里的显示名，可从路径末段派生。 */
export function readAndParse(sourcePath: string): { source: string; sourceFile: ts.SourceFile } {
  const source = readFileSync(sourcePath, 'utf8')
  const fileName = sourcePath.split('/').pop() ?? 'source.tsx'
  return { source, sourceFile: parseTsx(fileName, source) }
}

/**
 * 文件里所有「标识符 `name` 被直接调用」的调用表达式。
 *
 * 只认这一形状：`name(...)`。声明名、属性访问名（`state.name`）都不是「被调用的标识符」，不会命中——
 * 比如 `const prewarmTerminal = useAppStore((s) => s.prewarmTerminal)` 里的两处都不算。
 */
export function findCallsToIdentifier(sourceFile: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

/**
 * 文件里所有「对名为 `property` 的成员发起的调用」，含可选链。
 *
 * 认这两种形状：`x.property(...)` 与 `x?.property(...)`（例如 `promptRef.current?.focus()` 里的 `focus`）。
 * 用于关键调用不是裸标识符、而是方法调用的 effect。
 */
export function findCallsToMember(sourceFile: ts.SourceFile, property: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const nameOf = (expr: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text
    if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
      return expr.argumentExpression.text
    }
    return undefined
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && nameOf(node.expression) === property) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
}

/**
 * 包着这个节点的**全部**具名绑定，从外到内用 `' > '` 连接——即「这句调用长在谁身上」的限定路径。
 *
 * 为什么需要它：判「某个壳有没有把动作转发给出口」时，最容易写的判据是「文件里出现过
 * `sink(` 这个形状」。那条判据在**同一个文件里这个形状只出现一次**时才等价于「那个壳转发了」；
 * 一旦出现两次以上，删掉其中任意一处、留下另一处，判据照旧命中（本仓记过
 * 「presence-assertion-blind-when-shape-repeats」，先例 #586）。实测本仓 `copyTextToClipboard(`
 * 在 TerminalView.tsx 里有 3 处、WorkspaceWorkbench.tsx 里有 2 处，于是这两个文件的转发
 * 各自都不可观测。收法是把「文件里有没有」换成「**哪几个**具名位置上有」，逐位置比对。
 *
 * 认这四种命名来路（都在本仓真实出现过，取值由探针实测）：
 *   - `function f() {}` / 类方法 `f() {}`     → `f`
 *   - `const f = () => {}`（含 `function` 表达式）→ `f`（React 组件与 handler 的常见写法）
 *   - 对象字面量属性 `{ f: () => {} }`         → `f`（注入依赖端口的常见写法，如 `writeClipboard`）
 *   - JSX 属性上的内联箭头 `onX={() => {}}`    → `jsx:onX`（带前缀，免得与同名 handler 混淆）
 *
 * ─── 为什么是**路径**而不是「最近的那一个名字」（#619）───
 *
 * 这个函数的第一版只返回最近的一个名字，而且它宣称的第四种来路是**死代码**：内联 JSX 属性箭头的
 * **直接父节点是 `JsxExpression`**（那对花括号），`JsxAttribute` 在它的祖父位置，所以
 * `ts.isJsxAttribute(current.parent)` 恒假。实测：renderer 树里这种箭头有 342 个，该分支命中
 * **0 次**——docstring 亲口承诺了一种它从来认不出的写法（本仓「comment-promises-more-than-assertion」
 * 那一族，而这次比注释更糟：`d272316` 的 commit message 也照抄了这个假声明）。
 * 后果是真的：`SurfaceToolDock` 里 `onCopyPath={() => void copyTextToClipboard(...)}` 被记成
 * 外层组件名 `WorkspaceTopicsPanel`，于是把这次复制搬到同组件的 `onReveal`（它紧挨着，形状一样）
 * 照旧全绿——而那正是用户点「复制路径」会走的唯一一条路。
 *
 * 只穿透 `JsxExpression`、仍然「返回最近一个名字」是不够的：那样 `WorkspaceWorkbench` 的两处
 * 会双双坍缩成同一个 `jsx:writeClipboardText`（它们今天靠外层组件名 `SortableWorkbenchTab` /
 * `WorkbenchRegionLeaf` 区分），判据在那个文件反而**变弱**。返回限定路径两边都保住：实测
 * `SurfaceToolDock` 得到 `WorkspaceTopicsPanel > jsx:onCopyPath`（多了 handler 粒度），
 * `WorkspaceWorkbench` 得到两条各带外层组件名的不同路径（不坍缩）。
 *
 * 都不匹配时返回 `'(top-level)'`（模块顶层语句）。这是**词法**判据：它取的是绑定的名字，
 * 不做符号解析，所以**同名的两个局部绑定它区分不了**——`TerminalView` 那两个注入端口都叫
 * `writeClipboard`、都直接长在组件里，路径逐字相同，把复制在这两者之间对调不会红。需要区分时
 * 改用带实参的 `pickCallByArgument`，或在调用方额外钉住次数。
 */
export function enclosingBindingPath(node: ts.Node): string {
  const parts: string[] = []
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) parts.push(current.name.text)
    else if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) parts.push(current.name.text)
    else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      // 内联 JSX 属性箭头的直接父节点是 `JsxExpression`（那对花括号），要先穿透它才看得见
      // `JsxAttribute`。少了这一跳，`jsx:` 那条分支永远不可达——见上面 #619。
      const parent = ts.isJsxExpression(current.parent) ? current.parent.parent : current.parent
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) parts.push(parent.name.text)
      else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) parts.push(parent.name.text)
      else if (ts.isJsxAttribute(parent) && ts.isIdentifier(parent.name)) parts.push(`jsx:${parent.name.text}`)
    }
    current = current.parent
  }
  return parts.length === 0 ? '(top-level)' : parts.reverse().join(' > ')
}

/** 这四种是「函数边界」：向上找 enclosing body、向上找守护 if 时撞到它们就停。 */
export function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  )
}

/** `node` 是否在 `container` 的子树内（含自身）。依赖 parseTsx 建了 parent 指针。 */
export function isDescendant(node: ts.Node, container: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (current === container) return true
    current = current.parent
  }
  return false
}

/**
 * 包着这个节点的最内层函数体（block）。就是 effect / handler 的那个箭头函数体。
 *
 * 用来划定「在这个节点之前」的搜索范围。节点不在任何函数体内、或最内层函数是表达式体箭头
 * （`() => expr`，没有 block）时返回 undefined。
 */
export function enclosingFunctionBody(node: ts.Node): ts.Block | undefined {
  let current: ts.Node | undefined = node.parent
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
 * 在 `target` **之前**、同一个函数体里提前离开控制流的语句（`return` / `throw`）。
 *
 * 返回全部（不是只返回第一个），这样报错信息能列出所有出口而不是让人以为只有一处。嵌套函数
 * （回调、cleanup、setTimeout 的箭头等）里的 `return` 属于**那个**函数，整棵子树跳过。`target` 之后的
 * `return`（cleanup 那句 `return () => …`）位置在后，不会落进来。
 */
export function earlyExitsBefore(target: ts.Node): ts.Node[] {
  const body = enclosingFunctionBody(target)
  if (!body) return []
  const exits: ts.Node[] = []
  const targetStart = target.getStart()
  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionBoundary(node)) return
    if ((ts.isReturnStatement(node) || ts.isThrowStatement(node)) && node.end <= targetStart) {
      exits.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return exits
}

/** 把多行/含缩进的源码片段压成单空格分隔，方便与期望字符串逐字比对。 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 在 `target` 之前的每一个早退出口，控制它的那个条件（归一化后的源码文本）。
 *
 * 对每个 `return` / `throw`，从它向上找到**同一个** effect / handler 体内、把它放进 then 分支的最内层
 * `if`，取那个 `if` 的条件文本；找不到（裸 `return`、或落在普通 block 里而非任何 `if` 的 then 分支）
 * 记作 `'<unconditional>'`。落在某个 `if` 的 else 分支里也记 `'<unconditional>'`（else 不是「进入即离开」
 * 的守护，它按位置仍是一次早退，但它的极性不由那个条件担保）。
 *
 * 用途：让「合法的守护子句」与「被注入的早退」可区分——把它们各自的**条件**列出来逐字比对，而不是
 * 只数「有没有早退」。这样既能容忍一条 effect 本来就该有的那句 guard clause，又能抓住在它之上/之下另
 * 插的一句 `if (someNonEmptyString) return`（新条件不在期望清单里）。
 */
export function earlyExitConditionsBefore(target: ts.Node): string[] {
  const body = enclosingFunctionBody(target)
  if (!body) return []
  return earlyExitsBefore(target).map((exit) => {
    let current: ts.Node | undefined = exit.parent
    while (current && current !== body) {
      if (isFunctionBoundary(current)) break
      if (ts.isIfStatement(current)) {
        const inThen = isDescendant(exit, current.thenStatement)
        const inElse = current.elseStatement ? isDescendant(exit, current.elseStatement) : false
        if (inThen && !inElse) return normalizeWhitespace(current.expression.getText())
      }
      current = current.parent
    }
    return '<unconditional>'
  })
}

/**
 * 断言这句关键调用**可达**：它之前、同一个 effect / handler 体内没有任何 `return` / `throw`。
 *
 * 用于「正确形状里那句调用之前一个出口都不该有」的 effect（先例：prewarm——正确写法是体内只有那个
 * 守护 `if` + 调用，真要加守护写进 `if` 的条件里而不是另开出口）。带合法 guard clause 的 effect 用
 * `assertEarlyExitGuards` 传入允许清单，别用这个。
 *
 * `label` 会进报错信息，说明是哪个组件的哪条 effect，方便一眼定位。断言只保证 earlyExitsBefore 那一族，
 * 不保证本文件顶部 docstring 列出的「不保证」项——尤其不保证 effect 会被挂载或事件会被派发。
 */
export function assertReachable(target: ts.Node, label: string): void {
  assertEarlyExitGuards(target, [], label)
}

/**
 * 断言这句关键调用之前的早退守护**恰好**是 `expectedConditions`（归一化、按出现顺序逐条比对）。
 *
 * 这是 `assertReachable` 的推广，给「正确形状里本来就有一两句合法 guard clause」的 effect 用：
 *   - `expectedConditions: []` 等价于 `assertReachable`——一个出口都不许有。
 *   - 非空清单是这条 effect **应有**的守护条件白名单。任何偏离都红：
 *       · 在白名单之外**另插**一句早退（本任务要抓的那次 no-op 变异，典型是 `if (someNonEmptyString) return`）
 *         → 实测条件列表多出一项，与白名单不等 → 红。
 *       · **删掉**一句本应在场的合法守护 → 列表少一项 → 红（顺带守住那句 guard 是承重的，不许静默删）。
 *
 * 为什么按「条件」而不是按「有几个出口」比：只数个数的话，把合法守护换成另一句同样单出口的早退（改极性、
 * 换判据）就不红。逐字比条件才既容忍合法的那句、又认得出被换掉或另加的那句。
 *
 * 局限（承本文件顶部 docstring）：它按**词法**比条件文本，不推理条件是否恒真、两条件是否等价。所以它
 * 证明的是「这条 effect 的早退守护集合与声明的一致」，不是「这些守护语义正确」。用它时，白名单里写的
 * 应当是从**当前正确源码**里读出的、有据可查（注释/行为语义）的合法守护。
 */
export function assertEarlyExitGuards(target: ts.Node, expectedConditions: string[], label: string): void {
  const actual = earlyExitConditionsBefore(target)
  const expected = expectedConditions.map(normalizeWhitespace)
  expect(
    actual,
    `${label}：关键调用之前的早退守护应恰好是 [${expected.join(' | ')}]，实测 [${actual.join(' | ')}]` +
      `（多出的是被注入的 no-op 早退，缺失的是被删掉的合法守护）`
  ).toEqual(expected)
}

/**
 * 一步到位：读文件、按被调用标识符名找到那**唯一**一句关键调用、断言它可达。
 *
 * 同时守「调用点恰好一处」：0 处（effect 被删空 / 那行被注释掉，AST 里就没有 CallExpression）与多处
 * （另加了一个无守护的调用）都在这里红。要断言的调用不是裸标识符时，用 `findCallsToMember` + `assertReachable`
 * 自己组合。返回找到的调用，方便调用方再叠加别的判据（极性、参数等）。
 */
export function assertSingleCallReachable(opts: {
  sourcePath: string
  calleeName: string
  label: string
}): ts.CallExpression {
  const { sourceFile } = readAndParse(opts.sourcePath)
  const calls = findCallsToIdentifier(sourceFile, opts.calleeName)
  expect(calls, `${opts.label}：${opts.calleeName}( 的调用点应恰为 1 处，实测 ${calls.length} 处`).toHaveLength(1)
  assertReachable(calls[0]!, opts.label)
  return calls[0]!
}
