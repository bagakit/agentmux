import type { AgentMuxEvidenceSource } from '@agentmux/core'
import { conversationInvocationId, conversationRecordId, type ConversationContentRef, type ConversationEvent, type ConversationSelector, type ConversationSourceRecord, type ConversationTimeline } from '@agentmux/core/conversation'

export const NATIVE_CONVERSATION_SOURCE = '原生对话'
export const COLLECTED_REPLY_TITLE = '回复快照'
const capturedSources = {
  'native-hook': { label: 'CLI 事件回报', description: 'CLI 通过事件回调或通知上报的内容；具体回调及安装方式须查原始回执。' },
  'native-transcript': { label: '原生记录观察', description: '从原生记录采集的观察内容。' },
  'terminal-output': { label: '终端输出观察', description: '从终端输出采集的观察内容。' },
  'run-process': { label: '进程观察', description: '原运行进程的观察记录。' },
  acp: { label: 'ACP', description: '通过 ACP 协议取得的记录。' },
  user: { label: 'AgentMux 提交记录', description: 'AgentMux 保留的原输入提交事实；不单独证明原生采用。' },
  agentmux: { label: 'AgentMux', description: 'AgentMux 自身记录的系统事实。' }
} satisfies Record<AgentMuxEvidenceSource, { label: string; description: string }>

/** Display definitions only; never evidence of author, adoption or Hook installation. */
export function describeCapturedConversationSource(source: AgentMuxEvidenceSource) {
  return capturedSources[source]
}
export type ConversationSourceDisplay = { labels: readonly { id: string; label: string; title: string }[]; unread?: boolean }
export type ConversationSources = { main: ConversationSourceDisplay; parts: readonly ConversationSourceDisplay[]; fields: Partial<Record<'content' | 'toolInput' | 'toolOutput', ConversationSourceDisplay>>; collectedReply?: string; submissions?: readonly ConversationSourceRecord[] }
type Slot = ConversationEvent['content'][number]
const selectorKey = (selector: ConversationSelector) => selector.kind === 'native-part' ? ['native-part', selector.partIndex] : ['captured-field', selector.field]
const contentKey = (ref: ConversationContentRef) => JSON.stringify([conversationRecordId(ref.record), ref.recordRevision, selectorKey(ref.selector)])
function display(records: readonly ConversationSourceRecord[], unread = false): ConversationSourceDisplay {
  const labels = new Map<string, { id: string; label: string; details: string[] }>()
  for (const record of records) {
    const id = record.original.kind === 'native' ? 'native' : record.original.item.source
    const source = record.original.kind === 'native'
      ? { label: NATIVE_CONVERSATION_SOURCE, description: '从 Provider 原生会话记录读取的消息或过程。' }
      : describeCapturedConversationSource(record.original.item.source)
    const label = source.label
    const eventName = record.original.kind === 'captured' ? record.original.item.eventName : undefined
    const old = labels.get(id), detail = [source.description, ...(eventName ? [`原事件：${eventName}`] : []), record.id, `Revision: ${record.revision}`].join('\n')
    if (old) old.details.push(detail)
    else labels.set(id, { id, label, details: [detail] })
  }
  return { labels: [...labels.values()].map(({ id, label, details }) => ({ id, label, title: details.join('\n') })), ...(unread ? { unread: true } : {}) }
}

