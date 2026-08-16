// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentComposer } from '../src/renderer/src/components/AgentComposer'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentComposerTools, nextToolDockPhase } from '../src/renderer/src/components/AgentComposerTools.js'
import { allStyleRules } from './helpers/styles.js'

describe('Message Tools three-state interaction', () => {
  it('cycles from the quiet input through the tool row and a large editor', () => {
    const first = nextToolDockPhase('collapsed')
    const second = nextToolDockPhase(first)
    const third = nextToolDockPhase(second)
    expect([first, second, third]).toEqual(['current', 'expanded', 'collapsed'])
  })

  it('returns from the expanded state to the quiet collapsed state', () => {
    expect(nextToolDockPhase('expanded')).toBe('collapsed')
  })

  // 上面两条只判**档位循环**。它们看不见形态：把三态的两条 CSS 整个删掉，点击照旧在三个档位间
  // 转圈而输入区一动不动，两条全绿。用户要的是「收起成一行 / 两行 / 大输入框」——变的是形态，
  // 档位只是它的名字。所以下面按档位去样式表里找那条真的改变几何的规则。
  //
  // 按 `data-mode='<档位>'` 找而不是按类名找：档位名是组件与样式表之间的契约本身，改任一侧
  // 都会在这里红。剥注释后判（helpers/styles.ts 的 stripCssComments）：这两条规则的理由注释里
  // 逐字写着选择器，按原文判会被自己的注释满足。
  const rules = allStyleRules()

  it('两个非常态档位各自都真的改变了输入区几何——档位循环转圈而形态不动，是这一族的假绿形状', () => {
    // 一行态：编辑区与工具/主动作同排，所以**根元素自己**必须换布局轴；两行态是基础规则本身，
    // 它按定义没有自己的规则（补一条"恢复默认"等于把同一个几何写两遍，两处必然漂移）。
    //
    // 只取选择器落在根元素上的那一条，不是「所有命中 collapsed 的规则」——实测：把
    // `display: grid; grid-template-columns: …` 整个删掉，一条按并集判的断言照旧全绿，因为
    // 同族里那条藏工具的规则带着 `display: none`，旁证替被测判据交了差（本仓「判据键不能同时进
    // 两族」）。所以这里按选择器形状把那一条摘出来单判。
    const collapsedRoot = [...rules.matchAll(/([^{}\n]*)\{([^{}]*)\}/g)]
      .filter(([, selector]) => /^\s*\.composer:has\(\.composer-tools\[data-mode='collapsed'\]\)\s*$/.test(selector!))
    expect(
      collapsedRoot.length,
      "没有一条规则只落在 .composer 根元素上并按 data-mode='collapsed' 命中：一行态没有改变输入区自身"
    ).toBe(1)
    expect(
      collapsedRoot[0]![2]!,
      '一行态没有换布局轴——输入行与主动作不会同排，"收起成一行"这个名字没有对应的几何'
    ).toMatch(/(?:display|grid-template-columns):/)

    // 大输入框态：放高输入区。它改的是高度预算变量，而**不是**就地再写一条
    // `.composer__editor .tiptap { max-height }`——那会让那个选择器在全表出现两次，
    // agent-composer.test.tsx 的地板判据按「基础规则恰好一条」取值就会认错对象（实测红）。
    // 所以这里判两侧：档位真的改了预算，且基础规则真的在读这个预算——只判前者的话，
    // 一个没有任何消费者的变量看起来一模一样（本仓「声明了却静默不做的能力」）。
    const expanded = [...rules.matchAll(/([^{}]*\[data-mode='expanded'\][^{}]*)\{([^{}]*)\}/g)]
    expect(expanded.length, "样式表里没有任何规则按 data-mode='expanded' 命中：大输入框态不存在").toBeGreaterThan(0)
    const expandedBody = expanded.map(([, , body]) => body!).join(' ')
    expect(expandedBody).toContain('--composer-input-height: min(240px, 40vh)')
    const editors = [...rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(([, selector]) => selector!.trim() === '.composer__editor .tiptap')
    expect(editors).toHaveLength(1)
    expect(editors[0]![2]).toContain('height: var(--composer-input-height, auto)')

    expect(expandedBody, '大输入框态没有改动高度预算——"大输入框"这个名字没有对应的几何').toMatch(/--composer-input-max:/)
    expect(expandedBody, '大输入框态动了 min-height：静息地板会多出第二处，空输入框被抬成两行高').not.toMatch(/min-height:/)
    expect(
      rules,
      '基础规则没有消费 --composer-input-max：那个变量没有消费者，档位改了它也什么都不会发生'
    ).toMatch(/\.composer__editor \.tiptap \{[^}]*max-height:\s*var\(--composer-input-max\)/)
  })

  // 一行态**真的只有一行**。上面那条只判了根元素换没换布局轴——而用户报的「叠在一起」不是轴的事：
  // 轴换对了，压上来的是另外两样东西。所以这两样各自要有判据，否则把它们的修复整个删掉，上面那条
  // 照旧全绿（实测：两个变异体都存活）。
  //
  // 两样东西都**从样式表反推**，不维护一份手写清单：清单会和样式表一起漂移，漂移时它自己不会响。
  // 判据因此是「凡是符合这个形状的选择器，一行态都必须处理掉」——下一个人在 Composer 里加一处
  // 绝对定位装饰或一处 wrap，这里会要求他对一行态做出决定，而不是等用户再截一张图。
  const COLLAPSED = ".composer:has(.composer-tools[data-mode='collapsed'])"
  const ruleList = [...rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector!.trim(),
    body: body!
  }))
  /** 一行态下对某个落点生效的全部覆写，按「去掉前缀后的选择器」归拢。 */
  const collapsedOverrides = new Map<string, string>()
  for (const { selector, body } of ruleList) {
    if (!selector.startsWith(COLLAPSED)) continue
    const target = selector.slice(COLLAPSED.length).trim()
    collapsedOverrides.set(target, `${collapsedOverrides.get(target) ?? ''}${body}`)
  }

  it('gives toolbar controls a shared fixed height in all modes', () => {
    const shared = ruleList.filter(({ selector }) => selector.includes('.composer__toolbar :is('))
    expect(shared).toHaveLength(1)
    expect(shared[0]!.body).toContain('height: var(--sp-7)')
    expect(shared[0]!.body).toContain('padding-block: 0')
    expect(shared[0]!.selector).toContain('.composer-tool')
    expect(shared[0]!.selector).toContain('.composer-send')
    expect(shared[0]!.selector).toContain('.composer__inbox')
  })

  it('keeps identity in the control flow instead of overlaying the editor', () => {
    // 形状：`position: absolute` **且**钉了边距。钉边距才会脱离静态位置跑到盒子角上，而一行态里
    // 右上角与右下角都被控件占着，于是装饰直接压在按钮上（用户原话「叠在一起」）。
    // 不判 `position: fixed` 那两张卡：它们走 `popover` 进顶层、由 anchor 定位，且是用户点开的
    // 临时浮层，不是静息装饰。也不判没钉边距的那个 placeholder ::before——它待在静态位置，
    // 就在编辑区里，一行态下并不挪窝。
    expect(ruleList.length).toBeGreaterThan(0)
    const decorations = ruleList
      .filter(({ selector, body }) => selector.startsWith('.composer') && !selector.startsWith(COLLAPSED))
      .filter(({ body }) => /position:\s*absolute/.test(body) && /(?:^|;)\s*(?:top|right|bottom|left):/.test(body))
      .map(({ selector }) => selector)
    expect(decorations).toEqual([])

  })

  it('一行态里不许有 wrap——右列宽度由内容决定，一折行按钮就叠成两层', () => {
    // 这是「叠在一起」的第二个来源，和上面那条是两件事：一个压的是装饰，一个是控件自己叠自己。
    // 一行态的右列是 `auto`，宽度由内容决定；两行态那份 `flex-wrap: wrap` 继承下来，窄宽度下
    // 按钮就折成第二层，而这一行的高度只够一层。
    expect(ruleList.length).toBeGreaterThan(0)
    const wrapping = ruleList
      .filter(({ selector, body }) => selector.startsWith('.composer') && !selector.startsWith(COLLAPSED))
      .filter(({ body }) => /flex-wrap:\s*wrap/.test(body))
      .map(({ selector }) => selector)
    expect(wrapping).toEqual([])

  })

  it('自检：这个取值口认得出档位规则的缺席，否则上面那条只是恒绿', () => {
    // 判据自己的区分力：把两个档位选择器从表里抹掉，上面每一条 `toBeGreaterThan(0)` 都必须够不着。
    // 不抹掉就断言"能找到"，等于只证明了字符串在场，不证明找不到时会红。
    const scrubbed = rules.replace(/\[data-mode='(?:collapsed|expanded)'\]/g, "[data-mode='none']")
    expect([...scrubbed.matchAll(/\[data-mode='collapsed'\]/g)]).toHaveLength(0)
    expect([...scrubbed.matchAll(/\[data-mode='expanded'\]/g)]).toHaveLength(0)
    // 而原表里两者都真的在——上一条不是在一个空表上成立的空话。
    expect([...rules.matchAll(/\[data-mode='collapsed'\]/g)].length).toBeGreaterThan(0)
    expect([...rules.matchAll(/\[data-mode='expanded'\]/g)].length).toBeGreaterThan(0)
  })

  it('has one reachable layout control even when Agent input is unavailable', () => {
    const markup = renderToStaticMarkup(createElement(AgentComposerTools, {
      disabled: true, commands: [], loadSkills: async () => [],
      onChooseSkill: vi.fn(), onCommand: vi.fn(), runAction: async (action: () => void | Promise<void>) => { await action() }
    }))
    expect(markup.match(/composer-tool--mode/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Show the message tool row"')
    expect(markup).toContain('lucide-panel-bottom-open')
    expect(markup).not.toContain('disabled=""')
    const composer = readFileSync(resolve(import.meta.dirname, '../src/renderer/src/components/AgentComposer.tsx'), 'utf8')
    const toolbar = composer.indexOf('<div className="composer__toolbar">')
    const tools = composer.indexOf('{tools}', toolbar)
    const fileButton = composer.indexOf('<button', toolbar)
    expect(toolbar).toBeGreaterThan(-1)
    expect(tools).toBeGreaterThan(toolbar)
    expect(fileButton).toBeGreaterThan(tools)
    expect(composer.slice(toolbar, fileButton)).toContain('{tools}')
  })

  it('keeps the trigger group before the editor and the primary action after it in one-line mode', () => {
    for (const [selector, column] of [
      [".composer__toolbar > div:first-child", 1],
      [".composer__editor", 2],
      [".composer__toolbar > div:last-child", 3]
    ] as const) {
      expect(collapsedOverrides.has(selector)).toBe(true)
      expect(collapsedOverrides.get(selector)).toContain(`grid-column: ${column}`)
    }
    const root = ruleList.find(({ selector }) => selector === COLLAPSED)
    expect(root).toBeDefined()
    expect(root!.body).toContain('grid-template-columns: auto minmax(0, 1fr) auto')
  })
})


it('cycles the real Composer without replacing its editor or draft, with a distinct next-action icon', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onChange = vi.fn()
  try {
    await act(async () => root.render(createElement(AgentComposer, {
      value: 'Keep [review](agentmux-skill:%40%2Fskills%2Freview%2FSKILL.md)',
      disabled: false, placeholder: 'Message', onChange,
      tools: createElement(AgentComposerTools, { disabled: false, commands: [], loadSkills: async () => [],
        onChooseSkill: vi.fn(), onCommand: vi.fn(), runAction: async (action: () => void | Promise<void>) => { await action() } })
    })))
    const editor = container.querySelector('.tiptap')
    expect(editor).not.toBeNull()
    const text = editor!.textContent
    expect(text).toContain('Keep')
    expect(editor!.querySelectorAll('.composer-semantic-token')).toHaveLength(1)
    const expected = [
      ['collapsed', 'Show the message tool row', 'lucide-panel-bottom-open'],
      ['current', 'Grow the input box for long text', 'lucide-maximize2'],
      ['expanded', 'Collapse the composer to one line', 'lucide-minimize2'],
      ['collapsed', 'Show the message tool row', 'lucide-panel-bottom-open']
    ]
    for (const [mode, label, icon] of expected) {
      const buttons = container.querySelectorAll<HTMLButtonElement>('.composer-tool--mode')
      expect(buttons).toHaveLength(1)
      expect(container.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe(mode)
      expect(buttons[0]!.getAttribute('aria-label')).toBe(label)
      expect(buttons[0]!.querySelector('svg')?.classList.contains(icon!)).toBe(true)
      expect(container.querySelector('.tiptap')).toBe(editor)
      expect(editor!.textContent).toBe(text)
      expect(editor!.querySelectorAll('.composer-semantic-token')).toHaveLength(1)
      await act(async () => buttons[0]!.click())
    }
    expect(onChange).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('uses the Region width to shed tool text while retaining labelled icon controls', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/renderer/src/styles/composer.css'), 'utf8')
  const start = css.indexOf('@container composer (max-width: 560px)')
  const end = css.indexOf('\n.composer__toolbar > div:first-child', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const narrow = css.slice(start, end)
  expect(narrow).toContain('.composer-tool__label { display: none; }')
  expect(narrow).not.toMatch(/\.composer-tool\s*\{[^}]*display:\s*none/)
  expect(css).toContain('container-type: inline-size; container-name: composer')
  const markup = renderToStaticMarkup(createElement(AgentComposerTools, {
    disabled: false, layoutControl: false, commands: [{ text: '/status', description: 'Status' }],
    loadSkills: async () => [], onChooseSkill: vi.fn(), onCommand: vi.fn(), onCapture: async () => {}, runAction: async (action: () => void | Promise<void>) => { await action() }
  }))
  expect(markup).toContain('aria-label="Capture a screen region"')
  expect(markup).toContain('aria-label="Choose a skill"')
  expect(markup).toContain('aria-label="Choose a command"')
  expect(markup.match(/class="composer-tool__label"/g)).toHaveLength(3)
})

it('clips an empty editor placeholder to its own input column at narrow widths', () => {
  const css = allStyleRules()
  const editor = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].find(([, selector]) => selector!.trim() === '.composer__editor .tiptap')
  const placeholder = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].find(([, selector]) => selector!.includes('.tiptap:has(') && selector!.includes('::before'))
  expect(editor).toBeDefined()
  expect(placeholder).toBeDefined()
  expect(editor![2]).toContain('position: relative')
  expect(placeholder![2]).toContain('white-space: nowrap')
  expect(placeholder![2]).toContain('overflow: hidden')
  expect(placeholder![2]).toContain('max-width: calc(100% - 2 * var(--sp-5))')
})
