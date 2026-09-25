import { useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { presentError } from '../lib/error-presentation'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import type { RenderableServiceNotice } from '../lib/service-window-notice'

export const TERMINAL_GAP_NOTICE: RenderableServiceNotice = { kind: 'process-degraded', notice: {
  step: 'Earlier scrollback is unavailable',
  mode: 'Earlier Runtime output is no longer retained or the source reported a byte gap.',
  restore: 'Redraw requests a repaint of the current screen; it cannot restore missing history.'
} }

/** The gap fact remains owned by TerminalView; requesting a repaint never resolves that fact. */
export function TerminalReplayGapNotice({ scope, visible = true, canRedraw, onRedraw, embedded = false }: {
  scope: string
  visible?: boolean
  canRedraw: boolean
  /** Complete content within the Terminal service disclosure, without a nested popover. */
  embedded?: boolean
  onRedraw(): Promise<boolean>
}) {
  const [redrawing, setRedrawing] = useState(false)
  const [requested, setRequested] = useState(false)
  const [error, setError] = useState('')
  const content = <div className="terminal-gap-details">
    <ServiceWindowNotice notice={TERMINAL_GAP_NOTICE} />
    {requested ? <p role="status">Screen redraw requested. Missing history remains unavailable.</p> : null}
    {error ? <p role="status">{error}</p> : null}
    {canRedraw ? <button type="button" className="small-button" disabled={redrawing}
      title="Redraw current screen; missing history cannot be restored"
      aria-label="Redraw current terminal screen" onClick={() => {
        setRedrawing(true); setError('')
        void onRedraw().then((accepted) => {
          if (accepted) setRequested(true)
          else setError('Screen redraw unavailable while the terminal is not ready. Try again when visible and connected.')
        }).catch((cause) => setError(`Screen redraw failed: ${presentError(cause)}`))
          .finally(() => setRedrawing(false))
      }}>
      {redrawing ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}
      {redrawing ? 'Requesting…' : 'Redraw'}
    </button> : null}
  </div>
  if (embedded) return content
  return <ServiceNoticeDisclosure scope={scope} visible={visible}
    notices={[{ id: 'history-gap', cause: 'retained-output-gap', notice: TERMINAL_GAP_NOTICE }]}>
    {content}
  </ServiceNoticeDisclosure>
}
