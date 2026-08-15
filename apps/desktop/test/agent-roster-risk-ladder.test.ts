import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { RISK_TIERS } from '@agentmux/core/risk-tier'
import { rowRiskTier, type RosterRow, type RosterScope } from '../src/renderer/src/lib/agent-roster.js'

// ---------------------------------------------------------------------------
// `rowRiskTier` 的风险阶梯只有一处声明——就是 core 的 `RISK_TIERS`，且 agent-roster 必须**按序号**从它
// 派生，而不是自己手抄一份。
//
// 由来：agent-roster 里的 `rowRiskTier` 曾写死 `const order: RiskTier[] = ['danger','caution','safe']`
// ——这是 `RISK_TIERS`（SSOT 是升序危险度 `['safe','caution','danger']`）的一份**反向手抄**。两份声明
// 只要有一处漂移，"这一行最危险的授权是哪档"就会算错：往 `RISK_TIERS` 加一档（比如 `'lethal'`）而忘了
// 同步这份手抄，新档在手抄里 `indexOf === -1`，只带新档的一行会被判成"无风险"（null），一个真实的授权
// 在名册上静默消失；而"加一档"恰恰是常见方向。
//
// **为什么必须分三层、光靠行为测试不够**：一份**完整**的反向手抄（`['danger','caution','safe']` +
// 首个命中即返回）与"按 `RISK_TIERS` 序号取最大"在今天的三档上**行为完全相同**——任何行为断言都分辨
// 不出二者（本仓 equivalence-cannot-catch-a-fresh-copy）。于是：
//   L1 SSOT 锚点（外部写死的字面量）：钉住 `RISK_TIERS === ['safe','caution','danger']`。**加成员**或
//      **改顺序**都在这里当场红。这是本文件里"member 被加 / 顺序被改"的第一道、也是最直接的闸。
//   L2 行为·派生：逐对遍历**锚点**（不是遍历 `RISK_TIERS`，否则 expected 跟着变异一起漂而恒真，
//      本仓 expected-value-must-not-derive-from-mutation-target），喂真的 `rowRiskTier`，断言它总是返回
//      序号更大（更危险）的那一档。杀"取反了方向""按数组顺序而非危险度取""漏掉某一档"。
//   L3 结构·派生源：`agent-roster.ts` 必须从 node-free 子路径 `@agentmux/core/risk-tier` **按值** import
//      `RISK_TIERS`，且模块内**不得再出现任何等于某个档位名的字符串字面量**（那正是一份手抄的形状）。
//      这一层专杀 L1/L2 都盲的那一种：把完整的反向手抄原样搬回来。走 TS parser 判结构，不做文本 substring。
//
// 三层缺一不可，且各杀各的（见每个 describe 头）：L1 抓 SSOT 侧的增删改，L2 抓派生逻辑写错，
// L3 抓"派生被换回手抄"。
// ---------------------------------------------------------------------------

/**
 * SSOT 的外部锚点——**本文件写死**，故意不从被测的 `RISK_TIERS` 派生。
 *
 * 顺序承重：`RISK_TIERS` 是升序危险度，一个成员的**下标就是它的危险等级**，`rowRiskTier` 取下标最大的
 * 那一档。所以这份锚点的顺序 = 危险度从低到高，L2 的 expected 全部由它算出。往 `RISK_TIERS` 加成员或
 * 改顺序时，这份锚点必须**手动**跟着改——而"跟着改"这件事被 L1 那条 `toEqual` 强制，不是靠记性。
 */
const RISK_TIERS_ANCHOR = ['safe', 'caution', 'danger'] as const
type AnchorTier = (typeof RISK_TIERS_ANCHOR)[number]

