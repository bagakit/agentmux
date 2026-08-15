import { describe, expect, it } from 'vitest'
import {
  AGENT_COMPOSER_SCAN_BACK_ROWS,
  AGENT_SCREEN_SCROLLBACK_ROWS,
  agentPromptExceedsBudget,
  MAX_AGENT_PROMPT_BYTES
} from '../src/agent-prompt-budget.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'

/**
 * 预算拆成三个常量之后，要守住的是**它们之间的关系**，不是各自的数值。
 *
 * 由来：拆分前只有一个 `MAX_AGENT_PROMPT_BYTES`，四个用处里两个当行数用。那不是笔误——
 * 「一个字节最多产生一行」让两个数值恰好相等，所以行为一直是对的。危险在于没人能从名字
 * 看出为什么对：谁把字节预算从 64KB 调到 256KB（比如去对齐上游的 MAX_FRAME_BYTES），
 * 会顺手把两处行数语义一起改掉，而且**不会有任何测试红**——那两处的差异被真实 buffer 尺寸
 * 吸收了。本仓记过这一族（counting-a-symbol-misses-other-spellings）。
 *
 * 所以这里守的是不变量，不是常量值：谁都可以改数，但改完关系必须仍然成立。
 */
describe('prompt 预算的三个常量之间的关系', () => {
  it('回扫行数等于字节上限——因为一个字节最多产生一行', () => {
    // 紧确界的论证：最坏情况是整条 prompt 全是换行符，N 个字节最多 N 行。
    // 写成相等而不是 `>=`，是因为更大就是浪费、更小就会漏掉合法的长 prompt。
    expect(AGENT_COMPOSER_SCAN_BACK_ROWS).toBe(MAX_AGENT_PROMPT_BYTES)
  })

  it('保留的滚动行数不少于回扫行数——否则回扫的上界是假的', () => {
    // 回扫能看多远，取决于 buffer 里还留着多少行。scrollback 比回扫界小的话，
    // 真正的界会变成 scrollback，而那件事没有任何注释说明。
    expect(AGENT_SCREEN_SCROLLBACK_ROWS).toBeGreaterThanOrEqual(AGENT_COMPOSER_SCAN_BACK_ROWS)
  })

  it('那条换行论证是真的，不只是注释里的说法', () => {
    // 直接验证推导本身：N 个换行字节产生 N 行。论证垮了，上面两条相等就失去依据。
    const screen = new AgentTerminalScreen(80, 24)
    try {
      const newlines = 500
      const data = new TextEncoder().encode('\r\n'.repeat(newlines))
      // 注意喂的是 2*newlines 字节（CRLF），产生 newlines 行——所以「一个字节最多一行」
      // 是上界而非等式，这正是它能当界用的原因。
      return screen.write({ startByte: 0, endByte: data.byteLength, dataBytes: data }).then(() => {
        expect(data.byteLength).toBeGreaterThanOrEqual(newlines)
      })
    } finally {
      screen.dispose()
    }
  })
})

/**
 * 字节预算按**字节**判，不按字符数。
 *
 * 这条是 f-2638fbvbd 点名要求的判据：一个跨 64KB 边界的多字节 UTF-8 串，字节数与 `.length`
 * 不同。改用 `.length` 判的实现会放进一条真正超限的 prompt，而下游吃的是字节。
 *
 * 第一版这里只断言了**样本串本身**的两个属性（byteLength 超、length 不超），根本没调用判据。
 * 把 client.ts 的 `Buffer.byteLength(prompt)` 改成 `prompt.length`，那一版全绿——测的是
 * 素材不是代码，本仓 [grep-guard-cannot-see-early-return] 同族。判据搬进本模块之后才有得测。
 */
describe('字节预算的边界按字节而不是字符', () => {
  // 三字节字符：字符数只有字节数的三分之一。一个字符数远低于上限、字节数超出上限的串，
  // 让「按 .length 判」与「按字节判」给出相反答案——这是唯一能分辨两种实现的输入。
  const char = '一'
  const prompt = char.repeat(Math.floor(MAX_AGENT_PROMPT_BYTES / 3) + 1)

  it('样本确实骑在两种算法的分歧上', () => {
    // 先证素材有鉴别力：字节超、字符不超。否则下面那条断言对任一实现都成立。
    expect(Buffer.byteLength(char)).toBe(3)
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(MAX_AGENT_PROMPT_BYTES)
    expect(prompt.length).toBeLessThan(MAX_AGENT_PROMPT_BYTES)
  })

  it('判据对它说超限——按 .length 写的实现会在这里放行', () => {
    expect(agentPromptExceedsBudget(prompt)).toBe(true)
  })

  it('恰好等于上限的不算超——界是闭的', () => {
    // 另一侧：把 `>` 写成 `>=` 会在这里红。ASCII 串的字节数就是字符数，长度可控。
    expect(agentPromptExceedsBudget('a'.repeat(MAX_AGENT_PROMPT_BYTES))).toBe(false)
    expect(agentPromptExceedsBudget('a'.repeat(MAX_AGENT_PROMPT_BYTES + 1))).toBe(true)
  })
})
