// Compose the original complete App fixture; specialize only finite public resource facts.
import '../mote-cooperation/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import type { ScratchTopic } from '../../../src/shared/scratch-topics'
const workspace = useAppStore.getState().config!.workspaces.find(item => item.id === '__scratch__')!
const qualify = (topic: ScratchTopic) => ({ ...topic,
  physicalDirectoryPath: workspace.path + '/' + scratchTopicDirectoryName(topic.id),
  confirmedDirectoryPaths: [workspace.path + '/' + scratchTopicDirectoryName(topic.id)] })
const list = api.scratch.listTopics, readTopic = api.scratch.readTopic
api.scratch.listTopics = async (...args) => (await list(...args)).map(qualify)
api.scratch.readTopic = async (...args) => { const topic = await readTopic(...args); return topic ? qualify(topic) : null }
function refreshScope() {
  useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([id, snapshot]) => [id,
    snapshot.topics ? { ...snapshot, topics: snapshot.topics.map(qualify) } : snapshot])) }))
}
refreshScope()
const readFile = api.files.readPublic
api.files.readPublic = async params => {
  const prior = await readFile(params)
  const logical = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
  const resourcePath = (prior.resource?.zonePath.slice(workspace.path.length + 1) ?? logical) + '/' + params.path
  const content = params.path === 'BEHAVIOR.md' ? '---\nversion: 1\npreferences:\n  engagement: I\n  information: S\n  decisions: T\n  approach: J\n---\n'
    : params.path === 'SOUL.md' ? '# SOUL\n\nKeep the original direction and finish useful work.\n'
    : params.path === 'MEMORY.md' ? '# Memory\n\nOriginal decisions stay close to their sources.\n'
    : prior.result.status === 'read' ? prior.result.document.content : null
  return { ...prior, resource: prior.resource ? { ...prior.resource, path: resourcePath } : null,
    result: content === null ? prior.result : { status: 'read' as const, document: { path: resourcePath, revision: 'sha256:' + 'b'.repeat(64), content } } }
}
api.goals.execute = async request => {
  if (request.operation === 'demand.list') return { operation: 'demand.list', demands: [] }
  throw new Error('This private frame fixture allows only original Goal reads')
}
api.schedule.list = async () => ({ schedules: [], executionScope: 'connected-host' })
const capture = (window as unknown as { moteCooperationCapture: { longNames(): void; restore(): void; reopen(): void; facts(): Record<string, unknown> } }).moteCooperationCapture
const longNames = capture.longNames, restore = capture.restore
capture.longNames = () => { longNames(); refreshScope() }
capture.restore = () => { restore(); refreshScope() }

