/**
 * `working` 状态的衰减判定——纯函数，与渲染、定时器解耦。
 *
 * 要害不在「能不能算出到点了」，而在**衰减的边界与诚实**：只有 `working` 会因静默被证伪，其余状态
 * （waiting/blocked 是静止声明、done/error 是结论、starting/running/… 本就不是在干活的声明）静默都
 * 与之相容，绝不能被删；落点必须是中性的 `unknown`，不许伪造成 done/error。这里守的正是这些边。
 *
 * 阈值 15 分钟的理由不在此断言其具体数值（那会把测试变成抄常量），而由「远高过一次长构建/长测试」
 * 这条性质来守：见「长命令期间的健康 Agent 不被误降级」用例。
 */

import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { AgentDisplayState, AgentSemanticState, AgentStatus } from '../src/types.js'
import {
  DECAYED_SEMANTIC_STATE,
  agentDisplayState,
  msUntilSemanticStatusStale,
  semanticStatusStale
} from '../src/agent-status-freshness.js'

const STALE_AFTER_MS = 15 * 60_000

function status(state: AgentStatus['state'], observedAt: number): Pick<AgentStatus, 'state' | 'observedAt'> {
  return { state, observedAt }
}

describe('working 状态在无新证据时会衰减', () => {
  it('静默超过阈值的 working 判为陈旧', () => {
    expect(semanticStatusStale(status('working', 0), STALE_AFTER_MS + 1)).toBe(true)
  })

  it('恰好到点即算陈旧（>= 而非 >，免得定时器取整落在线上时空转）', () => {
    expect(semanticStatusStale(status('working', 0), STALE_AFTER_MS)).toBe(true)
  })

  it('还没到点的 working 不判陈旧', () => {
    expect(semanticStatusStale(status('working', 0), STALE_AFTER_MS - 1)).toBe(false)
  })
})

describe('衰减落到中性/未知，不伪造成 done 或 error', () => {
  it('衰减落点是 unknown——我们确实不知道它现在怎么样', () => {
    // 这条钉死落点的诚实性：改成 'done'/'error' 都是编造一个没观察到的结论，必须变红。
    expect(DECAYED_SEMANTIC_STATE).toBe('unknown')
    expect(DECAYED_SEMANTIC_STATE).not.toBe('done')
    expect(DECAYED_SEMANTIC_STATE).not.toBe('error')
  })
})

describe('语义态 → 显示态只有一处，且落点被钉死', () => {
  // 为什么这一族要存在：tsc 只守住「你没漏掉 unknown」——漏了就是把 AgentSemanticState 赋给
  // AgentDisplayState，编译不过。它守不住**你映射到了哪**：`unknown → 'done'` 类型完全合法，而它
  // 谎称 Agent 干完了；`unknown → 'error'` 同样合法，谎称它崩了。所以「它能编译」这件事一个断言
  // 都不值得写，下面钉的全是取值与「没人再手抄一遍」。

  // 两个联合的成员在这里逐个写死，不从类型反推（派生量对着变异一起漂，见
  // expected-value-must-not-derive-from-mutation-target）。类型侧的完整性由紧随的穷尽性自检守。
  const SEMANTIC: readonly AgentSemanticState[] = [
    'unknown',
    'working',
    'waiting',
    'blocked',
    'done',
    'error'
  ]
  const OVERLAPPING: readonly AgentSemanticState[] = ['working', 'waiting', 'blocked', 'done', 'error']

  it('unknown 落 running——不是 done（谎称干完了），不是 error（谎称崩了）', () => {
    expect(agentDisplayState('unknown')).toBe('running')
    expect(agentDisplayState('unknown')).not.toBe('done')
    expect(agentDisplayState('unknown')).not.toBe('error')
  })

  it('重叠的五个原样通过——改写任何一个都是撒谎', () => {
    for (const state of OVERLAPPING) {
      expect(agentDisplayState(state), `${state} 是同一件事的同一种说法，不许在归一时被改写`).toBe(
        state as unknown as AgentDisplayState
      )
    }
  })

  it('衰减落点经这个函数落地，两侧不许各判一次', () => {
    // DECAYED_SEMANTIC_STATE 与 agentDisplayState 是同一个决定的两半：衰减落 unknown，unknown 归一
    // 到 running。这条把它们连起来——任一半被改，转的圈就不再停在中性态上。
    expect(agentDisplayState(DECAYED_SEMANTIC_STATE)).toBe('running')
  })

  it('SEMANTIC 清单就是 AgentSemanticState 的全集（自检：漏一个则上面几条覆盖不全）', () => {
    // 这条不断言取值，只让 tsc 与运行期一起证明清单没漏：漏掉一个成员时，下面这张穷尽表缺键，
    // tsc 报错；多写一个不存在的成员，同样报错。运行期再核对数量一致。
    const exhaustive: Record<AgentSemanticState, true> = {
      unknown: true,
      working: true,
      waiting: true,
      blocked: true,
      done: true,
      error: true
    }
    expect(new Set(SEMANTIC)).toEqual(new Set(Object.keys(exhaustive)))
    expect(SEMANTIC).toHaveLength(Object.keys(exhaustive).length)
  })
})

