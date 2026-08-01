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
 */
function detachedMemberReads(sourceText: string, fileName: string): { line: number; object: string; member: string }[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: { line: number; object: string; member: string }[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      found.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        object: node.expression.text,
        member: node.name.text
      })
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

  it('前提自检：判据认得出摘下来的方法，也不会把正常调用与注释算进来', () => {
    // 这条守的是「判据自己失效」：`detachedMemberReads` 恒返回空数组时，下面那条主守卫会
    // **静默全绿**，而它正是这个仓库最贵的一族假绿。所以判据的两侧都要在场，且都由这条钉住。
    const probe = [
      'const shell = { exit: app.exit }', // 摘下来——必须认出
      'app.exit(1)', // 正常调用，receiver 在场——不许算进来
      '/** 说明：不要写 app.quit，它会丢 receiver */', // 注释——第一版正则在这里吃过八条假红
      'const message = "app.quit 也不该被算进来"' // 字符串
    ].join('\n')
    const reads = detachedMemberReads(probe, 'probe.ts').map((read) => `${read.object}.${read.member}`)
    expect(reads, '摘下来的方法没被认出——主守卫此刻什么都不检查').toContain('app.exit')
    expect(reads.filter((name) => name === 'app.exit'), '正常调用 `app.exit(1)` 被算成摘下来了——假红')
      .toHaveLength(1)
    expect(reads, '注释或字符串里的 `app.quit` 被算进来了——判据没有词法边界').not.toContain('app.quit')
  })

  it('src/main 里没有从 electron 单例上摘下来的方法引用', () => {
    const methodsBySingleton = new Map(
      singletons.map(({ name, type }) => [name, methodNamesOf(declarations, type)])
    )
    const files = sourceFilesUnder(MAIN_DIR)
    expect(files.length, 'src/main 一个源文件都没扫到，这条守卫是死代码').toBeGreaterThan(10)

    const detached: string[] = []
    for (const path of files) {
      const relative = path.slice(MAIN_DIR.length + 1)
      for (const read of detachedMemberReads(readFileSync(path, 'utf8'), relative)) {
        if (!methodsBySingleton.get(read.object)?.has(read.member)) continue
        detached.push(`${relative}:${read.line}  ${read.object}.${read.member}`)
      }
    }

    expect(detached, [
      '有 electron 单例的方法被从宿主对象上摘了下来。receiver 丢了，真机上调用抛 Illegal invocation，',
      '而 tsc 与注入普通对象的测试都看不见（普通对象上摘下来照样能调）。',
      '修法：传宿主对象本身（`{ app }` 而不是 `{ exit: app.exit }`），由取值处 `app.exit(code)` 调用；',
      '或者包一层箭头 `() => app.exit(code)`。参考 src/main/startup-failure-exit.ts 那三个注入端口。'
    ].join('\n')).toEqual([])
  })
})
