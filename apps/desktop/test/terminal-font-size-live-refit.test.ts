import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { TerminalViewportSynchronizer } from '../src/renderer/src/lib/terminal-viewport-sync'
import {
  enclosingFunctionBody,
  findCallsToIdentifier,
  findCallsToMember,
  parseTsx,
  assertEarlyExitGuards
} from './helpers/effect-reachability'

// ---------------------------------------------------------------------------
// Guard 2 — 改字号必须真的重排已开着的终端，不只是「调了 setter」。
//
// 一个字号变化的形状很特别：容器 CSS 像素**没变**，但每个格子的像素尺寸变了，于是整块 grid
// （cols/rows）都动了。这正好撞上 `fitAndSynchronize` 的抖动闸——它认为「grid 变了但容器像素
// 没变」是 WebGL/DOM cell-metric 的瞬时抖动，直接 return 不 fit。所以一次**普通的**
// observeViewport() 在字号变化后会被这道闸静默吞掉，PTY 永远收不到新的行列数、TUI 按旧网格串行。
//
// 判据因此是**行为**的：把 synchronizer 放进「上次成功 fit 的像素 == 现在的像素、但 grid 发散」
// 这个精确场景里，
//   · 普通 observeViewport() 一路跑完 → resize **没有**被调用（抖动闸挡住，这是缺陷形状）；
//   · synchronizeCellMetrics() 一路跑完 → resize **被**调用且带新 grid（缺陷被治好）。
// 只断言「setter 被调过」是数不出这个差别的——那正是本仓反复记录的假绿。
// ---------------------------------------------------------------------------

const frameHarness = () => {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    request(callback: FrameRequestCallback) {
      nextId += 1
      callbacks.set(nextId, callback)
      return nextId
    },
    cancel(frameId: number) {
      callbacks.delete(frameId)
    },
    async runAll() {
      // Drain every queued frame, including ones a frame schedules while running, so the stability
      // loop settles exactly as it does in the browser.
      for (let guard = 0; guard < 64 && callbacks.size > 0; guard += 1) {
        const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined
        if (!entry) break
        callbacks.delete(entry[0])
        entry[1](0)
        await Promise.resolve()
      }
    }
  }
}

/**
 * A synchronizer that has already gone live and settled on a fitted grid at a fixed container size —
 * the exact preconditions the wobble gate reads. `cellPx` is how many CSS px one cell takes on each
 * axis; raising it (a bigger font) shrinks the proposed grid while the container pixels stay put.
 */
async function liveSettledSynchronizer() {
  const frames = frameHarness()
  const viewportPx = { width: 1200, height: 800 }
  let cellPx = { w: 10, h: 20 }
  const gridFor = () => ({
    cols: Math.floor(viewportPx.width / cellPx.w),
    rows: Math.floor(viewportPx.height / cellPx.h)
  })
  let actual = gridFor()
  const resize = vi.fn(async (_size: { cols: number; rows: number }) => true)
  const sync = new TerminalViewportSynchronizer({
    proposeGrid: () => gridFor(),
    fit: () => { actual = gridFor() },
    readGrid: () => actual,
    resize,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    measureViewport: () => ({ ...viewportPx })
  })
  await sync.startLiveSynchronization()
  await frames.runAll()
  resize.mockClear()
  return {
    sync,
    resize,
    runAll: frames.runAll,
    // Simulate a font-size change: same container pixels, larger cells ⇒ the grid diverges while
    // measureViewport keeps returning the last-fitted pixels. This is precisely the wobble shape.
    growFont() { cellPx = { w: 12, h: 24 } }
  }
}

