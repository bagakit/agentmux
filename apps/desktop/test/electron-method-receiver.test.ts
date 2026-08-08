import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 守的缺陷（#301）：从 electron 的单例上**摘方法**——`{ exit: app.exit }`——receiver 就丢了。
 * 那些单例是 gin 原生绑定，脱离宿主对象调用在真机上抛 `Illegal invocation`。
 *
 * 为什么这个形状能一路走到用户面前：
 * - `tsc` 完全沉默。`app.exit` 的类型就是 `(exitCode?: number) => void`，摘下来类型不变。
 * - 注入普通对象的单元测试也照样绿。普通对象上摘下来的方法能正常调用，`this` 丢了没人在意。
 *   于是「有没有丢 receiver」在 fixture 下**不可观测**（记忆 property-unobservable-in-default-env）。
 *
 * 已经付过一次代价：`startup-failure-exit.ts` 里那三个注入端口最初就是 `exit: app.exit` /
 * `showErrorBox: dialog.showErrorBox`。那条路径抛在这里的结局最坏——启动失败既不弹框也不退出，
 * 留下一个挂着的进程。该文件现在用「recorder 的方法记录自己的 `this`」当检测器，逐个钉住
 * receiver 是宿主对象（见 `startup-failure-exit.test.ts` 的「两个 electron 方法都用它自己的
 * 宿主对象当 receiver 调用」）。
 *
 * 但那是**一处**的检测器。这条守的是**规则**：`src/main/` 里任何地方再写出同一形状都要红。
 * 常驻规则的交付物是守卫，不是那一次清理（记忆 cleanup-without-a-detector-is-not-cleanup）。
 *
 * 判据经过两次加固：第一版只认 `app.exit`（PropertyAccess）一种拼法，于是解构
 * `const { exit } = app` 与下标 `app['exit']` 两种同样摘掉 receiver 的写法都绕过——review agent
 * 各测 `3/3 green`。第二版 `detachedMemberReads` 枚举「成员被读出来的每一种方式」：属性访问、
 * 字符串下标、静态可折叠的拼接下标、（重命名）解构；静态解析不出成员名的动态键标成 unclassified
 * 并在宿主是 electron 单例时**响亮失败**，而不是静默放过（记忆 forbidden-list-guard-always-leaks）。
 * 复测：两种旧 bypass（解构 / 下标）均由主扫描 red，原始缺陷（`exit: app.exit`）仍 red。
 *
 * 第三次加固（本轮）：判据原先三个分支都按 `ts.isIdentifier(node.expression)` 认宿主，于是运行时
 * 是 no-op 的**透明包裹**——括号 `(app)`、非空断言 `app!`、`as` / `satisfies` 类型转换——把宿主一裹
 * 就整族静默绕过（`const f = (app as any).exit` 补丁前得 `[]`；`(app as any)['exit']`、
 * `const { exit } = (app as any)` 同）。这些编译产物就是 `app.exit`，摘下来一样丢 receiver。现在
 * 三个分支的宿主判定改走 `singletonIdOf`（先剥净透明包裹再取标识符），由自检
 * `前提自检：穿过运行时透明包裹（…）的摘取也要认出` 钉住：把宿主判定改回 `ts.isIdentifier` 那个变异
 * 会让 6 个 wrapper 探针退回 `[]`、该条 red。
 *
 * 仍在的盲点（诚实记录，不让注释许诺超过断言）：
 *   - 成员经**中间变量**再摘（`const a = app; const { exit } = a`）——判据只认 initializer 直接是
 *     单例标识符（剥净透明包裹后）的解构；跨变量要 TypeChecker 做符号解析，本文件是 createSourceFile 词法走查，够不到。
 *   - 真正的**动态键**（`app[runtimeName]`）无法静态判成员名，只能标 unclassified 让人回看，判不出
 *     它摘的到底是方法还是属性。这是有意为之的保守出口，不是遗漏。
 *   - 从**命名空间链**上摘（`electron.app.exit`、`const { app: { exit } } = electron`）——判据只认根对象
 *     是**裸标识符单例**（`app.exit`）的形状；`electron.app.exit` 的根是 `electron.app`（一个
 *     PropertyAccess，不是 Identifier），要判它等于 `app` 单例得靠符号解析，词法走查够不到。今天
 *     `src/main` 全是 `import { app } from 'electron'` 具名导入（grep 可证，无 `import * as electron`），
 *     所以这条路线一处都不存在——这是**人工观察**，不由机器强制（强制「不许命名空间导入」会对
 *     `import * as electron` + 只做正常调用 `electron.app.exit(1)` 的合法代码发假红）。这条盲点的
 *     **当前行为**被 `前提自检：命名空间链上的摘取是当前的已知盲点` 钉住：一旦有人给判据补上符号解析、
 *     让 `electron.app.exit` 也被认出，那条自检就 red，逼人回来把这段盲点声明一起更新。
 */

