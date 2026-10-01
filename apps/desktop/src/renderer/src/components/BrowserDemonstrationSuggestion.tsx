import type { BrowserDemonstrationSuggestion as Suggestion } from '../../../shared/browser-demonstration-semantics'

/** Suggestions remain separate from observed actions and the person's editable asset. */
export function BrowserDemonstrationSuggestion({ suggestion }: { suggestion?: Suggestion | undefined }) {
  if (!suggestion) return null
  return <span className="browser-demonstration-suggestion" data-suggestion-status={suggestion.status}>
    <strong>{suggestion.status === 'available' ? suggestion.title : suggestion.status === 'interpreting' ? 'Preparing suggestion…' :
      suggestion.status === 'failed' ? 'Suggestion unavailable' : 'Suggestion unknown'}</strong>
    <small>Suggestion · Recorded target{suggestion.parameter ? ' · Value not recorded' : ''}</small>
    {suggestion.reason ? <small>{suggestion.reason}</small> : null}
  </span>
}
