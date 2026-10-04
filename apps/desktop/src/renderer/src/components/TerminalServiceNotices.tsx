import type { ReactNode } from 'react'
import type { RenderableServiceNotice } from '../lib/service-window-notice'
import type { ServiceNoticeItem } from '../lib/use-service-notices'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** Only this Terminal's existing facts. No classifier, subscription, recovery action or error owner. */
export function TerminalServiceNotices({ scope, visible = true, available = true,
  reveal, replayGeometry, viewportSync, continuation,
  attachment, sessionObservation, causes = {}, historyNotice, historyContent,
  refreshingObservation = false, onRefreshObservation }: {
  scope: string
  visible?: boolean
  available?: boolean
  reveal: RenderableServiceNotice | null
  replayGeometry: RenderableServiceNotice | null
  viewportSync: RenderableServiceNotice | null
  continuation: RenderableServiceNotice | null
  attachment?: RenderableServiceNotice | null
  sessionObservation?: RenderableServiceNotice | null
  causes?: Partial<Record<'attachment' | 'sessionObservation' | 'reveal' | 'replayGeometry' | 'viewportSync' | 'continuation', string>>
  historyNotice?: ServiceNoticeItem | null
  historyContent?: ReactNode
  refreshingObservation?: boolean
  onRefreshObservation?(): void
}) {
  const notices: ServiceNoticeItem[] = (Object.entries({ attachment, sessionObservation, reveal, replayGeometry, viewportSync, continuation }) as
    [keyof typeof causes, RenderableServiceNotice | null | undefined][]).flatMap(([id, notice]) => notice
      ? [{ id, notice, ...(causes[id] ? { cause: causes[id] } : {}) }] : [])
  if (historyNotice) notices.push(historyNotice)
  // Keep the public receipt owner mounted even with no current notices: confirmed recovery clears
  // acknowledgements, while an unavailable observation retains them. No empty track is rendered.
  return <ServiceNoticeDisclosure scope={scope} visible={visible} available={available} notices={notices}
    className="terminal-service-window"
    title={notices.length === 1 ? (continuation ? 'Terminal state unconfirmed' : notices[0]!.notice.notice.step) : 'Terminal service notices'}
    actions={onRefreshObservation && notices.length ? <button type="button" className="small-button" disabled={refreshingObservation}
      onClick={onRefreshObservation}>{refreshingObservation ? 'Refreshing observation…' : 'Refresh observation'}</button> : null}>
    <ServiceWindowNotice notice={attachment ?? null} />
    <ServiceWindowNotice notice={sessionObservation ?? null} />
    <ServiceWindowNotice notice={reveal} />
    <ServiceWindowNotice notice={replayGeometry} />
    <ServiceWindowNotice notice={viewportSync} />
    <ServiceWindowNotice notice={continuation} />
    {historyContent}
  </ServiceNoticeDisclosure>
}
