import type { SurveyPageOpening } from '../lib/survey-system-page'
import { SurfaceState } from './SurfaceState'

export function SurveyOpeningPage({ opening }: { opening: SurveyPageOpening }) {
  const site = new URL(opening.url).hostname
  return <SurfaceState data-survey-opening-page="" role="status" title="Opening webpage" description={site || 'Local webpage'} />
}
