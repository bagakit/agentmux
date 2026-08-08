import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { enclosingBindingPath, enclosingFunctionBody, readAndParse } from './helpers/effect-reachability.js'

/**
 * 两条**不经过选区**的复制路的**接线侧**（#638 的出路）。
 *
 * 分工：取值与拼接由 `terminal-buffer-copy.test.ts` 用假 buffer 逐条变异钉死（折行不当换行、
 * viewportY 不当 baseY、行尾空白两种正确答案……）。那一侧全绿**并不意味着用户能用上**——它证明的是
 * 「若这三个函数被调用，它们算得对」。这个文件守的是另一半：菜单上真有这两个入口、点下去真的调到
 * 那三个函数、喂进去的真是这个终端的 buffer、算出来的文本真的进了剪贴板。
 *
 * 为什么这一半非守不可（不是形式主义）：本仓刚刚记过同形状的一次——`3867ef3` 的审计发现
 * `<ServiceWindowNotice>` 的整个挂载点可以删掉而 138 条 + tsc 全绿，因为守卫全停在 lib 边界上。
 * 这条复制路是**一模一样**的形状：纯函数在 lib、唯一的用户入口是两行 JSX。把那两行删掉，
 * lib 侧 14 条照旧全绿，`noUnusedLocals` 在 desktop 是关的（孤儿 import 不报），
 * 而用户右键菜单里那两项消失，回到 #638 的原点。
 *
 * 为什么是 AST 而不是渲染：菜单内容在 Radix 的 Portal 里，desktop 包也没有默认 DOM 环境，
 * `renderToStaticMarkup` 既不展开 Portal 也不派发点击（这条纪律在
 * `terminal-context-menu-selection-hint.test.tsx` 与 `terminal-mouse-tracking-sampling.test.ts` 都立过）。
 * 所以判据落在**取值关系**上，逐条问：值从哪来、被谁接住、送到哪去。
 *
 * ─── 这道门**不**保证什么（如实记，不夸大）───
 *
 *   - 它证明不了 Radix 真的会把 `onSelect` 接到点击上、React 真的会挂载这棵树——那要真 DOM 环境。
 *   - `if (!text) return`（空文本不写剪贴板）**没有**被守。它是对的（往剪贴板写空串会清掉用户
 *     剪贴板里原有的东西），但唯一能写的判据是「这个 if 在场」，而在场判据挡不住把条件取反。
 *     如实记为缺口，不拿一条弱判据充数。
 *   - 文案（"Copy visible output" / "Copy all output"）只钉「两项各自的文案互不相同且非空」，
 *     不钉具体字面量——措辞该能改，接线不该能断。
 */

const VIEW_PATH = fileURLToPath(
  new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url)
)
const MENU_PATH = fileURLToPath(
  new URL('../src/renderer/src/components/TerminalContextMenu.tsx', import.meta.url)
)
const { sourceFile: view } = readAndParse(VIEW_PATH)
const { sourceFile: menu } = readAndParse(MENU_PATH)

/** 某个源文件里所有 `name(...)` 形状的调用（裸标识符被调用；属性访问不算）。 */
function callsTo(file: ts.SourceFile, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return calls
}

/**
 * 在**这个函数体内**解析局部名字 `name` 的初始化式。
 *
 * 必须限定作用域，不能全文件找：`const terminal = terminalRef.current` 在 TerminalView.tsx 里有四处
 * （copySelection / copyViewport / copyScrollback / pasteClipboard）。全文件取「最后一个同名声明」
 * 会让这里的取值判据读到**另一个函数**的那一行——它今天恰好一样，于是判据看起来在工作，
 * 而实际上把 copyViewport 里那行改成 `const terminal = someOtherTerminal` 也不会红
 * （记忆 presence-assertion-blind-when-shape-repeats 的作用域版本）。
 *
 * 取文本用**无参**的 `getText()`（它走节点自己的 SourceFile），不写死 `getText(view)`：下面那条
 * 自证要拿一个探针 SourceFile 走同一条路径，而按 `view` 的文本去切探针节点的偏移量会读出一段
 * 完全无关的字符。这不是假设——初版就写死了 `view`，自证当场报出
 * `expected '-fit'\nimport { Searc' to be 'terminalRef.current'`，即从 TerminalView.tsx 的
 * import 区切下来的一段。判据抓到了自己的实现缺陷，这条注释记着它，别再写回去。
 */
