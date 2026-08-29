// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { SelectorPresence } from '../src/renderer/src/components/SelectorList.js'
import { AGENT_DISPLAY_STATES } from '../src/renderer/src/lib/attention-vocabulary.js'
import { allStyleRules } from './helpers/styles.js'

/**
 * 守的缺陷：**不可点的头像宣传自己可点**。
 *
 * `AgentAvatar` 是多态的——`const Element = onOpen ? 'button' : 'span'`，没有 `onOpen` 那支退成
 * `role="img"` 的 `<span>`（Branch 行按 provider 归并的那一摞就是这支：整行才是按钮，头像只是身份）。
 * 而 dock.css 从前把交互观感写在**裸** `.agent-avatar` 上：`cursor: pointer`、`:hover` 换底色抬阴影、
 * `:active` 位移。于是指针移到一枚点不动的方块上，光标变成手型、底色亮起——它承诺了一个不存在的动作。
 * 这不是审美问题：指针形状是「这里能点」在 Web 上唯一的通用约定，说谎的那一格会把用户的点击引到
 * 空处，而整行的打开按钮明明就在它下面。
 *
 * 判据不是「某个选择器字符串在不在场」。文本判据在这里有两条已知的绕法，本仓都栽过：
 *   - 子串命中：`.agent-avatar` 是 `button.agent-avatar` 的子串，`toContain('.agent-avatar:hover')`
 *     对修好后的样式表照旧为真（记忆 word-boundary-matches-at-hyphen 的同族）。
 *   - 换拼法：`span.agent-avatar, button.agent-avatar` 或 `.agent-avatar:not(span)` 都能重新把手型
 *     还给静态头像，而任何禁止清单都数不全这些拼法（记忆 forbidden-list-guard-always-leaks）。
 *
 * 所以判据是**真选择器匹配**：把两支形状都真渲染出来，用 `Element.matches()` 逐条问真实样式表里的
 * 每一条 `.agent-avatar` 规则「你选不选得中这枚静态头像」。选择器语义由 happy-dom 的引擎回答，不由
 * 我这边的正则回答——换任何等价拼法都会被同样地判到。
 *
 * 交互伪类（`:hover` / `:active` / `:focus*`）在 DOM 里没有指针可模拟，`matches()` 对它们恒假，所以
 * 先把伪类从选择器上摘掉再问「这条规则的**主语**是谁」。摘掉之后 `.agent-avatar:hover` 变回
 * `.agent-avatar`（静态头像命中→违规），`button.agent-avatar:hover` 变回 `button.agent-avatar`
 * （静态头像不命中→合规）。这正是要区分的那一对。
 */

const INTERACTIVE_PSEUDO = /:(?:focus-within|focus-visible|hover|active|focus)/gu
/**
 * 焦点伪类要单独拿出来，因为它回答的**不是**同一个问题。
 *
 * `:hover` / `:active` 与 `cursor: pointer` 画的是「点我会发生事」——静态头像点不动，画上去就是
 * 说谎。`:focus-visible` 画的是「键盘现在停在我这里」，而静态头像**确实**能被键盘停住：
 * `bcd94ac3` 给它加了无条件的 `tabIndex={0}`，`onFocus` 打开身份面板，于是它是一个真的键盘可达
 * 控件。这时候没有焦点环才是缺陷——密度合同要求「每个图标按钮必须有 tooltip、`aria-label` 和
 * 可见键盘 focus」。
 *
 * 所以焦点环不进"承诺可点"那一族。它另有守卫：下面那条「键盘可达就必须画得出焦点」。
 */
const FOCUS_PSEUDO = /:(?:focus-within|focus-visible|focus)(?![\w-])/u

/** 一条 CSS 规则：选择器与规则体，都压成单行便于报错时读。 */
interface Rule {
  readonly selector: string
  readonly body: string
}

/**
 * 整张样式表里点名了 `agent-avatar` 的规则。
 *
 * 走 `allStyleRules()`（已剥注释）而不是 `allStyles()`：一条规则的**理由注释**里往往逐字写着它自己的
 * 选择器，不剥注释的话，散文会冒充规则被这里收进来，于是把规则删掉也照旧「在场」。
 */
