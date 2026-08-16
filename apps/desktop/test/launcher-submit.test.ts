import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { launcherCanLaunch, launcherKeydownLaunches } from '../src/renderer/src/lib/launcher-submit.js'
import { SHORTCUT_BINDINGS, type ShortcutEvent } from '../src/renderer/src/lib/shortcut-registry.js'

// 起点页原本一个键都按不出来：五个动作全是鼠标。用户敲完 prompt 必须去摸鼠标才能发车，而下游每个
// agent 面都吃同一个 Cmd+Enter。这一族守的是两层，各自能独立变红：
//   行为层 —— 「能不能启动」「这次按键要不要启动」这两次判定算得对；
//   接线层 —— textarea 真的挂了这个处理器、真的把结论用上了，而不只是 import 了它。
// 本仓教训：抽进 lib 只解决一半（内容变可测了，壳有没有执行到照旧无人守）。

const SOURCE_ROOT = resolve(__dirname, '../src/renderer/src')

function readSource(relative: string): string {
  return readFileSync(resolve(SOURCE_ROOT, relative), 'utf8')
}

function parse(relative: string): ts.SourceFile {
  const path = resolve(SOURCE_ROOT, relative)
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** 一个表达式是不是**裸的** `isMacPlatform()` 调用（零实参）。取反、带参、别的调用都不是。 */
function isBareMacProbe(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'isMacPlatform' &&
    node.arguments.length === 0
  )
}

/**
 * 把 onKeyDown 守卫里那次 `launcherKeydownLaunches(event, <平台>, readiness)` 调用的**第 2 个实参**
 * 规范化成一个字符串，供 `toBe('isMacPlatform()')` 判定：
 *
 *   - `isMacPlatform()` —— 实参是裸的 `isMacPlatform()` 调用，**或**同文件里一个绑定到裸
 *     `isMacPlatform()` 的 `const`（解析一层，像 relative-age 的 `numericConstants`）。
 *   - `NOT-…(…)` —— 其它任何形状，`toBe` 会红并把看到的形状念出来。
 *
 * ─── 为什么判 AST 形状而不是 grep 文本 ───
 *
 * `!isMacPlatform()` 里也含 `isMacPlatform` 这个词——文本判据对它完全失明，而它正是本轮要防的真缺陷：
 * mac 上把平台判反，Cmd+Enter 那条和弦再也匹配不上，发车键静默失效（本仓 #729 记过同一族）。所以判的是
 * 「实参这棵子树**就是**一次裸调用」，不是「子树里出现过这个名字」。
 *
 * ─── 为什么解析一层同文件 const（刻意不做成 误伤）───
 *
 * `const isMac = isMacPlatform()` 再传 `isMac` 是**正确代码**、往往更可读；对正确代码打红的守卫会被下一个
 * 作者整条删掉（本仓 #731、#735 是这条的 误伤 反面）。所以跟一层绑定，对绑定的初始化式套同一条裸调用判据。
 *
 * ─── 已知缺口，逐条写明（不写明的缺口会变成将来的假承诺，#713）───
 *
 *   - 只解析**一层** `const` 绑定，且只认由裸 `isMacPlatform()` 初始化的绑定。`const a = isMacPlatform();
 *     const b = a;` 传 `b`（两层）会被判 NOT- 并红——那是一次 误伤，但今天源码至多绑一层，为一个不存在的
 *     形状加 N 层解析是过度机械。`const isMac = !isMacPlatform()` 传 `isMac` 也红——那是**对的**，取反被
 *     经局部洗白之后依然是同一个缺陷。
 *   - 不证明 `isMacPlatform` 是从 host-platform import 进来的：同文件里一个叫 `isMacPlatform` 的影子函数
 *     会通过本判据。「这是不是真探针」由上面的行为族与 import 关系管，本条只管「实参形状对不对」。
 *   - 自检：找不到那次调用时返回 `NO-CALL`，`toBe('isMacPlatform()')` 随之变红而不是空转——改名/删掉
 *     接线都会这样红（本仓 #393/#645「scan 面写错静默变绿」这一族）。
 */
