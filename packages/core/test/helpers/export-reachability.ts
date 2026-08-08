// ---------------------------------------------------------------------------
// 「一个模块的值导出还有没有生产调用方」的可达性引擎。
//
// 由来：这套判据原本长在 test/control-export-reachability.test.ts 里，只服务 control.ts 一个模块
// （#566 误判 + #580 假绿的产物）。抽出来的直接动机是 packages/core/src/errors.ts 的
// `CommandExecutionError` 死了很久没人发现——那个模块从来不在任何可达性判据的覆盖面里。
// 把引擎再手抄一份是**制造**熵而不是减熵，所以抽成共享 helper，两个门共用同一套判据。
//
// 判据是**可达性不动点**，不是「出现次数 ≥ N」（#580）：
//   种子：在被测模块**之外**的消费面里被按标识符引用过的导出；
//   闭包：模块**内部**被某个已存活导出的声明体引用到的导出，也算存活；反复扩张到不动。
//   剩下的就是死的——既没有外部消费者，也没有活着的同模块调用方。
//
// 为什么不能只写「≥2 次出现」：那道门把被测模块自己算进扫描面，于是任何**同文件的第二次出现**都能
// 顶满地板——`export type X = typeof X_CODES[number]` 这样的类型别名、一次自递归、一处内部组合，都让
// 一个真的零外部引用的导出过关。判对了结论、判据是错的，就是下一次真死代码的入场券。
//
// 一切名字识别都走 TypeScript 自己的 parser，不用正则（#580 的 F2/F3）：
//   - 导出抽取认得 `const`/`let`/`var`、一条语句里多个 declarator、`function`/`async function`/
//     `function*`、`class`/`abstract class`、`enum`、`export { x }`、`export { x as y }`、
//     `export default function f`。手写正则漏掉过其中六种。
//   - 引用计数只数**标识符**，所以注释里的 `{@link name}`、字符串与模板字面量里的同名文本天然不算。
//     此前那份 `stripComments` 用正则剥注释，会把字符串里含 `//` 的行（URL、路径）从那里截断，顺带
//     吃掉同一行后面真正的引用。
//
// **这套判据看不见什么**（务必知道，否则会误以为它保证得更多）：
//   1. 源码文本不执行。它证明"有人按名字引用了这个导出"，不证明"那个引用真的会在运行时走到"。一个
//      导出可能被引用、却因为调用点自身变成 no-op（比如方法第一行插了早退）而实际从不生效——那种
//      失效**只有行为测试能抓**。
//   2. 闭包这一步只沿**同文件**的组合关系传递。若某天模块 M 的导出 A 只被另一个模块里的死导出 B
//      引用，A 会被判成活的（B 的死是覆盖 B 那个模块的门该管的事）。
//   3. 按标识符名匹配，不做符号解析：别处若有同名局部变量会被算成一次引用。调用方必须自己确认被测
//      模块的导出名足够独特，并用 `externallyReferenced` 对一个保证不存在的名字自检"数得出零"。
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/** 收集一个目录下（递归）指定扩展名的文件，排除构建产物与依赖。 */
export function collect(root: string, exts: readonly string[]): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root, { recursive: true }) as string[]
  } catch {
    return []
  }
  return entries
    .filter((rel) => exts.some((ext) => rel.endsWith(ext)))
    .map((rel) => join(root, rel))
    .filter((path) => !path.includes(`${'/'}dist${'/'}`) && !path.includes(`${'/'}node_modules${'/'}`))
}

export function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
}

/**
 * 一个模块里的**值**导出。类型不进入运行时，不在本判据范围（`export type` / `interface` /
 * `export type { … }` / `export { type x }` 全部排除）。
 */
export function valueExportsOf(sourceFile: ts.SourceFile): string[] {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) {
        // `export { x }` 与 `export { internal as x }` 都要数**本地**那个名字：判的是"这个模块里
        // 定义的东西还有没有人用"，而不是它对外叫什么。
        if (!element.isTypeOnly) names.add((element.propertyName ?? element.name).text)
      }
      continue
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue
    if (ts.isVariableStatement(statement)) {
      // 一条语句里可以有多个 declarator（`export const a = 1, b = 2`），逐个收。
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) names.add(statement.name.text)
    }
  }
  return [...names]
}

