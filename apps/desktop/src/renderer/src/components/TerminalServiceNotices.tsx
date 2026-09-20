import type { RenderableServiceNotice } from '../lib/service-window-notice'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** Only this Terminal's existing facts. No classifier, subscription, recovery action or error owner. */
export function TerminalServiceNotices({ reveal, replayGeometry, viewportSync, continuation, duringReconnect = false,
  attachment, sessionObservation, refreshingObservation = false, onRefreshObservation }: {
  reveal: RenderableServiceNotice | null
  replayGeometry: RenderableServiceNotice | null
  viewportSync: RenderableServiceNotice | null
  continuation: RenderableServiceNotice | null
  duringReconnect?: boolean
  attachment?: RenderableServiceNotice | null
  sessionObservation?: RenderableServiceNotice | null
  refreshingObservation?: boolean
  onRefreshObservation?(): void
}) {
  if (!attachment && !sessionObservation && !reveal && !replayGeometry && !viewportSync && !continuation) return null
  return <div className="terminal-service-window" aria-label="Terminal service notices" tabIndex={0}>
    {attachment ? <ServiceWindowNotice notice={attachment} summary={{
      step: attachment.notice.step,
      mode: 'Run availability and input delivery unconfirmed; Session, history and draft retained.',
      restore: attachment.notice.restore
    }} /> : null}
    <ServiceWindowNotice notice={sessionObservation ?? null} />
    {reveal ? <ServiceWindowNotice notice={reveal} summary={{
      step: 'Terminal restoration unconfirmed', mode: reveal.notice.mode,
      restore: 'Reopen or resume to retry replay.'
    }} /> : null}
    {replayGeometry ? <ServiceWindowNotice notice={replayGeometry} summary={{
      step: 'Replay layout unconfirmed',
      mode: replayGeometry.kind === 'indeterminate' ? replayGeometry.notice.mode : 'Terminal available; retained layout size is unknown.',
      restore: 'Resize to retry; historical layout remains unconfirmed.'
    }} /> : null}
    {viewportSync ? <ServiceWindowNotice notice={viewportSync} summary={{
      step: 'Terminal size unconfirmed',
      mode: viewportSync.kind === 'indeterminate' ? viewportSync.notice.mode : 'Terminal available; requested size is unconfirmed.',
      restore: 'Resize or return to this tab to retry.'
    }} /> : null}
    {continuation ? <ServiceWindowNotice notice={continuation} summary={{
      step: 'Terminal state unconfirmed',
      mode: continuation.kind === 'indeterminate' ? continuation.notice.mode : duringReconnect
        ? 'Terminal display may be incomplete; live input remains available while the Run is healthy.'
        : 'History and input modes are unconfirmed; live input remains available while the Run is healthy.',
      restore: 'Reopen to retry the checkpoint. Missing origin or evicted bytes cannot be recovered.'
    }} /> : null}
    {onRefreshObservation ? <button type="button" className="small-button" disabled={refreshingObservation}
      onClick={onRefreshObservation}>{refreshingObservation ? 'Refreshing observation…' : 'Refresh observation'}</button> : null}
  </div>
}
