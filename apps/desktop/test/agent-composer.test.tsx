import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposer } from '../src/renderer/src/components/AgentComposer.js'
import { allStyles } from './helpers/styles.js'

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
})
