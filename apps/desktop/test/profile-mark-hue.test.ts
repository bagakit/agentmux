import { describe, expect, it } from 'vitest'
import { PROFILE_HUES, assignProfileHues, profileHue, profileTone } from '../src/renderer/src/components/ProfileMark'
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

  it('gives the first Profiles in a list all different colors, whatever their ids hash to', () => {
    // Many random lists: with one hash per id, three Profiles shared a color in almost half of them.
    for (let trial = 0; trial < 500; trial++) {
      const list = Array.from({ length: PROFILE_HUES.length }, (_, index) => ({ id: `p-${trial}-${index}-${(trial * 7919 + index * 104729).toString(36)}`, createdAt: index }))
      const hues = [...assignProfileHues(list).values()]
      expect(new Set(hues).size, `trial ${trial}`).toBe(PROFILE_HUES.length)
    }
  })

  it('spreads a few Profiles across the wheel: the first two are never palette neighbours, and four include teal', () => {
    const wheel = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d) }
    for (let trial = 0; trial < 300; trial++) {
      const list = Array.from({ length: 4 }, (_, index) => ({ id: `s-${trial}-${index}`, createdAt: index }))
      const assigned = assignProfileHues(list)
      const [first, second] = [assigned.get(list[0]!.id)!, assigned.get(list[1]!.id)!]
      expect(wheel(first, second), `trial ${trial}: ${first} then ${second}`).toBeGreaterThanOrEqual(60)
      expect([...assigned.values()], `trial ${trial}`).toContain(PROFILE_HUES[0])
    }
  })

  it('keeps a person’s choice, gives the others the least-used colors, and does not repaint older Profiles when one is added', () => {
    const chosen = { id: 'p-chosen', hue: PROFILE_HUES[0]!, createdAt: 1 }
    const older = { id: 'p-older', createdAt: 0 }
    const before = assignProfileHues([chosen, older])
    expect(before.get('p-chosen')).toBe(PROFILE_HUES[0])
    expect(before.get('p-older'), 'an automatic Profile avoids the chosen color').not.toBe(PROFILE_HUES[0])
    const after = assignProfileHues([chosen, older, { id: 'p-new', createdAt: 5 }])
    expect(after.get('p-older'), 'adding a Profile keeps the older one’s color').toBe(before.get('p-older'))
    // A full palette of older Profiles keeps every color when the next one arrives.
    const six = PROFILE_HUES.map((_, index) => ({ id: `p-${index}`, createdAt: index }))
    const full = assignProfileHues(six)
    const seventh = assignProfileHues([...six, { id: 'p-late', createdAt: 99 }])
    expect(six.map(profile => seventh.get(profile.id))).toEqual(six.map(profile => full.get(profile.id)))
    expect(new Set(after.values()).size).toBe(3)
    // Same list, same colors, in any order.
    expect([...assignProfileHues([{ id: 'p-new', createdAt: 5 }, older, chosen]).entries()].sort()).toEqual([...after.entries()].sort())
    // Without the list a mark falls back to its own hashed hue, still inside the palette.
    expect(PROFILE_HUES).toContain(profileHue({ id: 'p-older' }))
    expect(profileHue({ id: 'p-older' }, after)).toBe(after.get('p-older'))
  })

  it('a chosen hue always wins over the automatic one', () => {
    expect(profileHue({ id: 'p-work', hue: 302 })).toBe(302)
  })

  it('every two palette marks are told apart, by hue or by the alternating lightness step', () => {
    // The marks' text colors as browser.css draws them (dark theme: 80% or 70% lightness at 62% saturation).
    const lab = (h: number, l: number): [number, number, number] => {
      const s = 0.62, a = s * Math.min(l, 1 - l)
      const channel = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
      const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      const [r, g, b] = [channel(0), channel(8), channel(4)].map(lin) as [number, number, number]
      const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
      const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
      return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
    }
    const marks = PROFILE_HUES.map(hue => lab(hue, profileTone(hue) === 'deep' ? 0.70 : 0.80))
    let closest = Infinity
    for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) closest = Math.min(closest, Math.hypot(...marks[i]!.map((v, k) => v - marks[j]![k]!)))
    // A colour difference of 15 is plainly visible side by side; the old one-lightness palette had pairs under 8.
    expect(closest).toBeGreaterThan(15)
    expect(PROFILE_HUES.map(profileTone)).toEqual(PROFILE_HUES.map((_, index) => index % 2 ? 'deep' : 'light'))
    // A hue a person picked before the palette changed still draws, at the light step.
    expect(profileTone(302)).toBe('light')
  })
})
