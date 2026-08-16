import { describe, expect, it } from 'vitest'
import { draftDocument, documentDraft } from '../src/renderer/src/components/InlineComposer.js'
import { appendSemanticReference, expandSemanticReferences, type ComposerSemanticReference } from '../src/renderer/src/lib/composer-semantic-reference.js'

describe('inline composer durable reference surface', () => {
  const ref: ComposerSemanticReference = { token: '', label: 'review', kind: 'skill', reference: '@/skills/review/SKILL.md' }
  it('keeps full target in the durable draft while rendering a typed node', () => {
    const draft = appendSemanticReference('Please', ref)
    expect(draft).toContain('agentmux-skill:')
    expect(documentDraft(draftDocument(draft))).toBe(draft)
    expect(expandSemanticReferences(draft)).toBe('Please @/skills/review/SKILL.md ')
  })
  it('keeps ordinary newlines and multiple references ordered', () => {
    const a = appendSemanticReference('', ref)
    const b = appendSemanticReference(a + '\nnext', { ...ref, label: 'status', kind: 'subcommand', reference: '/status' })
    expect(expandSemanticReferences(b)).toContain('\nnext /status')
  })
})
