import { describe, expect, it } from 'vitest'
import { classifyApplicationProcesses, snapshotApplicationProcesses, assertApplicationActivationOwnership } from '../scripts/package-process-scope.mjs'

/**
 * 打包安装脚本用 `processIdsForApplication` 回答三个问题：退出旧实例前「还有没有在服务这份包的进程」、
 * 拉起后「新包起来了没有」、以及安装收尾的幸存者断言「上一份安装的进程还活着没有」。三处都把「服务这份
 * 包」当判据。
 *
 * 事故（2026-09-13 实测 pid 1033）：匹配器的 `startsWith(Frameworks/)` 那条把脱钩的 crash-reporter
 * helper（`chrome_crashpad_handler`，app 退出后被 launchd 收养、PPID 1）也算进来。它不服务任何 UI、不
 * flush 状态，却让每一次后续安装都在退出旧实例这步卡死。
 *
 * 但不能因此「忽略所有 helper」——那会复活 2026-09-01 那次事故：renderer/GPU/utility helper 全都在
 * **服务这份包**，放过它们等于交付一个跑着旧代码的窗口。所以判据必须成对：crash reporter 被排除，其余
 * helper 仍然阻断。
 */

const APP = 'home//Applications/AgentMux.app'
const EXECUTABLE = `${APP}/Contents/MacOS/AgentMux`
const HELPER_ROOT = `${APP}/Contents/Frameworks/`
const FRAMEWORK = `${HELPER_ROOT}Electron Framework.framework/Helpers`

const bundle = { executable: EXECUTABLE, helperRoot: HELPER_ROOT }

const line = (pid: number, command: string) => `${String(pid).padStart(5)} ${command}`

describe('classifyApplicationProcesses separates serving from crash-reporter', () => {
  it('excludes a detached crashpad handler from serving so a stale one cannot block install', () => {
    const ps = line(
      1033,
      `${FRAMEWORK}/chrome_crashpad_handler --no-rate-limit --monitor-self-annotation=ptype=crashpad-handler --database=/x --handshake-fd=17`
    )
    const { serving, crashReporter } = classifyApplicationProcesses(ps, bundle)
    expect(serving).toEqual([])
    expect(crashReporter).toEqual([1033])
  })

  it('keeps the main process serving — the 2026-09-01 protection', () => {
    const { serving } = classifyApplicationProcesses(line(500, EXECUTABLE), bundle)
    expect(serving).toEqual([500])
  })

  it('keeps a renderer/GPU/utility helper serving — "ignore all helpers" would resurrect 2026-09-01', () => {
    const renderer = line(
      601,
      `${FRAMEWORK}/AgentMux Helper (Renderer).app/Contents/MacOS/AgentMux Helper (Renderer) --type=renderer`
    )
    const gpu = line(
      602,
      `${FRAMEWORK}/AgentMux Helper (GPU).app/Contents/MacOS/AgentMux Helper (GPU) --type=gpu-process`
    )
    const utility = line(
      603,
      `${FRAMEWORK}/AgentMux Helper.app/Contents/MacOS/AgentMux Helper --type=utility`
    )
    const { serving, crashReporter } = classifyApplicationProcesses([renderer, gpu, utility].join('\n'), bundle)
    expect(serving).toEqual([601, 602, 603])
    expect(crashReporter).toEqual([])
  })

  it('classifies a realistic mixed bundle: main + helpers block, only crashpad is carved out', () => {
    const ps = [
      line(500, EXECUTABLE),
      line(601, `${FRAMEWORK}/AgentMux Helper (Renderer).app/Contents/MacOS/AgentMux Helper (Renderer) --type=renderer`),
      line(602, `${FRAMEWORK}/AgentMux Helper (GPU).app/Contents/MacOS/AgentMux Helper (GPU) --type=gpu-process`),
      line(1033, `${FRAMEWORK}/chrome_crashpad_handler --database=/x`),
      line(99, '/sbin/launchd'),
      line(100, '/Applications/OtherApp.app/Contents/MacOS/OtherApp')
    ].join('\n')
    const { serving, crashReporter } = classifyApplicationProcesses(ps, bundle)
    expect(serving).toEqual([500, 601, 602])
    expect(crashReporter).toEqual([1033])
  })

  it('does not let a crashpad-looking argument on a real helper get it excluded', () => {
    // A serving helper whose *arguments* mention the crashpad handler must still block:
    // only the executable position is allowed to make the crash-reporter call.
    const ps = line(
      601,
      `${FRAMEWORK}/AgentMux Helper (Renderer).app/Contents/MacOS/AgentMux Helper (Renderer) --type=renderer --crashpad-handler=/chrome_crashpad_handler`
    )
    const { serving, crashReporter } = classifyApplicationProcesses(ps, bundle)
    expect(serving).toEqual([601])
    expect(crashReporter).toEqual([])
  })
})

