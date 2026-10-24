import type { ExecutorChoice } from '../lib/executors'
import { ServiceWindowNotice } from './ServiceWindowNotice'

export function LauncherAvailabilityNotice({ executor, checking, retrying, onCheck }: {
  executor: ExecutorChoice | undefined
  checking: boolean
  retrying: boolean
  onCheck(): void
}) {
  const detection = executor?.detection
  if (!executor || detection?.state === 'ready' || detection?.state === 'missing') return null
  const failed = detection?.state === 'error' || Boolean(detection?.detail)
  const step = checking ? 'Checking Agent availability' : failed ? 'Agent check needs attention' : 'Agent availability has not been checked'
  const mode = `${executor.label} remains available to launch.${detection?.detail ? ` ${detection.detail}` : ''}`
  const restore = checking ? 'Checking this host. You can keep writing or launch now.'
    : retrying ? 'Rechecking automatically. You can keep writing or check again now.'
      : 'Check again to refresh this host. Your draft and launch options are kept.'
  return <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step, mode, restore } }}
    summary={{ step, mode: `${executor.label} is configured. Launch remains available.`, restore }}
    actions={<button type="button" className="small-button" disabled={checking} onClick={onCheck}>
      {checking ? 'Checking…' : 'Check again'}
    </button>} />
}
