import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * main → renderer 的**推送**频道，两侧必须指向同一个常量。
 *
 * 为什么单独一条：`ipc-parity.test.ts` 守的是 `handle` / `invoke` 那条请求-响应面，它的提取器认的是
 * `handle(...)` / `invoke(...)` 调用节点。推送面（`webContents.send` / `ipcRenderer.on`）**整个在它视野外**。
 * 而这一面的失败方向和请求面一样静默：`send` 与 `on` 的第一个形参都是 `channel: string`，两侧各自手写
 * 字面量时，拼错一侧编译干净、监听器注册成功、然后永远收不到东西——功能整条死掉，没有任何一处报错。
 *
 * 本轮之前 4 条推送频道正是那个形状（两端各写一份字面量），而同一个文件里另外 5 条推送频道已经走
 * contracts 常量。同一件事两种规矩，就是漂移的定义。
 *
 * ## 判据
 *
 * 1. **preload 侧穷举**：preload 里每一处 `.on/.off/.once/.send`，接收者必须是 `ipcRenderer`，
 *    且频道实参必须是**从 contracts 导入的标识符**，不许是字面量。
 * 2. **main 侧对偶**：上面收集到的每一个频道常量，必须至少被 `src/main` 下某个文件真正引用。
 *
 * 第 2 条是这道门真正的承重处：它让「新加一条推送频道」这件事**只能**经由 contracts。preload 必须
 * import（第 1 条），于是常量必然存在；而 main 若改回手写字面量，那个常量就在 main 侧失去引用，第 2 条
 * 当场红。两条合起来，两个写入点在构造上被合成一个。
 *
 * ## 频道清单从**消费侧**派生，不按命名约定
 *
 * 清单不是「contracts 里名字以 `_CHANNEL` 结尾的导出」——那是一条手抄规则，换个后缀就走出视野
 * （记忆 derivation-source-must-be-the-consumed-one：派生源要取消费侧真读的那份）。清单是
 * **preload 实际用在频道位上的那些标识符**。一个没人监听的常量本来就不是推送频道，不该被这条门管；
 * 一个被监听的常量必然进清单，无论它叫什么。
 *
 * ## 已申报的盲点
 *
 * - 只看 preload↔main。renderer 拿事件的唯一途径是 preload 暴露的 `onX`，那一层由
 *   `preload-consumption` 那族守；本文件不重复。
 * - `invoke` 的字面量是**刻意放过**的：那一面由 `ipc-parity.test.ts` 双向比集合，比这里的常量判据更强
 *   （它连「注册了没人调」都能报）。这里只管没有 parity 覆盖的推送面。
 * - 不做接收者的**同名影子**推理，改成正面要求：preload 里的事件接收者只允许是 `ipcRenderer`，
 *   且 `ipcRenderer` 必须是未改名的 electron 导入、且不被任何本地声明遮蔽。这三条都是显式断言，
 *   哪天 preload 真需要挂别的 emitter，是这道门**响亮地红**，而不是悄悄漏掉一半站点
 *   （记忆 forbidden-list-guard-always-leaks：禁止清单必漏，改成允许形状 + 在场自检）。
 */

const PRELOAD_TS = new URL('../src/preload/index.ts', import.meta.url)
const PRELOAD_SOURCE = readFileSync(PRELOAD_TS, 'utf8')
const MAIN_DIR = fileURLToPath(new URL('../src/main', import.meta.url))

/** electron 里能收 IPC 的方法名。`invoke` 不在内：它是请求面，由 ipc-parity 那条守。 */
const EVENT_METHODS = new Set(['on', 'off', 'once', 'send'])

/** 唯一允许的事件接收者。见文件头「已申报的盲点」第三条。 */
const ALLOWED_RECEIVER = 'ipcRenderer'

function parse(source: string, name: string): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/u.test(entry) ? [full] : []
  })
}

/** 这个文件从 `../shared/contracts.js` 导入了哪些名字（含 `type` 成员，判据只用得到值成员）。 */
function contractsImports(ast: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    if (!/contracts\.js$/u.test(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) names.add(element.name.text)
  }
  return names
}

/** 一处事件调用：接收者原文、方法名、频道实参的形状。 */
type EventSite = {
  where: string
  receiver: string
  method: string
  /** 频道实参是标识符时的名字；是字面量或别的表达式时为 null。 */
  identifier: string | null
  /** 频道实参是字面量时的值；否则为 null。 */
  literal: string | null
}

/**
 * preload 里每一处事件调用。
 *
 * 判据落在 AST 而不是文本：`ipcRenderer.on('x', …)` 这串字在注释里出现过（讲这个桥是什么），
 * 按行猜注释边界是一族已坐实的盲点（记忆 lexical-boundaries-need-a-real-lexer）。
 */
