import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 每一条通往 `sessionRecentActivity` 的路都必须带上仓根。
 *
 * 这条派生的返回值会被 CSS `text-overflow: ellipsis` 再截一刀，而 CSS 的省略号永远吃**尾巴**——
 * 也就是路径里唯一有识别力的那一头（文件名）。所以「传不传根」不是排版偏好：不传，这行字在窄面板上
 * 就只剩一串各行雷同的前缀。三个消费面各自落在带 ellipsis 的选择器里：
 * `.resource-usage__activity`、`.project-activity-menu__reason`、
 * `.project-activity-group__identity small`。
 *
 * **为什么不只扫 `sessionRecentActivity(` 本身。** 第一版就是那么写的，然后没抓到它唯一该抓的东西：
 * `ProjectActivity.tsx` 里有个模块私有的小包装 `sessionReason(session, timelines, workspaceRoot?)`，
 * 它自己总是把收到的根转交下去，所以那一行永远合规；真正漏根的是**包装的调用方**。把漏传改回去
 * 跑一遍，第一版全绿——一条守不住自己那个 bug 的守卫，比没有守卫更坏，因为它看起来守住了。
 * 所以这里连**同一文件内、形参可选的转发包装**一起收进扫描面：先找出所有把 workspaceRoot 转交给
 * 这条派生的函数，再要求它们的每个调用点也把根填上。
 *
 * 之所以不改成「让 workspaceRoot 变成必填形参」（那样 tsc 就能挡）：这个派生也服务于**不属于任何
 * 仓库**的 Session（未绑定的终端、scratch），对它们没有根可传，必填会逼调用方编一个假值出来。
 * 形参保持可选、路径全数守住——这是把「可以缺席」和「今天恰好谁都不该缺席」分开。
 */
describe('通往 sessionRecentActivity 的每条路都带上仓根', () => {
  const SOURCES = [
    'apps/desktop/src/renderer/src/components/ProjectActivity.tsx',
    'apps/desktop/src/renderer/src/lib/project-activity-row.ts',
    'apps/desktop/src/renderer/src/lib/resource-usage-panel.ts'
  ]

  /** 一次调用的实参文本——从 `<name>(` 起按括号配平读到闭括号。 */
  const callArguments = (source: string, name: string): string[] => {
    const calls: string[] = []
    const needle = `${name}(`
    for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
      // 跳过 `function foo(` / `const foo = (` 这类**声明**，只收调用。
      const before = source.slice(0, at).trimEnd()
      if (before.endsWith('function')) continue
      let depth = 0
      for (let cursor = at + needle.length - 1; cursor < source.length; cursor += 1) {
        if (source[cursor] === '(') depth += 1
        else if (source[cursor] === ')') {
          depth -= 1
          if (depth === 0) {
            calls.push(source.slice(at + needle.length, cursor))
            break
          }
        }
      }
    }
    return calls
  }

  /** 顶层逗号才算分隔：实参本身可能含 `a[b] ?? c(d, e)` 这种带括号的表达式。 */
  const argumentCount = (call: string): number => {
    if (!call.trim()) return 0
    let depth = 0
    let count = 1
    for (const character of call) {
      if ('([{'.includes(character)) depth += 1
      else if (')]}'.includes(character)) depth -= 1
      else if (character === ',' && depth === 0) count += 1
    }
    return count
  }

  /**
   * 本文件内把 workspaceRoot 转交给这条派生的私有包装名。形状：函数体里调了
   * `sessionRecentActivity(`，且自己声明了一个可选的 workspaceRoot 形参——正是那种「自己永远合规、
   * 把漏传推给调用方」的中间层。
   */
  const forwarderNames = (source: string): string[] =>
    [...source.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/gs)]
      .filter(([, , parameters]) => /workspaceRoot\??\s*:/.test(parameters))
      .map(([, name]) => name)
      .filter((name) => name !== 'sessionRecentActivity')

  it('自检 1：扫描面找得到那三个直接调用点——否则下面的断言会恒真', () => {
    const found = SOURCES.flatMap((path) => callArguments(readFileSync(path, 'utf8'), 'sessionRecentActivity'))
    expect(found.length, `只找到 ${found.length} 个直接调用点，扫描面可能已经失效`).toBe(3)
  })

  it('自检 2：转发包装这一层真的被识别出来了——它是第一版漏掉的那一层', () => {
    // 这条钉住的是上面注释讲的那次失手：若 forwarderNames 因为改名/改形状而识别不到任何包装，
    // 主断言就退化回第一版，而第一版是放过真 bug 的。
    const source = readFileSync('apps/desktop/src/renderer/src/components/ProjectActivity.tsx', 'utf8')
    expect(forwarderNames(source), 'ProjectActivity 里那个私有转发包装没被识别到').toContain('sessionReason')
  })

  it('直接调用与经由转发包装的调用，都没有漏掉仓根', () => {
    const offenders: string[] = []
    for (const path of SOURCES) {
      const source = readFileSync(path, 'utf8')
      for (const call of callArguments(source, 'sessionRecentActivity')) {
        if (argumentCount(call) < 3) offenders.push(`${path}: sessionRecentActivity(${call.trim()})`)
      }
      for (const forwarder of forwarderNames(source)) {
        for (const call of callArguments(source, forwarder)) {
          if (argumentCount(call) < 3) offenders.push(`${path}: ${forwarder}(${call.trim()})`)
        }
      }
    }
    expect(
      offenders,
      '这些调用点没传仓根——它们的输出会被 CSS 从尾巴剪掉，而尾巴正是文件名'
    ).toEqual([])
  })
})
