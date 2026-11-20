import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserRunOutcomeFromFailure } from '@agentmux/browser/operations'
import type { BrowserScriptFailure } from '@agentmux/browser/operations'

/**
 * 从「执行器的失败」到「契约的结局」这一次翻译，以及授权闸真的在那条必经之路上。
 *
 * 这两件事放一个文件，是因为它们守的是同一条原则（AGENTS.md:32-52）的两侧：
 * 结局不许折并（否则 Agent 走错方向），拒绝不许静默（否则用户不知道去哪开）。
 */

const MAIN_ROOT = join(import.meta.dirname, '..', 'src', 'main')

describe('Agent 程序的结局翻译', () => {
  it('四支失败映到三类结局，且 crashed 单独占住 indeterminate', () => {
    const failures: BrowserScriptFailure[] = [
      { kind: 'script-error', message: 'boom' },
      { kind: 'timeout', timeoutMs: 30_000 },
      { kind: 'output-limit', capturedChars: 1_048_576 },
      { kind: 'crashed', reason: 'The script process exited with code 1.' }
    ]
    const kinds = failures.map((failure) => browserRunOutcomeFromFailure(failure).kind)

    // 自检：四支都真的被翻译了，否则下面的判据在对空气生效（AGENTS.md:85-88）。
    expect(kinds, '不是四支都跑到了').toHaveLength(4)
    expect(kinds).toEqual(['script-failed', 'stopped', 'stopped', 'indeterminate'])
  })

  // 承重的一条。crashed 折进 script-failed 或 stopped 之后，上面那条 toEqual 也会红，
  // 但这条说清了**为什么**不能折：进程死了意味着做到哪一步不知道，页面上可能已经点过一次了。
  // 报成一次普通失败，调用方就会重试——那正是"下单被点两次"的来源。
  it('crashed 绝不与任何一支共用结局档位', () => {
    const crashed = browserRunOutcomeFromFailure({ kind: 'crashed', reason: 'Out of memory.' })
    const others = (
      [
        { kind: 'script-error', message: 'x' },
        { kind: 'timeout', timeoutMs: 1 },
        { kind: 'output-limit', capturedChars: 1 }
      ] satisfies BrowserScriptFailure[]
    ).map((failure) => browserRunOutcomeFromFailure(failure).kind)

    expect(others, '对照组是空的，下面的判据恒真').toHaveLength(3)
    expect(others, 'crashed 与别的失败共用了结局档位——"做到哪一步不知道"这一类消失了').not.toContain(
      crashed.kind
    )
  })

  it('每一类都说清下一步，而不只是复述发生了什么', () => {
    // 一句说不出下一步的失败，Agent 只能重试或放弃。逐条点名各自要出现的那个信息：
    // 超时要给出预算（才知道是不是该拆小），截断要说明是日志太多（而不是程序错了），
    // crashed 要警告页面**可能已经被改过**（这是四类里唯一一条会影响 Agent 下一步安全的）。
    expect(
      browserRunOutcomeFromFailure({ kind: 'timeout', timeoutMs: 30_000 }).kind === 'stopped' &&
        message({ kind: 'timeout', timeoutMs: 30_000 })
    ).toContain('30000')
    expect(message({ kind: 'output-limit', capturedChars: 999 }), '没说是输出太多').toMatch(/Log less/i)
    expect(
      message({ kind: 'crashed', reason: 'The script process died.' }),
      'crashed 没有警告页面可能已经被改过——Agent 会直接重试'
    ).toMatch(/partially changed/i)
    // script-error 原样带回脚本自己的话；不带的话 Agent 看不到它错在哪。
    expect(message({ kind: 'script-error', message: 'element is gone' })).toContain('element is gone')
  })
})

function message(failure: BrowserScriptFailure): string {
  const outcome = browserRunOutcomeFromFailure(failure)
  return outcome.kind === 'completed' ? '' : outcome.message
}

describe('Agent 驱动页面的授权闸', () => {
  // 闸必须在 Main 的 handler 里，不在调用方：那是所有入口的必经之路，漏写一处是静默的。
  // 判定本身归 browser-automation-gate.ts，那里有按调用方的行为测试（browser-profile-agent-access）；
  // 这里只守「runScript 这条入口真的在派发之前问了那道闸」。源码判据而非跑 handler，
  // 因为 registerIpc 要一整套 Electron 替身才能起来，而要守的恰好是结构。
  const ipc = readFileSync(join(MAIN_ROOT, 'ipc.ts'), 'utf8')

  it('browser:runScript 在派发程序之前先问自动化闸，并把调用方交给它', () => {
    expect(ipc, 'ipc.ts 没读到内容，这条在对空气生效').toContain('browser:runScript')
    const handler = ipc.slice(ipc.indexOf("handleWithEvent('browser:runScript'"))
    const body = handler.slice(0, handler.indexOf('\n  })'))
    expect(body.length, 'handler 切片是空的').toBeGreaterThan(50)
    const gate = body.indexOf('await browserAutomation(id, caller)')
    expect(gate, '这条入口没有问闸，或者没把调用方交给它——按 Profile 的 Agent 开关就拦不住 Agent').toBeGreaterThan(-1)
    expect(gate, '闸问在了程序派发之后——关着的时候程序已经开始跑').toBeLessThan(body.indexOf('browsers.runScript('))
  })
})
