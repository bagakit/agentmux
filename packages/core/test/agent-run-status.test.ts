/**
 * 「进程事实 → 界面那一行状态」的唯一投影。
 *
 * 这个文件守的是投影本身的取值规则；「两条路径有没有真的都走它」由 desktop 侧那两族接线测试各自钉死
 * （快照路径在 runtime-controller.test.ts，实时路径在 run-process-status-convergence.test.ts）。分工的
 * 理由：投影正确但某条路不调它，是本次修的那个真缺陷的形状——一个文件绿不能替另一个文件担保。
 */

import { describe, expect, it } from 'vitest'
import {
  RUN_INTERRUPTED_DETAIL,
  projectRunProcessStatus,
  runDisplayState
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
})