/**
 * 这个文件里「显示态是不是由 agentDisplayState 算出来的」都按 AST 判，不按文本判。
 *
 * 理由是一次实测存活的变异：此前的判据是 `source.toContain('agentDisplayState(')`，它只问「文件里有
 * 没有这个调用」，不问**那次调用喂进去的是什么**。于是把实参换成常量——
 * `state: agentDisplayState('working')`——名字与括号照旧在场，那条断言一个字都不会变（三处各试一次，
 * 旧守卫 19/19 全绿）。后果是每条 hook 事件都报 working，界面永远转圈
 * （forbidden-shape-guard-misfires：判「禁止形状不在场」既漏又误伤；正解是抽出取值位逐个质询）。
 *
 * 附一条修正，免得后人重复我的错：把整个调用换成手抄的三元，旧判据其实**认得出**——import 写作
 * `{ agentDisplayState }`，不带括号，删掉唯一调用后 `agentDisplayState(` 真的从文件里消失了。
 * 「import 里的名字会替它背书」这个推断在这三个文件上不成立，我实测后才知道。
 *
 * 也不用正则剥注释再 includes：按行猜注释边界是另一族盲点（lexical-boundaries-need-a-real-lexer），
 * 而真词法器让注释在语法树里根本不是节点，「写在注释里」自动不算接上了。
 */
function callArgumentTexts(source: string, fileName: string, callee: string): string[] {
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === callee
    ) {
      found.push(node.arguments.map((argument) => argument.getText(ast)).join(', '))
    }
    ts.forEachChild(node, walk)
  }
  walk(ast)
  return found
}

/** 源码里有没有「拿 unknown 换 running」这个手抄形状——同样按 AST，注释不算。 */
function hasInlineUnknownToRunning(source: string, fileName: string): boolean {
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found = false
  const walk = (node: ts.Node): void => {
    if (
      ts.isConditionalExpression(node) &&
      ts.isStringLiteral(node.whenTrue) &&
      node.whenTrue.text === 'running' &&
      /'unknown'/.test(node.condition.getText(ast))
    ) {
      found = true
    }
    ts.forEachChild(node, walk)
  }
  walk(ast)
  return found
}

describe('语义态到显示态只有一处决定', () => {
  it('三条到达界面的路都不再自己手抄那一行——判据是结构，不是取值', () => {
    // 取值相等证不了这件事：三处各抄一份、抄得一模一样时每条取值断言都绿，而下一次只改一处的漂移
    // 照旧发生（同一个 Agent 经一条路显示"运行中"、经另一条显示"已完成"）。所以这里质询源码本身。
    //
    // 判据是**这条路上那次调用真的以那个语义态为实参**，不是「文件里出现过这个名字」。每处的
    // `argument` 是它该喂进去的那个表达式：喂错了（比如喂一个常量、或换成别的函数）当场红。
    const callSites = [
      {
        url: new URL('../src/hook-normalizer.ts', import.meta.url),
        // 各自的在场证明：路径写错时 readFileSync 会抛，但读到一个**不相关**的文件同样会让
        // 「没有手抄」恒真。所以每处都要先证它真是这条路上的那个文件。
        proof: 'source: \'native-hook\'',
        argument: 'semanticState'
      },
      {
        url: new URL('../../../apps/desktop/src/renderer/src/lib/session-state.ts', import.meta.url),
        proof: "core.type === 'agent-status'",
        argument: 'core.state'
      },
      {
        url: new URL('../../../apps/desktop/src/renderer/src/lib/agent-status-decay.ts', import.meta.url),
        proof: 'DECAYED_SEMANTIC_STATE',
        argument: 'DECAYED_SEMANTIC_STATE'
      }
    ]
    for (const site of callSites) {
      const source = readFileSync(site.url, 'utf8')
      const name = site.url.pathname
      expect(source, `${name} 已不是这条路上的文件，这条守卫钉错了地方`).toContain(site.proof)

      const calls = callArgumentTexts(source, name, 'agentDisplayState')
      // 在场自检：抽到 0 处时下面按实参比对的那条会跑零次、恒绿。
      expect(
        calls.length,
        `${name} 里一处 agentDisplayState 调用都没抽到——它可能被换成了手抄的三元、或另一个函数，` +
          '而 import 与注释里的名字照旧在场（文本判据看不出来）'
      ).toBeGreaterThan(0)
      expect(
        calls,
        `${name} 的 agentDisplayState 没有以 \`${site.argument}\` 为实参（实际：${calls.join(' | ')}）——` +
          '这条路的显示态不再由那个语义态算出来'
      ).toContain(site.argument)

      // 手抄的形状就是「在三元里拿 unknown 换 running」。注释里讲解它不算手抄——按 AST 判时
      // 注释根本不是节点，这一点是白拿的。
      expect(
        hasInlineUnknownToRunning(source, name),
        `${name} 又手抄了一份 unknown→running；那个决定只能有一个出处`
      ).toBe(false)
    }
  })

  it('自检：判据认得出「名字在场但值不是它」这种绕过，也不误伤正确形状', () => {
    // 上面那条若因为抽取器写偏而恒真/恒假，它就是死代码。喂它三份构造样本。
    const bypass = `import { agentDisplayState } from './agent-status-freshness.js'
      // 语义态 → 显示态经 agentDisplayState 一处决定
      const status = { state: semanticState === 'unknown' ? 'running' : semanticState }`
    expect(
      callArgumentTexts(bypass, 'bypass.ts', 'agentDisplayState'),
      '抽取器把 import 里的名字当成了调用，于是「名字在场」就能过——那正是被真变异绕过的判据'
    ).toHaveLength(0)
    expect(hasInlineUnknownToRunning(bypass, 'bypass.ts'), '手抄形状判据认不出它要挡的拼法').toBe(true)

    // 反向一：正确形状必须过，否则这一族退化成「什么都拒」，谁改都红、于是被整条删掉。
    const wired = `const status = { state: agentDisplayState(semanticState) }`
    expect(callArgumentTexts(wired, 'wired.ts', 'agentDisplayState')).toContain('semanticState')
    expect(hasInlineUnknownToRunning(wired, 'wired.ts')).toBe(false)

    // 反向二：只把手抄形状写进注释不算手抄（否则三处解释它的注释都会误报）。
    const commentedOnly = `// 此前是 semanticState === 'unknown' ? 'running' : semanticState\nfoo()`
    expect(
      hasInlineUnknownToRunning(commentedOnly, 'comment.ts'),
      '注释里讲解这个形状被误判成手抄'
    ).toBe(false)
  })
})

