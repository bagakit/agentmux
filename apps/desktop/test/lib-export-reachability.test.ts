import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { readAndParse } from './helpers/effect-reachability.js'

// ---------------------------------------------------------------------------
// renderer 的 `lib/` 里，每个 `export` 都得有人消费。
//
// `export` 是一句**断言**：「这个名字有本文件之外的消费者」。没有消费者时它是假的，而代价不只是
// 几行死代码——本仓记过两次更贵的形态：
//   · 「promised-accessor-never-landed」：注释写明「唯一调用方是 X」而 X 从来不存在；
//   · 「declared-capability-silently-not-done」：声明了能力却没有消费者，于是那条轴上的谎言免检。
// 本轮实测到的正是第一种：`rosterBadgeCount` 的 docstring 说它是「折叠花名册徽标的计数」
// （agent-roster.ts）、`attention-event.ts` 又说「行内强调与折叠花名册徽标都读这个」，而那个徽标
// **从未被建造**（AgentRoster 折叠态渲染的是中性总数）。两处注释互相印证，读起来像已交付的接线。
//
// ─── 判据为什么是「不动点」，而不是「名字在别的文件里出现过」───
//
// 后者是最容易写的判据，且**实测不可用**：它在本仓 138 个 lib 模块 / 779 个导出里报出 134 个
// （17%），绝大多数是误报。原因是导出的**类型**常常只在自己文件里被点名，而在调用点是靠**推断**
// 消费的——例如 `TabDropZone` 只出现在同文件的 `Exclude<TabDropZone, 'center'>` 里，可它是
// `resolvePaneColumnEdgeZone` 返回类型的一部分，每个调用方都在用它。「名字没在别处出现」因此
// 不等于「没有消费者」。
//
// 所以判据取**可达性不动点**（沿用 packages/core/test/control-export-reachability.test.ts 的形状）：
//   种子：在**定义文件之外**被提到过名字的导出；
//   闭包：同一个文件里，凡是声明了「已活」名字的那条语句，它引用到的导出也算活——
//        并且**不分那条声明有没有 export**（非导出的本地 helper 也传递可达性）。
//        少了「不分导出」这一条，本判据会把 `MAX_STEP_SUMMARY_LENGTH`（只被同文件的私有
//        `clamp()` 消费）误报成孤儿。这是本文件第一版探针真的犯过的错，写在这里免得重犯。
//   迭代到不动点，剩下的就是**任何地方都没有消费者**的导出。
// 同一份输入下，不动点把 134 收敛到 2。差额里有 131 个是靠闭包翻身的：**118 个类型 + 13 个取值**，
// 全是上面那类「只在自己文件里被点名、在调用点靠推断消费」的误报。
//
// ─── 这条判据**只**保证什么，**不**保证什么 ───
//
//   保证：新增一个谁也不用的导出会红（本文件自检 2 用一个真实存在但无人消费的形状证过）；
//        删掉某个导出的最后一个消费者、而导出留在原地，也会红。
//
//   **不**保证：
//     - 它按**标识符名**匹配，不做符号解析。同名的两个不同实体它分不开，于是它会**偏向判活**
//       （另一个文件里有个同名局部变量就足以当种子）。这是刻意的保守方向：误判活只是漏报一个
//       孤儿，误判死会让人删掉在用的代码。
//     - 它数的是「有没有消费者」，**不**区分消费者是生产代码还是测试。「只有测试引用」在本仓
//       有两种完全相反的含义——结构守卫的 SSOT 枚举器（必须留着导出，删了守卫就失明）与
//       自证式的死函数（测试只是把纯函数的返回值再算一遍）——**这条判据分不开，它不试图分**。
//       本轮实测 12 个这样的导出，逐个判定记在 tracker #615，不在这里用清单表达：白名单会腐烂，
//       而本仓已经记过「forbidden-list-guard-always-leaks」。
//     - 它看不见「该私有」这一类。只被自己文件消费的导出被闭包**正确地**判成活的——它确实有
//       消费者，只是那个消费者在同一个文件里。上面那 131 个里就混着这一类（本轮把
//       `tab-drop-zone.ts` 那个 tab 条高度常量降级为私有，靠的是 review 不是这道门）。降级为
//       私有是另一条规则，需要另一个判据，别指望这里兜。
//     - 它只看 `lib/`。components/、hooks/、store.ts 的导出不在扫描面内（那些文件里 Props 类型
//       只在本文件被点名、由 JSX 推断消费的比例高得多，同一判据在那里的信噪比未实测）。
// ---------------------------------------------------------------------------

