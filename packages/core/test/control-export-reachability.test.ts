import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// 「control.ts 的每个导出都还有生产/消费者在引用它」的接线守护。
//
// 由来（task #566）：`resolveAgentMuxRegion` 一度被判成"零调用方孤儿"，理由是它在 `.ts` 源码里
// 只被测试引用。那个判断是**错的**——它是 `@agentmux/core/control` 子路径公开 API，且被打包消费
// 契约夹具 `test/fixtures/packed-consumer.mjs` 真正调用。判据当时漏看 `.mjs`，把一个公共 API 误判
// 成死代码，差点删掉一条对外契约。
//
// 判据是**可达性不动点**，不是「出现次数 ≥ N」（task #580）：
//   种子：在 control.ts **之外**的消费面里被按标识符引用过的导出；
//   闭包：control.ts **内部**被某个已存活导出的声明体引用到的导出，也算存活；反复扩张到不动。
//   剩下的就是死的——既没有外部消费者，也没有活着的同模块调用方。
//
// 为什么不能只写「≥2 次出现」：那道门把 control.ts 自己算进扫描面，于是任何**同文件的第二次出现**
// 都能顶满地板——`export type X = typeof X_CODES[number]` 这样的类型别名、一次自递归、一处内部组合，
// 都让一个真的零外部引用的导出过关。实测（#580）：`AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS` 与
// `isLongAgentMuxControlOperation` 在 control.ts 之外**零**引用，却双双绿灯。它们不是死代码——
// `agentMuxControlTimeoutMs`（:275）组合了两者，而它自己有跨包消费者——但让它们过门的不是这条组合
// 关系，只是"同一个文件里又出现了一次"。判对了结论、判据是错的，就是下一次真死代码的入场券。
// 不动点把这件事说准：先问有没有外部消费者，再顺着"活的导出组合了谁"往里传递。
// 于是 HEAD 上七个导出全活、**无需任何豁免清单**（种子 5 个，闭包补上那两个）。
//
// 一切名字识别都走 TypeScript 自己的 parser，不用正则（task #580 的 F2/F3）：
//   - 导出抽取认得 `const`/`let`/`var`、一条语句里多个 declarator、`function`/`async function`/
//     `function*`、`class`/`abstract class`、`enum`、`export { x }`、`export { x as y }`、
//     `export default function f`。手写正则漏掉过其中六种。
//   - 引用计数只数**标识符**，所以注释里的 `{@link name}`、字符串与模板字面量里的同名文本天然不算。
//     此前那份 `stripComments` 用正则剥注释，会把字符串里含 `//` 的行（URL、路径）从那里截断，
//     顺带吃掉同一行后面真正的引用。
//
// **这条守卫看不见什么**（务必知道，否则会误以为它保证得更多）：
//   1. 源码文本不执行。它证明"有人按名字引用了这个导出"，不证明"那个引用真的会在运行时走到"。
//      一个导出可能被引用、却因为调用点自身变成 no-op（比如方法第一行插了早退）而实际从不生效——
//      那种失效**只有行为测试能抓**。本模块的行为判据在 test/control-host.test.ts（协议解析、
//      等待预算与慢操作分档、resolveAgentMuxRegion 的歧义/未开/命中语义）与打包端到端契约
//      test/fixtures/packed-consumer.mjs 里。
//   2. 它只看 control.ts 一个模块。别的模块新增的死导出不在它的雷达上。
//   3. 闭包这一步只沿**同文件**的组合关系传递。若某天 control.ts 的导出 A 只被另一个模块里的
//      死导出 B 引用，A 会被这条判成活的（B 的死是别人的守卫该管的事，见第 2 条）。
//   4. 按标识符名匹配，不做符号解析：别处若有同名局部变量会被算成一次引用。control.ts 的导出名
//      都够独特，今天无碰撞；自检 4 用一个保证不存在的名字确保"数得出零"这条能力没退化。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const coreRoot = join(here, '..') // packages/core
const repoRoot = join(coreRoot, '..', '..')
const controlPath = join(coreRoot, 'src', 'control.ts')

