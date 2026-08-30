import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

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

  it('has tokenized responsive rules for narrow settings windows', () => {
    expect(styles).toContain('@media (max-width: 560px)')
    expect(styles).toContain('.settings-sidebar nav { display: flex;')
    expect(styles).toContain('.settings-content__icon')
    expect(styles).toContain('.settings-content__hint')
    expect(styles).toContain('.settings-sidebar__context')
    expect(styles).not.toContain('background: #')
  })
})
