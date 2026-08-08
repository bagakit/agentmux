import { useAppStore } from '../store'
import { ServiceWindowNotice } from './ServiceWindowNotice'

export function RuntimeOwnershipNotice() {
  const hosts = useAppStore((state) => state.runtimeOwnershipWarnings)
  return <ServiceWindowNotice notice={hosts.length > 0 ? {
    kind: 'process-degraded',
    notice: {
      step: 'Runtime launch record is unavailable',
      mode: `Connected to the compatible Runtime on ${hosts.join(', ')}. Existing Agents remain usable; the shared daemon will not be terminated to repair this record.`,
      restore: 'You can continue working. A new launch record will be saved when AgentMux next starts a daemon; restarting the app is not required.'
    }
  } : null} />
}