/** Disposable display lookup over accepted Core relations. It never changes event membership or reads a source. */
export function conversationSourcePresenter(timeline: ConversationTimeline) {
  const inventory = new Map(timeline.records.map(record => [record.id, record]))
  const invocationParts = new Map<string, Map<string, ConversationContentRef>>()
  const targetRelations = new Map<string, Set<string>>()
  const gapCodes = new Map<string, Set<string>>()
  for (const row of timeline.coverage) for (const gap of row.gaps) if (gap.record) {
    const id = conversationRecordId(gap.record), codes = gapCodes.get(id) ?? new Set<string>()
    codes.add(gap.code); gapCodes.set(id, codes)
  }
  for (const relation of new Set(timeline.events.flatMap(event => event.relations))) {
    if (relation.kind === 'same-event' || relation.kind === 'observes') {
      const target = relation.kind === 'same-event' ? relation.to : relation.target
      if ('kind' in target.source) {
        const from = conversationRecordId(relation.from), to = conversationRecordId({ ...target, source: target.source })
        const targets = targetRelations.get(from) ?? new Set<string>()
        targets.add(to); targetRelations.set(from, targets)
      }
    }
    if (relation.kind !== 'invocation-member') continue
    const key = conversationInvocationId(relation.invocation), group = invocationParts.get(key) ?? new Map<string, ConversationContentRef>()
    group.set(contentKey(relation.part), relation.part)
    invocationParts.set(key, group)
  }
  const related = new Map<string, ConversationSourceDisplay[]>()
  for (const group of invocationParts.values()) {
    const known = new Map<string, ConversationSourceRecord>(); let unread = false
    for (const ref of group.values()) {
      const id = conversationRecordId(ref.record), record = inventory.get(id)
      if (record?.revision === ref.recordRevision) known.set(id, record)
      else unread = true
    }
    const sources = display([...known.values()], unread)
    for (const key of group.keys()) { const values = related.get(key) ?? []; values.push(sources); related.set(key, values) }
  }
  const byContent = new Map([...related].map(([key, groups]) => {
    const labels = new Map<string, { id: string; label: string; titles: Set<string> }>()
    for (const group of groups) for (const source of group.labels) {
      const value = labels.get(source.id) ?? { id: source.id, label: source.label, titles: new Set<string>() }
      value.titles.add(source.title); labels.set(source.id, value)
    }
    return [key, { labels: [...labels.values()].map(({ id, label, titles }) => ({ id, label, title: [...titles].join('\n') })),
      ...(groups.some(group => group.unread) ? { unread: true } : {}) }] as const
  }))
  function slotDisplay(slot: Slot): ConversationSourceDisplay {
    const owner = inventory.get(slot.recordId)
    if (!owner || owner.revision !== slot.recordRevision) return display([], true)
    if (!owner.reference) return display([owner])
    return byContent.get(contentKey({ record: owner.reference, recordRevision: owner.revision, selector: slot.selector })) ?? display([owner])
  }
  return (record: { records?: readonly ConversationSourceRecord[]; event?: ConversationEvent; role?: ConversationEvent['role'] }): ConversationSources => {
    const originals = record.records ?? [], primary = originals.find(item => item.id === record.event?.anchorId) ?? originals[0]
    const slots: readonly Slot[] = record.event ? record.event.content.filter(slot => slot.placement === 'body') : primary
      ? primary.original.kind === 'native' ? primary.original.item.contentParts.map((_, partIndex) => ({ recordId: primary.id, recordRevision: primary.revision, selector: { kind: 'native-part' as const, partIndex }, placement: 'body' as const }))
        : (['content', 'toolInput', 'toolOutput'] as const).filter(field => primary.original.kind === 'captured' && primary.original.item[field] !== undefined).map(field => ({ recordId: primary.id, recordRevision: primary.revision, selector: { kind: 'captured-field' as const, field }, placement: 'body' as const })) : []
    const fields: ConversationSources['fields'] = {}
    if (primary?.original.kind === 'captured') for (const field of ['content', 'toolInput', 'toolOutput'] as const) if (primary.original.item[field] !== undefined)
      fields[field] = slotDisplay({ recordId: primary.id, recordRevision: primary.revision, selector: { kind: 'captured-field', field }, placement: 'body' })
    const main = display(originals)
    // Membership is already decided by Core. Only expose original submission facts
    // beside a readable native canonical body; never search another event for a match.
    const submissions = primary?.original.kind === 'native' && record.event
      ? originals.filter(source => source.original.kind === 'captured' && source.original.item.kind === 'user_message' && source.original.item.source === 'user') : []
    const unreadTarget = originals.some(original => [...(targetRelations.get(original.id) ?? [])].some(target => {
      const codes = gapCodes.get(target)
      return codes?.has('CONVERSATION_ANCHOR_UNREAD') || codes?.has('CONVERSATION_OBSERVED_TARGET_UNREAD')
    }))
    const relationConflict = originals.some(original => gapCodes.get(original.id)?.has('CONVERSATION_RELATION_CYCLE'))
    const collectedReply = record.role === 'observation' ? `事件回报附带的回复文本快照；不单独代表一次新发言。${unreadTarget ? '对应的原始记录尚未读到。' : relationConflict ? '记录的对应关系存在冲突。' : ''}` : undefined
    return { main, parts: slots.map(slotDisplay), fields,
      ...(collectedReply ? { collectedReply } : {}),
      ...(submissions.length ? { submissions } : {}) }
  }
}