function localInitializer(body: ts.Node, name: string): string | null {
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      found = node.initializer.getText()
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return found
}

/**
 * 把一个实参展开成「它最终读的是什么」：实参是局部名字就顺着它在同一函数体内的声明再读一层。
 *
 * 例：`terminalViewportText(terminal.buffer.active, terminal.rows)` 里的 `terminal.buffer.active`
 * 会被展开成 `terminalRef.current.buffer.active`，于是「读的是这个终端实例」可以被直接断言。
 *
 * 同上，取文本一律用无参 `getText()`——理由见 {@link localInitializer} 的注释。
 */
function resolvedArgument(call: ts.CallExpression, index: number): string {
  const argument = call.arguments[index]
  if (argument === undefined) return ''
  const text = argument.getText()
  const body = enclosingFunctionBody(call)
  if (body === undefined) return text
  // 取最左边那一段标识符（`terminal.buffer.active` → `terminal`），看它是不是本地绑定。
  const root = text.match(/^[A-Za-z_$][\w$]*/u)?.[0]
  if (root === undefined) return text
  const initializer = localInitializer(body, root)
  return initializer === null ? text : text.replace(root, initializer)
}

/** 某个源文件里被具名导入的名字集合（`import { a as b }` 记 `b`，即真正被解析到的那个名字）。 */
function importedNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined) {
      const bindings = node.importClause.namedBindings
      if (ts.isNamedImports(bindings)) for (const element of bindings.elements) names.add(element.name.text)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return names
}

/** `<Tag ...>` 上属性 `attribute` 挂的表达式文本；没有该属性或它不是表达式容器时 null。 */
function attributeExpression(
  file: ts.SourceFile,
  element: ts.JsxOpeningLikeElement,
  attribute: string
): string | null {
  for (const property of element.attributes.properties) {
    if (
      ts.isJsxAttribute(property) &&
      property.name.getText(file) === attribute &&
      property.initializer !== undefined &&
      ts.isJsxExpression(property.initializer) &&
      property.initializer.expression !== undefined
    ) {
      return property.initializer.expression.getText(file)
    }
  }
  return null
}

