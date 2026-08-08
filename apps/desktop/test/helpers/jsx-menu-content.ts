import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * 「Radix 菜单的那段 JSX 里，某一项是不是可以被静默取反掉」的词法判据。
 *
 * 为什么这族判据只能守形状：Radix 的 `<X.Content>` 默认关闭且住在 Portal 里，
 * `renderToStaticMarkup` 渲不出它，而 desktop 包没有任何 DOM 测试环境（无 jsdom / happy-dom），
 * 「真挂载点一下」这条路在本仓走不通。于是菜单项的**在场**只能由源码结构来守。
 *
 * 为什么必须走词法器而不是切字符串：本仓两次踩同一个坑。
 * 1. 按标点猜条件（`/\?(?![.?])/`）会把 `a ?? b` 的第二个 `?` 当成三元门，也会误报字符串、
 *    模板字面量、类型标注里的 `?`；放松到躲开这些，`{cond ? … : null}` 就漏了。
 * 2. 按 `indexOf('<X.Content')` / `indexOf('</X.Content>')` 切左右界，只要中间出现一个同名的
 *    嵌套结构或者标签换了写法，截出来的那段就是错的，而「截错了」与「没违规」在结果上同形。
 * 记忆：lexical-boundaries-need-a-real-lexer。
 *
 * 这里出的判据回答的**不是同一个问题**，调用方别混用：
 *
 * - `inlineConditions`：这段 JSX 里**有没有任何**内联条件。适用于「这个 Content 本来就不该有
 *   条件」的容器——一旦有，整节就有被取反成永不渲染的余地。它刻意不把 `?.` / `??` 算作条件：
 *   在 map 回调里 `entry.action?.label ?? entry.label` 是合法取值，不是门。
 *
 * - `gatesAbove` + `callbackErasureGates`：**某一次具体调用**头上、以及它回调**内部**有没有门。
 *   适用于 Content 里本来就有合法条件的容器（比如某一项按可选回调在场与否决定画不画）——那种容器
 *   用 `inlineConditions` 会把诚实的代码判红，而一道会打假红的守卫最终会被删掉，等于没有。
 *
 *   这两条早先合成一个 `gatesAbove`，用「祖先里出现三元 / `&&` / `||` / `??` / `if` / 函数边界就算门」
 *   这种**黑名单**来判。一次独立审计证明黑名单必漏（本仓反复踩到的老坑）：`{void list.map(…)}`、
 *   `{!list.map(…)}`、`{(list.map(…), null)}` 三种把整组抹掉的写法都不在名单上，14 条断言全绿；
 *   回调**内部**的 `if (true) return null` 更是祖先扫描根本够不着。所以判据翻了个面——
 *   `gatesAbove` 改成**白名单**：调用到 Content 之间只准出现「把表达式塞进 JSX」的那几层无害包装
 *   （见 `ALLOWED_ABOVE_MAP_CALL`），别的一律算门，不必再去猜有哪些坏拼法；`callbackErasureGates`
 *   单独判回调体，把「按数据跳过某些项」（合法）与「无条件 / 按渲染层开关抹掉整组」（门）分开。
 */

const COMPONENTS = new URL('../../src/renderer/src/components/', import.meta.url)

export interface JsxContent {
  readonly node: ts.JsxElement
  readonly source: ts.SourceFile
}

/** `<X.Content>` 那个 JSX 元素本身。边界由词法器给，不靠猜左右界。 */
export function jsxContentElementIn(text: string, fileName: string, tag: string): JsxContent | null {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: ts.JsxElement | null = null
  const walk = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === `${tag}.Content`) {
      found = node
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found ? { node: found, source } : null
}

/** 同上，但直接读 `src/renderer/src/components/<file>`。找不到就抛——静默返回空会让整族判据恒绿。 */
export function jsxContentElement(file: string, tag: string): JsxContent {
  const text = readFileSync(new URL(file, COMPONENTS), 'utf8')
  const found = jsxContentElementIn(text, file, tag)
  if (!found) throw new Error(`${file} 里找不到 <${tag}.Content> ——组件换了容器或改了名`)
  return found
}

