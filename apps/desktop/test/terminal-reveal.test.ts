import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  TERMINAL_REVEAL_DEADLINE_MS,
  terminalAcceptsInput,
  terminalInputSender,
  terminalRevealDecision,
  terminalRevealServiceOutcome
} from '../src/renderer/src/lib/terminal-reveal.js'
import { classifyServiceNotice, serviceNoticeToRender } from '../src/renderer/src/lib/service-window-notice.js'

/**
 * 揭示不得被我们自己的步骤无限期挡住（AGENTS.md 原则 11）。
 *
 * 用户的说法是："现在有个 ctxmux 明明存在还在打开时显示 restoring"。恢复态此前只有两个出口——
 * 全链成功、attach 抛错——所以"链上某处永不 settle"这一类在界面上表现为**永久转圈**，而 ctxmux、
 * Run、PTY 全都好着。这是第 2 类（Agent 没坏，是我们的流程坏了）被写成了无限期等待，比写成
 * 第 1 类更糟：连"哪里不对"都不告诉用户。
 *
 * 所以这里断言的是那条兜底本身：到点必须把画布交还用户，且**必定**同时说清情况。这两件事一件都
 * 不能少——只揭示不说话是静默降级，只说话不揭示是继续挡路。
 *
 * 承重断言落在纯函数上：本仓没有能跑 useEffect 的测试环境（renderToStaticMarkup），
 * 写在 effect 里的取舍没有断言够得着。
 */

const startedAtMs = 1_000

/** 揭示尚未完成时的输入。`revealed` 为真代表 replay 已写完、画布已交出。 */
function pending(elapsedMs: number) {
  return {
    revealed: false,
    startedAtMs,
    nowMs: startedAtMs + elapsedMs,
    deadlineMs: TERMINAL_REVEAL_DEADLINE_MS
  }
}

describe('揭示的 deadline', () => {
  it('未到点：继续等，保持恢复态', () => {
    const decision = terminalRevealDecision(pending(TERMINAL_REVEAL_DEADLINE_MS - 1))
    expect(decision.reveal).toBe(false)
    expect(decision.overdue).toBe(false)
  })

  it('到点仍未揭示：强制揭示，把画布交还用户', () => {
    const decision = terminalRevealDecision(pending(TERMINAL_REVEAL_DEADLINE_MS))
    expect(decision.reveal).toBe(true)
    expect(decision.overdue).toBe(true)
  })

  it('已经正常揭示过的，deadline 不再产生任何主张——它不是第二个揭示者', () => {
    const decision = terminalRevealDecision({
      ...pending(TERMINAL_REVEAL_DEADLINE_MS * 10),
      revealed: true
    })
    expect(decision.overdue).toBe(false)
  })

  it('deadline 是一个正的有限值——0 会让恢复态永不出现，Infinity 等于没有兜底', () => {
    expect(TERMINAL_REVEAL_DEADLINE_MS).toBeGreaterThan(0)
    expect(Number.isFinite(TERMINAL_REVEAL_DEADLINE_MS)).toBe(true)
  })
})

describe('强制揭示绝不静默', () => {
  it('到点揭示的同时必定产出一条告示', () => {
    const outcome = terminalRevealServiceOutcome({ overdue: true, processState: 'running', liveReady: true })
    expect(outcome.completed).toBe(false)
    // 走既有分类器，不新建第二条失败通路。
    expect(serviceNoticeToRender(classifyServiceNotice(outcome))).not.toBeNull()
  })

  it('没到点就没有告示——恢复态正常走完不该留下任何降级痕迹', () => {
    const outcome = terminalRevealServiceOutcome({ overdue: false, processState: 'running', liveReady: true })
    expect(outcome.completed).toBe(true)
    expect(serviceNoticeToRender(classifyServiceNotice(outcome))).toBeNull()
  })
})

describe('三态分流：判据是 Run 还能干活吗，不是我们的步骤过了吗', () => {
  function classify(processState: 'running' | 'exited' | 'interrupted') {
    return classifyServiceNotice(
      terminalRevealServiceOutcome({ overdue: true, processState, liveReady: true })
    )
  }

  it('Run 还在跑：第 2 类，放行并提醒', () => {
    expect(classify('running').kind).toBe('process-degraded')
  })

  it('Run 退了：第 1 类，交给既有恢复横幅，服务窗不接手', () => {
    expect(classify('exited').kind).toBe('agent-broken')
  })

  it('既非在跑也非退出：如实说分不清，不猜一个再照着做', () => {
    expect(classify('interrupted').kind).toBe('indeterminate')
  })

  it('三者不是同一种处置——把它们折叠成一种要红', () => {
    const kinds = new Set([
      classify('running').kind,
      classify('exited').kind,
      classify('interrupted').kind
    ])
    expect(kinds.size).toBe(3)
  })

  it('分不清也绝不静默：它和第 2 类一样必定产出告示', () => {
    expect(serviceNoticeToRender(classify('interrupted'))).not.toBeNull()
  })
})

