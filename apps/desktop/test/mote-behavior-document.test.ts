import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MOTE_BEHAVIOR, deriveMoteBehaviorCode, moteBehaviorIntroduction, parseMoteBehaviorDocument,
  serializeMoteBehaviorDocument, type MoteBehaviorDraft, type MoteBehaviorPreferences
} from '../src/shared/mote-behavior'
import * as rendererBehavior from '../src/renderer/src/lib/mote-behavior'

const preferences: MoteBehaviorPreferences = { engagement: 'I', information: 'N', decisions: 'F', approach: 'J', custom: '\n## My notes\nKeep my exact wording.\n\n---\nBody delimiters are Markdown.\n' }

describe('original BEHAVIOR Markdown document', () => {
  it('round-trips all sixteen explicit choices and derives their code instead of persisting it', () => {
    const codes = []
    for (const engagement of ['E', 'I'] as const) for (const information of ['S', 'N'] as const)
      for (const decisions of ['T', 'F'] as const) for (const approach of ['J', 'P'] as const) {
        const draft = { engagement, information, decisions, approach, custom: preferences.custom }, code = engagement + information + decisions + approach
        const source = serializeMoteBehaviorDocument('', draft)
        expect(parseMoteBehaviorDocument(source)).toEqual({ status: 'valid', code, preferences: draft })
        expect(source).not.toContain(code)
        expect(deriveMoteBehaviorCode(draft)).toBe(code)
        codes.push(code)
      }
    expect(new Set(codes).size).toBe(16)
    expect(rendererBehavior.parseMoteBehaviorDocument).toBe(parseMoteBehaviorDocument)
    expect(rendererBehavior.deriveMoteBehaviorCode).toBe(deriveMoteBehaviorCode)
  })
  it('keeps empty and partial preferences explicit, without interpreting user Markdown as choices', () => {
    expect(parseMoteBehaviorDocument(DEFAULT_MOTE_BEHAVIOR)).toEqual({ status: 'valid', preferences: { custom: '' }, code: null })
    const draft: MoteBehaviorDraft = { engagement: 'E', custom: '# I seem like an INTJ.\n' }
    expect(parseMoteBehaviorDocument(serializeMoteBehaviorDocument('', draft))).toEqual({ status: 'valid', preferences: draft, code: null })
    expect(deriveMoteBehaviorCode({ custom: 'I seem like an INTJ.' })).toBeNull()
    expect(deriveMoteBehaviorCode({ ...preferences, engagement: 'X' } as unknown as MoteBehaviorPreferences)).toBeNull()
    expect(parseMoteBehaviorDocument('---\nversion: 1\n---\nUser body')).toEqual({ status: 'valid', preferences: { custom: 'User body' }, code: null })
    expect(serializeMoteBehaviorDocument(serializeMoteBehaviorDocument('', preferences), { custom: 'Only notes' })).not.toContain('engagement:')
  })
  it('preserves unrelated frontmatter, nested fields, anchors and comments when editing preferences', () => {
    const original = `---
# My document comment
version: 1 # Format comment
locale: &language zh-CN # My language
presentation:
  language: *language
  colors: [blue, green] # My colors
preferences: # Preference comment
  engagement: I # Conversation comment
  information: N
  decisions: F
  approach: J
  custom_field: keep-me # An additional preference
---
` + preferences.custom
    expect(serializeMoteBehaviorDocument(original, preferences)).toBe(original)
    const changed = { ...preferences, engagement: 'E' as const, approach: 'P' as const }
    const saved = serializeMoteBehaviorDocument(original, changed)
    expect(parseMoteBehaviorDocument(saved)).toEqual({ status: 'valid', preferences: changed, code: 'ENFP' })
    for (const text of ['# My document comment', '# Format comment', '&language zh-CN', '*language', '# My language',
      'colors: [ blue, green ] # My colors', '# Preference comment', '# Conversation comment', 'custom_field: keep-me # An additional preference']) expect(saved).toContain(text)
    expect(saved.endsWith(preferences.custom)).toBe(true)
    expect(serializeMoteBehaviorDocument(saved, changed)).toBe(saved)
  })
  it('keeps BOM, original header line endings and exact free Markdown body through an edit', () => {
    const original = '\uFEFF---\r\nversion: 1\r\npreferences: { engagement: I }\r\n---\r\n' + preferences.custom
    const saved = serializeMoteBehaviorDocument(original, preferences)
    expect(saved.startsWith('\uFEFF---\r\n')).toBe(true)
    expect(saved.endsWith(preferences.custom)).toBe(true)
    expect(parseMoteBehaviorDocument(saved)).toEqual({ status: 'valid', preferences, code: 'INFJ' })
    expect(parseMoteBehaviorDocument('---\nversion: 1\npreferences: {}\n---')).toEqual({ status: 'valid', preferences: { custom: '' }, code: null })
  })
  it('retains configuration comments when explicitly clearing an earlier choice', () => {
    const original = '---\nversion: 1\npreferences: # preferences note\n  engagement: I # my conversation note\n  custom_field: keep-me # unrelated note\n---\nMy body'
    const saved = serializeMoteBehaviorDocument(original, { custom: 'My body' })
    expect(parseMoteBehaviorDocument(saved)).toEqual({ status: 'valid', preferences: { custom: 'My body' }, code: null })
    for (const text of ['# preferences note', '# my conversation note', 'custom_field: keep-me # unrelated note']) expect(saved).toContain(text)
    expect(saved).not.toContain('engagement:')
  })
  it.each([
    '', 'Arbitrary original text', '---\nversion: 1\npreferences: {}',
    '---\nversion: 2\npreferences: {}\n---\n', '---\nversion: "1"\npreferences: {}\n---\n',
    '---\nversion: 1\nversion: 1\n---\n', '---\nversion: 1\npreferences: {engagement: I, engagement: E}\n---\n',
    '---\nversion: 1\npreferences: {engagement: X}\n---\n', '---\nversion: 1\npreferences: {engagement: null}\n---\n',
    '---\nversion: 1\npreferences: []\n---\n', '---\nversion: 1\npreferences: null\n---\n',
    '---\nversion: 1\npreferences: { engagement: true }\n---\n', '---\nversion: 1\npreferences: { engagement: [I] }\n---\n',
    '---\nversion: 1\nbase: &style {engagement: I}\npreferences: *style\n---\n',
    '---\nversion: 1\nbase: &choice I\npreferences: {engagement: *choice}\n---\n',
    '---\nversion: 1\nmetadata: !unknown value\n---\n', '---\nversion: 1\nmetadata: {a: 1, a: 2}\n---\n',
    '---\nversion: 1\npreferences: {\n---\n'
  ])('leaves ambiguous or invalid original configuration unconfirmed: %s', content => {
    expect(parseMoteBehaviorDocument(content).status).toBe('unconfirmed')
    if (content !== '') expect(() => serializeMoteBehaviorDocument(content, preferences)).toThrow('kept')
  })
  it('rejects invalid supplied choices without changing any original source', () => {
    expect(() => serializeMoteBehaviorDocument(DEFAULT_MOTE_BEHAVIOR, { ...preferences, information: 'X' } as unknown as MoteBehaviorPreferences)).toThrow('documented pairs')
    expect(() => serializeMoteBehaviorDocument(DEFAULT_MOTE_BEHAVIOR, { ...preferences, custom: null } as unknown as MoteBehaviorPreferences)).toThrow('Markdown text')
  })
  it('provides explicit introduction depths from the same selected preferences', () => {
    const summary = moteBehaviorIntroduction(preferences, 'summary'), details = moteBehaviorIntroduction(preferences, 'preferences'), full = moteBehaviorIntroduction(preferences, 'full')
    expect(summary).toContain('MBTI style: INFJ')
    expect(summary).toContain('Think, then reply · Bigger possibilities · People & values · Plans & next steps')
    expect(summary).not.toContain('Organize your thinking first')
    expect(details).toContain('Organize your thinking first')
    expect(details).not.toContain('My notes')
    expect(full).toBe(details + '\n\n### Additional preferences\n' + preferences.custom)
    expect(moteBehaviorIntroduction({ custom: '' }, 'summary')).toBe('No behavior preferences selected.')
    expect(moteBehaviorIntroduction({ engagement: 'E', custom: '' }, 'preferences')).not.toContain('MBTI')
  })
})
