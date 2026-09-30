import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { formatSessionAddress } from '../../../src/renderer/src/lib/agent-address'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { FocusContextRow } from '../../../src/renderer/src/components/FocusContextRow'
import { TransientErrorNotice } from '../../../src/renderer/src/components/TransientErrorNotice'
import '../../../src/renderer/src/styles/index.css'

// Maintained typed preview transport, original card/Store/menu/copy/error owners.
// No Runtime, actual PID, Native history producer or user application is represented.
const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const base = snapshot.sessions.find(session => session.kind === 'agent')
if (!base?.control.run.runId || !config.workspaces[0]) throw new Error('Nonempty typed preview Agent facts required')
const { pendingInteraction: _pending, ...agent } = base
const workspace = { ...config.workspaces[0], id: 'recap-proof', hostId: 'local', path: '/private/recap-proof', name: '连续阅读与信息设计' }
const now = Date.now(), response = '已经修复了滚动锚点，正在核对窄窗口正文与关闭按钮，原草稿及选区均保留。'
const prompt = '接下来检查加载：保留原请求和已有回复，不把上一轮摘录冒充新一轮结果。'
const message = (id, kind, content, time = now - 1000) => ({ id, agentSessionId: 'recap-a', kind, content, title: kind, status: 'complete', source: 'native-hook', createdAt: time, updatedAt: time })
const tool = { id: 'current-tool', agentSessionId: 'recap-a', kind: 'tool_call', title: 'Read', toolName: 'Read', toolInput: JSON.stringify({ file_path: workspace.path + '/src/components/scrolling/repair-anchor-and-preserve-long-chinese-target.tsx' }), status: 'streaming', source: 'native-hook', createdAt: now, updatedAt: now }
const ids = ['recap-a', 'recap-b', 'permission', 'failed', 'next-prompt', 'result', 'offline']
const sessions = ids.map((id, index) => ({ ...agent, id, label: index < 2 ? '同名 Agent · 保持原会话与连续阅读' : ['','','等待真实权限确认','失败说明保持直接可读','下一轮请求仍可区分','已完成的合法会话摘录','离线会话紧凑保留'][index], workspacePath: workspace.path,
  processState: index === 5 ? 'exited' : index === 6 ? 'interrupted' : 'running', status: { state: ['working','working','waiting_permission','error','done','done','disconnected'][index], source: 'native-hook', observedAt: now, ...(index === 3 ? { detail: 'History reader unavailable; original Run retained' } : index === 6 ? { detail: 'Disconnected · execution is unconfirmed' } : {}) },
  control: { ...base.control, agentSessionId: id, run: { ...base.control.run, runId: 'typed-recap-' + id } },
  ...(index === 2 ? { pendingInteraction: { id: 'permission-real-owner', kind: 'permission', title: 'Allow editing src/scroll-anchor.ts?', operation: 'edit' } } : {}) }))
const timelines = Object.fromEntries(ids.map(id => [id, { agentSessionId: id, revision: 3, items: id === 'recap-b' || id === 'offline' ? [] : id === 'next-prompt' ? [message('old-response', 'assistant_message', response), message('next-request', 'user_message', prompt, now)] : id === 'result' ? [message('finished-response', 'assistant_message', response)] : [message('request', 'user_message', prompt), message('response', 'assistant_message', response), tool] }]))
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
api.scratch.listTopics = async () => []
const reads = { historyPage: 0, timeline: 0, historySources: 0, topics: 0, appearance: 0 }, controls = { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 }
for (const key of ['historyPage','timeline','historySources']) { const original = api.sessions[key]; api.sessions[key] = (...args) => { reads[key]++; return original(...args) } }
for (const [port, key, count] of [[api.workspaces,'appearance','appearance'], [api.scratch,'listTopics','topics']]) { const original = port[key]; port[key] = (...args) => { reads[count]++; return original(...args) } }
for (const key of Object.keys(controls)) { const original = api.sessions[key]; api.sessions[key] = (...args) => { controls[key]++; return original(...args) } }
const clipboard = []; let denyClipboard = false
api.ui.writeClipboardText = async text => { clipboard.push(text); if (denyClipboard) throw new Error('Clipboard denied: private presentation probe') }
useAppStore.setState({ loading: false, config: { ...config, workspaces: [workspace] }, sessions, timelines, agentNames: Object.fromEntries(sessions.map(session => [session.id, session.label])), scratchTopicSnapshots: {}, tabs: {}, layouts: {}, activeWorkspaceId: workspace.id, mainSurface: 'agents', providerCatalog: [],
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { 'recap-b': '保留的原草稿：菜单只复制，不发送' }, error: null, lastError: null, errorDismissed: false })
const original = useAppStore.getState(), select = createFocusProjectionSelector(), contexts = select(original).contexts
const compact = contexts.find(context => context.id === 'offline')
if (!compact) throw new Error('Nonempty retained compact Context required')
function Probe() {
  const error = useAppStore(state => state.error), lastError = useAppStore(state => state.lastError), dismissed = useAppStore(state => state.errorDismissed)
  const [chosen, setChosen] = useState(null)
  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(GlobalFocusSurface)),
    h('aside', { 'aria-label': 'Same Session at another card occurrence', style: { display: 'flex', gap: '12px', padding: '8px', alignItems: 'center', flexWrap: 'wrap', background: 'var(--bg-2)' } },
      h('div', { style: { width: '160px' }, 'data-min-column': true }, h(FocusContextRow, { context: contexts.find(context => context.id === 'recap-a'), selected: false, onSelect: setChosen })),
      h('div', { style: { width: '160px' }, 'data-compact-column': true }, h(FocusContextRow, { context: compact, compact: true, selected: chosen === compact.id, onSelect: setChosen })),
      h('input', { 'aria-label': 'Later explicit input', defaultValue: original.agentComposerDrafts['recap-b'], style: { flex: 1, minWidth: '160px' } })),
    h(TransientErrorNotice, { error, lastError, dismissed, onDismiss: () => useAppStore.setState({ errorDismissed: true }), onReopen: () => useAppStore.setState({ errorDismissed: false }) }))
}
createRoot(document.getElementById('root')).render(h(Probe))
let nodes = [], draft
window.recapProof = {
  ready: true, response, prompt, population: ids, expectedSecondAddress: formatSessionAddress('recap-b'),
  remember() { nodes = [...document.querySelectorAll('.focus-context')]; draft = document.querySelector('[aria-label="Later explicit input"]'); draft.setSelectionRange(2,8) },
  denyClipboard(value) { denyClipboard = value },
  churn() { for (let index = 0; index < 200; index++) useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, latestOutputBytes: session.latestOutputBytes + 1, status: { ...session.status, observedAt: now + index + 1 } })) })) },
  facts() { const state = useAppStore.getState(); return { reads: { ...reads }, controls: { ...controls }, clipboard: [...clipboard], sameNodes: nodes.length > 0 && nodes.every(node => node.isConnected), originalFocus: state.agentFocus === original.agentFocus, originalDrafts: state.agentComposerDrafts === original.agentComposerDrafts, originalControls: state.sessions.every((session,index) => session.control === sessions[index].control), draft: draft?.value, range: [draft?.selectionStart, draft?.selectionEnd], error: state.error } }
}
