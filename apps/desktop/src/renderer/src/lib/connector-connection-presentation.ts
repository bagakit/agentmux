import type { GroupDiagnosis } from './group-diagnosis'

/** Receiving connection only. Publication and input observations never decide socket liveness. */
export function connectorConnectionPresentation(report: GroupDiagnosis | null) {
  const connection = report?.connection, current = connection && !connection.issue && !connection.retained ? connection.value : null
  const receiver = current?.receiver
  const scheduled = receiver?.state === 'ended' && receiver.nextAttemptAt !== undefined
  const state = receiver?.state === 'ready' && current?.transport.state === 'ready' ? 'online' :
    receiver?.state === 'starting' || receiver?.state === 'recovering' || scheduled ? 'recovering' : receiver?.state === 'ended' ? 'stopped' : 'unknown'
  const title = { online: 'Receiving online', recovering: 'Reconnecting', stopped: 'Receiving stopped', unknown: 'Needs checking' }[state]
  const shortTitle = { online: 'Online', recovering: 'Reconnecting', stopped: 'Stopped', unknown: 'Not checked' }[state]
  const policies = report ? [report.service, report.adapterService, report.connection, report.binding] : []
  const active = policies.length > 0 && policies.every(section => !!section.value && !section.issue && !section.retained) &&
    report!.service.value!.enabled && report!.adapterService.value!.enabled && report!.connection.value!.enabled && report!.binding.value!.state === 'active'
  const out = report?.outgoing.value, source = !report?.outgoing.issue && !report?.outgoing.retained ? out?.sourceObservation : null
  const busy = source?.state === 'unavailable' && source.code === 'AGENT_SESSION_HISTORY_BUSY'
  const sourceNeedsRecovery = !!source && source.state !== 'ready'
  const service = report?.service && !report.service.issue && !report.service.retained ? report.service.value : null
  const adapter = report?.adapterService && !report.adapterService.issue && !report.adapterService.retained ? report.adapterService.value : null
  const binding = report?.binding && !report.binding.issue && !report.binding.retained ? report.binding.value : null
  const policy = service?.enabled === false ? { kind: 'sync' as const, label: 'Review automatic sync', hint: 'Automatic sync is off' } :
    adapter?.enabled === false || current?.enabled === false ? { kind: 'channel-settings' as const, label: 'Open bot settings', hint: 'Automatic receiving is off' } :
    binding?.state === 'paused' ? { kind: 'sharing' as const, label: 'Review group sync', hint: 'This group is paused' } : null
  const primary: 'sync' | 'channel-settings' | 'sharing' | 'source' | 'check' = policy ? policy.kind : state === 'online' && sourceNeedsRecovery ? 'source' : 'check'
  const actionLabel = policy?.label ?? (primary === 'source' ? 'Try sync now' : state === 'recovering' ? 'Check progress' : state === 'unknown' ? 'Check connection' : 'Check status')
  const hint = policy?.hint ?? (busy ? active ? 'Reply sync busy · will retry automatically' : 'Reply sync is busy' : sourceNeedsRecovery ? 'Reply sync needs checking' : null)
  const waiting = report?.incoming.value?.rows.find(row => row.kind === 'message' && row.scope === 'current-binding' && row.inputOperationId && row.coreStatus === 'waiting') ?? null
  const needsCheck = !!report && ([report.connection, report.incoming, report.outgoing].some(section => !!section.issue) || current?.intake.reason === 'check-failed' ||
    out?.effectObservation?.state === 'unknown' || out?.deliveries.some(row => row.state === 'unknown' || row.state === 'not-applied') ||
    !!out?.coverage?.gaps.length || sourceNeedsRecovery && !busy)
  const policyState = policy?.kind === 'sharing' ? 'paused' as const : policy ? 'off' as const : null
  return { state, title, shortTitle, hint, primary, actionLabel, active, policyState, waiting, attention: needsCheck ? 'check' as const : null,
    scope: 'Receiving connection for this bot’s groups.' }
}
