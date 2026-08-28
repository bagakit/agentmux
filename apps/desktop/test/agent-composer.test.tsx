import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposer } from '../src/renderer/src/components/AgentComposer.js'
import { allStyleRules, allStyles } from './helpers/styles.js'

const styles = allStyles()

describe('AgentComposer reusable surface', () => {
  it('renders from controlled props without a Session Store', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: 'Review this file',
      disabled: false,
      placeholder: 'Ask the Agent…',
      activeFile: 'src/review.ts',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onInterrupt: vi.fn(),
      onReferenceActiveFile: vi.fn()
    }))

    expect(markup).toContain('data-agent-composer="true"')
    expect(markup).toContain('class="composer__editor"')
    expect(markup).toContain('Review this file')
    expect(markup).toContain('review.ts')
    expect(markup).toContain('Send')
    expect(markup).not.toContain('composer-send--working')
    expect(markup).not.toMatch(/data-disabled="true"/)
  })

  it('keeps the whole rich-input surface visible while disabled', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: true,
      placeholder: 'Agent is not running',
      onChange: vi.fn()
    }))

    expect(markup).toContain('data-agent-composer="true"')
    expect(markup).toContain('placeholder="Agent is not running"')
    expect(markup).toMatch(/data-disabled="true"/)
    expect(markup).toContain('Files')
    expect(markup).toContain('Send')
  })

  it('places the unified Session mailbox after the send action in the right controls', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: '', disabled: false, placeholder: '', onChange: vi.fn(),
      mailbox: createElement('button', { 'data-test-mailbox': true }, 'Mailbox')
    }))
    const mailboxAt = markup.indexOf('data-test-mailbox')
    const sendAt = markup.indexOf('class="composer-send"')
    expect(mailboxAt).toBeGreaterThan(-1)
    expect(sendAt).toBeGreaterThan(-1)
    expect(mailboxAt).toBeGreaterThan(sendAt)
    expect(markup.slice(sendAt, mailboxAt)).not.toContain('</div><div>')
  })

  it('offers the active-file shortcut only when there is an active file to reference', () => {
    // The shortcut names the open file, so with nothing open it has nothing to say. It hides rather
    // than sitting greyed out next to Attach, which is what made the toolbar read as broken.
    const withoutFile = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onAttach: vi.fn()
    }))
    expect(withoutFile).toContain('Files')
    expect(withoutFile).not.toContain('lucide-at-sign')

    const withFile = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: false,
      placeholder: 'Ask the Agent…',
      activeFile: 'src/index.ts',
      onChange: vi.fn(),
      onAttach: vi.fn(),
      onReferenceActiveFile: vi.fn()
    }))
    expect(withFile).toContain('lucide-at-sign')
    expect(withFile).toContain('index.ts')
  })

  it('leaves Attach usable whenever the Agent can take input', () => {
    // Attach was permanently inert because no caller ever supplied its handler; it must now be gated
    // only by whether the Agent can accept input at all.
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onAttach: vi.fn()
    }))

    expect(markup).not.toContain('not available yet')
    expect(markup).toMatch(/Files/u)
    // The only disabled control in a live composer with an empty draft is Send.
    expect(markup.match(/disabled=""/gu) ?? []).toHaveLength(1)
  })

  it('offers a single filled square that names interrupting THIS turn, not stopping the session', () => {
    // The button calls Core's semantic interrupt, which ends the current turn and leaves the Run alive.
    // Terminating the whole session is a different action living in the Tabbar, so this one must not say
    // "Stop" — a word a user reads as "I lose the session", which makes them afraid to press it. The mark
    // is a filled square and the accessible name says "current turn"; the two entry points stay tellable apart.
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: 'Some text',
      disabled: false,
      placeholder: 'Ask the Agent…',
      primaryAction: 'stop',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onInterrupt: vi.fn()
    }))

    expect(markup).toContain('composer-send--working')
    expect(markup).toContain('aria-label="Interrupt the current turn"')
    // The mark carries it: a filled square glyph, no word that could be read as ending the session.
    expect(markup).toContain('lucide-square')
    expect(markup).not.toContain('>Stop')
    expect(markup).not.toContain('aria-label="Send steer"')
    expect(markup.match(/class="composer-send/g)).toHaveLength(1)
  })

  it('submits on Enter whether the primary action is Send or Stop — a working Agent can be steered', () => {
    // The bug: one !isWorking flag made the working state swallow Enter, so a running Agent could only be
    // stopped, never steered. Enter now submits in BOTH modes; Stop stays a button click, so mid-turn
    // Enter can never be an accidental stop. Delivery (incl. codex's mid-turn refusal) is Core's call.
    const onSubmit = vi.fn()
    const onInterrupt = vi.fn()

    const idleComposer = AgentComposer({
      value: 'Fix bug',
      disabled: false,
      placeholder: 'Ask the Agent…',
      primaryAction: 'send',
      onChange: vi.fn(),
      onSubmit,
      onInterrupt
    }) as unknown as { props: { children: [ { props: { onKeyDown(e: unknown): void } } ] } }

    const idleTextarea = idleComposer.props.children[0]
    const preventDefault = vi.fn()
    idleTextarea.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onInterrupt).not.toHaveBeenCalled()

    onSubmit.mockClear()
    preventDefault.mockClear()

    // While working (primaryAction 'stop'): Enter STILL submits the steer, and never interrupts.
    const workingComposer = AgentComposer({
      value: 'Actually, try the other file',
      disabled: false,
      placeholder: 'Ask the Agent…',
      primaryAction: 'stop',
      onChange: vi.fn(),
      onSubmit,
      onInterrupt
    }) as unknown as { props: { children: [ { props: { onKeyDown(e: unknown): void } } ] } }

    const workingTextarea = workingComposer.props.children[0]
    workingTextarea.props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  // 四个来源各自承重。此前这条用例的 fixture 在**合成事件与 nativeEvent 上设同一个值**，于是它分不清
  // 生产代码读的是哪一侧：把 `event.nativeEvent?.isComposing` 改成 `event.isComposing` 时 17 条全绿
  // （fixture 形状让测试失明）。改成每个 fixture 只设一个来源——这既钉住读的是哪一侧，也把「收敛到
  // 四路 SSOT 谓词」变成必须的改动：只标记 keyCode 或只标记顶层 isComposing 的输入法，在两路手抄下
  // 会把半转换草稿提交上去。
  const IME_SOURCES: ReadonlyArray<{ name: string; event: Record<string, unknown> }> = [
    { name: '合成事件 isComposing', event: { isComposing: true, keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } } },
    { name: '合成事件 keyCode=229', event: { isComposing: false, keyCode: 229, nativeEvent: { isComposing: false, keyCode: 13 } } },
    { name: 'nativeEvent.isComposing', event: { isComposing: false, keyCode: 13, nativeEvent: { isComposing: true, keyCode: 13 } } },
    { name: 'nativeEvent.keyCode=229', event: { isComposing: false, keyCode: 13, nativeEvent: { isComposing: false, keyCode: 229 } } }
  ]

  for (const source of IME_SOURCES) {
    it(`does not submit while an IME is confirming a candidate（只标记${source.name}）`, () => {
      const onSubmit = vi.fn()
      const composer = AgentComposer({
        value: '中文草稿',
        disabled: false,
        placeholder: 'Ask the Agent…',
        onChange: vi.fn(),
        onSubmit
      }) as unknown as { props: { children: [{ props: { onKeyDown(e: unknown): void } }] } }
      const textarea = composer.props.children[0]
      const preventDefault = vi.fn()

      textarea.props.onKeyDown({ key: 'Enter', shiftKey: false, ...source.event, preventDefault })

      expect(onSubmit, `只标记${source.name} 的组字确认 Enter 被当成提交`).not.toHaveBeenCalled()
      expect(preventDefault).not.toHaveBeenCalled()
    })
  }

  it('四个来源都不满足的裸 Enter 仍然提交（反向锚点，防谓词恒真）', () => {
    // 没有这条，把判据改成恒「在组字」就能让上面四条全绿——而那样 Enter 永远发不出消息。
    const onSubmit = vi.fn()
    const composer = AgentComposer({
      value: '中文草稿',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit
    }) as unknown as { props: { children: [{ props: { onKeyDown(e: unknown): void } }] } }
    const preventDefault = vi.fn()

    composer.props.children[0].props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 提交门的三个合取各自被谁守。
  //
  // `canSubmit = !disabled && Boolean(onSubmit) && Boolean(value.trim())`。此前这三条**一条都没人守**：
  // 把整个表达式换成 `Boolean(onSubmit)`，本文件与 agent-session-composer.test.tsx 共 25 条全绿。
  //
  // 成因是 fixture 的形状，不是断言不够多：四个 `value: ''` 的 fixture 全都**没传 onSubmit**，于是
  // `Boolean(onSubmit)` 先短路，后两个合取从来没有参与过判定——那个判据永远走不到（记忆
  // guard-must-check-reachability-not-presence 的同族：在场不等于可达）。
  //
  // 每个合取的失效各有各的症状，所以下面按合取分条，每条只让**一个**合取成为唯一的决定因素：
  // 空草稿门失效 → 空 composer 上 Send 可点、Enter 发一条空消息给 agent；
  // disabled 门失效 → agent 没跑、或有待决权限交互时也能提交（那正是 disabled 的用途）；
  // trim 失效 → 只按了几个空格也算有内容，agent 收到一条纯空白的 turn。
  // -------------------------------------------------------------------------
  describe('提交门的三个合取', () => {
    /** 把组件当函数调，拿到 textarea 的 props——Enter 路径与 Send 按钮共用同一个 canSubmit。 */
    function composerParts(props: Parameters<typeof AgentComposer>[0]) {
      const tree = AgentComposer(props) as unknown as {
        props: { children: [{ props: { onKeyDown(e: unknown): void } }, unknown] }
      }
      return { textarea: tree.props.children[0] }
    }

    function pressEnter(props: Parameters<typeof AgentComposer>[0]) {
      const preventDefault = vi.fn()
      composerParts(props).textarea.props.onKeyDown({
        key: 'Enter',
        shiftKey: false,
        preventDefault
      })
      return { preventDefault }
    }

    it('空草稿：onSubmit 在场且未 disabled，仍不能提交——唯一的拦路者是空草稿', () => {
      // onSubmit **必须**传进来，否则 Boolean(onSubmit) 先短路，这一条就测不到空草稿门。
      const onSubmit = vi.fn()
      const { preventDefault } = pressEnter({
        value: '',
        disabled: false,
        placeholder: 'Ask the Agent…',
        onChange: vi.fn(),
        onSubmit
      })
      expect(onSubmit, '空草稿也提交了：agent 会收到一条空消息').not.toHaveBeenCalled()
      expect(preventDefault, '空草稿时吃掉了 Enter：连换行都打不出来').not.toHaveBeenCalled()

      const markup = renderToStaticMarkup(createElement(AgentComposer, {
        value: '',
        disabled: false,
        placeholder: 'Ask the Agent…',
        onChange: vi.fn(),
        onSubmit
      }))
      expect(markup, 'Send 在空草稿上是可点的').toMatch(/class="composer-send"[^>]*disabled=""/)
    })

    it('只有空白的草稿等同于空——trim 之后没内容就不是内容', () => {
      const onSubmit = vi.fn()
      for (const value of ['   ', '\n\n', ' \t \n ']) {
        const { preventDefault } = pressEnter({
          value,
          disabled: false,
          placeholder: 'Ask the Agent…',
          onChange: vi.fn(),
          onSubmit
        })
        expect(onSubmit, `${JSON.stringify(value)} 被当成有内容：agent 收到一条纯空白的 turn`)
          .not.toHaveBeenCalled()
        expect(preventDefault).not.toHaveBeenCalled()
      }
    })

    it('disabled：草稿有内容、onSubmit 也在场，仍不能提交——唯一的拦路者是 disabled', () => {
      // disabled 是「这个面此刻不能写」的唯一表达（agent 没跑、有待决权限交互）。它失效时
      // 用户能往一个不接受输入的会话里发消息，而消息去哪了没人知道。
      const onSubmit = vi.fn()
      const { preventDefault } = pressEnter({
        value: 'Fix the bug',
        disabled: true,
        placeholder: 'Agent is not running',
        onChange: vi.fn(),
        onSubmit
      })
      expect(onSubmit, 'disabled 的 composer 提交了：消息发进一个不接受输入的会话')
        .not.toHaveBeenCalled()
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('三个合取同时满足时才提交——这一条是上面三条的对照面', () => {
      // 没有它，把 canSubmit 直接写成 false 会让上面三条全绿（都在断言"不提交"）。
      const onSubmit = vi.fn()
      const { preventDefault } = pressEnter({
        value: 'Fix the bug',
        disabled: false,
        placeholder: 'Ask the Agent…',
        onChange: vi.fn(),
        onSubmit
      })
      expect(onSubmit, '三个条件都满足却不提交：composer 彻底发不出消息').toHaveBeenCalledTimes(1)
      expect(preventDefault).toHaveBeenCalled()
    })

    it('Send 按钮与 Enter 走的是同一个门——不是各判一次', () => {
      // 两处各判一次必漂移，症状是「按钮灰着但 Enter 发得出去」或反过来。判据是让三个合取
      // 各失败一次，两条路径的结论每次都一致。
      const onSubmit = vi.fn()
      const cases = [
        { value: '', disabled: false, submittable: false },
        { value: '   ', disabled: false, submittable: false },
        { value: 'text', disabled: true, submittable: false },
        { value: 'text', disabled: false, submittable: true }
      ] as const
      for (const { value, disabled, submittable } of cases) {
        onSubmit.mockClear()
        const props = {
          value,
          disabled,
          placeholder: 'Ask the Agent…',
          onChange: vi.fn(),
          onSubmit
        }
        pressEnter(props)
        const enterSubmitted = onSubmit.mock.calls.length > 0
        // 按钮那侧读 markup 上的 disabled 属性；两条路径必须给出同一个结论。
        const markup = renderToStaticMarkup(createElement(AgentComposer, props))
        const buttonEnabled = /class="composer-send"(?![^>]*disabled="")/.test(markup)
        expect(
          enterSubmitted,
          `Enter 与预期不符（value=${JSON.stringify(value)} disabled=${disabled}）`
        ).toBe(submittable)
        expect(
          buttonEnabled,
          `Send 按钮与 Enter 判得不一样：按钮 ${buttonEnabled ? '可点' : '灰着'}、Enter ${enterSubmitted ? '发得出' : '发不出'}`
        ).toBe(enterSubmitted)
      }
    })
  })

  it('uses a transparent surface without a black drop shadow', () => {
    const baseRule = styles.match(/(?:^|\n)\.composer \{([^}]*)\}/)?.[1]
    const focusRule = styles.match(/\.composer:focus-within \{([^}]*)\}/)?.[1]

    expect(baseRule).toContain('background: var(--surface-1)')
    expect(baseRule).toContain('box-shadow: none')
    expect(focusRule).toContain('box-shadow: var(--focus-ring)')
    expect(focusRule).not.toMatch(/#[0-9a-f]+/i)
  })

  it('gives the collapsed Agent Input editor the flexible middle track', () => {
    const collapsedRule = allStyleRules().match(/\.composer:has\(\.composer-tools\[data-mode='collapsed'\]\) \{([^}]*)\}/)?.[1]
    expect(collapsedRule, 'collapsed composer rule is missing').toBeDefined()
    expect(collapsedRule).toContain('grid-template-columns: minmax(0, 6rem) minmax(0, 1fr) max-content')
    expect(collapsedRule).not.toContain('grid-template-columns: auto minmax(0, 1fr) auto')
  })

  // -------------------------------------------------------------------------
  // 静息态**恰好一行**。
  //
  // 三样东西合起来决定它，缺一个就退化成多行框：`rows={1}`（HTML 的固有高度）、
  // `field-sizing: content`（按内容长高而不是按 rows 定死）、以及 min-height 这道地板。
  // 此前地板写死 `34px`，比真正的一行（1lh + 上下 padding ≈ 26px）高出 8px，于是空的输入框
  // 永远画成两行高，看上去像个多行文本域——这是 #317 那条用户诉求的一半。
  //
  // ─── 判据为什么是「加法项的全集」，而不是「这几个记号在不在场」───
  //
  // 第一版判据是「`min-height` 的取值**含有** `1lh`、`var(--sp-4)`、`var(--sp-1)` 这三个子串」。
  // 它比 `toContain('1lh')` 强，但仍然是**在场判据**，而在场判据守不住「恰好一行」这条性质——
  // 审计实测（#627）出两个真回归在 16 条全绿下存活：
  //   · `calc(1lh * 2 + var(--sp-4) + var(--sp-1))`——**正是这次要消灭的那个两行高**。三个记号一个
  //     不少、与 padding 也没脱钩，所以「含有」这个判据对它完全失明；
  //   · `calc(1lh + var(--sp-4) + var(--sp-1) + 10px)`——一个凭空的 10px 抬高，同样全绿。
  // 「含有三个子串」与「由这三段相加构成」是两件事：任何加法或乘法的膨胀都满足前者。本仓记过这一族
  // （「presence-assertion-blind-when-shape-repeats」「guard-must-check-reachability-not-presence」），
  // 而第一版判据的注释里就引着这两条记忆，却还是写成了三次在场——这本身是「注释承诺的比断言强」。
  //
  // 所以判据改成**加法项的全集相等**：地板必须是一个 `calc(…)`，它的顶层加法项归一化后恰好是
  // `{1lh, padding-top, padding-bottom}` 这个多重集合——不多一项、不少一项、每一项逐字相等。
  // 于是 `1lh * 2` 不再等于 `1lh`（项内容不同）、多出的 `10px` 是第四项、少一项也红。顺序不敏感
  // （相加可交换，换顺序不改几何），减法留在项内故 `1lh - 2px` 逐字不等于 `1lh`。
  // border-box（base.css 的 `*`）让 min-height 含 padding，所以「加回纵向两档」不是巧合，
  // 而是几何上必须的那一步；padding 一改，地板的写法必须跟着改，否则这条断言红。
  //
  // 判据抽成 `floorDerivationProblems`，是为了让它能跑在**合成规则**上（下面那两条自检）：
  // 断言自己必须被证明「对着事故当时那份取值会红」，否则整组判据只是花架子。本仓记过
  // 「synthesized-fixture-is-self-certification」——所以主判据跑的是真 CSS，合成规则只用来
  // 证明判据有区分力，两条各管一件事。两条自检各钉一族存活形态（换字面量／膨胀成两行）。
  //
  // 这道门**不**保证：它不渲染真浏览器——「1lh 在 Electron 43 上算得对」不在它的射程内。级联只
  // 覆盖到「同一个元素上不许有第二条 min-height」（见 `composerTextareaMinHeightRules`），选择器
  // 匹配是按文本判的，所以 `textarea { min-height }` 这种不提 `.composer` 的祖先/裸元素覆写它看不见。
  // -------------------------------------------------------------------------

  /**
   * `calc(…)` 的顶层加法项，归一化去空白。不是 `calc(…)` 形状时返回 undefined——那意味着地板根本
   * 不是「几段相加」，与「一行 + 两档 padding」这个几何说法无关。
   *
   * 按括号深度切 `+`，所以 `var(--sp-4)` 内部不会被误切。`-`（减法）刻意**不**切：它留在项内，
   * 于是 `calc(1lh - 2px + …)` 的第一项是 `1lh-2px`，与期望的 `1lh` 逐字不等 → 红。
   */
  function additiveTerms(value: string): string[] | undefined {
    const trimmed = value.trim()
    if (!trimmed.startsWith('calc(') || !trimmed.endsWith(')')) return undefined
    const body = trimmed.slice('calc('.length, -1)
    const terms: string[] = []
    let depth = 0
    let current = ''
    for (const ch of body) {
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        // 括号早闭说明这不是单个 calc 的内部（例如 `calc(a) + calc(b)`），判据的切法失效。
        if (depth < 0) return undefined
      }
      if (ch === '+' && depth === 0) {
        terms.push(current)
        current = ''
        continue
      }
      current += ch
    }
    if (depth !== 0) return undefined
    return terms.concat(current).map((term) => term.replace(/\s+/g, ''))
  }

  /**
   * 「这条 `.composer__editor .tiptap` 规则的地板是不是恰好由一行 + 纵向 padding 相加构成」——返回问题
   * 清单，空数组表示通过。写成纯函数是为了让合成规则也能过同一组判据。
   */
  function floorDerivationProblems(rule: string): string[] {
    const padding = rule.match(/(?:^|;)\s*padding:\s*([^;]+)/)?.[1]?.trim()
    if (!padding) return ['padding 声明解析不出来：纵向两档无从取，判据无法成立']
    const tokens = padding.split(/\s+/)
    // 三值简写：top / 横向 / bottom。份数一变（比如改成四值），下面「纵向是第 0 和第 2 档」的
    // 取法当场失效——那时该红，因为判据自己的前提破了，不是因为地板错了。
    if (tokens.length !== 3) return [`padding 简写不是三值（实测 \`${padding}\`），纵向两档的取法失效`]
    const [padTop, , padBottom] = tokens

    const minHeight = rule.match(/(?:^|;)\s*min-height:\s*([^;]+)/)?.[1]?.trim()
    if (!minHeight) return ['min-height 声明解析不出来：静息地板没人设，rows 与内容会各说各话']

    // 期望是**多重集合**而不是集合：padTop 与 padBottom 相等时两档都得加回来（border-box 含上下
    // 两侧），去重会让「只加了一次」蒙混过关。
    const expected = ['1lh', padTop, padBottom].map((term) => term.replace(/\s+/g, '')).sort()
    const actual = additiveTerms(minHeight)?.sort()
    const shown = (terms: string[]): string => terms.map((term) => `\`${term}\``).join(' + ')
    if (!actual || actual.join('|') !== expected.join('|')) {
      return [
        `地板的加法项应恰好是 ${shown(expected)}（一行 + padding 的纵向两档），实测 \`${minHeight}\`` +
          `${actual ? `，切出来的项是 ${shown(actual)}` : '，它连 calc(…) 相加的形状都不是'}。` +
          'border-box 让 min-height 含 padding，所以两档必须逐字加回来；而多出任何一项（`+ 10px`）或' +
          '把某一项换成它的倍数（`1lh * 2`）都会把静息高度抬离一行——那正是本次修复要消灭的两行高'
      ]
    }
    return []
  }

  /**
   * 全表里所有「选择器同时提到 `.composer` 与 `textarea`、且声明了 `min-height`」的规则。
   *
   * 为什么需要它：上面那条判据只看**基础规则内部**的取值关系，于是审计实测出第二个存活形态
   * （#627 FINDING 2）——在任意样式文件里追加 `.composer__editor .tiptap:enabled { min-height: 34px }`，
   * 特异度更高、按级联赢，两行高原样回来，而 16 条照旧全绿。判据因此要补一条：这个元素上的
   * `min-height` **只能有一处**。
   *
   * 它按选择器文本判，不做真正的选择器匹配，所以看不见 `textarea { min-height }` 这类不提
   * `.composer` 的裸元素/祖先覆写（限制已写进上面的「不保证」）。
   */
  function composerTextareaMinHeightRules(css: string): Array<{ selector: string; value: string }> {
    /** 叶子规则（选择器 + 声明块），按大括号深度正确穿过 `@media` 这类容器块。 */
    const leafRules = (source: string, out: Array<{ selector: string; body: string }> = []) => {
      let depth = 0
      let headStart = 0
      let bodyStart = -1
      for (let index = 0; index < source.length; index += 1) {
        const ch = source[index]
        if (ch === '{') {
          if (depth === 0) bodyStart = index
          depth += 1
        } else if (ch === '}') {
          depth -= 1
          if (depth === 0) {
            const body = source.slice(bodyStart + 1, index)
            // body 里还有 `{` 说明这是容器块（`@media` 等）：递归进去，别把它当成一条声明块，
            // 否则藏在 @media 里的覆写对这道门完全隐身。
            if (body.includes('{')) leafRules(body, out)
            else out.push({ selector: source.slice(headStart, bodyStart).replace(/\s+/g, ' ').trim(), body })
            headStart = index + 1
          }
        }
      }
      return out
    }
    return leafRules(css)
      .filter(({ selector }) => selector.includes('.composer') && selector.includes('.tiptap'))
      .flatMap(({ selector, body }) => {
        const value = body.match(/(?:^|;)\s*min-height:\s*([^;]+)/)?.[1]?.trim()
        return value === undefined ? [] : [{ selector, value }]
      })
  }

  /**
   * 取出那条 `.composer__editor .tiptap` 基础规则的声明块。
   *
   * 主判据与下面的自检**共用这一个取值口**，是实测出来的必要：第一版让自检自己拼一段带选择器的
   * 文本，而判据收到的是**已经剥掉选择器的声明块**——两种形状不同，于是自检报的是「min-height
   * 解析不出来」而不是「地板脱钩」。那是假红，且反过来说明形状一分岔，判据就可能只对其中一种
   * 输入有效（本仓「fixture-wrong-shape-blinds-the-test」）。共用取值口把这一族整个消掉。
   *
   * 先数在场次数：这条规则出现两次时按 [0] 取的那份可能不是承重的那份，改一处就假绿
   * （本仓 #586「presence-assertion-blind-when-shape-repeats」）。
   */
  function composerTextareaRule(css: string): string {
    const matches = [...css.matchAll(/\.composer__editor .tiptap \{([^}]*)\}/g)]
    expect(matches.length, '`.composer__editor .tiptap` 的基础规则不是恰好一条，按第一条取值会认错对象').toBe(1)
    return matches[0][1]
  }

  it('输入框静息高度恰好一行：地板由 1lh 加 padding 的纵向两档派生，不是脱钩的值', () => {
    // 剥掉注释再判——上面那段解释里逐字写着 `min-height: calc(1lh …`，按原文判会被自己的注释
    // 满足（本仓 #409 的原型事故，见 helpers/styles.ts 的 stripCssComments）。
    const rule = composerTextareaRule(allStyleRules())

    // `field-sizing: content` 是「按内容长高」的那一半。没有它，rows={1} 把高度定死在一行
    // **而且长不高**，多行输入会退化成框内滚动——那是另一个毛病，不是这条规则想要的。
    expect(rule).toContain('overflow-y: auto')

    expect(floorDerivationProblems(rule).join('\n')).toBe('')
  })

  it('自检：这组判据对着每一族已实测存活的取值都会红', () => {
    // 少了这条，上面那条会以最难发现的方式假绿：正则写错、取值取空、问题清单永远为空，
    // 三种都让 `.join('')` 恒等于空串，而「判过了」与「没判到」打印出来一模一样。
    //
    // 三个负样本各代表一族**实测存活过**的形态，不是想象出来的：
    //   · `34px`——事故当时的真实字节（换字面量，与 padding 彻底脱钩）；
    //   · `calc(1lh * 2 + …)`——审计 #627 实测在旧判据下 16 条全绿，而它正是要消灭的那个两行高；
    //   · `calc(1lh + … + 10px)`——同一次审计的第二个存活形态，凭空抬高一截。
    // 后两个的意义在于：它们含齐了全部三个记号，所以任何「在场式」判据都认不出来。
    const survivors: Array<{ label: string; minHeight: string }> = [
      { label: '事故当时的字面量', minHeight: '34px' },
      { label: '两行高（#627 实测存活）', minHeight: 'calc(1lh * 2 + var(--sp-4) + var(--sp-1))' },
      { label: '凭空抬高（#627 实测存活）', minHeight: 'calc(1lh + var(--sp-4) + var(--sp-1) + 10px)' }
    ]
    for (const { label, minHeight } of survivors) {
      const problems = floorDerivationProblems(
        composerTextareaRule(`.composer__editor .tiptap { min-height: ${minHeight}; padding:var(--sp-4) var(--sp-5) var(--sp-1); }`)
      )
      expect(problems.length, `${label}（${minHeight}）喂回去，判据一条问题都没报——它守不住这一族`).toBeGreaterThan(0)
      // 报的必须是「加法项不对」这件事，不是碰巧因为解析失败而红：解析失败会走前面那几条
      // early return，措辞完全不同，那种红是假红。
      expect(problems.join('\n'), `${label}：报的不是加法项不符，可能是解析失败的假红`).toContain('加法项')
    }

    // 反向：正确的那份必须**不**报问题，否则上面三条只是「判据恒红」而不是「判据有区分力」。
    expect(
      floorDerivationProblems(
        composerTextareaRule('.composer__editor .tiptap { min-height: calc(1lh + var(--sp-4) + var(--sp-1)); padding:var(--sp-4) var(--sp-5) var(--sp-1); }')
      ),
      '正确的取值也被判成有问题：判据恒红，上面三条自检因此不证明任何区分力'
    ).toEqual([])
  })

  it('这个元素上只有一处 min-height——第二条更特异的规则会按级联赢回两行高', () => {
    // #627 FINDING 2 实测：追加 `.composer__editor .tiptap:enabled { min-height: 34px }`（放 composer.css
    // 或任何后加载的文件都一样）特异度更高、按级联赢，两行高原样回来，而上面那条判据只读基础规则
    // 的内部取值，16 条全绿。所以「地板派生正确」还不够，得同时是**唯一**的地板。
    const declarations = composerTextareaMinHeightRules(allStyleRules())
    expect(
      declarations.map(({ selector, value }) => `${selector} → min-height: ${value}`),
      'composer 的 textarea 上有不止一处 min-height：更特异或更靠后的那条按级联赢，' +
        '地板派生得再对也拦不住它把静息高度抬回两行'
    ).toHaveLength(1)

    // 自检：这个取值口真的认得出追加进来的那一条，否则上面那条 `toHaveLength(1)` 只是碰巧成立
    // （选择器过滤写错、容器块没穿透，都会让它恒为 1）。
    const withOverride = composerTextareaMinHeightRules(
      `${allStyleRules()}\n.composer__editor .tiptap:enabled { min-height: 34px; }`
    )
    expect(
      withOverride.map(({ value }) => value),
      '追加一条更特异的 min-height 之后取值口仍只看到一条：它的选择器过滤或分块有问题'
    ).toEqual([declarations[0]!.value, '34px'])

    // 同一条自检的另一半：藏在 `@media` 里的覆写也必须被看见（叶子规则要穿过容器块）。
    const inMedia = composerTextareaMinHeightRules(
      `${allStyleRules()}\n@media (min-width: 100px) { .composer__editor .tiptap { min-height: 34px; } }`
    )
    expect(
      inMedia.map(({ value }) => value),
      '@media 里的覆写对取值口隐身：容器块没被穿透，那一整类覆写不受这道门约束'
    ).toEqual([declarations[0]!.value, '34px'])
  })

  it('uses the inline editor with the actual controlled draft', () => {
    const tree = AgentComposer({ value: 'draft', disabled: false, placeholder: 'Ask', onChange: vi.fn() })
    const editor = tree.props.children[0]
    expect(editor.type.name).toBe('InlineComposer')
    expect(editor.props.value).toBe('draft')
  })
})