/** 收集一个目录下（递归）指定扩展名的文件，排除构建产物与依赖。 */
function collect(root: string, exts: readonly string[]): string[] {
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

/**
 * 消费者面：生产源码 + CLI/入口 + 打包消费契约夹具，**减去 control.ts 自己**。
 *
 * 减掉定义文件是这条判据的要点：种子只能来自外部引用，否则同文件的第二次出现就顶满了地板
 * （#580）。control.ts 内部的组合关系由不动点那一步单独处理。
 *
 * **故意不含 `.test.ts` 单元测试**——一个只被单元测试引用的导出正是"零生产调用方"，那是要被抓的
 * 东西，不是让判据变绿的理由。
 *
 * 关键：`.mjs`（`test/fixtures/packed-consumer.mjs`）必须在内，那是本守卫存在的直接原因——漏看它就是
 * 当初把 `resolveAgentMuxRegion` 误判成孤儿的那个洞。
 */
function consumerFiles(): string[] {
  return [
    ...collect(join(coreRoot, 'src'), ['.ts', '.tsx']),
    ...collect(join(coreRoot, 'bin'), ['.js', '.mjs', '.cjs']),
    ...collect(join(coreRoot, 'test', 'fixtures'), ['.mjs', '.cjs', '.js', '.ts']),
    ...collect(join(repoRoot, 'apps', 'desktop', 'src'), ['.ts', '.tsx'])
  ].filter((file) => file !== controlPath)
}

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
}

/**
 * control.ts 里的**值**导出。类型不进入运行时，不在本判据范围（`export type` / `interface` /
 * `export type { … }` / `export { type x }` 全部排除）。
 */
function valueExportsOf(sourceFile: ts.SourceFile): string[] {
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
function identifierNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text)
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return names
}

/** 一个顶层导出的声明节点（用于问"它的实现体引用了哪些别的导出"）。 */
function declarationOf(sourceFile: ts.SourceFile, name: string): ts.Node | null {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration
      }
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return statement
    }
  }
  return null
}

/**
 * 每个导出的声明体里引用到的**其它导出**（同模块组合关系）。
 * 自引用（递归）刻意不算：一个只被自己调用的导出仍然是死的。
 */
function compositionEdges(
  sourceFile: ts.SourceFile,
  exportedValues: readonly string[]
): Map<string, Set<string>> {
  const exported = new Set(exportedValues)
  const edges = new Map<string, Set<string>>()
  for (const name of exportedValues) {
    const referenced = new Set<string>()
    const declaration = declarationOf(sourceFile, name)
    if (declaration) {
      const walk = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text !== name && exported.has(node.text)) {
          referenced.add(node.text)
        }
        node.forEachChild(walk)
      }
      // 从声明的子节点走起：跳过声明自己的名字，否则每个导出都会"引用"自己。
      declaration.forEachChild(walk)
    }
    edges.set(name, referenced)
  }
  return edges
}