const MAIN_DIR = fileURLToPath(new URL('../src/main', import.meta.url))
const ELECTRON_DTS = fileURLToPath(new URL('../node_modules/electron/electron.d.ts', import.meta.url))

/**
 * electron 单例的名字从 `electron.d.ts` 里那批 `const x: T;` 声明**派生**，不手抄。
 *
 * 手抄一份清单必然漂移：electron 升级新增一个单例（近年真的加过 `pushNotifications`、
 * `webUtils`、`sharedTexture`），手抄那份不会跟上，于是从新单例上摘方法这条路无人守，
 * 而症状与老单例一模一样。派生之后「有哪些单例」由依赖自己回答。
 */
function electronSingletons(declarations: string): { name: string; type: string }[] {
  return [...declarations.matchAll(/^ {2}const ([a-zA-Z]+): ([A-Za-z]+);$/gmu)]
    .map(([, name, type]) => ({ name: name!, type: type! }))
}

/**
 * 某个单例的哪些成员是**方法**（而不是属性取值）——同样由声明回答。
 *
 * 这是这条守卫成立的关键：`app.exit` 摘下来是缺陷，`app.name` 摘下来只是读一个 string，
 * 完全正常。文本判据分不开这两者（都是 `app.<标识符>`），于是只按文本报警就会对
 * `productName: app.name` 这类无害写法发假红，而假红久了必被加豁免、豁免再吃掉真缺陷。
 *
 * 声明里两者形状不同：方法是 `exit(exitCode?: number): void;`，属性是 `name: string;`。
 * 按「标识符后紧跟 `(`」判方法。
 */
function methodNamesOf(declarations: string, interfaceName: string): Set<string> {
  const start = declarations.search(new RegExp(`^ {2}(?:interface|class) ${interfaceName}\\b`, 'mu'))
  if (start < 0) return new Set()
  // 右界：下一个顶层 `interface` / `class` 声明。只取左界会让邻节顶上来
  //（记忆 section-slice-without-right-bound）。
  const rest = declarations.slice(start + 1)
  const end = rest.search(/^ {2}(?:interface|class) [A-Za-z]/mu)
  const body = end < 0 ? rest : rest.slice(0, end)
  return new Set([...body.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9_]*)\(/gmu)].map(([, name]) => name!))
}

/**
 * 一个文件里所有「从某个标识符上取成员、但不在调用位置」的地方。
 *
 * 为什么必须走 TypeScript 自己的 AST 而不是正则：这条守卫第一版就是按行做正则的，跑出来
 * **八条全是假红**——命中的 `app.exit` / `dialog.showErrorBox` 全在注释里，正是解释这个缺陷的
 * 那几段说明文字。按行猜词法边界是一族盲点（注释、字符串、模板字面量、JSDoc），补一条
 * 「跳过以 `*` 开头的行」只是把盲点挪个位置。用编译器的语法树，注释与字符串根本不会进来。
 *
 * 判「不在调用位置」也交给 AST：`app.exit(1)` 的父节点是 `CallExpression` 且它自己是
 * `expression`，receiver 在场；`{ exit: app.exit }` 与 `const f = app.exit` 没有这个父节点。
 * 正则要靠「后面跟不跟左括号」猜，跨行调用（`app.exit(\n  1\n)`）就会误判。
 *
 * 「取成员」不止点号一种拼法。第一版只认 `PropertyAccessExpression`，于是 `const { exit } = app`
 * （解构）与 `app['exit']`（下标）两种把 receiver 摘掉的写法都绕过了它——review agent 复现，各测
 * `3/3 green`（记忆 counting-a-symbol-misses-other-spellings：数一个符号的某几种拼法就漏掉别的拼法）。
 * 所以这里**枚举成员被读出来的每一种方式**，逐一归一成 `{object, member}`：
 *   - 属性访问     `app.exit`
 *   - 下标访问     `app['exit']`（字符串字面量键）
 *   - 拼接下标     `app['ex' + 'it']`（把静态可折叠的 `+` 串折出成员名）
 *   - 解构         `const { exit } = app` / `const { exit: e } = app`（键取 `propertyName ?? name`）
 *
 * 关键的一半是**归类不了的形状要响亮**，不能静默跳过（记忆 forbidden-list-guard-always-leaks：
 * 禁止清单总会漏；能反过来就只认一小撮已识别形状，其余一律显式失败）。`app[dynamicKey]` 或
 * `const { [k]: v } = app` 这类静态解析不出成员名的写法，标成 `kind:'unclassified'` 连同源码文本
 * 带出来；主扫描发现它的宿主是某个 electron 单例时，就在那条断言里响亮失败（今天 src/main 里一处
 * 这种写法都没有，见反向自证）。
 */