describe('terminal font-size live refit reaches the PTY', () => {
  it('自检：字号变化确实制造「grid 发散、容器像素不变」这个抖动闸场景', async () => {
    const harness = await liveSettledSynchronizer()
    harness.growFont()
    // 普通 observe 走完后 resize 一次都没有——证明抖动闸真的把这个形状挡住了。若这条为假，
    // 下面那条「synchronizeCellMetrics 能穿过」就不再证明任何东西（场景本身就不需要穿透）。
    harness.sync.observeViewport()
    await harness.runAll()
    expect(harness.resize).not.toHaveBeenCalled()
  })

  it('synchronizeCellMetrics 穿过抖动闸，把新 grid 送到 PTY', async () => {
    const harness = await liveSettledSynchronizer()
    harness.growFont()
    harness.sync.synchronizeCellMetrics()
    await harness.runAll()
    // 更大的字号 ⇒ 更少的行列。容器 1200×800、cell 12×24 ⇒ 100×33。
    expect(harness.resize).toHaveBeenCalledWith({ cols: 100, rows: 33 })
  })

  it('普通 observeViewport 与 synchronizeCellMetrics 在同一场景下结果相反', async () => {
    // 把两条路并排跑在同一初始状态上：差异只来自 synchronizeCellMetrics 清掉了像素基线。
    const viaObserve = await liveSettledSynchronizer()
    viaObserve.growFont()
    viaObserve.sync.observeViewport()
    await viaObserve.runAll()

    const viaSync = await liveSettledSynchronizer()
    viaSync.growFont()
    viaSync.sync.synchronizeCellMetrics()
    await viaSync.runAll()

    expect(viaObserve.resize).not.toHaveBeenCalled()
    expect(viaSync.resize).toHaveBeenCalledTimes(1)
  })
})

