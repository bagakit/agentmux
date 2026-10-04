import { ClientDeliveryDiagnostics, deliveryLogNotice, type DeliveryAttemptSeed } from '@agentmux/client-ui/delivery-diagnostics'
import { api } from './api'

// The receiving Desktop business endpoint, independent of the selected execution Host.
const OWNER = 'desktop-business-local'
export const messageDeliveryDiagnostics = new ClientDeliveryDiagnostics()
export function reportMessageDeliveryDiagnostics(): Promise<void> {
  return messageDeliveryDiagnostics.sync(OWNER, record => api.sessions.recordDeliveryFailure(record))
}
export async function recordMessageDeliveryFailure(seed: DeliveryAttemptSeed, error: unknown, stage: string) {
  const entry = await messageDeliveryDiagnostics.failed(seed, error, stage, OWNER)
  void reportMessageDeliveryDiagnostics()
  return { logId: entry.record.logId, notice: deliveryLogNotice(entry) }
}