describe('取值：两个 lib 函数被真的调用，且喂的是这个终端的 buffer', () => {
  // 逐个函数问同一串问题。两条路今天形状几乎一样，但**不共用**一条断言：措辞近似的两条判据
  // 若折成一条，把 scrollback 那条接成 viewport 的实现（或反之）就无人发现
  // （记忆 near-identical-copy-defeats-distinct-classes）。
  const CASES = [
    { fn: 'terminalViewportText', holder: 'copyViewport', arity: 2 },
    { fn: 'terminalScrollbackText', holder: 'copyScrollback', arity: 1 }
  ] as const

  it('两个取值函数都是从 terminal-buffer-copy 导入的，不是同名本地函数', () => {
    // 判 import 关系而不是「文件里出现过这个名字」：在组件里另写一个同名函数返回 ''，
    // 下面每条调用点判据照旧全绿而用户复制到空串（记忆 guard-criterion-must-be-import-relation）。
    let imported: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.includes('terminal-buffer-copy') &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        imported = node.importClause.namedBindings.elements.map((element) => element.name.text)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(view, visit)
    for (const { fn } of CASES) {
      expect(imported, `${fn} 不是从 terminal-buffer-copy 导入的——调用点解析到的可能是别的实现`).toContain(fn)
    }
  })

  it('这两个导入名没有被组件体内的本地声明影子掉', () => {
    // 上一条只证「import 声明在场」。审计实测过这条绕法：在组件体里加一个同名局部绑定，import 照旧
    // 在场、调用点文本照旧是那个名字，但真正被调用的是局部那个（#596/#648 两次先例）。
    // 按「这个名字有没有在组件体内被重新绑定」判，不枚举拼法。
    let component: ts.FunctionDeclaration | undefined
    const findComponent = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'TerminalView') component = node
      ts.forEachChild(node, findComponent)
    }
    ts.forEachChild(view, findComponent)
    expect(component, '找不到 TerminalView 函数声明——这条判据的扫描对象缺席，会恒绿').not.toBeUndefined()

    const locals: string[] = []
    const collectBound = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        locals.push(name.text)
        return
      }
      for (const element of name.elements) if (ts.isBindingElement(element)) collectBound(element.name)
    }
    const collectLocals = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) collectBound(node.name)
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) locals.push(node.name.text)
      if (ts.isParameter(node)) collectBound(node.name)
      ts.forEachChild(node, collectLocals)
    }
    ts.forEachChild(component!, collectLocals)

    const shadowed = CASES.map(({ fn }) => fn).filter((fn) => locals.includes(fn))
    expect(
      shadowed,
      `这些导入名被组件体内的本地声明影子掉了：${shadowed.join(', ')}——调用到的不是 lib 的那个实现`
    ).toEqual([])
  })

  for (const { fn, holder, arity } of CASES) {
    describe(`${fn} 的调用点`, () => {
      const calls = callsTo(view, fn)

      it(`${fn} 的调用点恰为一处`, () => {
        // 在场自证 + 唯一性。0 处 = 取值被删（菜单项还在、点了什么都不发生）；多处 = 下面几条抽到的
        // 那一个不一定是菜单真正走的那个（记忆 presence-assertion-blind-when-shape-repeats）。
        expect(
          calls.map((call) => call.getText(view)),
          `${fn} 的调用点不是恰好一处——取值被删掉，或出现了第二个调用点`
        ).toHaveLength(1)
      })

      it(`它长在 ${holder} 里，不在别的 handler 上`, () => {
        // 把这次调用搬到另一个 handler（两条路的函数体今天几乎同形，搬过去编译照过），
        // 「复制可视区」就会复制整个回滚缓冲，反之亦然——两条菜单项做同一件事而计数判据全绿。
        expect(calls, '调用缺席，这条判据没有对象').toHaveLength(1)
        const path = enclosingBindingPath(calls[0]!)
        expect(path, `${fn} 不在 ${holder} 里（实测所在绑定：${path}）——两条复制路可能被接反了`).toBe(
          `TerminalView > ${holder}`
        )
      })

      it(`第一个实参读的是 terminalRef.current 的 buffer.active`, () => {
        // 本文件最承重的一条。换成一个假 buffer 字面量、换成 `buffer.normal`（另一块缓冲区，
        // alt-screen 下内容完全不同）、或换成别处同名字段，调用点在场、计数不变、lib 侧 14 条全绿，
        // 而用户复制到的是另一段东西。判**取值身份**，不判「有没有实参」。
        expect(calls, '调用缺席，这条判据没有对象').toHaveLength(1)
        const resolved = resolvedArgument(calls[0]!, 0)
        expect(resolved, `${fn} 没有第一个实参`).not.toBe('')
        expect(
          resolved,
          `${fn} 读的不是 xterm 的活动缓冲区（实测取值：${resolved}）——` +
            'buffer.normal / 假 buffer 都会让复制到的内容与屏幕对不上'
        ).toContain('buffer.active')
        expect(
          resolved,
          `${fn} 读的 buffer 不来自 terminalRef.current（实测取值：${resolved}）——可能读到了别的终端实例`
        ).toContain('terminalRef.current')
      })

      it(`实参个数正好是 ${arity} 个`, () => {
        // viewport 要两个（buffer + rows），scrollback 只要一个。多传一个不会编译错（TS 允许？不允许，
        // 但少传会）。这条真正防的是**混用**：把 scrollback 也传上 rows，说明有人把两条路当成同一件事，
        // 而它们的取值范围本就不同（一屏 vs 整个会话）。
        expect(calls, '调用缺席，这条判据没有对象').toHaveLength(1)
        expect(
          calls[0]!.arguments.length,
          `${fn} 的实参个数不是 ${arity}——两条复制路的取值范围可能被当成了同一件事`
        ).toBe(arity)
      })

      it(`${holder} 真的把算出来的文本送进了剪贴板`, () => {
        // 缺了这条，取值可以完全正确然后被丢掉：`const text = terminalViewportText(...)` 之后什么都不做，
        // 上面每一条都全绿而用户点了没反应。
        // 不能用「文件里出现过 copyTextToClipboard(」判——它在 TerminalView.tsx 里有 5 处，删掉这一处
        // 剩下 4 处照旧满足在场判据（记忆 presence-assertion-blind-when-shape-repeats，本仓 #586 先例）。
        // 所以按**绑定路径**逐位置问：这一处必须落在 holder 上。
        const sinks = callsTo(view, 'copyTextToClipboard').map((call) => enclosingBindingPath(call))
        expect(
          sinks,
          `${holder} 里没有 copyTextToClipboard 调用（实测这些位置有：${sinks.join(' / ')}）——` +
            '文本算出来了却没进剪贴板，点了完全没反应'
        ).toContain(`TerminalView > ${holder}`)
      })
    })
  }

  it('viewport 的第二个实参读的是这个终端的 rows，不是常量', () => {
    // 只有 viewport 有这个参数，所以单列一条（上面那组是两条路共用的形状）。
    // 写死成 24/50 之类的常量，短窗口会多复制、长窗口会少复制，而全部计数与身份判据都不受影响。
    const calls = callsTo(view, 'terminalViewportText')
    expect(calls, 'terminalViewportText 调用缺席，这条判据没有对象').toHaveLength(1)
    const resolved = resolvedArgument(calls[0]!, 1)
    expect(
      resolved,
      `可视区高度不是从终端实例读的（实测取值：${resolved}）——写死的行数会让复制范围与屏幕对不上`
    ).toBe('terminalRef.current.rows')
  })

  it('自证：实参解析器认得出「换成字面量」这次变异', () => {
    // 没有这一条，上面几条可能只是恰好在一个解析器读不懂的形状上返回了空串或原文。
    // 用探针走一遍同一条 resolvedArgument 路径：局部名字要被展开，字面量要原样留着且不含那些关键子串。
    const probe = ts.createSourceFile(
      'probe.tsx',
      'function holder() {\n' +
        '  const terminal = terminalRef.current\n' +
        '  terminalViewportText(terminal.buffer.active, terminal.rows)\n' +
        "  terminalScrollbackText({ length: 0, viewportY: 0, getLine: () => undefined })\n" +
        '}',
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TSX
    )
    const probeCalls = (name: string): ts.CallExpression[] => {
      const found: ts.CallExpression[] = []
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
          found.push(node)
        }
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(probe, visit)
      return found
    }
    // 真实形状：局部名字被顺着声明展开，两条关键子串都在。
    const real = probeCalls('terminalViewportText')[0]
    expect(real, '探针里的真实形状调用没被找到——提取器坏了').not.toBeUndefined()
    const realBody = enclosingFunctionBody(real!)
    expect(realBody, '探针调用不在任何函数体内——作用域限定失效，上面的解析可能跨了函数').not.toBeUndefined()
    const realRoot = localInitializer(realBody!, 'terminal')
    expect(realRoot, '解析器读不出 `const terminal = ...` 的初始化式——上面几条的展开是恒空的').toBe(
      'terminalRef.current'
    )
    // 变异形状：实参换成一个假 buffer 字面量，两条关键子串都不该出现。
    const faked = probeCalls('terminalScrollbackText')[0]
    expect(faked, '探针里的变异形状调用没被找到——提取器坏了').not.toBeUndefined()
    const fakedText = faked!.arguments[0]!.getText(probe)
    expect(fakedText, '假 buffer 字面量竟含 buffer.active——判据分不出真假').not.toContain('buffer.active')
    expect(fakedText, '假 buffer 字面量竟含 terminalRef.current——判据分不出真假').not.toContain(
      'terminalRef.current'
    )
  })
})

