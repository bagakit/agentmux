import { fixtureEpoch as _batchFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ContinuousProgressLoop, ContinuousProgressTarget, FileReadResult, ScheduleParamsMap } from '@agentmux/core'
import { validateScheduleRpcResult } from '@agentmux/core/schedule-rpc'
import { parseMoteChatResult } from '@agentmux/core/mote-chat'
import { parseConnectionResult } from '@agentmux/core/connections'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { AgentSessionComposer } from '../../../src/renderer/src/components/AgentSessionComposer'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { MoteFilesTool } from '../../../src/renderer/src/components/MoteFilesTool'
import { MoteProfilePopover } from '../../../src/renderer/src/components/MoteProfilePopover'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { useMoteWorkfaceScope } from '../../../src/renderer/src/lib/mote-workface'
import { DEFAULT_MOTE_BEHAVIOR, serializeMoteBehaviorDocument, type MoteBehaviorDraft } from '../../../src/renderer/src/lib/mote-behavior'
import { DEFAULT_MOTE_SOUL, PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { DEFAULT_MOTE_MEMORY } from '../../../src/shared/topic-agent-instructions'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import type { Demand, ScratchTopicSnapshot, SessionSnapshot, WorkspaceRecord } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
import './scene.css'

// No preload is installed. All transport replies below belong to this one private Renderer.
if (Object.hasOwn(window, 'agentmux')) throw new Error('A live Desktop preload must never enter this visual fixture.')
const workspacePath = new URLSearchParams(location.search).get('workspacePath')
if (!workspacePath || !workspacePath.includes('/capture-')) throw new Error('An exact private capture workspace is required.')
mountThemeRuntime(window, { appAppearance: 'dark' })
const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: workspacePath, name: 'Motes', kind: 'folder' }
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
const topic: ScratchTopicSnapshot = { id: PMO_TEAMS_TOPIC_ID, title: 'Mote', summary: 'A small working result, then the next decision.',
  directoryPath: workspacePath + '/' + rootPath, physicalDirectoryPath: workspacePath + '/' + rootPath,
  confirmedDirectoryPaths: [workspacePath + '/' + rootPath], identityDirectoryPath: workspacePath + '/' + rootPath,
  topicPath: workspacePath + '/' + rootPath + '/topic.md', collaborators: [] }
const spaceId = directoryIdentity(workspace.hostId, topic.directoryPath), zoneId = homeZoneId(spaceId), groupId = 'calendar-private-group'
const now = Date.now(), day = 86_400_000
const civil = (instant: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
const nine = (instant: number) => new Date(civil(instant) + ("T" + new Date(_batchFixtureEpoch(0, 32400)).toISOString().slice(11, 19) + "+" + new Date(_batchFixtureEpoch(0, 28800)).toISOString().slice(11, 16))).getTime()
const nextNine = nine(now) > now ? nine(now) : nine(now + day)
const sessions: Extract<SessionSnapshot, { kind: 'agent' }>[] = [0, 1].map(index => ({ id: 'calendar-renderer-session-' + index, kind: 'agent', providerId: 'fixture', executorId: 'fixture', hostId: 'local',
  workspacePath: topic.directoryPath, label: index ? 'Research follow-up' : 'Project decisions', createdAt: now - day, updatedAt: now, agentSessionUpdatedAt: now,
  processState: 'running', latestOutputBytes: 0, status: { state: 'waiting', source: 'native-hook', observedAt: now },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: 'calendar-core-session-' + index, run: { runId: 'calendar-private-run-' + index } } }))
const tabs = sessions.map((session, index) => ({ ...createWorkbenchTab('calendar-tab-' + index,
  { kind: 'agent', phase: 'attached', regionId: 'calendar-region-' + index, workspaceId: workspace.id, sessionId: session.id }, session.label),
  topicId: topic.id, space: { spaceId, zoneId } }))
const targets: ContinuousProgressTarget[] = sessions.map(session => ({ hostId: session.hostId, agentSessionId: session.control.agentSessionId,
  providerId: session.providerId, workspacePath: session.workspacePath }))
