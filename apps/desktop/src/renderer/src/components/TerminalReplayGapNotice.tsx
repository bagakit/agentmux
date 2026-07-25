import { History, LoaderCircle, RefreshCw } from 'lucide-react'

export function TerminalReplayGapNotice({
  canRedraw,
  redrawing,
  onRedraw
}: {
  canRedraw: boolean
  redrawing: boolean
  onRedraw(): void
}) {
  return (
    <div className="terminal-replay-gap" role="status">
      <History size={12} aria-hidden="true" />
      <span>Earlier scrollback is unavailable</span>
      {canRedraw ? (
        <button
          type="button"
          disabled={redrawing}
          title="Redraw current screen"
          aria-label="Redraw current terminal screen"
          onClick={onRedraw}
        >
          {redrawing ? <LoaderCircle className="spin" size={11} /> : <RefreshCw size={11} />}
          Redraw
        </button>
      ) : null}
    </div>
  )
}
