import type { GroupDiagnosis } from './group-diagnosis'
import type { CheckedGroupDiagnosis } from './use-connector-group-diagnosis'

/** Display only: these original observations confer no input, delivery or retry authority. */
export function connectorGroupStatus(snapshot: CheckedGroupDiagnosis | undefined) {
  const report = snapshot?.report
  if (!report) return { label: snapshot?.checking ? 'Checking…' : 'Not checked', tone: 'unknown', rows: [] as Array<[string, string]>, outcome: 'Not checked' }
  const sections = [report.service, report.connection, report.binding, report.outgoing, report.incoming]
  const issues = sections.filter(section => section.issue), retained = sections.some(section => section.retained)
  const config = report.binding.value, service = report.service.value, connection = report.connection.value, out = report.outgoing.value
  const policy = [config ? config.state === 'active' ? 'Linked' : config.state === 'paused' ? 'Sharing paused' : 'Detached' : 'Link unconfirmed',
    `Sync ${service ? service.enabled ? 'on' : 'off' : 'unknown'}`, `Bot ${connection ? connection.enabled ? 'on' : 'off' : 'unknown'}`].join(' · ')
  const gaps = out?.coverage ? out.coverage.gaps.length + out.coverage.omittedGapCount : 0
  const source = !out ? 'Reading unavailable' : out.observation?.reason === 'content-unconfirmed' ? 'Content not confirmed' :
    out.sourceObservation?.state === 'ready' ? 'Read confirmed' : out.sourceObservation?.state === 'unavailable' ? 'Reading unavailable' : 'Reading unconfirmed'
  const sourceText = source + (gaps ? ` · ${gaps} content gap${gaps === 1 ? '' : 's'} in this page` : out?.coverage?.state === 'incomplete' ? ' · coverage incomplete' : '')
  const counts = { confirmed: 0, unknown: 0, pending: 0, notApplied: 0 }
  for (const delivery of out?.deliveries ?? []) {
    if (delivery.receipt === 'confirmed') counts.confirmed++
    else if (delivery.receipt === 'unknown' || delivery.state === 'unknown') counts.unknown++
    else if (delivery.receipt === 'not-applied' || delivery.state === 'not-applied') counts.notApplied++
    else if (delivery.state === 'pending' || delivery.state === 'dispatching') counts.pending++
  }
  const effects = [[counts.confirmed, 'confirmed'], [counts.unknown, 'unconfirmed'], [counts.pending, 'pending'], [counts.notApplied, 'not applied']]
    .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(' · ')
  const requests = (effects ? `This window: ${effects}` : out?.deliveries.length ? `${out.deliveries.length} original requests; outcomes not recorded` : 'No requests in this window') +
    (out?.effectObservation?.state === 'unknown' ? ' · original results remain unconfirmed' : '') + (out?.next ? ' · more receipts available' : '')
  const incoming = incomingStatus(report)
  const sharing = config ? `${config.scope.publication === 'future-shared-conversation' ? 'Confirmed user messages and public Agent replies' : 'Public Agent replies and questions'} → group · ${config.scope.input === 'all-messages' ? 'All group messages' : 'Mentions and replies'} → Agent (member access required)` : 'Range unconfirmed'
  const attention = gaps > 0 || out?.coverage?.state === 'incomplete' || out?.observation?.reason === 'content-unconfirmed' || out?.observation?.state === 'unavailable' ||
    out?.sourceObservation?.state === 'unavailable' || out?.effectObservation?.state === 'unknown' || counts.unknown > 0 || counts.notApplied > 0 || report.incoming.value?.rows[0]?.state === 'refused'
  const label = issues.length ? 'Status unknown' : service?.enabled === false ? 'Sync off' : config?.state === 'paused' ? 'Sharing paused' :
    connection?.enabled === false ? 'Bot off' : attention ? 'Needs attention' : service?.enabled ? 'Sync on' : 'Status unknown'
  return { label, tone: issues.length ? 'unknown' : attention ? 'attention' : 'neutral', outcome: issues.length === sections.length ? 'Unavailable' : issues.length ? 'Partial' : 'Checked',
    rows: [['Configuration', policy], ['Sharing', sharing], ['Conversation → group', sourceText], ['Platform requests', out ? requests : 'Reading unavailable'], ['Group → Agent', incoming],
      ...(retained ? [['Earlier observations', 'Kept after this check failed; not current confirmation']] : [])] as Array<[string, string]> }
}

function incomingStatus(report: GroupDiagnosis): string {
  const row = report.incoming.value?.rows[0]
  if (!report.incoming.value) return 'Reading unavailable'
  if (!row) return 'No events in this window'
  const recorded = row.recording?.state === 'recorded' ? 'Conversation recorded' : 'Recording unconfirmed'
  if (!row.inputOperationId) return recorded + (row.state === 'refused' ? row.code === 'INGRESS_ACTOR_NOT_AUTHORIZED' ? ' · not sent; member request access missing' : ' · request refused' : ' · no Agent submission recorded')
  if (row.coreObservation === 'unavailable') return recorded + ' · Agent submission observation unavailable'
  const status = row.coreStatus
  const input = status === 'admitted' ? 'Accepted by Agent' : status === 'waiting' ? 'Waiting for Agent' : status === 'stopped' ? 'Input delivery stopped' :
    status === 'not-applied' ? 'Not delivered to Agent' : status === 'terminal-confirmed' || status === 'bytes-accepted' ? 'Input sent; Agent acceptance unconfirmed' : 'Input outcome unconfirmed'
  return `${recorded} · ${input}`
}
