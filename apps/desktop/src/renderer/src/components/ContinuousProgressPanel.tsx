import { Pause, Play, Square, RefreshCw } from 'lucide-react'

export type ContinuousProgressPanelLoop = {
  loopId: string
  providerLabel: string
  executionState: string
  loopState: 'active' | 'paused' | 'stopped'
  nextCheckAt?: number
  lastTickAt?: number
  lastDecision?: string
}

export function ContinuousProgressPanel({ loop, onPause, onResume, onStop, onCheck, disabled = false, unconfirmed = false }: {
  loop: ContinuousProgressPanelLoop
  onPause?: () => void
  onResume?: () => void
  onStop?: () => void
  onCheck?: () => void
  disabled?: boolean
  unconfirmed?: boolean
}) {
  return <section className="continuous-progress-panel" aria-label={`Continuous progress · ${loop.providerLabel}`}>
    <dl className="continuous-progress-panel__summary">
      <dt>{unconfirmed ? 'Last known loop status' : 'Loop'}</dt><dd>{loop.loopState}</dd>
      <dt>Agent execution</dt><dd>{loop.executionState}</dd>
      {!unconfirmed && loop.loopState === 'active' && loop.nextCheckAt !== undefined ? <><dt>Next check</dt><dd><time dateTime={new Date(loop.nextCheckAt).toISOString()}>{new Date(loop.nextCheckAt).toLocaleTimeString()}</time></dd></> : null}
      {loop.lastTickAt !== undefined ? <><dt>Last check</dt><dd><time dateTime={new Date(loop.lastTickAt).toISOString()}>{new Date(loop.lastTickAt).toLocaleString()}</time></dd></> : null}
    </dl>
    {loop.loopState !== 'stopped' ? <>
      <div className="continuous-progress-panel__actions">
        {loop.loopState === 'active' ? <button type="button" aria-label="Pause continuous progress" disabled={disabled} onClick={onPause}><Pause size={13} aria-hidden="true" />Pause</button> : <button type="button" aria-label="Resume continuous progress" disabled={disabled} onClick={onResume}><Play size={13} aria-hidden="true" />Resume</button>}
        <button type="button" aria-label="Check continuous progress now" disabled={disabled || loop.loopState !== 'active'} onClick={onCheck}><RefreshCw size={13} aria-hidden="true" />Check now</button>
        <button type="button" aria-label="Stop continuous progress" disabled={disabled} onClick={onStop}><Square size={13} aria-hidden="true" />Stop loop</button>
      </div>
      <p className="continuous-progress-control__help">Stop loop ends automatic continuation. It does not stop the Agent.</p>
    </> : null}
    {loop.lastDecision ? <div className="continuous-progress-panel__decision"><h4>Latest decision</h4><p>{loop.lastDecision}</p></div> : null}
  </section>
}
