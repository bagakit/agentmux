import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  SPLIT_DIRECTIONS,
  SPLIT_FLAG_DIRECTIONS,
  isSplitDirection,
  type SplitDirection
} from '../src/split-direction-ssot.js'
import { parseAgentMuxControlRequest } from '../src/control-host.js'

// ---------------------------------------------------------------------------
// 分屏方向的 SSOT。
//
// 由来：`left/right/up/down` 此前只以纯类型存在，运行时被两处 Core 校验各自手抄——control-host 的
// `['left','right','up','down'].includes(...)` 与 agentmux 的 `? 'left' : … : 'down'` 兜底三元。审计实测从
// control-host 删掉 'up' 后 1203 条全绿、tsc exit 0，合法的 split-up 被静默判成 INVALID_CONTROL_REQUEST。
// 收敛后：元组是 SSOT，SplitDirection 由它派生，谓词与 CLI flag 映射都从元组长出来。
//
// 这个文件分三层，各杀各的（与 union-membership-ssot 的分工同源）：
//   A 元组/谓词的**运行时答案**——tsc 表达不了「谓词恒真」「元组被截断」。
//   B CLI flag 映射与 control 校验点的**行为**——每个方向都映得到、每个合法方向都越过校验闸。
//   C **结构**：两处消费者都从 SSOT import、且各自不再留一份内联方向枚举。C 层的判据是
//     **import/派生关系**，不是「值当前恰好相等」——一份今天正确的新手抄（M3）值上全对，只有 import
//     关系能抓住「不再消费 SSOT」这件事（记忆 equivalence-cannot-catch-a-fresh-copy /
//     guard-criterion-must-be-import-relation）。
//
// 双向 exactness（元组 === 控制协议 union）与 flag 映射的覆盖证明都是**编译期**守卫（split-direction-ssot.ts
// 里那两道 `[true, true]` / `extends ? true : never`），任一漂移是 tsc 错误，不在这里重测——重测反而把
// 编译期保证降级成更弱的文本断言。
// ---------------------------------------------------------------------------

// 锚点写死历史字面量：不从 SPLIT_DIRECTIONS 反算，否则期望值跟着元组一起漂、恒相等
//（记忆 expected-value-must-not-derive-from-mutation-target）。加/删一档要在这里显式改。
const DIRECTION_ANCHOR = ['left', 'right', 'up', 'down'] as const

