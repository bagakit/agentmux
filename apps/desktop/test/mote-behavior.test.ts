import { describe, expect, it } from 'vitest'
import { deriveMoteBehaviorCode, parseMoteBehaviorBlock, replaceMoteBehaviorBlock, serializeMoteBehaviorBlock, type MoteBehaviorPreferences } from '../src/renderer/src/lib/mote-behavior'

const preferences: MoteBehaviorPreferences = { engagement: 'I', information: 'N', decisions: 'F', approach: 'J', custom: 'Keep my exact wording.\n\nUse examples.' }
describe('original SOUL owned behavior block', () => {
  it('derives all 16 codes only from four explicit valid choices', () => {
    const codes = []
    for (const engagement of ['E', 'I'] as const) for (const information of ['S', 'N'] as const)
      for (const decisions of ['T', 'F'] as const) for (const approach of ['J', 'P'] as const) {
        const draft = { engagement, information, decisions, approach, custom: '' }, code = engagement + information + decisions + approach
        expect(deriveMoteBehaviorCode(draft)).toBe(code); codes.push(code)
        expect(parseMoteBehaviorBlock(serializeMoteBehaviorBlock(draft))).toMatchObject({ status: 'valid', code, preferences: draft })
      }
    expect(new Set(codes).size).toBe(16)
    expect(deriveMoteBehaviorCode({ custom: 'I seem like an INTJ.' })).toBeNull()
    const { information: _information, ...incomplete } = preferences
    expect(deriveMoteBehaviorCode(incomplete)).toBeNull()
    expect(deriveMoteBehaviorCode({ ...preferences, engagement: 'X' } as unknown as MoteBehaviorPreferences)).toBeNull()
    expect(parseMoteBehaviorBlock('# I am an INFJ\nArbitrary custom SOUL.')).toEqual({ status: 'absent' })
  })
  it('appends once, replaces only the uniquely valid block and preserves every original byte', () => {
    const original = '# My original SOUL\r\nKeep this prose exactly.\n\n## Cooperation preferences\nOld choices.\n\n## Idea feedback\nOriginal note/revision/comment.\n'
    const first = replaceMoteBehaviorBlock(original, preferences), tail = '\n\nAn unsaved original paragraph.\n'
    const replacement = { ...preferences, approach: 'P' as const, custom: '' }
    const second = replaceMoteBehaviorBlock(first + tail, replacement), parsed = parseMoteBehaviorBlock(second)
    expect(second.startsWith(original)).toBe(true); expect(second.endsWith(tail)).toBe(true)
    expect(parsed).toMatchObject({ status: 'valid', code: 'INFP', preferences: replacement })
    expect(second.match(/agentmux:mote-behavior:begin/g)).toHaveLength(1)
    expect(replaceMoteBehaviorBlock(second, replacement)).toBe(second)
  })
  it('preserves duplicate, partial, edited and unknown-version blocks without choosing a first match', () => {
    const block = serializeMoteBehaviorBlock(preferences)
    for (const content of [block + '\n' + block, block.replace(' v1 ', ' v9 '), block.replace('INFJ', 'XXXX'),
      block.replace('## Collaboration behavior', '## My changed block'), block.replace('agentmux:mote-behavior:end -->', 'broken end'),
      '<!-- agentmux:mote-behavior:end -->\n' + block, block.replace('Use examples.', 'Use examples.\n<!-- agentmux:mote-behavior:begin v1 ESTJ -->')]) {
      expect(parseMoteBehaviorBlock(content).status).toBe('unconfirmed')
      expect(() => replaceMoteBehaviorBlock(content, preferences)).toThrow('kept')
    }
    expect(() => serializeMoteBehaviorBlock({ ...preferences, custom: '<!-- agentmux:mote-behavior:end -->' })).toThrow()
  })
})
