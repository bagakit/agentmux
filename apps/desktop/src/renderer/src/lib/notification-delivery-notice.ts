import type { NotificationDelivery, SessionControl } from '../../../shared/contracts'

/** Both OS channels report the same platform receipt through the existing event owner. */
export function notificationDeliveryNotice(delivery: NotificationDelivery, request: { requestId: string; subject: SessionControl }) {
  if (delivery.status === 'unsupported') return {
    message: `Desktop notifications are unavailable: ${delivery.reason}. Agent attention and messages remain available in this window. Check your system notification settings.`,
    context: { kind: 'process-degraded', summary: 'Desktop banners are unavailable',
      event: { source: 'desktop-notifications', key: 'unsupported', object: { kind: 'application', id: 'desktop' } } } as const
  }
  if (delivery.status === 'failed' || delivery.status === 'unknown') return {
    message: `${delivery.status === 'failed' ? 'The system could not display this notification' : 'Desktop notification display was not confirmed'}: ${delivery.reason}. Agent attention and messages remain available in this window. Review the receiving Session and your system notification settings; this notification was not resent.`,
    context: { kind: delivery.status === 'failed' ? 'process-degraded' : 'indeterminate', subject: request.subject,
      summary: delivery.status === 'failed' ? 'Desktop banner delivery failed' : 'Desktop banner display is unconfirmed',
      event: { source: 'desktop-notifications', key: request.requestId } } as const
  }
  if (delivery.presentation === 'downgraded') return {
    message: 'This platform cannot keep a notification open until dismissed; it was shown as a normal banner. Agent attention and messages remain available in this window.',
    context: { kind: 'process-degraded', summary: 'Desktop banners use the system duration',
      event: { source: 'desktop-notifications', key: 'presentation-downgraded', object: { kind: 'application', id: 'desktop' } } } as const
  }
  return null
}
