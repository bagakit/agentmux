import { fixturePath } from '../../lib/fixture-values.mjs'
import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { ExecutorIdentityContext } from '../../../src/renderer/src/components/AgentAvatar'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { FocusSettingsPane } from '../../../src/renderer/src/components/settings/FocusSettingsPane'
import { saveFocusPreferences } from '../../../src/renderer/src/lib/focus-preferences'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { UNCLASSIFIED_TOPIC_CATEGORY_ID } from '@agentmux/host/topic-categories'
import { formatSpaceAddress } from '@agentmux/core/sharing'
import '../../../src/renderer/src/styles/index.css'

// Actual current Renderer, static private transport facts. This does not claim
// a true Provider/Run, native PTY or persisted configuration receipt.
const config = await api.config.get(), snapshot = await api.sessions.snapshot(), base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base) throw new Error('Original typed preview Agent required')
const scratch = { id: '__scratch__', name: 'Topics', path: fixturePath('private/focus-collection-preview/topics'), hostId: 'local', kind: 'folder' }
const project = { id: 'collection-project', name: 'agentmux', path: fixturePath('private/focus-collection-preview/project'), hostId: 'local', kind: 'folder' }
const topic = (suffix, title) => { const id = 'launcher:collection-' + suffix, directoryPath = scratch.path + '/' + scratchTopicDirectoryName(id); return { id, title, summary: '原 Topic 的完整说明。标题与 Agent 任务名分别保留。', directoryPath, topicPath: directoryPath + '/topic.md', collaborators: [], kind: 'topic' } }
const topics = [topic('local', '局域网设备查看'), topic('devbox', 'DevBox、Bot 与研究 / 开发农场管理优化：保留原工作环境与跨设备访问边界，让不同开发任务更容易辨认'), topic('study', '学习：Agent 架构与持续改进'), topic('multi-a', '跨领域工作 A'), topic('multi-b', '跨领域工作 B'), topic('unclassified', '尚未整理的研究'), topic('unknown', '原分类关系待确认的任务')]
const category = (id, title) => { const directoryPath = scratch.path + '/category--' + id; return { categoryId: id, hostId: 'local', title, directoryPath, spaceId: directoryIdentity('local', directoryPath), revision: 'private-static-revision' } }
const categories = [category('11111111-1111-4111-8111-111111111111', 'MAC'), category('22222222-2222-4222-8222-222222222222', '学习'), category(UNCLASSIFIED_TOPIC_CATEGORY_ID, '未分类')]
const bindings = Object.fromEntries(topics.map((value, i) => { const spaceId = directoryIdentity('local', value.directoryPath); return [homeZoneId(spaceId), { spaceId, workspaceId: scratch.id, topicId: value.id, contentKind: 'topic', directoryPath: value.directoryPath,
  relations: Object.fromEntries((i < 2 ? [categories[0]] : i === 2 ? [categories[1]] : i < 5 ? categories.slice(0, 2) : i === 5 ? [categories[2]] : []).map(item => [item.spaceId, true])) }] }))