/** 一条只在 `scopes` 上有内容的名册行——`rowRiskTier` 只读 `scopes`，其余字段给合法占位值。 */
function rowWith(scopes: RosterScope[]): RosterRow {
  return {
    sessionId: 's',
    label: 'Agent s',
    providerId: 'codex',
    workspacePath: '/repo',
    state: 'working',
    attention: null,
    observedAt: 1,
    awaitingReply: false,
    scopes,
    usage: { kind: 'unsupported', text: '', title: '' },
    // 上下文压力与本文件无关（`rowRiskTier` 只读 scopes），给「没报」这个占位值——不是 0，
    // 因为 0 在 RosterRow 的语义里是「查过了，一点没用」，而这里是「本用例不关心」。
    contextPercent: null,
    contextPressure: null
  }
}

function scope(tier: AnchorTier): RosterScope {
  return { label: 'Sandbox', value: tier, tier }
}

describe('L1 SSOT 锚点：RISK_TIERS 的成员与顺序被外部字面量钉死', () => {
  it('RISK_TIERS 恰好是升序危险度 [safe, caution, danger]——加成员或改顺序在这里当场红', () => {
    // `toEqual` 同时钉长度、成员、顺序：
    //   - 往 RISK_TIERS 加一档 → 长度/内容不符 → 红（这就是"member 被加到 RISK_TIERS"要触发的红）。
    //   - 把 RISK_TIERS 悄悄重排（如反转成 danger→safe）→ 顺序不符 → 红（"ordering 被静默改"要触发的红）。
    // 一旦这条红，改法只有两个：要么撤销对 SSOT 的改动，要么把这份锚点一起更新——而更新锚点会立刻把
    // 新成员纳入下面 L2 的逐对覆盖。
    expect([...RISK_TIERS]).toEqual([...RISK_TIERS_ANCHOR])
  })
})

describe('L2 行为·派生：rowRiskTier 总是返回危险度更高（锚点下标更大）的那一档', () => {
  it('锚点非空，下面的循环不是死代码', () => {
    expect(RISK_TIERS_ANCHOR.length).toBeGreaterThanOrEqual(2)
  })

  it('单档行返回那一档；无档 / 无 tier 的行返回 null', () => {
    for (const tier of RISK_TIERS_ANCHOR) {
      expect(rowRiskTier(rowWith([scope(tier)]))).toBe(tier)
    }
    expect(rowRiskTier(rowWith([]))).toBeNull()
    expect(rowRiskTier(rowWith([{ label: 'Model', value: 'Opus' }]))).toBeNull()
  })

  it('两档并存时取危险度更高的那一档，且与 scopes 的排列顺序无关', () => {
    // 逐对遍历锚点：i < j 意味着 j 更危险（下标更大）。两种排列都喂一遍，钉住"按危险度取"而不是
    // "按数组第一个/最后一个取"。expected（higher）来自锚点，故 rowRiskTier 若把方向取反、或改成
    // 按数组顺序取，这里必红；而这些红点由锚点而非 RISK_TIERS 决定，不会跟着 SSOT 的变异一起漂。
    for (let i = 0; i < RISK_TIERS_ANCHOR.length; i++) {
      for (let j = i + 1; j < RISK_TIERS_ANCHOR.length; j++) {
        const lower = RISK_TIERS_ANCHOR[i]!
        const higher = RISK_TIERS_ANCHOR[j]!
        expect(
          rowRiskTier(rowWith([scope(lower), scope(higher)])),
          `[${lower}, ${higher}] 应取更危险的 ${higher}`
        ).toBe(higher)
        expect(
          rowRiskTier(rowWith([scope(higher), scope(lower)])),
          `[${higher}, ${lower}] 应取更危险的 ${higher}`
        ).toBe(higher)
      }
    }
  })
})

