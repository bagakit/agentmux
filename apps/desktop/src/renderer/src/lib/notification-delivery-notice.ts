import type { NotificationDelivery } from '../../../shared/contracts'
import type { ErrorNoticeContext } from '../store'

/** Both OS channels report the same platform receipt through the existing event owner. */
export function notificationDeliveryNotice(delivery: NotificationDelivery): { message: string; context: ErrorNoticeContext } | null {
  if (delivery.status === 'unsupported') return {
    message: `Desktop notifications are unavailable: ${delivery.reason}. Agent attention and messages remain available in this window. Check your system notification settings.`,
    context: { kind: 'process-degraded', summary: 'Desktop banners are unavailable',
      event: { source: 'desktop-notifications', key: 'unsupported', object: { kind: 'application', id: 'desktop' } } }
  }
  if (delivery.presentation === 'downgraded') return {
    message: 'This platform cannot keep a notification open until dismissed; it was shown as a normal banner. Agent attention and messages remain available in this window.',
    context: { kind: 'process-degraded', summary: 'Desktop banners use the system duration',
      event: { source: 'desktop-notifications', key: 'presentation-downgraded', object: { kind: 'application', id: 'desktop' } } }
  }
  return null
}
