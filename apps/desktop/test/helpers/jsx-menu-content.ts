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
 * 这里出两族判据，它们回答的**不是同一个问题**，调用方别混用：
 *
 * - `inlineConditions`：这段 JSX 里**有没有任何**内联条件。适用于「这个 Content 本来就不该有
 *   条件」的容器——一旦有，整节就有被取反成永不渲染的余地。它刻意不把 `?.` / `??` 算作条件：
 *   在 map 回调里 `entry.action?.label ?? entry.label` 是合法取值，不是门。
 *
 * - `gatesAbove`：**某一次具体调用**头上有没有门。适用于 Content 里本来就有合法条件的容器
 *   （比如某一项按可选回调在场与否决定画不画）——那种容器用 `inlineConditions` 会把诚实的代码
 *   判红，而一道会打假红的守卫最终会被删掉，等于没有。它反过来**要**把 `??` 算作门：
 *   `{x ?? list.map(…)}` 在 x 非空时就把整组换掉了。
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
 * 这次调用与 `root` 之间的每一道**门**：跑不跑得到它、跑到了画不画得出来，任一被别的表达式说了算，
 * 就是一道门。返回门的源文本；空数组表示这次调用无条件发生且它的结果就是画出来的东西。
 *
 * 为什么把「门」判得这么宽（凡是祖先上的条件一律算，不区分调用落在哪一侧）：窄判法有真实的绕法，
 * 因为 React 把 `false` / `null` / `undefined` 渲染成什么都没有。于是
 *
 *     {copyModel.entries.map(…) && false}
 *     {copyModel.entries.map(…) || null}   // 数组是真值，这条其实画得出来
 *     {true || copyModel.entries.map(…)}
 *     {somethingElse ?? copyModel.entries.map(…)}
 *
 * 里，第一、三、四条都能在「那次 map 照常执行、源码里那行字面量原样在场」的前提下把整组从界面上
 * 抹掉。只按「调用落在 `&&` 的右操作数 / 三元的某个臂里」来判，第一条与第三条会漏。宽判法的代价是
 * 它也拒绝那些今天无害的写法——而那正是这道守卫要的语气：这一项的在场只能由数据决定。
 *
 * `??` 在这里算门，在 `inlineConditions` 里不算：那边问的是「这段里有没有条件」，取值用的 `??`
 * 不是门；这边问的是「这次调用头上有没有东西能替掉它」，而 `x ?? list.map(…)` 恰好能。
 *
 * 函数边界也算门：把整段包进 `{(() => { if (x) return null; return list.map(…) })()}` 同样能让它
 * 消失，而那个 `if` 是语句不是表达式，只盯表达式会漏。
 */
export function gatesAbove(call: ts.Node, { node: root, source }: JsxContent): string[] {
  const GATE_OPERATORS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.QuestionQuestionToken
  ])
  const out: string[] = []
  for (let cursor = call.parent; cursor && cursor !== root; cursor = cursor.parent) {
    if (ts.isConditionalExpression(cursor)) out.push(cursor.getText(source))
    else if (ts.isBinaryExpression(cursor) && GATE_OPERATORS.has(cursor.operatorToken.kind)) {
      out.push(cursor.getText(source))
    } else if (ts.isIfStatement(cursor)) out.push(cursor.getText(source))
    else if (
      ts.isArrowFunction(cursor) ||
      ts.isFunctionExpression(cursor) ||
      ts.isFunctionDeclaration(cursor)
    ) {
      // 调用被包进了一层函数体。map 自己的回调是这次调用的**实参**（在它下面），不是祖先，
      // 所以这里命中的只会是外面新包的那层壳。
      out.push(cursor.getText(source))
    }
  }
  return out
}