describe('告示说清三件事', () => {
  const notice = serviceNoticeToRender(
    classifyServiceNotice(terminalRevealServiceOutcome({ overdue: true, processState: 'running', liveReady: true }))
  )

  it('哪一步没走通、现在按什么状态在跑、怎么恢复——缺任一件要红', () => {
    expect(notice).not.toBeNull()
    for (const line of [notice!.notice.step, notice!.notice.mode, notice!.notice.restore]) {
      expect(line.trim().length).toBeGreaterThan(0)
    }
  })

  it('说的是这一步（恢复这个终端），而不是一句放之四海的"出错了"', () => {
    expect(notice!.notice.step.toLowerCase()).toContain('restor')
  })

  it('说清终端此刻可用——这正是"放行"的意思，用户不该以为自己还在等', () => {
    expect(notice!.notice.mode.toLowerCase()).toContain('usable')
  })

  it('attachment 尚未交接时不宣称输入已经可用', () => {
    const pendingNotice = serviceNoticeToRender(classifyServiceNotice(
      terminalRevealServiceOutcome({ overdue: true, processState: 'running', liveReady: false })
    ))
    expect(pendingNotice!.notice.mode.toLowerCase()).toContain('unlock')
    expect(pendingNotice!.notice.mode.toLowerCase()).not.toContain('usable now')
  })
})

/**
 * "放行"不等于"什么都通了"。
 *
 * 这是原则 11 第 2 类最容易做错的半句：画布交还用户之后，replay→live 的交接可能还没完成，
 * 此刻键盘敲下去会写进一个还没接上的 attachment。所以两件事必须同时成立——告示如实说输入
 * 还没通（上面那条），且输入**真的**没通（下面这些）。
 *
 * 这些断言是补一个真空洞：三条输入通路的 liveReady 卡口此前一条测试都没有，
 * 三个 gate 一起删掉全仓 1512 个测试照样全绿（变异实测）。
 */
describe('揭示了不等于输入通了', () => {
  const ready = { canControlRun: true, acceptsInput: true, liveReady: true }

  it('三个条件都成立才送输入', () => {
    expect(terminalAcceptsInput(ready)).toBe(true)
  })

  it('交接未完成时不送——写进一个还没接上的 attachment 等于按键丢失', () => {
    expect(terminalAcceptsInput({ ...ready, liveReady: false })).toBe(false)
  })

  it('进程不可控时不送——Run 已经退了，键入无处可去', () => {
    expect(terminalAcceptsInput({ ...ready, canControlRun: false })).toBe(false)
  })

  it('Session 此刻不收输入时不送——Agent 有待答交互，键入会插进那个问题里', () => {
    expect(terminalAcceptsInput({ ...ready, acceptsInput: false })).toBe(false)
  })

  it('三个条件各自都是必要的——去掉任一个都要红', () => {
    // 逐个单独置假：三次都必须为 false。少卡一条就等于没卡，用户总会找到那一条。
    const blocked = (['canControlRun', 'acceptsInput', 'liveReady'] as const).map((key) =>
      terminalAcceptsInput({ ...ready, [key]: false })
    )
    expect(blocked).toEqual([false, false, false])
  })

  it('闸的极性真的跑得到：不收输入时一个字节都不许送出', () => {
    // 判定是纯函数不等于**用法**被守住。此前三条通路各写一个 `if (acceptsInputNow())` 在
    // attach effect 里，而本仓跑不了 effect，只有源码文本守卫够得着——它数得出闸的个数，
    // 数不出极性：三处一起改成 `if (!...)`，76 条相关断言全绿（实测）。而那是「每次击键都丢，
    // 且不该送的时候反而送」，用户侧等于键盘彻底哑掉。
    //
    // 所以送出这一步收进了 terminalInputSender：极性于是落在这里，跑得到、断言得着。
    const sent: string[] = []
    const open = terminalInputSender({ accepts: () => true, write: (data) => sent.push(data) })
    const shut = terminalInputSender({ accepts: () => false, write: (data) => sent.push(data) })

    open('a')
    shut('b')
    expect(sent).toEqual(['a'])
  })

  it('每次送出都重新问一遍，不缓存开闸那一刻的答案', () => {
    // 闸的三个输入都是 ref/state，会在 attachment 生命周期里翻转。若 sender 在构造时把
    // accepts() 的结果存下来，交接完成前建立的那个 sender 会永远拒收——终端从此哑到重挂载。
    let accepts = false
    const sent: string[] = []
    const send = terminalInputSender({ accepts: () => accepts, write: (data) => sent.push(data) })

    send('before')
    accepts = true
    send('after')
    accepts = false
    send('closed-again')
    expect(sent).toEqual(['after'])
  })
})