type MemberRead =
  | { line: number; object: string; kind: 'member'; member: string }
  | { line: number; object: string; kind: 'unclassified'; text: string }

function detachedMemberReads(sourceText: string, fileName: string): MemberRead[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: MemberRead[] = []
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const isCallee = (node: ts.Node): boolean => ts.isCallExpression(node.parent) && node.parent.expression === node

  // 从字符串字面量或字面量的 `+` 拼接里折出静态值；折不出（含变量、模板插值）时返回 null。
  const staticString = (node: ts.Expression): string | null => {
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticString(node.left)
      const right = staticString(node.right)
      return left !== null && right !== null ? left + right : null
    }
    return null
  }

  // 剥掉运行时的**透明包裹**再认单例标识符。括号 `(app)`、非空断言 `app!`、`as` / `satisfies`
  // 类型转换在运行时都是 no-op：`(app as any).exit` / `app!.exit` 编译产物就是 `app.exit`，摘下来
  // 一样丢 receiver，真机上一样抛 Illegal invocation，而 tsc 与普通对象 fixture 一样沉默。只按
  // `ts.isIdentifier(node.expression)` 认宿主时，这一整族写法全部静默绕过（本轮修补前实测：
  // `const f = (app as any).exit` 得 `[]`）。返回被包裹的最内层标识符，非标识符返回 null。
  const singletonIdOf = (node: ts.Expression): ts.Identifier | null => {
    let inner: ts.Expression = node
    while (
      ts.isParenthesizedExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isSatisfiesExpression(inner)
    ) {
      inner = inner.expression
    }
    return ts.isIdentifier(inner) ? inner : null
  }

  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && !isCallee(node)) {
      // 1) 属性访问 app.exit / (app as any).exit —— 不在调用位置（`app.exit(1)` 的 receiver 在场，不算摘）。
      const object = singletonIdOf(node.expression)
      if (object) found.push({ line: lineOf(node), object: object.text, kind: 'member', member: node.name.text })
    } else if (ts.isElementAccessExpression(node) && !isCallee(node)) {
      // 2/3) 下标访问 app['exit'] 与拼接下标 app['ex' + 'it']（含穿过包裹的 `(app as any)['exit']`）—— 同样排除调用位置。
      const object = singletonIdOf(node.expression)
      if (object) {
        const key = staticString(node.argumentExpression)
        if (key !== null) {
          found.push({ line: lineOf(node), object: object.text, kind: 'member', member: key })
        } else if (!ts.isNumericLiteral(node.argumentExpression)) {
          // 静态解析不出成员名的非数字下标：归类不了，留成 unclassified 让主扫描按宿主是否单例来响亮。
          found.push({ line: lineOf(node), object: object.text, kind: 'unclassified', text: node.getText(source) })
        }
      }
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      ts.isVariableDeclaration(node.parent.parent) &&
      node.parent.parent.initializer !== undefined
    ) {
      // 4) 解构 const { exit } = app / const { exit } = (app as any) —— 解构天生就是摘（拿到的绑定
      // 没有 receiver），无「调用位置」豁免。键取 propertyName ?? name，故重命名解构 const { exit: e } = app 也算在内。
      const object = singletonIdOf(node.parent.parent.initializer)
      if (object) {
        const key = node.propertyName ?? node.name
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
          found.push({ line: lineOf(node), object: object.text, kind: 'member', member: key.text })
        } else if (ts.isComputedPropertyName(key)) {
          const resolved = staticString(key.expression)
          if (resolved !== null) found.push({ line: lineOf(node), object: object.text, kind: 'member', member: resolved })
          else found.push({ line: lineOf(node), object: object.text, kind: 'unclassified', text: node.getText(source) })
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...sourceFilesUnder(path))
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) found.push(path)
  }
  return found
}

