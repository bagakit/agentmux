import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

/**
 * 终端链接悬停预览（.terminal-link-preview）被刻意压平了：用户原话「那个 hover 组件的样式不好看，
 * 可以调整成更加平面风格，且不要看起来那么像个按钮」。压平删掉了顶部高光/受光面渐变/菜单入场——
 * 那些都是纯品味，不需要测试钉死。这里只守两条一旦破了就**悄悄**破、不会有任何行为测试变红、
 * 且用户直接可见的性质：
 *   1. pointer-events:none —— 它是 role=tooltip 的被动读出，不能吃掉指针；一旦退回 auto，
 *      这块浮层会挡住它自己解释的那个链接，点击落空，而外观毫无变化。
 *   2. 与终端仍有分离 —— 填充是半透明的 --overlay-surface，浮在任意终端内容之上（深底/浅底都有），
 *      分离全靠 box-shadow 那圈描边；描边被删掉后，遇到同色终端输出就糊在一起看不出边界。
 * 判据读剥注释后的样式（allStyleRules），否则本段自己的解释性注释里出现的 token 名会把
 * not.toContain 蹭绿（见 helpers/styles.ts stripCssComments 的教训）。
 */

/** .terminal-link-preview 那条规则体——切到它第一个变体选择器之前为止。 */
function previewRule(): string {
  const styles = allStyleRules()
  const start = styles.indexOf('.terminal-link-preview {')
  const end = styles.indexOf(".terminal-link-preview[data-placement", start)
  if (start < 0 || end < 0) throw new Error('链接预览样式段找不到了——这个读取器要跟着改')
  return styles.slice(start, end)
}

describe('终端链接预览：压平后仍守住的性质', () => {
  it('扫描面非空——扫到的是真的规则体，不是空串', () => {
    // 扫空的检查会全绿地什么也不说（记忆 false-green-gate-patterns）。
    const rule = previewRule()
    expect(rule).toContain('border-radius')
    expect(rule.length).toBeGreaterThan(80)
  })

  it('保持 pointer-events:none——被动 tooltip 不吃点击', () => {
    expect(previewRule()).toContain('pointer-events: none')
  })

  it('仍有 box-shadow 作为与终端的分离——平不等于隐形', () => {
    // 只判「有阴影」这个性质，不钉具体是 elev-1 还是 elev-2：压得更平可以换更浅的阴影，
    // 但完全删掉阴影就失去了在任意终端底色上的边界。
    expect(previewRule()).toMatch(/box-shadow:\s*[^;]+;/)
  })
})
