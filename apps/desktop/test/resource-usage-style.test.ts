import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

/**
 * 资源面板的排版对齐。
 *
 * 这条守的是一个不会让任何行为测试变红、只有肉眼能看见的洞：面板经 Radix Portal 挂到
 * `document.body`，落在 `.app-shell` 之外，而全站没有一处基准 `font-size`（`:root` 只设
 * `font-family`）。于是 `.resource-usage__name` / `__metric` / 空态 / app 行——它们自己都没写
 * `font-size`——会继承 UA 默认的 16px，把 Agent 名和读数撑到比同一行 10px 的标签大出一号，
 * 与花名册（identity 11px）当场不齐。修法是在容器 `.resource-usage` 上给一档基准。
 *
 * 判据读的是**规则**（allStyleRules 已剥注释），不是散文：把这条 font-size 删掉即红。
 */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`样式表里找不到 ${selector} 的规则——选择器改名了？`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('资源面板的字号基准', () => {
  it('.resource-usage 容器声明了 font-size——否则 portal 外的叶子继承 16px', () => {
    // name/metric/empty/app 都不各自写 font-size，全靠容器这一档兜底。删掉它 = 回到 16px 不齐。
    expect(ruleBody(allStyleRules(), '.resource-usage')).toMatch(/font-size:/)
  })
})
