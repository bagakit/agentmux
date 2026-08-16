import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposer } from '../src/renderer/src/components/AgentComposer.js'
import { AgentComposerTools } from '../src/renderer/src/components/AgentComposerTools.js'
import { allStyleRules } from './helpers/styles.js'

// 四条 Composer 表单/动作诉求（interaction SSOT「Composer 静息形态与主操作」）：
//   1. 静息即一行；2. 切换键两行态重排、一行态更弱；3. Send/Interrupt 收成图标但保住区分；
//   4. Cmd/Ctrl+Enter 直接 steer，与裸 Enter 的"常规发送"两个意图互不退化。
//
// keydown 用例把组件当函数调，读 InlineComposer 那层的 onKeyDown——与 agent-composer.test.tsx 同一
// 套路。断言两个方向都判：不只证明 Cmd+Enter 会 steer，还证明裸 Enter 在该排队时**不** steer、
// 且 Cmd+Enter 不会既 steer 又排队（不双触发）。

describe('Composer 静息即一行（诉求 1）', () => {
  it('AgentComposerTools 默认档位是 collapsed——工具排收起，只留切换键', () => {
    // 默认 useState 是 'collapsed'：静息态 data-mode 就是 collapsed，且这一档下工具行整排不渲染
    // （Skills/Commands 都不出现）。把默认改回 'current' 时 data-mode 变 current、Skills 出现——红。
    const markup = renderToStaticMarkup(createElement(AgentComposerTools, {
      disabled: false,
      commands: [{ text: '/status', description: 'Session status' }],
      loadSkills: async () => [],
      onChooseSkill: vi.fn(),
      onCommand: vi.fn(),
      runAction: async (action: () => void | Promise<void>) => { await action() }
    }))
    expect(markup, '静息态不是 collapsed：输入框一上来就是两行').toContain('data-mode="collapsed"')
    // 反面锚点：collapsed 档下工具排隐藏，这两个只在展开档才渲染。缺了它们证明确实收起了。
    expect(markup, 'collapsed 档下 Skills 仍在渲染：工具排没有收起').not.toContain('Skills')
    expect(markup).not.toContain('Commands')
  })
})

describe('切换键的位置与密度（诉求 2）', () => {
  const rules = allStyleRules()

  it('切换键不再排到工具末尾，三档保持在左边', () => {
    const base = [...rules.matchAll(/([^{}\n]*)\{([^{}]*)\}/g)]
      .filter(([, selector]) => /^\s*\.composer-tool--mode\s*$/.test(selector!))
    // 扫描有收获：基础规则恰好一条，否则下面按 [0] 取值会认错对象。
    expect(base.length, '.composer-tool--mode 的基础规则不是恰好一条').toBe(1)
    expect(base[0]![2]!).not.toMatch(/order:/)
  })

  it('一行态里切换键更矮更淡——最安静的形态里控件也最安静（诉求 2b）', () => {
    // 一行态对 .composer-tool--mode 的覆写：压掉纵向 padding（更矮）+ 调淡（存在感更弱）。
    const collapsed = [...rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(([, selector]) => /\.composer:has\(\.composer-tools\[data-mode='collapsed'\]\)\s+\.composer-tool--mode\s*$/.test(selector!.trim()))
    expect(collapsed.length, '一行态没有任何针对切换键的覆写：它仍沿用两行态那份更强的存在感')
      .toBeGreaterThan(0)
    const body = collapsed.map(([, , declarations]) => declarations!).join(' ')
    expect(body, '一行态没有压掉切换键的纵向 padding：它没有变矮').toMatch(/padding:/)
    expect(body, '一行态没有调淡切换键：它的存在感没有降下来').toMatch(/opacity:/)
  })
})

describe('Send 与 Interrupt 收成图标但保住区分（诉求 3）', () => {
  it('Stop 形态：↑ steer（绿）与 ■ interrupt（红）是两个不同图标、两种颜色语汇', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposer, {
      value: 'steer me',
      disabled: false,
      placeholder: 'Ask the Agent…',
      primaryAction: 'stop',
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      onInterrupt: vi.fn()
    }))
    // 图形区分：steer 是箭头，interrupt 是方块——收成图标不等于两个键长一样。
    expect(markup, 'steer 键没有箭头图标').toContain('lucide-arrow-up')
    expect(markup, 'interrupt 键没有方块图标').toContain('lucide-square')
    // 颜色语汇（Design Control Language）：推进走绿的 --secondary，破坏性走红的 --working。
    expect(markup, 'steer 键不是绿的推进色').toContain('composer-send--secondary')
    expect(markup, 'interrupt 键不是红的破坏性色').toContain('composer-send--working')
    // 收成图标后不再带文字标签，但可访问名把两者分得清清楚楚（破坏性区分不随文字消失而消失）。
    expect(markup).toContain('aria-label="Send steer"')
    expect(markup).toContain('aria-label="Interrupt the current turn"')
    expect(markup, 'interrupt 变回了会被读成「结束会话」的 Stop 字样').not.toContain('>Stop')
  })
})

