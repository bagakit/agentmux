import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 占满一格的等待态必须带 scope/phase，不能是一行裸文字。
 *
 * 密度合同 :184 定的规矩：「占满一格终端、一块 Board 的等待态是产品的门面，用通用转圈是把最显眼的
 * 位置让给了最没有信息的图形」；:901 定了落点：「任何新的等待态先复用 `FullPageLoadingSurface`」。
 * 于是「整面在等」这件事有唯一一种表达，且它必须说清自己是 app 级还是 region 级、处在哪个阶段——
 * 这两个事实正是 `scope` 与 `phase`，它们进 DOM（`data-loading-scope` / `data-loading-phase`），
 * 所以下游能按它们分流，而一行 `<span>Loading…</span>` 什么都没交代。
 *
 * 病史（2026-09-25）：`EditorPane` 的 diff 等待与 `WorkspaceWorkbench` 的编辑器 Suspense fallback
 * 都写成 `<section className="pane-state">` 里一行字。两处都占满整格 Region，与 `WorkspaceBoard`
 * 用 `scope="region"` 渲染的那些是同一种形状，只是没走同一条路。当时**没有任何测试会因此变红**：
 * 盘点测试手抄了七个文件名，而这两处不在名单上——名单只能证明它列到的那些，证明不了它漏掉的。
 *
 * 判据从**源码实读**：`.pane-state` 这个类就是「这一格现在被状态占满」的既有标记（样式实读：
 * `height:100%` + 居中列），于是「带 .pane-state 且文案在说等待」就是一处占满一格的等待态。
 * 不手抄名单——名单会和来源一起漂移，漂移那天它自己不会响。
 */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src')

function sourceFiles(): string[] {
  return readdirSync(RENDERER, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => join(RENDERER, entry))
}

/** 这行文字在说「正在等」吗。进行时的等待词，不含 error/empty 这些终局态。 */
const WAITING_COPY = /\b(?:Loading|Restoring|Connecting|Starting|Preparing|Attaching)\b/u

describe('占满一格的等待态', () => {
  /**
   * `.pane-state` 真的占满一格——下面整条判据都建立在这个前提上，所以先把它证了。
   *
   * 不证这一条，「带 .pane-state 就算占满一格」只是一句断言者自己的话；样式改成行内贴片那天，
   * 这份守卫会继续按旧前提判，而它自己不会响。
   */
  it('前提自检：.pane-state 的样式确实是占满一格的居中状态层', () => {
    const workbench = readFileSync(join(RENDERER, 'styles', 'workbench.css'), 'utf8')
    const rule = /(?:^|\n)\.pane-state\s*\{([^}]*)\}/u.exec(workbench)
    expect(rule, '.pane-state 的规则没扫到——这份守卫的前提没被证实，整条判据在空转').not.toBeNull()
    expect(rule![1], '.pane-state 不再占满高度，「占满一格」这个前提不成立了').toMatch(/height:\s*100%/u)
    expect(rule![1]).toMatch(/justify-content:\s*center/u)
  })

  /**
   * 每一处占满一格的等待都走共用表面。
   *
   * 判据落在**同一个 JSX 元素**上：`.pane-state` 的那个标签开到它自己闭合为止，等待词必须出现在
   * 这一段里。整文件 grep 会把同文件别处的 "Loading" 算进来（`EditorPane` 里就有一个按钮文案
   * `'Loading…' : 'Refresh'`，那是行内忙碌信号，本就该用 `.spin`）。
   */
  it('没有哪一格用一行裸文字充当整面的等待态', () => {
    const offenders: string[] = []
    let paneStates = 0
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/<(section|div)[^>]*className=\{?["'`][^"'`]*\bpane-state\b[^"'`]*["'`][^>]*>/gu)) {
        paneStates += 1
        const open = match.index!
        // 取到这个元素的闭合标签为止；取不到就退回整段剩余源码（宁可多判，不可判空）。
        const close = source.indexOf(`</${match[1]}>`, open)
        const body = source.slice(open, close === -1 ? source.length : close)
        if (WAITING_COPY.test(body)) {
          offenders.push(`${file.slice(RENDERER.length + 1)}: ${body.replace(/\s+/gu, ' ').slice(0, 90)}`)
        }
      }
    }
    // 非空见证：一处 .pane-state 都没扫到，下面那条 toEqual([]) 就是恒真的白绿。
    expect(paneStates, '一处 .pane-state 都没扫到——这份扫描在空转').toBeGreaterThan(0)
    expect(
      offenders,
      '这些地方用一行裸文字占满了整格来表示"在等"。整面的等待要走 FullPageLoadingSurface，' +
        '由它交代 scope 与 phase；行内的忙碌信号才用 .spin：\n' + offenders.join('\n')
    ).toEqual([])
  })

  /**
   * 反过来的一半：共用表面的每一次调用都交代了 scope 与 phase。
   *
   * 少了这一半，上面那条可以靠「把 FullPageLoadingSurface 的 scope 改成可选」来满足——形状对了、
   * 事实没了。两个 prop 都是 union 且必填，tsc 会挡住删掉它们，但挡不住有人给它们加默认值：
   * 默认值会让「没想清楚这是 app 还是 region」静默通过，而这正是这两个字段存在的理由。
   */
  it('共用表面的每一次调用都说清了 scope 与 phase', () => {
    const definition = join(RENDERER, 'components', 'FullPageLoadingSurface.tsx')
    const calls: string[] = []
    for (const file of sourceFiles()) {
      if (file === definition) continue
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/<FullPageLoadingSurface\b([\s\S]*?)(?:\/>|>)/gu)) {
        const props = match[1]!
        const where = `${file.slice(RENDERER.length + 1)}: ${props.replace(/\s+/gu, ' ').slice(0, 70)}`
        if (!/\bscope=/u.test(props) || !/\bphase=/u.test(props)) calls.push(where)
      }
    }
    // 非空见证：这条与上一条共享扫描面，但它数的是调用点——零调用点同样让 toEqual([]) 恒真。
    const total = sourceFiles()
      .filter((file) => file !== definition)
      .reduce((sum, file) => sum + [...readFileSync(file, 'utf8').matchAll(/<FullPageLoadingSurface\b/gu)].length, 0)
    expect(total, '一处 FullPageLoadingSurface 调用都没扫到——这条判据在空转').toBeGreaterThan(0)
    expect(calls, `这些调用没说清自己是 app 级还是 region 级、或处在哪个阶段：\n${calls.join('\n')}`).toEqual([])

    // scope/phase 不许有默认值：有默认值等于"没想清楚也能过"。
    const component = readFileSync(definition, 'utf8')
    expect(component, 'phase 有了默认值，调用方不再被迫交代阶段').not.toMatch(/\bphase\s*=\s*['"]/u)
    expect(component, 'scope 有了默认值，调用方不再被迫交代 app/region').not.toMatch(/\bscope\s*=\s*['"]/u)
  })
})
