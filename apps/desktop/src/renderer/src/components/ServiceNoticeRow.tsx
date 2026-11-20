import type { MouseEvent } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { ServiceNoticeItem } from '../lib/use-service-notices'
import { serviceNoticeFingerprint } from '../lib/use-service-notices'
import { MailboxRecordRow, MailboxTime } from './MailboxReading'

export function ServiceNoticeRow({ item, unread, onOpen }: {
  item: ServiceNoticeItem; unread: boolean; onOpen(key: string, event: MouseEvent<HTMLButtonElement>): void
}) {
  const notice = item.summary ?? item.notice.notice
  const indeterminate = item.notice.kind === 'indeterminate'
  return <MailboxRecordRow
    recordKey={`notice:${item.id}:${serviceNoticeFingerprint(item)}`} label={notice.step} text={notice.mode.slice(0, 240)}
    avatar={<span className="composer-notice__glyph"><SemanticIcon name={indeterminate ? 'status.unknown' : 'status.warning'} size={15} aria-hidden="true" />
      {unread ? <span className="composer-notice__unread" role="img" aria-label="Unread" title="Unread" /> : null}</span>}
    context={<span className="composer-notice__state">{indeterminate ? 'Result unconfirmed' : 'Needs attention'}</span>}
    metadata={item.observedAt === undefined ? null : <MailboxTime value={item.observedAt} />}
    actions={item.action ? <button type="button" className="composer-notice__action" aria-label={`${item.action.label}: ${notice.step}`}
      onClick={() => item.action!.run()}><span>{item.action.label}</span><span aria-hidden="true">→</span></button> : undefined}
    onOpen={onOpen} />
}