describe('electron 单例的方法不许脱离宿主对象', () => {
  const declarations = readFileSync(ELECTRON_DTS, 'utf8')
  const singletons = electronSingletons(declarations)

  it('前提自检：单例清单与方法清单都真的从 electron 声明里读出来了', () => {
    // 这两条挡板守的是「判据自己失效」这一族：正则改错、路径变了、声明格式换了，
    // 下面那条主守卫会因为清单为空而**静默全绿**（记忆 sampled-pair-can-be-the-blind-spot 同族）。
    expect(singletons.length, 'electron 单例清单读成空，主守卫已经不检查任何东西')
      .toBeGreaterThanOrEqual(20)
    expect(singletons.map((entry) => entry.name), 'app 不在单例清单里——正则没匹配上声明').toContain('app')

    const appMethods = methodNamesOf(declarations, 'App')
    // 判据的两侧都要在场：分不出方法就退化成文本判据，分不出属性就会发假红。
    expect(appMethods, 'app.exit 没被认成方法——受害最重的那个成员正好漏掉了').toContain('exit')
    expect(appMethods, 'app.name 被误认成方法——属性取值会被误报，假红久了必被加豁免')
      .not.toContain('name')
  })

  // 为什么每种拼法各占一条用例（#742 同族，本轮实测）：这几组断言原先挤在一个 it 里，正向计数排在
  // 最前，反向自证（正常调用与注释不许被算进来 / 合法调用不许被标 unclassified）排在后面。任何让正向
  // 计数失败的变异都让反向自证变成**死代码**，于是「判据瞎了」和「判据误伤合法代码」这两类相反的缺陷
  // 被同一条红压成一件事（记忆 two-throws-in-one-it-mask-each-other）。同时那个 `toHaveLength(5)`
  // 比缺陷粗：漏掉哪一种拼法都只是「5 变 4」，说不出是哪一种（记忆 mutation-must-change-one-thing）。
  //
  // 顺带删掉一条恒被上面覆盖的断言：原先在计数之后还有一句 `expect(names).toContain('app.exit')`，
  // 它严格弱于「恰好 5 次」，不可能独立报红——是纯噪声。
  const DETACH_SPELLINGS: ReadonlyArray<{ why: string; code: string }> = [
    { why: '点号摘取', code: 'const shell = { exit: app.exit }' },
    { why: '字符串字面量下标', code: "const g = app['exit']" },
    { why: '静态可折叠的拼接下标', code: "const h = app['ex' + 'it']" },
    { why: '解构', code: 'const { exit } = app' },
    { why: '重命名解构', code: 'const { exit: e } = app' }
  ]

  it.each(DETACH_SPELLINGS)('前提自检：$why 被认成一次摘取', ({ code }) => {
    // 这条守的是「判据自己失效」：`detachedMemberReads` 恒返回空数组时，下面那条主守卫会
    // **静默全绿**，而它正是这个仓库最贵的一族假绿。所以判据的每一侧都要在场，且各自可观测。
    const names = detachedMemberReads(code, 'probe.ts')
      .filter((read) => read.kind === 'member')
      .map((read) => `${read.object}.${read.member}`)
    expect(names, `这种摘取写法没被认出，主守卫对它什么都不检查：${code}`).toEqual(['app.exit'])
  })

  it.each([
    { why: '正常调用（receiver 在场）', code: 'app.exit(1)' },
    // 注释：第一版正则在这里吃过八条假红。
    { why: '注释里提到成员', code: '/** 说明：不要写 app.quit，它会丢 receiver */' },
    { why: '字符串里提到成员', code: 'const message = "app.quit 也不该被算进来"' }
  ])('前提自检：$why 不算一次摘取', ({ code }) => {
    const reads = detachedMemberReads(code, 'probe.ts')
    expect(reads.filter((read) => read.kind === 'member'), `合法写法被算成摘取了——假红：${code}`).toEqual([])
    expect(reads.filter((read) => read.kind === 'unclassified'), `合法写法被误标成可疑：${code}`).toEqual([])
  })

  it.each([
    { why: '运行期键的下标', code: "const k = 'exit'; const x = app[k]" },
    { why: '运行期键的解构', code: "const k = 'exit'; const { [k]: v } = app" }
  ])('前提自检：$why 被标成 unclassified 而不是静默放过', ({ code }) => {
    // 归类不了的可疑形状必须响亮，不能静默跳过（记忆 forbidden-list-guard-always-leaks）。
    expect(
      detachedMemberReads(code, 'probe.ts').filter((read) => read.kind === 'unclassified'),
      `静态解析不出成员名的写法被静默放过了：${code}`
    ).toHaveLength(1)
  })

  it('前提自检：命名空间链上的摘取是当前的已知盲点', () => {
    // 把头部残留盲点清单里「命名空间链」那一条做成**可证伪**的断言，而不是一句只写在注释里的话。
    // 判据只认根对象是**裸标识符单例**（`app.exit` / `const { exit } = app`）的摘取；从命名空间链上摘
    // （`electron.app.exit`、`const { app: { exit } } = electron`）今天**认不出** exit——`electron.app`
    // 是 PropertyAccess 而不是 Identifier，要判它就是那个 `app` 单例得靠符号解析，本文件的词法走查够不到。
    //
    // 这条盲点今天不构成真缺陷：`src/main` 全是 `import { app } from 'electron'` 具名导入，没有
    // `import * as electron`，所以命名空间链的摘取一处都不存在（见报告里的 grep）。这里不去强制
    // 「不许命名空间导入」——那会对 `import * as electron` + 只做合法调用 `electron.app.exit(1)` 发假红。
    // 这条钉的是**当前行为**：一旦有人给判据补上符号解析、让下面这两个 exit 被认出，断言就 red，
    // 逼人回来把头部那段盲点声明与这条自检一起更新（记忆 expired-reason-for-not-mapping：
    // 刻意不覆盖的理由要做成可被质询的断言，别只写进注释里等它过期）。
    const chainMembers = detachedMemberReads(
      'const f = electron.app.exit\nconst { app: { exit } } = electron',
      'probe.ts'
    )
      .filter((read) => read.kind === 'member')
      .map((read) => `${read.object}.${read.member}`)
    expect(chainMembers, '命名空间链上的 exit 现在被认出来了——盲点被补上了，去更新头部残留盲点清单与本自检')
      .not.toContain('app.exit')
    expect(chainMembers, '命名空间链上的 exit 现在被认出来了（解构形）——去更新头部残留盲点清单与本自检')
      .not.toContain('electron.exit')
  })

  it('前提自检：穿过运行时透明包裹（括号 / 非空断言 / as / satisfies）的摘取也要认出', () => {
    // 本轮新补的盲点：判据原先只按 `ts.isIdentifier(node.expression)` 认宿主，于是运行时是 no-op 的
    // 透明包裹——括号 `(app)`、非空断言 `app!`、`as` / `satisfies` 类型转换——把宿主一裹就整族静默绕过。
    // 这些写法编译产物就是 `app.exit`，摘下来一样丢 receiver、真机上一样抛 Illegal invocation，而
    // tsc 与普通对象 fixture 一样沉默（`(app as any).exit` 尤其像样：为压类型报错随手 cast 就顺手摘掉了）。
    //
    // 曾经存活、现在被杀的**确切变异**（补丁前实测，counts 见报告）：把三个分支的宿主判定从
    // `singletonIdOf(node.expression)`（剥包裹后取标识符）改回 `ts.isIdentifier(node.expression)`，
    // 下面 6 个 wrapper 探针全部退回 `[]`，本条 red（`toHaveLength(6)` 收到 0）；补丁后 6 个全部认出，本条 green。
    //
    // 仍**不覆盖**：宿主经中间变量再摘（`const a = app; const { exit } = a`）、真正的动态键
    // （`app[runtimeName]` 走 unclassified 让人回看）——两者都要 TypeChecker 做符号解析，本文件的
    // createSourceFile 词法走查够不到；命名空间链（`electron.app.exit`）见上一条自检。
    const wrapped = [
      'const a = app!.exit', // 非空断言
      'const b = (app).exit', // 括号
      'const c = (app as any).exit', // as 转换（最像样的误用）
      'const d = (app as unknown as never).exit', // 链式转换
      "const e = (app as any)['exit']", // 转换 + 下标
      'const { exit } = (app as any)' // 转换 + 解构
    ].join('\n')
    const wrappedExit = detachedMemberReads(wrapped, 'probe.ts')
      .filter((read) => read.kind === 'member')
      .map((read) => `${read.object}.${read.member}`)
      .filter((name) => name === 'app.exit')
    expect(wrappedExit, '穿过 (app)/app!/(app as T) 的摘取没被全部认出——透明包裹这族又能静默绕过了')
      .toHaveLength(6)

    // 反向自证：合法形状不能因为这次放宽而误红。
    // 1) 穿过包裹的**正常调用**，receiver 在场，不算摘（isCallee 在剥包裹后仍成立）。
    for (const legalCall of ['app.exit(1)', '(app).exit(1)', '(app as any).exit(1)', 'app!.exit(1)']) {
      expect(
        detachedMemberReads(legalCall, 'probe.ts').filter((r) => r.kind === 'member'),
        `合法调用 ${legalCall} 被算成摘下来了——放宽包裹后产生了假红`
      ).toHaveLength(0)
    }
    // 2) 宿主本身不是裸标识符（`foo().exit` / `(app.bar).exit`）不许被当成从单例 `app` 上摘。
    const notBareId = detachedMemberReads('const f = foo().exit\nconst g = (app.bar).exit', 'probe.ts')
      .filter((read) => read.kind === 'member')
      .map((read) => `${read.object}.${read.member}`)
    expect(notBareId, 'foo().exit 被误当成单例摘取').not.toContain('foo.exit')
    expect(notBareId, '(app.bar).exit 应记成 app.bar（读了 bar），不该冒出 app.exit').not.toContain('app.exit')
  })

  it('src/main 里没有从 electron 单例上摘下来的方法引用', () => {
    const methodsBySingleton = new Map(
      singletons.map(({ name, type }) => [name, methodNamesOf(declarations, type)])
    )
    const files = sourceFilesUnder(MAIN_DIR)
    expect(files.length, 'src/main 一个源文件都没扫到，这条守卫是死代码').toBeGreaterThan(10)

    const detached: string[] = []
    const unclassified: string[] = []
    for (const path of files) {
      const relative = path.slice(MAIN_DIR.length + 1)
      for (const read of detachedMemberReads(readFileSync(path, 'utf8'), relative)) {
        // 只关心宿主是 electron 单例的读取；别的对象上摘方法不是这条守卫管的事。
        const isSingleton = methodsBySingleton.has(read.object)
        if (!isSingleton) continue
        if (read.kind === 'unclassified') {
          // 归类不了但宿主确实是 electron 单例：响亮，别猜。哪怕它今天无害，也要有人回来看一眼。
          unclassified.push(`${relative}:${read.line}  ${read.text}`)
          continue
        }
        if (!methodsBySingleton.get(read.object)?.has(read.member)) continue
        detached.push(`${relative}:${read.line}  ${read.object}.${read.member}`)
      }
    }

    // 先钉「无法归类」这一侧：一个动态键从 electron 单例上取东西，可能正把某个方法摘了下来而判据
    // 看不穿。它必须让人回来看，而不是被当成安全（记忆 forbidden-list-guard-always-leaks）。
    expect(unclassified, [
      'electron 单例上出现了静态解析不出成员名的取值（动态下标或计算解构键）。它可能正把一个原生',
      '方法摘了下来，而 receiver 一旦丢了真机上会抛 Illegal invocation。请改成静态可判的写法，',
      '或确认它取的是属性而非方法后，在这里为它增加一个具名的识别分支。'
    ].join('\n')).toEqual([])

    expect(detached, [
      '有 electron 单例的方法被从宿主对象上摘了下来。receiver 丢了，真机上调用抛 Illegal invocation，',
      '而 tsc 与注入普通对象的测试都看不见（普通对象上摘下来照样能调）。',
      '修法：传宿主对象本身（`{ app }` 而不是 `{ exit: app.exit }`），由取值处 `app.exit(code)` 调用；',
      '或者包一层箭头 `() => app.exit(code)`。参考 src/main/startup-failure-exit.ts 那三个注入端口。'
    ].join('\n')).toEqual([])
  })
})