function macArgumentShape(guard: ts.Node, source: ts.SourceFile): string {
  let call: ts.CallExpression | undefined
  const findCall = (node: ts.Node): void => {
    if (call) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'launcherKeydownLaunches') {
      call = node
      return
    }
    ts.forEachChild(node, findCall)
  }
  findCall(guard)
  if (!call) return 'NO-CALL(找不到 launcherKeydownLaunches 调用——接线被改名或删掉了)'
  const argument = call.arguments[1]
  if (!argument) return 'MISSING-2ND-ARGUMENT(平台实参根本没传)'
  if (isBareMacProbe(argument)) return 'isMacPlatform()'
  if (ts.isIdentifier(argument)) {
    let bound: ts.Expression | undefined
    const scan = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === argument.text && node.initializer) {
        bound = node.initializer
      }
      ts.forEachChild(node, scan)
    }
    scan(source)
    if (bound && isBareMacProbe(bound)) return 'isMacPlatform()'
    return `NOT-A-PROBE-BINDING(${argument.text} = ${bound ? bound.getText().replace(/\s+/gu, ' ') : '<未在本文件绑定>'})`
  }
  return `NOT-A-BARE-PROBE(${ts.SyntaxKind[argument.kind]}: ${argument.getText().replace(/\s+/gu, ' ')})`
}

function event(overrides: Partial<ShortcutEvent>): ShortcutEvent {
  return { key: 'a', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides }
}

const READY = { hasWorkspace: true, busy: false, installedExecutorCount: 2 }

