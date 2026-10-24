import { expect, it } from 'vitest'
import { DEFAULT_FOCUS_MAP_PREFERENCES, focusMapPreset, focusMapPreferencesIssue, resolveFocusMapPreferences,
  focusMapInformationChoices, type FocusMapPreferences } from '../src/shared/focus-map-preferences'

it('keeps the original three-stage disclosure and gives each supported count an isolated usable starting profile', () => {
  expect(resolveFocusMapPreferences(undefined)).toBe(DEFAULT_FOCUS_MAP_PREFERENCES)
  expect(DEFAULT_FOCUS_MAP_PREFERENCES).toEqual({ boundary: 'bezier', levels: [
    { form: 'point', information: 'identity', from: .05, to: .05 },
    { form: 'compact', information: 'identity', from: .32, to: .58 },
    { form: 'card', information: 'summary', from: .62, to: .82 }
  ] })
  for (const count of [2, 3, 4] as const) {
    const levels = focusMapPreset(count)
    expect(levels).toHaveLength(count)
    expect(focusMapPreferencesIssue({ boundary: 'polygon', levels })).toBeNull()
    levels[0]!.form = 'card'
    expect(focusMapPreset(count)[0]!.form).toBe('point')
  }
  expect(focusMapInformationChoices('point')).toEqual(['identity'])
  expect(focusMapInformationChoices('compact')).toEqual(['identity', 'status'])
  expect(focusMapInformationChoices('card')).toEqual(['identity', 'status', 'summary'])
})

it('rejects invalid ranges, incompatible information and decreasing disclosure without repairing the authored profile', () => {
  const valid = (): FocusMapPreferences => ({ boundary: 'polygon', levels: focusMapPreset(3) })
  const variants: unknown[] = [
    { ...valid(), count: 3 }, { ...valid(), boundary: 'circle' }, { boundary: 'bezier', levels: [] },
    { boundary: 'bezier', levels: [...focusMapPreset(4), focusMapPreset(2)[1]] }
  ]
  for (const [index, patch] of [
    [0, { from: .04 }], [0, { to: .2 }], [1, { from: .6, to: .6 }],
    [1, { from: .31, to: .7 }], [2, { to: 1.41 }], [2, { from: Number.NaN }],
    [2, { to: Number.POSITIVE_INFINITY }], [1, { information: 'summary' }],
    [0, { form: 'card' }], [2, { form: 'point', information: 'identity' }],
    [1, { information: 'status' }], [1, { extra: true }]
  ] as const) {
    const value = valid(), levels = value.levels.map((level, at) => at === index ? { ...level, ...patch } : level)
    // The status case becomes decreasing information while forms stay ordered.
    variants.push({ ...value, levels: index === 1 && 'information' in patch && patch.information === 'status' ? levels.map((level, at) => at === 2 ? { ...level, information: 'identity' } : level) : levels })
  }
  for (const value of variants) {
    const before = structuredClone(value)
    expect(focusMapPreferencesIssue(value)).not.toBeNull()
    expect(value).toEqual(before)
  }
  expect(focusMapPreferencesIssue({ boundary: 'bezier', levels: focusMapPreset(4).map(level => ({ ...level, form: 'point', information: 'identity' })) })).toBeNull()
})
