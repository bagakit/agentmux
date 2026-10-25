import type { GroupDiagnosis } from './group-diagnosis'
import type { CheckedGroupDiagnosis } from './use-connector-group-diagnosis'
import type { RoomBinding } from '@agentmux/core/connections'

/** Display only: these original observations confer no input, delivery or retry authority. */
export function connectorGroupDiagnostics(snapshot: CheckedGroupDiagnosis | undefined) {
  const report = snapshot?.report
  if (!report) return { rows: [] as Array<[string, string]>, outcome: 'Not checked' }
  const sections = [report.service, report.adapterService, report.connection, report.binding, report.outgoing, report.incoming]
  const issues = sections.filter(section => section.issue), retained = sections.some(section => section.retained)
  const config = report.binding.value, service = report.service.value, adapterService = report.adapterService.value, connection = report.connection.value, out = report.outgoing.value
  const policy = [config ? config.state === 'active' ? 'Linked' : config.state === 'paused' ? 'Sharing paused' : 'Detached' : 'Link unconfirmed',
    `Sync ${service ? service.enabled ? 'on' : 'off' : 'unknown'}`, `Platform ${adapterService ? adapterService.enabled ? 'on' : 'off' : 'unknown'}`, `Bot ${connection ? connection.enabled ? 'on' : 'off' : 'unknown'}`].join(' · ')
  const { gapCount: gaps, accessUnconfirmed, effects } = outgoingFacts(out)
  const source = !out ? 'Reading unavailable' : out.observation?.reason === 'content-unconfirmed' ? 'Content not confirmed' :
    out.sourceObservation?.state === 'ready' ? 'Read confirmed' : out.sourceObservation?.state === 'unavailable' ? 'Reading unavailable' : 'Reading unconfirmed'
  const sourceText = source + (gaps ? ` · ${gaps} content gap${gaps === 1 ? '' : 's'} in this page` : out?.coverage?.state === 'incomplete' ? ' · coverage incomplete' : '')
  const requests = (effects ? `This window: ${effects}` : out?.deliveries.length ? `${out.deliveries.length} original requests; outcomes not recorded` : 'No requests in this window') +
    (out?.effectObservation?.state === 'unknown' ? ' · original results remain unconfirmed' : '') + (out?.next ? ' · more receipts available' : '')
  const incoming = incomingStatus(report)
  const sharing = config ? `${config.scope.publication === 'future-shared-conversation' ? 'Confirmed user messages and public Agent replies' : 'Public Agent replies and questions'} → group · ${config.scope.input === 'all-messages' ? 'All group messages' : 'Mentions and replies'} → Agent (member access required)` : 'Range unconfirmed'
  return { outcome: issues.length === sections.length ? 'Unavailable' : issues.length ? 'Partial' : 'Checked',
    rows: [['Configuration', policy], ['Sharing', sharing], ['Conversation → group', sourceText], ['Platform requests', out ? requests : 'Reading unavailable'], ['Group → Agent', incoming],
      ...(accessUnconfirmed ? [['Member access', 'Application permissions could not be checked; saved decisions are kept']] : []),
      ...(retained ? [['Earlier observations', 'Kept after this check failed; not current confirmation']] : [])] as Array<[string, string]> }
}