describe('L3 结构·派生源：ladder 从 node-free 子路径按值 import，模块内无手抄的档位字面量', () => {
  const ROSTER_SPECIFIER = '@agentmux/core/risk-tier'
  const rosterPath = new URL('../src/renderer/src/lib/agent-roster.ts', import.meta.url)

  function parse(fileName: string, source: string): ts.SourceFile {
    return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  }

  /** 这个文件是否从 `from` 具名、**按值**（非 type-only）import 了 `name`——判 import 关系，不判裸文本。 */
  function valueImportsNamed(sourceFile: ts.SourceFile, name: string, from: string): boolean {
    return sourceFile.statements.some((statement) => {
      if (!ts.isImportDeclaration(statement)) return false
      if (statement.importClause?.isTypeOnly) return false
      if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== from) {
        return false
      }
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) return false
      return bindings.elements.some(
        (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name
      )
    })
  }

  /** 模块里所有等于某个档位名的字符串字面量节点（注释里的同名文字不是字面量节点，不会命中）。 */
  function tierStringLiterals(sourceFile: ts.SourceFile, tiers: readonly string[]): string[] {
    const tierSet = new Set(tiers)
    const found: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && tierSet.has(node.text)) found.push(node.text)
      node.forEachChild(walk)
    }
    sourceFile.forEachChild(walk)
    return found
  }

  const rosterSource = readFileSync(rosterPath, 'utf8')
  const rosterAst = parse('agent-roster.ts', rosterSource)

  it('agent-roster.ts 从 @agentmux/core/risk-tier 按值 import RISK_TIERS（钉住派生源与 node-free 边界）', () => {
    expect(
      valueImportsNamed(rosterAst, 'RISK_TIERS', ROSTER_SPECIFIER),
      `agent-roster.ts 没有从 ${ROSTER_SPECIFIER} 按值 import RISK_TIERS——ladder 的派生源不再是 SSOT，` +
        `或改从会把 Core 运行时拖进渲染进程的根桶导入`
    ).toBe(true)
  })

  it('agent-roster.ts 里不出现任何等于档位名的字符串字面量（一份手抄的 ladder 就是这形状）', () => {
    // 反向手抄 `['danger','caution','safe']` 与按序号派生在三档上行为完全相同，L1/L2 都盲；只有这条结构
    // 判据抓得住——它一出现就是 3 个档位字面量节点。当前实现里档位只经 import 的 RISK_TIERS 值流转，
    // 故这里应为空集。
    expect(
      tierStringLiterals(rosterAst, RISK_TIERS_ANCHOR),
      'agent-roster.ts 里出现了档位名字面量——ladder 可能又被手抄了一份，改回从 RISK_TIERS 派生'
    ).toEqual([])
  })

  it('自检：两条结构判据都认得出它们要抓/要放行的形状（否则上面两条是在描述今天的字面量）', () => {
    // 值 import 认得出，且不被 type-only import 或别处同名 import 骗过。
    const importProbe = parse(
      'probe.ts',
      [
        "import { RISK_TIERS } from '@agentmux/core/risk-tier'",
        "import type { RiskTier } from '@agentmux/core/risk-tier'",
        "import { RISK_TIERS as Other } from './elsewhere.js'"
      ].join('\n')
    )
    expect(valueImportsNamed(importProbe, 'RISK_TIERS', ROSTER_SPECIFIER), '认不出正常的按值具名 import').toBe(true)
    const typeOnlyProbe = parse('probe.ts', "import type { RISK_TIERS } from '@agentmux/core/risk-tier'")
    expect(
      valueImportsNamed(typeOnlyProbe, 'RISK_TIERS', ROSTER_SPECIFIER),
      '把 type-only import 当成了值 import'
    ).toBe(false)
    expect(
      valueImportsNamed(importProbe, 'RISK_TIERS', './elsewhere.js'),
      '不看模块路径——别处同名 import 也算数了'
    ).toBe(true)

    // 手抄的 ladder 数组会被字面量扫描抓到；option id 之类不等于档位名的字面量放行。
    const copyProbe = parse('probe.ts', "const order = ['danger', 'caution', 'safe']")
    expect(tierStringLiterals(copyProbe, RISK_TIERS_ANCHOR).sort()).toEqual(['caution', 'danger', 'safe'])
    const cleanProbe = parse('probe.ts', "const ids = ['read-only', 'danger-full-access']")
    expect(tierStringLiterals(cleanProbe, RISK_TIERS_ANCHOR), 'option id 被误判成档位字面量').toEqual([])
  })
})
