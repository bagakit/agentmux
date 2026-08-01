import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { bumpWorkspaceFileRevision } from '../src/renderer/src/lib/file-workbench-state.js'

// ---------------------------------------------------------------------------
// 文件树的失效计数器：每个「往 Workspace 里写文件」的面都必须让它前进。
//
// 这个派生原先在 store.ts 里逐字手抄了 5 份（保存 scratch 文档 / 建 topic / 改 topic 标题 /
// 建笔记 / 启动 scratch topic 的 agent），横跨 documents、scratch、sessions 三个关注组。
// 抄得多不是问题本身——问题是漏抄**完全静默**：文件在盘上、树自信地是旧的，新文件要等别的
// 写入面碰巧 bump 才出现。同一形状已经在 #266 复审里被抓到过一次（当时是把自增写成常量 1）。
// ---------------------------------------------------------------------------
describe('bumpWorkspaceFileRevision', () => {
  it('没有记录时从 1 起步，而不是留在 undefined', () => {
    // 缺省必须落到一个**具体数字**：留 undefined 或 NaN 会让下游的相等比较永远为假，
    // 树于是每帧都认为自己过期——与漏 bump 相反的方向，但同样是坏的。
    expect(bumpWorkspaceFileRevision({}, 'workspace')).toEqual({ workspace: 1 })
  })

  it('已有记录时前进一格（不是重置成 1，也不是恒等于 1）', () => {
    // 写成常量 1 与正确实现在**第一次**调用上完全无法区分，所以这里从 7 起判。
    expect(bumpWorkspaceFileRevision({ workspace: 7 }, 'workspace')).toEqual({ workspace: 8 })
  })

  it('只动目标 Workspace，别人的计数原样保留', () => {
    // 顺带把别人的清掉，症状是另一个项目的文件树无端全量刷新（性能问题，且看起来像闪烁）。
    const before = { a: 3, b: 5 }
    expect(bumpWorkspaceFileRevision(before, 'b')).toEqual({ a: 3, b: 6 })
  })

  it('不就地改传入的对象——zustand 靠引用变化判重渲染', () => {
    // 就地改会让 set() 拿到同一个引用：值对了，订阅者却收不到通知，于是树还是不刷新。
    // 这一条与上面三条判的是不同的事，不能靠它们蕴含。
    const before = { workspace: 2 }
    const after = bumpWorkspaceFileRevision(before, 'workspace')
    expect(before).toEqual({ workspace: 2 })
    expect(after).not.toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 上面测的是「这个函数算得对」。下面这条测的是「store 里没人绕过它自己手写一遍」——
// 清理本身不是交付物，能挡住下一份手抄的检测器才是。没有这条，第六个写入面照旧会
// 复制粘贴出第六份，而那时上面四条仍然全绿。
// ---------------------------------------------------------------------------
describe('store 只经由这个函数改失效计数', () => {
  const store = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')

  /**
   * 手抄那份长这样（空白可任意）：
   *   [workspace.id]: (current.workspaceFileRevisions[workspace.id] ?? 0) + 1
   * 判据落在**取下标再自增**这个动作上，而不是某个具体的变量名——换个变量名照样是手抄。
   */
  const handWrittenBump = /workspaceFileRevisions\s*\[[^\]]+\]\s*\?\?\s*0\s*\)?\s*\+\s*1/

  it('前提自检：这个正则真的认得那份手抄，不是一个恒不匹配的死判据', () => {
    // 没有这条，把正则写错（比如多一个字符）会让整条守卫静默变成恒绿。
    // 样本就是被删掉的那份原文。
    const removed = '[workspace.id]: (current.workspaceFileRevisions[workspace.id] ?? 0) + 1'
    expect(handWrittenBump.test(removed)).toBe(true)
  })

  it('store.ts 里没有手写的自增', () => {
    expect(store).not.toMatch(handWrittenBump)
  })

  it('前提自检：store 确实是从这个 lib 导入的，判据没有挂在空处', () => {
    // 判 import 关系而不是判裸标识符出现过：一个同名的本地函数能骗过后者
    // （store.ts 有 4000 行，本地重定义一个同名 helper 完全不显眼），
    // 而那样一来「唯一入口」就又变成两个了。
    expect(store).toMatch(
      /import\s*\{[^}]*\bbumpWorkspaceFileRevision\b[^}]*\}\s*from\s*'\.\/lib\/file-workbench-state'/s
    )
  })

  it('五个写入面都还在调它', () => {
    // 数调用次数是刻意的：上面那条 not.toMatch 只证明「没有手抄」，
    // 把某个面的 bump 整行删掉同样能满足它——那正是漏 bump 的原样子。
    // 五个面 = 保存 scratch 文档 / 建 topic / 改 topic 标题 / 建笔记 / 启动 scratch agent。
    // 这条守不住「新增第六个面却忘了 bump」（没有任何文本判据能守住那个），
    // 但守得住「已有的五个被悄悄拆掉一个」。
    expect(store.split('bumpWorkspaceFileRevision(').length - 1).toBe(5)
  })
})
