import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

// 浮窗在 app-shell 外渲染；自己的字号基准不能退回 UA 的 16px。
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `实际样式规则 ${selector} 必须存在`).toBeGreaterThan(-1)
  const open = css.indexOf('{', start), close = css.indexOf('}', open)
  expect(close).toBeGreaterThan(open)
  const body = css.slice(open + 1, close)
  expect(body.trim().length).toBeGreaterThan(0)
  return body
}

describe('Toolkit Performance 浮窗的字号基准', () => {
  it('显式声明字号，保住 portal 内叶子的排版基准', () => {
    expect(ruleBody(allStyleRules(), '.performance-popover')).toMatch(/font-size:/)
  })
})