function avatarRules(): Rule[] {
  return [...allStyleRules().matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map(([, selector, body]) => ({
      selector: selector!.replace(/\s+/gu, ' ').trim(),
      body: body!.replace(/\s+/gu, ' ').trim()
    }))
    .filter((rule) => rule.selector.includes('agent-avatar'))
}

/**
 * 这条规则画的是不是「可以点我」。
 *
 * 两个来源，缺一不可：**指针形状**（`cursor: pointer` 直接就是那句承诺，它写在无伪类的基础规则上）
 * 与**指针伪类**（`:hover`/`:active` 的整条规则按定义只在指针落上来时才生效，画的就是
 * 「你碰到我了」的反馈）。只取其一都会漏：只看 cursor 会放过 hover 换底色，只看伪类会放过基础规则里
 * 那句 `cursor: pointer`——而后者正是这次的缺陷本体。
 *
 * 焦点伪类**不在**这一族，理由见 `FOCUS_PSEUDO`：它说的是键盘停在哪，不是点了会怎样。
 */
function promisesInteraction(rule: Rule): boolean {
  if (FOCUS_PSEUDO.test(rule.selector)) return false
  INTERACTIVE_PSEUDO.lastIndex = 0
  return INTERACTIVE_PSEUDO.test(rule.selector) || /cursor:\s*pointer/u.test(rule.body)
}

/** 摘掉交互伪类，露出这条规则的**主语**——`matches()` 才问得动。 */
function subjectOf(member: string): string {
  INTERACTIVE_PSEUDO.lastIndex = 0
  return member.replace(INTERACTIVE_PSEUDO, '').trim()
}

let container: HTMLDivElement
let root: Root
let sheet: HTMLStyleElement

/** 静态头像（`role="img"` 的 span）与可点头像（button），每个状态各一枚。 */
interface Shapes {
  readonly quiet: HTMLElement[]
  readonly interactive: HTMLElement[]
}

/**
 * 两支形状都真渲染。逐状态各来一枚，而不是只渲染一个状态：状态类参与选择器
 * （`.agent-avatar.status--working:hover` 只选中 working/running），只渲染一枚 idle 头像会让那条规则
 * 谁也匹配不上，于是「它选不选得中静态头像」这个问题恒答否——一条真把手型还给静态头像的
 * `.agent-avatar.status--working:hover` 会被漏掉。
 */
async function renderBothShapes(): Promise<Shapes> {
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement(SelectorPresence, {
          // 无 onOpen：退成 role="img" 的 span，也就是 Branch 行归并出来的那一摞。
          agents: AGENT_DISPLAY_STATES.map((state) => ({
            key: `quiet-${state}`,
            providerId: 'codex' as const,
            label: state,
            state
          })),
          max: AGENT_DISPLAY_STATES.length
        }),
        createElement(SelectorPresence, {
          agents: AGENT_DISPLAY_STATES.map((state) => ({
            key: `live-${state}`,
            providerId: 'codex' as const,
            label: state,
            state,
            onOpen: () => {}
          })),
          max: AGENT_DISPLAY_STATES.length
        })
      )
    )
  )
  const all = [...container.querySelectorAll<HTMLElement>('.agent-avatar')]
  return {
    quiet: all.filter((element) => element.tagName === 'SPAN'),
    interactive: all.filter((element) => element.tagName === 'BUTTON')
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  sheet = document.createElement('style')
  sheet.textContent = allStyleRules()
  document.head.append(sheet)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  sheet.remove()
})

