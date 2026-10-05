import { BrandIcon } from './BrandIcon'

/** Shared first-party identity for the unselected Survey and original blank Browser. */
export function SurveyStartBrand() {
  return <div className="survey-start-brand"><BrandIcon size={44} /><h1>AgentMux</h1><p>Follow a question. Keep what you find.</p></div>
}
