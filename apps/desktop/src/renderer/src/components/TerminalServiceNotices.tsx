import { Button } from '@agentmux/client-ui/components/Button'
import type { SessionControl } from '../../../shared/contracts'
import { TerminalStorageDetails } from './TerminalStorageDetails'
import type { ReactNode } from 'react'
import type { RenderableServiceNotice } from '../lib/service-window-notice'
import type { ServiceNoticeItem } from '../lib/use-service-notices'
import { ServiceNoticeDisclosure } from './ServiceNoticeDisclosure'
import { ServiceWindowNotice } from './ServiceWindowNotice'

/** Only this Terminal's existing facts. No classifier, subscription, recovery action or error owner. */
export function TerminalServiceNotices({ scope, visible = true, available = true,
  reveal, replayGeometry, viewportSync, continuation,
  attachment, writeObservation, sessionRefresh, sessionObservation, hookIngress, hookDelivery, causes = {}, historyNotice, historyContent,
  refreshingObservation = false, onRefreshObservation, storageControl, continuationReason, connectionObservations = [] }: {
  scope: string
  visible?: boolean
  available?: boolean
  reveal: RenderableServiceNotice | null
  replayGeometry: RenderableServiceNotice | null
  viewportSync: RenderableServiceNotice | null
  continuation: RenderableServiceNotice | null
  attachment?: RenderableServiceNotice | null
  writeObservation?: RenderableServiceNotice | null
  sessionRefresh?: RenderableServiceNotice | null
  sessionObservation?: RenderableServiceNotice | null
  hookIngress?: RenderableServiceNotice | null
  hookDelivery?: RenderableServiceNotice | null
  causes?: Partial<Record<'attachment' | 'writeObservation' | 'sessionRefresh' | 'sessionObservation' | 'hookIngress' | 'hookDelivery' | 'reveal' | 'replayGeometry' | 'viewportSync' | 'continuation', string>>
  historyNotice?: ServiceNoticeItem | null
  historyContent?: ReactNode
  refreshingObservation?: boolean
  storageControl?: SessionControl
  continuationReason?: string | undefined
  connectionObservations?: readonly ServiceNoticeItem[]
  onRefreshObservation?(): void
}) {
  const notices: ServiceNoticeItem[] = (Object.entries({ attachment, writeObservation, sessionRefresh, sessionObservation, hookIngress, hookDelivery, reveal, replayGeometry, viewportSync, continuation }) as
    [keyof typeof causes, RenderableServiceNotice | null | undefined][]).flatMap(([id, notice]) => notice
      ? [{ id, notice, ...(causes[id] ? { cause: causes[id] } : {}) }] : [])
  if (historyNotice) notices.push(historyNotice)
  notices.push(...connectionObservations)
  // Keep the public receipt owner mounted even with no current notices: confirmed recovery clears
  // acknowledgements, while an unavailable observation retains them. No empty track is rendered.
  return <ServiceNoticeDisclosure scope={scope} visible={visible} available={available} notices={notices}
    className="terminal-service-window"
    title={notices.length === 1 ? (continuation ? 'Terminal state unconfirmed' : notices[0]!.notice.notice.step) : 'Terminal service notices'}
    actions={onRefreshObservation && notices.length ? <Button type="button" disabled={refreshingObservation}
      onClick={onRefreshObservation}>{refreshingObservation ? 'Refreshing observation…' : 'Refresh observation'}</Button> : null}>
    <ServiceWindowNotice notice={attachment ?? null} />
    <ServiceWindowNotice notice={writeObservation ?? null} />
    <ServiceWindowNotice notice={sessionRefresh ?? null} />
    <ServiceWindowNotice notice={sessionObservation ?? null} />
    <ServiceWindowNotice notice={hookIngress ?? null} />
    <ServiceWindowNotice notice={hookDelivery ?? null} />
    <ServiceWindowNotice notice={reveal} />
    <ServiceWindowNotice notice={replayGeometry} />
    <ServiceWindowNotice notice={viewportSync} />
    <ServiceWindowNotice notice={continuation} />
    {connectionObservations.map(item => <ServiceWindowNotice key={item.id} notice={item.notice} />)}
    {historyContent}
    {storageControl ? <TerminalStorageDetails control={storageControl} scope={scope} visible={visible} continuationReason={continuationReason} /> : null}
  </ServiceNoticeDisclosure>
}