// TerminalView 里那条 effect 无法在本仓跑（没有 DOM 测试环境，renderToStaticMarkup 不跑 effect）。
// 所以「字号 effect 里，refit 那句调用**可达**」用 AST 可达性判据守——文本 toContain 看不见
// 在它之前插一句 `return` 造成的整段 no-op（本仓 renderer-effect-reachability 的同一族判据）。
describe('TerminalView applies the size to an open terminal and refits', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url)),
    'utf8'
  )
  const sourceFile = parseTsx('TerminalView.tsx', source)

  it('字号 effect 调用 synchronizeCellMetrics，且之前只有那两句合法守护', () => {
    const calls = findCallsToMember(sourceFile, 'synchronizeCellMetrics')
    expect(calls, 'synchronizeCellMetrics() 应恰有一处调用').toHaveLength(1)
    // 合法守护恰好两句：跳过挂载首跑（attach 已在构造期用过字号），以及 open terminal 缺席时不做。
    // 任何在这之外**另插**一句早退（把整段 effect 变成 no-op）都会让白名单不匹配而红——这正是
    // 「文本 toContain 看不见早退」的补法。删掉这两句本应在场的守护，同样红。
    assertEarlyExitGuards(
      calls[0]!,
      ['!fontSizeMountedRef.current', '!terminal'],
      'TerminalView font-size effect'
    )
  })

  it('挂载首跑那条守护会把 flag 置位（不置位则每次改字号都早退，effect 永久 no-op）', () => {
    // 上一条只读早退的**条件**，读不到条件成立时那个分支**做了什么**。而这条 effect 的正确性一半
    // 压在分支体上：`if (!flag.current) { flag.current = true; return }`——那句赋值是「首跑不做事，
    // 之后每次都做事」这个语义的全部实现。把它删成 `if (!flag.current) return`，条件列表一个字都
    // 不变（白名单仍匹配），可 flag 永远是 false，于是**每一次**字号变化都走首跑分支早退：改字号
    // 从此完全没有反应。实测：删掉那行，本文件与另外三个字号 suite 27/27 全绿。
    //
    // 判据因此要落在那个 then 分支的**体**上：它必须把守护读的那个 ref 写成 true。按 AST 读
    // `<同一个 ref>.current = true` 这个赋值，而不是 grep 文件里有没有这串字符——ref 名从条件里
    // 取出来再回头比对，改名重构不会假红，而写到**别的** ref 上（一种真缺陷）会红。
    const calls = findCallsToMember(sourceFile, 'synchronizeCellMetrics')
    const body = enclosingFunctionBody(calls[0]!)
    expect(body, '字号 effect 的函数体应能被定位到').toBeDefined()

    // 找到守护那句 `if (!X.current) …`，从条件里取出 ref 名 X——这样下面比的是「守护读的那一个」。
    let guard: ts.IfStatement | undefined
    let guardedRef: string | undefined
    for (const statement of body!.statements) {
      if (!ts.isIfStatement(statement)) continue
      const condition = statement.expression
      if (!ts.isPrefixUnaryExpression(condition)) continue
      if (condition.operator !== ts.SyntaxKind.ExclamationToken) continue
      const operand = condition.operand
      if (!ts.isPropertyAccessExpression(operand)) continue
      if (operand.name.text !== 'current') continue
      if (!ts.isIdentifier(operand.expression)) continue
      if (!operand.expression.text.toLowerCase().includes('fontsize')) continue
      guard = statement
      guardedRef = operand.expression.text
      break
    }
    expect(guard, '应能定位到 `if (!<fontSize…Ref>.current)` 这句挂载守护').toBeDefined()

    // 在那个 then 分支里找 `<同一个 ref>.current = true`。找不到 ⇒ flag 永不置位 ⇒ 永久 no-op。
    //
    // 判「在场」不够，必须判「跑得到」。原先这里递归整棵 then 子树，于是
    //     if (!fontSizeMountedRef.current) { return; fontSizeMountedRef.current = true }
    // 全绿存活——赋值在 return 之后是死代码，flag 永远 false，每次改字号都早退，正是这条判据要
    // 拦的 #845，只是换了个拼法。所以改成只认 then 块的**直接语句**，且必须排在任何 return/throw
    // 之前。本仓这一族记过：`guard-must-check-reachability-not-presence`。
    const isGuardedFlagAssignment = (node: ts.Node): boolean =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'current' &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === guardedRef &&
      node.right.kind === ts.SyntaxKind.TrueKeyword

    // then 分支可以是块，也可以是单条语句（`if (!ref.current) ref.current = true`）。
    const thenStatements = ts.isBlock(guard!.thenStatement)
      ? [...guard!.thenStatement.statements]
      : [guard!.thenStatement]

    let assignsGuardedFlag = false
    for (const statement of thenStatements) {
      // 走到无条件出口就停：其后的语句一律不可达，在那里置位等于没置位。
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break
      if (ts.isExpressionStatement(statement) && isGuardedFlagAssignment(statement.expression)) {
        assignsGuardedFlag = true
        break
      }
    }
    expect(
      assignsGuardedFlag,
      `挂载守护的 then 分支必须把 ${guardedRef}.current 置为 true，且这句要**跑得到**——` +
        '排在任何 return/throw 之前的直接语句。缺了它（或把它埋在早退之后当死代码），flag 永远是 ' +
        'false，每次字号变化都走首跑分支早退——改字号对已开着的终端完全没有反应，而早退条件本身' +
        '一个字没变，所以只读条件的那条判据看不见。'
    ).toBe(true)
  })

  it('写进 options 的就是 fontSize 这个 prop 本身，不是由它算出来的别的值', () => {
    // 只 refit 而不改 terminal.options.fontSize，xterm 会按旧字号重新 fit，字号根本不变。
    // 两件事必须都在这条 effect 里：设 options + 触发 refit。
    //
    // 但「那行字符串在场」证不到取值对：把右边写成 `fontSize + 1`，`toContain('… = fontSize')`
    // 仍然命中（它是新串的前缀），于是每个终端都比用户选的大一号而全绿——实测存活。所以判据要按
    // AST 读那次赋值的**右值**，要求它恰好是标识符 `fontSize`。这样 `fontSize + 1`、`12`、
    // `clamp(fontSize)` 之类一律红，而重命名 prop 会连同守护一起改，不会假红。
    //
    // 收**全部**写入点而不是留最后一个。原先每命中一次就覆写单个变量，于是
    //     if (fontSize > 20) terminal.options.fontSize = fontSize + 1
    //     else terminal.options.fontSize = fontSize
    // 全绿存活——所有 >20px 的字号都大一号是真缺陷，但 else 那支源码顺序在后、被记下，断言看到的
    // 是对的那个。本仓这一族记过：`sampled-pair-can-be-the-blind-spot`（抽一个当代表，代表恰好是
    // 对的那个）。所以下面既钉每一处的取值，也钉「只该有一处」。
    const assignedExpressions: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === 'fontSize' &&
        ts.isPropertyAccessExpression(node.left.expression) &&
        node.left.expression.name.text === 'options'
      ) {
        assignedExpressions.push(node.right.getText(sourceFile))
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    expect(
      assignedExpressions.length,
      '应能定位到 `<terminal>.options.fontSize = …` 这次赋值'
    ).toBeGreaterThan(0)
    expect(
      assignedExpressions,
      '写进 xterm 的必须是 fontSize 这个 prop 原值，且只该有一处这么写。写成由它算出来的别的表达式' +
        '（如 fontSize + 1），对应那一支的终端就会渲染成与用户所选不同的字号；而分成两支写、只有一支' +
        '算错时，「留最后一个写入点」的判据会被对的那支替错的那支背书。'
    ).toEqual(['fontSize'])
  })

  it('attach effect 不依赖 fontSize（改字号不能重建 xterm、重放 scrollback）', () => {
    // attach effect 的依赖数组钉死为这三项。把 fontSize 加进去会让每次改字号都拆掉 xterm 重放
    // 历史输出——一次严重的体验回归，且静默。依赖数组是承重的，用 AST 读它而不是文本匹配。
    const attachDeps = findCallsToIdentifier(sourceFile, 'useEffect')
      .map((call) => call.arguments[1])
      .filter((arg): arg is NonNullable<typeof arg> => Boolean(arg))
      .map((arg) => arg.getText())
      .filter((text) => text.includes('session.control.run.runId'))
    expect(attachDeps, 'attach effect 依赖数组应能被定位到').toHaveLength(1)
    expect(attachDeps[0]).not.toContain('fontSize')
  })
})

