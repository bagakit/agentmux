import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerSemanticTokens } from '../src/renderer/src/components/ComposerSemanticTokens.js'
import { appendSemanticReference, expandSemanticReferences, semanticReferenceKind } from '../src/renderer/src/lib/composer-semantic-reference.js'

describe('composer semantic references', () => {
  it('keeps a short token in the draft and expands it only at submission', () => {
    const reference = { token: '$review', label: 'review', kind: 'skill' as const, reference: '@/skills/review/SKILL.md' }
    expect(appendSemanticReference('please', reference.token)).toBe('please $review ')
    expect(expandSemanticReferences('please $review now', [reference])).toBe('please @/skills/review/SKILL.md now')
  })

  it('derives distinct semantic kinds from existing references', () => {
    expect(semanticReferenceKind('/status')).toBe('subcommand')
    expect(semanticReferenceKind('/repo/components/card.md')).toBe('component')
    expect(semanticReferenceKind('/repo/skills/review/SKILL.md')).toBe('skill')
  })

  it('renders the compact name, kind-specific icon and full hover reference', () => {
    const markup = renderToStaticMarkup(createElement(ComposerSemanticTokens, { references: [
      { token: '$review', label: 'review', kind: 'skill', reference: '@/skills/review/SKILL.md' },
      { token: '$card', label: 'card', kind: 'component', reference: '@/components/card.md' },
      { token: '/status', label: 'status', kind: 'subcommand', reference: '/status' }
    ] }))
    expect(markup).toContain('composer-semantic-token--skill')
    expect(markup).toContain('composer-semantic-token--component')
    expect(markup).toContain('composer-semantic-token--subcommand')
    expect(markup).toContain('title="@/skills/review/SKILL.md"')
  })
})