const initialDrafts = { [sessions[0]!.id]: '先保留这个手动草稿：等我确认方案再继续。', [sessions[1]!.id]: '这段研究追问还没发送。' }
const goal: Demand = { id: 'mote-workspace-experiment', title: '把第一个小实验做好', description: '比较两份有来源的调研，留下可以检查的选择。',
  sessionIds: [sessions[0]!.id], assigneeSessionIds: [], supervisorSessionId: null, participations: [],
  status: 'in_progress', priority: 'normal', projectId: null, projectName: null, executorId: null,
  tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, activities: [], decisions: [], createdAt: now, updatedAt: now,
  alignment: { revision: 1, confirmedAt: now, summary: '先做一个可验证的结果，再决定下一步。', criteria: [{ id: 'sources', text: '保留原始证据和仍需确认的问题。' }], openQuestions: [] } }
const calls: { method: string; params: unknown }[] = [], opened: string[] = []
const listeners = new Set<(schedule: ContinuousProgressLoop) => void>()
let mode = 'populated', lostCreate = false, listUnknown = false, noteUnknown = false, generation = 0
const policies = { gap: 'skip' as const, fold: 'earlier' as const, monthEnd: 'clamp' as const, overdue: 'latest' as const }
const calendar = { kind: 'daily' as const, time: (new Date(_batchFixtureEpoch(0, 32400)).toISOString().slice(11, 16)), timezone: 'Asia/Shanghai', policies }
const make = (id: string, index: number, prompt: string, due: number, rest: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop => ({ ...targets[index]!,
  loopId: id, creationOperationId: 'original-' + id, futureIntentId: 'private-intent-' + id, revision: 2, intervalMs: 60_000, calendar, prompt, status: 'active', nextCheckAt: due, ...rest })
function sceneRecords(): ContinuousProgressLoop[] {
  return [make('daily-brief', 0, '早上一起看：项目进展、需要我决定的事情，以及今天最小的一步', nextNine),
    make('research-timer', 1, '20 分钟后提醒我回来比较调研结论，不要替我决定或发消息给别人', now + 20 * 60_000, { calendar: undefined, afterMs: 1_200_000 }),
    make('paused-review', 1, '暂停的每周复盘：先等我确认下一个阶段', nextNine, { status: 'paused' }),
    make('overdue-design', 0, '已经到点：检查设计原型中仍未确认的选择', nine(now - day),
      { calendar: { ...calendar, kind: 'once', date: civil(now - day) } }),
    make('unknown-input', 1, '原输入回执还没确认，保留原操作等待核对', now - 30 * 60_000,
      { afterMs: 900_000, calendar: undefined, status: 'paused', lastOutcome: 'unknown', lastDecision: 'Input receipt is unconfirmed. Keep the original operation; check before retrying.' }),
    make('accepted-input', 0, '上一次晨间安排：输入已被接收，结果仍需要核对', nextNine,
      { lastOutcome: 'sent', lastOccurrenceAt: nextNine - day, lastTickAt: nextNine - day + 10_000 }),
    make('month-once', 1, '下周一起整理实验结果和仍待确认的假设', nine(now + 7 * day),
      { calendar: { ...calendar, kind: 'once', date: civil(now + 7 * day) } })]
}
let records = sceneRecords()
const clone = <T,>(value: T): T => structuredClone(value)
const assertTarget = (target: ContinuousProgressTarget) => {
  if (!targets.some(value => (['hostId', 'agentSessionId', 'providerId', 'workspacePath'] as const).every(key => value[key] === target[key]))) throw new Error('PRIVATE_FIXTURE_TARGET_MISMATCH')
}
api.schedule.list = async params => {
  calls.push({ method: 'schedule.list', params: clone(params) })
  if (listUnknown) throw new Error('The connected Host could not confirm saved arrangements. Original discussions and drafts remain available.')
  if (params.scope) {
    if (params.scope.hostId !== workspace.hostId || params.scope.workspacePath !== topic.directoryPath) throw new Error('PRIVATE_FIXTURE_SCOPE_MISMATCH')
    return validateScheduleRpcResult('schedule.list', { schedules: clone(records), executionScope: 'connected-host' }, params)
  }
  if (params.target) assertTarget(params.target)
  return validateScheduleRpcResult('schedule.list', { schedules: clone(params.target ? records.filter(item => item.agentSessionId === params.target!.agentSessionId) : records), executionScope: 'connected-host' }, params)
}
api.schedule.onChanged = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
api.schedule.create = async (params: ScheduleParamsMap['schedule.create']) => {
  assertTarget(params.target); calls.push({ method: 'schedule.create', params: clone(params) })
  let schedule = records.find(item => item.creationOperationId === params.operationId)
  if (!schedule) { schedule = { ...params.target, loopId: 'created-calendar-' + (++generation), creationOperationId: params.operationId,
    revision: 1, futureIntentId: 'private-intent-' + generation, status: 'active', intervalMs: 60_000, prompt: params.prompt,
    ...('afterMs' in params ? { afterMs: params.afterMs, nextCheckAt: Date.now() + params.afterMs } : { calendar: params.calendar, nextCheckAt: now + day }),
    ...('checkIn' in params && params.checkIn ? { checkIn: params.checkIn } : {}) }; records.push(schedule) }
  if (lostCreate) { lostCreate = false; throw new Error('The original write receipt is unconfirmed. Keep this message and retry the same operation.') }
  listeners.forEach(listener => listener(clone(schedule!)))
  return validateScheduleRpcResult('schedule.create', { schedule: clone(schedule), diskDurability: 'confirmed', executionScope: 'connected-host' }, params)
}
api.schedule.inspect = async params => {
  calls.push({ method: 'schedule.inspect', params: clone(params) })
  return validateScheduleRpcResult('schedule.inspect', { schedule: clone(records.find(item => params.operationId ? item.creationOperationId === params.operationId || item.lastMutation?.operationId === params.operationId : item.loopId === params.scheduleId) ?? null), executionScope: 'connected-host' }, params)
}
const mutate = (action: 'pause' | 'resume' | 'cancel') => async (params: ScheduleParamsMap['schedule.pause']) => {
  calls.push({ method: 'schedule.' + action, params: clone(params) })
  const previous = records.find(item => item.loopId === params.scheduleId)
  if (!previous || previous.revision !== params.expectedRevision || previous.status === 'stopped') throw new Error('PRIVATE_FIXTURE_REVISION_OR_TERMINAL_MISMATCH')
  const schedule: ContinuousProgressLoop = { ...previous, status: action === 'cancel' ? 'stopped' : action === 'pause' ? 'paused' : 'active', revision: previous.revision + 1,
    lastMutation: { operationId: params.operationId, expectedRevision: params.expectedRevision, action } }
  records = records.map(item => item.loopId === previous.loopId ? schedule : item); listeners.forEach(listener => listener(clone(schedule)))
  return validateScheduleRpcResult('schedule.' + action, { schedule: clone(schedule), diskDurability: 'confirmed' as const, executionScope: 'connected-host' as const }, params)
}
api.schedule.pause = mutate('pause'); api.schedule.resume = mutate('resume'); api.schedule.cancel = mutate('cancel')
const savedPreferences = { engagement: 'I', information: 'N', decisions: 'F', approach: 'J', custom: 'Keep our decisions clear and leave room for a useful next step.' } as const
let behaviorUnknown = false
const files: Record<string, string> = { [rootPath + '/SOUL.md']: DEFAULT_MOTE_SOUL, [rootPath + '/BEHAVIOR.md']: serializeMoteBehaviorDocument(DEFAULT_MOTE_BEHAVIOR, savedPreferences),
  [rootPath + '/MEMORY.md']: DEFAULT_MOTE_MEMORY, [rootPath + '/experiment-notes.md']: '# 比较一个小实验\n\n来源：项目讨论。范围：本 Mote。\n\n先比较一个原型，再决定是否扩大。\n\n## 下一步值得弄清楚的事\n\n- 哪个选择能让日常协作更自然？\n- 哪些操作必须保留原来的身份与草稿？\n- 一个小实验能否给出足够清楚的证据？\n\n> 先把问题问清楚，再一起决定投入多少。\n',
  [rootPath + '/next-steps.md']: '# 下一步的几个方向\n\n保留可以直接比较的小选择。\n\n从真实工作中收集反馈，再决定是否扩大范围。\n',
  [rootPath + '/a-long-question-about-how-we-build-and-learn-together.md']: '# 关于怎样一起工作与学习的一个长问题\n\n长标题和长内容仍然属于同一个原文件，不应该挤掉编辑与返回动作。\n' }
const revision = async (content: string) => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
api.files.readDirectory = async (_workspace, directory) => Object.keys(files).filter(file => file.startsWith(directory + '/')).map(file => ({ path: file, name: file.split('/').at(-1)!, isDirectory: false, isSymlink: false, ignored: false, mtimeMs: now }))
api.files.read = async (_workspace, file) => ({ status: 'read', document: { path: file, content: files[file] ?? '', revision: await revision(files[file] ?? '') } })
api.files.readPublic = async params => {
  const file = rootPath + '/' + params.path
  const resource = { ...params.expectedResource, zoneId: params.zoneId, zonePath: topic.directoryPath, path: file }
  if (behaviorUnknown && file === rootPath + '/BEHAVIOR.md') return { resource, result: { status: 'unknown', code: 'PRIVATE_BEHAVIOR_READ_UNCONFIRMED', message: 'The original saved behavior could not be confirmed. Inspect or retry the same source.' } } as FileReadResult
  if (noteUnknown && file === rootPath + '/experiment-notes.md') return { resource, result: { status: 'unknown', code: 'PRIVATE_NOTE_READ_UNCONFIRMED', message: 'The original saved note could not be confirmed. Last confirmed content is kept; retry the same file.' } } as FileReadResult
  return { resource, result: files[file] === undefined ? { status: 'deleted' } : { status: 'read', document: { path: file, content: files[file], revision: await revision(files[file]) } } } as FileReadResult
}
api.files.observe = async () => {}; api.files.unobserve = async () => {}; api.files.onInvalidated = () => () => {}
api.scratch.listTopics = async () => [topic]; api.scratch.readTopic = async () => topic
api.demands.list = async () => [goal]
api.sessions.historyPage = async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'fixture', nativeSessionId: 'private-' + control.agentSessionId }, nextCursor: null, items: [] })
api.moteChat.call = async (method, params) => {
  calls.push({ method, params: clone(params) })
  if (method !== 'space.mote.chat.inspect') throw new Error('PRIVATE_FIXTURE_NO_CHAT_MUTATION')
  return parseMoteChatResult(method, { configuration: null, operation: null }, params)
}
api.connections.call = async (method, params) => {
  calls.push({ method, params: clone(params) })
  if (method === 'connection.ls') return parseConnectionResult(method, { connections: [] }, params)
  if (method === 'connection.service.get') return parseConnectionResult(method, { enabled: false, revision: 0 }, params)
  throw new Error('PRIVATE_FIXTURE_NO_CONNECTION_MUTATION')
}
useAppStore.setState({ config: { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: {}, workspaces: [workspace], appearance: { terminalTheme: 'graphite' } },
  tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])), layouts: { [workspace.id]: createWorkspaceLayout(groupId, tabs.map(tab => tab.id)) }, sessions,
  activeWorkspaceId: workspace.id, mainSurface: 'workbench', agentComposerDrafts: { ...initialDrafts }, documents: {}, dirtyDocuments: {}, documentIssues: {}, demands: { [goal.id]: goal },
  scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), topics: [topic], revision: 0, reading: false, error: null } },
  spaceZoneBindings: { [zoneId]: { workspaceId: workspace.id, spaceId, topicId: topic.id, contentKind: 'mote', directoryPath: topic.directoryPath } },
  workbenchSpaceSelection: { workspaceId: workspace.id, groupId, tabId: tabs[0]!.id, regionId: tabs[0]!.layout.activeRegionId, topicId: topic.id, spaceId, zoneId },
  prewarmTerminal: async () => {}, detectExecutors: async () => {}, reportError: error => { calls.push({ method: 'fixture.error', params: String(error) }) },
  send: () => { throw new Error('PRIVATE_FIXTURE_NO_MODEL_OR_INPUT') }, interrupt: async () => { throw new Error('PRIVATE_FIXTURE_NO_RUN_CONTROL') } })