const RENDERER_SRC = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
const LIB_DIR = `${RENDERER_SRC}/lib`
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))

function sourceFilesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => /\.tsx?$/u.test(entry))
    .map((entry) => `${root}/${entry}`)
}

/** 这个语句导出了哪些名字。覆盖本仓真实出现的每种写法。 */
function exportedNames(statement: ts.Statement): string[] {
  const isExported = (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    // `export { x }` / `export { x as y }`——对外的名字是 `y`。
    return statement.exportClause.elements.map((element) => element.name.text)
  }
  if (!isExported) return []
  if (ts.isVariableStatement(statement)) {
    // 一条 `export const a = 1, b = 2` 声明两个名字，别只取第一个。
    return statement.declarationList.declarations
      .map((declaration) => declaration.name)
      .filter(ts.isIdentifier)
      .map((name) => name.text)
  }
  const named = statement as ts.Statement & { name?: ts.Node }
  return named.name && ts.isIdentifier(named.name) ? [named.name.text] : []
}

/**
 * 这个语句声明了哪些名字——**不分导不导出**。
 *
 * 闭包要靠它传递「同文件组合」：私有 helper 被判活之后，它引用到的导出也活。漏掉非导出声明
 * 就会把「只被同文件私有函数消费」的导出误报成孤儿。
 */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) => declaration.name)
      .filter(ts.isIdentifier)
      .map((name) => name.text)
  }
  const named = statement as ts.Statement & { name?: ts.Node }
  return named.name && ts.isIdentifier(named.name) ? [named.name.text] : []
}

/** 子树里出现过的全部标识符名。类型位也算——`typeof X` 里的 `X` 是标识符，会被收进来。 */
function identifiersIn(node: ts.Node): Set<string> {
  const names = new Set<string>()
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current)) names.add(current.text)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return names
}

const libFiles = sourceFilesUnder(LIB_DIR)
const consumerFiles = [...sourceFilesUnder(RENDERER_SRC), ...sourceFilesUnder(TEST_DIR)]
const identifiersByFile = new Map(consumerFiles.map((file) => [file, identifiersIn(readAndParse(file).sourceFile)]))

/** 除 `exclude` 之外，有没有文件提到过这个名字。 */
function mentionedOutside(name: string, exclude: string): boolean {
  for (const [file, identifiers] of identifiersByFile) {
    if (file !== exclude && identifiers.has(name)) return true
  }
  return false
}

/** 一个 lib 模块里，没有任何消费者的导出名。 */
function unconsumedExports(file: string): string[] {
  const { sourceFile } = readAndParse(file)
  const statements = [...sourceFile.statements]
  const exported = new Set(statements.flatMap(exportedNames))
  if (exported.size === 0) return []

  const alive = new Set([...exported].filter((name) => mentionedOutside(name, file)))
  // 同文件组合的闭包：迭代到不动点。`alive` 里放的是**任何**已活名字（含非导出的本地 helper），
  // 所以「私有 helper 消费了某个导出」这条边传得过去。
  for (let grew = true; grew; ) {
    grew = false
    for (const statement of statements) {
      if (!declaredNames(statement).some((name) => alive.has(name))) continue
      for (const identifier of identifiersIn(statement)) {
        if (!alive.has(identifier)) {
          alive.add(identifier)
          grew = true
        }
      }
    }
  }
  return [...exported].filter((name) => !alive.has(name))
}