const now = Date.now(), actor = (id, index, name) => {
  const { pendingInteraction: _pending, ...agent } = base
  const workspacePath = index === null ? project.path : topics[index].directoryPath
  const status = { state: 'disconnected', source: 'native-hook', observedAt: now, detail: '原会话、历史与草稿仍保留。' }
  return { ...agent, id, label: name, hostId: 'local', workspacePath, processState: 'interrupted', status,
    semanticStatus: { ...status, stateEnteredAt: now - 10000 + ({ task3: 9000, task2: 8000, task1: 7000, task5: 5000, task4: 4000, task6: 3000, task7: 2000, task8: 1000, task9: 500 }[id] ?? 0) },
    control: { ...agent.control, hostId: 'local', agentSessionId: 'canonical-' + id, run: { runId: 'private-run-' + id } } }
}
const sessions = [actor('task1', 0, '管理面板安全远程访问'), actor('task2', 1, '核查 CPA 与 codexL 认证'), actor('task3', 0, '确认局域网访问边界'), actor('task4', 2, '研读 Personal Agent 参考架构'), actor('task5', null, '检查 Focus 与标准 Agent 菜单'), actor('task6', 3, '整理跨领域资料'), actor('task7', 4, '核对共用能力边界'), actor('task8', 5, '整理保留的原始研究'), actor('task9', 6, '继续原任务并保留分类缺口')]
const candidate = { ...config, workspaces: [scratch, project], focus: { recentActivityHours: 48, topicPresentation: 'cards', replyLines: 2 } }
mountThemeRuntime(window, candidate.appearance ?? {})
api.scratch.listTopics = async () => topics
api.workspaces.listBranches = async id => ({ kind: 'not-git-repository', workspaceId: id, branches: [] })
const controls = { stop: 0, resume: 0, write: 0, launchAgent: 0, interrupt: 0 }
const headingTransport = { clipboard: [], topicReads: [], topicWrites: [], appearanceReads: [], avatarWrites: [], iconWrites: [], reveals: [], terminalOpens: [], workspaceSelections: [] }
api.ui.writeClipboardText = async text => { headingTransport.clipboard.push(text) }
api.topics.call = async (method, params) => {
  if (method === 'topic.category.ls') { headingTransport.topicReads.push({ method, params }); return { categories: useAppStore.getState().topicCategories } }
  headingTransport.topicWrites.push({ method, params }); throw new Error('Category writes are outside this cancel-only Renderer scene')
}
api.spaceObjects.appearance = async target => { headingTransport.appearanceReads.push(target); return { local: true, icon: null } }
api.spaceObjects.saveAvatar = async (...args) => { headingTransport.avatarWrites.push(args); throw new Error('Avatar writes are outside this cancel-only Renderer scene') }
api.files.reveal = async (...args) => { headingTransport.reveals.push(args); throw new Error('No filesystem reveal is authorized in this scene') }
for (const name of Object.keys(controls)) api.sessions[name] = async () => { controls[name]++; throw new Error('Unexpected lifecycle/input in a layout-only Renderer scene') }
api.config.save = async (next, requestedBefore) => {
  const before = useAppStore.getState().config
  if (JSON.stringify(next.appearance?.spaceObjectIcons ?? {}) !== JSON.stringify(before.appearance?.spaceObjectIcons ?? {})) {
    const originalIcons = before.appearance?.spaceObjectIcons ?? {}, expected = { ...originalIcons, [categories[0].spaceId]: 'book' }
    const accepted = headingTransport.iconWrites.length === 0 && requestedBefore === before && JSON.stringify(next.appearance.spaceObjectIcons) === JSON.stringify(expected)
    headingTransport.iconWrites.push({ accepted, subject: { hostId: categories[0].hostId, categoryId: categories[0].categoryId, spaceId: categories[0].spaceId }, key: categories[0].spaceId,
      choice: next.appearance.spaceObjectIcons[categories[0].spaceId], before: originalIcons, after: next.appearance.spaceObjectIcons })
    if (!accepted) throw new Error('Only the declared private Category preset save is authorized in this Renderer scene')
    return next
  }
  useAppStore.setState({ config: next }); return next
}
const tab = { ...createWorkbenchTab('original-topic-tab', { kind: 'agent', phase: 'attached', regionId: 'original-topic-region', workspaceId: scratch.id, sessionId: 'task1' }), topicId: topics[0].id, space: { zoneId: homeZoneId(directoryIdentity('local', topics[0].directoryPath)), spaceId: categories[0].spaceId } }
useAppStore.setState({ loading: false, config: candidate, sessions, timelines: {}, agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])),
  tabs: { [tab.id]: tab }, layouts: { [scratch.id]: createWorkspaceLayout('original-group', [tab.id]), [project.id]: createWorkspaceLayout('project-group', []) }, activeWorkspaceId: project.id, mainSurface: 'agents',
  scratchTopicSnapshots: { [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics, error: null, reading: false } },
  spaceZoneBindings: bindings, topicCategories: categories, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } },
  agentComposerDrafts: { task1: '保留的原 Agent 草稿', task2: '另一份原草稿' }, error: null, lastError: null, errorDismissed: false })
