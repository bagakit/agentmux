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
    expect(markup).toContain('aria-label="Message Agent"')
    expect(markup).toContain('Review this file')
    expect(markup).toContain('review.ts')
    expect(markup).toContain('Send')
    expect(markup).not.toContain('composer-send--working')
    expect(markup).not.toMatch(/<textarea[^>]*disabled=""/)
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
    expect(markup).toMatch(/<textarea[^>]*disabled=""/)
    expect(markup).toContain('Attach')
    expect(markup).toContain('Send')
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
    expect(withoutFile).toContain('Attach')
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
    expect(markup).toMatch(/Attach/u)
    // The only disabled control in a live composer with an empty draft is Send.
    expect(markup.match(/disabled=""/gu) ?? []).toHaveLength(1)
  })

  it('offers a single ■ that names interrupting THIS turn, not stopping the session', () => {
    // The button calls Core's semantic interrupt, which ends the current turn and leaves the Run alive.
    // Terminating the whole session is a different action living in the Tabbar, so this one must not say
    // "Stop" — a word a user reads as "I lose the session", which makes them afraid to press it. The mark
    // is ■ and the accessible name says "current turn"; the two entry points stay tellable apart.
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
    // The mark carries it: a filled ■ glyph, no word that could be read as ending the session.
    expect(markup).toContain('lucide-square')
    expect(markup).not.toContain('>Stop')
    // Exactly one primary action — Send is not also present while a turn is in flight.
    expect(markup).not.toContain('aria-label="Send"')
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

  it('does not submit while an IME is confirming a candidate', () => {
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

    // macOS/Chromium reports the candidate-confirming Enter with isComposing. Some IMEs use the
    // legacy keyCode=229 instead, so both signals must remain submit-safe.
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      isComposing: true,
      nativeEvent: { isComposing: true },
      keyCode: 13,
      preventDefault
    })
    textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      nativeEvent: { isComposing: false },
      keyCode: 229,
      preventDefault
    })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
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
    const baseRule = styles.match(/\.composer \{([^}]*)\}/)?.[1]
    const focusRule = styles.match(/\.composer:focus-within \{([^}]*)\}/)?.[1]

    expect(baseRule).toContain('background: transparent')
    expect(baseRule).toContain('box-shadow: none')
    expect(focusRule).toContain('box-shadow: var(--focus-ring)')
    expect(focusRule).not.toMatch(/#[0-9a-f]+/i)
  })

  // -------------------------------------------------------------------------
  // 静息态**恰好一行**。
  //
  // 三样东西合起来决定它，缺一个就退化成多行框：`rows={1}`（HTML 的固有高度）、
  // `field-sizing: content`（按内容长高而不是按 rows 定死）、以及 min-height 这道地板。
  // 此前地板写死 `34px`，比真正的一行（1lh + 上下 padding ≈ 26px）高出 8px，于是空的输入框
  // 永远画成两行高，看上去像个多行文本域——这是 #317 那条用户诉求的一半。
  //
  // ─── 判据为什么是「绑定关系」，而不是「1lh 在不在场」───
  //
  // `toContain('1lh')` 是最容易写的判据，且**守不住**：它是一句在场断言，而本仓记过这一族
  // （「presence-assertion-blind-when-shape-repeats」「guard-must-check-reachability-not-presence」）。
  // 换个字面量回来（`min-height: 34px`）会红，但**换一个别的派生式**（`calc(1lh + 8px)`）照旧
  // 全绿——而那正是这条规则要防的漂移：地板与 padding 分开手抄，下次有人调 padding 时地板不跟着
  // 动，两行高会静默回来。
  //
  // 所以判据落在**同一条规则内部的取值关系**上：地板必须由 `1lh` 加上 padding 简写里纵向那两档
  // （top 与 bottom）**逐字**构成。padding 一改，地板的写法必须跟着改，否则这条断言红。
  // border-box（base.css 的 `*`）让 min-height 含 padding，所以「加回纵向两档」不是巧合，
  // 而是几何上必须的那一步。
  //
  // 判据抽成 `floorDerivationProblems`，是为了让它能跑在**合成规则**上（下面那条自检）：
  // 断言自己必须被证明「对着事故当时那份取值会红」，否则整组判据只是花架子。本仓记过
  // 「synthesized-fixture-is-self-certification」——所以主判据跑的是真 CSS，合成规则只用来
  // 证明判据有区分力，两条各管一件事。
  //
  // 这道门**不**保证：它不算级联，也不渲染真浏览器——「1lh 在 Electron 43 上算得对」不在它的
  // 射程内。它保证的是：地板不会变成一个与 padding 脱钩的值。
  // -------------------------------------------------------------------------

  /**
   * 「这条 `.composer textarea` 规则的地板是不是从一行 + 纵向 padding 派生的」——返回问题清单，
   * 空数组表示通过。写成纯函数是为了让合成规则也能过同一组判据。
   */
  function floorDerivationProblems(rule: string): string[] {
    const problems: string[] = []

    const padding = rule.match(/(?:^|;)\s*padding:\s*([^;]+)/)?.[1]?.trim()
    if (!padding) return ['padding 声明解析不出来：纵向两档无从取，判据无法成立']
    const tokens = padding.split(/\s+/)
    // 三值简写：top / 横向 / bottom。份数一变（比如改成四值），下面「纵向是第 0 和第 2 档」的
    // 取法当场失效——那时该红，因为判据自己的前提破了，不是因为地板错了。
    if (tokens.length !== 3) return [`padding 简写不是三值（实测 \`${padding}\`），纵向两档的取法失效`]
    const [padTop, , padBottom] = tokens

    const minHeight = rule.match(/(?:^|;)\s*min-height:\s*([^;]+)/)?.[1]?.trim()
    if (!minHeight) return ['min-height 声明解析不出来：静息地板没人设，rows 与内容会各说各话']

    if (!minHeight.includes('1lh')) {
      problems.push(`地板没有从 \`1lh\` 派生（实测 \`${minHeight}\`）：字号或行高一动它就与一行脱钩`)
    }
    for (const token of new Set([padTop, padBottom])) {
      if (!minHeight.includes(token)) {
        problems.push(
          `地板没有逐字加回 padding 的纵向档 \`${token}\`（实测 \`${minHeight}\`）。border-box 让 min-height ` +
            '含 padding，不加回来地板就比一行矮；写成别的值则与 padding 脱钩，下次调 padding 时两行高会静默回来'
        )
      }
    }
    return problems
  }

  /**
   * 取出那条 `.composer textarea` 基础规则的声明块。
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
    const matches = [...css.matchAll(/\.composer textarea \{([^}]*)\}/g)]
    expect(matches.length, '`.composer textarea` 的基础规则不是恰好一条，按第一条取值会认错对象').toBe(1)
    return matches[0][1]
  }

  it('输入框静息高度恰好一行：地板由 1lh 加 padding 的纵向两档派生，不是脱钩的值', () => {
    // 剥掉注释再判——上面那段解释里逐字写着 `min-height: calc(1lh …`，按原文判会被自己的注释
    // 满足（本仓 #409 的原型事故，见 helpers/styles.ts 的 stripCssComments）。
    const rule = composerTextareaRule(allStyleRules())

    // `field-sizing: content` 是「按内容长高」的那一半。没有它，rows={1} 把高度定死在一行
    // **而且长不高**，多行输入会退化成框内滚动——那是另一个毛病，不是这条规则想要的。
    expect(rule, 'field-sizing 不在场：输入框会被 rows={1} 定死在一行且长不高').toContain('field-sizing: content')

    expect(floorDerivationProblems(rule).join('\n')).toBe('')
  })

  it('自检：这组判据对着事故当时那份取值会红', () => {
    // 少了这条，上面那条会以最难发现的方式假绿：正则写错、取值取空、问题清单永远为空，
    // 三种都让 `.join('')` 恒等于空串，而「判过了」与「没判到」打印出来一模一样。
    //
    // 合成规则用的是**事故当时的真实字节**（`min-height: 34px`，padding 不变），所以它证明的
    // 正是这道门要防的那次回归会被认出来。
    const problems = floorDerivationProblems(
      composerTextareaRule('.composer textarea { min-height: 34px; padding:var(--sp-4) var(--sp-5) var(--sp-1); }')
    )
    expect(problems.length, '把 34px 那份取值喂回去，判据居然一条问题都没报——它守不住任何东西').toBeGreaterThan(0)
    // 报的必须是「脱钩」这件事，不是碰巧因为解析失败而红：解析失败会走前面那几条 early return，
    // 报出来的措辞完全不同，那种红是假红。
    expect(problems.join('\n')).toContain('1lh')
  })

  it('rows={1} 在场：HTML 的固有高度也是一行', () => {
    // CSS 那条门管地板，这条管另一半——`rows` 缺省是 2，光有 min-height 压不住它，因为
    // field-sizing: content 之下固有高度会跟着 rows 走。判在渲染结果上而不是源码文本上。
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: '',
      disabled: false,
      placeholder: 'Ask the Agent…',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onInterrupt: vi.fn(),
      onReferenceActiveFile: vi.fn()
    }))

    expect(markup, 'textarea 没有 rows="1"：固有高度回到 2 行，地板压不住它').toMatch(/<textarea[^>]*rows="1"/)
  })
})
