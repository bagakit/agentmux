import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ContinuousProgressDecision } from '@agentmux/core/continuous-progress'

const ThemeActionPauseIcon = semanticIconComponent('action.pause')
const ThemeActionStartIcon = semanticIconComponent('action.start')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionStopIcon = semanticIconComponent('action.stop')

const decisionLabels: Record<Extract<ContinuousProgressDecision, { kind: 'skip' }>['reason'], string> = {
  working: 'The Agent is still working. No continuation is needed yet.',
  'stale-working': 'The last known turn is still working; its completion is not confirmed.',
  'interaction-pending': 'The Agent is waiting for a reply or permission. Respond in the original conversation.',
  'readiness-unconfirmed': 'The Agent’s readiness is unconfirmed. Check its original conversation.',
  'completion-consumed': 'This completed turn has already been used by an input. Waiting for the next completed turn.',
  'duplicate-tick': 'This check has already been handled.',
  'user-input-changed': 'Your input takes priority. Automatic continuation was skipped.',
  'unknown-status': 'A completed, ready Agent turn could not be confirmed. This check sent no continuation.'
}

export type ContinuousProgressPanelLoop = {
  loopId: string
  providerLabel: string
  executionState: string
  loopState: 'active' | 'paused' | 'stopped'
  nextCheckAt?: number
  lastTickAt?: number
  lastDecision?: string
}

export function ContinuousProgressPanel({ loop, onPause, onResume, onStop, onCheck, notice, disabled = false, unconfirmed = false }: {
  loop: ContinuousProgressPanelLoop
  onPause?: () => void
  onResume?: () => void
  onStop?: () => void
  onCheck?: () => void
  notice?: string | undefined
  disabled?: boolean
  unconfirmed?: boolean
}) {
  return <section className="continuous-progress-panel" aria-label={`Continuous progress · ${loop.providerLabel}`} aria-busy={disabled}>
    <dl className="continuous-progress-panel__summary">
      <dt>{unconfirmed ? 'Last known loop status' : 'Loop'}</dt><dd>{loop.loopState}</dd>
      <dt>Agent execution</dt><dd>{loop.executionState}</dd>
      {!unconfirmed && loop.loopState === 'active' && loop.nextCheckAt !== undefined ? <><dt>Next check</dt><dd><time dateTime={new Date(loop.nextCheckAt).toISOString()}>{new Date(loop.nextCheckAt).toLocaleTimeString()}</time></dd></> : null}
      {loop.lastTickAt !== undefined ? <><dt>Last check</dt><dd><time dateTime={new Date(loop.lastTickAt).toISOString()}>{new Date(loop.lastTickAt).toLocaleString()}</time></dd></> : null}
    </dl>
    {loop.loopState !== 'stopped' ? <>
      <div className="continuous-progress-panel__actions">
        {loop.loopState === 'active' ? <>
          <button type="button" aria-label="Check continuous progress now" disabled={disabled} onClick={onCheck}><ThemeActionRefreshIcon size={13} aria-hidden="true" />Check now</button>
          <button type="button" aria-label="Pause continuous progress" disabled={disabled} onClick={onPause}><ThemeActionPauseIcon size={13} aria-hidden="true" />Pause</button>
        </> : <button type="button" aria-label="Resume and check continuous progress" disabled={disabled} onClick={onResume}><ThemeActionStartIcon size={13} aria-hidden="true" />Resume and check</button>}
        <button type="button" aria-label="Stop continuous progress" disabled={disabled} onClick={onStop}><ThemeActionStopIcon size={13} aria-hidden="true" />Stop loop</button>
      </div>
      <p className="continuous-progress-control__help">{loop.loopState === 'paused' ? 'Resume checks this Agent now and restarts periodic checks.' : 'Continuation is sent only after a completed, ready Agent turn.'} Stop loop does not stop the Agent.</p>
    </> : null}
    {notice ? <p className="continuous-progress-control__notice" role="status">{notice}</p> : null}
    {loop.lastDecision && loop.lastDecision !== notice ? <div className="continuous-progress-panel__decision"><h4>Latest decision</h4><p>{Object.hasOwn(decisionLabels, loop.lastDecision) ? decisionLabels[loop.lastDecision as keyof typeof decisionLabels] : loop.lastDecision}</p></div> : null}
  </section>
}
