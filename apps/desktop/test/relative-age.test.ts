import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

import { formatRelativeAge, relativeAgeTier } from '../src/renderer/src/lib/relative-age.js'

/**
 * 相对年龄阶梯的判据。
 *
 * ─── 这一族的形状 ───
 *
 * 「一个决定写了两遍」在本仓反复出现，而它最危险的形态是**两遍现在都是对的**：`WorkspaceBoard` 的
 * `formatAge` 与 `SurfaceToolDock` 的 `formatAgentAge` 逐字相同地判 1 分钟 / 60 分钟 / 24 小时三道界，
 * 两份都读同一个 `session.updatedAt`。所以今天没有可观测的 bug——任何行为断言都抓不到它。只有把界挪
 * 一下才会分岔，而那时不会红、不会报错、也没有人会想起还有第二份。
 *
 * 所以这里有三层，各自能独立变红：
 *   行为层 —— 每道界的两侧都钉住（阶梯的取值真的来自入参）；
 *   接线层 —— 消费者真的是从这个 lib 取的年龄，不是自己又算一遍（按 import 关系判，不数名字）；
 *   结构层 —— renderer 源码树里**只有这一个文件**在做毫秒→分钟那次换算。
 *
 * 结构层是唯一能抓「新抄第三份」的那层：行为层对副本完全失明（副本对今天的界是正确的），接线层只
 * 管已知的消费者。本仓教训「等价性抓不到新手抄的一份」说的就是这件事。
 *
 * ─── 已知缺口，逐条写明（不写明的缺口会变成将来的假承诺）───
 *
 *   - 结构层按「除以 60_000」判。换个写法（先除 1000 再除 60、或把 60_000 藏进另一个常量）就绕过。
 *     选它是因为这道阶梯必须做这次换算，而不是因为它不可绕。
 *   - `SurfaceToolDock` 此刻由别的 agent 持有未入库改动，不能改，所以它那份副本仍在树上，结构层为
 *     它开了**一条具名例外**。那条例外自带自检：等它被收进 lib、例外变成死条目时，自检会红并要求
 *     删掉例外——例外不会静默留成永久豁免。
 *   - 后缀不在这个 lib 的管辖内（看板 `' ago'`、窄面留空），这是密度合同下的正当差异，不是漂移。
 *     判据因此不要求两个面输出同一个字符串，只要求档位来自同一处。
 */

const RENDERER_ROOT = resolve(__dirname, '../src/renderer/src')
const AGE_LIB = 'lib/relative-age.ts'

/**
 * 结构层的具名例外。
 *
 * 每条都必须写明**为什么现在不能收**。这不是"允许重复"的清单，是"还没轮到"的清单：`self-check`
 * 会断言每条例外**今天仍然确实持有那份副本**，所以一旦它被收进 lib，这里就变成死条目并打红。
 */
const PENDING_CONVERSION: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'components/SurfaceToolDock.tsx',
    reason: '该文件此刻有别的 agent 的未入库改动，本轮不许动；它的 formatAgentAge 待其释放后收进 lib'
  }
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** 把 `60_000` 这类带分隔符的数字字面量读成数。 */
function numericValue(node: ts.Node): number | null {
  if (!ts.isNumericLiteral(node)) return null
  return Number(node.text.replace(/_/gu, ''))
}

/**
 * 文件里所有绑定到数字字面量的 `const`（`const MS_PER_MINUTE = 60_000`）。
 *
 * 必须解析这一层：给那个数起个名字是**更好**的代码，lib 自己就是这么写的。只认裸字面量的判据看不见
 * lib 本身——第一次跑这道门时正是自检 1 报出了这件事。顺带把「抄一份并给常量起个名」也收进视野。
 */
function numericConstants(source: ts.SourceFile): Map<string, number> {
  const bindings = new Map<string, number>()
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = numericValue(node.initializer)
      if (value !== null) bindings.set(node.name.text, value)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return bindings
}

