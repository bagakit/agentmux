import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allStyleRules, allStyles } from './helpers/styles.js'

const panel = readFileSync(new URL('../src/renderer/src/components/SettingsPanel.tsx', import.meta.url), 'utf8')
const styles = allStyles()

describe('settings workbench shell', () => {
  /**
   * 壳层的每个位次都由**它自己的类名**选中，而不是靠"它恰好是第几个子元素"。
   *
   * 病史：header 上写着 `className="settings-content__header"`，而**七条**规则全写成
   * `.settings-content > header`（位置选择器）。类名一条规则都没选中，`rendered-class-has-rule`
   * 那道门因此一直红着。而本文件当时只断言 `panel.toContain('settings-content__header')`——
   * 类名**作为源码文本**在场，这在"它被样式表选中"和"它什么都不是"两种世界里同样为真，
   * 于是这条断言什么都没记录（记忆 assertion-passing-under-both-behaviors-records-nothing）。
   *
   * 判据因此改成**类名与规则的对应**：每个壳层类都要真有规则选中它。位置选择器还有第二个
   * 代价——在 header 前插入任何一个元素都会静默改变哪个元素被选中，而没有任何测试会红。
   */
  it('每个壳层位次都由自己的类名选中，不靠它在 DOM 里排第几', () => {
    const shellClasses = [
      'settings-content__header',
      'settings-content__title',
      'settings-content__close',
      'settings-content__breadcrumb',
      'settings-content__actions',
      'settings-sidebar__context'
    ]
    for (const token of shellClasses) {
      expect(panel, `${token} 没有渲染出来`).toContain(token)
      // 规则里出现 `.token` 且后面不接标识符字符——`.settings-content__header h2` 算，
      // `.settings-content__headerfoo` 不算。
      expect(
        new RegExp(`\\.${token}(?![\\w-])`, 'u').test(styles),
        `${token} 渲染了却没有任何规则选中它——要么类名拼错，要么规则还写成位置选择器`
      ).toBe(true)
    }
    // 位置选择器一条都不许留：它会在插入元素时静默换掉被选中的那个。
    expect(styles, '还有规则靠 `.settings-content > header` 按位置选中壳层').not.toContain('.settings-content > header')
    expect(panel).toContain('onClick={onClose}')
  })

  /**
   * 窄窗口下设置页真的**写了**收窄规则，而不是"那几个类名在样式表里出现过"。
   *
   * 这是静态判据：它读拼起来的样式表，问 560px 那一档**里面**有没有那几条收窄规则。它不在 560px
   * 下渲染、不量真实盒子——所以它证的是"规则在"，不是"看起来收窄了"。这条边界写在这里而不是
   * 假装覆盖全：一条读起来比实际强的断言，比一条明说自己边界的断言更危险。
   *
   * 病史（2026-09-25）：这条原先写成 `expect(styles).toContain('.settings-content__icon')` 一类的
   * 全表子串判断。那几个类**都有自己的基础规则**（`.settings-sidebar__context`、
   * `.settings-content__icon`、`.settings-content__hint` 在 `surfaces.css` 顶层各有一条，都排在
   * 560px 那一档之前），于是子串在「窄窗口规则还在」和「窄窗口规则被删光」两种世界里同样为真
   * ——断言什么都没记录（记忆 assertion-passing-under-both-behaviors-records-nothing）。
   *
   * 实测：把 560px 块里四条规则删掉（侧栏上下文、搜索条高度、icon、hint 在手机宽度下不再收起），
   * 只留下测试恰好 grep 的那一句字面量——**两条全绿**。所以判据改成先把那个 media 块整段切出来，
   * 再在**块内**问每条收窄行为在不在。
   *
   * 切块用配对花括号数，不用 `indexOf('}')`：块里每条规则自己就带一对花括号，
   * 取第一个 `}` 会切出只含一条规则的碎片，之后每条 `toContain` 都容易恒假（假红）或恒真（假绿）。
   *
   * 找块也不能只 `indexOf('@media (max-width: 560px)')`：这张拼起来的总表里 **560px 这一档不止一个**
   * （`surfaces.css` 与 `workflow.css` 各有一个）。今天 `indexOf` 拿到对的那个，靠的只是
   * `index.css` 里 surfaces 排在 workflow 前面——改一次 @import 顺序，这份判据就会对着 workflow 的
   * 块提问，六条全红（假红）或更糟。所以要在候选块里按**内容**认领：哪个块真的在改设置页的规则。
   *
   * 注释里刻意**不写行号**：行号会随任何一次插入静默变假，而没有任何守卫会因此变红。
   * 这条注释的上一版就踩了——它按 `97/118/124` 的顺序点名三个类，而那三行上的类其实是
   * 另一个排列（97 是 `__context`，118 才是 `__icon`）。类名本身 grep 得到，行号 grep 不到。
   */
  it('窄窗口那一档写了收窄规则，不只是类名在表里出现过', () => {
    const rules = allStyleRules()

    /** 从 `@media` 开头切到它配对的那个 `}`。 */
    function blockAt(start: number): string {
      const open = rules.indexOf('{', start)
      let depth = 0
      for (let i = open; i < rules.length; i += 1) {
        if (rules[i] === '{') depth += 1
        else if (rules[i] === '}') { depth -= 1; if (depth === 0) return rules.slice(start, i + 1) }
      }
      return ''
    }

    const candidates: string[] = []
    for (const match of rules.matchAll(/@media\s*\(max-width:\s*560px\)/gu)) candidates.push(blockAt(match.index!))
    expect(candidates.length, '手机宽度那一档整个不见了——设置页在窄窗口下不再收窄').toBeGreaterThan(0)

    // 按内容认领，不按出现顺序：总表里别的表面也有 560px 档。
    const owned = candidates.filter((block) => block.includes('.settings-'))
    expect(
      owned,
      `560px 这一档里没有一个在改设置页（共 ${candidates.length} 个候选）——` +
        '设置页的窄窗口规则被整块删了，或者搬去了另一个断点'
    ).toHaveLength(1)
    const narrow = owned[0]!
    // 非空见证：切出来是空串或没闭合时，下面每条 toMatch 都会失真。
    expect(narrow.endsWith('}'), '切出来的块没有闭合——范围不可信，下面每条判据都会失真').toBe(true)
    expect(narrow.length, '切出来的 560px 块太短，不像一整块规则——这份判据在空转').toBeGreaterThan(200)

    // 每一条都是"窄窗口下这个表面必须让位"的具体行为。少任何一条，手机宽度就挤成一团。
    const collapses: Array<[string, RegExp]> = [
      ['侧栏从左右并排改成上下堆叠', /\.settings-page\s*\{[^}]*flex-direction:\s*column/u],
      ['侧栏导航横向滚动而不是竖排', /\.settings-sidebar nav\s*\{[^}]*display:\s*flex/u],
      ['侧栏的说明段落收起', /\.settings-sidebar__context\s*\{[^}]*display:\s*none/u],
      ['主区 header 不再吸顶', /\.settings-content__header\s*\{[^}]*position:\s*relative/u],
      ['主区大图标收起', /\.settings-content__icon\s*\{[^}]*display:\s*none/u],
      ['键盘提示收起', /\.settings-content__hint\s*\{[^}]*display:\s*none/u]
    ]
    const missing = collapses.filter(([, pattern]) => !pattern.test(narrow)).map(([why]) => why)
    expect(
      missing,
      `窄窗口下这些收窄行为没有了：\n${missing.join('\n')}\n` +
        '（类名在样式表别处有基础规则，所以全表 toContain 判不出这件事——实测删掉这几条仍全绿）'
    ).toEqual([])

    // 导航按钮在窄窗口下仍要能看见文字标签：只留图标就不可发现了（A2「侧栏导航保持可发现」）。
    expect(
      narrow,
      '窄窗口下导航按钮的文字被藏了，只剩图标——侧栏导航不再可发现'
    ).toMatch(/\.settings-sidebar nav > button > span\s*\{[^}]*display:\s*block/u)
  })

  it('颜色一律走 token，不在设置页硬编码十六进制', () => {
    expect(allStyleRules(), '样式表里出现了硬编码颜色').not.toContain('background: #')
  })
})
