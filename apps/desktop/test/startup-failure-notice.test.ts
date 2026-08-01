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
// 第二半（那条失败路径真的调它）不在这个文件里，见 `startup-failure-exit.test.ts`。
//
// 原先它在这里，判据落在 `index.ts` 里 `exitAfterFailure` 的函数体文本上。那族有一个盲点被实测
// 坐实：在函数体第一行插一句 `if (configStore) return`，整条通知路径变成 no-op 而 11 条全绿
// （记忆 grep-guard-cannot-see-early-return）。文本看不见执行。
//
// 修法是把序列抽成 `startup-failure-exit.ts` 的可注入纯函数，于是那五条判据各自升级：
//
//   有 showErrorBox      → 行为断言：真的调了，且弹的内容与本文件这个纯函数 toEqual
//   内容来自纯函数        → 同上（原来是「文本里有 startupFailureNotice(」）
//   对话框在清理之前      → 行为断言：让 disposeOwners 真的永不 settle，看框有没有弹出来
//   路径取自 ConfigStore  → 接线层文本断言，原样保留
//   切片前提自检          → 新文件有它自己的
//
// 而壳被压成一句表达式（没有语句可插），那个早退变异因此无处落脚。
// ---------------------------------------------------------------------------