/** A past refusal describes that one event, never current access or the whole link. */
function incomingRefusal(code: string | null): { title: string; detail: string; action: ConnectorProblemAction } {
  if (code === 'INGRESS_CONTENT_UNSUPPORTED') return { title: 'Message type not supported', detail: 'This message was not sent to the Agent. Try a text message. Other messages and replies can still be delivered.', action: { kind: 'incoming', label: 'View message details' } }
  if (code === 'INGRESS_QUESTION_ANSWER_INVALID') return { title: 'Check the question answers', detail: 'These answers were not sent. Complete each question in the original card before submitting. Other messages and replies are unaffected.', action: { kind: 'incoming', label: 'View event details' } }
  if (code === 'INGRESS_ACTION_UNSUPPORTED') return { title: 'Action not supported', detail: 'This group action was not sent to the Agent. It does not stop ordinary messages or replies.', action: { kind: 'incoming', label: 'View event details' } }
  if (code === 'INGRESS_ACTOR_NOT_AUTHORIZED') return { title: 'Member request was refused', detail: 'This sender could not ask the Agent when this message arrived. Other approved members can still send requests.', action: { kind: 'members', label: 'Member access' } }
  return { title: 'Last request refused', detail: 'This request was not sent to the Agent. Open its original receipt for the reason; other messages have independent results.', action: { kind: 'incoming', label: 'View request details' } }
}

function incomingStatus(report: GroupDiagnosis): string {
  const row = report.incoming.value?.rows[0]
  if (!report.incoming.value) return 'Reading unavailable'
  if (!row) return 'No events in this window'
  if (row.scope === 'other-binding') return 'Earlier connection receipt · does not confirm this connection'
  const recorded = row.kind === 'action' ? 'Group event' : row.recording?.state === 'recorded' ? 'Conversation recorded' : row.recording?.state === 'refused' ? 'Message not recorded' : 'Recording unconfirmed'
  if (!row.inputOperationId) return recorded + (row.state === 'refused' ? ' · ' + incomingRefusal(row.code).title : ' · no Agent submission recorded')
  if (row.coreObservation === 'unavailable') return recorded + ' · Agent submission observation unavailable'
  const status = row.coreStatus
  const input = status === 'admitted' ? 'Accepted by Agent' : status === 'waiting' ? row.waiting?.wake === 'explicit-rejoin' ? 'Input recovery needed' : 'Waiting for Agent' : status === 'stopped' ? 'Input delivery stopped' :
    status === 'not-applied' ? 'Not delivered to Agent' : status === 'terminal-confirmed' || status === 'bytes-accepted' ? 'Input sent; Agent acceptance unconfirmed' : 'Input outcome unconfirmed'
  return `${recorded} · ${input}`
}

export type ConnectorProblemKind = 'configuration-unconfirmed' | 'sync-off' | 'platform-off' | 'sharing-paused' | 'bot-off' | 'content-gap' | 'source-unconfirmed' | 'access-unconfirmed' |
  'outgoing-unconfirmed' | 'outgoing-not-applied' | 'outgoing-read-unavailable' | 'incoming-read-unavailable' | 'member-access' | 'request-refused' | 'agent-waiting' | 'agent-stopped' | 'agent-not-applied' | 'agent-unconfirmed' | 'recording-unconfirmed'
export type ConnectorProblemAction = { kind: 'members' | 'content' | 'receipts' | 'incoming'; label: string }
export type ConnectorProblem = { kind: ConnectorProblemKind; title: string; detail: string; tone: 'warning' | 'muted'; action?: ConnectorProblemAction }
export type ConnectorDirectionSummary = { direction: 'outgoing' | 'incoming'; title: string; value: string; detail: string; secondary?: string; tone: 'neutral' | 'warning' | 'muted'; problem?: ConnectorProblemKind }
export type ConnectorGroupSummary = { problems: ConnectorProblem[]; outgoing: ConnectorDirectionSummary; incoming: ConnectorDirectionSummary; retained: boolean; note: string | null }
export type ConnectorGroupAction = 'resume' | 'members' | 'sharing' | 'sync' | 'activity' | 'channel-settings'

/** Choose a destination from original facts, never from its displayed label. Execution stays with the original owner. */
export function connectorGroupAction(summary: ConnectorGroupSummary, bindingState: RoomBinding['state']): { kind: ConnectorGroupAction; label: string } {
  const has = (kind: ConnectorProblemKind) => summary.problems.some(problem => problem.kind === kind)
  if (bindingState === 'paused') return { kind: 'resume', label: 'Resume group sync' }
  if (has('member-access') || summary.problems.some(problem => problem.action?.kind === 'members')) return { kind: 'members', label: 'Manage member access' }
  if (has('platform-off') || has('bot-off')) return { kind: 'channel-settings', label: 'Open channel settings' }
  if (has('sync-off')) return { kind: 'sync', label: 'Review automatic sync' }
  return { kind: 'activity', label: 'View group details' }
}

