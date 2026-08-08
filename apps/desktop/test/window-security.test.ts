import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import ts from 'typescript'
import {
  windowOpenDecision,
  windowOpenOutcome,
  windowSecurityWebPreferences
} from '../src/main/window-security.js'
import {
  declarationOf,
  importedModuleOf,
  namedImportsFrom,
  parseModule,
  parseModuleFile,
  type ParsedModule
} from './helpers/ts-binding.js'
import {
  browserWindowSites,
  NODE_PATH_MODULE,
  PRELOAD_RELATIVE_PATH,
  WINDOW_SECURITY_MODULE,
  type SiteVerdict
} from './helpers/window-security-ast.js'

/**
 * 主窗口的四个隔离开关（contextIsolation/sandbox/nodeIntegration/preload）+ webSecurity + 弹窗判据。
 *
 * 这些取值此前完全无人守：另一个 reviewer 把四个开关全部取反、加 webSecurity:false、并把
 * setWindowOpenHandler 从 deny 翻成 allow，9 个碰 index.ts 的测试 98/98 全绿、tsc 退 0。根因两条：
 * index.ts 一 import 就跑 Electron app 副作用（顶层 crashReporter/setPath/单实例锁），任何测试都无法
 * import 它；唯一沾它的守卫是源码文本扫描，只看窗口几何/单实例/菜单/导航，从不看这五个取值。
 *
 * 修法（#452）：把取值提成可 import 的纯常量/纯函数（window-security.ts），让测试**直接质询取值**，
 * 而不是再写一条已经失效的文本扫描。本文件分两层：
 * - 行为层：直接 import 纯函数，逐开关断言取值（不是「键在场」），弹窗判据按 url 分类穷举，并对
 *   windowOpenOutcome 断言它那唯一的副作用（交给系统浏览器）恰好落在哪些输入上。
 * - 接线层：走 TS parser（AST），断言 index.ts 真的 import 了这个模块、webPreferences 的值**就是**那次
 *   调用（而非另手抄一份对象字面量）、setWindowOpenHandler 的回调体**就是**一次把 url 转发给那个纯函数
 *   的调用。文本判据（裸标识符能绕过、不问喂进去的是不是那个值）在这里被明确拒绝。
 *
 * 接线层的判据在 #665 收紧过一次：原先它问「回调体里调了纯函数吗 / 返回的 action 是属性访问吗」，实测
 * 可绕——在派生的 return 之前插一句可达的 `return { action: 'allow' as const }`，17/17 全绿。根因是那版
 * 判据遍历所有 return 并保留最后走到的那个，读到的是死代码。现在的判据要求回调体是**简洁体**（体就是
 * 那一次调用），于是一句语句也插不进去。
 */

const here = dirname(fileURLToPath(import.meta.url))
const indexPath = join(here, '../src/main/index.ts')

// ---------------------------------------------------------------------------------------------------
// 行为层：直接质询取值
// ---------------------------------------------------------------------------------------------------

describe('windowSecurityWebPreferences: the four isolation switches, by value', () => {
  const prefs = windowSecurityWebPreferences('/pkg/preload/index.cjs')

  it('contextIsolation is true — false lets page scripts reach into preload/Node and hijack the bridge', () => {
    // 取值错成 false：renderer 的 JS 世界不再与 preload/Electron 内部隔离，页面脚本能改写 preload
    // 暴露对象的原型、拿到 Node 原语，那座特权桥（files/git/gh/shell）彻底失守。
    expect(prefs.contextIsolation).toBe(true)
  })

  it('sandbox is true — false turns a renderer-side RCE into a host-level RCE', () => {
    // 取值错成 false：renderer 不再跑在 OS 沙箱里，一次 renderer 侧代码执行就等于主机级代码执行。
    expect(prefs.sandbox).toBe(true)
  })

  it('nodeIntegration is false — true hands injected scripts require/process/Buffer directly', () => {
    // 取值错成 true：页面里直接有 require，任何注入脚本可 require('child_process').exec(...)。
    expect(prefs.nodeIntegration).toBe(false)
  })

  it('preload is the exact path handed in — this is the controlled bridge entry point', () => {
    // 取值漂成别的路径：要么桥装不上（应用废掉），要么装上一个非受控的 preload。
    expect(prefs.preload).toBe('/pkg/preload/index.cjs')
  })

  it('webSecurity is absent or true, never false — the key nobody watched is the one most easily set false', () => {
    // webSecurity 默认 true。它在 src/ 与 test/ 下曾 0 命中（没人盯），正是最容易被静默塞成 false 的键。
    // 取值错成 false：同源策略关闭，file:// 文档能读任意本地文件、跨站请求无限制。判据：缺席算 true，
    // 出现必须为 true，绝不为 false。
    expect(prefs.webSecurity ?? true).toBe(true)
  })
})