// ---------------------------------------------------------------------------
// 行为层 A：那道闸。三条都是必要条件——少判一条的症状不是被拦住，而是点下去报一个内部错。
// ---------------------------------------------------------------------------
describe('launcherCanLaunch', () => {
  it('三件事同时成立才放行', () => {
    expect(launcherCanLaunch(READY)).toBe(true)
  })

  it('每一条单独不成立都拦下来——逐条改坏，不是只试一条', () => {
    // 判据落在「每个合取项各自承重」上：只试一条时，把另外两条删掉的变异会存活。
    expect(launcherCanLaunch({ ...READY, hasWorkspace: false }), 'no workspace: 启动没有落点').toBe(false)
    expect(launcherCanLaunch({ ...READY, busy: true }), 'busy: 已经有一次在飞').toBe(false)
    expect(launcherCanLaunch({ ...READY, installedExecutorCount: 0 }), 'no executor: 挑不出 agent').toBe(false)
  })

  it('装了一个就够——不是「装了很多才行」', () => {
    // 反向：把 `> 0` 写成 `> 1` 这类差一错误在这里红。
    expect(launcherCanLaunch({ ...READY, installedExecutorCount: 1 })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 行为层 B：这次按键要不要启动。和弦取自注册表（不在这里手抄第二份），闸取自上面那一次判定。
// ---------------------------------------------------------------------------
describe('launcherKeydownLaunches', () => {
  it('Cmd+Enter（mac）/ Ctrl+Enter（其他）发车', () => {
    expect(launcherKeydownLaunches(event({ key: 'Enter', metaKey: true }), true, READY)).toBe(true)
    expect(launcherKeydownLaunches(event({ key: 'Enter', ctrlKey: true }), false, READY)).toBe(true)
  })

  it('裸 Enter 绝不发车——prompt 是 rows=4 的多行框，换行是它的主要用途', () => {
    // 承重设计决定，不是实现细节：把 `launcher.submit` 的 primary 改成 false（或壳里改成判裸 Enter）
    // 会让用户再也没法在 prompt 里换行。
    expect(launcherKeydownLaunches(event({ key: 'Enter' }), true, READY)).toBe(false)
    expect(launcherKeydownLaunches(event({ key: 'Enter' }), false, READY)).toBe(false)
  })

  it('Shift+Enter 也不发车：那是「换行」的常规拼法，且终端 scope 已经这么用了', () => {
    expect(launcherKeydownLaunches(event({ key: 'Enter', shiftKey: true }), true, READY)).toBe(false)
    expect(launcherKeydownLaunches(event({ key: 'Enter', metaKey: true, shiftKey: true }), true, READY)).toBe(false)
  })

  it('别的键一概不是我们的——返回 false，调用方据此不 preventDefault', () => {
    expect(launcherKeydownLaunches(event({ key: 'a' }), true, READY)).toBe(false)
    expect(launcherKeydownLaunches(event({ key: 's', metaKey: true }), true, READY)).toBe(false)
  })

  it('闸关着时不发车——键盘绝不绕过按钮的 disabled', () => {
    // 守的形状：壳里只判和弦、把闸忘在按钮那一侧。症状是 busy 期间连发两次、或者没有 workspace
    // 时按下去报一个裸内部错。
    for (const broken of [
      { ...READY, hasWorkspace: false },
      { ...READY, busy: true },
      { ...READY, installedExecutorCount: 0 }
    ]) {
      expect(
        launcherKeydownLaunches(event({ key: 'Enter', metaKey: true }), true, broken),
        JSON.stringify(broken)
      ).toBe(false)
    }
  })

  it('和弦取自注册表那一条，不是这里手抄的第二份', () => {
    // 挡板：注册表里删掉 `launcher.submit` 时，上面那些「发车」断言会红——这条说明它为什么该红，
    // 并且钉住 launcher scope 恰好只有这一条 binding（多出一条就该有人重新想清楚碰撞）。
    const launcherBindings = SHORTCUT_BINDINGS.filter((binding) => binding.scope === 'launcher')
    expect(launcherBindings.map((binding) => binding.id)).toEqual(['launcher.submit'])
    expect(launcherBindings[0]!.gate, 'launcher.submit 必须无 gate：它就是要在 textarea 里按').toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 接线层：壳。这些断言在「行为对了但壳没接上/接错了」时红——那种情况下上面所有断言照旧全绿，
// 而用户按键什么都不会发生。
// ---------------------------------------------------------------------------
describe('NewTabSurface 真的把键盘接到了 prompt 那一格', () => {
  const relative = 'components/NewTabSurface.tsx'

  it('onKeyDown belongs only to the rich prompt input, not the containing surface', () => {
    const source = parse(relative)
    const owners: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText() === 'onKeyDown') {
        const tag = node.parent.parent
        owners.push(ts.isJsxSelfClosingElement(tag) || ts.isJsxOpeningElement(tag) ? tag.tagName.getText() : '<unknown>')
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    expect(owners).toEqual(['InlineComposer'])
    // Real editor key dispatch and IME protection are exercised by composer-image-preview/DOM tests.
  })

  it('那个处理器把判定交给 launcherKeydownLaunches，且壳里没有自己的条件', () => {
    // 守的形状（本仓「抽进 lib 只解决一半」）：把判定抽进 lib 之后，壳里再写一个 `if (event.key === …)`
    // 就是第二处无人守的判定。判据是壳里那个箭头函数的语句序列恰好是「一次早退 + preventDefault +
    // 一次启动调用」，而那次早退的条件就是 launcherKeydownLaunches 的取反。
    const source = parse(relative)
    let body: ts.Block | null = null
    const walk = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText() === 'onKeyDown') {
        const initializer = node.initializer
        if (initializer && ts.isJsxExpression(initializer) && initializer.expression
          && ts.isArrowFunction(initializer.expression) && ts.isBlock(initializer.expression.body)) {
          body = initializer.expression.body
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    expect(body, 'onKeyDown 不是一个带块体的箭头函数——提取器需要跟上').not.toBeNull()
    const statements = body!.statements
    expect(statements.length, '壳里恰好三句：早退、preventDefault、启动').toBe(3)

    const [guard, prevented, launched] = statements
    // 第一句必须是「不是我们的键就走」——而且判据取自 lib，不是壳里自己写的比较。
    expect(ts.isIfStatement(guard!), '第一句必须是早退守卫').toBe(true)
    const guardText = guard!.getText()
    expect(guardText).toMatch(/^if \(!launcherKeydownLaunches\(/)
    // 闸必须真的被喂进去：漏掉 readiness 那个实参会让键盘绕过按钮的 disabled。
    expect(guardText, '必须把 readiness 传进去，否则键盘绕过 disabled').toMatch(/readiness/)
    // 平台实参必须**就是**一次裸 `isMacPlatform()` 调用（或同文件一层 const 绑定到它）。这是本轮补的判据：
    // 此前这条断言只看 callee 名字与 readiness 在不在，对第 2 个实参零覆盖，于是 `true` / `false` /
    // `!isMacPlatform()` 三种改法都在 13 条全绿下存活（tsc 也沉默——两侧都是 boolean）。其中 `!isMacPlatform()`
    // 是真缺陷：mac 上平台判反，Cmd+Enter 和弦匹配不上，发车键静默失效（本仓 #729 同族）。判 AST 形状而非
    // grep 文本——`!isMacPlatform()` 也含这个词。同文件一层 const 绑定算通过，因为 `const isMac = isMacPlatform()`
    // 是更可读的正确代码，对它打红会让守卫被删（#731/#735 的 误伤 反面）。缺口见 macArgumentShape 的文档。
    expect(
      macArgumentShape(guard!, source),
      '第 2 个实参必须是裸 isMacPlatform()：true/false/!isMacPlatform() 三种改法此前全在 13 条下存活，' +
        '取反那种会让 Cmd+Enter 在 mac 上静默失效'
    ).toBe('isMacPlatform()')
    expect(prevented!.getText()).toBe('event.preventDefault()')
    // 启动走与按钮同一个函数——抄第二份就会漏掉精调/名字里的某一项。
    expect(launched!.getText()).toBe('launchFromLauncher()')
  })

  it('主按钮与键盘读同一次闸判定，且调同一个启动函数', () => {
    // 守的缺陷形状：两条路各写一遍条件。症状不是报错，而是两条路对同一概念判得不一样——按钮灰着
    // 而键盘照旧发车，或者反过来。判据落在「disabled 的值就是那次调用的取反」上。
    const source = parse(relative)
    const disabledValues: string[] = []
    const onClickValues: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer)) {
        const name = node.name.getText()
        const text = node.initializer.expression?.getText() ?? ''
        // 只看主按钮那一个：它是唯一读 launcherCanLaunch 的地方。
        if (name === 'disabled' && text.includes('launcherCanLaunch')) disabledValues.push(text)
        if (name === 'onClick' && text.includes('launchFromLauncher')) onClickValues.push(text)
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    expect(disabledValues, '主按钮的 disabled 必须恰好由 launcherCanLaunch 决定').toEqual(['!launcherCanLaunch(readiness)'])
    expect(onClickValues, '主按钮必须点同一个启动函数').toEqual(['() => launchFromLauncher()'])
  })

  it('readiness 的三个取值来自组件已有的那三个事实，不是重新取一遍', () => {
    // 守的形状：readiness 里随便写个 `busy: false` 之类的常量，闸就永久开着而所有行为断言照旧全绿。
    // 判据是那三个属性的值分别引用到组件里真正的取值表达式。
    const text = readSource(relative)
    expect(text).toMatch(/hasWorkspace:\s*Boolean\(workspace\)/)
    expect(text).toMatch(/busy:\s*busy\s*!==\s*null/)
    expect(text).toMatch(/installedExecutorCount:\s*installedExecutors\.length/)
  })
})
