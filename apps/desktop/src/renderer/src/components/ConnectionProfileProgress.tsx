import type { ConnectionProfileOperation, ProfileEffectState } from '@agentmux/core/connections'
import '../styles/bot-setup-guide.css'

export const profileEffectLabels: Record<ProfileEffectState, string> = {
  'not-required': 'Not requested', 'not-dispatched': 'Not sent', dispatching: 'In progress',
  confirmed: 'Confirmed', refused: 'Refused', unknown: 'Unconfirmed'
}

/** Profile synchronization has no sign-in or application-creation stage. */
export function ConnectionProfileProgress({ operation, started = false, sourceConfirmed = false }: {
  operation?: ConnectionProfileOperation | null | undefined; started?: boolean; sourceConfirmed?: boolean
}) {
  const upload = operation?.upload.state, patch = operation?.patch.state
  const current = !started ? 1 : !operation || upload !== 'confirmed' && upload !== 'not-required' ? 2 : patch !== 'confirmed' ? 3 : 4
  const steps = [
    { label: 'Saved profile', status: sourceConfirmed ? 'Confirmed' : 'Not confirmed', confirmed: sourceConfirmed },
    { label: 'Upload image', status: upload ? profileEffectLabels[upload] : started ? 'Receipt not yet available' : 'Not started', confirmed: upload === 'confirmed', attention: upload === 'unknown' || upload === 'refused' },
    { label: 'Write profile', status: patch ? profileEffectLabels[patch] : started ? 'Receipt not yet available' : 'Not started', confirmed: patch === 'confirmed', attention: patch === 'unknown' || patch === 'refused' },
    { label: 'Review & publish', status: operation?.publication === 'platform-review-required' ? 'Platform action required' : 'Not submitted here', confirmed: false }
  ]
  return <nav className="bot-setup-guide" aria-label="Profile update progress" data-profile-progress>
    <ol>{steps.map((step, index) => <li key={step.label} data-step={index + 1} data-state={step.attention ? 'attention' : step.confirmed ? 'recorded' : index + 1 === current ? 'current' : 'upcoming'} aria-current={index + 1 === current ? 'step' : undefined}>
      <span className="bot-setup-guide__number" aria-hidden="true">{step.confirmed ? '✓' : index + 1}</span>
      <span><strong>{step.label}</strong><small>{step.status}</small></span>
    </li>)}</ol>
    <p>{!started ? 'Review the saved Mote profile before updating this bot.' : 'Updates the same bot. Upload, profile write and platform publication have separate results.'}</p>
  </nav>
}
