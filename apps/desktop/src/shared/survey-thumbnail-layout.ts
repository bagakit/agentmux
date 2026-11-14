/** Survey navigation density only; original pages and their viewports are unchanged. */
export type SurveyThumbnailLayout = { height: number; maxColumns: number }
export const SURVEY_THUMBNAIL_HEIGHT = { min: 52, max: 180 } as const
export const SURVEY_THUMBNAIL_COLUMNS = { min: 1, max: 6 } as const
export const DEFAULT_SURVEY_THUMBNAIL_LAYOUT: SurveyThumbnailLayout = { height: 52, maxColumns: 4 }

export function resolveSurveyThumbnailLayout(value?: Partial<SurveyThumbnailLayout>): SurveyThumbnailLayout {
  return { height: value?.height ?? DEFAULT_SURVEY_THUMBNAIL_LAYOUT.height,
    maxColumns: value?.maxColumns ?? DEFAULT_SURVEY_THUMBNAIL_LAYOUT.maxColumns }
}

/** Both the saved navigation and the local sample use the same CSS inputs. */
export function surveyThumbnailStyle(value?: Partial<SurveyThumbnailLayout>) {
  const layout = resolveSurveyThumbnailLayout(value)
  return { '--survey-thumbnail-height': `${layout.height}px`, '--survey-thumbnail-columns': layout.maxColumns }
}