describe('renderer lib 的每个导出都有消费者', () => {
  it('没有任何导出是「生产与测试都不用」的', () => {
    const orphans = libFiles.flatMap((file) =>
      unconsumedExports(file).map((name) => `${file.slice(RENDERER_SRC.length + 1)}  ${name}`)
    )
    // 报出 file + 名字而不是只给个数：孤儿要一眼看得到是哪个。
    expect(
      orphans,
      '这些导出在整棵 renderer 与整个 test/ 里都没有消费者。\n' +
        '要么它是遗孤（删掉），要么它的接线从未落地（那就把接线补上，别让 export 替不存在的\n' +
        '消费者作担保——本仓记过 promised-accessor-never-landed）。\n' +
        `实测：\n${orphans.join('\n')}`
    ).toEqual([])
  })

  it('自检：扫描面非空、闭包不是恒真、不存在的名字计零', () => {
    // 少了这条，上面那条会以最难发现的方式假绿：扫描根写错、后缀过滤写错、导出提取返回空，
    // 任何一种都让 orphans 恒为空数组，而「没扫到」与「扫过了没问题」打印出来一模一样。
    expect(libFiles.length, 'lib 一个文件都没扫到，扫描根坏了').toBeGreaterThan(100)
    expect(consumerFiles.length, '消费者面一个文件都没扫到').toBeGreaterThan(200)

    // 提取器真的认得出导出：随便挑一个文件都该有导出，且总量得是个大数。
    const totalExports = libFiles.reduce(
      (sum, file) => sum + new Set(readAndParse(file).sourceFile.statements.flatMap(exportedNames)).size,
      0
    )
    expect(totalExports, '导出提取器一个名字都没认出来').toBeGreaterThan(500)

    // 不存在的名字必须计零。这条钉住 mentionedOutside 不是恒返回 true——恒真会让上面那条
    // 断言变成「永远没有孤儿」，也就是这道门最危险的假绿形态。
    expect(mentionedOutside('zzzNoSuchExportNameEverAppearsHere', LIB_DIR)).toBe(false)

    // 反向：一个**真的**被外部消费的导出不许被判成孤儿。挑 clipboard-copy 的出口，它有 9 个
    // 组件在调（见 clipboard-copy.test.ts 那张表），是本仓消费面最宽的导出之一。
    expect(unconsumedExports(`${LIB_DIR}/clipboard-copy.ts`)).not.toContain('copyTextToClipboard')
  })

  it('自检：闭包只传「同文件」，不会把跨文件的孤儿也判活', () => {
    // 闭包是这道门唯一的宽判来源：它按语句粒度传播，所以一条语句里同时提到「活的」与「死的」
    // 名字时会一起判活。这条断言钉住它至少没有宽到跨文件——否则只要仓里任何地方还有一个活
    // 导出，全仓导出都会被判活，门就彻底失效了。
    //
    // 探针必须同时满足三条，否则这条自检会恒真：
    //   1. **它得还是导出的**——`unconsumedExports` 只返回导出名，拿一个私有常量当探针，
    //      `not.toContain` 永远成立。本文件第一版正是这么写的（用 tab-drop-zone 里那个已被降级为
    //      私有的常量），删掉闭包时它照旧绿，只有上面第一条红。写在这里免得重犯。
    //   2. 它在**别的**文件里一次都没出现——否则它是种子，活是种子给的，与闭包无关；
    //   3. 它确实被判活——说明闭包在工作。
    // `TabDropZone` 三条全中：它只在同文件的 `Exclude<TabDropZone, 'center'>` 里被点名，而那是
    // `resolvePaneColumnEdgeZone` 返回类型的一部分，每个调用方都靠推断消费它。
    const PROBE = 'TabDropZone'
    const probeFile = `${LIB_DIR}/tab-drop-zone.ts`
    expect(
      [...readAndParse(probeFile).sourceFile.statements.flatMap(exportedNames)],
      `探针 ${PROBE} 必须是导出的，否则 unconsumedExports 永远不会返回它，这条自检恒真`
    ).toContain(PROBE)
    expect(mentionedOutside(PROBE, probeFile), `探针 ${PROBE} 在别的文件里出现了，它是种子而非闭包救活的`).toBe(false)
    expect(unconsumedExports(probeFile)).not.toContain(PROBE)
  })
})