/** Read-only presentation of the original bounded facts. Labels are never parsed back into state. */
export function connectorGroupSummary(report: GroupDiagnosis | null): ConnectorGroupSummary {
  const problems: ConnectorProblem[] = []
  const add = (kind: ConnectorProblemKind, title: string, detail: string, tone: ConnectorProblem['tone'] = 'muted', action?: ConnectorProblemAction) => {
    problems.push({ kind, title, detail, tone, ...(action ? { action } : {}) })
  }
  const sections = report ? [report.service, report.adapterService, report.connection, report.binding, report.outgoing, report.incoming] : []
  const retained = sections.some(section => section.retained)
  const unread = report ? [[report.service.issue, 'Sync policy'], [report.adapterService.issue, 'Platform policy'], [report.connection.issue, 'Bot settings'], [report.binding.issue, 'Group link']].filter(([issue]) => issue).map(([, name]) => name) : []
  if (unread.length) add('configuration-unconfirmed', `${unread.join(', ')} unread`, 'These original settings could not be read. Earlier matching facts are kept.')
  if (report?.outgoing.issue) add('outgoing-read-unavailable', 'Platform receipt check unavailable', 'Earlier original platform receipts are kept; this check did not confirm them.', 'muted', { kind: 'receipts', label: 'View delivery details' })
  if (report?.incoming.issue) add('incoming-read-unavailable', 'Agent input check unavailable', 'Earlier input observations are kept; this check did not confirm them.', 'muted', { kind: 'incoming', label: 'View input details' })
  if (report?.service.value?.enabled === false) add('sync-off', 'Automatic sync is off', 'This is the saved policy for all bots.', 'muted')
  if (report?.adapterService.value?.enabled === false) add('platform-off', 'Platform is turned off', 'Enable this platform in channel settings to resume its automatic messages.', 'muted')
  if (report?.binding.value?.state === 'paused') add('sharing-paused', 'Group sharing is paused', 'The saved group and its original requests are kept.', 'muted')
  if (report?.connection.value?.enabled === false) add('bot-off', 'Bot is disabled', 'Enable this original bot in its settings to resume its automatic work.', 'muted')
  const out = report?.outgoing.value
  const { contentGap, sourceUnconfirmed, accessUnconfirmed, counts, confirmedText } = outgoingFacts(out)
  if (accessUnconfirmed) add('access-unconfirmed', 'Member access check unavailable', 'Application permissions could not be checked. Saved decisions are kept; review member access and check again.', 'muted', { kind: 'members', label: 'Member access' })
  if (contentGap) add('content-gap',
    'Some conversation content is not shared yet', 'Some original content is not confirmed for sharing. Other messages can still be delivered.', 'muted', { kind: 'content', label: 'View content details' })
  else if (sourceUnconfirmed) add('source-unconfirmed', 'Source reading unconfirmed', 'This describes the local conversation source, not delivery to the group.')
  if (counts.unconfirmed || out?.effectObservation?.state === 'unknown') add('outgoing-unconfirmed',
    counts.unconfirmed ? `${counts.unconfirmed} delivery result${counts.unconfirmed === 1 ? '' : 's'} not confirmed` : 'Earlier delivery results not confirmed', 'The platform has not confirmed these earlier requests. Recent confirmed deliveries are unaffected.', 'muted', { kind: 'receipts', label: 'View delivery details' })
  if (counts.notApplied) add('outgoing-not-applied', `${counts.notApplied} request${counts.notApplied === 1 ? '' : 's'} not delivered`, 'The original platform receipts report not applied. Check those exact requests.', 'warning', { kind: 'receipts', label: 'View delivery details' })
  const outgoing: ConnectorDirectionSummary = { direction: 'outgoing', title: 'Conversation → group',
    value: !out ? report ? 'Could not check recent sends' : 'Not checked' : contentGap ? 'Some conversation content is not shared yet' : counts.notApplied ? `${counts.notApplied} request${counts.notApplied === 1 ? '' : 's'} not delivered` :
      counts.unconfirmed ? 'Recent send results not confirmed' : sourceUnconfirmed ? 'Source reading unconfirmed' : counts.pending ? 'Sending recent requests' : confirmedText || (out.deliveries.length ? 'Recent send results not recorded' : 'No recent requests'),
    detail: out ? `Recent receipt window${out.next ? '; more receipts available' : ''}.` : 'Check the original group to read its receipts.',
    ...(confirmedText && (contentGap || counts.notApplied || counts.unconfirmed || sourceUnconfirmed || counts.pending) ? { secondary: confirmedText } : {}),
    tone: !out || contentGap || sourceUnconfirmed ? 'muted' : counts.notApplied ? 'warning' : 'neutral',
    ...(contentGap ? { problem: 'content-gap' as const } : counts.notApplied ? { problem: 'outgoing-not-applied' as const } : counts.unconfirmed ? { problem: 'outgoing-unconfirmed' as const } : sourceUnconfirmed ? { problem: 'source-unconfirmed' as const } : {}) }
  const incoming = report?.incoming.value, row = incoming?.rows[0]
  let value = !incoming ? report ? 'Input check unavailable' : 'Not checked' : !row ? 'No events in this window' : 'Agent submission unconfirmed'
  let detail = row ? row.kind === 'action' ? row.inputOperationId ? 'Group action with an original Agent input receipt.' : 'Latest group event; no Agent input recorded.' : row.recording?.state === 'recorded' ? 'Conversation recorded.' : 'Conversation recording unconfirmed.' : incoming ? 'This bounded window does not describe all group history.' : 'Check the original group to read its input receipts.'
  let tone: ConnectorDirectionSummary['tone'] = !incoming ? 'muted' : 'neutral'
  let incomingProblem: ConnectorProblemKind | undefined
  if (report?.binding.value?.activeInputGrants === 0 && !report.binding.issue) add('member-access', 'No member has request access', 'Group recording and permission to ask the Agent are separate. Review member access explicitly.', 'warning', { kind: 'members', label: 'Member access' })
  if (row?.recording && (row.recording.state === 'unavailable' || row.recording.state === 'not-started')) add('recording-unconfirmed', 'Conversation recording unconfirmed', 'Keep the original received event and check its recording receipt.')
  if (row?.scope === 'other-binding') { value = 'Earlier connection receipt'; detail += ' It does not confirm the current group connection.'; tone = 'muted' }
  else if (row) {
    if (!row.inputOperationId) {
      const refusal = row.state === 'refused' ? incomingRefusal(row.code) : undefined
      value = refusal?.title ?? 'No Agent submission recorded'
      if (refusal) { detail = (row.scope === 'group-event' ? 'Latest group event. ' : '') + refusal.detail; incomingProblem = 'request-refused'; add('request-refused', refusal.title, detail, 'warning', refusal.action) }
      tone = row.state === 'refused' ? 'warning' : 'neutral'
    } else if (row.coreObservation === 'unavailable') { value = 'Agent receipt could not be checked'; incomingProblem = 'agent-unconfirmed'; add('agent-unconfirmed', value, 'The original input remains recorded; its current Agent receipt could not be read.') }
    else if (row.coreStatus === 'admitted') value = 'Accepted by Agent'
    else if (row.coreStatus === 'waiting') {
      const explicit = row.waiting?.wake === 'explicit-rejoin'
      value = explicit ? 'Input recovery needed' : 'Waiting for Agent'; incomingProblem = 'agent-waiting'; tone = explicit ? 'warning' : 'neutral'
      detail += explicit ? ' This saved input needs an explicit rejoin. Open its original receipt to review and recover the same input.' : ' The original input is waiting for its automatic recovery condition.'
      add('agent-waiting', value, detail, explicit ? 'warning' : 'muted', { kind: 'incoming', label: explicit ? 'Review original input' : 'View input details' })
    }
    else if (row.coreStatus === 'stopped') { value = 'Input delivery stopped'; incomingProblem = 'agent-stopped'; add('agent-stopped', value, 'The original saved input remains available.', 'muted') }
    else if (row.coreStatus === 'not-applied') { value = 'Not delivered to Agent'; tone = 'warning'; incomingProblem = 'agent-not-applied'; add('agent-not-applied', value, 'Check the original input receipt.', 'warning') }
    else { value = row.coreStatus === 'terminal-confirmed' || row.coreStatus === 'bytes-accepted' ? 'Sent to Agent · awaiting confirmation' : 'Agent acceptance not confirmed'; incomingProblem = 'agent-unconfirmed'; add('agent-unconfirmed', value, 'Input transport or recording is separate from Agent acceptance.') }
  }
  const remaining = problems.filter(problem => problem.kind !== outgoing.problem && problem.kind !== incomingProblem).map(problem => problem.title).join(' · ')
  const note = [remaining, retained ? 'Earlier observations are kept; the latest check is incomplete.' : null].filter(Boolean).join(' ') || null
  return { problems, outgoing, incoming: { direction: 'incoming', title: 'Group → Agent', value, detail, tone, ...(incomingProblem ? { problem: incomingProblem } : {}) }, retained, note }
}