// -----------------------------------------------------------------------------
// Region 名水印（#—— 用户诉求：Terminal 里没处看 Region 名）。
//
// AgentComposer 只透传这个字符串——「名字取决于兄弟格」的算法住在 SessionPane（见
// region-name-watermark.test.tsx）。这一组只钉住组件这层的两条契约：给了名字就渲染、没给就整段
// 缺席（占位符会把「没有可信名字」谎报成「有个东西」），外加水印的 CSS 归位。
// -----------------------------------------------------------------------------
describe('AgentComposer Region 名水印', () => {
  it('renders no invented identity when the host has none', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: '', disabled: false, placeholder: 'Message', onChange: vi.fn()
    }))
    expect(markup).not.toContain('composer__identity')
    expect(markup).not.toContain('Unknown')
  })
})

/**
 * 识别词：裸词命中的候选、Tab 接管边界、以及下划线装饰。
 *
 * 判据分两层。**接线层**（本组）读 AgentComposer 的 props 与 keydown：候选开不开、Tab 拦不拦、
 * keyword 有没有真的交到编辑器手里。**装饰层**在 inline-composer 那侧——它要一个真编辑器，而本仓的
 * vitest 是 node 环境。
 */
describe('识别词的候选与 Tab 接管', () => {
  const promptKeywords = [
    { text: 'eli5', description: 'Explain simply · Your prompt' },
    { text: 'grill_me', description: 'Grill me · Your prompt' }
  ]

  function composerFor(value: string, extra: Partial<Parameters<typeof AgentComposer>[0]> = {}) {
    return AgentComposer({
      value,
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      promptKeywords,
      ...extra
    }) as unknown as {
      props: {
        children: unknown[]
      }
    }
  }

  /** 候选浮层的 role=listbox 那一层；缺席时是 null（`suggestions.length` 为 0 就整段不渲染）。 */
  function suggestionTexts(value: string): string[] {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value,
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      promptKeywords
    }))
    if (!markup.includes('composer__suggestions')) return []
    return promptKeywords.filter((item) => markup.includes(`>${item.text}<`)).map((item) => item.text)
  }

  it('打字过程中就给出提示，且打全整个 keyword 之后候选仍在', () => {
    // 打到一半：前缀命中。
    expect(suggestionTexts('please eli'), '打到一半没有提示——用户无从知道有这个词').toEqual(['eli5'])
    // **打全之后仍在**。若沿用 `/` 那条 `item.text !== trigger` 的排除，这里会空掉，而那正是
    // 用户要按 Tab / 点它的那一刻——候选恰好在此消失。
    expect(suggestionTexts('please eli5'), '打全 keyword 后候选消失了：Tab 与点击都无从下手').toEqual(['eli5'])
    // 不是 keyword 的普通词不开口。
    expect(suggestionTexts('please explain this')).toEqual([])
    // 单个字符不开口：否则几乎每句话都在弹候选。
    expect(suggestionTexts('e')).toEqual([])
  })

  it('显式 / 触发不被裸词分支抢走', () => {
    // `/diff` 这类命令走原来的路，`promptKeywords` 不该掺进来。
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: 'run /di',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      promptKeywords,
      commands: [{ text: '/diff', description: 'Show the diff' }]
    }))
    expect(markup).toContain('/diff')
    expect(markup, '`/` 触发时把识别词也端了出来').not.toMatch(/>eli5</)
  })

  it('Tab 只在光标停在识别词末尾时接管，其余一律放行', () => {
    function pressTab(value: string, caret: number, onChange = vi.fn()) {
      const preventDefault = vi.fn()
      const tree = composerFor(value, { onChange }) as unknown as {
        props: { children: [{ props: { onKeyDown(event: unknown, caret: number): void } }, ...unknown[]] }
      }
      tree.props.children[0].props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault }, caret)
      return { preventDefault, onChange }
    }

    // 命中：接管并替换。
    const hit = pressTab('please eli5', 11)
    expect(hit.preventDefault, '光标停在识别词末尾却没接管 Tab').toHaveBeenCalled()
    expect(hit.onChange).toHaveBeenCalledWith('please eli5')

    // 未命中：**不得** preventDefault，否则 Tab 永远出不了输入框（无条件拦的实现在这里红）。
    const miss = pressTab('please explain', 14)
    expect(miss.preventDefault, '没命中也吃掉了 Tab：用户被永久困在输入框里').not.toHaveBeenCalled()
    expect(miss.onChange).not.toHaveBeenCalled()

    // 词中间按 Tab 的人在遍历焦点，不是要替换。
    const inside = pressTab('please eli5', 9)
    expect(inside.preventDefault, '词中间也接管了 Tab').not.toHaveBeenCalled()

    // Shift+Tab 是反向遍历，永不接管。
    const tree = composerFor('please eli5') as unknown as {
      props: { children: [{ props: { onKeyDown(event: unknown, caret: number): void } }, ...unknown[]] }
    }
    const shiftPrevent = vi.fn()
    tree.props.children[0].props.onKeyDown({ key: 'Tab', shiftKey: true, preventDefault: shiftPrevent }, 11)
    expect(shiftPrevent, 'Shift+Tab 也被接管了：反向焦点遍历没了').not.toHaveBeenCalled()
  })

  it('Tab 替换走 onSelectSuggestion，拿到的是裸 keyword 与 keyword 这个 kind', () => {
    // 这条钉的是 Tab 与点击**同一条替换路径**：宿主只实现一次「keyword → 正文」。
    const onSelectSuggestion = vi.fn(() => '[Explain simply](agentmux-subcommand:body)')
    const onChange = vi.fn()
    const tree = composerFor('please eli5', { onSelectSuggestion, onChange }) as unknown as {
      props: { children: [{ props: { onKeyDown(event: unknown, caret: number): void } }, ...unknown[]] }
    }

    tree.props.children[0].props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault: vi.fn() }, 11)

    expect(onSelectSuggestion).toHaveBeenCalledWith('eli5', 'keyword')
    expect(onChange, 'Tab 没有把 keyword 换成宿主给的正文').toHaveBeenCalledWith('please [Explain simply](agentmux-subcommand:body)')
  })

  it('识别词交到编辑器手里用于画下划线', () => {
    // 装饰本身由 InlineComposer 的扩展画（要真编辑器，见 inline-composer 那侧）。这里钉的是这条线
    // 真的接上了：不传下去的话下划线永远不出现，而候选与 Tab 照旧工作——半个功能，且测试全绿。
    const tree = composerFor('hello') as unknown as {
      props: { children: [{ props: { keywords?: readonly string[] } }, ...unknown[]] }
    }
    expect(tree.props.children[0].props.keywords, '识别词没交给编辑器：下划线永远不出现').toEqual(['eli5', 'grill_me'])
  })

  it('没有识别词时这条路整体静默——不开候选、不拦 Tab', () => {
    // 反向世界：一条 prompt 都没有（用户删光了）时，上面每一条都必须变成"什么也不做"。
    // 少了这条，一个把 promptKeywords 当摆设、恒开候选的实现也能通过前面几条。
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: 'please eli5',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit: vi.fn()
    }))
    expect(markup).not.toContain('composer__suggestions')

    const preventDefault = vi.fn()
    const tree = AgentComposer({
      value: 'please eli5',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit: vi.fn()
    }) as unknown as {
      props: { children: [{ props: { onKeyDown(event: unknown, caret: number): void } }, ...unknown[]] }
    }
    tree.props.children[0].props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault }, 11)
    expect(preventDefault, '一条识别词都没有却还是拦了 Tab').not.toHaveBeenCalled()
  })
})