/** 那段 JSX 的源文本，注释已剥掉（注释里描述规则的文字不是规则本身）。 */
export function contentSourceText({ node, source }: JsxContent): string {
  return node
    .getText(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 这段 JSX 的子节点里所有**内联条件**：三元与 `&&`。
 *
 * map 回调里的 `if (entry.kind === …) return …` 不算：那是按数据分支，每一项都到得了。被挡的是
 * 「整节要不要出现」这种只有渲染层知道的判断。
 */
export function inlineConditions({ node, source }: JsxContent): string[] {
  const out: string[] = []
  const walk = (child: ts.Node): void => {
    if (ts.isConditionalExpression(child)) out.push(child.getText(source))
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      out.push(child.getText(source))
    }
    ts.forEachChild(child, walk)
  }
  for (const child of node.children) walk(child)
  return out
}

/** `<receiver>.<method>(…)` 这些调用点。receiver 逐字比对，`a.b.slice(0,0).map(` 不算 `a.b.map(`。 */
export function memberCallsIn(
  { node, source }: JsxContent,
  receiver: string,
  method: string
): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const walk = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.name.text === method &&
      child.expression.expression.getText(source) === receiver
    ) {
      out.push(child)
    }
    ts.forEachChild(child, walk)
  }
  walk(node)
  return out
}

/**
 * 这次调用与它所在的 `{…}` 之间，允许出现的祖先节点种类。
 *
 * 之所以只有这四种：从 `list.map(…)` 这个调用往上走到 Content，一路上**唯一**无害的东西就是
 * 「把表达式塞进 JSX」的那几层包装——`{…}` 本身（JsxExpression）、把它裹进另一层元素或 Fragment
 * （`<Frag>{…}</Frag>` / `<>{…}</>`），以及一对纯分组括号（`{(list.map(…))}`，语义透明）。
 * 除此之外，凡是能出现在这条链上的节点都能改写渲染结果：
 *
 *   - `VoidExpression`      `{void list.map(…)}`            → 求值成 undefined，React 渲染成空
 *   - `PrefixUnaryExpression` `{!list.map(…)}`              → 数组取反成 false，同样是空
 *   - `BinaryExpression`    `{false && …}` / `{… && false}` / `{true || …}` / `{x ?? …}` / `{(…, null)}`
 *   - `ConditionalExpression` `{ok ? … : null}`
 *   - `CallExpression` / `ArrowFunction` / `Block` / `ReturnStatement`
 *                            `{(() => { if (x) return null; return list.map(…) })()}`
 *   - `PropertyAccessExpression` `{list.map(…).filter(…)}` → 在渲染层再筛一遍，能悄悄丢项
 *
 * 空数组表示这次调用无条件发生、且它的数组结果**直接**就是画出来的东西。
 */
const ALLOWED_ABOVE_MAP_CALL = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.JsxExpression,
  ts.SyntaxKind.JsxElement,
  ts.SyntaxKind.JsxFragment,
  ts.SyntaxKind.ParenthesizedExpression
])

export function gatesAbove(call: ts.Node, { node: root, source }: JsxContent): string[] {
  const out: string[] = []
  for (let cursor = call.parent; cursor && cursor !== root; cursor = cursor.parent) {
    if (!ALLOWED_ABOVE_MAP_CALL.has(cursor.kind)) out.push(cursor.getText(source))
  }
  return out
}

/** `undefined` / `null` / `false` / 裸 `return`——React 把它们都渲染成什么都没有的那几种值。 */
function erasesToNothing(expr: ts.Expression | undefined): boolean {
  let node = expr
  while (node && ts.isParenthesizedExpression(node)) node = node.expression
  if (!node) return true // 裸 `return;`
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  )
}

/** 一个（可能解构的）形参声明里绑定到的所有标识符名。 */
function bindingNames(param: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(param)) into.add(param.text)
  else if (ts.isObjectBindingPattern(param) || ts.isArrayBindingPattern(param)) {
    for (const el of param.elements) if (ts.isBindingElement(el)) bindingNames(el.name, into)
  }
}

/** `node` 子树里是否引用了 `names` 中的任一名字。判「这个条件跟不跟着当前项走」用的就是它。 */
function referencesAny(node: ts.Node, names: ReadonlySet<string>): boolean {
  let hit = false
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && names.has(n.text)) hit = true
    ts.forEachChild(n, walk)
  }
  walk(node)
  return hit
}