describe('windowOpenDecision: classify every url scheme', () => {
  it('https:// — denied in-app, handed to the system browser', () => {
    // 唯一交给系统浏览器的形状。若 action 翻成 allow，外部链接会在应用内开一个带特权桥的新窗口。
    expect(windowOpenDecision('https://example.com/x')).toEqual({ action: 'deny', openExternally: true })
  })

  it('http:// — denied, and NOT handed out (only https is trusted enough for the system browser)', () => {
    expect(windowOpenDecision('http://example.com/x')).toEqual({ action: 'deny', openExternally: false })
  })

  it('file:// — denied, not handed out (a dropped/opened local file must not spawn a window)', () => {
    expect(windowOpenDecision('file:///tmp/evil.html')).toEqual({ action: 'deny', openExternally: false })
  })

  it('some other scheme — denied, not handed out', () => {
    expect(windowOpenDecision('mailto:a@b.c')).toEqual({ action: 'deny', openExternally: false })
    expect(windowOpenDecision('javascript:alert(1)')).toEqual({ action: 'deny', openExternally: false })
  })

  it('empty string — denied, not handed out (the empty string itself neither throws nor allows)', () => {
    // 「不抛」这半句只说空串这一个输入。**非字符串**（null/undefined/数字/对象/数组）会实测抛
    // TypeError（`url.startsWith is not a function` 等五种全抛），这里刻意不守也不加防御：
    // Electron 的 HandlerDetails.url 类型就是 string，形参也是 string，非字符串只能靠 cast 硬塞
    // 进来。为一个签名与宿主双重排除的输入写运行期兜底属于兼容层，会把「谁该保证它是字符串」这件事
    // 从类型边界搬到函数体里。若哪天真有非字符串调用点出现，那是那个调用点的缺陷。
    expect(windowOpenDecision('')).toEqual({ action: 'deny', openExternally: false })
  })

  it('action is deny for EVERY string input — the app opens no child windows', () => {
    // 分类穷举的收束断言：无论什么 scheme，action 恒为 deny。把 deny 翻成 allow 会让这条整批红。
    for (const url of ['https://a', 'http://a', 'file:///a', 'ws://a', 'about:blank', '', 'not a url']) {
      expect(windowOpenDecision(url).action).toBe('deny')
    }
  })
})

