import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserRunOutcomeFromFailure } from '../src/main/browser-run-outcome.js'
import type { BrowserScriptFailure } from '../src/main/browser-script-runner.js'

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
  // 闸必须在 Main 的 handler 里，不在调用方。那是所有入口的必经之路；放在调用方的话，
  // 每多一个入口就要记得再写一遍同样的检查，而漏写是静默的——新入口会在开关关着时照样跑。
  //
  // 这条用源码判据而不是跑一次 handler：ipc.ts 的 registerIpc 要一整套 Electron 替身才能起来，
  // 而这里要守的性质（闸在哪一层、拒绝说不说得出去哪开）恰好是结构性的。
  const ipc = readFileSync(join(MAIN_ROOT, 'ipc.ts'), 'utf8')

  it('闸在 browser:runScript 这一层，而且拒绝时说得出去哪开', () => {
    // 先证扫描面真的读到了东西，否则路径写错时下面全部恒绿。
    expect(ipc, 'ipc.ts 没读到内容，这条在对空气生效').toContain('browser:runScript')

    const handler = ipc.slice(ipc.indexOf("handleWithEvent('browser:runScript'"))
    const body = handler.slice(0, handler.indexOf('\n  })'))
    // 自检：真的切到了一段有内容的 handler，而不是空串。
    expect(body.length, 'handler 切片是空的').toBeGreaterThan(50)

    expect(body, '授权开关没有在这一层被检查——关着的时候程序照样会跑').toContain('agentAutomation')
    // `!== true` 而不是 `=== false`：字段是可选的，缺席必须也算关（config-store 会补成 false 落盘，
    // 但这一层不该依赖那个补齐动作有没有发生过）。
    expect(body, '缺席被当成了开——可选字段的 undefined 会绕过 === false 那种写法').toContain(
      'agentAutomation !== true'
    )
    expect(body, '拒绝没有指明去哪开，Agent 和用户都卡住').toMatch(/Settings/)
    // 必须是抛，不是返回一个空结果。静默降级正是 AGENTS.md:32-52 的唯一硬规则所禁止的。
    expect(body, '关着的时候没有抛，而是静默返回了什么东西').toContain('throw new Error')
  })
})
