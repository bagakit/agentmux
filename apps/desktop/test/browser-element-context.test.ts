// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  BROWSER_PAGE_CAPABILITIES,
  browserPageCapabilityNames
} from '@agentmux/core'
import {
  buildBrowserElementContextDeclaration,
  buildBrowserElementSelectionScript
} from '../src/main/browser-selection-script.js'
import { sanitizeBrowserElementSelection } from '../src/main/browser-selection.js'

/**
 * Agent 发起的元素上下文，与人工选择的信任边界。
 *
 * 这条能力的**全部风险**在于它长得像「给 isTrusted 开个后门」。所以判据不是"新函数存在"，
 * 而是三件可证伪的事：
 *
 * 1. 人工选择那条路上的 `isTrusted` 门禁**一条没少**，且网页脚本合成的事件真的选不出东西来。
 *    这一条在真 DOM 里跑：合成一次 `click`，看人工选择那个 Promise 有没有 settle。
 * 2. Agent 那条路**不经指针事件**：它的声明里根本没有事件监听，目标由 `this` 给定。
 * 3. 两条路的提取结果**逐字段相同**——共用一份 `extract`，所以同一道脱敏对两边都成立。
 *    这一条也在真 DOM 里跑：同一个元素，两条路各取一次，逐字段比。
 */

/**
 * 把一段 HTML 装进当前 happy-dom 文档，返回那个 window。
 *
 * 用环境自带的 DOM 而不是另起一个：页面脚本里的 `document` / `getComputedStyle` / `CSS.escape`
 * 都取全局，跨 realm 传元素会让 `instanceof Element` 在另一个 realm 里为假——那会让整条判据
 * 变成"恒返回 null"的假绿。
 */
function page(html: string): Window & typeof globalThis {
  document.body.innerHTML = html
  return window as unknown as Window & typeof globalThis
}