// -----------------------------------------------------------------------------
// Cmd/Ctrl+Enter 直接 steer（诉求 4）。
//
// 语义：裸 Enter 走「常规发送」——忙时（onQueue 在场）排进下一轮，闲时直接提交；Cmd/Ctrl+Enter 走
// 「插进当前这一轮」——无论忙闲都调 onSubmit（交付/mid-turn 是 Core 的判断）。两个意图绝不互相退化。
// -----------------------------------------------------------------------------
describe('Cmd/Ctrl+Enter 直接 steer（诉求 4）', () => {
  type KeyTree = { props: { children: [{ props: { onKeyDown(event: unknown, caret?: number): void } }, ...unknown[]] } }

  function keydown(
    props: Parameters<typeof AgentComposer>[0],
    event: Record<string, unknown>
  ): { preventDefault: ReturnType<typeof vi.fn> } {
    const tree = AgentComposer(props) as unknown as KeyTree
    const preventDefault = vi.fn()
    tree.props.children[0].props.onKeyDown({ key: 'Enter', shiftKey: false, ...event, preventDefault })
    return { preventDefault }
  }

  it('闲着时 Cmd+Enter 有确定含义：照常提交，不是 no-op', () => {
    // 设计约束：Agent 闲着时 Cmd+Enter 也必须有确定含义。没有「当前 turn」可插，它就是常规提交
    // （send() 开新一轮），而不是什么都不做。
    const onSubmit = vi.fn()
    const { preventDefault } = keydown(
      { value: 'go', disabled: false, placeholder: 'Ask…', primaryAction: 'send', onChange: vi.fn(), onSubmit },
      { metaKey: true }
    )
    expect(onSubmit, '闲着时 Cmd+Enter 什么也没做——它成了 no-op').toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('Ctrl+Enter 与 Cmd+Enter 等价（跨平台的同一个意图）', () => {
    const onSubmit = vi.fn()
    keydown(
      { value: 'go', disabled: false, placeholder: 'Ask…', primaryAction: 'send', onChange: vi.fn(), onSubmit },
      { ctrlKey: true }
    )
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('忙时 Cmd+Enter 插进当前这一轮（onSubmit），不是排进下一轮（onQueue）', () => {
    const onSubmit = vi.fn()
    const onQueue = vi.fn()
    keydown(
      { value: 'steer now', disabled: false, placeholder: 'Ask…', primaryAction: 'stop', onChange: vi.fn(), onSubmit, onQueue },
      { metaKey: true }
    )
    expect(onSubmit, '忙时 Cmd+Enter 没有直接 steer').toHaveBeenCalledTimes(1)
    expect(onQueue, 'Cmd+Enter 退化成了排队——两个意图混了').not.toHaveBeenCalled()
  })

  it('反面：忙时裸 Enter 走常规发送（排队），**不** steer', () => {
    // 没有这条，把 Cmd+Enter 分支删掉、让裸 Enter 也 steer，前面几条照样绿。裸 Enter 忙时必须排队。
    const onSubmit = vi.fn()
    const onQueue = vi.fn()
    keydown(
      { value: 'later', disabled: false, placeholder: 'Ask…', primaryAction: 'stop', onChange: vi.fn(), onSubmit, onQueue },
      {}
    )
    expect(onQueue, '裸 Enter 忙时没有排队').toHaveBeenCalledTimes(1)
    expect(onSubmit, '裸 Enter 忙时直接 steer 了——它退化成了 Cmd+Enter 的意图').not.toHaveBeenCalled()
  })

  it('Cmd+Enter 不双触发——只 steer 一次，不同时排队', () => {
    const onSubmit = vi.fn()
    const onQueue = vi.fn()
    keydown(
      { value: 'once', disabled: false, placeholder: 'Ask…', primaryAction: 'stop', onChange: vi.fn(), onSubmit, onQueue },
      { metaKey: true }
    )
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onQueue).not.toHaveBeenCalled()
  })

  it('不能提交时 Cmd+Enter 也不提交——canSubmit 门对它同样成立', () => {
    // disabled（canSubmit false）时 Cmd+Enter 不得越过提交门；否则它成了绕过「面此刻不能写」的后门。
    const onSubmit = vi.fn()
    const { preventDefault } = keydown(
      { value: 'blocked', disabled: true, placeholder: 'Agent is not running', primaryAction: 'send', onChange: vi.fn(), onSubmit },
      { metaKey: true }
    )
    expect(onSubmit, 'disabled 时 Cmd+Enter 仍然提交了').not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('待答卡片状态下 Cmd+Enter 不退化成排队——canSubmit 为 false 时它落空但也不排队', () => {
    // 承重反例：待答卡片时 onSubmit 缺席（canSubmit=false）、onQueue 在场、primaryAction=stop。
    // Cmd+Enter 从 steer 分支落空后，若 QUEUE 分支不带 `!metaKey` 守卫就会把它接走（退化成裸 Enter 的
    // "排队"意图）。这一条钉住那道守卫：Cmd+Enter 在这里既不 submit（本就不能）也不 queue。
    const onQueue = vi.fn()
    const { preventDefault } = keydown(
      { value: 'card is up', disabled: false, placeholder: 'Answer…', primaryAction: 'stop', onChange: vi.fn(), onQueue },
      { metaKey: true }
    )
    expect(onQueue, 'Cmd+Enter 在待答卡片下退化成了排队——两个意图混了').not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })
})
