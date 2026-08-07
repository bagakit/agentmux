import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import {
  windowOpenDecision,
  windowOpenOutcome,
  windowSecurityWebPreferences
} from '../src/main/window-security.js'

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

  it('action is deny for EVERY input — this function opens no in-app child window either', () => {
    for (const url of ['https://a', 'http://a', 'file:///a', 'about:blank', '', 'not a url']) {
      expect(record(url).action).toBe('deny')
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// 接线层：AST 质询 index.ts 真的用了它，且喂进去的就是那个值
// ---------------------------------------------------------------------------------------------------
const MODULE_SPECIFIER = './window-security.js'

function sourceFileOf(source: string, label = 'index.ts'): ts.SourceFile {
  return ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 从某模块 specifier 具名 import 进来的名字集合（import 关系判据，不是文本拼法）。 */
function namedImportsFrom(sf: ts.SourceFile, moduleSpecifier: string): string[] {
  const names: string[] = []
  sf.forEachChild((node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === moduleSpecifier
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push(element.name.text)
      }
    }
  })
  return names
}

function findNewExpression(sf: ts.Node, ctorName: string): ts.NewExpression | null {
  let found: ts.NewExpression | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === ctorName) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function propertyInitializer(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of obj.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) {
      return property.initializer
    }
  }
  return null
}

/**
 * new BrowserWindow(...) 第一个实参对象里 webPreferences 的值是什么形状：
 * - {kind:'call',callee} 一次函数调用（我们要的：windowSecurityWebPreferences(...)）
 * - {kind:'object'} 一份内联对象字面量（就是要禁的：另手抄一份，取值即便正确也是第二个 SSOT）
 * - {kind:'other'|'absent'} 其它 / 缺席
 */
function webPreferencesShape(
  sf: ts.SourceFile
): { kind: 'call'; callee: string } | { kind: 'object' } | { kind: 'other' } | { kind: 'absent' } {
  const nw = findNewExpression(sf, 'BrowserWindow')
  if (!nw || !nw.arguments || nw.arguments.length === 0) return { kind: 'absent' }
  const arg0 = nw.arguments[0]
  if (!ts.isObjectLiteralExpression(arg0)) return { kind: 'other' }
  const init = propertyInitializer(arg0, 'webPreferences')
  if (!init) return { kind: 'absent' }
  if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) return { kind: 'call', callee: init.expression.text }
  if (ts.isObjectLiteralExpression(init)) return { kind: 'object' }
  return { kind: 'other' }
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
      node.arguments.length >= 1
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
 * setWindowOpenHandler 回调体的形状：它**就是**一次具名函数调用吗，调的是谁，第一个实参是哪个名字。
 *
 * 判据刻意是「体就是这一次调用」而不是「体里有这次调用」。后者是此前那版守卫的形状，实测可绕：在派生的
 * `return { action: decision.action }` 之前插一句可达的 `return { action: 'allow' as const }`，原句留在
 * 后面成死代码，而守卫遍历所有 return 并保留最后走到的那个，于是 17/17 全绿。只要回调体是**简洁体**
 * （没有花括号），就一句话也插不进去——多加任何一条语句都会强制变成块体，这里当场返回 null。
 *
 * 也钉住第一个实参是那个解构出来的 `url`：否则 `windowOpenOutcome('https://x', …)` 这种把判定对象换成
 * 常量的写法，形状与行为层都拦不住（行为层测的是纯函数，压根不知道生产喂了什么）。
 */
function forwardedCall(fn: ts.Node): { callee: string; firstArgument: string } | null {
  if (!ts.isArrowFunction(fn)) return null
  if (ts.isBlock(fn.body)) return null
  const body = fn.body
  if (!ts.isCallExpression(body) || !ts.isIdentifier(body.expression)) return null
  const arg0 = body.arguments[0]
  return {
    callee: body.expression.text,
    firstArgument: arg0 !== undefined && ts.isIdentifier(arg0) ? arg0.text : '<not an identifier>'
  }
}

describe('index.ts wiring: it imports and USES the security module (AST, not text scan)', () => {
  const indexSf = sourceFileOf(readFileSync(indexPath, 'utf8'))

  it('imports both the webPreferences factory and the popup outcome from window-security', () => {
    const names = namedImportsFrom(indexSf, MODULE_SPECIFIER)
    expect(names).toContain('windowSecurityWebPreferences')
    expect(names).toContain('windowOpenOutcome')
  })

  it("BrowserWindow's webPreferences value IS the factory call, not a re-authored object literal", () => {
    // 这条正是接线层专属判据：即便有人内联一份取值完全正确的对象字面量（行为层全绿），这里也会红，
    // 因为 webPreferences 的值变成了 object 而不是对 windowSecurityWebPreferences 的调用。
    expect(webPreferencesShape(indexSf)).toEqual({ kind: 'call', callee: 'windowSecurityWebPreferences' })
  })

  it('the setWindowOpenHandler callback body IS one forward of the incoming url to windowOpenOutcome', () => {
    // 判据不是「体里调了它」而是「体就是这次调用」：这样回调里没有任何语句可以被劫持，判定与副作用
    // 全部落在受行为层直接质询的纯函数里。
    const callback = setWindowOpenHandlerCallback(indexSf)
    expect(callback).not.toBeNull()
    expect(forwardedCall(callback as ts.Node)).toEqual({
      callee: 'windowOpenOutcome',
      firstArgument: 'url'
    })
  })
})