describe('candidate activation uses OS ownership rather than the first launch PID list', () => {
  const oldBirth = 'Fri Oct 2 12:00:00 2026', newBirth = 'Fri Oct 2 12:00:01 2026'
  const oldMain = { pid: 500, ppid: 1, birth: oldBirth }
  const oldHelper = { pid: 601, ppid: 500, birth: oldBirth }
  const main = { pid: 700, ppid: 1, birth: newBirth }
  const renderer = { pid: 701, ppid: 700, birth: newBirth }
  const gpu = { pid: 702, ppid: 700, birth: newBirth }
  const utility = { pid: 703, ppid: 701, birth: newBirth }
  const system = { pid: 1, ppid: 0, birth: oldBirth }
  const ownership = (current: typeof main[], serving: number[] = [700, 701, 702, 703]) => ({
    previous: [oldMain, oldHelper], beforeLaunch: [system, oldMain, oldHelper], current, serving, mainPid: 700
  })

  it('keeps exact nonempty process metadata while preserving the crash-reporter classification', () => {
    const ps = [
      ` 700 1 Fri Oct  2 12:00:01 2026 ${EXECUTABLE}`,
      ` 701 700 Fri Oct  2 12:00:01 2026 ${FRAMEWORK}/AgentMux Helper (Renderer).app/Contents/MacOS/AgentMux Helper (Renderer) --type=renderer`,
      ` 710 1 Fri Oct  2 12:00:01 2026 ${FRAMEWORK}/chrome_crashpad_handler --database=/x`
    ].join('\n')
    expect(snapshotApplicationProcesses(ps, bundle)).toEqual({ serving: [700, 701], crashReporter: [710],
      processes: [main, renderer, { pid: 710, ppid: 1, birth: newBirth }] })
    expect(() => snapshotApplicationProcesses('', bundle)).toThrow('empty')
    expect(() => snapshotApplicationProcesses(`700 1 unavailable ${EXECUTABLE}`, bundle)).toThrow('birth observation')
  })

  it('accepts later Renderer/GPU/utility owners although the platform first returned only Main', () => {
    const current = [system, main, renderer, gpu, utility]
    expect(assertApplicationActivationOwnership(ownership(current))).toEqual([main, renderer, gpu, utility])
  })

  it('rejects an original owner still alive even when absent from the current canonical-path scope', () => {
    expect(() => assertApplicationActivationOwnership(ownership([system, oldMain, main, renderer, gpu, utility])))
      .toThrow('previous application owner')
    expect(() => assertApplicationActivationOwnership(ownership([system, { ...oldHelper, ppid: 700 }, main, renderer, gpu, utility])))
      .toThrow('previous application owner')
  })

  it('distinguishes PID reuse by birth and still requires the real new Main ancestry', () => {
    const reused = { pid: 601, ppid: 700, birth: newBirth }
    expect(assertApplicationActivationOwnership(ownership([system, main, reused], [700, 601]))).toEqual([main, reused])
    expect(() => assertApplicationActivationOwnership(ownership([system, main, { ...reused, ppid: 1 }], [700, 601])))
      .toThrow('not a confirmed descendant')
  })

  it('refuses an already-existing Main and a helper that existed before launch', () => {
    const current = [system, main, renderer, gpu, utility]
    expect(() => assertApplicationActivationOwnership({ ...ownership(current), beforeLaunch: [system, main] }))
      .toThrow('Main existed before')
    expect(() => assertApplicationActivationOwnership({ ...ownership(current), beforeLaunch: [system, renderer] }))
      .toThrow('existed before candidate launch')
  })

  it('does not qualify missing birth facts or an empty actual application scope', () => {
    expect(() => assertApplicationActivationOwnership(ownership([system, main, { ...renderer, birth: '' }], [700, 701])))
      .toThrow('birth is unavailable')
    expect(() => assertApplicationActivationOwnership(ownership([system, main], []))).toThrow('loaded Main')
  })

  it('terminates on a cyclic ancestry observation rather than ignoring the helper', () => {
    const a = { pid: 701, ppid: 702, birth: newBirth }, b = { pid: 702, ppid: 701, birth: newBirth }
    expect(() => assertApplicationActivationOwnership(ownership([system, main, a, b], [700, 701, 702])))
      .toThrow('ancestry is cyclic')
  })
})
