import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { AGENT_DISPLAY_STATES } from '../src/renderer/src/lib/attention-vocabulary'
import { URGENT_ATTENTION_CATEGORIES, attentionAccentFor } from '../src/renderer/src/lib/attention-event'
import { boardRunCardAttributes } from '../src/renderer/src/lib/board-run-card'
import { allStyleRules } from './helpers/styles.js'

/**
 * Board 卡框的状态色。
 *
 * 为什么单独有这个文件：这一格此前是第二份状态色表——`.board-run-card--<state>` 把
 * waiting/blocked/disconnected/error 四个状态一起写死成 `var(--amber-line)` / `var(--amber-bg)`，
 * 于是同一张卡上，卡框说「等你」而卡里的状态点说「崩了」（色表判 `error` 是红）。`disconnected`
 * 更是压根不该有色框：`attention-event.ts` 写明「掉线不是一次请求，它有自己的中性处理，正是为了让
 * 琥珀只表示等你」。它能活到今天的原因很直接：**这一格的颜色与「哪些状态带框」都没有任何测试盯着**。
 * 所以判据不是「卡渲染出来了」，而是「颜色从哪来」与「谁决定带不带框」。
 */

const COMPONENT = new URL('../src/renderer/src/components/WorkspaceBoard.tsx', import.meta.url)

describe('Board 卡片的状态属性只判一次', () => {
  it('class 带 status--<state> 且不带 .status 本体', () => {
    for (const state of AGENT_DISPLAY_STATES) {
      const classes = boardRunCardAttributes(state).className.split(/\s+/u)
      expect(classes).toContain(`status--${state}`)
      expect(classes).toContain('board-run-card')
      // `.status` 是 inline-flex + capitalize 的行内小构件语汇，套到 grid 卡片上会掀翻版式并把
      // 措辞大写化。需要的只是 `--status-ink` 那一次赋值，赋值全在 `.status--<state>` 这一族上。
      expect(classes).not.toContain('status')
    }
  })

  it('带不带色框由 attentionAccentFor 决定，卡片自己不持有第二份清单', () => {
    // 守的是恒等而不是几个例子：卡片这一侧多认一个状态、少认一个状态，或把 done 也上了色，
    // 这条循环立刻红。清单只有 attentionAccentFor 一份。
    for (const state of AGENT_DISPLAY_STATES) {
      const accent = attentionAccentFor(state)
      expect(boardRunCardAttributes(state)['data-attention'], state).toBe(accent ?? undefined)
    }
    // 三个曾被这条规则误伤或漏掉的取值，各自单独钉一次——它们就是那个缺陷本身：
    //   disconnected 曾被画成琥珀（「你是瓶颈」），error 曾被画成琥珀（而它该是红），
    //   done 从来不该上色（红与琥珀留给「你是瓶颈」与「这坏了」）。
    expect(boardRunCardAttributes('disconnected')['data-attention']).toBeUndefined()
    expect(boardRunCardAttributes('done')['data-attention']).toBeUndefined()
    expect(boardRunCardAttributes('error')['data-attention']).toBe('error')
    expect(boardRunCardAttributes('waiting')['data-attention']).toBe('needs-you')
  })
})