useAppStore.setState({ localHome: fixturePath('private/focus-collection-preview/home'),
  selectWorkspace: async id => { headingTransport.workspaceSelections.push(id); throw new Error('No Project navigation is authorized in this scene') },
  launchTerminal: async id => { headingTransport.terminalOpens.push(id); throw new Error('No Terminal is authorized in this scene') } })
const original = useAppStore.getState(), selections = []
const headingInvokers = new Map()
const heading = id => document.querySelector(`button.focus-context[data-session-id="${id}"]`)?.closest('.focus-project-lanes__row')?.querySelector('.focus-project-lanes__axis')
let setView
function Scene() {
  const [view, viewSetter] = useState('board'); setView = viewSetter
  const preferences = useAppStore(state => state.config.focus)
  return h('main', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--text)' } },
    h('header', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', borderBottom: '1px solid var(--line)' } }, h('strong', {}, view === 'board' ? 'Focus' : 'Focus settings'), h('small', {}, 'Private Renderer verification')),
    h('div', { hidden: view !== 'board', style: { flex: 1, minHeight: 0, display: view === 'board' ? 'flex' : 'none' } }, h(GlobalFocusSurface, { visible: view === 'board', workspaceOpen: false, onSelectContext: id => selections.push(id) })),
    h('section', { 'data-settings-pane': true, hidden: view !== 'settings', style: { overflow: 'auto', flex: 1, minHeight: 0, padding: '12px', display: view === 'settings' ? 'block' : 'none' } }, h(FocusSettingsPane, { active: view === 'settings', preferences, onSave: saveFocusPreferences })))
}
createRoot(document.getElementById('root')).render(h(ExecutorIdentityContext.Provider, { value: { config: candidate } }, h(DesktopClientUiProvider, {}, h(Scene))))
window.collectionProof = {
  ready: true,
  mode(value) { useAppStore.setState(state => ({ config: { ...state.config, focus: { ...state.config.focus, topicPresentation: value } } })) },
  theme(value) { const result = updateThemeSelection({ ...candidate.appearance, appAppearance: value }); if (!result.applied) throw new Error(result.reason) },
  view(value) { setView(value) },
  metadataError(value) { useAppStore.setState({ topicCategories: categories.map((category, index) => index === 0 && value ? { ...category, readError: 'Private Category metadata read failed; the original binding is kept.' } : category) }) },
  rememberHeading(id) { const node = heading(id); if (!node) throw new Error('Missing original heading'); headingInvokers.set(id, node); node.focus(); return true },
  headingReturned(id) { const original = headingInvokers.get(id); return !!original?.isConnected && document.activeElement === original },
  headingFacts(id) { const node = heading(id); if (!node) throw new Error('Missing original heading'); return { text: node.textContent, collapsed: node.closest('.focus-project-lanes__row').getAttribute('data-collapsed'),
    cards: [...document.querySelectorAll('.global-focus-main button.focus-context[data-session-id]')].map(node => node.dataset.sessionId).sort(), projectFilter: !!document.querySelector('[aria-label="Remove Project filter"]') } },
  headingTargets() { return { category: { title: categories[0].title, link: formatSpaceAddress({ spaceId: categories[0].spaceId }), subject: { hostId: categories[0].hostId, categoryId: categories[0].categoryId, spaceId: categories[0].spaceId }, preset: 'book' },
    secondCategory: { title: categories[1].title, link: formatSpaceAddress({ spaceId: categories[1].spaceId }) }, projectPath: project.path } },
  facts() { const state = useAppStore.getState(); return { controls, selections, mode: state.config.focus.topicPresentation,
    headingTransport, spaceObjectIcons: state.spaceObjectIcons, configuredSpaceObjectIcons: state.config.appearance.spaceObjectIcons ?? {},
    sameSessions: state.sessions === original.sessions, sameTabs: state.tabs === original.tabs, sameLayouts: state.layouts === original.layouts,
    sameDrafts: state.agentComposerDrafts === original.agentComposerDrafts, sameFocus: state.agentFocus === original.agentFocus, sameIcons: state.spaceObjectIcons === original.spaceObjectIcons,
    cards: [...document.querySelectorAll('.global-focus-main button.focus-context[data-session-id]')].map(node => node.dataset.sessionId) } }
}
