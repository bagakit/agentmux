export const FOCUS_MAP_BOUNDARIES = ['bezier', 'polygon'] as const
export const FOCUS_MAP_FORMS = ['point', 'compact', 'card'] as const
export const FOCUS_MAP_INFORMATION = ['identity', 'status', 'summary'] as const
export const FOCUS_MAP_LEVEL_COUNTS = [2, 3, 4] as const
export const FOCUS_MAP_MIN_ZOOM = .05
export const FOCUS_MAP_MAX_ZOOM = 1.4

export type FocusMapBoundary = typeof FOCUS_MAP_BOUNDARIES[number]
export type FocusMapForm = typeof FOCUS_MAP_FORMS[number]
export type FocusMapInformation = typeof FOCUS_MAP_INFORMATION[number]
export type FocusMapLevelCount = typeof FOCUS_MAP_LEVEL_COUNTS[number]
export type FocusMapLodLevel = { form: FocusMapForm; information: FocusMapInformation; from: number; to: number }
export type FocusMapPreferences = { boundary: FocusMapBoundary; levels: readonly FocusMapLodLevel[] }

const point: FocusMapLodLevel = { form: 'point', information: 'identity', from: .05, to: .05 }
const presets: Record<FocusMapLevelCount, readonly FocusMapLodLevel[]> = {
  2: [point, { form: 'card', information: 'summary', from: .4, to: .82 }],
  3: [point, { form: 'compact', information: 'identity', from: .32, to: .58 }, { form: 'card', information: 'summary', from: .62, to: .82 }],
  4: [point, { form: 'compact', information: 'identity', from: .25, to: .46 },
    { form: 'compact', information: 'status', from: .48, to: .64 }, { form: 'card', information: 'summary', from: .68, to: .9 }]
}
export const DEFAULT_FOCUS_MAP_PREFERENCES: FocusMapPreferences = { boundary: 'bezier', levels: presets[3] }

/** Counts select complete starting profiles; the array remains the only count owner. */
export function focusMapPreset(count: FocusMapLevelCount): FocusMapLodLevel[] {
  return presets[count].map(level => ({ ...level }))
}
export function focusMapInformationChoices(form: FocusMapForm): readonly FocusMapInformation[] {
  return form === 'point' ? ['identity'] : form === 'compact' ? ['identity', 'status'] : FOCUS_MAP_INFORMATION
}
export function focusMapFormChoices(information: FocusMapInformation): readonly FocusMapForm[] {
  return FOCUS_MAP_FORMS.filter(form => focusMapInformationChoices(form).includes(information))
}
export const resolveFocusMapPreferences = (value: FocusMapPreferences | undefined): FocusMapPreferences => value ?? DEFAULT_FOCUS_MAP_PREFERENCES

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
/** Shared validation for the draft, durable schema and declared public setters. */
export function focusMapPreferencesIssue(value: unknown): string | null {
  if (!record(value) || !exactKeys(value, ['boundary', 'levels']) || !FOCUS_MAP_BOUNDARIES.includes(value.boundary as FocusMapBoundary)) return 'Choose a polygon or Bezier boundary.'
  if (!Array.isArray(value.levels) || !FOCUS_MAP_LEVEL_COUNTS.includes(value.levels.length as FocusMapLevelCount)) return 'Choose 2, 3 or 4 LOD levels.'
  let previousEnd = FOCUS_MAP_MIN_ZOOM
  let previousForm = 0, previousInformation = 0
  for (const [index, level] of value.levels.entries()) {
    if (!record(level) || !exactKeys(level, ['form', 'information', 'from', 'to']) || !FOCUS_MAP_FORMS.includes(level.form as FocusMapForm)
      || !focusMapInformationChoices(level.form as FocusMapForm).includes(level.information as FocusMapInformation)) return `Level ${index + 1}: choose information that fits its form.`
    const { from, to } = level
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to)
      || from < FOCUS_MAP_MIN_ZOOM || to > FOCUS_MAP_MAX_ZOOM) return `Level ${index + 1}: use a zoom from 5% to 140%.`
    if (index === 0 ? from !== FOCUS_MAP_MIN_ZOOM || to !== FOCUS_MAP_MIN_ZOOM : from < previousEnd || to <= from) return index === 0
      ? 'The first level covers the farthest view, starting at 5%.' : `Level ${index + 1}: finish after its start, without overlapping the previous level.`
    const form = FOCUS_MAP_FORMS.indexOf(level.form as FocusMapForm), information = FOCUS_MAP_INFORMATION.indexOf(level.information as FocusMapInformation)
    if (form < previousForm || information < previousInformation) return `Level ${index + 1}: zooming in must retain the previous form and information capacity.`
    previousEnd = to
    previousForm = form; previousInformation = information
  }
  return null
}
export const validFocusMapPreferences = (value: unknown): value is FocusMapPreferences => focusMapPreferencesIssue(value) === null
