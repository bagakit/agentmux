import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// 「control.ts 的每个导出都还有生产/消费者在引用它」的接线守护。
//
// 由来（task #566）：`resolveAgentMuxRegion` 一度被判成"零调用方孤儿"，理由是它在 `.ts` 源码里
// 只被测试引用。那个判断是**错的**——它是 `@agentmux/core/control` 子路径公开 API，且被打包消费
// 契约夹具 `test/fixtures/packed-consumer.mjs` 真正调用。判据当时漏看 `.mjs`，把一个公共 API 误判
// 成死代码，差点删掉一条对外契约。这条守卫把那次教训钉死：一个 control.ts 导出只要在
//   - 生产源码（packages/core/src、apps/desktop/src），或
//   - 打包/CLI 入口（packages/core/bin 的 .js、test/fixtures 里的 .mjs 消费者契约），或
//   - 本模块内部被另一个（同样可达的）导出组合调用
// 里被按名字引用过，就算**可达**；否则它只被单元测试引用（.test.ts）——那是"零生产调用方"，红。
//
// 判据是**引用关系**，不是 `not.toContain('name(')` 那种文本匹配：后者被一个裸标识符（换行、
// 别名、`x = name` 而非 `name(`）就绕过（本仓有先例）。这里数的是跨消费面按词边界的出现次数，
// 定义行本身贡献 1，可达则 ≥2。
//
// **这条守卫看不见什么**（务必知道，否则会误以为它保证得更多）：
//   1. 源码文本不执行。它证明"有人按名字引用了这个导出"，不证明"那个引用真的会在运行时走到"。
//      一个导出可能被引用、却因为调用点自身变成 no-op（比如方法第一行插了早退）而实际从不生效——
//      那种失效**只有行为测试能抓**。本模块的行为判据在 test/control-host.test.ts（协议解析、
//      等待预算与慢操作分档、resolveAgentMuxRegion 的歧义/未开/命中语义）与打包端到端契约
//      test/fixtures/packed-consumer.mjs 里。
//   2. 它只看 control.ts 一个模块。别的模块新增的死导出不在它的雷达上。
//   3. 它按词边界数出现次数，同名符号若在别处另有定义会被并进来（control.ts 的导出名都够独特，
//      今天无碰撞；自检 3 用一个保证不存在的名字确保"数得出零"这条能力没退化）。
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
 * 消费者面：生产源码 + CLI/入口 + 打包消费契约夹具。**故意不含 `.test.ts` 单元测试**——一个只被
 * 单元测试引用的导出正是"零生产调用方"，那是要被抓的东西，不是让判据变绿的理由。
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
  ]
}

/** 剥掉块注释与行注释，避免把注释里的名字（如 {@link ...}）算成引用。字符串里的 `//` 不当注释。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1')
}

/** control.ts 里的值导出（function / const / class）。类型导出不进入运行时，不在本判据范围。 */
function valueExportsOf(source: string): string[] {
  const re = /^export (?:async )?(?:function|const|abstract class|class) ([A-Za-z0-9_]+)/gm
  const names: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) names.push(match[1]!)
  return [...new Set(names)]
}

/** 一个名字在所有消费者面里按词边界出现的总次数（含各自的定义行）。 */
function referenceCount(name: string, files: readonly string[], read: (file: string) => string): number {
  const re = new RegExp(`\\b${name}\\b`, 'g')
  let total = 0
  for (const file of files) total += (read(file).match(re) ?? []).length
  return total
}

describe('control.ts 的导出没有一个是零生产调用方', () => {
  const files = consumerFiles()
  const cache = new Map<string, string>()
  const read = (file: string): string => {
    if (!cache.has(file)) cache.set(file, stripComments(readFileSync(file, 'utf8')))
    return cache.get(file)!
  }
  const controlSource = readFileSync(controlPath, 'utf8')
  const exportedValues = valueExportsOf(controlSource)

  it('每个值导出都被生产源码 / 入口 / 打包消费契约引用（不止被单元测试引用）', () => {
    // 定义行本身贡献 1；可达要求 ≥2（除了本模块内部引用，也算上跨面消费者与 .mjs 契约）。
    const dead = exportedValues.filter((name) => referenceCount(name, files, read) < 2)
    expect(
      dead,
      `control.ts 里这些导出只出现在自己的定义处、没有任何生产/消费者引用（只被单元测试引用即属此列）：` +
      `${dead.join(', ')}。要么接线，要么删掉它与其测试——别把死代码留在公共 API 面上。`
    ).toEqual([])
  })

  it('自检 1：扫描面确实包含 packed-consumer.mjs，且 resolveAgentMuxRegion 在那里被引用', () => {
    // 这是当初误判的直接位点。扫描根写错（比如漏了 test/fixtures 的 .mjs）时，这条立刻红，
    // 而不是让上面那条在错误的空扫描面上恒绿。
    const packed = files.find((file) => file.endsWith(`${'/'}packed-consumer.mjs`))
    expect(packed, 'consumerFiles 里没有 packed-consumer.mjs——扫描面漏了 .mjs 消费契约').toBeTruthy()
    expect(
      referenceCount('resolveAgentMuxRegion', [packed!], read),
      'packed-consumer.mjs 里找不到 resolveAgentMuxRegion——扫描面或读取退化了'
    ).toBeGreaterThanOrEqual(1)
  })

  it('自检 2：导出抽取器认得出 control.ts 的已知导出', () => {
    // 抽取器若退化成抽不到东西，上面那条 filter 会在空集上恒绿。
    expect(exportedValues).toContain('resolveAgentMuxRegion')
    expect(exportedValues).toContain('agentMuxControlTimeoutMs')
    expect(exportedValues.length, 'control.ts 值导出抽取器一个都没抽到').toBeGreaterThanOrEqual(5)
  })

  it('自检 3：判据数得出"零引用"——一个保证不存在的名字必被判成死', () => {
    // 若引用计数因为扫描面为空/读取恒返回同一串而永远 ≥2，这条会红，证明"死"这个结论真的可达。
    const nonexistent = 'AgentMuxControlSymbolThatIsNotExportedAnywhere_566'
    expect(referenceCount(nonexistent, files, read)).toBe(0)
  })
})
