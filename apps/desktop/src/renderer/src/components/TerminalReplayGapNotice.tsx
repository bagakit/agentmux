import { useState } from 'react'
import { History, LoaderCircle, RefreshCw } from 'lucide-react'
import { presentError } from '../lib/error-presentation'

export function TerminalReplayGapNotice({ canRedraw, onRedraw }: {
  canRedraw: boolean
  onRedraw(): Promise<boolean>
}) {
  const [redrawing, setRedrawing] = useState(false)
  const [requested, setRequested] = useState(false)
  const [error, setError] = useState('')
  const explanation = 'Earlier scrollback is unavailable. Redraw requests a repaint of the current screen; it cannot restore missing history.'
  if (requested) return <div className="terminal-replay-gap terminal-replay-gap--compact" role="status" title={`Screen redraw requested. ${explanation}`} aria-label={`Screen redraw requested. ${explanation}`}>
    <History size={12} aria-hidden="true" />
  </div>
  return <div className="terminal-replay-gap" role="status">
    <History size={12} aria-hidden="true" />
    <span title={explanation}>{error || 'Earlier scrollback is unavailable'}</span>
    {canRedraw ? <button type="button" disabled={redrawing}
      title="Redraw current screen; missing history cannot be restored"
      aria-label="Redraw current terminal screen" onClick={() => {
        setRedrawing(true); setError('')
        void onRedraw().then((accepted) => {
          if (accepted) setRequested(true)
          else setError('Screen redraw unavailable while the terminal is not ready. Try again when visible and connected.')
        }).catch((cause) => setError(`Screen redraw failed: ${presentError(cause)}`))
          .finally(() => setRedrawing(false))
      }}>
      {redrawing ? <LoaderCircle className="spin" size={11} /> : <RefreshCw size={11} />}
      {redrawing ? 'Requesting…' : 'Redraw'}
    </button> : null}
  </div>
}
