import type { MouseEvent } from 'react'
import { Circle, CircleAlert, Square } from 'lucide-react'
import type { BrowserDemonstrationDraft } from '../../../shared/browser-demonstration'

type Props = {
  draft: BrowserDemonstrationDraft | null
  warning?: string
  busy?: boolean
  collapseSteps?: boolean
  onStart: (event: MouseEvent<HTMLButtonElement>) => void
  onStop: (event: MouseEvent<HTMLButtonElement>) => void
}

/** Draft review lives in the Browser's existing details surface; it never runs recorded actions. */
export function BrowserDemonstrationSurface({ draft, warning, busy = false, collapseSteps = false, onStart, onStop }: Props) {
  const recording = draft?.status === 'recording'
  if (!draft) return <section className="browser-demonstration-entry" aria-label="Human demonstration draft">
    <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy}
      aria-label="Start recording demonstration" onClick={onStart}><Circle size={11} aria-hidden="true" />Record demonstration</button>
    {warning ? <p className="browser-rsi-timeline__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{warning}</p> : null}
  </section>
  return <section className="browser-rsi-replay" aria-label="Human demonstration draft" data-demonstration-id={draft?.id}>
    <header className="browser-rsi-replay__header">
      <strong>Demonstration</strong>
      <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy}
        aria-label={recording ? 'Stop recording demonstration' : 'Start recording demonstration'}
        onClick={recording ? onStop : onStart}>
        {recording ? <Square size={11} aria-hidden="true" /> : <Circle size={11} aria-hidden="true" />}
        {recording ? 'Stop' : 'Record'}
      </button>
    </header>
    <p className="browser-rsi-replay__origin" role="status">
      {recording ? 'Recording human input · main document' : draft?.status === 'interrupted' ? 'Interrupted · review before recording again' : draft ? 'Draft saved for review' : 'Record a demonstration to create a reviewable draft'}
    </p>
    {warning || draft?.warning ? <p className="browser-rsi-timeline__warning" role="status"><CircleAlert size={12} aria-hidden="true" />{warning ?? draft?.warning}</p> : null}
    {draft ? <details className="browser-demonstration__steps" open={recording || !collapseSteps}>
      <summary aria-label="Recorded demonstration steps">{draft.steps.length} recorded {draft.steps.length === 1 ? 'step' : 'steps'}</summary>
      <ol className="browser-rsi-replay__steps">
      {draft.steps.length === 0 ? <li className="browser-rsi-timeline__empty">No demonstrated steps yet</li> : draft.steps.map(step => <li key={step.id} className="browser-rsi-replay__step" data-sequence={step.sequence}>
        <span className="browser-rsi-replay__step-number">{step.sequence}</span>
        <span className="browser-rsi-replay__step-copy"><strong>{step.method === 'fillInput' ? 'Fill' : step.method === 'gotoUrl' ? 'Navigate' : 'Click'}</strong>
          <span>{step.target?.name ?? (step.method === 'gotoUrl' ? step.url : 'Target needs location')}</span>
          {step.inputKey ? <small>Parameter: {step.inputKey} · value not recorded</small> : null}
          {step.blockedReason ? <small className="browser-rsi-replay__blocked">{step.blockedReason}</small> : null}
        </span>
      </li>)}
      </ol>
    </details> : null}
  </section>
}
