import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parseTsx, readAndParse } from './helpers/effect-reachability.js'

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
// 后者是最容易写的判据，且**实测不可用**：在引入这道门的那一刻（`d6c7c37^`，138 个 lib 模块 /
// 779 个导出）它报出 134 个（17%），绝大多数是误报。原因是导出的**类型**常常只在自己文件里被
// 点名，而在调用点是靠**推断**
// 消费的——例如 `TabDropZone` 只出现在同文件的 `Exclude<TabDropZone, 'center'>` 里，可它是
// `resolvePaneColumnEdgeZone` 返回类型的一部分，每个调用方都在用它。「名字没在别处出现」因此
// 不等于「没有消费者」。
//
// 所以判据取**可达性不动点**（沿用 packages/core/test/control-export-reachability.test.ts 的形状）：
//   种子：在**定义文件之外**被提到过名字的导出；
//   闭包：同一个文件里，凡是声明了「已活」名字的那条语句，它引用到的导出也算活——
//        并且**不分那条声明有没有 export**（非导出的本地 helper 也传递可达性）。
//        少了「不分导出」这一条，「只被同文件的私有 helper 消费」的导出会被误报成孤儿。
//        **这一条今天在本仓没有任何真实见证**：实测把闭包收窄成只走导出声明，整棵树的裁决一字不变
//        （两种写法都是 0 个孤儿），也就是说它保护的形状此刻一个实例都不存在。所以它由下面
//        「自检 3」用一个**合成模块**钉住——那是本文件里唯一不读真实源码的断言，理由写在那条断言里。
//   迭代到不动点，剩下的就是**任何地方都没有消费者**的导出。
// 同一份输入（`d6c7c37^`）下，不动点把 134 收敛到 2。差额 132 个全是靠闭包翻身的：**118 个类型 +
// 14 个取值**，全是上面那类「只在自己文件里被点名、在调用点靠推断消费」的误报。
// 这两组数必须来自**同一棵树**：本注释第一版把 `134→2`（提交前）与 `131 / 13 个取值`（提交后，那次
// 提交删掉 3 个导出）拼在一句话里，于是 134−2=132 与「131 个」自相矛盾——差额算不平就是这个拼接的
// 指纹。今天的树是 776 个导出 / 131 naive / 0 孤儿，与上面那组不可混用。
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
//       消费者，只是那个消费者在同一个文件里。上面那 132 个里就混着这一类（本轮把
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

/**
 * 不动点本体：给定一份 AST 与「哪些导出算种子」，返回没有任何消费者的导出名。
 *
 * 与 `unconsumedExports` 分开，是为了让判据能跑在**合成模块**上（自检 3）——真实源码里
 * 「只被同文件私有 helper 消费的导出」今天一个都没有，不合成就没有任何东西能让闭包的
 * 「不分导出」那一条变得可观测。
 */
function unconsumedExportsOf(sourceFile: ts.SourceFile, isSeed: (name: string) => boolean): string[] {
  const statements = [...sourceFile.statements]
  const exported = new Set(statements.flatMap(exportedNames))
  if (exported.size === 0) return []

  const alive = new Set([...exported].filter(isSeed))
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

/** 一个 lib 模块里，没有任何消费者的导出名。 */
function unconsumedExports(file: string): string[] {
  return unconsumedExportsOf(readAndParse(file).sourceFile, (name) => mentionedOutside(name, file))
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

  it('自检：闭包传递「非导出」声明——今天没有真实见证，所以用合成模块钉住', () => {
    // 这是本文件里**唯一**不读真实源码的断言，理由必须写清：
    //
    // 闭包刻意「不分那条声明有没有 export」（`declaredNames` 而不是 `exportedNames`），为的是让
    // 「导出只被同文件的**私有** helper 消费」这条边传得过去。而**本仓今天没有任何这种形状**——
    // 实测把闭包收窄成只走导出声明，整棵树的裁决一字不变（两种写法都是 0 个孤儿，差集为空）。
    // 于是那一条收窄在真实源码上**完全不可观测**：把 `declaredNames` 换成 `exportedNames`
    // 整套测试照旧全绿。本仓记过这一族（「守卫要判可达性不是在场」「结构守卫对整体 no-op 免疫」）：
    // 判据必须**被证明会红**，不能假定它守着。
    //
    // 合成模块提供那个缺席的见证：`kept` 只被私有的 `helper()` 引用，`helper` 自己被导出的
    // `entry()` 引用，`entry` 是种子。少了「不分导出」这一跳，`helper` 传不出去，`kept` 会被
    // 误报成孤儿。合成的代价是它不证明真实源码里有这种形状（今天没有），只证明**判据本身**
    // 认得它——所以上面那条全树断言才是主判据，这条只守着它的一个能力。
    const synthetic = parseTsx(
      'synthetic-closure-witness.ts',
      [
        'export const kept = 1',
        'function helper(): number { return kept }',
        'export function entry(): number { return helper() }'
      ].join('\n')
    )
    const seeds = new Set(['entry'])

    expect(
      unconsumedExportsOf(synthetic, (name) => seeds.has(name)),
      '闭包没能穿过非导出的 helper：`kept` 被误报成孤儿。这正是 declaredNames→exportedNames 那次收窄的后果'
    ).toEqual([])

    // 反向自检：这个合成模块**真的**依赖那一跳，否则上面那条恒真。只走导出声明时 `kept` 必须掉出来。
    const exportedOnly = (sourceFile: ts.SourceFile): string[] => {
      const statements = [...sourceFile.statements]
      const exported = new Set(statements.flatMap(exportedNames))
      const alive = new Set([...exported].filter((name) => seeds.has(name)))
      for (let grew = true; grew; ) {
        grew = false
        for (const statement of statements) {
          if (!exportedNames(statement).some((name) => alive.has(name))) continue
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
    expect(
      exportedOnly(synthetic),
      '合成模块没能区分两种闭包，上面那条断言因此恒真——换一个真的依赖私有 helper 的形状'
    ).toEqual(['kept'])
  })
})
