import { describe, expect, it } from 'vitest'
import { allStyles, styleFiles } from './helpers/styles.js'

/**
 * 样式表按表面分文件。
 *
 * 2551 行的单文件不是"文件大"的问题，是**找不到东西**的问题：改 Topic 行要先 grep 出它散在
 * 哪几段，改完不知道有没有漏。这里守住拆分之后的形状——尤其是那些一旦破了就悄悄破、
 * 不会有任何行为测试变红的约束。
 */
describe('样式表的组织', () => {
  it('每个表面一个文件，入口按顺序 @import——层叠顺序即文件顺序', () => {
    const files = styleFiles().map((file) => file.name)
    expect(files).toEqual([
      'tokens.css',
      'base.css',
      'chrome.css',
      'dock.css',
      'workbench.css',
      'terminal.css',
      'surfaces.css',
      'browser.css',
      'agent.css',
      'activity.css',
      'overlays.css'
    ])
  })

  it(':root 只有一处，在 tokens.css', () => {
    // 第二个 :root 会让"尺度系统有唯一来源"这句话失效，且两处定义谁赢取决于 @import 顺序——
    // 一个没人会去读的规则决定了全表的颜色。
    for (const { name, text } of styleFiles()) {
      const count = text.split(':root').length - 1
      if (name === 'tokens.css') expect(count).toBeGreaterThan(0)
      else expect(`${name}: ${count} 处 :root`).toBe(`${name}: 0 处 :root`)
    }
    expect(allStyles().split(':root {').length - 1).toBe(1)
  })

  it('单文件不超过 400 行——超出的按表面继续拆，不靠注释分节假装分层', () => {
    const oversized = styleFiles()
      .map(({ name, text }) => ({ name, lines: text.split('\n').length }))
      .filter(({ lines }) => lines > 400)
    expect(oversized.map(({ name, lines }) => `${name} 有 ${lines} 行`)).toEqual([])
  })

  it('没有孤儿文件：每个样式文件都被入口 @import', () => {
    // styleFiles() 自身会在发现未被 @import 的文件时抛错——一个没进入口的样式文件是死文件，
    // 它的规则永不生效，而契约测试会照常扫描它并放行。这里把那条检查变成一条显式断言。
    expect(() => styleFiles()).not.toThrow()
    expect(styleFiles().length).toBeGreaterThan(1)
  })

  it('全表拼起来仍是可扫描的一张表，契约测试因此不会扫到空内容', () => {
    const styles = allStyles()
    expect(styles.length).toBeGreaterThan(100_000)
    // 抽查几个分属不同文件的表面，证明拼接确实覆盖了全部而不是只读到第一个文件。
    expect(styles).toContain('--fs-body')          // tokens
    expect(styles).toContain('.status__dot')       // chrome
    expect(styles).toContain('.workspace-topic-item')  // dock
    expect(styles).toContain('.pane-body__region')     // workbench
    expect(styles).toContain('.activity-ruler')        // activity
  })
})