/** control.ts 之外，各消费面里被引用到的候选名字集合。 */
function externallyReferenced(candidates: readonly string[], files: readonly string[]): Set<string> {
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

/** 可达性不动点：外部引用为种子，沿"活导出组合了谁"扩张。 */
function reachableExports(
  exportedValues: readonly string[],
  seeds: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const alive = new Set(exportedValues.filter((name) => seeds.has(name)))
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

describe('control.ts 的导出没有一个是零生产调用方', () => {
  const files = consumerFiles()
  const controlFile = parse(controlPath, readFileSync(controlPath, 'utf8'))
  const exportedValues = valueExportsOf(controlFile)
  const edges = compositionEdges(controlFile, exportedValues)
  const seeds = externallyReferenced(exportedValues, files)
  const alive = reachableExports(exportedValues, seeds, edges)

  it('每个值导出都从生产源码 / 入口 / 打包消费契约可达（自己那个文件里的引用不算）', () => {
    const dead = exportedValues.filter((name) => !alive.has(name))
    expect(
      dead,
      `control.ts 里这些导出在本文件之外零引用，也没有被任何活着的同模块导出组合调用：` +
        `${dead.join(', ')}。要么接线，要么删掉它与其测试——别把死代码留在公共 API 面上。` +
        `注意「同一个文件里又出现了一次」不算引用（#580）。`
    ).toEqual([])
  })

  it('自检 1：判据真的排除了定义文件——否则每个导出都会被自己的定义行判活', () => {
    // 这是 #580 那次假绿的直接位点。扫描面若把 control.ts 放回去，种子集合会变成全集，
    // 上面那条就在一个恒真的判据上绿。
    expect(files, '扫描面里出现了 control.ts 自己——种子会被定义行顶满').not.toContain(controlPath)
    expect(
      exportedValues.filter((name) => !seeds.has(name)).sort(),
      '没有任何导出是"只靠组合关系才活"的——不动点那一步于此退化成恒等，' +
        '假绿会重新变得不可观测。若这是真实变化（那两个常量接上了外部消费者），把本条改成断言空集。'
    ).toEqual(['AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS', 'isLongAgentMuxControlOperation'])
  })

  it('自检 2：扫描面确实包含 packed-consumer.mjs，且 resolveAgentMuxRegion 在那里被引用', () => {
    // 这是 #566 那次误判的直接位点。扫描根写错（比如漏了 test/fixtures 的 .mjs）时，这条立刻红，
    // 而不是让上面那条在错误的空扫描面上恒绿。
    const packed = files.find((file) => file.endsWith(`${'/'}packed-consumer.mjs`))
    expect(packed, 'consumerFiles 里没有 packed-consumer.mjs——扫描面漏了 .mjs 消费契约').toBeTruthy()
    expect(
      identifierNames(parse(packed!, readFileSync(packed!, 'utf8'))),
      'packed-consumer.mjs 里找不到 resolveAgentMuxRegion——扫描面或读取退化了'
    ).toContain('resolveAgentMuxRegion')
  })

  it('自检 3：导出抽取器认得出 control.ts 的已知导出', () => {
    // 抽取器若退化成抽不到东西，上面那条 filter 会在空集上恒绿。
    expect(exportedValues).toContain('resolveAgentMuxRegion')
    expect(exportedValues).toContain('agentMuxControlTimeoutMs')
    expect(exportedValues.length, 'control.ts 值导出抽取器一个都没抽到').toBeGreaterThanOrEqual(5)
  })

  it('自检 4：判据数得出"零引用"——一个保证不存在的名字必被判成死', () => {
    // 若引用检测因为扫描面为空/读取恒返回同一串而永远命中，这条会红，证明"死"这个结论真的可达。
    const nonexistent = 'AgentMuxControlSymbolThatIsNotExportedAnywhere_566'
    expect(externallyReferenced([nonexistent], files).size).toBe(0)
    expect(reachableExports([nonexistent], new Set(), new Map()).size).toBe(0)
  })

  it('自检 5：抽取器认得每一种值导出写法，且不把类型导出算进来', () => {
    // 此前那份正则只认 `export (async )?(function|const|abstract class|class)`：`let`/`var`、
    // 一条语句里的第二个 declarator、`function*`、`enum`、`export { x }`、`export default function f`
    // 六种全部漏掉。漏掉即那个导出永远不在候选里，死了也没人报。
    const probe = parse(
      'probe.ts',
      [
        'export const aConst = 1',
        'export let aLet = 2',
        'export var aVar = 3',
        'export const multiA = 1, multiB = 2',
        'export function aFn() {}',
        'export async function aAsyncFn() {}',
        'export function* aGen() {}',
        'export class AClass {}',
        'export abstract class AAbstract {}',
        'export enum AnEnum { X }',
        'const internal = 5',
        'export { internal as aliased }',
        'export default function aDefaultNamed() {}',
        'export type AType = string',
        'export interface AnIface { x: number }',
        'export type { AType as ReExportedType }',
        'export { type AnIface as TypeOnlyNamed }'
      ].join('\n')
    )
    expect(valueExportsOf(probe).sort()).toEqual([
      'AAbstract',
      'AClass',
      'AnEnum',
      'aAsyncFn',
      'aConst',
      'aDefaultNamed',
      'aFn',
      'aGen',
      'aLet',
      'aVar',
      'internal',
      'multiA',
      'multiB'
    ])
  })

  it('自检 6：引用检测只认标识符——注释与字符串里的同名文本不算引用', () => {
    // 反过来也要成立：真引用必须被认出来，否则"不算"就是靠整体失明换来的。
    // 此前用正则剥注释，字符串里含 `//` 的行（URL、路径）会被从那里截断，连同一行后面的真引用
    // 一起吃掉——那是**假绿**（把真引用读成零）与**假红**（把注释读成引用）各一半。
    const probe = parse(
      'probe.ts',
      [
        '// 行注释里提到 CommentOnlyName 与一个 http://example.com//path',
        '/* 块注释里也提到 CommentOnlyName */',
        "const inSingle = 'StringOnlyName'",
        'const inDouble = "path//with//slashes 与 StringOnlyName"',
        'const inTemplate = `StringOnlyName 在模板里`',
        'const real = ActuallyReferencedName'
      ].join('\n')
    )
    const names = identifierNames(probe)
    expect(names.has('CommentOnlyName'), '注释里的名字被算成了引用').toBe(false)
    expect(names.has('StringOnlyName'), '字符串/模板里的名字被算成了引用').toBe(false)
    expect(names.has('ActuallyReferencedName'), '真引用没被认出来——检测整体失明').toBe(true)
  })
})