if (new URLSearchParams(location.search).has('conversation')) {
  // This fixture supplies finite original source facts; the complete App, its
  // Reader, original input records, Info and Composer remain the consumers.
  await import('../mote-discussion-threads/entry')
  const { projectConversationReading, parseConversationReadPage, conversationRevision } = await import('@agentmux/core/conversation')
  const { requestPmoTeamsTopicFloatingClose, requestPmoTeamsTopicFloatingOpen } = await import('../../../src/renderer/src/lib/pmo-teams-topic-floating')
  const { directoryIdentity } = await import('../../../src/shared/space-addresses')
  const sourceHostId = 'host-original', at = Date.now() - 8 * 60_000
  const customId = 'launcher:reviewer', customName = '长期合作伙伴：产品体验与可靠实现'
  const customTopic = useAppStore.getState().scratchTopicSnapshots[workspace.id]!.topics!.find(topic => topic.id === customId)!
  const customReference = { hostId: 'local', sessionId: 'custom-mote', displayWorkspaceId: workspace.id, groupId: 'original-mote-group', tabId: 'custom-mote-tab', regionId: 'custom-mote-region' }
  let customLongName = false
  const withName = (topic: ScratchTopic) => customLongName && topic.id === customId ? { ...topic, title: customName } : topic
  const listTopics = api.scratch.listTopics, readOneTopic = api.scratch.readTopic
  api.scratch.listTopics = async (...args) => (await listTopics(...args)).map(withName)
  api.scratch.readTopic = async (...args) => { const topic = await readOneTopic(...args); return topic ? withName(topic) : null }
  const events = capture.facts().trustedEvents as Array<{ type: string; trusted: boolean; label: string | null }>
  for (const type of ['pointerdown', 'pointerup']) document.addEventListener(type, event => events.push({ type, trusted: event.isTrusted,
    label: event.target instanceof Element ? event.target.getAttribute('aria-label') : null }), true)
  const sourceFor = (id: string) => ({ providerId: 'codex', nativeSessionId: 'original-native-' + id })
  const sourceReads: unknown[] = [], observers = new Set<{ input: { hostId: string; agentSessionId: string }; listener: (event: unknown) => void }>()
  let unavailable = false, delayed = new URLSearchParams(location.search).has('initialDelay')
  const delayedReads: (() => void)[] = []
  const device = { hostId: 'original-device-host', deviceId: 'original-device', name: '本机 Mac' }
  const submitted = (id: string, text: string, status: 'admitted' | 'terminal-confirmed', createdAt: number, joined = false) => ({
    id, agentSessionId: 'mote-primary', kind: 'user_message' as const, source: 'user' as const, title: 'Original human input',
    status: 'complete' as const, createdAt, updatedAt: createdAt, content: text, authorHuman: true, publicContent: 'confirmed' as const,
    inputRef: { kind: 'prompt' as const, agentSessionId: 'mote-primary', expectedRun: { runId: 'original-run-mote-primary' }, submissionId: id },
    inputOrigin: { queueId: 'original-input-queue', incarnation: 'original-input-incarnation', sequence: (createdAt - at) / 2000 },
    inputSubmission: { status, observation: 'closed' as const }, sourceChannel: 'message-tool' as const, sourceDevice: device,
    ...(joined ? { conversation: { sameEvent: { hostId: sourceHostId, agentSessionId: 'mote-primary', source: { kind: 'native' as const, ...sourceFor('mote-primary'), recordId: 'native-human' } } } } : {})
  })
  const question = '把头像留在这里，日常先读消息；需要核对来源的时候，再打开详情。'
  const submissions = [submitted('original-native-submission', question, 'admitted', at + 2000, true),
    submitted('original-captured-submission', 'Info 里的设备、来源和原记录要保留，我偶尔需要查。', 'admitted', at + 4000),
    submitted('original-unconfirmed-submission', '未确认的输入留个简短提示，继续保留原消息。', 'terminal-confirmed', at + 6000)]
  function page(input: Parameters<typeof api.conversation.readAgentConversation>[0]) {
    sourceReads.push({ operation: 'conversation.read', input })
    if (unavailable && input.agentSessionId === 'mote-primary') throw new Error('原生消息来源暂不可读；已读正文、原会话与草稿保留。')
    const main = input.agentSessionId === 'mote-primary' || input.agentSessionId === 'custom-mote', source = sourceFor(input.agentSessionId)
    const nativeItems = main ? [
      { id: 'original-platform-context', kind: 'system-message' as const, title: 'AgentMux context', startedAt: at,
        contentParts: [{ kind: 'text' as const, text: '<environment_context>\nThis is the complete original runtime context. The exact Host, Session and Run keep their own authority.\nRead the original module guide before operating a capability.\n</environment_context>' }] },
      { id: 'original-native-human', kind: 'user-message' as const, startedAt: at + 2000,
        contentParts: [{ kind: 'text' as const, text: question }] },
      { id: 'original-native-reply', kind: 'assistant-message' as const, startedAt: at + 3000,
        contentParts: [{ kind: 'text' as const, text: '我会一直在这里。\n\n头像和名字留在导航里，消息成为阅读的主体。正常的来源与回执放进 Info，送达待核实则保留一句准确提示。\n\n历史、草稿和原工作面都沿原位置继续。' }] },
    ] : [
      { id: 'earlier-native-human', kind: 'user-message' as const, startedAt: at - 60_000,
        contentParts: [{ kind: 'text' as const, text: '之前的设计方向也要保留，后续继续从原记录核对。' }] },
      { id: 'earlier-native-reply', kind: 'assistant-message' as const, startedAt: at - 50_000,
        contentParts: [{ kind: 'text' as const, text: '原记录留在这段历史里。此处只读取原会话，不新建、不重发。' }] }
    ]
    // The explicit same-event ref joins the accepted input to this native item.
    if (main) nativeItems[1]!.id = 'native-human'
    const timelineItems = input.agentSessionId === 'mote-primary' ? submissions : []
    const projected = projectConversationReading({ agentSessionId: input.agentSessionId, routeHostId: input.hostId, executionHostId: sourceHostId,
      historyPage: { agentSessionId: input.agentSessionId, sourceHostId, source, nextCursor: null, items: nativeItems },
      timeline: { agentSessionId: input.agentSessionId, sourceHostId, revision: 1, items: timelineItems,
        stream: { epoch: 'original-conversation-presence', sequence: timelineItems.length, revision: 1, origin: 'beginning', gaps: [],
          positions: timelineItems.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) } } }).timeline
    const ref = { hostId: input.hostId, agentSessionId: input.agentSessionId }
    const checkpoint = { ...ref, sourceHostId, frontier: { ...ref, hostId: sourceHostId, scope: projected.scope, cuts: [] } }
    const items = [...projected.events].reverse().map(event => ({ kind: 'item', item: { event, records: projected.records.filter(record => event.recordIds.includes(record.id)) } }))
    return parseConversationReadPage({ ...ref, ...(input.processDetails ? { processDetails: input.processDetails } : {}), sourceHostId,
      scope: projected.scope, coverage: projected.coverage, order: { ...projected.order, direction: 'newest-first' }, items, nextCursor: null,
      budgetBytes: input.maxBytes ?? 64 * 1024, window: { id: 'original-presence-window-' + input.agentSessionId, revision: 1, itemCount: items.length, complete: true,
        view: input.view ?? 'original-presence-view-' + input.agentSessionId, replay: 'original-presence-replay', checkpoint,
        outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }, input)
  }
  api.conversation.readAgentConversation = async input => {
    if (delayed && input.agentSessionId === 'mote-primary') await new Promise<void>(resolve => delayedReads.push(resolve))
    return page(input)
  }
  api.conversation.readConversationChanges = async input => { const result = page(input); return { ...result, checkpoint: result.window.checkpoint, more: false } }
  api.conversation.observeConversation = async (input, listener) => {
    const current = page(input), controller = new AbortController(), watch = { input, listener: listener as (event: unknown) => void }
    observers.add(watch)
    return { hostId: input.hostId, sourceHostId, agentSessionId: input.agentSessionId, scope: current.scope, coverage: current.coverage,
      closed: controller.signal, dispose() { observers.delete(watch); controller.abort() } }
  }
  const dialogueRead = api.moteDialogue.read
  api.moteDialogue.read = async input => {
    if (input.target.spaceId === directoryIdentity(workspace.hostId, customTopic.directoryPath)) return {
      main: { target: input.target, identity: { hostId: workspace.hostId, moteId: customId }, status: 'ready', resource: null,
        documentRevision: 'sha256:' + 'd'.repeat(64), roleRevision: 'original-custom-role', current: customReference, issue: null },
      links: [], incarnation: 'original-custom-associations', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
    const result = await dialogueRead(input), current = result.main.current
    if (!current || input.kind === 'work') return result
    const topic = useAppStore.getState().scratchTopicSnapshots[workspace.id]!.topics!.find(topic => topic.id === PMO_TEAMS_TOPIC_ID)!
    const earlier = { kind: 'main' as const, sequence: 2, identity: result.main.identity!, operationId: 'original-earlier-role', associatedAt: at - 60_000,
      roleRevision: 'original-earlier-role', reference: { ...current, sessionId: 'mote-neighbor', tabId: 'mote-neighbor-tab', regionId: 'mote-neighbor-region' },
      range: 'whole-session' as const, file: { resource: { ...result.main.target.expectedResource, zoneId: result.main.target.zoneId, zonePath: topic.directoryPath, path: 'MOTE.md' }, revision: 'sha256:' + 'c'.repeat(64) } }
    return { ...result, links: [earlier, ...result.links], throughSequence: 2 }
  }
  const preferencesRead = api.motePreferences.read
  api.motePreferences.read = async input => {
    if (input.target.spaceId !== directoryIdentity(workspace.hostId, customTopic.directoryPath)) return preferencesRead(input)
    const { serializeMoteQuickMode } = await import('../../../src/shared/mote-quick-mode')
    return { target: input.target, kind: 'quick', status: 'ready', source: { resource: { ...input.target.expectedResource, zoneId: input.target.zoneId,
      zonePath: customTopic.directoryPath, path: scratchTopicDirectoryName(customId) + '/MOTE.md' }, result: { status: 'read', document: {
      path: scratchTopicDirectoryName(customId) + '/MOTE.md', content: serializeMoteQuickMode('', { conversation: customReference }), revision: 'sha256:' + 'd'.repeat(64) } } },
      defaults: { conversation: customReference }, choices: { executors: [], conversations: [], destinations: [] }, main: false,
      maintenance: { status: 'unbound', schedule: null, issue: null }, issue: null } as Awaited<ReturnType<typeof api.motePreferences.read>>
  }
  const discussion = (window as unknown as { moteDiscussionCapture: { facts(): unknown } }).moteDiscussionCapture
  Object.assign(window, { moteConversationCapture: { ready: true, facts: () => ({ ...capture.facts(), sourceReads, observerCount: observers.size, delayed, unavailable, discussion: discussion.facts() }),
    reopen() { requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID }) },
    longName() {
      customLongName = true
      useAppStore.setState(state => ({ scratchTopicSnapshots: Object.fromEntries(Object.entries(state.scratchTopicSnapshots).map(([key, snapshot]) => [key,
        snapshot.topics ? { ...snapshot, topics: snapshot.topics.map(withName) } : snapshot])) }))
      requestPmoTeamsTopicFloatingOpen({ targetTopicId: customId })
    },
    release() { delayed = false; for (const release of delayedReads.splice(0)) release() },
    fail() {
      unavailable = true
      useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'mote-primary'
        ? { ...session, processState: 'exited' as const, status: { state: 'exited' as const, source: 'run-process' as const, observedAt: Date.now(), exitReason: 'crashed' as const, detail: 'The process exited on its own. Exit code 1.' } } : session) }))
      for (const watch of observers) if (watch.input.agentSessionId === 'mote-primary') watch.listener({ ...watch.input, sourceHostId,
        source: { kind: 'native', ...sourceFor('mote-primary') }, kind: 'unavailable', code: 'ORIGINAL_NATIVE_SOURCE_UNAVAILABLE', message: '原生消息来源暂不可读；已读正文、原会话与草稿保留。' })
    }
  } })
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID })
}
