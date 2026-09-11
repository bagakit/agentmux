import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

/**
 * 「agent 操作浏览器的轨迹……放到左侧或右侧，用更能表达 trace 的风格」的判据。
 *
 * 这条判据守的是**位置**，而位置在这个表面上不是审美问题，是可见性问题：`.browser-stage`
 * 里落的是原生 WebContentsView，它在窗口层合成，盖在**所有** renderer 像素之上。把轨迹画进
 * stage 里，它会被原生视图整块吃掉——DOM 在、类名在、样式在，屏幕上什么都没有。所以
 * 「rail 是 stage 的兄弟，不是它的后代」是这块能不能被看见的全部条件。
 *
 * 判据走 TS 词法器而不是切字符串：`indexOf('<div className="browser-body"')` 一旦锚点改名就切出
 * 空串，之后每条 `not.toContain` 恒真（记忆 indexof-anchor-gone-slices-to-empty-string）。
 * 这里问的是树上的父子关系，就按树来问。
 */

const source = (() => {
  const text = readFileSync(
    new URL('../src/renderer/src/components/BrowserPane.tsx', import.meta.url),
    'utf8'
  )
  return ts.createSourceFile('BrowserPane.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
})()

/** 带这个 className 字面量的 JSX 元素（开标签本身）。找不到返回 null，由调用方判红。 */
function elementWithClass(className: string): ts.JsxElement | null {
  let found: ts.JsxElement | null = null
  const walk = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const attribute = node.openingElement.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText(source) === 'className'
      )
      const initializer = attribute?.initializer
      if (initializer && ts.isStringLiteral(initializer) && initializer.text === className) found = node
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

/** node 是不是 ancestor 的后代（严格后代，不含自身）。 */
function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current === ancestor) return true
  }
  return false
}

describe('Browser 轨迹占页面一侧的竖向 rail', () => {
  const stage = elementWithClass('browser-stage')
  const rail = elementWithClass('browser-trace-rail')
  const body = elementWithClass('browser-body')

  it('三块都在树上——锚点没了的话下面每一条都在问空气', () => {
    expect(stage, 'BrowserPane 里找不到 .browser-stage——原生视图的落点换了地方').not.toBeNull()
    expect(rail, 'BrowserPane 里找不到 .browser-trace-rail——轨迹 rail 没了或改了名').not.toBeNull()
    expect(body, '找不到把 stage 与 rail 装在一起的那层容器').not.toBeNull()
  })

  it('rail 不在 stage 里面——在里面会被原生视图整块吃掉，DOM 在而屏幕上没有', () => {
    // 这是这条判据最要害的一句。原生 WebContentsView 在窗口层合成，盖在所有 renderer 像素之上，
    // z-index 对它无效。轨迹一旦成为 stage 的后代，它在测试里照样「渲染出来了」，在屏幕上却
    // 永远看不见——而没有任何行为断言会红。
    expect(isDescendantOf(rail!, stage!), '轨迹 rail 落在 .browser-stage 里，会被原生视图盖住').toBe(false)
  })

  it('rail 与 stage 是同一层容器下的兄弟——让出的是横向空间，不是盖在页面上', () => {
    expect(isDescendantOf(stage!, body!), 'stage 不在 .browser-body 里，那层横向容器没接上').toBe(true)
    expect(isDescendantOf(rail!, body!), 'rail 不在 .browser-body 里，它没跟 stage 排在同一行').toBe(true)
  })

  it('stage 仍是原生 bounds 的量取点——rail 挤窄它，原生视图才跟着收', () => {
    // 几何一行没改：bounds 取自 stage 的 getBoundingClientRect + ResizeObserver（见
    // browser-pane-resize.test.tsx）。这条只钉「量的还是 stage 那个盒子」，因为一旦改成量
    // .browser-body，rail 让出的那条带会被重新算进原生视图里，页面又盖回轨迹上。
    const text = source.getFullText()
    const observed = [...text.matchAll(/observer\.observe\((\w+)\)/g)].map((match) => match[1])
    expect(observed, '没有任何 ResizeObserver 在观察 stage').toContain('stage')
  })
})

describe('竖向 rail 的形状', () => {
  const css = allStyleRules()

  it('装 stage 与 rail 的那层是横向 flex——这是「让出横向空间」的实现', () => {
    const rule = css.match(/\.browser-body\s*\{([^}]*)\}/)
    expect(rule, '样式表里没有 .browser-body 规则——rail 会掉回纵向堆叠').not.toBeNull()
    expect(rule![1]).toContain('display: flex')
    // 不写 flex-direction 就是 row，row 正是要的；写了 column 则整条判据失效。
    expect(rule![1], '.browser-body 被写成了纵向堆叠，轨迹又回到页面下方了').not.toContain('column')
  })

  it('rail 有自己的宽度且不被挤没——没有宽度的 rail 读不成一条轨迹', () => {
    const rule = css.match(/\.browser-trace-rail\s*\{([^}]*)\}/)
    expect(rule, '样式表里没有 .browser-trace-rail 规则').not.toBeNull()
    expect(rule![1], 'rail 没有 flex-basis，会被 stage 挤成一条缝').toMatch(/flex:\s*0\s+0\s+/)
    expect(rule![1], 'rail 不能纵向滚动，长轨迹会把它撑破').toContain('overflow-y: auto')
  })

  it('rail 里几段是一条连续的脊，不是三张摞起来的卡片', () => {
    // 用户要的是「更能表达 trace 的风格」。三块各带外框圆角摞在一起读起来是三个盒子；
    // 去掉各自的框、只留一条分界发丝线，竖读下来才是一条轨迹。
    expect(css, 'rail 里的各段还带着自己的外框').toMatch(/\.browser-trace-rail > \*\s*\{[^}]*border:\s*0/)
    expect(css, '段与段之间没有分界线，会糊成一块').toMatch(/\.browser-trace-rail > \* \+ \*\s*\{[^}]*border-top/)
  })
})
