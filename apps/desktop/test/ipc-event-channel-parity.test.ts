import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * IPC **事件**面（推送与回送）两端必须指向同一个常量。
 *
 * 为什么单独一条：`ipc-parity.test.ts` 守的是 `handle` / `invoke` 那条请求-响应面，它的提取器认的是
 * `handle(...)` / `invoke(...)` 调用节点。事件面（`webContents.send` / `ipcRenderer.on`）**整个在它视野外**。
 * 而这一面的失败方向和请求面一样静默：`send` 与 `on` 的第一个形参都是 `channel: string`，两侧各自手写
 * 字面量时，拼错一侧编译干净、监听器注册成功、然后永远收不到东西——功能整条死掉，没有任何一处报错。
 *
 * ## 判据：**按方向**比两个集合，不是「名字在对面出现过」
 *
 * 1. **preload 侧穷举**：preload 里每一处 `.on/.off/.once/.send`，接收者必须是 `ipcRenderer`，
 *    且频道实参必须是**从 contracts 导入的标识符**，不许是字面量。
 * 2. **main→renderer 推送方向**：`src/main` 下所有 IPC 推送调用用的频道集合，必须与 preload
 *    `on/off/once` 监听的频道集合**逐元素相等**。
 * 3. **renderer→main 回送方向**：preload `ipcRenderer.send` 用的频道集合，必须与 `ipcMain.on/once`
 *    监听的频道集合**逐元素相等**。
 * 4. **两侧来源**：频道位上的标识符，必须是**它所在文件**从 contracts 导入的名字，**且没有被本地
 *    声明遮蔽**。同名 `const` 让名字对而取值错，是这一族最静默的形状；这一条 preload 与 main 各判
 *    一次，判据同一个函数（`shadowedContractsImports`）。
 *
 * ### 为什么必须是「相等」而不是「被引用过」
 *
 * 上一版第 2 条问的是「这个常量在 `src/main` 下某个文件里出现过吗」。那条规则有三个已**实测**的漏点，
 * 三个都是全绿存活：
 *
 * - **交叉接线**：把 preload 的 session 监听接到另一个真实频道常量上（两边都是导入的、都在 main 被引用、
 *   都是 `string`）→ renderer 等错频道、main 往没人听的频道发。7 条全绿，`tsc` exit 0。
 * - **装饰性引用**：把真发送点改回字面量（真 bug），同时在无关文件里加一行 `const _x = THE_CHANNEL`
 *   → 常量「被引用过」恒真。7 条全绿；本仓 `noUnusedLocals` 没开（见 #324），死绑定连 tsc 都不说话。
 * - **非频道导出**：频道位上放任何 contracts 导出（例如 `CONFIG_VERSION`）都算合格。当时只有 tsc 因
 *   `number` 不能赋给 `string` 偶然拦住——换一个 string 值的非频道导出就同时过门和过 tsc。
 *
 * 按方向比集合把三个一起收掉：交叉接线让两个集合各差一个元素；改回字面量让那个常量退出**发送**集合
 * （装饰性引用不在发送位上，救不了它）；非频道导出根本不在 main 的发送集合里。
 *
 * 三条规则合起来还有一个构造性的结论：第 1 条要求 preload 用导入标识符，第 2/4 条要求 main 用同名的
 * contracts 导入，于是「两端各写一份相同字面量」这种最初的缺陷形状也不可能通过——preload 那一半先红。
 *
 * ## 「哪些 `.send(` 算 IPC 推送」按**实参形状**判，不按接收者名字
 *
 * `src/main` 里还有非 IPC 的 `.send(...)`：`browser-view-manager` 有个私有 `send(event: BrowserEvent)`
 * 助手，四处调用传的是对象字面量。区分它们**不能**用接收者白名单（`webContents` / `sender` / …）——
 * 禁止/允许清单按名字判是本仓反复漏的一族（记忆 forbidden-list-guard-always-leaks）。这里改成问
 * **第一个实参可不可能是频道**：频道位只能是字符串字面量或标识符，对象字面量不可能是，于是私有助手
 * 自然落选，不需要为它写例外。
 *
 * 这个判据的失败方向是**响亮的**：哪天有人把非 IPC 的事件对象提成变量再 `this.send(e)`，`e` 是标识符，
 * 这道门会把它当推送站点、发现它不在 preload 的监听集合里而**当场红**。那正是想要的方向——有人得来
 * 教这道门那个区别，而不是让它悄悄漏掉一半站点。
 *
 * ## 频道清单从**消费侧**派生，不按命名约定
 *
 * 清单不是「contracts 里名字以 `_CHANNEL` 结尾的导出」——那是一条手抄规则，换个后缀就走出视野
 * （记忆 derivation-source-must-be-the-consumed-one：派生源要取消费侧真读的那份）。清单是
 * **两侧实际用在频道位上的那些标识符**。
 *
 * ## 已申报的盲点
 *
 * - 只看 preload↔main。renderer 拿事件的唯一途径是 preload 暴露的 `onX`，那一层由
 *   `preload-consumption` 那族守；本文件不重复。
 * - `invoke` / `handle` 的字面量是**刻意放过**的：那一面由 `ipc-parity.test.ts` 双向比集合，比这里更强
 *   （它连「注册了没人调」都能报）。这里只管没有 parity 覆盖的事件面。
 * - 不做接收者的**同名影子**推理，改成正面要求：preload 里的事件接收者只允许是 `ipcRenderer`，
 *   且 `ipcRenderer` 必须是未改名的 electron 导入、且不被任何本地声明遮蔽。这三条都是显式断言，
 *   哪天 preload 真需要挂别的 emitter，是这道门**响亮地红**，而不是悄悄漏掉一半站点。
 * - **动态频道**：`ipcRenderer.on(pick(x), cb)` 这种既非标识符又非字面量的形状，在 preload 侧算违规
 *   （第 1 条会报它）；在 main 的 `.send` 侧则被判为「不是 IPC 推送」而跳过。所以 main 侧真要动态算
 *   频道，这道门看不见——那一天需要另立判据，本文件不假装守住了它。
 * - **两侧集合相等**不等于**语义配对**：如果两条推送频道被互相对调（A 的发送点改用 B、B 的改用 A），
 *   两个集合仍然相等，这道门沉默。它守的是「每条被监听的频道都有人发、每条被发的频道都有人听」，
 *   不是「哪个 handler 收哪条」。后者要靠各频道自己的行为测试。
 */

