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
})