/** 一份源码里出现过的所有标识符名。注释与字符串/模板字面量里的文本不是标识符，天然不计。 */
export function identifierNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text)
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return names
}

/**
 * 「导出 A 的唯一同模块引用者是**非导出**的 B」这件事的实测见证，即只收导出那版引擎的全部误判。
 *
 * 实测（本表落地时）：只沿导出传递会把 7 个模块 / 14 个导出报成死的，而正确判据是 4 个模块 /
 * 5 个导出——多出来的 9 个导出全在下表，散在 3 个模块里。它是**数据而不是注释**，因为自检 5 会逐条
 * 质询三件事：A 仍是导出、B 仍是同模块顶层绑定且**不是**导出、B 的声明体真的引用了 A。任何一条
 * 不成立就红，于是重命名/删除不会像注释那样静默留下一句虚构的举例。
 */
export const NON_EXPORTED_INTERMEDIARY_WITNESSES: ReadonlyArray<{
  module: string
  export: string
  intermediary: string
}> = [
  // 七个方言常量只被非导出的 HOOK_LIFECYCLE_DIALECTS 表收着。
  { module: 'src/agent-hook-event.ts', export: 'PASCAL_CASE_HOOK_DIALECT', intermediary: 'HOOK_LIFECYCLE_DIALECTS' },
  { module: 'src/agent-hook-event.ts', export: 'HERMES_HOOK_DIALECT', intermediary: 'HOOK_LIFECYCLE_DIALECTS' },
  { module: 'src/agent-hook-event.ts', export: 'PI_HOOK_DIALECT', intermediary: 'HOOK_LIFECYCLE_DIALECTS' },
  { module: 'src/agent-hook-event.ts', export: 'GROK_HOOK_DIALECT', intermediary: 'HOOK_LIFECYCLE_DIALECTS' },
  { module: 'src/agent-hook-event.ts', export: 'GEMINI_HOOK_DIALECT', intermediary: 'HOOK_LIFECYCLE_DIALECTS' },
  { module: 'src/agent-hook-event.ts', export: 'CURSOR_HOOK_DIALECT', intermediary: 'HOOK_LIFECYCLE_DIALECTS' },
  { module: 'src/agent-hook-event.ts', export: 'COPILOT_HOOK_DIALECT', intermediary: 'HOOK_LIFECYCLE_DIALECTS' },
  // 截断上限只被非导出的 clamp() 读。
  { module: 'src/hook-tool-outcome.ts', export: 'MAX_TOOL_OUTPUT_CHARS', intermediary: 'clamp' },
  // 事件名清单只被非导出的 openCodePluginSource() 插进生成的插件源码里。
  { module: 'src/providers/opencode.ts', export: 'OPENCODE_HOOK_EVENTS', intermediary: 'openCodePluginSource' }
]

/**
 * 模块里**所有**顶层绑定的声明节点，导出与否都收（名字 → 声明）。
 *
 * 为什么不能只收导出（这是本引擎第一版的真缺陷）：同模块的组合关系经常绕一层**非导出**的局部，
 * 只沿导出传递就会把这些导出全判成死的。这三族是那次误判的全部内容，逐条列在
 * {@link NON_EXPORTED_INTERMEDIARY_WITNESSES}，由 core-export-reachability 的自检 5 逐条质询——
 * 举例写在注释里没有读者，一条被重命名或删掉的"例子"会静默变成虚构（本条此前第三个例子
 * `AGENT_PROMPT_DELIVERY_INTERRUPTED` 就是这样：全仓只剩这句注释提到它）。
 */
export function topLevelBindings(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const bindings = new Map<string, ts.Node>()
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) bindings.set(declaration.name.text, declaration)
      }
      continue
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      bindings.set(statement.name.text, statement)
    }
  }
  return bindings
}

/** 一个顶层绑定的声明节点（用于问"它的实现体引用了哪些别的绑定"）。 */
export function declarationOf(sourceFile: ts.SourceFile, name: string): ts.Node | null {
  return topLevelBindings(sourceFile).get(name) ?? null
}

/**
 * 顶层绑定之间的引用关系（同模块组合图，含非导出的中间层）。
 * 自引用（递归）刻意不算：一个只被自己调用的绑定仍然是死的。
 */