/** 源码里做了「除以 60_000」这次换算的文件（相对 renderer 根的路径）。 */
function filesConvertingMsToMinutes(): string[] {
  const hits: string[] = []
  for (const path of sourceFiles(RENDERER_ROOT)) {
    const source = parse(path)
    const constants = numericConstants(source)
    /** 除号右边那个操作数是不是 60_000——字面量与同文件常量名两种写法都算。 */
    const isMinuteDivisor = (node: ts.Node): boolean => {
      if (numericValue(node) === 60_000) return true
      return ts.isIdentifier(node) && constants.get(node.text) === 60_000
    }
    let found = false
    const walk = (node: ts.Node): void => {
      if (found) return
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.SlashToken &&
        isMinuteDivisor(node.right)
      ) {
        found = true
        return
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    if (found) hits.push(relative(RENDERER_ROOT, path))
  }
  return hits
}

// ---------------------------------------------------------------------------
// 行为层：每道界的两侧。少钉一侧的症状不是报错，而是某一档永远显示不出来。
// ---------------------------------------------------------------------------
describe('relativeAgeTier 的每道界两侧都判对', () => {
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  it('1 分钟以下是 now，正好 1 分钟就报分钟', () => {
    // 成对：只钉一侧时，把 `< 1` 改成 `< 2` 之类的差一错误会存活。
    expect(relativeAgeTier(0)).toEqual({ unit: 'now' })
    expect(relativeAgeTier(MINUTE - 1)).toEqual({ unit: 'now' })
    expect(relativeAgeTier(MINUTE)).toEqual({ unit: 'minute', value: 1 })
  })

  it('59 分钟仍报分钟，正好 60 分钟翻成小时', () => {
    expect(relativeAgeTier(59 * MINUTE)).toEqual({ unit: 'minute', value: 59 })
    expect(relativeAgeTier(HOUR)).toEqual({ unit: 'hour', value: 1 })
  })

  it('23 小时仍报小时，正好 24 小时翻成天', () => {
    expect(relativeAgeTier(23 * HOUR)).toEqual({ unit: 'hour', value: 23 })
    expect(relativeAgeTier(DAY)).toEqual({ unit: 'day', value: 1 })
  })

  it('取整一律向下，不四舍五入', () => {
    // 守的形状：把 floor 换成 round 会让「89 分钟」报成 2h——比实际新。
    expect(relativeAgeTier(89 * MINUTE)).toEqual({ unit: 'hour', value: 1 })
    expect(relativeAgeTier(2 * DAY - 1)).toEqual({ unit: 'day', value: 1 })
  })

  it('未来的时间戳读成 now，不报负数', () => {
    // 宿主与 daemon 钟不同步时可达。报 `-3m ago` 比报 now 更糟。
    // 承重的是 `minutes < 1` 那道界（负数除完仍是负数），不是一句单独的夹取——lib 里那句
    // `Math.max(0, …)` 删掉后本文件 14 条全绿，实测证明它改不了任何结果，于是删了代码而不是加判据。
    expect(relativeAgeTier(-1)).toEqual({ unit: 'now' })
    expect(relativeAgeTier(-5 * HOUR)).toEqual({ unit: 'now' })
  })
})

describe('formatRelativeAge 的后缀由调用方给，且 now 一档永不带', () => {
  it('数值档带上调用方给的后缀', () => {
    expect(formatRelativeAge(5 * 60_000, ' ago')).toBe('5m ago')
    expect(formatRelativeAge(3 * 3_600_000, ' ago')).toBe('3h ago')
    expect(formatRelativeAge(2 * 86_400_000, ' ago')).toBe('2d ago')
  })

  it('不给后缀时就是裸的——窄面（密度合同把时间戳压在 --fs-micro）要的是这一种', () => {
    // 与上一条成对：后缀必须真的来自入参，不是常量。
    expect(formatRelativeAge(5 * 60_000)).toBe('5m')
    expect(formatRelativeAge(3 * 3_600_000)).toBe('3h')
  })

  it("now 一档不带后缀——'now ago' 不是句子", () => {
    expect(formatRelativeAge(0, ' ago')).toBe('now')
    expect(formatRelativeAge(0)).toBe('now')
  })

  it('三档各自用不同的字母', () => {
    // 守的形状：字母表抄错/对调，两档显示同一个单位而数值不同。
    const letters = [
      formatRelativeAge(5 * 60_000),
      formatRelativeAge(3 * 3_600_000),
      formatRelativeAge(2 * 86_400_000)
    ].map((text) => text.replace(/^\d+/u, ''))
    expect(new Set(letters).size, '三档的单位字母必须互不相同').toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 接线层：消费者真的从 lib 取，而不是自己又算一遍。按 import 关系判——数名字会被
// 同名局部函数骗过（本仓「守卫判据要是 import 关系」记过这一族）。
// ---------------------------------------------------------------------------
describe('WorkspaceBoard 的年龄取自这个 lib', () => {
  const relativePath = 'components/WorkspaceBoard.tsx'

  it('它 import 了 relative-age，而不是自己判档', () => {
    const source = parse(resolve(RENDERER_ROOT, relativePath))
    const specifiers = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => (ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : ''))
    expect(
      specifiers.some((specifier) => specifier.includes('relative-age')),
      'WorkspaceBoard 没有 import relative-age：它要么自己抄了一份阶梯，要么这道判据的扫描面写错了'
    ).toBe(true)
  })

  it('它自己不做毫秒→分钟那次换算', () => {
    // 与上一条成对：光 import 不算接上——旁边留着一份自己的阶梯照旧会漂移。
    expect(filesConvertingMsToMinutes()).not.toContain(relativePath)
  })
})

// ---------------------------------------------------------------------------
// 结构层：唯一能抓「将来又抄一份」的那层。
// ---------------------------------------------------------------------------
describe('毫秒→分钟的换算全树只有 lib 一处', () => {
  it('除了具名例外，没有别的文件做这次换算', () => {
    const converting = filesConvertingMsToMinutes()
    const unexpected = converting.filter(
      (file) => file !== AGE_LIB && !PENDING_CONVERSION.some((entry) => entry.file === file)
    )
    expect(
      unexpected,
      `这些文件自己在判相对年龄的档位，应当改用 lib/relative-age.ts：${unexpected.join(', ')}`
    ).toEqual([])
  })

  it('自检 1：扫描面真的看得见 lib 自己——否则上面那条会恒真', () => {
    // 少了这条，扫描根写错时 `unexpected` 恒为空而整道门静默失效（本仓「扫描根写错静默变绿」）。
    expect(filesConvertingMsToMinutes()).toContain(AGE_LIB)
  })

  it('自检 2：每条具名例外今天确实还持有一份副本', () => {
    // 例外变成死条目（那个文件已经收进 lib 了）就在这里红，逼着把例外删掉——否则它会静默留成
    // 永久豁免，而永久豁免正是这道门要防的东西。
    const converting = filesConvertingMsToMinutes()
    for (const entry of PENDING_CONVERSION) {
      expect(
        converting,
        `例外 ${entry.file} 已经不再自己判档了（理由曾是：${entry.reason}）——请删掉这条例外`
      ).toContain(entry.file)
    }
  })
})