/**
 * 三条输入通路共用同一个出口。
 *
 * 这一族只能用源码断言守住——它们长在 attach effect 里，本仓跑不了 effect。但守的东西换了：
 * 不再数"每处 write 前面有没有闸"（数得出个数、数不出极性，三处一起取反曾 76 条全绿），
 * 而是守"组件里根本没有第二个 write，也没有可以写反的 if"——闸与送出一起收在
 * terminalInputSender 里，极性由上面那两条真跑的断言守。
 */
describe('输入只有一个出口', () => {
  const terminalView = readFileSync(
    new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
    'utf8'
  )

  it('整个组件只有一处 api.sessions.write，就在那个 sender 里', () => {
    // 一处以上就意味着有一条通路绕过了 sender——而绕过的那条不会被任何断言够得着。
    const writes = [...terminalView.matchAll(/api\.sessions\.write\(/g)]
    expect(writes.length, '出现了第二个写入点，它绕过了带闸的 sender').toBe(1)
    const sender = terminalView.slice(
      terminalView.indexOf('const sendInput = terminalInputSender({')
    )
    expect(
      sender.slice(0, sender.indexOf('\n    })')),
      '唯一那处 write 不在 sender 里'
    ).toContain('api.sessions.write(')
  })

  it('组件里不再自己写闸——没有 if 可以取反', () => {
    // 判定与送出一起在 lib 里，组件只提供三个取值。任何一处 `if (accepts...)` 回到组件里，
    // 就等于把"极性没人守"这个洞装回去。
    const code = terminalView.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/if\s*\(!?\s*acceptsInputNow\(\)/)
    expect(code).toContain('terminalInputSender({')
    // 三条通路都送进那一个出口，各自钉住自己的形状（宽松的 `/sendInput/` 会被任意一处满足，
    // 于是"某条通路没接上"照旧全绿）。
    expect(code, 'onData 没接到 sender').toContain('terminal.onData(sendInput)')
    expect(code, 'Shift+Enter 没接到 sender').toMatch(/sendInput\(shiftEnterInput\(/)
    expect(code, 'OSC 回复没接到 sender').toMatch(/sendInput\s*\n\s*\}\)/)
  })

  it('判定走共享纯函数，不在组件里各写一遍布尔表达式', () => {
    // 各写一遍等于让"什么算可以输入"有第二个说法，且下一处新增通路会漏掉最新的那个条件。
    expect(terminalView).toContain('terminalAcceptsInput({')
    expect(terminalView).not.toMatch(
      /canControlRunRef\.current && acceptsInputRef\.current && readyForLiveOutput/
    )
  })
})

/**
 * 揭示时序：live 视口同步不再排在揭示之前。
 *
 * 这是本轮的根因修复，且**只能**用源码断言守住——它发生在 attach effect 里，本仓跑不了 effect。
 * 那把锁的形状是：`startLiveSynchronization` → `api.sessions.resize` →
 * `resizeSessionAttachment`，与 attach 争用同一把按 Run 串行的锁；只要该 Run 上还排着一个不
 * settle 的操作，排在揭示之前的 live 同步就永远等不到，于是揭示永不发生。
 */
describe('揭示只等画面正确真正依赖的那一步', () => {
  const terminalView = readFileSync(
    new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url),
    'utf8'
  )

  it('replay 写完就揭示，不等 live 同步与 gap redraw', () => {
    // 断言的是**调用点**，不是 setHydrating 的定义位置：揭示已收进一个 helper，
    // 而 helper 定义在整条链之前，所以比较 `setHydrating(false)` 的下标恒真——
    // 那样的断言把揭示挪到恢复收尾之后也照样绿（本轮变异测试实测）。
    // 取"回放"到"恢复收尾"之间的那段源码，揭示必须发生在里面。
    const replayAt = terminalView.indexOf('hydrateTerminalReplay(')
    const recoveryAt = terminalView.indexOf('await finishTerminalReplayRecovery({')
    expect(replayAt).toBeGreaterThan(-1)
    expect(recoveryAt).toBeGreaterThan(replayAt)
    expect(terminalView.slice(replayAt, recoveryAt)).toContain('reveal()')
  })

  it('揭示就是把恢复态放下——helper 名副其实，不是个空壳', () => {
    expect(terminalView).toContain('revealed = true')
    expect(terminalView).toContain('setHydrating(false)')
  })

  it('deadline 用 setTimeout 挂在 attach effect 里，并在拆卸时清掉', () => {
    expect(terminalView).toContain('TERMINAL_REVEAL_DEADLINE_MS')
    expect(terminalView).toContain('clearTimeout')
  })

  it('恢复收尾仍然发生——它改善画面，只是不再决定画面何时可看', () => {
    expect(terminalView).toContain('finishTerminalReplayRecovery')
    expect(terminalView).toContain('requestContentRedraw')
  })
})
