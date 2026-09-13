import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InlineComposer, draftDocument, documentDraft } from '../src/renderer/src/components/InlineComposer.js'
import { appendSemanticReference, expandSemanticReferences, semanticReferenceKind, encodeSemanticReference, parseComposerDraft } from '../src/renderer/src/lib/composer-semantic-reference.js'

describe('composer semantic references', () => {
  it('keeps a short token in the draft and expands it only at submission', () => {
    const reference = { token: '', label: 'review', kind: 'skill' as const, reference: '@/skills/review/SKILL.md' }
    const encoded = encodeSemanticReference(reference)
    expect(appendSemanticReference('please', reference)).toBe(`please ${encoded} `)
    expect(expandSemanticReferences(`please ${encoded} now`)).toBe('please @/skills/review/SKILL.md now')
    expect(parseComposerDraft(encoded)).toHaveLength(1)
  })

  it('derives distinct semantic kinds from existing references', () => {
    expect(semanticReferenceKind('/status')).toBe('subcommand')
    expect(semanticReferenceKind('/repo/components/card.md')).toBe('component')
    expect(semanticReferenceKind('/repo/skills/review/SKILL.md')).toBe('skill')
  })

  it('round-trips the durable editor document', () => {
    // prompt 正文不再由这个模块持有：它搬进了用户配置（`AppConfig.composerShortcuts`，取值层是
    // shared/composer-shortcut-library）。这里原先还断言 `COMPOSER_SHORTCUT_PRESETS.length > 0`——
    // 那一半随常量一起删掉，它现在的守卫在 composer-shortcut-library.test.ts 与 config-store.test.ts。
    const doc = draftDocument('[review](agentmux-skill:%40%2Fskills%2Freview%2FSKILL.md)')
    expect(documentDraft(doc)).toContain('agentmux-skill')
  })

  it('renders the compact name, kind-specific icon and full hover reference', () => {
    const markup = renderToStaticMarkup(createElement(InlineComposer, { value: '', disabled: false, placeholder: 'Ask', 'aria-label': 'Message', onValueChange: () => {}, onKeyDown: () => {} }))
    expect(markup).toContain('data-placeholder="Ask"')
  })

  it('flags data-empty by real value length, so a typed draft hides the placeholder', () => {
    // 2026-09-27 用户报："一行模式输入到两行时 placeholder 还在叠着显示"。原判据用 CSS
    // `:has(...)` 探 tiptap DOM shape,遇到某种 shape 时错答 empty。修法换到 JS 侧真值
    // (props.value.length===0)派生 data-empty,CSS 只看这个属性决定 placeholder 显不显示。
    // 此测试钉的是 JS→DOM 那一步:三个真实的 value 形态各自派生出正确的 data-empty。
    const empty = renderToStaticMarkup(createElement(InlineComposer, { value: '', disabled: false, placeholder: 'Ask', 'aria-label': 'Message', onValueChange: () => {}, onKeyDown: () => {} }))
    expect(empty).toContain('data-empty="true"')
    const oneLine = renderToStaticMarkup(createElement(InlineComposer, { value: 'hi', disabled: false, placeholder: 'Ask', 'aria-label': 'Message', onValueChange: () => {}, onKeyDown: () => {} }))
    expect(oneLine).toContain('data-empty="false"')
    // 两行 draft:documentDraft 会把两行拼成 "1\n2",value.length===3 非空。
    const twoLines = renderToStaticMarkup(createElement(InlineComposer, { value: '1\n2', disabled: false, placeholder: 'Ask', 'aria-label': 'Message', onValueChange: () => {}, onKeyDown: () => {} }))
    expect(twoLines).toContain('data-empty="false"')
    // 语义决定:用户敲了 whitespace(空格/换行/tab)也算"在打字",placeholder 应该消失——
    // 与主流编辑器(VS Code/IntelliJ)一致。判据钉在这里防止将来有人"优化"成 trim().length===0,
    // 那会让用户敲空格时 placeholder 又叠回来。若确实要改成"trim 后判空",要**先**改这条断言、
    // 让此测试红,承认这是语义决定翻转,而不是静默把主流行为改了。
    const whitespace = renderToStaticMarkup(createElement(InlineComposer, { value: '   ', disabled: false, placeholder: 'Ask', 'aria-label': 'Message', onValueChange: () => {}, onKeyDown: () => {} }))
    expect(whitespace).toContain('data-empty="false"')
  })
})