describe('点不动的头像不许宣传自己可点', () => {
  it('自检：两支形状都真渲染出来了，且静态那支确实是 role="img" 的非按钮', async () => {
    // 前提自检。下面两条都是「对每一枚静态头像……」的全称判断，静态头像一枚都没渲染出来时它们空转
    // 恒真（记忆 false-green-gate-patterns）。这条把那个前提钉住：两支都在场、枚数等于状态数、
    // 静态那支不是按钮。
    const { quiet, interactive } = await renderBothShapes()
    expect(quiet.length, '静态头像一枚都没渲染出来——下面的全称判断已经恒真').toBe(
      AGENT_DISPLAY_STATES.length
    )
    expect(interactive.length, '可点头像一枚都没渲染出来').toBe(AGENT_DISPLAY_STATES.length)
    for (const element of quiet) {
      expect(element.getAttribute('role')).toBe('img')
      expect(element.tagName).not.toBe('BUTTON')
    }
    for (const element of interactive) expect(element.tagName).toBe('BUTTON')

    // 样式表真被挂进文档了，否则计算值那条测的是一张空表。
    expect(avatarRules().length, '样式表里一条 agent-avatar 规则都没有——判据落空').toBeGreaterThan(0)
  })

  it('每一条画交互的规则都选不中静态头像', async () => {
    const { quiet, interactive } = await renderBothShapes()
    const rules = avatarRules().filter(promisesInteraction)
    // 自检：一条画交互的规则都没找到时，下面的循环空转。真实样式表里至少有 cursor 那条与几条
    // :hover——为零说明提取器坏了或扫描面走空，而不是"样式表很干净"。
    expect(rules.length, '一条画交互的 agent-avatar 规则都没提取到——提取器坏了').toBeGreaterThan(0)

    const offenders: string[] = []
    // 至少有一条画交互的规则真的选中了可点头像。没有这一条，把整段交互样式删光（静态头像自然也就
    // 不再被选中）会让上面的 offenders 为空而全绿——「谁也不承诺」和「只对按钮承诺」是两回事，
    // 而前者意味着可点的头像也不再有手型。
    let reachesInteractive = false
    for (const rule of rules) {
      for (const member of rule.selector.split(',')) {
        if (!member.includes('agent-avatar')) continue
        const subject = subjectOf(member)
        if (quiet.some((element) => element.matches(subject))) {
          offenders.push(`${subject}  {${rule.body}}`)
        }
        if (interactive.some((element) => element.matches(subject))) reachesInteractive = true
      }
    }
    expect(
      offenders,
      '这些规则把「可以点我」画到了 role="img" 的静态头像上——它点不动，指针形状/悬停反馈在说谎'
    ).toEqual([])
    expect(reachesInteractive, '没有任何交互规则选中可点头像——手型和悬停反馈被整段删掉了').toBe(true)
  })

  it('键盘停得下来的头像都画得出焦点环', async () => {
    // 上一条把焦点伪类从"承诺可点"里摘了出去。摘出去不能等于不守——否则收窄判据就成了删覆盖：
    // 把 `.agent-avatar:focus-visible` 整条删掉，上一条会更绿，而键盘用户从此看不见自己在哪。
    //
    // 判据从**元素自己**来，不从形状来：凡是键盘停得下来的（`tabIndex >= 0`，今天静态与可点两支
    // 都是），就必须有一条焦点规则选得中它。静态头像可聚焦是 `bcd94ac3` 的决定——它的 `onFocus`
    // 打开身份面板，不给焦点环就等于有一个看不见的落脚点。
    const { quiet, interactive } = await renderBothShapes()
    const focusRules = avatarRules().filter((rule) => FOCUS_PSEUDO.test(rule.selector))
    // 自检：一条焦点规则都没提取到时，下面的循环会对着空集合恒真。
    expect(focusRules.length, '一条 agent-avatar 的焦点规则都没提取到——提取器坏了或规则被删光').toBeGreaterThan(0)

    const focusable = [...quiet, ...interactive].filter((element) => {
      const index = element.getAttribute('tabindex')
      return element.tagName === 'BUTTON' ? index !== '-1' : index !== null && Number(index) >= 0
    })
    // 自检：可聚焦的一枚都没有＝下面恒真。两支形状各九个状态，一个都不该漏。
    expect(focusable.length, '没有任何可聚焦头像——下面的全称判断恒真').toBe(quiet.length + interactive.length)

    const unringed = focusable.filter((element) => !focusRules.some((rule) =>
      rule.selector.split(',').some((member) => {
        if (!member.includes('agent-avatar')) return false
        FOCUS_PSEUDO.lastIndex = 0
        return element.matches(member.replace(INTERACTIVE_PSEUDO, '').trim())
      })
    )).map((element) => `${element.tagName}[role=${element.getAttribute('role')}]`)
    expect(
      [...new Set(unringed)],
      '这些头像键盘停得下来却没有任何焦点规则选中它——键盘用户看不见自己在哪'
    ).toEqual([])
  })

  it('计算值层：静态头像没有 pointer 光标，可点头像有', async () => {
    // 上一条按规则逐条问，是**结构**判据；这一条问浏览器最终算出来的那个值，是**结果**判据。
    // 两者不互相包含：结构判据不知道层叠与特异度（后写的一条能把前面的覆盖掉），结果判据只看得见
    // 光标这一个属性（悬停底色在没有真指针的 DOM 里算不出来）。缺陷从任一侧引入都会被抓到。
    const { quiet, interactive } = await renderBothShapes()
    for (const element of quiet) {
      expect(
        getComputedStyle(element).cursor,
        `${element.getAttribute('aria-label')}：静态头像算出了手型光标`
      ).not.toBe('pointer')
    }
    for (const element of interactive) {
      expect(
        getComputedStyle(element).cursor,
        `${element.getAttribute('aria-label')}：可点头像没有手型光标`
      ).toBe('pointer')
    }
  })
})