describe('Agent 发起的元素上下文', () => {
  it('人工选择的三道 isTrusted 门禁一条没少，且合成事件真的选不出东西', async () => {
    const script = buildBrowserElementSelectionScript(1)
    expect(
      script.match(/if \(!event\.isTrusted\) return;/gu),
      'isTrusted 门禁少了——网页脚本可以伪造一次「人选的」元素'
    ).toHaveLength(3)

    page('<main><button id="go">Go</button></main>')
    // happy-dom 根本没实现 `isTrusted`（实测：`new MouseEvent(...).isTrusted` 是 `undefined`，
    // `Event.prototype` 上连描述符都没有）。这对本条恰好是**更强**的前提：产品代码写的是
    // `if (!event.isTrusted) return`，`undefined` 同样为假，所以这里派发的事件与网页脚本能造的
    // 那种走同一条拒绝分支。前提要断言出来，否则哪天环境补上了 `isTrusted: true`，这条会静默
    // 从「证明了拒绝」变成「什么都没证明」。
    const synthetic = new MouseEvent('click', { bubbles: true })
    expect(
      Boolean((synthetic as { isTrusted?: boolean }).isTrusted),
      '这个环境造出来的事件是 trusted——本条的前提不成立，它证明不了拒绝'
    ).toBe(false)

    const settled: unknown[] = []
    const promise = eval(script) as Promise<unknown> | null
    expect(promise, '选择脚本没有返回 Promise——下面等的东西不存在').not.toBeNull()
    void promise!.then((value) => settled.push(value))

    document.getElementById('go')!.dispatchEvent(synthetic)
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
    // 给微任务一轮机会：真 settle 了的话这一轮就会落进 settled。
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      settled,
      '网页脚本合成的点击选出了一个元素——isTrusted 边界被绕过了'
    ).toEqual([])
  })

  it('Agent 入口不经任何指针事件，目标由调用方的句柄给定', () => {
    const declaration = buildBrowserElementContextDeclaration()
    expect(() => new Function(`return (${declaration})`), '声明不是合法 JS').not.toThrow()

    // 它不监听、不合成、也不读事件——目标只可能来自 `this`。
    for (const forbidden of ['addEventListener', 'dispatchEvent', 'isTrusted', 'composedPath']) {
      expect(declaration, `Agent 入口里出现了 ${forbidden}：它不该碰事件这条路`).not.toContain(forbidden)
    }
    expect(declaration, '目标不是来自调用方给的句柄').toContain('extract(this)')
    // 只读：不点、不填，连滚动都不做（那会挪走人此刻正在看的位置）。
    for (const mutating of ['scrollIntoView', '.click()', 'dispatchEvent', '.focus()']) {
      expect(declaration, `observe 类能力里出现了会改页面的 ${mutating}`).not.toContain(mutating)
    }
  })

  it('两条路读出来的字段逐字段相同，且同一道脱敏对两边都成立', async () => {
    page('<main><p>before</p><button id="go" aria-label="Go now" data-k="v">Go</button><p>after</p></main>')
    const element = document.getElementById('go')!

    // Agent 那条：声明直接在元素上调用，就是 `Runtime.callFunctionOn` 会做的事。
    const agentRaw = eval(`(${buildBrowserElementContextDeclaration()})`).call(element) as Record<string, unknown> | null
    expect(agentRaw, 'Agent 入口对一个真元素返回了 null').not.toBeNull()

    // 人那条：把选择脚本跑起来，用一个 **trusted** 事件让它 settle。这个环境不提供 `isTrusted`，
    // 所以在派发前把那个属性定义上——改的是**这一个事件对象**，不是产品代码里的门禁。
    const promise = eval(buildBrowserElementSelectionScript(2)) as Promise<unknown>
    const trusted = new MouseEvent('click', { bubbles: true })
    Object.defineProperty(trusted, 'isTrusted', { value: true })
    element.dispatchEvent(trusted)
    const humanRaw = await promise
    expect(humanRaw, '带 isTrusted 的真实点击没有选出元素——人工那条路断了').not.toBeNull()

    // 逐字段相同。这是「共用一份 extract」的可证伪形式：任何一侧长出自己的字段都会在这里红。
    expect(
      Object.keys(agentRaw as object).sort(),
      '两条路的字段集不一样了——extract 被复制成了两份'
    ).toEqual(Object.keys(humanRaw as object).sort())
    expect(agentRaw, '同一个元素，两条路读出来的内容不同').toEqual(humanRaw)

    // 同一道脱敏对两边都成立（它按一组固定键 assertExactKeys，多一个少一个都抛）。
    const sanitized = sanitizeBrowserElementSelection(agentRaw)
    expect(sanitized.selector, '脱敏后选择器是空的').not.toBe('')
    expect(sanitized.accessibleName).toBe('Go now')
    // 脱敏层按白名单留属性：`aria-label` / `id` 留下，`data-k` 这种任意 data-* 被丢掉（实测）。
    // 断言两边都写，才说明这条判据知道白名单在起作用，而不是碰巧只问了留下来的那些。
    expect(sanitized.attributes['aria-label'], '白名单里的属性被丢了').toBe('Go now')
    expect(
      sanitized.attributes['data-k'],
      '任意 data-* 属性穿过了脱敏白名单——页面可以借它塞任意内容给 Agent'
    ).toBeUndefined()
    expect(() => sanitizeBrowserElementSelection(humanRaw), '人那条的结果过不了同一道脱敏').not.toThrow()
  })

  it('elementContext 在能力表里是 observe——人接管之后仍然放行', () => {
    const entry = BROWSER_PAGE_CAPABILITIES.find((capability) => capability.name === 'elementContext')
    expect(entry, 'elementContext 不在能力表里——Agent 的脚本里根本没有这个名字').toBeDefined()
    expect(
      entry!.effect,
      'elementContext 被归成了会改页面的类：它只读，人接管之后该继续放行'
    ).toBe('observe')
    expect(browserPageCapabilityNames('observe')).toContain('elementContext')
  })
})