describe('index.ts wiring guard: self-check (the guard reds on a planted violation)', () => {
  // 若不自检，这道 AST 守卫可能恒绿（枚举器悄悄不再匹配任何东西）。这里对每条判据种下它该抓的违规，
  // 断言判据确实认出违规——从而证明上面那三条不是恒真。

  it('namedImportsFrom returns [] when the module is not imported at all', () => {
    const noImport = sourceFileOf("import { app } from 'electron'\nconst x = new BrowserWindow({})")
    expect(namedImportsFrom(noImport, MODULE_SPECIFIER)).toEqual([])
    // 对照：真的 import 了就认得出。
    const withImport = sourceFileOf(
      "import { windowSecurityWebPreferences, windowOpenOutcome } from './window-security.js'"
    )
    expect(namedImportsFrom(withImport, MODULE_SPECIFIER)).toEqual([
      'windowSecurityWebPreferences',
      'windowOpenOutcome'
    ])
  })

  it('webPreferencesShape reports {kind:object} for an inlined (even correct) literal — the forbidden shape', () => {
    const inlined = sourceFileOf(
      'const w = new BrowserWindow({ webPreferences: { preload: p, contextIsolation: true, sandbox: true, nodeIntegration: false } })'
    )
    // 内联对象字面量：取值全对，但形状是 object 而非 call。守卫据此报红。
    expect(webPreferencesShape(inlined)).toEqual({ kind: 'object' })
    // 对照：真正的调用形状被认成 call。
    const viaCall = sourceFileOf('const w = new BrowserWindow({ webPreferences: windowSecurityWebPreferences(p) })')
    expect(webPreferencesShape(viaCall)).toEqual({ kind: 'call', callee: 'windowSecurityWebPreferences' })
  })

  it('forwardedCall rejects a block body even when that block DOES call the right function', () => {
    // 这条是本守卫的承重自检：判据必须是「体就是这次调用」，不是「体里调了它」。下面这个形状调对了
    // 函数、返回了它的结果，却在前面插了一句可达的 return——正是 #665 实测存活的那个变异的形状。
    // 判据认它为 null（不合格），因为一旦有块体就有语句可插。
    const hijacked = sourceFileOf(
      "win.webContents.setWindowOpenHandler(({ url }) => { if (true) return { action: 'allow' }; return windowOpenOutcome(url, open) })"
    )
    expect(forwardedCall(setWindowOpenHandlerCallback(hijacked) as ts.Node)).toBeNull()

    // 连一句不带任何劫持的「先取值再返回」也不合格——只要块体在，就永远有下一次插语句的地方。
    const blockButClean = sourceFileOf(
      'win.webContents.setWindowOpenHandler(({ url }) => { return windowOpenOutcome(url, open) })'
    )
    expect(forwardedCall(setWindowOpenHandlerCallback(blockButClean) as ts.Node)).toBeNull()
  })

  it('forwardedCall catches a hardcoded handler and a hardcoded url — the two ways to bypass the pure function', () => {
    // 完全不走纯函数：体是对象字面量而非调用。
    const hardcoded = sourceFileOf(
      "win.webContents.setWindowOpenHandler(({ url }) => ({ action: 'allow' }))"
    )
    expect(forwardedCall(setWindowOpenHandlerCallback(hardcoded) as ts.Node)).toBeNull()

    // 形状合格、调的也是对的函数，但判定对象被换成常量：行为层看不见（它测的是纯函数），
    // 只有「第一个实参是那个 url」这半条判据能抓。
    const constantUrl = sourceFileOf(
      "win.webContents.setWindowOpenHandler(({ url }) => windowOpenOutcome('https://x', open))"
    )
    expect(forwardedCall(setWindowOpenHandlerCallback(constantUrl) as ts.Node)).toEqual({
      callee: 'windowOpenOutcome',
      firstArgument: '<not an identifier>'
    })

    // 对照：真正接线的形状被完整认出。
    const wired = sourceFileOf(
      'win.webContents.setWindowOpenHandler(({ url }) => windowOpenOutcome(url, (t) => { void shell.openExternal(t) }))'
    )
    expect(forwardedCall(setWindowOpenHandlerCallback(wired) as ts.Node)).toEqual({
      callee: 'windowOpenOutcome',
      firstArgument: 'url'
    })
  })
})