describe('不把「停下来等你/已出结论」的状态误删', () => {
  it('waiting 永不衰减——它是静止声明，静默与之相容', () => {
    expect(semanticStatusStale(status('waiting', 0), STALE_AFTER_MS * 100)).toBe(false)
    expect(msUntilSemanticStatusStale(status('waiting', 0), 0)).toBe(0)
  })

  it('blocked 永不衰减', () => {
    expect(semanticStatusStale(status('blocked', 0), STALE_AFTER_MS * 100)).toBe(false)
  })

  it('done/error 是结论，永不衰减——删掉就是抹掉真实发生过的结果', () => {
    expect(semanticStatusStale(status('done', 0), STALE_AFTER_MS * 100)).toBe(false)
    expect(semanticStatusStale(status('error', 0), STALE_AFTER_MS * 100)).toBe(false)
  })

  it('running/starting/disconnected/exited 本就不是在干活的声明，不衰减', () => {
    for (const state of ['running', 'starting', 'disconnected', 'exited'] as const) {
      expect(semanticStatusStale(status(state, 0), STALE_AFTER_MS * 100)).toBe(false)
    }
  })
})

describe('有新证据到达时正常刷新，不误降活着的 Agent', () => {
  it('阈值内的每一次刷新都把定时器排到满额——活着的 Agent 够不到衰减', () => {
    // observedAt 每被一次新 hook 事件抬高，msUntil 就重回满额；只要刷新间隔 < 阈值就永远不陈旧。
    const observedAt = 1_000_000
    const now = observedAt + 5 // 一次新证据刚落地
    expect(semanticStatusStale(status('working', observedAt), now)).toBe(false)
    expect(msUntilSemanticStatusStale(status('working', observedAt), now)).toBe(STALE_AFTER_MS - 5)
  })

  it('一条正跑长命令、几分钟不出 hook 的健康 Agent 不被误降级', () => {
    // 一次长构建/长测试期间没有任何 hook 事件；阈值必须明确高过这个上界。取一个宽裕的 5 分钟静默：
    // 若阈值被拍成一个「几分钟」的小数，这条会红——它守的是「远高过一次工具调用上界」这条性质。
    const fiveMinutesQuiet = 5 * 60_000
    expect(semanticStatusStale(status('working', 0), fiveMinutesQuiet)).toBe(false)
  })
})

describe('msUntilSemanticStatusStale 给定时器算延时', () => {
  it('working 刚落地时返回满额 TTL', () => {
    expect(msUntilSemanticStatusStale(status('working', 0), 0)).toBe(STALE_AFTER_MS)
  })

  it('已过阈值则为 0（无需再等，立即可衰减）', () => {
    expect(msUntilSemanticStatusStale(status('working', 0), STALE_AFTER_MS + 10)).toBe(0)
  })

  it('不可衰减的状态一律返回 0', () => {
    expect(msUntilSemanticStatusStale(status('waiting', 0), 0)).toBe(0)
    expect(msUntilSemanticStatusStale(status('done', 0), 0)).toBe(0)
  })
})