describe('卡框的颜色来自状态色表', () => {
  const styles = allStyleRules()

  it('带框那条规则读 --status-ink，且没有按状态自己挑色的兄弟规则', () => {
    // 正面：必须有一条以 `.board-run-card` + `[data-attention]` 为键的规则，且它**每一条颜色声明**
    // 都派生自 `--status-ink`。
    //
    // 判据必须逐条声明看，不能只问「规则体里出现过 --status-ink 吗」：这条规则有两条颜色声明
    // （border-color 与 background），只把其中一条换成 `var(--amber-line)`，另一条替它顶住，
    // 「出现过」的判据照旧全绿——实测存活过一次，就是这个形状。
    const framed = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].filter((match) => {
      const selector = match[1]!
      return /\.board-run-card\b/u.test(selector) && /\[data-attention/u.test(selector)
    })
    expect(framed.length, '没有以 data-attention 为键的卡框规则').toBeGreaterThan(0)
    const COLOUR_PROPERTIES = /^(?:color|background|background-color|border-color|border|outline|outline-color|box-shadow|fill|stroke)$/u
    const offenders: string[] = []
    let colourDeclarations = 0
    for (const match of framed) {
      for (const declaration of match[2]!.split(';')) {
        const [rawProperty, ...rest] = declaration.split(':')
        const property = rawProperty!.trim()
        const value = rest.join(':').trim()
        if (value === '' || !COLOUR_PROPERTIES.test(property)) continue
        colourDeclarations += 1
        if (!/var\(\s*--status-ink\b/u.test(value)) offenders.push(`${property}: ${value}`)
      }
    }
    // 自检：真的看到了颜色声明。一条都没看到时上面那个循环是空转，offenders 恒为空。
    expect(colourDeclarations, '卡框规则里没有任何颜色声明——判据会变成恒真').toBeGreaterThan(1)
    expect(offenders, '卡框的每一条颜色声明都必须派生自 --status-ink').toEqual([])

    // 反面：任何以 `board-run-card--<state>` 为键的规则都不许存在。少了反面，加一条读 token 的规则
    // 之后旁边照旧可以留一条写死琥珀的，而「有一条读了」的断言仍然绿——那正是这个缺陷的形状。
    const stateKeyed: string[] = []
    for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const selector = match[1]!.trim().replace(/\s+/gu, ' ')
      for (const member of selector.split(',').map((part) => part.trim())) {
        if (AGENT_DISPLAY_STATES.some((state) => member.includes(`board-run-card--${state}`))) {
          stateKeyed.push(member)
        }
      }
    }
    expect(stateKeyed, '卡框不许以状态为键——那是第二份状态色表').toEqual([])
  })

  it('每个会带框的 category 都有一条卡框规则选中它——少认一个是静默无框', () => {
    // 判据是**逐 category 的可达性**，不是「有没有以 data-attention 为键的规则」。上面那条用
    // `filter(...).length > 0`：一条能命中 `needs-you` 的规则就让长度非零，`error` 缺席对它完全不可见。
    // 实测过——把选择器里 `, .board-run-card[data-attention='error']` 那一半删掉，本文件与邻近两个
    // 文件 51 条全绿，而一个崩掉的 run 从此没有色框，与正常 run 逐像素相同。
    //
    // 这个形状在头像那一面已经做对了（topic-agent-status.test.ts 遍历 URGENT_ATTENTION_CATEGORIES 逐个
    // 查可达性，那是 #397 的产物）。Board 建了同一条投影链，却没把那道穷举门一起搬过来。
    //
    // 清单从 URGENT_ATTENTION_CATEGORIES 派生而不是手抄那两个名字：手抄的话，Core 加一个会上色的
    // category 时这条门会安静地把它放行——那正是它要防的静默漏点（#421）。
    expect(URGENT_ATTENTION_CATEGORIES.length, '会上色的 category 是空的——判据会变成恒真').toBeGreaterThan(0)
    const selects = (category: string): boolean => {
      for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        // 逐条拆开选择器列表：色表那侧的教训同样适用，`[^,{]*` 一类的正则只认得列表里最后那一项。
        const members = match[1]!.split(',').map((member) => member.trim())
        if (
          members.some((member) =>
            new RegExp(`\\.board-run-card\\b[^\\s]*\\[data-attention=['"]${category}['"]\\]`, 'u').test(member)
          )
        ) {
          return true
        }
      }
      return false
    }
    for (const category of URGENT_ATTENTION_CATEGORIES) {
      expect(selects(category), `data-attention='${category}' 的卡没有任何规则选中它，会变成无框`).toBe(true)
    }
    // 自检：判据认得出缺席。一个不存在的取值必须落空，否则上面几条恒真。
    expect(selects('nonexistent')).toBe(false)
  })

  it('每个会带框的状态都有一条赋 --status-ink 的规则接得住', () => {
    // 光有 `var(--status-ink)` 不够：它是继承来的自定义属性，没有任何 `.status--<state>` 规则落在
    // 这个元素上时它无值，两条声明一起失效——卡框会变成「没有框」而不是响亮报错。所以逐个问。
    //
    // 判据必须逐条拆开选择器列表：色表里那条是 `.status--error, .status--exited { … }`，用
    // `\.status--error[^,{]*\{` 这类正则不许跨逗号，只有列表**最后**那个状态认得出来（这个盲点在
    // 恢复横幅那道判据上实测发作过一次，把 error 误报成缺席）。
    const assignsInk = (state: string): boolean => {
      for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        if (!/--status-ink\s*:/u.test(match[2]!)) continue
        const members = match[1]!.split(',').map((member) => member.trim())
        if (members.some((member) => new RegExp(`\\.status--${state}(?![\\w-])`, 'u').test(member))) {
          return true
        }
      }
      return false
    }
    const framedStates = AGENT_DISPLAY_STATES.filter((state) => attentionAccentFor(state) !== null)
    expect(framedStates.length, '没有任何状态会带框——判据会变成恒真').toBeGreaterThan(0)
    for (const state of framedStates) {
      expect(assignsInk(state), `.status--${state} 没有给 --status-ink 赋值，卡框会变成无颜色`).toBe(true)
    }
    // 自检：判据认得出缺席。一个不存在的状态名必须落空，否则上面几条是恒真的。
    expect(assignsInk('nonexistent')).toBe(false)
  })

  it('带框的卡也要有悬停反馈——否则最该被点开的那张对指针没有回应', () => {
    // 这不是色相问题，所以「不分档的规则不许点名色相」那道门抓不到它：`.board-run-card:hover` 与
    // `.board-run-card[data-attention='…']` 的特异性同为 0,2,0，后者排在后面，于是 hover 时边与底
    // 都被静息态赢回来——一张需要你 / 出错的卡指上去毫无变化，而它恰恰是这张板上最该被点开的那张。
    // 实测过：删掉 hover 那条，本文件与邻近三个文件 45 条全绿。
    //
    // 判据是**逐 category 的成对性**：每个会带框的 category，既要有静息规则，也要有一条同键的 hover
    // 规则。清单从 URGENT_ATTENTION_CATEGORIES 派生而不是手抄，理由与上面那条穷举门相同。
    const framedRule = (category: string, hover: boolean): boolean => {
      for (const [, rawSelector] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        for (const member of rawSelector!.split(',').map((part) => part.trim())) {
          if (!new RegExp(`\\.board-run-card\\b[^\\s]*\\[data-attention=['"]${category}['"]\\]`, 'u').test(member)) {
            continue
          }
          // `:hover` 必须落在**卡自己**这个 compound 上，不是落在某个后代元素上：
          // `.board-run-card[data-attention='error'] .x:hover` 不是这张卡的悬停反馈。
          if (/\[data-attention=['"][^'"]+['"]\]:hover(?![\w-])/u.test(member) === hover) return true
        }
      }
      return false
    }
    expect(URGENT_ATTENTION_CATEGORIES.length, '会上色的 category 是空的——判据会变成恒真').toBeGreaterThan(0)
    for (const category of URGENT_ATTENTION_CATEGORIES) {
      expect(framedRule(category, false), `data-attention='${category}' 没有静息色框规则`).toBe(true)
      expect(
        framedRule(category, true),
        `data-attention='${category}' 的卡没有 hover 规则，静息态会盖住通用 hover，指上去毫无反馈`
      ).toBe(true)
    }
    // 自检：判据认得出缺席，也认得出"hover 落在后代元素上不算"。
    expect(framedRule('nonexistent', false)).toBe(false)
    expect(framedRule('nonexistent', true)).toBe(false)
  })
})