/**
 * 候选按来源分段（设计 SSOT「同一个 `/` 列表，但分组带标题」——用户在两个方案里挑的就是这个，
 * 而不是第二个触发符）。
 *
 * 判据必须落在**成员归属**上，不是落在「两个标题都在场」：一个把所有候选塞进第一段、第二段只剩一个
 * 空标题的实现，同样能让两个标题都出现在 markup 里（本仓「在场判据太弱」那一族）。所以这里按段切开，
 * 逐段核对里面装的是哪几条。
 */
describe('候选浮层按来源分段', () => {
  /** 把浮层按 `<div class="composer__suggestion-group" … aria-label="X">` 切成 { 段名: 段内文本 }。 */
  function sections(markup: string): Record<string, string> {
    const out: Record<string, string> = {}
    const re = /<div class="composer__suggestion-group"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/h4>([\s\S]*?)(?=<div class="composer__suggestion-group"|<\/div><\/div>$)/g
    for (const [, label, , body] of markup.matchAll(re)) out[label!] = body!
    return out
  }

  const mine = [
    { text: '/review-changes', description: 'Review changes', group: 'Shortcuts' },
    { text: '/eli5', description: 'Explain simply', group: 'Shortcuts' }
  ]
  const theirs = [
    { text: '/diff', description: 'Show the diff', group: 'Agent commands' },
    { text: '/compact', description: 'Compact context', group: 'Agent commands' }
  ]

  function markupFor(commands: typeof mine) {
    return renderToStaticMarkup(createElement(AgentComposer, {
      value: '/',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      commands
    }))
  }

  it('两个来源各成一段，每条候选落在自己那一段里', () => {
    const found = sections(markupFor([...mine, ...theirs]))
    // 先证切分有收获：切出空的话，下面每一条 not.toContain 都恒真（本仓 indexOf 取空那一族）。
    expect(Object.keys(found), '浮层没有切出两个分段：分组根本没渲染').toEqual(['Shortcuts', 'Agent commands'])
    for (const [label, body] of Object.entries(found)) {
      expect(body.length, `${label} 段切出来是空的：这一段里的断言全部恒真`).toBeGreaterThan(0)
    }
    // 归属：我的两条在 Shortcuts 段里，Agent 的两条不在。**两个方向都判**——只判前者的话，
    // 一个把全部候选塞进第一段的实现照样通过。
    expect(found['Shortcuts']).toContain('/review-changes')
    expect(found['Shortcuts']).toContain('/eli5')
    expect(found['Shortcuts'], 'Agent 原生命令混进了 Shortcuts 段：分段只是视觉上的，归属是错的').not.toContain('/diff')
    expect(found['Agent commands']).toContain('/diff')
    expect(found['Agent commands']).toContain('/compact')
    expect(found['Agent commands'], '我的 Shortcut 混进了 Agent commands 段').not.toContain('/review-changes')
  })

  it('只有一个来源时不分段——给一份列表起个多余的名字', () => {
    const markup = markupFor(theirs)
    expect(markup, '单一来源也画了分段标题').not.toContain('composer__suggestion-group')
    // 反向锚：候选本身照旧在（上一条不是因为整个浮层没渲染）。
    expect(markup).toContain('/diff')
    expect(markup).toContain('/compact')
  })
})