const PRELOAD_TS = new URL('../src/preload/index.ts', import.meta.url)
const PRELOAD_SOURCE = readFileSync(PRELOAD_TS, 'utf8')
const MAIN_DIR = fileURLToPath(new URL('../src/main', import.meta.url))

/** electron 里能**收**一条事件的方法名。`invoke` 不在内：它是请求面，由 ipc-parity 那条守。 */
const LISTEN_METHODS = new Set(['on', 'off', 'once'])
/** 往对面**推**一条事件的方法名。 */
const SEND_METHOD = 'send'
/** preload 侧要穷举的全部事件方法：收 + 推。 */
const EVENT_METHODS = new Set([...LISTEN_METHODS, SEND_METHOD])

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
    if (!/contracts(\.js)?$/u.test(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) names.add(element.name.text)
  }
  return names
}

/**
 * `ast` 里被本地声明遮蔽的 contracts 导入名。
 *
 * 「名字对而取值错」是本文件所有形状里最静默的一个：`const SESSION_EVENT_CHANNEL = 'typo'` 让两侧
 * 集合的**元素名**完全一致，集合判据全绿，而运行期两端在两条不同的频道上。两侧都要跑这个检测，
 * 不能只跑 preload——这条正是本轮变异矩阵当场逼出来的：只按「名字在 import 清单里」判时，往
 * `window-resize-events.ts` 的推送上方插一个同名局部 `const` 的变异 **11 条全绿存活**，而那一族的
 * 注释已经写明它该被守住（记忆 comment-promises-more-than-assertion）。
 */
