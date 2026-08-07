import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import {
  windowOpenDecision,
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
 * - 行为层：直接 import 纯函数，逐开关断言取值（不是「键在场」），弹窗判据按 url 分类穷举。
 * - 接线层：走 TS parser（AST），断言 index.ts 真的 import 了这个模块、webPreferences 的值**就是**那次
 *   调用（而非另手抄一份对象字面量）、setWindowOpenHandler 的判定**来自**那个纯函数。文本判据（裸标识符
 *   能绕过、不问喂进去的是不是那个值）在这里被明确拒绝。
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

  it('empty string — denied, not handed out (never crashes, never allows)', () => {
    expect(windowOpenDecision('')).toEqual({ action: 'deny', openExternally: false })
  })

  it('action is deny for EVERY input — the app opens no child windows', () => {
    // 分类穷举的收束断言：无论什么 scheme，action 恒为 deny。把 deny 翻成 allow 会让这条整批红。
    for (const url of ['https://a', 'http://a', 'file:///a', 'ws://a', 'about:blank', '', 'not a url']) {
      expect(windowOpenDecision(url).action).toBe('deny')
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

/** 某个子树里有没有对具名标识符 name 的直接调用（f(...)）。 */
function callsIdentifier(root: ts.Node, name: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

/** setWindowOpenHandler 回调 return 的对象里 action 的值形状。 */
function returnedActionKind(fn: ts.Node): 'string-literal' | 'property-access' | 'other' | 'none' {
  let kind: 'string-literal' | 'property-access' | 'other' | 'none' = 'none'
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      const init = propertyInitializer(node.expression, 'action')
      if (init) {
        if (ts.isStringLiteralLike(init)) kind = 'string-literal'
        else if (ts.isPropertyAccessExpression(init)) kind = 'property-access'
        else kind = 'other'
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)
  return kind
}

describe('index.ts wiring: it imports and USES the security module (AST, not text scan)', () => {
  const indexSf = sourceFileOf(readFileSync(indexPath, 'utf8'))

  it('imports both the webPreferences factory and the popup decision from window-security', () => {
    const names = namedImportsFrom(indexSf, MODULE_SPECIFIER)
    expect(names).toContain('windowSecurityWebPreferences')
    expect(names).toContain('windowOpenDecision')
  })

  it("BrowserWindow's webPreferences value IS the factory call, not a re-authored object literal", () => {
    // 这条正是接线层专属判据：即便有人内联一份取值完全正确的对象字面量（行为层全绿），这里也会红，
    // 因为 webPreferences 的值变成了 object 而不是对 windowSecurityWebPreferences 的调用。
    expect(webPreferencesShape(indexSf)).toEqual({ kind: 'call', callee: 'windowSecurityWebPreferences' })
  })

  it('setWindowOpenHandler routes its decision through windowOpenDecision, and returns the derived action', () => {
    const callback = setWindowOpenHandlerCallback(indexSf)
    expect(callback).not.toBeNull()
    // 判定来自纯函数：回调体里真的调了 windowOpenDecision。
    expect(callsIdentifier(callback as ts.Node, 'windowOpenDecision')).toBe(true)
    // 且返回的 action 是从判定取的（属性访问，如 decision.action），不是又硬编码一个字符串字面量——
    // 后者会让「deny→allow」的翻转脱离受行为层保护的纯函数。
    expect(returnedActionKind(callback as ts.Node)).toBe('property-access')
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
      "import { windowSecurityWebPreferences, windowOpenDecision } from './window-security.js'"
    )
    expect(namedImportsFrom(withImport, MODULE_SPECIFIER)).toEqual([
      'windowSecurityWebPreferences',
      'windowOpenDecision'
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

  it('the popup checks catch a hardcoded handler that never calls the decision', () => {
    const hardcoded = sourceFileOf(
      "win.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('https://')) shell.openExternal(url); return { action: 'deny' } })"
    )
    const cb = setWindowOpenHandlerCallback(hardcoded)
    expect(cb).not.toBeNull()
    // 没走纯函数：不调 windowOpenDecision。
    expect(callsIdentifier(cb as ts.Node, 'windowOpenDecision')).toBe(false)
    // 且 action 是硬编码字符串字面量，翻转它不会触发行为层。
    expect(returnedActionKind(cb as ts.Node)).toBe('string-literal')

    // 对照：真正接线的形状被认成 property-access 且调了 windowOpenDecision。
    const wired = sourceFileOf(
      'win.webContents.setWindowOpenHandler(({ url }) => { const d = windowOpenDecision(url); if (d.openExternally) shell.openExternal(url); return { action: d.action } })'
    )
    const wiredCb = setWindowOpenHandlerCallback(wired)
    expect(callsIdentifier(wiredCb as ts.Node, 'windowOpenDecision')).toBe(true)
    expect(returnedActionKind(wiredCb as ts.Node)).toBe('property-access')
  })
})
