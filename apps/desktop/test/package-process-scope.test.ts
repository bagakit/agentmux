import { describe, expect, it } from 'vitest'
import { classifyApplicationProcesses } from '../scripts/package-process-scope.mjs'

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

const APP = '/Users/alice/Applications/AgentMux.app'
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
