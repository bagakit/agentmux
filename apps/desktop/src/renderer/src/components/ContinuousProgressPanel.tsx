import { Pause, Play, Square, RefreshCw } from 'lucide-react'

export type ContinuousProgressPanelLoop = {
  loopId: string
  providerLabel: string
  executionState: string
  loopState: 'active' | 'paused' | 'stopped'
  nextCheckAt?: number
  lastDecision?: string
}

export function ContinuousProgressPanel({ loop, onPause, onResume, onStop, onCheck }: {
  loop: ContinuousProgressPanelLoop
  onPause?: () => void
  onResume?: () => void
  onStop?: () => void
  onCheck?: () => void
}) {
  return <section className="continuous-progress-panel" aria-label={`Continuous progress · ${loop.providerLabel}`}>
    <div className="continuous-progress-panel__summary">
      <strong>↻ Continuous progress · {loop.providerLabel}</strong>
      <span>{loop.executionState} · {loop.loopState}</span>
      {loop.nextCheckAt ? <time dateTime={new Date(loop.nextCheckAt).toISOString()}>Next check {new Date(loop.nextCheckAt).toLocaleTimeString()}</time> : null}
    </div>
    {loop.lastDecision ? <small className="continuous-progress-panel__decision">{loop.lastDecision}</small> : null}
    <div className="continuous-progress-panel__actions">
      {loop.loopState === 'active' ? <button type="button" aria-label="Pause continuous progress" onClick={onPause}><Pause size={13} /></button> : <button type="button" aria-label="Resume continuous progress" onClick={onResume}><Play size={13} /></button>}
      <button type="button" aria-label="Check continuous progress now" onClick={onCheck}><RefreshCw size={13} /></button>
      <button type="button" aria-label="Stop continuous progress" onClick={onStop}><Square size={13} /></button>
    </div>
  </section>
}