describe('投递：菜单挂载点真的收到了这两个 handler', () => {
  /** TerminalView 里所有 `<TerminalContextMenu ...>` 开标签（自闭合与成对都认）。 */
  function menuElements(): ts.JsxOpeningLikeElement[] {
    const found: ts.JsxOpeningLikeElement[] = []
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(view) === 'TerminalContextMenu'
      ) {
        found.push(node)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(view, visit)
    return found
  }

  it('恰好一个 TerminalContextMenu 挂载点', () => {
    // 在场自证：0 个 → 下面两条读 undefined 会恒真；多个 → 只钉住其中一个，另一个可以接错。
    expect(
      menuElements(),
      'TerminalContextMenu 的挂载点不是恰好一个——下面的接线断言可能扫错元素或恒真'
    ).toHaveLength(1)
  })

  it('onCopyViewport / onCopyScrollback 分别接到那两个函数，且没接反', () => {
    // 三种让能力静默消失的写法都要红：接成 `() => {}`（点了没反应）、两个都接同一个函数
    // （两项做同一件事）、以及接反（"Copy visible output" 复制整个会话）。判表达式身份，
    // 不判「属性在不在」——后者对接反完全失明。
    const element = menuElements()[0]
    expect(element, '菜单挂载点缺席').not.toBeUndefined()
    expect(
      attributeExpression(view, element!, 'onCopyViewport'),
      'onCopyViewport 收到的不是 copyViewport——可视区复制接错或接成了 no-op'
    ).toBe('copyViewport')
    expect(
      attributeExpression(view, element!, 'onCopyScrollback'),
      'onCopyScrollback 收到的不是 copyScrollback——整段复制接错或接成了 no-op'
    ).toBe('copyScrollback')
  })
})