describe('windowOpenOutcome: the decision AND its one side effect, in a single call', () => {
  // 这个函数存在的理由是「让 index.ts 的回调体里没有语句可劫持」（详见 window-security.ts 的注释）。
  // 它因此承担了两件此前无人守的事，各自单独钉：
  // 1. openExternally 的**消费侧**——把 `if (decision.openExternally)` 取反或删掉，此前 17/17 全绿。
  // 2. 返回的 action——此前接线守卫遍历所有 return 并保留最后走到的那个，读的可能是死代码。
  function record(url: string): { readonly handed: string[]; readonly action: 'allow' | 'deny' } {
    const handed: string[] = []
    const outcome = windowOpenOutcome(url, (target) => handed.push(target))
    return { handed, action: outcome.action }
  }

  it('https:// — handed to the system browser exactly once, with that exact url', () => {
    // 判据是「碰了外界几次、拿到的是什么」而不是某个 spy 是否被碰过：把 openExternal(url) 改成
    // openExternal('') 或调两次，这条都会红。
    expect(record('https://example.com/x')).toEqual({ handed: ['https://example.com/x'], action: 'deny' })
  })

  it('http:// — NOT handed out (downgrading the scheme must not reach the system browser)', () => {
    expect(record('http://example.com/x')).toEqual({ handed: [], action: 'deny' })
  })

  it('file:// — NOT handed out (a dropped local file must not be opened by the OS on our behalf)', () => {
    expect(record('file:///tmp/evil.html')).toEqual({ handed: [], action: 'deny' })
  })

  it('mailto: / javascript: / empty — NOT handed out, never allowed', () => {
    expect(record('mailto:a@b.c')).toEqual({ handed: [], action: 'deny' })
    expect(record('javascript:alert(1)')).toEqual({ handed: [], action: 'deny' })
    expect(record('')).toEqual({ handed: [], action: 'deny' })
  })

  it('the effect gate is a gate in BOTH directions — exactly the https inputs are handed out', () => {
    // 成对判据：删掉 `if (decision.openExternally)` 让人人都被交出去，这条红在「不该交」那半边；
    // 把条件取反，它红在「该交」那半边。单看某一族用例都可能只杀掉一个方向。
    const handedOut = ['https://a', 'https://b/c?d=e']
    const heldBack = ['http://a', 'file:///a', 'ws://a', 'about:blank', 'mailto:a@b', '', 'not a url']
    for (const url of handedOut) expect(record(url).handed).toEqual([url])
    for (const url of heldBack) expect(record(url).handed).toEqual([])
  })

  it('action is deny for EVERY string input — this function opens no in-app child window either', () => {
    for (const url of ['https://a', 'http://a', 'file:///a', 'about:blank', '', 'not a url']) {
      expect(record(url).action).toBe('deny')
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// 接线层：AST 质询 index.ts 真的用了它，且喂进去的就是那个值
// ---------------------------------------------------------------------------------------------------
/**
 * 这一层的取值判据（`new BrowserWindow` 站点分类、preload 实参怎么算出来的、隔离开关按写法读）由
 * helpers/window-security-ast.ts **单份**实现，本文件与 window-security-reachability.test.ts 共用它。
 *
 * 为什么必须单份：那里最承重的一句是**绑定**判据（这个名字解析到我以为的那次 import 吗）。此前两个文件
 * 各抄一份，于是删掉那句的变异要改**两处**才能观测到——而真正的风险是下一次收紧只落在其中一个副本上，
 * 另一个静默留着弱判据。这正是这道守卫本身要防的形状（同一概念两份手抄必漂移）。
 *
 * 留在本文件里的是**只有主窗口这条路才有的判据**：setWindowOpenHandler 的整条接线，以及「webPreferences
 * 必须是那次工厂调用而不是内联对象」这条比 allow-list 更严的策略（隐藏的 import 窗口用内联字面量是被
 * 允许的，主窗口不允许——所以策略不能共用，只有机制能共用）。
 */
const MODULE_SPECIFIER = WINDOW_SECURITY_MODULE
const ELECTRON_MODULE = 'electron'
/**
 * webPreferencesShape 的自检 fixture 共用的 import 前导。收紧后的判据按**绑定**判 callee 与 `join`：
 * 合成片段若不带这两行 import，callee 的 importedFrom 会读成 null、`join` 会被判成 join-not-from-node-path，
 * 于是「诚实形状」的正向 fixture 反而对不上（记忆里 #452 的教训：强判据一旦不更新自检 fixture，自检会
 * 用弱前提放过一个仍然破的守卫）。带上它们，正向 fixture 与真文件走同一套绑定。故意省掉它们的负向
 * fixture（影子 callee / 影子 join）另写，各自钉住那条新判据认得出违规。
 */
const WEBPREFS_IMPORTS =
  `import { windowSecurityWebPreferences } from '${WINDOW_SECURITY_MODULE}'\n` +
  `import { join } from '${NODE_PATH_MODULE}'\n`

/** 本文件用的别名：解析一段合成源码（与真文件走同一条 parse 路径，故自检强度就是真文件强度）。 */
const parse = (source: string, label = '/synthetic/index.ts'): ParsedModule => parseModule(source, label)

/**
 * 主窗口那一个 BrowserWindow 站点的 webPreferences 形状。取值分类由共享模块给出，这里只把「主窗口只有
 * 第一个站点」这条约定收成一个更窄的返回：
 * - {shape:'factory-call'} 一次函数调用（我们要的：windowSecurityWebPreferences(<preload 路径>)）
 * - {shape:'inline-literal'} 一份内联对象字面量（主窗口就是要禁的：另手抄一份，取值即便正确也是第二个 SSOT）
 * - 其余 / 缺席
 *
 * `importedFrom` 按**绑定**判 callee 解析到哪里，不是比拼写。一个函数作用域里的同名影子（返回
 * contextIsolation:false / sandbox:false / nodeIntegration:true / webSecurity:false）拼写完全一样、真实的
 * 那份 import 还在文件顶部，于是老判据（只看 callee 的文本 + preload 实参）读出的还是合格的 call——主窗口
 * 的每个隔离开关被静默关掉而 32 条全绿、tsc 退 0。抓它的正是 `importedFrom`：名字对，绑定指向本地声明。
 */
function webPreferencesShape(module: ParsedModule): SiteVerdict {
  const [first] = browserWindowSites(module)
  return first ?? { shape: 'no-object-arg' }
}

/** 找 window.webContents.setWindowOpenHandler(cb) 的回调实参。 */
function setWindowOpenHandlerCallback(sf: ts.Node): ts.Node | null {
  let callback: ts.Node | null = null
  const visit = (node: ts.Node): void => {
    if (callback) return
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setWindowOpenHandler' &&
      node.arguments[0] !== undefined
    ) {
      callback = node.arguments[0]
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return callback
}

/**
 * 一个实参**从哪来**。这是本文件全部「喂进去的是不是那个值」判据的共用词汇，按绑定判而非按拼写判：
 * - `own-parameter`：解析到的声明落在**这个函数自己的形参表**里（我们要的：转发收到的那个值）
 * - `declared-elsewhere`：是个标识符，但声明在别处（外层常量、同名影子……）——即「钉死成固定值」
 * - `not-an-identifier`：字面量、调用、模板串……凡是不能是「原样转发」的形状
 * - `absent` / `unresolved`：实参缺席 / 本文件里查不到声明
 */
type ArgumentOrigin = 'own-parameter' | 'declared-elsewhere' | 'not-an-identifier' | 'absent' | 'unresolved'

function argumentOrigin(
  module: ParsedModule,
  argument: ts.Expression | undefined,
  fn: ts.ArrowFunction
): ArgumentOrigin {
  if (argument === undefined) return 'absent'
  if (!ts.isIdentifier(argument)) return 'not-an-identifier'
  const declaration = declarationOf(module, argument)
  if (declaration === null) return 'unresolved'
  // 参数的声明节点可能是 Parameter 本身，也可能是解构里的 BindingElement——往上走到 Parameter，再问它
  // 属于哪个函数。比位置区间（pos/end）更直接：解构、默认值、嵌套解构都不需要各写一条规则。
  let node: ts.Node | undefined = declaration
  while (node !== undefined) {
    if (ts.isParameter(node)) return node.parent === fn ? 'own-parameter' : 'declared-elsewhere'
    node = node.parent
  }
  return 'declared-elsewhere'
}

/**
 * 一个箭头函数体里**唯一那个表达式**。块体只有恰好一句 ExpressionStatement 时才算；`void x` 与括号是
 * 透明的（生产里写 `(t) => { void shell.openExternal(t) }` 是为了显式丢弃 Promise，不是第二件事）。
 *
 * 返回 null 表示「体里不止一个表达式」——那就有语句可插，正是本族缺陷的落脚点。
 */
function soleExpressionOf(fn: ts.ArrowFunction): ts.Expression | null {
  let expression: ts.Expression
  if (ts.isBlock(fn.body)) {
    const only = fn.body.statements.length === 1 ? fn.body.statements[0] : undefined
    if (only === undefined || !ts.isExpressionStatement(only)) return null
    expression = only.expression
  } else {
    expression = fn.body
  }
  while (ts.isVoidExpression(expression) || ts.isParenthesizedExpression(expression)) {
    expression = expression.expression
  }
  return expression
}

/**
 * 副作用实参的形状：它必须是一个箭头，体里**恰好一次方法调用**，且那个方法的 receiver 从 electron
 * import 进来、实参就是箭头自己收到的那个 target。
 */
type EffectShape =
  | { kind: 'absent' }
  | { kind: 'not-an-arrow' }
  | { kind: 'not-one-expression' }
  | { kind: 'not-a-method-call' }
  | {
      kind: 'method-call'
      method: string
      receiverImportedFrom: string | null
      target: ArgumentOrigin
      argumentCount: number
    }

function effectShape(module: ParsedModule, argument: ts.Expression | undefined): EffectShape {
  if (argument === undefined) return { kind: 'absent' }
  // 必须是**现场包的箭头**而不是摘下来的方法：`shell.openExternal` 是原生绑定，摘下来 receiver 就没了，
  // 在 Electron 里调用会抛 Illegal invocation——结局是弹窗判据算对了却什么也没打开（记忆
  // detached-method-loses-native-receiver，本仓吃过这个亏，window-security.ts 的注释也写明了这条规矩）。
  if (!ts.isArrowFunction(argument)) return { kind: 'not-an-arrow' }
  const expression = soleExpressionOf(argument)
  if (expression === null) return { kind: 'not-one-expression' }
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return { kind: 'not-a-method-call' }
  }
  const access = expression.expression
  return {
    kind: 'method-call',
    method: access.name.text,
    receiverImportedFrom: importedModuleOf(declarationOf(module, access.expression)),
    target: argumentOrigin(module, expression.arguments[0], argument),
    argumentCount: expression.arguments.length
  }
}

/**
 * setWindowOpenHandler 的整条接线：回调体**就是**一次把收到的 url 转发给那个 import 进来的纯函数，
 * 并把「交给系统浏览器」这唯一的副作用现场包成箭头传进去。
 *
 * 判据全部按**绑定**判。此前这一版按**文本**判（只比对标识符拼写，且只看 callee 与 arguments[0]），实测
 * 有四种改法在 24/24 全绿下存活，每一种都是真能力：
 *   1. 把 import 改成别名、另写一个同名本地函数返回 `{action:'allow'}` → 应用内弹窗判据从 deny 翻成 allow。
 *      抓它的是 `decision.importedFrom`：名字一样，但绑定不再指向那次 import。
 *   2. 声明一个外层 `const url = 'https://pinned…'`、把解构的形参改名 → 判定对象被钉死成固定值，行为层
 *      完全看不见（它测的是纯函数，压根不知道生产喂了什么）。抓它的是 `urlArgument`。
 *   3. 副作用里改成 `shell.openExternal('https://attacker…')` → 任意攻击者选定的 URL 被交给系统浏览器。
 *      抓它的是 `effect.target`：不再是箭头自己收到的那个值。
 *   4. 直接传 `shell.openExternal`（摘方法）→ 抛 Illegal invocation，什么也打不开。抓它的是 `effect.kind`。
 * 另外四种此前连模型都没有的形状也一并钉住：多传一个实参（`argumentCount`）、副作用体里插语句或加条件
 * （`not-one-expression`）、用逗号表达式塞第二件事（`not-a-method-call`）。
 *
 * 回调体本身仍要求**简洁体**：一旦有块体就有语句可插，那正是 #665 实测存活的那个变异的形状（在派生的
 * return 之前插一句可达的 `return { action: 'allow' as const }`，原句留在后面成死代码）。
 *
 * 已申报的盲点：判据只认「原样转发同一个绑定」，不追踪值本身。若有人把 url 先经一个本文件内的纯函数
 * 变换再转发，`urlArgument` 会读成 `not-an-identifier` 而报红——宁可误伤也不放过，因为放过的那一侧是
 * 攻击者可控的 URL。
 */
type WindowOpenWiring =
  | { kind: 'no-handler' }
  | { kind: 'not-an-arrow' }
  | { kind: 'block-body' }
  | { kind: 'body-is-not-a-call' }
  | {
      kind: 'forwards-decision'
      decision: { callee: string; importedFrom: string | null }
      urlArgument: ArgumentOrigin
      argumentCount: number
      effect: EffectShape
    }

function windowOpenWiring(module: ParsedModule): WindowOpenWiring {
  const callback = setWindowOpenHandlerCallback(module.sourceFile)
  if (callback === null) return { kind: 'no-handler' }
  if (!ts.isArrowFunction(callback)) return { kind: 'not-an-arrow' }
  if (ts.isBlock(callback.body)) return { kind: 'block-body' }
  const body = callback.body
  if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression)) return { kind: 'body-is-not-a-call' }
  return {
    kind: 'forwards-decision',
    decision: {
      callee: body.expression.text,
      importedFrom: importedModuleOf(declarationOf(module, body.expression))
    },
    urlArgument: argumentOrigin(module, body.arguments[0], callback),
    argumentCount: body.arguments.length,
    effect: effectShape(module, body.arguments[1])
  }
}

/** 生产接线该长的样子。每个字段都是一条独立判据，上面的注释逐条说明它抓的是哪种改法。 */
const HONEST_WIRING: WindowOpenWiring = {
  kind: 'forwards-decision',
  decision: { callee: 'windowOpenOutcome', importedFrom: MODULE_SPECIFIER },
  urlArgument: 'own-parameter',
  argumentCount: 2,
  effect: {
    kind: 'method-call',
    method: 'openExternal',
    receiverImportedFrom: ELECTRON_MODULE,
    target: 'own-parameter',
    argumentCount: 1
  }
}

describe('index.ts wiring: it imports and USES the security module (AST, not text scan)', () => {
  const indexModule = parseModuleFile(indexPath)

  it('imports both the webPreferences factory and the popup outcome from window-security', () => {
    const names = namedImportsFrom(indexModule, MODULE_SPECIFIER)
    expect(names).toContain('windowSecurityWebPreferences')
    expect(names).toContain('windowOpenOutcome')
  })

  it("BrowserWindow's webPreferences value IS the factory call, not a re-authored object literal", () => {
    // 这条正是接线层专属判据：即便有人内联一份取值完全正确的对象字面量（行为层全绿），这里也会红，
    // 因为 webPreferences 的值变成了 object 而不是对 windowSecurityWebPreferences 的调用。
    //
    // 也判到 callee 的**绑定**与 preload 那个实参：
    // - `importedFrom` 抓「函数作用域里另写一个同名影子把四个隔离开关全关掉」——callee 拼写一样、真的
    //   import 还在顶部，实测 32 条全绿、tsc 退 0；名字对而绑定指向本地声明（null）。
    // - preload 实参此前只判 callee，实测把它改成 '../preload/evil.cjs' 后 41 条全绿；再往里，把 `join`
    //   影子成 `const join = (_b, _r) => '/tmp/evil/preload.cjs'`（基点与字面量都保留）也曾 32 条全绿——
    //   两者都指向那座特权桥的入口，所以判到取值且要求 join 绑定到 node:path。
    expect(webPreferencesShape(indexModule)).toEqual({
      shape: 'factory-call',
      callee: 'windowSecurityWebPreferences',
      importedFrom: MODULE_SPECIFIER,
      preload: { kind: 'join-from-module-dir', relativePath: PRELOAD_RELATIVE_PATH }
    })
  })

  it('the preload filename this guard pins is the one electron-vite actually emits', () => {
    // 上一条把 preload 路径钉成字面量，而那个文件名的真正 SSOT 在构建配置里。两个该联动的常量分居两文件
    // 就一定会漂移（记忆 ctxmux-endpoint-frozen-across-versions），所以这里让构建配置来核对它：改了
    // entryFileNames 而没改 index.ts，这条会红并指出该改哪里。
    const viteConfig = readFileSync(join(here, '..', 'electron.vite.config.ts'), 'utf8')
    const emitted = /entryFileNames:\s*'([^']+)'/.exec(viteConfig)?.[1]
    expect(emitted).toBe(basename(PRELOAD_RELATIVE_PATH))
  })

  it('the setWindowOpenHandler callback forwards the INCOMING url to the IMPORTED outcome, with the effect wrapped here', () => {
    // 整条接线一次比完：callee 的绑定、url 的来处、实参个数、副作用的形状/receiver/转发对象。任何一项
    // 单独改坏都会红，且 diff 直接指出坏的是哪一项。
    expect(windowOpenWiring(indexModule)).toEqual(HONEST_WIRING)
  })
})

describe('index.ts wiring guard: self-check (the guard reds on a planted violation)', () => {
  // 若不自检，这道 AST 守卫可能恒绿（枚举器悄悄不再匹配任何东西）。这里对每条判据种下它该抓的违规，
  // 断言判据确实认出违规——从而证明上面那三条不是恒真。合成片段与真文件走的是**同一个** parse()，
  // 所以自检证明的强度就是真文件上的强度，不存在「自检走弱判据」的分岔。

  const PREAMBLE =
    "import { shell } from 'electron'\n" +
    "import { windowOpenOutcome } from './window-security.js'\n" +
    'declare const win: any\n'
  /** 把一段回调源码放进与生产同构的上下文里（同样的两个 import + 同样的调用点）。 */
  const handler = (callback: string): ParsedModule =>
    parse(`${PREAMBLE}win.webContents.setWindowOpenHandler(${callback})`)
  const HONEST_CALLBACK = '({ url }) => windowOpenOutcome(url, (t) => { void shell.openExternal(t) })'

  it('namedImportsFrom returns [] when the module is not imported at all', () => {
    const noImport = parse("import { app } from 'electron'\nconst x = new BrowserWindow({})")
    expect(namedImportsFrom(noImport, MODULE_SPECIFIER)).toEqual([])
    // 对照：真的 import 了就认得出。
    const withImport = parse(
      "import { windowSecurityWebPreferences, windowOpenOutcome } from './window-security.js'"
    )
    expect(namedImportsFrom(withImport, MODULE_SPECIFIER)).toEqual([
      'windowSecurityWebPreferences',
      'windowOpenOutcome'
    ])
  })

  it("webPreferencesShape reports {shape:'inline-literal'} for an inlined (even correct) literal — the forbidden shape for the MAIN window", () => {
    const inlined = parse(
      'const w = new BrowserWindow({ webPreferences: { preload: p, contextIsolation: true, sandbox: true, nodeIntegration: false } })'
    )
    // 内联对象字面量：取值全对，但形状是 object 而非 call。守卫据此报红。webSecurity 缺席读成 'missing'，
    // preload 是裸标识符 `p`（不是 join 调用）故读成 not-a-join——两个新字段都由共享分类器一并读出。
    expect(webPreferencesShape(inlined)).toEqual({
      shape: 'inline-literal',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: 'missing',
      preload: { kind: 'not-a-join' }
    })
    // 对照：真正的调用形状被认成 call，callee 的绑定与 preload 实参的来处一并读出。fixture 带上生产同款
    // 的两行 import（见 WEBPREFS_IMPORTS 注释），callee 才解析到 window-security、join 才解析到 node:path。
    const viaCall = parse(
      `${WEBPREFS_IMPORTS}const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })`
    )
    expect(webPreferencesShape(viaCall)).toEqual({
      shape: 'factory-call',
      callee: 'windowSecurityWebPreferences',
      importedFrom: MODULE_SPECIFIER,
      preload: { kind: 'join-from-module-dir', relativePath: PRELOAD_RELATIVE_PATH }
    })
  })

  it('webPreferencesShape catches a function-scoped shadow of the factory even though the callee text is identical', () => {
    // 事故形状（exploit A）：真的 import 仍在文件顶部，但在建窗的函数作用域里另写一个同名影子，把四个
    // 隔离开关全关掉（contextIsolation/sandbox → false、nodeIntegration → true、webSecurity → false）。
    // callee 的拼写一模一样，只有绑定变了——老判据只比 callee 文本 + preload 实参，实测 32 条全绿、tsc
    // 退 0。抓它的是 importedFrom：名字对，绑定指向本地声明（null）而非那次 import。
    // 盲点：它只认「callee 绑定是不是那次 import」，不追工厂返回值的取值——那由行为层直接质询纯函数守。
    const shadowed = parse(
      "import { windowSecurityWebPreferences as real } from './window-security.js'\n" +
        "import { join } from 'node:path'\n" +
        'function buildWindow() {\n' +
        '  const windowSecurityWebPreferences = (p: string) => ({ preload: p, contextIsolation: false, sandbox: false, nodeIntegration: true, webSecurity: false })\n' +
        `  return new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })\n` +
        '}'
    )
    expect(webPreferencesShape(shadowed)).toMatchObject({ shape: 'factory-call', callee: 'windowSecurityWebPreferences', importedFrom: null })
    expect(webPreferencesShape(shadowed)).not.toEqual({
      shape: 'factory-call',
      callee: 'windowSecurityWebPreferences',
      importedFrom: MODULE_SPECIFIER,
      preload: { kind: 'join-from-module-dir', relativePath: PRELOAD_RELATIVE_PATH }
    })
  })

  it('webPreferencesShape catches a function-scoped shadow of join even though the join text is identical', () => {
    // 事故形状（exploit B）：`join` 的 import 仍在顶部，但函数作用域里 `const join = (_b, _r) =>
    // '/tmp/evil/preload.cjs'` 影子把 preload 重指到任意路径，import.meta.dirname 基点与字面量相对路径
    // 都原样保留。老判据只比 argument.expression.text === 'join'，读出的还是合格的 join-from-module-dir，
    // 实测 32 条全绿、tsc 退 0。抓它的是「join 的绑定必须是 node:path」：名字对，绑定指向本地影子。
    // 盲点：它只认 join 这一个名字的绑定，不追 import.meta.dirname 之外的其它基点算法（那由 not-rooted 守）。
    const shadowed = parse(
      "import { windowSecurityWebPreferences } from './window-security.js'\n" +
        "import { join } from 'node:path'\n" +
        'function buildWindow() {\n' +
        "  const join = (_b: string, _r: string) => '/tmp/evil/preload.cjs'\n" +
        `  return new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '${PRELOAD_RELATIVE_PATH}')) })\n` +
        '}'
    )
    expect(webPreferencesShape(shadowed)).toMatchObject({ shape: 'factory-call', preload: { kind: 'join-not-from-node-path' } })
  })

  it('webPreferencesShape catches a repointed preload path and a drifting base directory', () => {
    // 一个 review agent 实测过：把这个实参改成 '../preload/evil.cjs' 时 41 条全绿。preload 就是那座特权桥
    // 的入口，指错等于给 renderer 装了一座不受控的桥（拿到完整 ipcRenderer）——所以这条必须判到取值。
    // 这些 fixture 都带上 WEBPREFS_IMPORTS：收紧后的判据要求 `join` 绑定到 node:path，不带 import 会先被
    // 判成 join-not-from-node-path，读不到下面这些「取值/基点」层面的判据。
    const repointed = parse(
      `${WEBPREFS_IMPORTS}const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '../preload/evil.cjs')) })`
    )
    expect(webPreferencesShape(repointed)).toMatchObject({
      preload: { kind: 'join-from-module-dir', relativePath: '../preload/evil.cjs' }
    })
    // 基点换成 cwd：取值那一半仍然「正确」，但路径从此随启动方式漂移（双击 vs 终端 vs 打包）。判据落在
    // 基点上，所以这种改法也认得出。
    const cwdBased = parse(
      `${WEBPREFS_IMPORTS}const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(process.cwd(), '${PRELOAD_RELATIVE_PATH}')) })`
    )
    expect(webPreferencesShape(cwdBased)).toMatchObject({ preload: { kind: 'not-rooted-at-module-dir' } })
    // 不经 join 直接给一个串，以及整个实参缺席。
    expect(
      webPreferencesShape(parse("const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences('/abs/preload.cjs') })"))
    ).toMatchObject({ preload: { kind: 'not-a-join' } })
    expect(
      webPreferencesShape(parse('const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences() })'))
    ).toMatchObject({ preload: { kind: 'absent' } })
    // 拼出来的路径（变量、模板串）也不合格：判据要能逐字比对那个相对路径。
    expect(
      webPreferencesShape(parse(`${WEBPREFS_IMPORTS}const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, chosen)) })`))
    ).toMatchObject({ preload: { kind: 'not-a-literal-path' } })
  })

  it('the honest shape — and ONLY the honest shape — matches HONEST_WIRING', () => {
    // 正向锚点：合成的诚实接线与真文件比出同一个结果。缺了这条，下面每一条「违规被认出」都可能是因为
    // 判据对**所有**输入都返回同一个错值（恒红也是一种坏判据）。
    expect(windowOpenWiring(handler(HONEST_CALLBACK))).toEqual(HONEST_WIRING)
    // 显式丢弃 Promise 的 `void` 是可有可无的写法差异，不是第二件事：两种写法都该算诚实。
    expect(windowOpenWiring(handler('({ url }) => windowOpenOutcome(url, (t) => shell.openExternal(t))'))).toEqual(
      HONEST_WIRING
    )
  })

  it('rejects a block body even when that block DOES call the right function', () => {
    // 这条是本守卫的承重自检：判据必须是「体就是这次调用」，不是「体里调了它」。下面这个形状调对了
    // 函数、返回了它的结果，却在前面插了一句可达的 return——正是 #665 实测存活的那个变异的形状。
    const hijacked = handler(
      "({ url }) => { if (true) return { action: 'allow' }; return windowOpenOutcome(url, (t) => { void shell.openExternal(t) }) }"
    )
    expect(windowOpenWiring(hijacked)).toEqual({ kind: 'block-body' })

    // 连一句不带任何劫持的「先取值再返回」也不合格——只要块体在，就永远有下一次插语句的地方。
    const blockButClean = handler(
      '({ url }) => { return windowOpenOutcome(url, (t) => { void shell.openExternal(t) }) }'
    )
    expect(windowOpenWiring(blockButClean)).toEqual({ kind: 'block-body' })

    // 完全不走纯函数：体是对象字面量而非调用。
    expect(windowOpenWiring(handler("({ url }) => ({ action: 'allow' })"))).toEqual({ kind: 'body-is-not-a-call' })
  })

  it('rejects a same-named LOCAL function even though the text of the callee is identical', () => {
    // #665 存活变异之一，也是「按文本判」最贵的那个盲点：把 import 改成别名，另写一个同名本地函数返回
    // allow。callee 的拼写一模一样，只有绑定变了——这正是必须带 checker 的理由。
    const shadowed = parse(
      "import { shell } from 'electron'\n" +
        "import { windowOpenOutcome as realOutcome } from './window-security.js'\n" +
        'declare const win: any\n' +
        "const windowOpenOutcome = (u: string, f: (t: string) => void) => ({ action: 'allow' as const })\n" +
        `win.webContents.setWindowOpenHandler(${HONEST_CALLBACK})`
    )
    const wiring = windowOpenWiring(shadowed)
    // 名字仍是对的，绑定不是——判据落在 importedFrom 上。
    expect(wiring).toMatchObject({ decision: { callee: 'windowOpenOutcome', importedFrom: null } })
    expect(wiring).not.toEqual(HONEST_WIRING)
  })

  it('rejects a pinned url (an outer constant shadowing the destructured parameter)', () => {
    // #665 存活变异之二：判定对象被钉死成常量，行为层完全看不见（它测的是纯函数）。这里 url 这个名字
    // 依然出现在实参位置，只是它解析到外层那个 const——按拼写判会放过，按绑定判抓得住。
    const pinned = parse(
      `${PREAMBLE}const url = 'https://pinned.example'\n` +
        'win.webContents.setWindowOpenHandler(({ url: incoming }) => windowOpenOutcome(url, (t) => { void shell.openExternal(t) }))'
    )
    expect(windowOpenWiring(pinned)).toMatchObject({ urlArgument: 'declared-elsewhere' })

    // 连「不是标识符」的钉死写法一起认出（`windowOpenOutcome('https://x', …)`）。
    expect(
      windowOpenWiring(handler("({ url }) => windowOpenOutcome('https://x', (t) => { void shell.openExternal(t) })"))
    ).toMatchObject({ urlArgument: 'not-an-identifier' })
  })

  it('rejects an effect that opens anything other than the target it was handed', () => {
    // #665 存活变异之三：副作用打开攻击者选定的 URL。三种拼法各认一次——字面量、外层常量、经手变换。
    const cases: Array<[string, ArgumentOrigin]> = [
      ["({ url }) => windowOpenOutcome(url, (t) => { void shell.openExternal('https://attacker.example') })", 'not-an-identifier'],
      ['({ url }) => windowOpenOutcome(url, () => { void shell.openExternal(url) })', 'declared-elsewhere'],
      ['({ url }) => windowOpenOutcome(url, (t) => { void shell.openExternal(mangle(t)) })', 'not-an-identifier']
    ]
    for (const [callback, target] of cases) {
      expect(windowOpenWiring(handler(callback))).toMatchObject({ effect: { kind: 'method-call', target } })
    }
  })

  it('rejects a detached method, a missing effect, and a foreign receiver', () => {
    // #665 存活变异之四（摘方法：抛 Illegal invocation，什么都打不开），外加同族的另两种。
    expect(windowOpenWiring(handler('({ url }) => windowOpenOutcome(url, shell.openExternal)'))).toMatchObject({
      effect: { kind: 'not-an-arrow' }
    })
    expect(windowOpenWiring(handler('({ url }) => windowOpenOutcome(url)'))).toMatchObject({
      effect: { kind: 'absent' },
      argumentCount: 1
    })
    // receiver 不是那个 import 进来的 shell：`openExternal` 这个方法名可以出现在任何对象上。
    expect(
      windowOpenWiring(handler('({ url }) => windowOpenOutcome(url, (t) => { void fake.openExternal(t) })'))
    ).toMatchObject({ effect: { kind: 'method-call', receiverImportedFrom: null } })
  })

  it('rejects a second thing smuggled into the effect body (statement / condition / comma) and an extra argument', () => {
    // 这三种此前连模型都没有：旧判据只看 callee 与 arguments[0]，副作用体里想插什么都行。
    const smuggled = [
      '({ url }) => windowOpenOutcome(url, (t) => { log(t); void shell.openExternal(t) })',
      '({ url }) => windowOpenOutcome(url, (t) => { if (t) void shell.openExternal(t) })'
    ]
    for (const callback of smuggled) {
      expect(windowOpenWiring(handler(callback))).toMatchObject({ effect: { kind: 'not-one-expression' } })
    }
    // 逗号表达式：只有一个 ExpressionStatement，但它不是那次方法调用。
    expect(
      windowOpenWiring(handler('({ url }) => windowOpenOutcome(url, (t) => { void (log(t), shell.openExternal(t)) })'))
    ).toMatchObject({ effect: { kind: 'not-a-method-call' } })
    // 多喂一个实参也认出来：纯函数今天只收两个，第三个参数意味着有人改了那份合同。
    expect(
      windowOpenWiring(handler('({ url }) => windowOpenOutcome(url, (t) => { void shell.openExternal(t) }, true)'))
    ).toMatchObject({ argumentCount: 3 })
  })

  it('reports no-handler when the wiring is gone entirely', () => {
    // 最后一种恒绿风险：枚举器找不到调用点时必须响亮，不能读成「一切正常」。
    expect(windowOpenWiring(parse(`${PREAMBLE}const x = 1`))).toEqual({ kind: 'no-handler' })
  })
})
