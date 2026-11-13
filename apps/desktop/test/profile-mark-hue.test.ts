import { describe, expect, it } from 'vitest'
import { PROFILE_HUES, profileHue } from '../src/renderer/src/components/ProfileMark'
import { clearsSemanticHues } from '../src/renderer/src/lib/conversation-avatar-color'

/**
 * A Profile mark sits next to green "Open" text and a green primary button. An automatic hue in the
 * yellow-green or lime range reads as success there, so automatic Profiles draw from the same palette
 * a person picks from, never from the wider speaker range.
 */
describe('Profile identity hue', () => {
  const ids = Array.from({ length: 2000 }, (_, index) => `profile-${index}-${(index * 2654435761 >>> 0).toString(16)}`)

  it('keeps every automatic hue inside the picker palette and out of 60–160°', () => {
    const hues = ids.map(id => profileHue({ id }))
    expect(hues.every(hue => PROFILE_HUES.includes(hue))).toBe(true)
    expect(hues.filter(hue => hue >= 60 && hue <= 160)).toEqual([])
    expect(PROFILE_HUES.every(clearsSemanticHues)).toBe(true)
  })

  it('spreads automatic Profiles across the palette and keeps each one stable', () => {
    const used = new Set(ids.map(id => profileHue({ id })))
    expect(used.size).toBe(PROFILE_HUES.length)
    expect(profileHue({ id: 'p-work' })).toBe(profileHue({ id: 'p-work' }))
  })

  it('a chosen hue always wins over the automatic one', () => {
    expect(profileHue({ id: 'p-work', hue: 302 })).toBe(302)
  })
})