describe('卡片的属性由那个纯函数产出', () => {
  it('组件里没有手抄的 board-run-card-- 拼接，属性就是那次调用的展开', () => {
    const source = readFileSync(COMPONENT, 'utf8')
    const file = ts.createSourceFile(COMPONENT.pathname, source, ts.ScriptTarget.Latest, true)

    // 判「接线」而不是「字符串在场」：找到那次展开，要求它的值**就是** boardRunCardAttributes 的
    // 调用结果，实参是这张卡的状态。此前这里是内联拼 `board-run-card--${session.status.state}`，
    // 于是「哪些状态上色」这个清单在 CSS 里又活了一份。
    const spread: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSpreadAttribute(node)) {
        const expression = node.expression
        if (
          ts.isCallExpression(expression) &&
          expression.expression.getText() === 'boardRunCardAttributes'
        ) {
          spread.push(expression.getText())
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(spread).toHaveLength(1)
    expect(spread[0]).toContain('session.status.state')

    // 组件里不许再出现手抄的修饰类拼法。裸 `board-run-card` 不在禁令内（还有 `__status` /
    // `__identity` 这些子类），只禁 `board-run-card--`，那才是状态那一段。
    expect(source).not.toContain('board-run-card--')
    // className 也不许再自己拼——它整份来自那次调用。
    expect(source).not.toMatch(/className=\{`board-run-card/u)
  })
})
