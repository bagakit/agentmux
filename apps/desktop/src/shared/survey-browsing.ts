export const SURVEY_PAGE_GROUPINGS = ['none', 'site', 'time'] as const
export const SURVEY_GROUP_GAP_MINUTES = { min: 5, max: 240 } as const

export type SurveyBrowsingPreferences = {
  reuseOpenPages: boolean
  pageGrouping: typeof SURVEY_PAGE_GROUPINGS[number]
  groupGapMinutes: number
}

export const DEFAULT_SURVEY_BROWSING: SurveyBrowsingPreferences = {
  reuseOpenPages: true,
  pageGrouping: 'none',
  groupGapMinutes: 30,
}

export function resolveSurveyBrowsing(preferences?: Partial<SurveyBrowsingPreferences>): SurveyBrowsingPreferences {
  return { ...DEFAULT_SURVEY_BROWSING, ...preferences }
}