function outgoingFacts(out: GroupDiagnosis['outgoing']['value'] | undefined) {
  const gapCount = out?.coverage ? out.coverage.gaps.length + out.coverage.omittedGapCount : 0
  const contentGap = gapCount > 0 || out?.coverage?.state === 'incomplete' || out?.observation?.reason === 'content-unconfirmed'
  const accessUnconfirmed = out?.observation?.reason === 'access-unconfirmed'
  const sourceUnconfirmed = !!out && (out.sourceObservation?.state !== 'ready' || out.observation?.state === 'unavailable' && out.observation.reason !== 'effect-unconfirmed' && !accessUnconfirmed)
  const counts = { confirmed: 0, unconfirmed: 0, pending: 0, notApplied: 0 }
  const confirmed = { conversation: 0, permission: 0, 'binding-notice': 0, 'query-feedback': 0 }
  for (const delivery of out?.deliveries ?? []) {
    if (delivery.receipt === 'confirmed') { counts.confirmed++; confirmed[delivery.kind]++ }
    else if (delivery.receipt === 'unknown' || delivery.state === 'unknown') counts.unconfirmed++
    else if (delivery.receipt === 'not-applied' || delivery.state === 'not-applied') counts.notApplied++
    else if (delivery.state === 'pending' || delivery.state === 'dispatching') counts.pending++
  }
  const effects = [[counts.confirmed, 'confirmed'], [counts.unconfirmed, 'unconfirmed'], [counts.pending, 'pending'], [counts.notApplied, 'not applied']]
    .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(' · ')
  const confirmedText = [[confirmed.conversation, 'conversation update', 'delivered'], [confirmed.permission, 'permission request', 'delivered'], [confirmed['binding-notice'], 'connection notice', 'delivered'], [confirmed['query-feedback'], 'message status update', 'confirmed']]
    .filter(([count]) => count).map(([count, label, result]) => `${count} ${label}${count === 1 ? '' : 's'} ${result}`).join(' · ')
  return { gapCount, contentGap, sourceUnconfirmed, accessUnconfirmed, counts, effects, confirmedText }
}