describe('菜单侧：两个入口真的渲染出来，且永不变灰', () => {
  /** TerminalContextMenu 里所有 `ContextMenu.Item`（成对形式）。 */
  function items(): ts.JsxElement[] {
    const found: ts.JsxElement[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(menu) === 'ContextMenu.Item') {
        found.push(node)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(menu, visit)
    return found
  }

  /** 由 `onSelect` 的表达式文本定位某一项；找不到为 null。 */
  function itemByHandler(handler: string): ts.JsxElement | null {
    for (const item of items()) {
      if (attributeExpression(menu, item.openingElement, 'onSelect') === handler) return item
    }
    return null
  }

  /** 一项里 `<span>` 的文本（用于「两项文案不同」这条判据）。 */
  function spanText(item: ts.JsxElement): string {
    for (const child of item.children) {
      if (ts.isJsxElement(child) && child.openingElement.tagName.getText(menu) === 'span') {
        return child.children
          .map((grand) => (ts.isJsxText(grand) ? grand.getText(menu).trim() : ''))
          .join('')
      }
    }
    return ''
  }

  const HANDLERS = ['onCopyViewport', 'onCopyScrollback'] as const

  it('两个 prop 都在组件签名里，且是必填', () => {
    // 必填这件事是承重的：可选 prop 在这里买到的只有 tsc 的沉默——全仓只有一个调用点，
    // 删掉那行 JSX 属性、或写成 `{undefined && …}`，整条能力静默消失且编译照过
    // （记忆 optional-prop-only-buys-silence，本组件的 mouseTrackingMode 就栽过一次）。
    let parameters: ts.ObjectBindingPattern | undefined
    let typeLiteral: ts.TypeLiteralNode | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'TerminalContextMenu') {
        const first = node.parameters[0]
        if (first !== undefined && ts.isObjectBindingPattern(first.name)) parameters = first.name
        if (first?.type !== undefined && ts.isTypeLiteralNode(first.type)) typeLiteral = first.type
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(menu, visit)
    expect(parameters, '找不到 TerminalContextMenu 的解构参数——判据的扫描对象缺席').not.toBeUndefined()
    expect(typeLiteral, '找不到 TerminalContextMenu 的参数类型字面量——「必填」这条没法判').not.toBeUndefined()

    const destructured = parameters!.elements.flatMap((element) =>
      ts.isIdentifier(element.name) ? [element.name.text] : []
    )
    for (const handler of HANDLERS) {
      expect(destructured, `${handler} 没有被解构出来——组件收不到这个 handler`).toContain(handler)
      const member = typeLiteral!.members.find(
        (one) => one.name !== undefined && one.name.getText(menu) === handler
      )
      expect(member, `${handler} 不在参数类型里——它会是隐式 any 或自由变量`).not.toBeUndefined()
      expect(
        member!.questionToken,
        `${handler} 是可选的——调用方删掉那行 JSX 属性时 tsc 会沉默，整条能力静默消失`
      ).toBeUndefined()
    }
  })

  for (const handler of HANDLERS) {
    it(`有一个 ContextMenu.Item 的 onSelect 正好是 ${handler}`, () => {
      // 这是 Finding C 那个形状的正面判据：整个菜单项可以被删掉，而 lib 侧 14 条、投递侧 2 条全绿
      // （`noUnusedLocals` 在 desktop 是关的，孤儿 prop 连编译警告都没有），用户回到 #638 的原点。
      expect(
        itemByHandler(handler),
        `没有任何 ContextMenu.Item 的 onSelect 是 ${handler}——这个入口没被渲染出来，用户看不到它`
      ).not.toBeNull()
    })

    it(`${handler} 那一项永不 disabled`, () => {
      // 这两条路存在的**全部理由**就是「不依赖选区」。给它们挂上 `disabled={!hasSelection}`
      // （复制上面那条 Copy 项时最容易顺手带上的一行），它们会与坏掉的那条一起变灰——
      // 缺陷原样复现，而上面每一条接线判据都还是绿的。
      const item = itemByHandler(handler)
      expect(item, `${handler} 那一项缺席，这条判据没有对象`).not.toBeNull()
      expect(
        attributeExpression(menu, item!.openingElement, 'disabled'),
        `${handler} 那一项挂了 disabled——它的可用性不该取决于有没有选区，那正是 #638 的病根`
      ).toBeNull()
    })
  }

  it('两项的文案不同且都非空', () => {
    // 不钉具体措辞（措辞该能改），钉「它们说的不是同一件事」：两项都叫 "Copy" 时用户无从选择，
    // 而按 onSelect 定位的上面几条完全看不出这一点。
    const labels = HANDLERS.map((handler) => {
      const item = itemByHandler(handler)
      return item === null ? '' : spanText(item)
    })
    for (const [index, label] of labels.entries()) {
      expect(label, `${HANDLERS[index]} 那一项没有可读文案——菜单上是一个空条目`).not.toBe('')
    }
    expect(labels[0], '两条复制路的菜单文案相同——用户分不出「这一屏」和「全部输出」').not.toBe(labels[1])
  })

  it('自证：按 onSelect 定位真的能区分两项，不是都落到同一个元素上', () => {
    // 上面每条 `itemByHandler` 都假设两个 handler 分别命中不同的元素。若定位器坏掉（例如属性读法
    // 失配而总是返回第一项），那些断言会集体在同一个元素上恒真。这里把「两项是不同节点」钉死。
    const first = itemByHandler('onCopyViewport')
    const second = itemByHandler('onCopyScrollback')
    expect(first, 'onCopyViewport 那一项定位不到').not.toBeNull()
    expect(second, 'onCopyScrollback 那一项定位不到').not.toBeNull()
    expect(first === second, '两个 handler 定位到了同一个菜单项——定位器坏了，上面几条是恒真的').toBe(false)
    // 反向自证：一个**不存在**的 handler 必须定位不到，否则定位器是「随便返回一个」而不是在比对。
    expect(
      itemByHandler('onCopyNothing'),
      '定位器对一个不存在的 handler 也能返回菜单项——它没有在比对 onSelect'
    ).toBeNull()
  })
})