/**
 * map 回调**内部**那些会把整组抹掉的抹除点。返回它们的源文本；空数组表示回调只会按数据画东西。
 *
 * 为什么单开这一条、而不并进 `gatesAbove`：`gatesAbove` 看的是调用**头上**的祖先，而这里的洞在
 * 调用**底下**——回调是 `map(…)` 的实参，住在调用节点之下，祖先扫描永远够不着它。本仓实测过
 * `{copyModel.entries.map((entry) => { if (true) return null; … })}`：那次 map 照常执行、`entry.action.id`
 * 等字面量原样在场，14 条断言全绿，而每一项都渲染成 null——整组复制/地址从菜单上彻底消失。回调
 * 恰恰是「有人自然会往里加逐项逻辑」的地方，所以这是最真实的一种绕法。
 *
 * 判据：只盯**会抹除的**返回（`return null/false/undefined` 或裸 `return`；箭头函数的简写体
 * `(e) => null` / `(e) => cond ? null : <I/>` 同理）。抹除返回分三档：
 *   - 无条件抹除（回调里没有任何 `if` 包着它）→ 每一项都成空，整组消失 → 算门。
 *   - 抹除挂在 `if` 上，但**并非每一层** `if` 的条件都引用了当前项 → 那是渲染层的开关（`if (true)`、
 *     `if (someOuterFlag)`），不是按数据分支 → 算门。
 *   - 抹除挂在 `if` 上，且**每一层** `if` 都引用了当前项（`if (entry.kind === 'separator')`）→ 按数据
 *     跳过某些项，每一项自己决定，合法 → 不算门。
 *
 * 只返回 JSX 的返回（`return <Item/>`）从不算门：那是正常渲染，不是抹除。回调里 `entry.visible && …`
 * 这类**返回出去的 JSX 内部**的条件也不算：它决定的是某一项长什么样，不是「这一项在不在」。
 *
 * 已知的残留盲区（诚实标注）：本判据用「条件引用了当前项的绑定」来近似「条件由当前项决定」。于是
 * `if (entry || true) return null` 会被放过——它引用了 `entry` 却恒真，实为整组门。要抓它得做常量
 * 折叠 / 数据流分析，超出词法判据的范围，故不在此守。真正要防的那对（`if (entry.kind === …)` 放行、
 * `if (true)` 拦下）已被干净地分开。
 *
 * 嵌套函数（比如某一项 `onSelect={() => { return null }}`）里的 `return` 不算：那不是这一项的渲染
 * 结果，扫描到它就停，不往里走。
 */
export function callbackErasureGates(call: ts.CallExpression, { source }: JsxContent): string[] {
  const callback = call.arguments.find(
    (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
      ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
  )
  if (!callback) return []
  const params = new Set<string>()
  for (const p of callback.parameters) bindingNames(p.name, params)
  const out: string[] = []

  if (ts.isBlock(callback.body)) {
    const walk = (node: ts.Node): void => {
      // 嵌套函数的返回属于那个函数，不是当前项的渲染结果——不下钻。
      if (
        node !== callback &&
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))
      ) {
        return
      }
      if (ts.isReturnStatement(node) && erasesToNothing(node.expression)) {
        const guards: ts.Expression[] = []
        for (let c = node.parent; c && c !== callback; c = c.parent) {
          if (ts.isIfStatement(c)) guards.push(c.expression)
        }
        if (guards.length === 0) out.push(node.getText(source))
        else if (!guards.every((cond) => referencesAny(cond, params))) out.push(node.getText(source))
      }
      ts.forEachChild(node, walk)
    }
    walk(callback.body)
  } else {
    // 简写体：`(e) => null` 无条件抹除；`(e) => cond ? null : <I/>` 里 cond 不引用当前项则是渲染层门。
    let body: ts.Expression = callback.body
    while (ts.isParenthesizedExpression(body)) body = body.expression
    if (erasesToNothing(body)) out.push(body.getText(source))
    else if (ts.isConditionalExpression(body)) {
      const erasesABranch = erasesToNothing(body.whenTrue) || erasesToNothing(body.whenFalse)
      if (erasesABranch && !referencesAny(body.condition, params)) out.push(body.getText(source))
    }
  }
  return out
}
