/**
 * 「进程事实 → 界面那一行状态」的唯一投影。
 *
 * 这个文件守的是投影本身的取值规则；「两条路径有没有真的都走它」由 desktop 侧那两族接线测试各自钉死
 * （快照路径在 runtime-controller.test.ts，实时路径在 run-process-status-convergence.test.ts）。分工的
 * 理由：投影正确但某条路不调它，是本次修的那个真缺陷的形状——一个文件绿不能替另一个文件担保。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  RUN_INTERRUPTED_DETAIL,
  projectRunProcessStatus,
  runDisplayState,
  runExitFacts
} from '../src/agent-run-status.js'

describe('interrupted 对用户就是出错', () => {
  it('显示态落到 error，而不是把一个内部词直接给用户看', () => {
    expect(runDisplayState('interrupted')).toBe('error')
  })

  it('其余状态原样透出——只有 interrupted 需要翻译', () => {
    expect(runDisplayState('running')).toBe('running')
    expect(runDisplayState('exited')).toBe('exited')
  })
})

describe('detail 说清「为什么是这个状态」', () => {
  it('interrupted 配一句固定说明：它既没有退出码也没有信号可给', () => {
    // 断言写死这句话本身，而不是 `toBe(RUN_INTERRUPTED_DETAIL)`：后者跟着常量一起漂，改文案永远绿。
    // 常量的价值在于「两条路径读同一句」，而这句话是什么，要有一处写死的期望来钉。
    expect(projectRunProcessStatus({
      state: 'interrupted',
      source: 'run-process',
      observedAt: 7
    }).detail).toBe('The Run owner interrupted this PTY.')
  })

  it('常量与投影用的是同一句——手抄第二份文案会红在这里', () => {
    expect(projectRunProcessStatus({
      state: 'interrupted',
      source: 'run-process',
      observedAt: 7
    }).detail).toBe(RUN_INTERRUPTED_DETAIL)
  })

  it('被信号打死时说是哪个信号——裸 error 搜不出任何东西', () => {
    // 这是本次修的真缺陷所在：这条事实此前只有快照路径在场，实时路径整段没读过 exitSignal。
    // 于是崩溃**当下**看不到 SIGSEGV，关掉窗口重开反而看到了。
    expect(projectRunProcessStatus({
      state: 'exited',
      source: 'run-process',
      observedAt: 7,
      exitCode: 139,
      exitSignal: 'SIGSEGV'
    }).detail).toBe('signal SIGSEGV')
  })

  it('干净退出不写 detail，也绝不写空串或占位符', () => {
    // 空串会把「没有更多信息」伪装成「信息是空的」，界面上就是一行空白说明。
    expect(projectRunProcessStatus({
      state: 'exited',
      source: 'run-process',
      observedAt: 7,
      exitCode: 0
    })).not.toHaveProperty('detail')
  })

  it('interrupted 同时带信号时，仍说 interrupt 那句——PTY 没了才是用户看到的原因', () => {
    // 优先级独立承重：把两条分支调个位置，只有这条会红。
    expect(projectRunProcessStatus({
      state: 'interrupted',
      source: 'run-process',
      observedAt: 7,
      exitSignal: 'SIGHUP'
    }).detail).toBe(RUN_INTERRUPTED_DETAIL)
  })
})

describe('带就带上、缺就缺席', () => {
  it('exitCode 0 是合法的码，必须原样在场', () => {
    // `?? 0` 那种兜底会把「没报码」伪造成「干净退出」；反过来把 0 当假值丢掉，横幅就说不出它是怎么走的。
    expect(projectRunProcessStatus({
      state: 'exited',
      source: 'run-process',
      observedAt: 7,
      exitCode: 0
    }).exitCode).toBe(0)
  })

  it('没报码时不凭空造一个', () => {
    expect(projectRunProcessStatus({
      state: 'exited',
      source: 'run-process',
      observedAt: 7
    })).not.toHaveProperty('exitCode')
  })

  it('exitReason 照原样带过去——它是「你关的还是它崩的」唯一的答案', () => {
    expect(projectRunProcessStatus({
      state: 'exited',
      source: 'run-process',
      observedAt: 7,
      exitCode: 1,
      exitReason: 'crashed'
    }).exitReason).toBe('crashed')
  })

  it('没有 exitReason 时不许一律填 crashed——那会把我们自己关掉的说成崩溃', () => {
    expect(projectRunProcessStatus({
      state: 'exited',
      source: 'run-process',
      observedAt: 7,
      exitCode: 0
    })).not.toHaveProperty('exitReason')
  })

  it('source 与 observedAt 原样透出：这条观察是谁看到的、什么时候', () => {
    expect(projectRunProcessStatus({
      state: 'running',
      source: 'native-hook',
      observedAt: 99
    })).toEqual({ state: 'running', source: 'native-hook', observedAt: 99 })
  })

  it('退出态投出的键集恰好是这几个——多一个键没有编译器挡，只有这条断言挡', () => {
    // 为什么必须逐键相等而不是 toMatchObject / 逐条 .toBe：两个调用方都把返回值存进变量再传下去，
    // 不是内联字面量，所以 TS 的 excess-property check 根本不触发；`exactOptionalPropertyTypes`
    // 管的也只是「可选属性别显式赋 undefined」，不管「别多一个键」。于是往投影里多写一条会一路静默
    // 流到 SessionStatus 上。`toMatchObject` 在这里等于没写——它对多出来的键完全失明。
    expect(projectRunProcessStatus({
      state: 'exited',
      source: 'run-process',
      observedAt: 7,
      exitCode: 139,
      exitSignal: 'SIGSEGV',
      exitReason: 'crashed'
    })).toEqual({
      state: 'exited',
      source: 'run-process',
      observedAt: 7,
      detail: 'signal SIGSEGV',
      exitCode: 139,
      exitReason: 'crashed'
    })
    // exitSignal 本身刻意**不**落到 status 上：它只用来合成 detail。上面的 toEqual 已经钉死了这件事
    // （多带一个 exitSignal 键就不相等），这条只是把「为什么不在」写明白。
  })
})

describe('三条退出事实的取法只有一个出处', () => {
  it('三条都在场时逐条带过去', () => {
    expect(runExitFacts({ exitCode: 139, exitSignal: 'SIGSEGV', exitReason: 'crashed' }))
      .toEqual({ exitCode: 139, exitSignal: 'SIGSEGV', exitReason: 'crashed' })
  })

  it('缺席的不许凭空补——键根本不出现，而不是出现一个 undefined', () => {
    // 判据是 toEqual({}) 而不是逐条 not.toHaveProperty：后者漏掉哪条就守不到哪条，而这个函数的
    // 全部价值就在于「三条一起决定」。`{ exitCode: undefined }` 与 `{}` 在 toEqual 下不等，正好
    // 也钉住了「别用 `?? undefined` 之类的写法把键塞进去」。
    expect(runExitFacts({})).toEqual({})
  })

  it('exitCode 0 与 exitReason user-stopped 都是有意义的取值，不能被当假值丢掉', () => {
    // 0 是干净退出的码，`user-stopped` 是「你自己关的」。任何 `if (x)` 式的过滤都会吞掉这两个。
    expect(runExitFacts({ exitCode: 0, exitReason: 'user-stopped' }))
      .toEqual({ exitCode: 0, exitReason: 'user-stopped' })
  })

  it('三条各自独立承重：单独在场时不会被另两条的缺席带走', () => {
    // 这是那个真缺陷的形状——两条路径各抄一份三行 spread，漏一行全绿。逐条单独喂，任何一条被从
    // runExitFacts 里删掉都只红这里的一个 case，红得指名道姓。
    expect(runExitFacts({ exitCode: 1 })).toEqual({ exitCode: 1 })
    expect(runExitFacts({ exitSignal: 'SIGKILL' })).toEqual({ exitSignal: 'SIGKILL' })
    expect(runExitFacts({ exitReason: 'crashed' })).toEqual({ exitReason: 'crashed' })
  })

  it('两个调用方都不再自己手抄那三行——判据是结构，不是取值', () => {
    // 取值相等证不了这件事：两处各抄一份、抄得一模一样时，每一条取值断言都是绿的，而下一次只改一处
    // 的漂移照旧发生（实测发生过两次：exitSignal、exitReason）。所以这里质询源码本身：那两个文件里
    // 不许再出现读 exitSignal / exitReason 的裸 spread，它们只能通过 runExitFacts 拿。
    const callSites = [
      new URL('../../../apps/desktop/src/main/runtime-controller.ts', import.meta.url),
      new URL('../../../apps/desktop/src/renderer/src/lib/session-state.ts', import.meta.url)
    ]
    for (const site of callSites) {
      const source = readFileSync(site, 'utf8')
      // 挡板：路径写错时 readFileSync 会抛，所以读到内容就说明文件在。再确认它真的是调用方——
      // 否则「没有手抄」会因为读了个不相关的文件而恒真。
      expect(source, `${site.pathname} 不再调用 projectRunProcessStatus，这条守卫钉错了文件`)
        .toContain('projectRunProcessStatus(')
      expect(source, `${site.pathname} 应通过 runExitFacts 取退出事实`).toContain('runExitFacts(')
      // 手抄的形状就是「在三元里读这两个字段之一」。exitCode 不列入：它在别处有独立用途，
      // 而 exitSignal/exitReason 在这两个文件里只为投影服务，出现裸 spread 就是又抄了一份。
      for (const field of ['exitSignal', 'exitReason']) {
        expect(
          source.includes(`${field} === undefined ? {} :`),
          `${site.pathname} 又手抄了一份 ${field} 的编组；那三行只能有一个出处（runExitFacts）`
        ).toBe(false)
      }
    }
  })
})
