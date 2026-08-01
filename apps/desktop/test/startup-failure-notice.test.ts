import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { startupFailureNotice } from '../src/main/startup-failure-notice.js'

// ---------------------------------------------------------------------------
// 启动失败必须**说出来**。
//
// 缺陷形状：`exitAfterFailure` 只 `process.stderr.write` 然后 `app.exit(1)`，而整个主进程没有任何
// `dialog.showErrorBox` 调用（实测 `grep -rn showErrorBox src/` 零命中）。终端里启动的开发者能看到
// 那行字；从 Finder 双击的用户看到的是 Dock 图标弹一下就消失，**一个字都没有**。
//
// 为什么这不是「小的体验问题」：config-store 里那四道守卫（容器不可读 / 项目全 stranded / 全损 /
// Executor 容器不可读）的设计前提是「拒绝启动，不覆盖磁盘，让用户知道东西还在」。用户收不到那段话，
// 这个交换就只剩代价没有收益——他手上那份完好的配置，会因为「应用坏了」而被他自己删掉重装。
//
// 这一族分两半判，因为它们会各自独立地坏掉（见记忆 extracting-to-lib-only-fixes-half）：
//   1. 内容对不对 —— 纯函数，行为断言；
//   2. 那条失败路径**有没有真的调它** —— 源码结构断言。
// 只有第 1 半时，整个 `showErrorBox` 调用可以被删掉而全绿；那正是修复前的状态。
// ---------------------------------------------------------------------------

const CONFIG_PATH = '/Users/someone/Library/Application Support/AgentMux/agentmux.config.json'

describe('启动失败通知的内容', () => {
  it('把原始诊断串原样带上——用户要能搜索它，也要能贴给我们', () => {
    const notice = startupFailureNotice(
      new Error('Refusing to retire a config whose host list the current schema cannot read'),
      { configPath: CONFIG_PATH }
    )

    expect(notice.body).toContain('host list the current schema cannot read')
  })

  it('说明磁盘上的东西没被改过——那是拒绝启动换来的唯一好处', () => {
    // 不说这句，用户读到的就只是「打不开」，而正确的下一步（去修那个文件、别重装）无从得知。
    const notice = startupFailureNotice(new Error('anything'), { configPath: CONFIG_PATH })

    expect(notice.body).toMatch(/has not been changed/)
  })

  it('给出配置文件的完整路径——没有它，「去修一个字节」是不可执行的建议', () => {
    const notice = startupFailureNotice(new Error('anything'), { configPath: CONFIG_PATH })

    expect(notice.body).toContain(CONFIG_PATH)
  })

  it('不建议重装或删除——那恰好会毁掉守卫刚保住的东西', () => {
    // 反向判据。这类文案很容易被"友好化"成「请尝试重新安装」，而重装会删掉 userData，
    // 也就删掉那份还完好的配置。
    const notice = startupFailureNotice(new Error('anything'), { configPath: CONFIG_PATH })

    expect(notice.body).not.toMatch(/reinstall|delete|remove the/i)
  })

  it('非 Error 的抛出物也要给出可读内容，不能变成 [object Object]', () => {
    // 主进程引导期抛出的不一定是 Error（Promise reject 一个字符串、一个 IPC 结构体都可能）。
    const notice = startupFailureNotice('daemon endpoint unavailable', { configPath: CONFIG_PATH })

    expect(notice.body).toContain('daemon endpoint unavailable')
    expect(notice.body).not.toContain('[object Object]')
  })

  it('标题里有产品名——原生对话框的标题栏是用户判断「谁在说话」的唯一线索', () => {
    expect(startupFailureNotice(new Error('x'), { configPath: CONFIG_PATH }).title).toMatch(
      /AgentMux/
    )
  })
})

// ---------------------------------------------------------------------------
// 第二半：那条失败路径真的调了它。
//
// 判据落在 `exitAfterFailure` 的**函数体**上，而不是整个文件：文件别处出现 `showErrorBox`
// （比如某个 IPC 处理器）不能替这条路径背书。
// ---------------------------------------------------------------------------
describe('exitAfterFailure 真的弹出那个对话框', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

  /**
   * `exitAfterFailure` 的函数体。左界取它自己的声明，右界取**下一个** `function` 声明——
   * 只取左界会让整段一直切到文件末尾，于是邻近函数里的任何 `showErrorBox` 都能让判据通过
   * （见记忆 section-slice-without-right-bound）。
   */
  const bodyOfExitAfterFailure = ((): string => {
    const start = source.indexOf('async function exitAfterFailure(')
    if (start < 0) return ''
    const next = source.indexOf('\n  async function ', start + 1)
    const alsoNext = source.indexOf('\n  function ', start + 1)
    const end = [next, alsoNext].filter((index) => index > 0).sort((a, b) => a - b)[0] ?? source.length
    return source.slice(start, end)
  })()

  it('前提自检：切出来的确实是那个函数体，且没有一直切到文件末尾', () => {
    // 这条先红时，下面两条的失败读起来才不会像「忘了调对话框」。
    expect(bodyOfExitAfterFailure).toMatch(/async function exitAfterFailure\(/)
    expect(bodyOfExitAfterFailure).toMatch(/app\.exit\(1\)/)
    // 右界有效：`buildWindow` 是它后面那个函数，不许被卷进来。
    expect(bodyOfExitAfterFailure).not.toMatch(/buildWindow/)
  })

  it('这条路径上有 showErrorBox——只写 stderr 就是对 GUI 用户静默失败', () => {
    expect(
      bodyOfExitAfterFailure,
      'exitAfterFailure 没有弹原生对话框：从 Finder 启动的用户看到应用闪一下就没了'
    ).toMatch(/dialog\.showErrorBox\(/)
  })

  it('弹的内容来自那个纯函数，而不是就地拼一段新文案', () => {
    // 判据是「用的是同一个取值层」。就地拼串的实现会绕过上面那六条内容断言——文案能对一次，
    // 但下次改动无人守，而且必然与纯函数漂移。
    expect(bodyOfExitAfterFailure).toMatch(/startupFailureNotice\(/)
    expect(bodyOfExitAfterFailure).toMatch(/showErrorBox\(\s*notice\.title\s*,\s*notice\.body\s*\)/)
  })

  it('对话框在清理之前弹——清理可能挂住或抛错，而这是用户唯一的信息来源', () => {
    // 顺序判据：`disposeOwners()` 里任何一个 owner 卡住，都会让「先清理再告知」的实现永远
    // 不弹那个框，症状与完全没有它一字不差。
    const dialogAt = bodyOfExitAfterFailure.indexOf('showErrorBox(')
    const disposeAt = bodyOfExitAfterFailure.indexOf('disposeOwners()')
    expect(dialogAt).toBeGreaterThan(0)
    expect(disposeAt).toBeGreaterThan(0)
    expect(dialogAt, '对话框排在 disposeOwners() 之后：清理一挂住，用户就什么都看不到').toBeLessThan(
      disposeAt
    )
  })

  it('配置文件路径取自 ConfigStore 自己，而不是第二处手抄的 join(...)', () => {
    // 手抄一份路径就会漂移，而漂移的症状是「对话框指着一个不存在的文件」——比不给路径更糟。
    expect(bodyOfExitAfterFailure).toMatch(/configStore\.filePath/)
    expect(bodyOfExitAfterFailure).not.toMatch(/getPath\(/)
  })
})