function eventSites(source = PRELOAD_SOURCE, fileName = 'preload.ts'): EventSite[] {
  const ast = parse(source, fileName)
  const out: EventSite[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      EVENT_METHODS.has(node.expression.name.text) &&
      node.arguments.length >= 1
    ) {
      const channel = node.arguments[0]!
      const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast))
      out.push({
        where: `preload/index.ts:${line + 1}`,
        receiver: node.expression.expression.getText(ast),
        method: node.expression.name.text,
        identifier: ts.isIdentifier(channel) ? channel.text : null,
        literal: ts.isStringLiteralLike(channel) ? channel.text : null
      })
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(ast, walk)
  return out
}

/** preload 消费的推送频道常量名——本门的清单，从消费侧派生。 */
function consumedChannels(source = PRELOAD_SOURCE): string[] {
  const imported = contractsImports(parse(source, 'preload.ts'))
  return [
    ...new Set(
      eventSites(source)
        .map((site) => site.identifier)
        .filter((name): name is string => name !== null && imported.has(name))
    )
  ].sort()
}

/**
 * `src/main` 下**真正用到** `name` 这个标识符的文件（仓库相对路径）。
 *
 * `import` 声明里的那次出现**不算**。这个排除是承重的，不是洁癖：把 `send(X, …)` 改回
 * `send('字面量', …)` 时，文件顶部的 import 通常还留着，于是「这个名字在这个文件里出现过」恒真，
 * 整条 main 侧规则退化成「preload 用的常量在 contracts 里存在吗」——一条永远不会红的规则。
 * 本仓 `noUnusedLocals` 没开（见 #324），所以那条孤儿 import 连 tsc 都不会说话。
 * 这个盲点是下面第一条自检当场逼出来的：第一版按「标识符出现过」判，变异后仍算引用。
 *
 * 注释里提到也不算——判据走 AST，注释不在树里。
 */
function mainReferences(name: string): string[] {
  return sourceFiles(MAIN_DIR)
    .filter((file) => usesIdentifier(readFileSync(file, 'utf8'), file, name))
    .map((file) => relative(MAIN_DIR, file))
}

