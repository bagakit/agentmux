import '../mote-discussion-threads/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { serializeMoteQuickMode } from '../../../src/shared/mote-quick-mode'
import type { MoteDialoguePage, MoteDialogueLink, MoteMainPeriod, MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'

const original = (window as any).moteDiscussionCapture, state = useAppStore.getState()
const captureAt = original.captureAt as number
const workspace = state.config!.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)!
const topic = state.scratchTopicSnapshots[workspace.id]!.topics!.find(item => item.id === PMO_TEAMS_TOPIC_ID)!
const spaceId = directoryIdentity(workspace.hostId, topic.directoryPath), zoneId = homeZoneId(spaceId)
const target = { spaceId, zoneId, expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
const reference = { hostId: 'local', sessionId: 'mote-primary', displayWorkspaceId: workspace.id, groupId: 'original-mote-group', tabId: 'mote-primary-tab', regionId: 'mote-primary-region' }
const identity = { hostId: workspace.hostId, moteId: topic.id }, revision = 'sha256:' + 'a'.repeat(64)
const resource = { ...target.expectedResource, zoneId, zonePath: topic.directoryPath, path: scratchTopicDirectoryName(topic.id) + '/MOTE.md' }
const executorId = Object.keys(state.config!.executors)[0]!
const native = await api.conversation.readAgentConversation({ hostId: reference.hostId, agentSessionId: reference.sessionId })
let unknown = false, history = true, bound = false, observations = 0
const decision: MoteMainRolloverDecision = { target, reference, expectedRoleRevision: 'old-role', policyRevision: revision,
  policy: { kind: 'idle', idleMs: 45 * 60000 }, activity: { inputKey: { kind: 'prompt', agentSessionId: reference.sessionId,
    expectedRun: { runId: 'original-mote-primary-run' }, submissionId: 'prior-human-query' }, run: { runId: 'original-mote-primary-run' }, sourceId: 'private-native-idle', sequence: 1, idleSince: captureAt - 3_600_000 },
  evaluatedAt: captureAt, queryOperationId: 'private-new-query', creationOperationId: 'private-new-main' }
const period = (id: string, from: number, through: number, automatic: boolean): MoteMainPeriod => ({ id, roleRevision: id, reference,
  startedAt: from, endedAt: through, start: { kind: 'initial', operationId: id + '-start' },
  end: automatic ? { kind: 'automatic', operationId: id + '-end', decision } : { kind: 'manual-takeover', operationId: id + '-end' },
  range: { kind: 'bounded', after: native.window.checkpoint, through: native.window.checkpoint } })
const periods: MoteMainPeriod[] = [period('period-older', captureAt - 111_600_000, captureAt - 87_600_000, true), period('period-recent', captureAt - 25_200_000, captureAt, false),
  { ...period('period-legacy', 0, 0, false), startedAt: null, endedAt: null, start: null, end: null,
    range: { kind: 'unconfirmed', issue: '早期记录没有保存消息边界，原对话仍可打开。' } }]
const bounded = (window as any).moteBoundedVisualSource
const changes = api.conversation.readConversationChanges
if (bounded) api.conversation.readConversationChanges = async input => {
  if (input.hostId !== bounded.link.reference.hostId || input.agentSessionId !== bounded.link.reference.sessionId) return changes(input)
  const index = bounded.calls.findIndex((call: any) => (call.cursor ?? null) === (input.cursor ?? null) && JSON.stringify(call.checkpoint) === JSON.stringify(input.checkpoint) && JSON.stringify(call.through) === JSON.stringify(input.through))
  if (index < 0) throw new Error('The requested original recorded period frame is unavailable. No latest Session fallback.')
  return bounded.frames[index]
}
const links = (): MoteDialogueLink[] => !history ? [] : periods.map((value, index) => ({ kind: 'main', sequence: index + 1, identity,
  operationId: value.id + '-source', associatedAt: captureAt, roleRevision: value.roleRevision, reference, range: 'whole-session', period: value,
  file: { resource, revision } } as MoteDialogueLink)).map(source => bounded && source.kind === 'main' && source.period?.id === 'period-recent'
    ? { ...source, roleRevision: bounded.link.roleRevision, reference: bounded.link.reference, period: bounded.link.period } : source).reverse()
const defaults = () => ({ executorId, conversationRollover: { kind: 'idle' as const, idleMs: 45 * 60000 }, ...(bound ? { conversation: reference, conversationRevision: 'original-main-role' } : {}) })
api.moteDialogue.read = async input => {
  if (unknown) throw new Error('主对话的原来源暂未确认，已有工作和输入保留。')
  const page: MoteDialoguePage = { main: { target, identity, status: 'ready', resource, documentRevision: revision,
    roleRevision: bound ? 'original-main-role' : null, current: bound ? reference : null, issue: null }, links: links(), incarnation: 'private-main-periods',
    throughSequence: links().length, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
  return input.kind === 'work' ? { ...page, links: [] } : page
}
api.motePreferences.read = async input => ({ target: input.target, kind: 'quick', status: 'ready',
  source: { resource, result: { status: 'read', document: { path: resource.path, content: serializeMoteQuickMode('', defaults()), revision } } },
  defaults: defaults(), choices: { executors: [{ id: executorId, name: '日常搭档', providerId: 'codex' }], conversations: [], destinations: [] },
  main: true, maintenance: { status: 'unbound', schedule: null, issue: null }, issue: null }) as any
function seed() {
  observations++
  useAppStore.setState(current => ({ scratchTopicSnapshots: { ...current.scratchTopicSnapshots,
    [workspace.id]: { ...current.scratchTopicSnapshots[workspace.id]!, revision: current.scratchTopicSnapshots[workspace.id]!.revision + 1,
      topics: current.scratchTopicSnapshots[workspace.id]!.topics!.map(item => item.id === topic.id ? { ...item, title: 'Mote', quickMode: { status: 'saved', version: 'private-observation-' + observations, defaults: defaults() } } : item) } } }))
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); requestPmoTeamsTopicFloatingOpen({ targetTopicId: topic.id })
}
seed()
Object.assign(window, { moteStartCapture: { ready: true, facts: original.facts, theme: original.theme,
  history(value: boolean) { history = value; unknown = false; bound = false; seed() },
  unknown() { unknown = true; seed() }, bound() { bound = true; unknown = false; seed() },
  longName() { original.longNames() } } })
