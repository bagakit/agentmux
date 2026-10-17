import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { flushSync } from 'react-dom'
import '../agent-region-actions/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { formatRegionAddress } from '../../../src/renderer/src/lib/agent-address'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { AgentSessionHistoryPage, AgentTimelineItem, ContinuousProgressLoop, DurableAgentMuxMessage, AgentMuxMessageMetadata } from '@agentmux/core'
import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'

const workspaceId = useAppStore.getState().activeWorkspaceId!
const tabId = 'region-actions-tab', leftId = 'region-actions-target', rightId = 'region-actions-survivor'
const names = ['Layout coordinator · investigate recovery without losing this original Agent', 'Notes researcher', 'Build reviewer']
const original = (window as any).regionActions
const first = useAppStore.getState().sessions[0]!
// Exact native read ports only; the real SessionMailbox owns windows, selection and reading.
let layoutJournal: DurableAgentMuxMessage[] | null = null
let layoutInputs: AgentInputMailboxItem[] = []
const layoutCalls: { action: string; reference: unknown; query?: unknown; messageId?: string }[] = []
const layoutListeners = new Set<Parameters<typeof api.sessions.onEvent>[0]>()
const listMessages = api.sessions.listMessages, readMessage = api.sessions.readMessage, inputMailbox = api.sessions.inputMailbox
const onSessionEvent = api.sessions.onEvent, dispatches = api.sessions.dispatches, dispatch = api.sessions.dispatch
api.sessions.onEvent = listener => {
  layoutListeners.add(listener)
  const release = onSessionEvent(listener)
  if (layoutJournal) queueMicrotask(() => { if (layoutListeners.has(listener)) listener({ type: 'core', hostId: first.hostId,
    event: { type: 'agent-message-observation', state: 'available' } }) })
  return () => { layoutListeners.delete(listener); release() }
}
api.sessions.listMessages = async (reference, query) => {
  if (!layoutJournal) return listMessages(reference, query)
  layoutCalls.push({ action: 'list', reference: { ...reference }, query: { ...query } })
  const matching = layoutJournal.filter(item => reference.hostId === first.hostId &&
    (query.direction === 'incoming' ? item.envelope.recipientSessionId : item.envelope.senderSessionId) === reference.agentSessionId &&
    (query.beforeSequence === undefined || item.sequence < query.beforeSequence)).sort((a, b) => b.sequence - a.sequence)
  const selected = matching.slice(0, query.limit ?? 25)
  return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, direction: query.direction,
    messages: selected.map(record => {
      const { body, ...envelope } = record.envelope
      return { sequence: record.sequence, envelope, delivery: record.delivery, deliveryMode: record.deliveryMode,
        notification: record.notification, bodyPreview: body.slice(0, 240), bodyBytes: new TextEncoder().encode(body).byteLength } as AgentMuxMessageMetadata
    }), nextBeforeSequence: matching.length > selected.length ? selected.at(-1)!.sequence : null }
}
api.sessions.readMessage = async (reference, messageId) => {
  if (!layoutJournal) return readMessage(reference, messageId)
  layoutCalls.push({ action: 'read', reference: { ...reference }, messageId })
  return { hostId: reference.hostId, message: layoutJournal.find(record => reference.hostId === first.hostId &&
    record.envelope.messageId === messageId && [record.envelope.senderSessionId, record.envelope.recipientSessionId].includes(reference.agentSessionId)) ?? null }
}
api.sessions.inputMailbox = async (reference, query) => {
  if (!layoutJournal) return inputMailbox(reference, query)
  layoutCalls.push({ action: 'input', reference: { ...reference }, query: { ...query } })
  return { agentSessionId: reference.agentSessionId, queueId: 'private-layout-input-journal', cut: { incarnation: 'private-layout-cut', throughSequence: 2 },
    budgetBytes: 128 * 1024, items: reference.hostId === first.hostId && reference.agentSessionId === first.id ? layoutInputs.map(item => ({ kind: 'item' as const, item })) : [],
    nextCursor: null, coverage: { kind: 'recorded-inputs' as const, unrecorded: 'unconfirmed' as const } }
}
const layoutDispatch = () => ({ sourceMessageId: layoutJournal!.at(-1)!.envelope.messageId, ownerAgentSessionId: first.id,
  workerAgentSessionId: layoutJournal!.at(-1)!.envelope.recipientSessionId!, threadId: 'private-layout-dispatch-thread',
  openedAt: layoutJournal!.at(-1)!.envelope.createdAt, originAwaits: true, events: [] })