describe('分屏方向 SSOT', () => {
  describe('A 层（元组 / 谓词的运行时答案）', () => {
    it('元组就是那四个方向，一个不多一个不少', () => {
      // 排序后比对：顺序不承重，但成员集合承重。截断（删 up）会让这条红。
      expect([...SPLIT_DIRECTIONS].sort()).toEqual([...DIRECTION_ANCHOR].sort())
    })

    it('谓词放行每一个方向', () => {
      // 逐一断言而非「数量对就行」：谓词内部清单少一档（M1 从元组删 up）会让这一条对那一档红——
      // 这是 ⊇ 方向，正是「合法请求被 fail-closed 拒掉」的形状。
      for (const direction of DIRECTION_ANCHOR) {
        expect(isSplitDirection(direction), `${direction} 该合法却被判非法`).toBe(true)
      }
    })

    it('近似但非方向的值被判非法——挡住谓词恒真', () => {
      for (const notDirection of ['sideways', 'Left', 'LEFT', 'up ', 'do', 'north', '', 'left-of', 'previous']) {
        expect(isSplitDirection(notDirection), `${notDirection} 该非法却被判合法`).toBe(false)
      }
    })
  })

  describe('B 层（CLI flag 映射与 control 校验点的行为）', () => {
    it('每个 CLI 方向 flag 映到一个合法方向，且四个方向都被某个 flag 覆盖', () => {
      const mapped = Object.values(SPLIT_FLAG_DIRECTIONS)
      // 每个映射目标都是真方向（M4 把某个 flag 映到 'downn' 会让这条红；映到一个真方向但**错的**方向
      // 由下一条锚点断言抓）。
      for (const direction of mapped) {
        expect(isSplitDirection(direction), `flag 映到了非方向 ${direction}`).toBe(true)
      }
      // 覆盖全集：四个方向都得有 flag（加方向不加 flag 由编译期覆盖证明抓，这里再钉一次运行时）。
      expect([...new Set(mapped)].sort()).toEqual([...DIRECTION_ANCHOR].sort())
    })

    it('flag→方向映射逐条锚定（M4：某个 flag 映到错方向必红）', () => {
      // 锚点写死每一对，不从被测对象反算：--above 是 up、--below 是 down 是 CLI 契约（open --help 里
      // 也这么写），任一对被对调（--above 映成 down）会让对应那条红。
      expect(SPLIT_FLAG_DIRECTIONS['--left-of']).toBe('left')
      expect(SPLIT_FLAG_DIRECTIONS['--right-of']).toBe('right')
      expect(SPLIT_FLAG_DIRECTIONS['--above']).toBe('up')
      expect(SPLIT_FLAG_DIRECTIONS['--below']).toBe('down')
    })

    it('control 校验点放行每个合法方向的 split（越过 membership 闸）', () => {
      // 只喂 kind+direction+region，直接打 control-host 的 openDestination membership 闸（M1 从元组删 up
      // 后，这里 up 那次会因方向被拒而红）。用完整合法请求，读回它没抛。
      for (const direction of DIRECTION_ANCHOR) {
        expect(() =>
          parseAgentMuxControlRequest({
            schemaVersion: 5,
            requestId: 'r-1',
            operation: 'open.terminal',
            destination: { kind: 'split', direction, region: { kind: 'region', regionId: 'region-1' } }
          })
        , `合法方向 ${direction} 的 split 被 control 校验闸拒掉了`).not.toThrow()
      }
    })

    it('control 校验点响亮拒掉非方向的 split', () => {
      for (const direction of ['sideways', 'Left', '', 'north', 42, null, undefined]) {
        expect(() =>
          parseAgentMuxControlRequest({
            schemaVersion: 5,
            requestId: 'r-1',
            operation: 'open.terminal',
            destination: { kind: 'split', direction, region: { kind: 'region', regionId: 'region-1' } }
          })
        , `非方向 ${String(direction)} 的 split 没被拒`).toThrow('Open destination is invalid.')
      }
    })
  })

  // -------------------------------------------------------------------------
  // C 层（结构）：两处消费者从 SSOT 派生方向，各自不留内联枚举。
  //
  // 判据是 **import 关系 + 无内联方向枚举**，不是「值当前相等」。M3 复现的正是这条的必要性：把
  // control-host 恢复成一份**今天正确**的 `['left','right','up','down'].includes(...)`，A/B 层与 tsc 全绿
  // （值全对），只有「消费者不再 import SSOT」与「消费者里又出现内联方向枚举」这两条结构判据能抓住它。
  // -------------------------------------------------------------------------
  const CONSUMERS = [
    { file: 'control-host.ts', imported: 'isSplitDirection' },
    { file: 'agentmux.ts', imported: 'SPLIT_FLAG_DIRECTIONS' }
  ] as const

  function readSrc(name: string): string {
    return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
  }

  /** 这个文件是否从 ./split-direction-ssot.js 具名 import 了 `name`（走 parser，不判裸标识符文本）。 */
  function importsFromSsot(source: string, name: string): boolean {
    const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    return sf.statements.some((statement) => {
      if (!ts.isImportDeclaration(statement)) return false
      if (!ts.isStringLiteral(statement.moduleSpecifier)) return false
      if (statement.moduleSpecifier.text !== './split-direction-ssot.js') return false
      const clause = statement.importClause
      if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false
      return clause.namedBindings.elements.some(
        (element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name
      )
    })
  }

  describe('C 层（结构）：消费者从 SSOT 派生，不留内联枚举', () => {
    it('自检：import 判据认得出正常的具名 import，不被同名/type-only/别处 import 骗过', () => {
      // 没有这条，把 import 判据写坏（永远真/永远假）会让下面两条恒绿——本仓 grep 守卫反复被绕的坑。
      expect(importsFromSsot("import { isSplitDirection } from './split-direction-ssot.js'", 'isSplitDirection')).toBe(true)
      expect(importsFromSsot("import { type SplitDirection } from './split-direction-ssot.js'", 'SplitDirection'), 'type-only import 被当成了值 import').toBe(false)
      expect(importsFromSsot("import { isSplitDirection } from './elsewhere.js'", 'isSplitDirection'), '判据不看模块路径').toBe(false)
      expect(importsFromSsot("const isSplitDirection = () => true", 'isSplitDirection'), '本地同名声明骗过了 import 判据').toBe(false)
    })

    it('两处消费者都从 SSOT 具名 import 它派生方向所需的东西（M3：换成本地正确手抄这条红）', () => {
      for (const { file, imported } of CONSUMERS) {
        expect(
          importsFromSsot(readSrc(file), imported),
          `${file} 没有从 ./split-direction-ssot.js import ${imported}——它的方向真相来自别处（哪怕值今天恰好对）`
        ).toBe(true)
      }
    })

    it('自检：内联方向枚举判据认得出它要防的那种数组（否则守卫恒绿）', () => {
      // 判据自身要能认出 M3 恢复的那种形状，也不能把无关文本误报。
      expect(hasInlineDirectionArray(`['left', 'right', 'up', 'down'].includes(x)`), '判据认不出内联方向数组').toBe(true)
      expect(hasInlineDirectionArray(`const label = 'left'`), '判据把无关字符串误报成内联枚举').toBe(false)
    })

    it('两处消费者里没有内联的方向枚举——方向清单只在元组里（M3：本地手抄这条红）', () => {
      for (const { file } of CONSUMERS) {
        expect(
          hasInlineDirectionArray(readSrc(file)),
          `${file} 里又出现了把四个方向枚举成数组的内联清单——第二处运行时拼写必与元组漂移`
        ).toBe(false)
      }
    })
  })
})

/**
 * 一份源码里是否含「把四个方向枚举成字符串数组」的内联清单。判据是**覆盖整条方向集合**的数组字面量
 * （M3 恢复的正是 `['left','right','up','down']`），而不是「某个方向字面量在场」——后者会误伤合法用途
 * （比如 direction: 'right' 这种单值）。走 parser 数数组元素，不做正则 substring。
 */
function hasInlineDirectionArray(source: string): boolean {
  const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const required = new Set<string>(DIRECTION_ANCHOR)
  let found = false
  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isArrayLiteralExpression(node)) {
      const literals = new Set(node.elements.filter(ts.isStringLiteral).map((element) => element.text))
      if ([...required].every((direction) => literals.has(direction))) found = true
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return found
}

// 编译期证明在场自检：SplitDirection 是从元组派生的类型（这行本身若类型错，tsc 门禁会红）。
const _typeIsUsable: SplitDirection = 'left'
void _typeIsUsable