/**
 * 候选浮层必须有边界并内部滚动（density SSOT DEN:480「菜单有边界和内部滚动」，interaction INT:735
 * 「当候选过多时在浮层内部滚动，输入框和底部操作保持可见」）。
 *
 * 为什么这条现在才立得住：候选来源合并成 Provider 原生命令 ∪ 用户自己的 prompt 之后，条数由**配置**
 * 决定而没有上限。不封顶时浮层会把输入框和底部操作顶出视口——而那两个正是用户此刻要看的东西。
 */
describe('候选浮层的边界', () => {
  it('有 max-height 且溢出时内部滚动', () => {
    const rules = allStyleRules()
    const found = [...rules.matchAll(/([^{}\n]*)\{([^{}]*)\}/g)]
      .filter(([, selector]) => /^\s*\.composer__suggestions\s*$/.test(selector!))

    expect(found.length, '.composer__suggestions 的基础规则不是恰好一条——判据会落到别的规则上').toBe(1)
    const body = found[0]![2]!
    expect(body, '候选浮层没有高度上限：候选一多就把输入框和 Send 顶出视口').toMatch(/max-height:/)
    // 只封顶不给滚动更糟：超出的候选既看不见也到不了。
    expect(body, '封了顶却没给内部滚动：溢出的候选永远够不着').toMatch(/overflow-y:\s*auto/)
  })
})
