import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * 终端里每一条 link provider 都必须接到**同一个** activate 出口。
 *
 * 来由（实测 2026-09-01，用户报告）：xterm 有两条互不相干的 http link provider——
 *  - `WebLinksAddon`：认裸文本 URL，activate 由我们作为构造参数传入；
 *  - 内建的 `OscLinkProvider`：认 OSC 8 超链接（转义序列声明的链接，Claude Code 就这么输出），
 *    它的 activate 取自 **`terminal.options.linkHandler`**，我们不设就落到 xterm 自己的
 *    `defaultActivate`——一个原生 `confirm("…could potentially be dangerous")` 加 `window.open`。
 *
 * 我们只接了第一条。于是"点链接出目的地选择器"在开发中每次手验都通过（裸 URL 那条一直是好的），
 * 而用户点 Claude Code 输出的链接看到的是浏览器厂商的告警框。**界面上没有我们任何一个字符串**，
 * 所以源码 grep 和包内 grep 都搜不到异常；13 个并行排查 agent 也全部漏掉，因为他们追的都是已知那条。
 *
 * 所以这条守卫的判据是**出口个数**，不是"点击这个动作有没有被处理"：同一个概念有两个入口时，
 * 只接一个不会让另一个变红。
 *
 * 判据用 AST 而不是文本：`toContain('activateHttpLink')` 这类字面量检查挡不住"新加一条 provider、
 * 给它写一个自己的内联 handler"——那种新增里根本不会出现共享出口的名字，检查照旧全绿
 * （本仓已有先例：`not.toContain('name(')` 被裸标识符绕过，16 条全绿）。这里改为求每个入口的
 * activate **实参解析到哪个标识符**，再要求它们全等。
 */

const SOURCE_PATH = new URL(
  '../src/renderer/src/components/TerminalView.tsx',
  import.meta.url
).pathname
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
}

/** 每个 http link 入口，以及它的 activate 解析到的标识符名（内联函数则为 null）。*/
type HttpEntry = { entry: string; activate: string | null }

/**
 * 找出所有 http link 入口的 activate 实参。
 *
 * 两个形状：
 *  - `new WebLinksAddon(<activate>, …)` —— 第一个实参就是 activate；
 *  - `terminal.options.linkHandler = { activate: … }` —— 对象字面量里的 activate 属性。
 *
 * 内联箭头函数返回 null（那正是要挡的形状之一：两条路各写一份逻辑），但箭头函数体里若只是
 * 转发给一个标识符（`(e, t) => shared(e, t)`）则算解析到那个标识符——这是合法的适配写法，
 * 因为两条 provider 的签名不同名但同形。
 */
function httpLinkEntries(source: string): HttpEntry[] {
  const sourceFile = parse(source)
  const found: HttpEntry[] = []

  const resolveActivate = (node: ts.Expression | undefined): string | null => {
    if (!node) return null
    if (ts.isIdentifier(node)) return node.text
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // 只转发的壳：函数体（或表达式体）恰好是一次对某标识符的调用。
      const body = node.body
      const call = ts.isBlock(body)
        ? body.statements.length === 1 && ts.isExpressionStatement(body.statements[0])
          ? body.statements[0].expression
          : undefined
        : body
      if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression)) return call.expression.text
      return null
    }
    return null
  }

  const visit = (node: ts.Node): void => {
    // new WebLinksAddon(activate, …)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'WebLinksAddon'
    ) {
      found.push({ entry: 'WebLinksAddon', activate: resolveActivate(node.arguments?.[0]) })
    }
    // terminal.options.linkHandler = { activate, … }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'linkHandler' &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      const activate = node.right.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'activate'
      )
      found.push({ entry: 'options.linkHandler', activate: resolveActivate(activate?.initializer) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

describe('every terminal link provider reaches the one destination exit', () => {
  it('wires both http link entry points — the bare-URL addon and the OSC 8 linkHandler', () => {
    const entries = httpLinkEntries(SOURCE)
    // 出口个数是判据：少一个入口就是那次事故的形状。
    expect(entries.map((item) => item.entry).sort()).toEqual(['WebLinksAddon', 'options.linkHandler'])
  })

  it('points both entry points at the same activate function, not two hand-copied ones', () => {
    const entries = httpLinkEntries(SOURCE)
    const names = entries.map((item) => item.activate)
    // 内联实现（null）也不接受：两条路各写一份必然在"什么算点击""快路按哪个键"上漂移。
    expect(names.every((name) => typeof name === 'string')).toBe(true)
    expect(new Set(names).size, `两条 provider 的 activate 必须同源，实测拿到 ${JSON.stringify(names)}`).toBe(1)
  })

  it('detects a provider wired to its own inline handler, so the checks above cannot go vacuously green', () => {
    // 自检一：把 linkHandler 的 activate 换成自己的内联实现（不转发共享出口）。判据若退化成
    // "文件里出现过共享函数名"，这段注入会静默通过——文件里那个名字始终在场。
    const mutated = SOURCE.replace(
      'activate: (event, text) => activateHttpLink(event, text),',
      'activate: (event, text) => { void openHttpLink(linkOriginRef.current, text, \'system\') },'
    )
    expect(mutated, '注入必须真的改动了源码').not.toBe(SOURCE)
    const names = httpLinkEntries(mutated).map((item) => item.activate)
    expect(names).toContain(null)
    expect(new Set(names).size).toBeGreaterThan(1)
  })

  it('detects the linkHandler entry point going missing entirely', () => {
    // 自检二：删掉整个 linkHandler 赋值——这**就是**用户遇到的那个缺陷的源码形状。
    const start = SOURCE.indexOf('    terminal.options.linkHandler = {')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = SOURCE.indexOf('\n    }\n', start)
    expect(end).toBeGreaterThan(start)
    const mutated = SOURCE.slice(0, start) + SOURCE.slice(end + '\n    }\n'.length)
    const entries = httpLinkEntries(mutated).map((item) => item.entry)
    expect(entries).not.toContain('options.linkHandler')
  })
})
