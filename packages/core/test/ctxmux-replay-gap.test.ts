import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { classifyReplayGap } from '../src/ctxmux-replay-gap.js'

/**
 * 守的缺陷（#548「高频误报 Earlier scrollback is unavailable：会话健康且可交互」）：
 * adapter 此前只看 `replay.truncated` 就宣布 gap。那个字段是 per-Run 的粘滞标志——daemon 逐出时
 * 置 1 且二进制里没有任何 `replay_truncated = 0`，SDK 也只是原样透传。于是任何逐出过一次的 Run
 * 会永久报缺口，而渲染层一律从 byte 0 attach，那句提示因此永不消失。
 *
 * 每条 it 都写清「把这一支折掉，生产上会怎么坏」，因为这四路各自对着一个不同的真实后果。
 */
describe('classifyReplayGap', () => {
  it('从未逐出过 ⇒ 没有 gap（truncated 是唯一的必要条件）', () => {
    // 折掉这一支（无条件进入区间比较）会让**全新的**、first_available_byte 恒为 0 的 Run
    // 也走进算式；虽然今天 0 <= afterByte 恰好也判 null，但那是巧合而非判据，
    // 且 truncated=false 时 firstAvailableByte 语义上不代表任何丢失。
    expect(classifyReplayGap({
      truncated: false,
      requestedAfterByte: 0,
      firstAvailableByte: 0
    })).toBeNull()
  })

  it('逐出过，但请求游标在保留区之内 ⇒ 没有 gap（这一路正是 #548）', () => {
    // SDK 的收流循环从 max(afterByte, first_available_byte) 开始并要求连续到最新，所以
    // afterByte=8192 >= firstAvailable=4096 时，要的字节一个不少。
    // 把这条判反（或删掉这个比较）就退回 #548：健康会话永久显示「Earlier scrollback is
    // unavailable」、多发一次强制 TUI 重绘、且 screen-evidence 对可交互会话直接抛 OUTPUT_GAP。
    expect(classifyReplayGap({
      truncated: true,
      requestedAfterByte: 8192,
      firstAvailableByte: 4096
    })).toBeNull()
  })

  it('逐出过，请求游标正好等于保留区起点 ⇒ 没有 gap（边界必须含在「够」的一侧）', () => {
    // 把 `>=` 收窄成 `>` 就漏掉这一格：请求 4096、保留自 4096 起，缺的字节数是 0，
    // 但会被报成缺口。恰好等于是最常见的一格——调用方通常拿上次的 firstAvailableByte
    // 当下次的游标（renderer 的 `cursor = result.gap.firstAvailableByte` 就是这么写的），
    // 于是「补读一次」会永远再报一次缺口，形成永不收敛的提示。
    expect(classifyReplayGap({
      truncated: true,
      requestedAfterByte: 4096,
      firstAvailableByte: 4096
    })).toBeNull()
  })

  it('逐出过且请求游标落在保留区之前 ⇒ 报出真实缺失区间', () => {
    // 这是唯一该报的一路：从 0 要，但 daemon 只留到 4096 起——[0, 4096) 永远拿不回来。
    // 折掉它（永远返回 null）会让真的丢了历史的会话一声不响：用户看到一屏排版错乱的
    // TUI 而没有任何解释，且 finishTerminalReplayRecovery 不再补那次重绘。
    expect(classifyReplayGap({
      truncated: true,
      requestedAfterByte: 0,
      firstAvailableByte: 4096
    })).toEqual({ requestedAfterByte: 0, firstAvailableByte: 4096 })
  })
})

/**
 * 接线层：上面四条只守分类器自己，改不动「adapter 有没有走它」。这一族缺陷已复发过很多次——
 * 纯函数抽出来了，但三个调用点里有一个（或全部）退回内联判定，行为断言完全看不见。
 *
 * 判据是**允许形状**而非禁止形状：adapter 里每一个 `gap:` 属性的值必须**就是**一次
 * `classifyReplayGap(...)` 调用（不是含它的表达式、不是三元、不是别的函数）。禁止清单
 * （「不许出现 `.truncated ?`」之类）换个拼法就绕过，而且会误伤本文件里合法的同形代码。
 *
 * 用真 TS 解析器取 `gap:` 的初值节点，不按行 grep：`truncated` 这个词在注释和参数名里都出现，
 * 文本判据分不清「读了这个字段」与「在讲这个字段」。
 */
const ADAPTER = fileURLToPath(new URL('../src/ctxmux-run-adapter.ts', import.meta.url))

/** adapter 里每个 `gap: <expr>` 的初值节点。 */
function gapInitializers(): ts.Expression[] {
  const source = ts.createSourceFile(
    ADAPTER,
    readFileSync(ADAPTER, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const found: ts.Expression[] = []
  function walk(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'gap'
    ) {
      found.push(node.initializer)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

describe('adapter 的每个 gap 都由 classifyReplayGap 决定', () => {
  const initializers = gapInitializers()

  it('三个 attach 面各有一处 gap，且提取器确实找到了它们', () => {
    // 自检挡板：解析失败或属性改名会让下面那条断言在空数组上恒真。attach / replay /
    // observeOutput 各产出一处，所以地板是 3；未来新增 attach 面只会更多，不会更少。
    expect(initializers.length, 'adapter 里没有扫到 gap 属性，接线判据失效').toBeGreaterThanOrEqual(3)
  })

  it('每处 gap 的值就是一次 classifyReplayGap 调用（不是内联三元、不是别的函数）', () => {
    for (const initializer of initializers) {
      const text = initializer.getText().slice(0, 120)
      expect(
        ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === 'classifyReplayGap',
        `gap 的值不是 classifyReplayGap(...) 而是：${text}`
      ).toBe(true)
    }
  })

  it('gap 的三个实参都从 replay 快照取，不许硬写', () => {
    // 只钉「是那次调用」还不够：实参写成字面量（例如 truncated: true）同样让判定失真。
    // 这里判每次调用的对象实参三个键都在场，且取值来自成员访问（`....replay.truncated` 一类）。
    for (const initializer of initializers) {
      const argument = ts.isCallExpression(initializer) ? initializer.arguments[0] : undefined
      expect(argument && ts.isObjectLiteralExpression(argument), 'classifyReplayGap 的实参不是对象字面量').toBe(true)
      const properties = new Map<string, ts.Expression>()
      for (const property of (argument as ts.ObjectLiteralExpression).properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue
        properties.set(property.name.text, property.initializer)
      }
      for (const key of ['truncated', 'requestedAfterByte', 'firstAvailableByte']) {
        const value = properties.get(key)
        expect(value, `classifyReplayGap 的实参缺 ${key}`).toBeDefined()
        // 字面量（true/false/数字）会让这一处的判定与真实快照脱钩。标识符（afterByte）与
        // 成员访问（snapshot.replay.truncated）都算取值。
        expect(
          value !== undefined &&
            !ts.isNumericLiteral(value) &&
            value.kind !== ts.SyntaxKind.TrueKeyword &&
            value.kind !== ts.SyntaxKind.FalseKeyword,
          `classifyReplayGap 的 ${key} 被硬写成字面量：${value?.getText()}`
        ).toBe(true)
      }
    }
  })
})