/** 某份源码在 import 声明之外用到了 `name` 吗。 */
function usesIdentifier(source: string, fileName: string, name: string): boolean {
  const ast = parse(source, fileName)
  let found = false
  const walk = (node: ts.Node): void => {
    if (found || ts.isImportDeclaration(node)) return
    if (ts.isIdentifier(node) && node.text === name) {
      found = true
      return
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(ast, walk)
  return found
}

/** preload 里被本地声明遮蔽的 contracts 导入名——有一个就说明标识符判据可能名对值错。 */
function shadowedImports(source = PRELOAD_SOURCE): string[] {
  const ast = parse(source, 'preload.ts')
  const imported = contractsImports(ast)
  const out: string[] = []
  const walk = (node: ts.Node): void => {
    const declared =
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
          ? node.name?.text
          : undefined
    if (declared && imported.has(declared)) out.push(declared)
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(ast, walk)
  return out
}

describe('main → renderer 推送频道：两侧只许指向同一个常量', () => {
  it('提取器真的取到了东西——清单不能落空', () => {
    // 提取器返回空数组会让下面每一条断言变成恒真。preload 重构成第三种写法时，应当是这一条先红，
    // 而不是别的断言静默变成空转。
    const sites = eventSites()
    expect(sites.length, 'preload 里一处事件调用都没取到——提取器与写法脱节了').toBeGreaterThan(8)
    expect(consumedChannels().length, '一个推送频道常量都没识别出来').toBeGreaterThan(5)
  })

  it('preload 的事件接收者只有 ipcRenderer，且它是未改名的 electron 导入', () => {
    // 这一条是「穷举」这个词的前提：只有当 preload 里所有事件调用都挂在 ipcRenderer 上，
    // 按方法名枚举才等于枚举了全部 IPC 监听点。
    const receivers = [...new Set(eventSites().map((site) => site.receiver))]
    expect(receivers, 'preload 出现了非 ipcRenderer 的事件接收者：本门的穷举前提不再成立').toEqual([
      ALLOWED_RECEIVER
    ])
    // 改名导入（`ipcRenderer as ipc`）或命名空间导入（`import * as electron`）都会让上面那条
    // 按接收者原文的判据失明——它会看见 `ipc` / `electron.ipcRenderer` 而报假红或漏站点。
    const ast = parse(PRELOAD_SOURCE, 'preload.ts')
    const electron = ast.statements.filter(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === 'electron'
    )
    expect(electron, "preload 应当恰好有一处 import from 'electron'").toHaveLength(1)
    const bindings = electron[0]!.importClause?.namedBindings
    expect(bindings && ts.isNamedImports(bindings), 'electron 必须是具名导入，不能是命名空间导入').toBe(
      true
    )
    const renderer = (bindings as ts.NamedImports).elements.filter(
      (element) => element.name.text === ALLOWED_RECEIVER
    )
    expect(renderer, `preload 应当具名导入 ${ALLOWED_RECEIVER}`).toHaveLength(1)
    expect(renderer[0]!.propertyName, `${ALLOWED_RECEIVER} 不许改名导入`).toBeUndefined()
  })

  it('每一处事件调用的频道实参都是 contracts 导入的标识符，不是字面量', () => {
    // 这是缺陷本身：两端各写一份字面量时，改一侧不会有任何东西红。
    const imported = contractsImports(parse(PRELOAD_SOURCE, 'preload.ts'))
    const offenders = eventSites()
      .filter((site) => site.identifier === null || !imported.has(site.identifier))
      .map((site) => `${site.where} ${site.receiver}.${site.method}(${site.literal ?? '<非标识符>'})`)
    expect(offenders, '频道位上出现了手写字面量或非 contracts 来源的名字').toEqual([])
  })

  it('没有本地声明遮蔽 contracts 导入的频道名', () => {
    // 上面那条按**名字**判来源。内层作用域里重名的 const 会让名字对而取值错——这一族在本仓
    // 已经坐实过多次（记忆 sampled-pair-can-be-the-blind-spot 的邻居：同名影子）。
    expect(shadowedImports(), 'contracts 导入的频道名被本地声明遮蔽，来源判据不再可信').toEqual([])
  })

  it('preload 监听的每一个频道，main 侧都真的引用了同一个常量', () => {
    // 这条是承重的那一半：它让 main 侧改回手写字面量当场可见——常量在 main 侧失去全部引用。
    // 反过来，一个 main 从不发的频道也会在这里报（监听器等一个没人发的事件，同样是死功能）。
    const missing = consumedChannels().filter((name) => mainReferences(name).length === 0)
    expect(missing, 'preload 在监听这些频道，但 src/main 下没有任何文件引用同名常量').toEqual([])
  })

  it('自检：把 main 侧一处常量换回字面量，「main 侧都引用了」那条会红', () => {
    // 这条守的是守卫自己。整道门的价值在于对「main 悄悄改回字面量」敏感，所以必须证明它真的敏感。
    // 变异只改一件事：把 ipc.ts 里那一处引用换成它今天的字面值，不动 preload。
    const target = 'RESOURCE_USAGE_CHANNEL'
    const file = join(MAIN_DIR, 'ipc.ts')
    const original = readFileSync(file, 'utf8')
    const mutated = original.replace(
      `sender.send(${target}, snapshot)`,
      "sender.send('agentmux:resource-usage', snapshot)"
    )
    expect(mutated, '锚点没匹配上，自检没有真的构造出「改回字面量」形状').not.toBe(original)
    // 直接问那条规则的取值来源：变异后的 ipc.ts 在 import 之外还用不用这个名字。判据落在**这一个**
    // 常量上，而不是「missing 数组非空」——后者会把自检的成败绑在其它常量当下恰好齐全上。
    //
    // 注意这次变异**只删了取值点，没删 import**——这正是真实的重构会留下的形状，也是它逼出
    // {@link mainReferences} 那个 import 排除的原因（第一版按「出现过」判，这里恒真而自检当场红）。
    expect(
      usesIdentifier(mutated, 'ipc.ts', target),
      `变异后 ipc.ts 仍在 import 之外用 ${target}——那这次变异没构造出被守的形状`
    ).toBe(false)
    // 且这个常量今天确实只由 ipc.ts 一处引用，所以上面那条规则会把它算进 missing。
    expect(mainReferences(target)).toEqual(['ipc.ts'])
  })

  it('自检：把 preload 一处常量换回字面量，「频道实参是导入标识符」那条会红', () => {
    // 与上一条分成两个 it：两个变异各杀一族判据，写在同一个 it 里时先失败的那个会把后面变成死代码
    // （记忆 two-throws-in-one-it-mask-each-other）。
    const mutated = PRELOAD_SOURCE.replace(
      'ipcRenderer.on(BROWSER_EVENT_CHANNEL, wrapped)',
      "ipcRenderer.on('agentmux:browser-event', wrapped)"
    )
    expect(mutated, '锚点没匹配上，自检没有真的构造出字面量形状').not.toBe(PRELOAD_SOURCE)
    const imported = contractsImports(parse(mutated, 'preload.ts'))
    const before = new Set(
      eventSites()
        .filter((site) => site.identifier === null || !imported.has(site.identifier))
        .map((site) => site.where)
    )
    const introduced = eventSites(mutated)
      .filter((site) => site.identifier === null || !imported.has(site.identifier))
      .filter((site) => !before.has(site.where))
    // 差集而不是全集：全集会把这条自检的成败绑在 preload 当下恰好干净上，于是真出现一处字面量时
    // 两条一起红，而这一条红得毫无信息（它只想说「我认得出字面量」）。
    expect(introduced).toHaveLength(1)
    expect(introduced[0]!.literal).toBe('agentmux:browser-event')
  })
})