api.sessions.dispatches = async (reference, query) => {
  if (!layoutJournal) return dispatches(reference, query)
  layoutCalls.push({ action: 'dispatch-list', reference: { ...reference }, query: { ...query } })
  return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, dispatches: [layoutDispatch()], nextSourceMessageId: null }
}
api.sessions.dispatch = async (reference, sourceMessageId) => {
  if (!layoutJournal) return dispatch(reference, sourceMessageId)
  layoutCalls.push({ action: 'dispatch-read', reference: { ...reference }, messageId: sourceMessageId })
  return { hostId: reference.hostId, dispatch: layoutDispatch(), source: layoutJournal.at(-1)!, replies: [], identityDiagnostics: [] }
}
mountThemeRuntime(window, useAppStore.getState().config?.appearance ?? {})
// Controlled API facts for the real UI: no timer, delivery or second loop manager.
let progressLoops: ContinuousProgressLoop[] = []
const progressListeners = new Set<(loop: ContinuousProgressLoop) => void>()
const progressReads: unknown[] = []
api.continuousProgress.list = async target => {
  progressReads.push(target)
  return progressLoops.filter(loop => loop.hostId === target.hostId && loop.agentSessionId === target.agentSessionId &&
    loop.providerId === target.providerId && loop.workspacePath === target.workspacePath)
}
api.continuousProgress.onChanged = listener => {
  progressListeners.add(listener)
  return () => { progressListeners.delete(listener) }
}
const third = (await api.sessions.launchAgent({ executorId: first.executorId!, hostId: 'local', workspacePath: first.workspacePath })).session
const clipboard: string[] = [], resizes: unknown[] = [], selections: unknown[] = []
const waitCancelCalls: { sessionId: string; operationId: string; result: boolean }[] = []
const cancelPreparation = useAppStore.getState().cancelAgentSteerPreparation
useAppStore.setState({ cancelAgentSteerPreparation(sessionId, operationId) {
  const result = cancelPreparation(sessionId, operationId)
  waitCancelCalls.push({ sessionId, operationId, result })
  return result
} })
const mailboxInputs: unknown[] = []
for (const type of ['pointerenter', 'pointerdown', 'click', 'keydown', 'input', 'compositionstart', 'compositionend'])
  document.addEventListener(type, event => {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.composer')) mailboxInputs.push({ type, trusted: event.isTrusted,
      pointerType: event instanceof PointerEvent ? event.pointerType : null,
      mailbox: Boolean(target.closest('.composer-mailbox, .composer__mailbox')) })
  }, true)
