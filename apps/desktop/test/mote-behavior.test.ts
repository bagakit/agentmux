import { describe, expect, it } from 'vitest'
import { MOTE_BEHAVIOR_LINK, type MoteBehaviorPreferences } from '../src/shared/mote-behavior'
import { linkMoteBehaviorFromSoul, moteSoulForBehaviorContext, parseMoteBehaviorBlock } from '../src/shared/mote-behavior-legacy'

const preferences: MoteBehaviorPreferences = { engagement: 'I', information: 'N', decisions: 'F', approach: 'J', custom: 'Keep my exact wording.\n\nUse examples.' }
const block = `<!-- agentmux:mote-behavior:begin v1 INFJ -->
## Collaboration behavior

- Organize your thinking first, then respond with focus and ask when needed.
- Connect the bigger picture, patterns and possibilities; distinguish them from confirmed facts.
- Stay truthful while considering people, relationships and the values that matter to me.
- Once the direction is clear, suggest steps, decision points and completion signals.

### Extra preferences
Keep my exact wording.

Use examples.

My current directions, original custom SOUL text and extra preferences take priority. These choices do not grant new actions or change factual standards.
<!-- agentmux:mote-behavior:end -->`

describe('one-time original SOUL behavior import', () => {
  it('recognizes only the original canonical source without inventing a style from prose', () => {
    expect(parseMoteBehaviorBlock(block)).toEqual({ status: 'valid', code: 'INFJ', preferences, start: 0, end: block.length })
    expect(parseMoteBehaviorBlock('# I am an INFJ\nArbitrary custom SOUL.')).toEqual({ status: 'absent' })
  })
  it('replaces only the uniquely valid block with a relative link and preserves every other byte', () => {
    const original = '# My original SOUL\r\nKeep this prose exactly.\n\n## Cooperation preferences\nOld choices.\n\n## Idea feedback\nOriginal note/revision/comment.\n'
    const tail = '\n\nAn unsaved original paragraph.\n'
    const linked = linkMoteBehaviorFromSoul(original + block + tail)
    expect(linked).toBe(original + MOTE_BEHAVIOR_LINK + tail)
    expect(parseMoteBehaviorBlock(linked)).toEqual({ status: 'absent' })
    expect(linkMoteBehaviorFromSoul(linked)).toBe(linked)
    expect(linkMoteBehaviorFromSoul(original)).toBe(original + '\n' + MOTE_BEHAVIOR_LINK + '\n')
    expect(linkMoteBehaviorFromSoul('')).toBe(MOTE_BEHAVIOR_LINK + '\n')
  })
  it('preserves duplicate, partial, edited and unknown-version blocks without choosing a first match', () => {
    for (const content of [block + '\n' + block, block.replace(' v1 ', ' v9 '), block.replace('INFJ', 'XXXX'),
      block.replace('## Collaboration behavior', '## My changed block'), block.replace('agentmux:mote-behavior:end -->', 'broken end'),
      '<!-- agentmux:mote-behavior:end -->\n' + block, block.replace('Use examples.', 'Use examples.\n<!-- agentmux:mote-behavior:begin v1 ESTJ -->')]) {
      expect(parseMoteBehaviorBlock(content).status).toBe('unconfirmed')
      expect(() => linkMoteBehaviorFromSoul(content)).toThrow('kept')
    }
  })
})

describe('SOUL projection with confirmed behavior authority', () => {
  it('omits only one recognized old application block and keeps original custom bytes', () => {
    const before = '# My SOUL\r\nMy own behavior instructions stay.\n\n', after = '\n\n## Current work\nMy extra notes stay.\r\n'
    const original = before + block + after
    expect(moteSoulForBehaviorContext(original, true)).toBe(before + after)
    expect(moteSoulForBehaviorContext(original, false)).toBe(original)
    expect(original).toBe(before + block + after)
    expect(moteSoulForBehaviorContext(block, true)).toBe('')
  })
  it('keeps absent, duplicate, damaged, edited and unknown-version text instead of guessing removal', () => {
    for (const original of ['', '# My custom behavior\nKeep every line.', block + '\n' + block,
      block.replace(' v1 ', ' v9 '), block.replace('INFJ', 'XXXX'), block.replace('## Collaboration behavior', '## My customized behavior'),
      block.replace('agentmux:mote-behavior:end -->', 'broken end'), block.replaceAll('\n', '\r\n')]) {
      expect(moteSoulForBehaviorContext(original, true)).toBe(original)
      expect(moteSoulForBehaviorContext(original, false)).toBe(original)
    }
  })
})