function Scene() {
  const [epoch, setEpoch] = useState(0), [card, setCard] = useState(false)
  const scope = useMoteWorkfaceScope(workspace.id)!
  const selected = useAppStore(state => state.workbenchSpaceSelection)
  const currentTab = useAppStore(state => selected?.tabId ? state.tabs[selected.tabId] : undefined)
  const currentRegion = currentTab?.regions[selected?.regionId ?? '']
  const sessionId = currentRegion?.kind === 'agent' ? currentRegion.sessionId : sessions[0]!.id
  const reference = selected ? { displayWorkspaceId: workspace.id, groupId, tabId: selected.tabId!, regionId: selected.regionId! } : null
  const select = (index: number) => useAppStore.setState(state => ({ workbenchSpaceSelection: { workspaceId: workspace.id, groupId,
    tabId: tabs[index]!.id, regionId: tabs[index]!.layout.activeRegionId, topicId: topic.id, spaceId, zoneId },
    layouts: { ...state.layouts, [workspace.id]: { ...state.layouts[workspace.id]!, groups: state.layouts[workspace.id]!.groups.map(group => ({ ...group, activeTabId: tabs[index]!.id })) } } }))
  Object.assign(window, { moteCalendarScene: {
    theme: (appearance: 'light' | 'dark') => updateThemeSelection({ appAppearance: appearance }),
    scenario: (next: 'populated' | 'empty' | 'unavailable') => { mode = next; records = next === 'empty' ? [] : sceneRecords(); listUnknown = next === 'unavailable'; setEpoch(value => value + 1) },
    loseCreateReceipt: () => { lostCreate = true },
    noteReadFailure: (failed: boolean) => { noteUnknown = failed; useAppStore.setState(state => ({ workspaceFileRevisions: { ...state.workspaceFileRevisions, [workspace.id]: (state.workspaceFileRevisions[workspace.id] ?? 0) + 1 } })) },
    name: (title: string) => { topic.title = title; useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
      [workspace.id]: { ...state.scratchTopicSnapshots[workspace.id]!, topics: [{ ...topic }] } } })) },
    summary: (summary: string) => { topic.summary = summary; useAppStore.setState(state => ({ scratchTopicSnapshots: { ...state.scratchTopicSnapshots,
      [workspace.id]: { ...state.scratchTopicSnapshots[workspace.id]!, topics: [{ ...topic }] } } })) },
    behavior: (preferences: MoteBehaviorDraft | 'unknown' | 'saved') => {
      behaviorUnknown = preferences === 'unknown'
      if (!behaviorUnknown) files[rootPath + '/BEHAVIOR.md'] = serializeMoteBehaviorDocument(DEFAULT_MOTE_BEHAVIOR, preferences === 'saved' ? savedPreferences : preferences as MoteBehaviorDraft)
      useAppStore.setState(state => ({ workspaceFileRevisions: { ...state.workspaceFileRevisions, [workspace.id]: (state.workspaceFileRevisions[workspace.id] ?? 0) + 1 } }))
    },
    presentation: (next: 'space' | 'card') => setCard(next === 'card'),
    facts: () => ({ mode, now, workspacePath, moteDirectory: topic.directoryPath, targets, initialDrafts, drafts: useAppStore.getState().agentComposerDrafts,
      selection: useAppStore.getState().workbenchSpaceSelection, tabIds: Object.keys(useAppStore.getState().tabs), sessions: useAppStore.getState().sessions.map(session => session.id), records, calls, opened })
  } })
  return <DesktopClientUiProvider><WindowOverlayHost /><main className="calendar-fixture" data-presentation={card ? 'card' : 'space'}>
    <header className="calendar-fixture__top"><span className="calendar-fixture__brand">Mote</span><span className="calendar-fixture__space-name">项目与日常合作</span><span className="calendar-fixture__private">Private visual fixture</span></header>
    <div className="calendar-fixture__body">
      <aside className="calendar-fixture__details" hidden={card}><MoteFilesTool key={epoch} workspace={workspace} visible={!card} isScratch scope={scope} reference={reference} onOpenPath={async file => { opened.push(file) }} /></aside>
      <section className="calendar-fixture__discussion" data-workbench-region-id={currentRegion?.regionId}>
        <header className="calendar-fixture__tabs">{tabs.map((tab, index) => <button type="button" key={tab.id} data-fixture-session={index} aria-pressed={sessionId === sessions[index]!.id} onClick={() => select(index)}>{tab.name}</button>)}
          <MoteProfilePopover workspaceId={workspace.id} topicId={topic.id} reference={reference} active onReferenceSelect={() => {}}>{trigger => trigger}</MoteProfilePopover>
        </header>
        <article className="calendar-fixture__history"><p className="calendar-fixture__eyebrow">{sessions.find(session => session.id === sessionId)?.label}</p><h1>先把一个小实验做好。</h1><p>保留现在的判断和原始资料，等结果出来再一起决定下一步。</p><blockquote>我们还没有确认最后的方案。安排提醒可以先保存，手动消息继续留在原对话。</blockquote><p className="calendar-fixture__history-note">两段讨论属于同一个 Mote，安排与原对话分别保留。</p></article>
        <div className="calendar-fixture__composer"><AgentSessionComposer key={sessionId} sessionId={sessionId} /></div>
      </section>
    </div>
  </main></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Scene />)