let mailboxTag: string | undefined
const originalHistoryPage = api.sessions.historyPage
api.sessions.historyPage = async (control, options) => {
  if (!mailboxTag || control.agentSessionId !== first.id) return originalHistoryPage(control, options)
  const base = Date.parse(_hygiene_fixtureIso(23796000000, "second"))
  const entries = options?.cursor ? [['native-earlier', 5]] as const
    : [['native-old', 15], ['native-new', 30], ['native-without-time', undefined]] as const
  const page: AgentSessionHistoryPage = { agentSessionId: first.id,
    source: { providerId: first.providerId, nativeSessionId: `visual-native-${mailboxTag}` },
    items: entries.map(([name, minute]) => ({ id: `${mailboxTag}-${name}`, kind: 'user-message',
      contentParts: [{ kind: 'text', text: name }], ...(minute === undefined ? {} : { startedAt: base + minute * 60_000 }) })),
    nextCursor: options?.cursor ? null : 'visual-earlier' }
  return page
}
const copy = api.ui.writeClipboardText, resize = api.sessions.resize
let failCopy = false
api.ui.writeClipboardText = async text => { clipboard.push(text); if (failCopy) throw new Error('Private clipboard refusal'); await copy(text) }
api.sessions.resize = async (...args) => { resizes.push(args); return resize(...args) }
for(const type of ['pointerdown','click','keydown'])document.addEventListener(type, event => {
  const item = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null
  const submenu = item?.closest<HTMLElement>('.workbench-menu-submenu[role="menu"]')
  const owners = submenu ? [...document.querySelectorAll<HTMLElement>('.agent-region-menu')].filter(parent =>
    [...parent.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')].some(trigger => trigger.getAttribute('aria-controls') === submenu.id)) : []
  if (submenu && owners.length !== 1) throw new Error('Swap selection must identify one original Region menu through its actual submenu trigger')
  const menu = submenu ? owners[0] : item?.closest<HTMLElement>('.agent-region-menu')
  if (menu && (type !== 'keydown' || (event as KeyboardEvent).key === 'Enter')) selections.push({ type, pointerType: event instanceof PointerEvent ? event.pointerType : null, label: (item!.getAttribute('aria-label') ?? item!.textContent)?.trim(), trusted: event.isTrusted,
    owner: menu.dataset.ownerRegionId, open: menu.dataset.state === 'open',
    active: useAppStore.getState().tabs[tabId]?.layout.activeRegionId })
}, true)
function naming() {
  const sessions = useAppStore.getState().sessions
  flushSync(() => useAppStore.setState({sessions: sessions.map((session, index) => index > 0 ? {
    ...session, providerId: sessions[0]!.providerId, executorId: sessions[0]!.executorId, label: sessions[0]!.label
  } : session), agentNames: Object.fromEntries(sessions.map((session, index) => [session.id, names[index]]))}))
}
const probe = {
  names,
  messageFeedback(kind: 'tool' | 'failed' | 'unknown' | 'waiting') {
    const state = useAppStore.getState(), session = state.sessions.find(session => session.id === first.id)!
    if (session.kind !== 'agent') throw new Error('Message feedback fixture needs the original Agent owner')
    const id = 'original-feedback-operation', messageId = 'original-feedback-message', logId = 'original-feedback-log'
    const identities = { hostId: session.hostId, agentSessionId: session.id, runId: session.control.run.runId, operationId: id, messageId, logId }
    const raw = 'Original preparation unavailable.\n' + JSON.stringify(identities) + '\n' + 'Original diagnostic line.\n'.repeat(900) + 'original-diagnostic-tail-完整'
    const text = 'Original unsent message.\n' + '原始正文 must remain available.\n'.repeat(20) + 'original-message-tail-完整'
    let toolCalls = 0
    api.ui.chooseFiles = async () => {
      toolCalls++
      if (toolCalls === 1) throw Object.assign(new Error(raw), { ...identities, detail: JSON.stringify(identities) })
      return []
    }
    failCopy = false
    flushSync(() => useAppStore.setState({ agentSteerQueues: { ...state.agentSteerQueues, [session.id]: kind === 'tool' ? [] : [{
      operationId: id, runId: session.control.run.runId, text, status: 'deferred', promptCondition: null,
      error: raw, errorCode: 'AGENT_PROMPT_PREPARATION_FAILED', logId,
      ...(kind !== 'unknown' ? { preparationInputNotApplied: true as const } : {}), enqueuedAt: _reshape_fixtureEpoch(0, 0, 1),
      ...(kind === 'unknown' ? { promptCondition: { expectedRun: { ...session.control.run }, afterSubmissionId: null } } : {}),
      ...(kind === 'waiting' ? { preparationWait: { reason: 'context-compaction', state: 'waiting', attempt: 2, maxAttempts: 3, nextAttemptAt: Date.now() + 30_000 } } : {})
    }] } }))
    return { identities, raw, text }
  },
  failFeedbackCopy(value: boolean) { failCopy = value },
  motionOwner(change: 'target' | 'hide' | 'show') {
    const state = useAppStore.getState()
    if (change === 'target') {
      flushSync(() => useAppStore.setState({ sessions: state.sessions.map(session => session.id === first.id && session.kind === 'agent'
        ? { ...session, control: { ...session.control, run: { ...session.control.run, runId: 'private-motion-target-run' } } } : session) }))
    } else {
      const layout = state.layouts[workspaceId]!
      const group = layout.groups[0]!
      const alternate = createWorkbenchTab('private-motion-hidden-tab', { regionId: 'private-motion-hidden-region', kind: 'launcher', workspaceId })
      flushSync(() => useAppStore.setState({ tabs: { ...state.tabs, [alternate.id]: alternate },
        layouts: { ...state.layouts, [workspaceId]: { ...layout, groups: layout.groups.map(candidate => candidate.id === group.id
          ? { ...candidate, tabOrder: [...new Set([...candidate.tabOrder, alternate.id])], activeTabId: change === 'hide' ? alternate.id : tabId } : candidate) } } }))
      flushSync(() => useAppStore.getState().activateTab(workspaceId, group.id, change === 'hide' ? alternate.id : tabId, 'local'))
    }
  },
  feedbackWaitCancelCalls() { return [...waitCancelCalls] },
  appearance(mode: 'dark' | 'light') { return updateThemeSelection({ ...useAppStore.getState().config?.appearance, appAppearance: mode }) },
  toolbarFacts() {
    flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === first.id ? {
      ...session, turnUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, observedAt: Date.now(), context: { usedTokens: 58_000, capacityTokens: 100_000 } }
    } : session), providerCatalog: state.providerCatalog.map(provider => provider.id === first.providerId ? {
      ...provider, composer: { ...provider.composer, commands: [{ text: '/review', description: 'Review the preview workspace' }] }
    } : provider) })))
  },
  progress(state: 'inactive' | 'active' | 'paused' | 'unconfirmed' | 'stopped', full = false) {
    const loop: ContinuousProgressLoop = { loopId: 'visual-progress', hostId: first.hostId, agentSessionId: first.id,
      providerId: first.providerId, workspacePath: first.workspacePath, intervalMs: 1_800_000,
      prompt: 'Continue the current task without replacing user input.', nextCheckAt: Date.parse(_hygiene_fixtureIso(23803200000, "second")),
      status: state === 'inactive' || state === 'stopped' ? 'stopped' : state === 'active' ? 'active' : 'paused',
      ...(state === 'unconfirmed' ? { lastOutcome: 'unknown' as const,
        lastDecision: 'Previous continuation delivery is unconfirmed. No retry has been sent.' }
        : state === 'paused' ? { lastDecision: 'Paused while the user is editing.' } : {}),
      ...(full ? { prompt: Array.from({ length: 12 }, (_, index) => `Saved continuation line ${index + 1}: keep the original user input and finish the assigned task.`).join('\n'),
        taskSource: { root: _hygiene_fixturePath("private/visual-task-source"), ownerId: 'visual-task', readerPath: _hygiene_fixturePath("private/visual-task-source/feature-tracker.sh") },
        lastTickAt: Date.parse(_hygiene_fixtureIso(23801400000, "second")),
        lastDecision: Array.from({ length: 14 }, (_, index) => `Original decision line ${index + 1}: the input owner is unchanged and the complete reason remains readable.`).join('\n') } : {}) }
    progressLoops = state === 'inactive' ? [] : [loop]
    flushSync(() => { for (const listener of progressListeners) listener(loop) })
  },
  progressFacts() { return { reads: [...progressReads], subscribers: progressListeners.size } },
  mailboxLayout(tag: string) {
    const state = useAppStore.getState(), session = state.sessions.find(item => item.id === first.id)!
    if (session.kind !== 'agent') throw new Error('Layout journal needs the exact original Agent')
    const peer = state.sessions[1]!, base = Date.parse(new Date(_reshape_fixtureEpoch(20747, 0, 12000000)).toISOString())
    const originalBody = (index: number) => `第${index}封：请核对当前工作区的设计与实现。先确认来源、责任与验收，再保留原始上下文推进。\n\n` +
      '这是一段需要完整阅读的中文原文。摘要只能帮助辨认，不能代替原始消息，也不能把通知已提交理解为任务已接受。'.repeat(7) + `\n\n原文唯一尾段-${tag}-${index}-完整保留。`
    const message = (index: number, incoming: boolean): DurableAgentMuxMessage => {
      const sender = incoming ? peer : session, recipient = incoming ? session : peer
      const record: DurableAgentMuxMessage = { sequence: index, envelope: { schema: 'agentmux.a2a.v1', messageId: `layout-${tag}-${incoming ? 'incoming' : 'outgoing'}-${index}`,
        operationId: `layout-operation-${tag}-${index}`, createdAt: base + index * 60_000,
        sender: { kind: 'agent-session', agentSessionId: sender.id }, recipient: { kind: 'agent-session', agentSessionId: recipient.id },
        senderSessionId: sender.id, senderRunId: sender.control.run.runId, recipientSessionId: recipient.id, recipientRunId: recipient.control.run.runId,
        threadId: `layout-thread-${tag}-${index}`, correlationId: `layout-correlation-${tag}-${index}`, replyTo: null, workspaceId, body: originalBody(index) },
        delivery: index % 5 === 3 ? { state: 'failed', at: base + index * 60_000, reason: '原收件方投递回执未确认；保留原消息与当前 Agent。' } : { state: 'delivered', at: base + index * 60_000 } }
      return index % 5 < 3 ? { ...record, deliveryMode: 'reference', notification: { state: (['pending', 'submitted', 'unconfirmed'] as const)[index % 5]!,
        ...(index % 5 === 2 ? { notificationId: `layout-notice-${index}`, reason: '通知输入回执未知；原文和原消息身份仍保留。' } : {}) } } : record
    }
    layoutJournal = [...Array.from({ length: 27 }, (_, index) => message(index + 1, true)), ...[101, 102, 103].map(index => message(index, false))]
    const key = { kind: 'prompt' as const, agentSessionId: session.id, expectedRun: session.control.run, submissionId: `layout-human-${tag}` }
    const body = '<amux>作者自己写下的原始标记，不能再次解包</amux>\n\n' + originalBody(201)
    const wire = `<amux>原平台上下文-${tag}</amux>\n\n<amux:a2a from="recorded-peer" msg-id="recorded-wire">\n${originalBody(202)}\n</amux:a2a>`
    layoutInputs = [{ kind: 'controlled', sequence: 2, recordedAt: base + 202 * 60_000, intent: { key, execution: 'immediate',
      admissionIntent: { kind: 'manual-actor', expectedRun: session.control.run }, source: { kind: 'prompt', prompt: body, promptWire: `原wire头-${tag}\n${body}\n原wire尾-${tag}`, authorHuman: true } }, receipt: null,
      failure: { name: 'Error', code: 'ORIGINAL_OBSERVATION_UNKNOWN', message: '原输入回执未确认；正文与准确输入身份保留。' } },
    { kind: 'submission', sequence: 1, recordedAt: base + 201 * 60_000, key: { ...key, submissionId: `layout-wire-${tag}` },
      record: { agentSessionId: session.id, run: session.control.run, admission: { inputKey: { ...key, submissionId: `layout-wire-${tag}` }, submissionId: `layout-wire-${tag}`,
        operationId: `layout-wire-operation-${tag}`, startByte: 0, endByte: new TextEncoder().encode(wire).byteLength, acknowledged: true,
        intent: { run: session.control.run, ownerInstanceId: 'private-layout-owner', prompt: wire, plan: { kind: 'single-phase', data: wire } } } } }]
    layoutCalls.length = 0
    mailboxTag = `layout-${tag}`
    flushSync(() => useAppStore.setState({ sessions: state.sessions.map(item => item.id === session.id ? { ...session,
      terminalCapability: { state: 'unknown', mode: 'degraded', reason: 'handshake-timeout', run: session.control.run, observedAt: base } } : item),
      agentSteerQueues: { ...state.agentSteerQueues, [session.id]: [{ operationId: `layout-pending-${tag}`, runId: session.control.run.runId,
        text: '原待发意图：先保留草稿与准确目标，再继续核对。', status: 'deferred', error: '原投递观察未确认，尚未重新发送。', enqueuedAt: base + 203 * 60_000 }] } }))
    for (const listener of layoutListeners) {
      listener({ type: 'core', hostId: session.hostId, event: { type: 'agent-message-observation', state: 'available' } })
      listener({ type: 'core', hostId: session.hostId, event: { type: 'agent-message-changed', messageId: layoutJournal[26]!.envelope.messageId,
        sequence: 27, senderSessionId: peer.id, recipientSessionId: session.id } })
    }
    return { hostId: session.hostId, agentSessionId: session.id, incoming: layoutJournal[26]!.envelope.messageId,
      body: layoutJournal[26]!.envelope.body, bodyInput: body, wireInput: wire }
  },
  mailboxLayoutFacts() { return { calls: [...layoutCalls], inputCopies: layoutInputs.map(item => item.kind === 'controlled' && item.intent.source.kind === 'prompt'
    ? item.intent.source.promptWire ?? item.intent.source.prompt : item.kind === 'submission' ? item.record?.admission?.intent?.prompt : undefined) } },
  mailbox(tag: string) {
    mailboxTag = tag
    const state = useAppStore.getState(), session = state.sessions.find(session => session.id === first.id)!
    if (session.kind !== 'agent') throw new Error('Mailbox fixture needs the actual Agent owner')
    const base = Date.parse(_hygiene_fixtureIso(23796000000, "second"))
    const items: AgentTimelineItem[] = [
      ['incoming-old', 10, true], ['timeline-old', 10, false], ['timeline-tie-a', 20, false],
      ['incoming-new', 40, true], ['timeline-tie-b', 20, false], ['timeline-new', 40, false]
    ].map(([text, minute, incoming]) => ({ id: `${tag}-${text}`, agentSessionId: session.id,
      kind: 'user_message', status: 'complete', source: 'user', title: 'User message', content: String(text),
      createdAt: base + Number(minute) * 60_000, updatedAt: base + Number(minute) * 60_000,
      ...(incoming ? { authorAgentSessionId: state.sessions[1]!.id } : {}) }))
    flushSync(() => useAppStore.setState({ sessions: state.sessions.map(item => item.id === session.id ? {
      ...session, processState: 'running', terminalCapability: { state: 'unknown', mode: 'degraded',
        reason: 'handshake-timeout', run: session.control.run, observedAt: base + 10 * 60_000 },
      terminalPromptDelivery: { state: 'unverified', mode: 'degraded', reason: 'prompt-render-timeout',
        submissionId: `visual-${tag}`, run: session.control.run, observedAt: base + 20 * 60_000 }
    } : item), timelines: { ...state.timelines, [session.id]: { agentSessionId: session.id, revision: 1, items } },
      agentSteerQueues: { ...state.agentSteerQueues, [session.id]: ['queue-first', 'queue-second'].map((text, index) => ({
        operationId: `${tag}-${text}`, runId: session.control.run.runId, text, status: 'deferred',
        error: 'Private preview delivery has not completed.', enqueuedAt: base + (50 + index) * 60_000 })) } }))
  },
  mailboxConnectionTime(observedAt: number) {
    flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(session =>
      session.id === first.id && session.kind === 'agent' && session.terminalCapability
        ? { ...session, terminalCapability: { ...session.terminalCapability, observedAt } } : session) })))
  },
  mailboxInputs() { return [...mailboxInputs] },
  terminalLoading() {
    const attach = api.sessions.attach
    let release!: () => void
    const waiting = new Promise<void>(done => { release = done })
    const timeout = setTimeout(release, 10_000)
    api.sessions.attach = async (...args) => { await waiting; return attach(...args) }
    const generation = original.mode('terminal'); naming()
    const state = useAppStore.getState()
    flushSync(() => useAppStore.setState({ sessions: state.sessions.map(session => session.kind === 'agent' ? {
      ...session, terminalCapability: { state: 'unknown', mode: 'degraded', reason: 'handshake-timeout',
        run: session.control.run, observedAt: Date.now() }
    } : session) }))
    return { generation, release() { clearTimeout(timeout); api.sessions.attach = attach; release() } }
  },
  menuSource(state: 'confirmed' | 'changed' | 'unknown') {
    flushSync(() => useAppStore.setState(current => ({ sessions: current.sessions.map(session => session.id === first.id && session.kind === 'agent'
      ? { ...session, nativeHandle: { kind: 'provider', providerId: session.providerId, sessionId: 'preview-original-native' },
          capabilities: { ...session.capabilities, providerFork: { current: true } },
          observedNativeHandle: { kind: 'provider', providerId: session.providerId, sessionId: state === 'changed' ? 'preview-candidate-native' : 'preview-original-native' },
          nativeSourceObservation: state === 'confirmed' ? undefined : { state, run: session.control.run, observedAt: Date.now(), reason: 'Authoritative current candidate differs from the retained source.' } }
      : session) })))
  },
  mode(mode: 'terminal' | 'cold' | 'notice') { const generation = original.mode(mode); naming(); return generation },
  observe() { const generation = original.observe(); naming(); return generation },
  swap() {
    const generation = original.mode('terminal', third); naming()
    const state = useAppStore.getState(), sessions = state.sessions
    flushSync(() => useAppStore.setState({
      tabs: { ...state.tabs, 'unrelated-swap-tab': createWorkbenchTab('unrelated-swap-tab', {
        regionId: 'unrelated-swap-region', kind: 'launcher', workspaceId
      }) },
      agentComposerDrafts: Object.fromEntries(sessions.map(session => [session.id, `Unsent original ${session.id}`])),
      agentSteerQueues: Object.fromEntries(sessions.map(session => [session.id, [{ operationId: `pending-${session.id}`,
        runId: session.control.run.runId, text: `Unsent pending ${session.id}`, status: 'queued', enqueuedAt: _reshape_fixtureEpoch(0, 0, 1) }]]))
    }))
    return generation
  },
  rename(index: number, name: string | null) { flushSync(() => useAppStore.getState().renameAgent(useAppStore.getState().sessions[index]!.id, name)) },
  focusNeighbor() { flushSync(() => useAppStore.getState().focusRegion(workspaceId, tabId, rightId, 'pointer')) },
  facts() {
    const state = useAppStore.getState()
    return { ...original.facts(), active: state.tabs[tabId]?.layout.activeRegionId, tabs: state.tabs,
      drafts: state.agentComposerDrafts, queues: state.agentSteerQueues, names: state.agentNames,
      regionAddress: formatRegionAddress(leftId), clipboard: [...clipboard], resizes: [...resizes], selections: [...selections] }
  },
  terminal() {
    const element = document.querySelector(`[data-workbench-region-id="${leftId}"] .xterm`) ?? document.querySelector('.xterm')
    const terminals = (window as any).identityTerminals as Array<{ id: number; terminal: { element: Element | undefined; cols: number; rows: number; buffer: { active: { cursorX: number; cursorY: number } } }; disposed: boolean }>
    const record = terminals.find(record => record.terminal.element === element)
    if (!record || record.disposed) throw new Error('The actual original xterm instance is absent')
    const r = element!.parentElement!.getBoundingClientRect()
    return { id: record.id, cols: record.terminal.cols, rows: record.terminal.rows, cursor: { x: record.terminal.buffer.active.cursorX, y: record.terminal.buffer.active.cursorY },
      container: { x: r.x, y: r.y, width: r.width, height: r.height }, resizes: resizes.length }
  }
}
Object.assign(window, { identityMenu: probe })
probe.mode('terminal')
