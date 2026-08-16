import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextToolDockPhase } from '../src/renderer/src/components/AgentComposerTools.js'
import { allStyleRules } from './helpers/styles.js'

describe('Message Tools three-state interaction', () => {
  it('collapses first, restores the current density, then expands to multiple tools', () => {
    const first = nextToolDockPhase('current')
    const second = nextToolDockPhase(first)
    const third = nextToolDockPhase(second)
    expect([first, second, third]).toEqual(['collapsed', 'restored', 'expanded'])
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

  it('一行态里绝对定位的装饰必须收掉——它们的落点正是工具条与 Send 的位置', () => {
    // 形状：`position: absolute` **且**钉了边距。钉边距才会脱离静态位置跑到盒子角上，而一行态里
    // 右上角与右下角都被控件占着，于是装饰直接压在按钮上（用户原话「叠在一起」）。
    // 不判 `position: fixed` 那两张卡：它们走 `popover` 进顶层、由 anchor 定位，且是用户点开的
    // 临时浮层，不是静息装饰。也不判没钉边距的那个 placeholder ::before——它待在静态位置，
    // 就在编辑区里，一行态下并不挪窝。
    const decorations = ruleList
      .filter(({ selector, body }) => selector.startsWith('.composer') && !selector.startsWith(COLLAPSED))
      .filter(({ body }) => /position:\s*absolute/.test(body) && /(?:^|;)\s*(?:top|right|bottom|left):/.test(body))
      .map(({ selector }) => selector)
    // 扫描有收获，且收获的是那个已知的载体——扫到空、或者扫到一堆别的东西，下面的循环都恒真。
    expect(decorations, 'Composer 里没有扫到任何绝对定位装饰：这条判据在一个空集合上恒成立').toEqual([
      '.composer__region'
    ])
    for (const selector of decorations) {
      expect(
        collapsedOverrides.get(selector) ?? '',
        `${selector} 在一行态里没有被收掉：它钉在盒子角上，而那里正是工具条与 Send，压出来的是糊成一团`
      ).toMatch(/display:\s*none/)
    }
  })

  it('一行态里不许有 wrap——右列宽度由内容决定，一折行按钮就叠成两层', () => {
    // 这是「叠在一起」的第二个来源，和上面那条是两件事：一个压的是装饰，一个是控件自己叠自己。
    // 一行态的右列是 `auto`，宽度由内容决定；两行态那份 `flex-wrap: wrap` 继承下来，窄宽度下
    // 按钮就折成第二层，而这一行的高度只够一层。
    const wrapping = ruleList
      .filter(({ selector, body }) => selector.startsWith('.composer') && !selector.startsWith(COLLAPSED))
      .filter(({ body }) => /flex-wrap:\s*wrap/.test(body))
      .map(({ selector }) => selector)
    expect(wrapping, 'Composer 里没有扫到任何 wrap：这条判据在一个空集合上恒成立').toEqual([
      '.composer__toolbar',
      '.composer__toolbar > div'
    ])
    for (const selector of wrapping) {
      expect(
        collapsedOverrides.get(selector) ?? '',
        `${selector} 在一行态里仍然允许折行：窄宽度下它的按钮会叠成两层`
      ).toMatch(/flex-wrap:\s*nowrap|display:\s*none/)
    }
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

  it('收起/展开只有一个入口——第二个共用同一枚图标的入口已废止', () => {
    // 用户原话「而不是右边那个 collapse」。判据不是"disclosure 的类名没了"（换个类名即绕过），
    // 而是**渲染 message-tools 这枚图标的收起/展开控件全表只有一处**：重复之所以是重复，是因为
    // 同一枚图标出现在两处而用户无从区分。WorkflowComponentGallery 那处是画廊里的一个目录链接，
    // 不是 Composer 的控件，所以只数 Composer 这两个文件。
    const composerSources = ['AgentComposer.tsx', 'AgentComposerTools.tsx']
    const carriers = composerSources.flatMap((name) => {
      const source = readFileSync(resolve(import.meta.dirname, '../src/renderer/src/components', name), 'utf8')
      return [...source.matchAll(/name="message-tools"/g)].map(() => name)
    })
    expect(carriers, 'Composer 里渲染 message-tools 图标的控件不止一处：收起入口又长回了两个').toEqual([
      'AgentComposerTools.tsx'
    ])
  })
})
