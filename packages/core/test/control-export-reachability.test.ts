import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collect,
  compositionEdges,
  externallyReferenced,
  identifierNames,
  parse,
  reachableExports,
  valueExportsOf
} from './helpers/export-reachability.js'

// ---------------------------------------------------------------------------
// 「control.ts 的每个导出都还有生产/消费者在引用它」的接线守护。
//
// 判据引擎（不动点、导出抽取、标识符计数、它看不见什么）住在
// test/helpers/export-reachability.ts，**那份文件头是判据的权威说明**，包括三条盲点。本文件只做两件
// 事：把 control.ts 这一个模块的消费面定下来，以及守住这个模块特有的自检。
//
// 全包范围的同族门在 test/core-export-reachability.test.ts：它扫 src 下每一个模块，本文件则是
// control.ts 的专门自检（种子/闭包分界、`.mjs` 消费面在场）。两者共用同一个引擎，不各写一份——
// 手抄一份引擎正是当初 errors.ts 从没被任何可达性判据覆盖过的原因。
//
// 由来（task #566）：`resolveAgentMuxRegion` 一度被判成"零调用方孤儿"，理由是它在 `.ts` 源码里
// 只被测试引用。那个判断是**错的**——它是 `@agentmux/core/control` 子路径公开 API，且被打包消费
// 契约夹具 `test/fixtures/packed-consumer.mjs` 真正调用。判据当时漏看 `.mjs`，把一个公共 API 误判
// 成死代码，差点删掉一条对外契约。所以本文件的消费面**必须**含 `.mjs`，自检 2 专门钉这件事。
//
// 第二段由来（task #580）：本门第一版写的是「出现次数 ≥ 2」，而扫描面把 control.ts 自己算在内，
// 于是任何**同文件的第二次出现**都能顶满地板。实测那时 `AGENTMUX_CONTROL_LONG_REQUEST_TIMEOUT_MS`
// 与 `isLongAgentMuxControlOperation` 在 control.ts 之外**零**引用却双双绿灯——它们确实不是死代码
// （`agentMuxControlTimeoutMs` 组合了两者，而它有跨包消费者），但让它们过门的不是这条组合关系，
// 只是"同一个文件里又出现了一次"。判对了结论、判据是错的，就是下一次真死代码的入场券。自检 1 把
// 这个分界钉死：种子恰好不含那两个，它们只能靠闭包活。
//
// 本模块的行为判据（可达性判据看不见"引用真的会走到"，见 helper 文件头盲点 1）在
// test/control-host.test.ts 与打包端到端契约 test/fixtures/packed-consumer.mjs。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const coreRoot = join(here, '..') // packages/core
const repoRoot = join(coreRoot, '..', '..')
const controlPath = join(coreRoot, 'src', 'control.ts')

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


describe('control.ts 的导出没有一个是零生产调用方', () => {
  const files = consumerFiles()
  const controlFile = parse(controlPath, readFileSync(controlPath, 'utf8'))
  const exportedValues = valueExportsOf(controlFile)
  const edges = compositionEdges(controlFile)
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