// ---------------------------------------------------------------------------
// Guard 3 — 每个渲染 <TerminalView> 的地方都必须把用户选的字号传进去。
//
// 上面两组守的都是 TerminalView **内部**：effect 可达、置位在场、写进去的取值对。可这条 prop 有
// 默认值（`fontSize = TERMINAL_FONT_SIZE_DEFAULT`），于是调用方**不传**它是合法 TypeScript——
// tsc 一声不吭，组件照常渲染，只是永远停在 12。实测：删掉 SessionPane 那一行，四个字号 suite
// 27/27 全绿；用户改字号，那一格终端纹丝不动。
//
// 判据必须**枚举出全部渲染点**再逐个检查，而不是照抄一份文件清单：手抄清单对「新开一个渲染
// TerminalView 的组件」结构性失明（本仓 #535 记过同一形状）。所以扫整棵 renderer 树找 JSX 标签，
// 让新增的渲染点自动落进判据里。
// ---------------------------------------------------------------------------
describe('每个 TerminalView 渲染点都把字号传进去', () => {
  const rendererRoot = fileURLToPath(new URL('../src/renderer/src', import.meta.url))

  /** renderer 树下所有 .tsx 的绝对路径（递归；TerminalView 自己的定义文件除外）。 */
  function allRendererTsx(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) found.push(...allRendererTsx(full))
      else if (entry.name.endsWith('.tsx') && entry.name !== 'TerminalView.tsx') found.push(full)
    }
    return found
  }

  /** 一个 `<TerminalView …>` 渲染点：文件名 + 它给 fontSize 的表达式（缺席**或显式 undefined** 时为 undefined）。 */
  interface RenderSite {
    readonly file: string
    readonly fontSizeExpression: string | undefined
    /** 这个渲染点上有没有一个**看不透**的 spread——它可能悄悄带着 fontSize，只能放行。 */
    readonly spreadsUnknownProps: boolean
  }

  /**
   * 这个文件里，哪些标识符指向 TerminalView。
   *
   * 判据不能只认「标签名字面上叫 TerminalView」：`import { TerminalView as TV }` 与
   * `const TV = TerminalView` 都是合法写法，而它们让渲染点**整个**从扫描面消失——漏传 fontSize
   * 最容易藏身的地方恰恰在那里（审计实测：套一层别名，判据 9 条全绿）。所以从 import 绑定出发，
   * 再把「直接赋值给另一个名字」闭包到不动点，链式别名也认得。
   *
   * 起点里保留裸 `TerminalView`：即使某天改从 barrel 导入、import 那一支认不出来，射程也只增不减。
   */
  function terminalViewAliases(sourceFile: ts.SourceFile): ReadonlySet<string> {
    const names = new Set<string>(['TerminalView'])
    const collectImports = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === 'TerminalView') names.add(element.name.text)
          }
        }
      }
      ts.forEachChild(node, collectImports)
    }
    collectImports(sourceFile)

    for (let grew = true; grew; ) {
      grew = false
      const collectAliases = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          names.has(node.initializer.text) &&
          !names.has(node.name.text)
        ) {
          names.add(node.name.text)
          grew = true
        }
        ts.forEachChild(node, collectAliases)
      }
      collectAliases(sourceFile)
    }
    return names
  }

  /**
   * 这个 spread 有没有可能带上 fontSize。
   *
   * `{...props}` 里装着什么静态看不出来，只能放行。但 `{...{ session }}` 是**对象字面量**，
   * 它带什么一目了然——审计实测的绕法正是这一种：把 props 写成字面量 spread，无条件的豁免
   * 就不再问 fontSize 了，而那个 spread 证明性地不可能携带它。于是字面量按内容判，
   * 非字面量（含计算键、嵌套 spread）一律当作「可能带」。
   */
  function spreadMayCarryFontSize(attribute: ts.JsxSpreadAttribute): boolean {
    const expression = attribute.expression
    if (!ts.isObjectLiteralExpression(expression)) return true
    return expression.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) return true
      const name = property.name
      if (!name) return true
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === 'fontSize'
      return true
    })
  }

  /** `undefined` / `void 0`：属性在场，取值却等于缺席。 */
  function isUndefinedExpression(expression: ts.Expression): boolean {
    if (ts.isVoidExpression(expression)) return true
    return ts.isIdentifier(expression) && expression.text === 'undefined'
  }

  /** 从一份源码里取出全部 `<TerminalView …>` 渲染点。抽成函数是为了让下面的反向自检**执行这一份**。 */
  function renderSitesIn(fileName: string, source: string): RenderSite[] {
    const parsed = parseTsx(fileName, source)
    const aliases = terminalViewAliases(parsed)
    const sites: RenderSite[] = []
    const visit = (node: ts.Node): void => {
      const opening = ts.isJsxOpeningElement(node)
        ? node
        : ts.isJsxSelfClosingElement(node)
          ? node
          : undefined
      if (opening && aliases.has(opening.tagName.getText(parsed))) {
        let fontSizeExpression: string | undefined
        let spreadsUnknownProps = false
        for (const attribute of opening.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) {
            if (spreadMayCarryFontSize(attribute)) spreadsUnknownProps = true
            continue
          }
          if (!ts.isJsxAttribute(attribute)) continue
          if (attribute.name.getText(parsed) !== 'fontSize') continue
          const initializer = attribute.initializer
          if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
            // `fontSize={undefined}` 在语法上「传了」，在语义上等于没传：默认值照样兜底，
            // 那一格终端仍旧钉死在 12。只问属性在不在的判据会放行它（审计实测过的绕法）。
            if (!isUndefinedExpression(initializer.expression)) {
              fontSizeExpression = initializer.expression.getText(parsed)
            }
          }
        }
        sites.push({ file: fileName, fontSizeExpression, spreadsUnknownProps })
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    return sites
  }

  function terminalViewRenderSites(): RenderSite[] {
    return allRendererTsx(rendererRoot).flatMap((file) =>
      renderSitesIn(path.basename(file), readFileSync(file, 'utf8'))
    )
  }

  /** 判据本体：哪些渲染点没有把一个真取值交给 fontSize。 */
  function sitesMissingFontSize(sites: readonly RenderSite[]): string[] {
    return sites
      .filter((site) => site.fontSizeExpression === undefined && !site.spreadsUnknownProps)
      .map((site) => site.file)
  }

  it('渲染点被真的枚举到了（自检：判据不是在空集合上恒真）', () => {
    // 没有这条，扫描面一旦写错（改了目录、后缀、标签名），下面那条就在空数组上恒真，
    // 而它正是要抓「有渲染点漏传」的那条判据。
    const sites = terminalViewRenderSites()
    expect(sites.length, 'renderer 树里应能找到 <TerminalView> 的渲染点').toBeGreaterThan(0)
  })

  it('自检：文本上看得见的每个 `<TerminalView` 渲染点，AST 那侧都找到了', () => {
    // 用一个**机制完全不同**的下界（纯文本）给 AST 扫描兜底：目录写错、后缀过滤写错、标签匹配
    // 写坏，任何一种都让 AST 那侧静默少扫，而上面那条「>0」照旧绿。反过来不成立——别名写法
    // 文本看不见，那正是 AST 那侧多出来的射程，所以这里只做下界，不做相等。
    const textual = allRendererTsx(rendererRoot)
      .filter((file) => readFileSync(file, 'utf8').includes('<TerminalView'))
      .map((file) => path.basename(file))
      .sort()
    expect(textual.length, '文本下界本身为空，这条自检会恒真').toBeGreaterThan(0)
    const found = new Set(terminalViewRenderSites().map((site) => site.file))
    expect(
      textual.filter((file) => !found.has(file)),
      'AST 扫描漏掉了这些文本上明摆着的渲染点，说明扫描面坏了'
    ).toEqual([])
  })

  // ── 三条反向自检：审计实测过的三种绕法，判据必须把它们认成「漏传」 ───────────────
  // 每条单独一个 it：挤在一起时先失败的那条会让后面的成为死代码（本仓 #742 那一族）。
  // 输入是合成源码，但被检验的是**提取器本身**——真判据仍然跑在真实树上，两者不互相背书。

  it('反向自检：`fontSize={undefined}` 必须被认成漏传', () => {
    const sites = renderSitesIn('Synthetic.tsx', '<TerminalView session={s} fontSize={undefined} />')
    expect(sites.length).toBe(1)
    expect(sitesMissingFontSize(sites)).toEqual(['Synthetic.tsx'])
  })

  it('反向自检：别名渲染（`const TV = TerminalView`）不许逃出扫描面', () => {
    const sites = renderSitesIn(
      'Synthetic.tsx',
      "import { TerminalView } from './TerminalView'\nconst TV = TerminalView\nexport const X = () => <TV session={s} />\n"
    )
    expect(sites.length, '别名渲染点没被认出来，等于整个渲染点从判据里消失').toBe(1)
    expect(sitesMissingFontSize(sites)).toEqual(['Synthetic.tsx'])
  })

  it('反向自检：证明性地带不了 fontSize 的字面量 spread 不构成豁免', () => {
    const sites = renderSitesIn('Synthetic.tsx', '<TerminalView {...{ session: s }} />')
    expect(sites.length).toBe(1)
    expect(sitesMissingFontSize(sites)).toEqual(['Synthetic.tsx'])
  })

  it('自检：看不透的 spread 仍然放行（判据不许对合法写法打假红）', () => {
    // 对称的另一半。`{...props}` 里有没有 fontSize 静态答不了，判成漏传就是误伤——
    // 一个会打假红的守卫最后一定被删掉，那才是真正的损失。
    const sites = renderSitesIn('Synthetic.tsx', '<TerminalView {...props} />')
    expect(sites.length).toBe(1)
    expect(sitesMissingFontSize(sites)).toEqual([])
  })

  it('没有任何渲染点漏掉 fontSize（漏掉即那一格终端永久钉死在默认值）', () => {
    // `fontSize?: number` 带默认值，所以漏传是合法 TS——tsc 不会响。漏传的后果不是崩溃而是静默：
    // 那一格终端永远 12，用户在设置里怎么调都没反应，且与同屏其他终端不一致。
    const missing = sitesMissingFontSize(terminalViewRenderSites())
    expect(
      missing,
      `这些文件渲染 <TerminalView> 却没传 fontSize：${missing.join(', ')}。` +
        'prop 有默认值，因此漏传不会有编译错，只会让那一格终端永久停在 TERMINAL_FONT_SIZE_DEFAULT。'
    ).toEqual([])
  })
})