export function compositionEdges(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  const bindings = topLevelBindings(sourceFile)
  const edges = new Map<string, Set<string>>()
  for (const [name, declaration] of bindings) {
    const referenced = new Set<string>()
    const walk = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text !== name && bindings.has(node.text)) {
        referenced.add(node.text)
      }
      node.forEachChild(walk)
    }
    // 从声明的子节点走起：跳过声明自己的名字，否则每个绑定都会"引用"自己。
    declaration.forEachChild(walk)
    edges.set(name, referenced)
  }
  return edges
}

/** 被测模块之外，各消费面里被引用到的候选名字集合。 */
export function externallyReferenced(
  candidates: readonly string[],
  files: readonly string[]
): Set<string> {
  const found = new Set<string>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // 先做一次廉价的原文包含检查：绝大多数文件一个候选名都不提，没必要为它们建 AST。
    // 这只是**加速器**，不是判据——纯文本命中之后仍然只认 parser 数出来的标识符。
    if (!candidates.some((name) => source.includes(name))) continue
    const names = identifierNames(parse(file, source))
    for (const name of candidates) if (names.has(name)) found.add(name)
  }
  return found
}

/**
 * 可达性不动点：外部引用为种子，沿同模块引用图扩张（**含非导出的中间层**，见
 * {@link topLevelBindings}）。
 *
 * `seedCandidates` 只用来挑种子（种子必然是导出，非导出的名字外部引用不到）；扩张一步走的是
 * `edges`，所以一个导出可以经由若干层非导出局部被判活。
 */
export function reachableExports(
  seedCandidates: readonly string[],
  seeds: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const alive = new Set(seedCandidates.filter((name) => seeds.has(name)))
  let grew = true
  while (grew) {
    grew = false
    for (const name of [...alive]) {
      for (const referenced of edges.get(name) ?? []) {
        if (!alive.has(referenced)) {
          alive.add(referenced)
          grew = true
        }
      }
    }
  }
  return alive
}

/**
 * 一份消费面的标识符索引：文件 → 它里面出现过的标识符名。
 *
 * 全包扫描（每个模块问一次「还有人引用吗」）必须用它，而不是对每个模块重跑一遍
 * {@link externallyReferenced}：后者按候选名做原文预筛，对 75 个模块要把同一批文件读上 75 遍。
 * 建一次索引 = 每个文件恰好 parse 一次。
 */
export type IdentifierIndex = ReadonlyMap<string, ReadonlySet<string>>

export function identifierIndex(files: readonly string[]): IdentifierIndex {
  const index = new Map<string, ReadonlySet<string>>()
  for (const file of files) {
    index.set(file, identifierNames(parse(file, readFileSync(file, 'utf8'))))
  }
  return index
}

/**
 * 一个模块的死导出，判据同 {@link deadExportsOf}，但消费面来自预建索引。
 *
 * 与 `deadExportsOf` 的**唯一实质差别**：减去被测模块自己这件事在这里是**结构性**的
 * （按索引的键跳过 `modulePath`），不再是调用方的义务。#580 那次假绿正是「调用方忘了减」的形状，
 * 所以能做成结构性就别留成约定。调用方仍应自检索引里确实有那个键（否则跳过什么都没发生）。
 */
export function deadExportsIn(modulePath: string, index: IdentifierIndex): string[] {
  const sourceFile = parse(modulePath, readFileSync(modulePath, 'utf8'))
  const exportedValues = valueExportsOf(sourceFile)
  const seeds = new Set<string>()
  for (const [file, names] of index) {
    if (file === modulePath) continue
    for (const name of exportedValues) if (names.has(name)) seeds.add(name)
  }
  const alive = reachableExports(exportedValues, seeds, compositionEdges(sourceFile))
  return exportedValues.filter((name) => !alive.has(name))
}

/**
 * 一个模块的死导出（零外部引用，且没有任何活着的同模块绑定引用它）。
 *
 * `consumerFiles` **必须**已经减去 `modulePath` 自己——这是判据的要点，否则种子集合会被定义行顶成
 * 全集（#580 那次假绿的直接位点）。调用方自检这件事。全包扫描请改用 {@link deadExportsIn}，
 * 那一版把这件事做成了结构性的。
 */
export function deadExportsOf(modulePath: string, consumerFiles: readonly string[]): string[] {
  return deadExportsIn(modulePath, identifierIndex(consumerFiles))
}
