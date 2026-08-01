/**
 * 采集规则本身的单测——与信封、传输、时间戳解耦。
 *
 * 这一层容易错的地方不在"能不能读到字段"，而在**读不出结论时该怎么办**：把没观察到的东西
 * 判成失败，比不判更坏。所以这里的用例大半在守"不许乱报红"这条边。
 */

import { describe, expect, it } from 'vitest'
import { MAX_TOOL_OUTPUT_CHARS, hookToolOutcome } from '../src/hook-tool-outcome.js'

describe('hook tool outcome capture', () => {
  it('把结果读出来——这是整件事的理由', () => {
    expect(hookToolOutcome({ tool_response: 'total 24\ndrwxr-xr-x' })).toEqual({
      output: 'total 24\ndrwxr-xr-x',
      failed: false
    })
  })

  it('正文藏在结果对象里时，取正文而不是整份转义 JSON', () => {
    // `JSON.stringify({stdout: "..."})` 会把真正要看的东西埋进一层转义，用户得在脑子里反转义。
    const outcome = hookToolOutcome({ tool_response: { stdout: 'hello world', duration_ms: 12 } })
    expect(outcome.output).toBe('hello world')
    expect(outcome.output).not.toContain('stdout')
  })

  it('三种失败形态都认：布尔标志、error 状态、非零退出码', () => {
    expect(hookToolOutcome({ tool_response: { is_error: true, stderr: 'boom' } }).failed).toBe(true)
    expect(hookToolOutcome({ tool_response: { status: 'error', message: 'nope' } }).failed).toBe(true)
    expect(hookToolOutcome({ tool_response: 'out', exit_code: 1 }).failed).toBe(true)
  })

  it('退出码 0 是成功，不是"有退出码所以可疑"', () => {
    expect(hookToolOutcome({ tool_response: 'fine', exit_code: 0 }).failed).toBe(false)
  })

  it('读不出结论时不报失败——存疑就报红会让红点失去意义', () => {
    // 用户会去查一个根本不存在的错误，查几次之后就再也不信这个红点了。
    expect(hookToolOutcome({ tool_response: 'plain output' }).failed).toBe(false)
    expect(hookToolOutcome({}).failed).toBe(false)
    expect(hookToolOutcome({ tool_name: 'Bash' }).failed).toBe(false)
  })

  it('没观察到输出就是缺席，不伪造空字符串', () => {
    // 空串会把"还没结果"显示成"结果是空的"，那是两件事。
    expect(hookToolOutcome({})).toEqual({ failed: false })
    expect(hookToolOutcome({ tool_response: '   ' })).toEqual({ failed: false })
    expect(Object.hasOwn(hookToolOutcome({}), 'output')).toBe(false)
  })

  it('失败与输出彼此独立：可以失败而没有正文', () => {
    const outcome = hookToolOutcome({ tool_response: { is_error: true } })
    expect(outcome.failed).toBe(true)
    expect(outcome.output).toBeUndefined()
  })

  it('超长输出被截断，并且**明说**被截了', () => {
    // 静默砍掉会让用户以为自己看到了全部；更要命的是不封顶会撑爆整条 mutation 的 128 KiB 硬上限，
    // 后果不是显示不全，是这一步彻底看不见。
    const outcome = hookToolOutcome({ tool_response: 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 500) })
    expect(outcome.output).toContain('[output truncated]')
    expect(outcome.output!.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 100)
  })

  it('刚好不超限的输出原样保留，不无端加标记', () => {
    const exact = 'y'.repeat(MAX_TOOL_OUTPUT_CHARS)
    expect(hookToolOutcome({ tool_response: exact }).output).toBe(exact)
  })

  it('认得各家 Provider 放结果的字段名', () => {
    expect(hookToolOutcome({ toolResponse: 'a' }).output).toBe('a')
    expect(hookToolOutcome({ tool_result: 'b' }).output).toBe('b')
    expect(hookToolOutcome({ output: 'c' }).output).toBe('c')
  })

  /**
   * 两族文本键的**顺序**本身承载判断，而不只是「有没有认得这个名字」。
   *
   * 一个结果对象常常同时带正文与旁证：`{stdout, stderr}` 里 stderr 往往只是进度条或告警，
   * `{output, message}` 里 message 常是一句「Tool completed」。取错那一个的后果不是缺信息，
   * 而是**显示了错的那段文本**——用户看着一行 warning 找不到自己命令的输出，且没有任何迹象说明
   * 真正的输出还在负载里。
   *
   * 之前只有「藏在 stdout 里要取 stdout」这一条：喂的对象只有一个候选键，于是任何重排都不改结果。
   * 下面每条都同时给两个键、且断言必须落在**优先的那一个**上，重排才会红。
   */
  it('结果对象同时带正文与旁证时，取优先的那个键——重排会显示错的那段文本', () => {
    // stderr 常是进度条或告警；取它等于把 warning 当成命令输出。
    expect(hookToolOutcome({ tool_response: { stdout: 'RESULT', stderr: 'warn' } }).output).toBe('RESULT')
    // message 常是一句状态语（'Tool completed'），output 才是这一步真正产出的东西。
    expect(hookToolOutcome({ tool_response: { output: 'REAL', message: 'noise' } }).output).toBe('REAL')
    // content 与 text 都是正文候选，但只有一个是这一步的结论。
    expect(hookToolOutcome({ tool_response: { content: 'C', text: 'T' } }).output).toBe('C')
  })

  it('失败正文也按顺序取：error 压过 error_message', () => {
    // 两个都在场时，`error` 是那一步自己说的原因，`error_message` 常是外层包装后的转述。
    const outcome = hookToolOutcome({ error: 'PRIMARY', error_message: 'secondary' })
    expect(outcome.output).toBe('PRIMARY')
    expect(outcome.failed).toBe(true)
    // 反向那一侧：`error` 缺席时 `error_message` 必须顶上，否则失败只有红点没有原因。
    expect(hookToolOutcome({ error_message: 'only' }).output).toBe('only')
  })
})