function shadowedContractsImports(ast: ts.SourceFile): Set<string> {
  const imported = contractsImports(ast)
  const out = new Set<string>()
  const walk = (node: ts.Node): void => {
    const declared =
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
          ? node.name?.text
          : undefined
    if (declared && imported.has(declared)) out.add(declared)
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(ast, walk)
  return out
}

/** 一处方法调用：接收者原文、方法名、调用节点本身。 */
type MethodCall = { receiver: string; method: string; call: ts.CallExpression }

/**
 * `ast` 里所有对 `methods` 中某个方法的调用，**点号与下标两种取法都算**。
 *
 * 下标取法是承重的，不是周全：`ipcRenderer['on'](…)` 与点号写法在运行期完全等价，而只认
 * `PropertyAccessExpression` 的上一版对它彻底失明——把 preload 两处 session 站点改成下标取法加错频道，
 * 7 条全绿且 `tsc` exit 0，正是这道门声称要防的「监听死频道」。
 */
function methodCalls(ast: ts.SourceFile, methods: Set<string>): MethodCall[] {
  const out: MethodCall[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const target = node.expression
      let method: string | undefined
      let receiver: ts.Node | undefined
      if (ts.isPropertyAccessExpression(target)) {
        method = target.name.text
        receiver = target.expression
      } else if (
        ts.isElementAccessExpression(target) &&
        ts.isStringLiteralLike(target.argumentExpression)
      ) {
        method = target.argumentExpression.text
        receiver = target.expression
      }
      if (method !== undefined && receiver !== undefined && methods.has(method)) {
        out.push({ receiver: receiver.getText(ast), method, call: node })
      }
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(ast, walk)
  return out
}

/** 频道实参的形状。两个都是 null 表示既非标识符也非字面量（动态算的）。 */
type ChannelArg = { identifier: string | null; literal: string | null }

function channelArg(call: ts.CallExpression): ChannelArg {
  const first = call.arguments[0]
  if (!first) return { identifier: null, literal: null }
  if (ts.isIdentifier(first)) return { identifier: first.text, literal: null }
  if (ts.isStringLiteralLike(first)) return { identifier: null, literal: first.text }
  return { identifier: null, literal: null }
}

/** 一处事件调用：位置、接收者、方法、频道实参形状。 */
type EventSite = { where: string; receiver: string; method: string } & ChannelArg

function siteAt(ast: ts.SourceFile, file: string, entry: MethodCall): EventSite {
  const { line } = ast.getLineAndCharacterOfPosition(entry.call.getStart(ast))
  return {
    where: `${file}:${line + 1}`,
    receiver: entry.receiver,
    method: entry.method,
    ...channelArg(entry.call)
  }
}

/**
 * preload 里每一处事件调用。
 *
 * 判据落在 AST 而不是文本：`ipcRenderer.on('x', …)` 这串字在注释里出现过（讲这个桥是什么），
 * 按行猜注释边界是一族已坐实的盲点（记忆 lexical-boundaries-need-a-real-lexer）。
 */
function eventSites(source = PRELOAD_SOURCE, fileName = 'preload/index.ts'): EventSite[] {
  const ast = parse(source, fileName)
  return methodCalls(ast, EVENT_METHODS).map((entry) => siteAt(ast, fileName, entry))
}

/** preload 用在频道位上、且确实来自 contracts 的标识符——按方法族分方向。 */
function preloadChannels(methods: Set<string>, source = PRELOAD_SOURCE): string[] {
  const imported = contractsImports(parse(source, 'preload/index.ts'))
  return [
    ...new Set(
      eventSites(source)
        .filter((site) => methods.has(site.method))
        .map((site) => site.identifier)
        .filter((name): name is string => name !== null && imported.has(name))
    )
  ].sort()
}

/** 一处 main 侧 IPC 站点：频道取值 + 它在自己文件里是不是 contracts 导入。 */
type MainSite = { where: string; channel: string; fromContracts: boolean }

/** `src/main` 下每个文件的源码。测试构造变异时用 `overrides` 顶替其中某个文件。 */
function mainSources(overrides: ReadonlyMap<string, string> = new Map()): [string, string][] {
  return sourceFiles(MAIN_DIR).map((file) => {
    const rel = relative(MAIN_DIR, file)
    return [rel, overrides.get(rel) ?? readFileSync(file, 'utf8')]
  })
}

/**
 * main 侧的 IPC 站点：一个方向一次扫描。
 *
 * `receiver` 给 `null` 表示不限接收者——推送方向就是这样：`window.webContents.send` /
 * `sender.send` / `client.send` 都算，「算不算推送」交给实参形状判（见文件头）。回送方向则必须
 * 挂在 `ipcMain` 上。
 *
 * `fromContracts` 的三个合取项要一起看：名字在频道位上（`identifier !== null`）、这个文件从
 * contracts 导入过这个名字（`imported.has`）、且**没有被本地声明遮蔽**（`!shadowed.has`）。
 * 少了第三项就是 F4 那个存活的变异：同名局部 `const` 让前两项恒真而取值是错的。
 */
function mainSites(
  methods: Set<string>,
  receiver: string | null,
  overrides?: ReadonlyMap<string, string>
): MainSite[] {
  const out: MainSite[] = []
  for (const [rel, source] of mainSources(overrides)) {
    const ast = parse(source, rel)
    const imported = contractsImports(ast)
    const shadowed = shadowedContractsImports(ast)
    for (const entry of methodCalls(ast, methods)) {
      if (receiver !== null && entry.receiver !== receiver) continue
      const arg = channelArg(entry.call)
      const channel = arg.identifier ?? arg.literal
      if (channel === null) continue
      const { line } = ast.getLineAndCharacterOfPosition(entry.call.getStart(ast))
      out.push({
        where: `${rel}:${line + 1}`,
        channel,
        fromContracts:
          arg.identifier !== null && imported.has(arg.identifier) && !shadowed.has(arg.identifier)
      })
    }
  }
  return out
}

/**
 * main 侧的 IPC **推送**站点。
 *
 * 「算不算推送」按第一个实参可不可能是频道判：只有字符串字面量或标识符才可能。见文件头
 * 「哪些 `.send(` 算 IPC 推送」一节——那里也写明了这个判据响亮的失败方向。
 */
function mainPushSites(overrides?: ReadonlyMap<string, string>): MainSite[] {
  return mainSites(new Set([SEND_METHOD]), null, overrides)
}

/** main 侧 `ipcMain.on/once` 监听的站点（renderer→main 回送方向的对偶）。 */
function mainListenSites(overrides?: ReadonlyMap<string, string>): MainSite[] {
  return mainSites(LISTEN_METHODS, 'ipcMain', overrides)
}

const channelsOf = (sites: MainSite[]): string[] => [...new Set(sites.map((s) => s.channel))].sort()

/** preload 里被本地声明遮蔽的 contracts 导入名（排序后便于断言）。 */
function shadowedImports(source = PRELOAD_SOURCE): string[] {
  return [...shadowedContractsImports(parse(source, 'preload/index.ts'))].sort()
}

describe('IPC 事件面：两侧按方向指向同一个常量', () => {
  it('提取器真的取到了东西——三个清单都不能落空', () => {
    // 提取器返回空数组会让下面每一条断言变成恒真。preload 或 main 重构成第三种写法时，应当是这一条
    // 先红，而不是别的断言静默变成空转。
    expect(eventSites().length, 'preload 里一处事件调用都没取到——提取器与写法脱节了').toBeGreaterThan(8)
    expect(preloadChannels(LISTEN_METHODS).length, 'preload 一条监听频道都没识别出来').toBeGreaterThan(5)
    expect(mainPushSites().length, 'main 一处 IPC 推送都没取到').toBeGreaterThan(5)
    expect(mainListenSites().length, 'main 一处 ipcMain 监听都没取到').toBeGreaterThan(0)
  })

  it('preload 的事件接收者只有 ipcRenderer，且它是未改名的 electron 导入', () => {
    // 这一条是「穷举」这个词的前提：只有当 preload 里所有事件调用都挂在 ipcRenderer 上，
    // 按方法名枚举才等于枚举了全部 IPC 站点。
    const receivers = [...new Set(eventSites().map((site) => site.receiver))]
    expect(receivers, 'preload 出现了非 ipcRenderer 的事件接收者：本门的穷举前提不再成立').toEqual([
      ALLOWED_RECEIVER
    ])
    // 改名导入（`ipcRenderer as ipc`）或命名空间导入（`import * as electron`）都会让上面那条
    // 按接收者原文的判据失明——它会看见 `ipc` / `electron.ipcRenderer` 而报假红或漏站点。
    const ast = parse(PRELOAD_SOURCE, 'preload/index.ts')
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

  it('每一处 preload 事件调用的频道实参都是 contracts 导入的标识符，不是字面量', () => {
    // 这是缺陷本身的一半：两端各写一份字面量时，改一侧不会有任何东西红。
    const imported = contractsImports(parse(PRELOAD_SOURCE, 'preload/index.ts'))
    const offenders = eventSites()
      .filter((site) => site.identifier === null || !imported.has(site.identifier))
      .map((site) => `${site.where} ${site.receiver}.${site.method}(${site.literal ?? '<非标识符>'})`)
    expect(offenders, '频道位上出现了手写字面量或非 contracts 来源的名字').toEqual([])
  })

  it('没有本地声明遮蔽 contracts 导入的频道名', () => {
    // 上面那条按**名字**判来源。内层作用域里重名的 const 会让名字对而取值错。
    expect(shadowedImports(), 'contracts 导入的频道名被本地声明遮蔽，来源判据不再可信').toEqual([])
  })

  it('main→renderer：main 推送的频道集合与 preload 监听的逐元素相等', () => {
    // 承重的那一半。「相等」而不是「被引用过」：后者被交叉接线、装饰性引用、非频道导出三种形状
    // 各自全绿绕过（见文件头）。相等把三个一起收掉。
    expect(channelsOf(mainPushSites()), 'main 推送与 preload 监听的频道集合不一致').toEqual(
      preloadChannels(LISTEN_METHODS)
    )
  })

  it('renderer→main：preload 回送的频道集合与 ipcMain 监听的逐元素相等', () => {
    // 回送方向同样会静默死掉：preload `send` 一条没人 `ipcMain.on` 的频道，或反之。
    expect(channelsOf(mainListenSites()), 'preload 回送与 ipcMain 监听的频道集合不一致').toEqual(
      preloadChannels(new Set([SEND_METHOD]))
    )
  })

  it('main 侧频道位上的标识符，都是它所在文件从 contracts 导入的名字', () => {
    // 本地 `const SESSION_EVENT_CHANNEL = 'typo'` 会让上面两条集合判据**名字全对**而取值错——
    // 这一族是本文件所有形状里最静默的一个，所以单独一条。
    const local = [...mainPushSites(), ...mainListenSites()]
      .filter((site) => !site.fromContracts)
      .map((site) => `${site.where} ${site.channel}`)
    expect(local, 'main 侧频道位上出现了字面量或非 contracts 来源的名字').toEqual([])
  })

  it('判据自检：下标取法的事件调用也会被提取到', () => {
    // 这条守的是 F1 那个已坐实的绕法：只认点号时，把站点改成 `ipcRenderer['on'](…)` 让它整体隐身，
    // 7 条全绿且 tsc exit 0。样本用独立源码构造，不依赖 preload 当下恰好怎么写。
    const sample = [
      "import { ipcRenderer } from 'electron'",
      "import { SOME_CHANNEL } from '../shared/contracts.js'",
      "ipcRenderer['on'](SOME_CHANNEL, () => {})"
    ].join('\n')
    const sites = eventSites(sample, 'sample.ts')
    expect(sites, '下标取法的调用没被提取到——F1 那个绕法又开着了').toHaveLength(1)
    expect(sites[0]!.method).toBe('on')
    expect(sites[0]!.receiver).toBe(ALLOWED_RECEIVER)
    expect(sites[0]!.identifier).toBe('SOME_CHANNEL')
  })

  it('判据自检：把 main 一处推送换回字面量，推送方向那条集合判据会红', () => {
    // 变异只改一件事：把一处真实推送的常量换成它今天的字面值，不动 preload、不动 import。
    // 「不动 import」是刻意的——那正是真实重构会留下的形状，也正是上一版「被引用过」恒真的原因。
    const target = 'RESOURCE_USAGE_CHANNEL'
    const file = 'ipc.ts'
    const original = readFileSync(join(MAIN_DIR, file), 'utf8')
    const mutated = original.replace(
      `sender.send(${target}, snapshot)`,
      "sender.send('agentmux:resource-usage', snapshot)"
    )
    expect(mutated, '锚点没匹配上，自检没有真的构造出「改回字面量」形状').not.toBe(original)
    const overrides = new Map([[file, mutated]])
    // 判据落在**这一个**常量退出发送集合上，而不是「两个集合不等」——后者会把自检的成败绑在
    // 其它频道当下恰好齐全上。
    expect(
      channelsOf(mainPushSites(overrides)),
      `变异后 ${target} 仍在 main 的推送集合里——那这次变异没构造出被守的形状`
    ).not.toContain(target)
    expect(channelsOf(mainPushSites(overrides))).toContain('agentmux:resource-usage')
    // 且它今天确实只由**一处**推送——这一条是上面那步能成立的前提：如果别处也推送同一频道，
    // 换掉一处不会让常量退出集合，这次自检就证不出集合判据敏感。
    expect(
      mainPushSites().filter((site) => site.channel === target),
      `${target} 今天不只一处推送——这次自检的前提不再成立`
    ).toHaveLength(1)
    // 频道退出发送集合后，两侧集合当场不等：这正是上一版沉默、本版会红的那一步。
    expect(channelsOf(mainPushSites(overrides))).not.toEqual(preloadChannels(LISTEN_METHODS))
  })

  it('判据自检：main 侧的同名局部 const 会让那处站点掉出「来源可信」', () => {
    // F4 那个**实测存活过**的形状：在真实推送上方插一句 `const WINDOW_RESIZE_EVENT_CHANNEL = 'typo'`。
    // 名字仍在 import 清单里，于是两条集合判据全对；只有「有没有被遮蔽」这一项能认出取值错了。
    // 与 F1/F2 分开成独立 it：同一个 it 里两个变异会互相掩盖（记忆
    // two-throws-in-one-it-mask-each-other）。
    const file = 'window-resize-events.ts'
    const target = 'WINDOW_RESIZE_EVENT_CHANNEL'
    const anchor = `window.webContents.send(${target}, event)`
    const original = readFileSync(join(MAIN_DIR, file), 'utf8')
    expect(original.split(anchor).length - 1, `锚点 ${anchor} 不是恰好一处，自检的前提不再成立`).toBe(1)
    const overrides = new Map([
      [file, original.replace(anchor, `const ${target} = 'agentmux:typo'\n    ${anchor}`)]
    ])
    // 前提：变异**没有**动集合——这正是它当初能存活的原因，也是这条自检要证明的那一半。
    expect(
      channelsOf(mainPushSites(overrides)),
      `${target} 应当仍在推送集合里：如果它退出了，说明这次变异改的不只是「取值」一件事`
    ).toContain(target)
    expect(channelsOf(mainPushSites(overrides))).toEqual(channelsOf(mainPushSites()))
    // 判据：那一处站点的来源不再可信。落在**这一处**上，而不是「清单非空」——后者会把自检的成败
    // 绑在别处恰好干净上。
    const site = mainPushSites(overrides).filter((entry) => entry.where.startsWith(`${file}:`))
    expect(site, `${file} 应当恰好有一处推送站点`).toHaveLength(1)
    expect(
      site[0]!.fromContracts,
      '同名局部 const 遮蔽后，来源判据仍说这处站点可信——F4 那个绕法又开着了'
    ).toBe(false)
  })

  it('判据自检：把 preload 一处监听交叉接到另一条真实频道，集合判据会红', () => {
    // 这是 F2 那个已坐实的形状：两个常量都是导入的、都在 main 被引用、都是 string，于是上一版
    // 「被引用过」恒真而 7 条全绿。与上一条分成两个 it：两个变异各杀一族判据，写在同一个 it 里时
    // 先失败的那个会把后面变成死代码（记忆 two-throws-in-one-it-mask-each-other）。
    //
    // 每条频道在 preload 都有**成对**的 `on`/`off`（订阅与退订），所以要构造出「这条频道不再被监听」
    // 必须两处一起换——只换 `on` 时 `off` 那处仍把它留在集合里。这个前提是本条自检第一次跑时当场
    // 逼出来的：只换 `on` 那版红在下面那句断言上，如实说了「这次变异没构造出被守的形状」。
    const cross = (method: string): [string, string] => [
      `ipcRenderer.${method}(SESSION_EVENT_CHANNEL, wrapped)`,
      `ipcRenderer.${method}(WORKSPACE_FILE_INVALIDATED_CHANNEL, wrapped)`
    ]
    let mutated = PRELOAD_SOURCE
    for (const method of ['on', 'off']) {
      const [from, to] = cross(method)
      expect(mutated, `锚点 ${from} 没匹配上，自检没有真的构造出交叉接线形状`).toContain(from)
      mutated = mutated.replace(from, to)
    }
    const listened = preloadChannels(LISTEN_METHODS, mutated)
    expect(
      listened,
      'SESSION_EVENT_CHANNEL 仍在 preload 的监听集合里——这次变异没构造出被守的形状'
    ).not.toContain('SESSION_EVENT_CHANNEL')
    // main 照旧往它推送，于是两个集合不等——这正是上一版沉默、本版会红的那一步。
    expect(channelsOf(mainPushSites())).toContain('SESSION_EVENT_CHANNEL')
    expect(listened).not.toEqual(channelsOf(mainPushSites()))
  })

  it('判据自检：非 IPC 的 `.send(对象字面量)` 不算推送站点', () => {
    // 这条既防误伤也防判据松掉。browser-view-manager 的私有 `send(event)` 助手今天有多处调用传对象
    // 字面量；把它们算成推送会让集合判据永远不等（这道门当场变成假红）。反过来，如果哪天有人把
    // 「算不算推送」改成接收者白名单，这条自检不会红——所以它只证形状判据在场，不证白名单不存在。
    const sample = [
      'class Manager {',
      '  private send(event: { type: string }): void { void event }',
      "  private emit(): void { this.send({ type: 'closed' }) }",
      '}'
    ].join('\n')
    const ast = parse(sample, 'sample.ts')
    const calls = methodCalls(ast, new Set([SEND_METHOD]))
    expect(calls, '样本里那处 this.send 没被 methodCalls 取到——自检构造错了').toHaveLength(1)
    expect(
      channelArg(calls[0]!.call),
      '对象字面量被当成了频道实参——集合判据会因此永远不等'
    ).toEqual({ identifier: null, literal: null })
  })
})
