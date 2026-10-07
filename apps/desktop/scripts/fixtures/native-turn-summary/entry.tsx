import { fixtureEpoch as _newTailFixtureEpoch, fixturePath as _newTailFixturePath } from "../../../../../test/fixture-values.mjs"
import { createElement } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { metricsPage, responsePage } from '../../../../../packages/client-ui/test/fixtures/conversation-metrics'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const known = snapshot.sessions.find(session => session.id === 'session-codex')!
if (known.kind !== 'agent') throw new Error('Nonempty preview Agent required')
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: _newTailFixturePath('preview/topics'), name: 'Topics', kind: 'folder' as const }
const topicId = 'launcher:native-metrics', directoryPath = workspace.path + '/' + scratchTopicDirectoryName(topicId)
const topic = { id: topicId, title: '系统信息核对', summary: '查看原生耗时、输出和完整过程。', directoryPath,
  topicPath: directoryPath + '/topic.md', collaborators: [], soul: { path: directoryPath + '/SOUL.md', content: '# Identity', version: 'preview' } }
const session = { ...known, workspacePath: directoryPath, turnUsage: { scope: 'response' as const, inputTokens: 12, outputTokens: 127, totalTokens: 139,
  observedAt: _newTailFixtureEpoch(0, 0, 1), context: { usedTokens: 1000, capacityTokens: 10000 } } }
const single = { ...createWorkbenchTab('metrics-tab', { kind: 'agent', phase: 'attached', regionId: 'metrics-region', workspaceId: workspace.id, sessionId: session.id }), topicId }
const split = addWorkbenchRegion(single, 'metrics-region', 'right', { kind: 'agent', phase: 'attached', regionId: 'metrics-region-second', workspaceId: workspace.id, sessionId: session.id })
for (const name of ['listTopics', 'readTopic', 'ensureMote'] as const) (api.scratch as any)[name] = async () => name === 'listTopics' ? [topic] : topic
let page = { ...metricsPage(), agentSessionId: session.id, source: { providerId: session.providerId, nativeSessionId: 'metrics-native-preview' } }, changed: (() => void) | undefined
let reads = 0, observations = 0
api.sessions.historyPage = async () => { reads++; return page }
api.sessions.observeHistory = async (_control, onChange) => { observations++; changed = () => onChange({ kind: 'invalidated', agentSessionId: session.id, source: page.source });
  return { source: page.source, dispose() { observations-- } } }
const calls = { launchAgent: 0, stop: 0, resume: 0, write: 0 }
for (const name of Object.keys(calls) as (keyof typeof calls)[]) (api.sessions as any)[name] = async () => { calls[name]++; throw new Error('No execution is authorized in this preview') }
localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: false, targetTopicId: null, targetTabId: null }))
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [workspace], appearance: { ...config.appearance, appAppearance: 'dark' } },
  sessions: [session], activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: { [single.id]: single }, layouts: { [workspace.id]: createWorkspaceLayout('metrics-group', [single.id]) },
  toolsOpen: false, projectRailOpen: false, scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics: [topic], error: null, reading: false } },
  viewModes: { [session.id]: 'activity' }, timelines: { [session.id]: { agentSessionId: session.id, items: [], revision: 1 } }, agentComposerDrafts: { [session.id]: '保留的未发送草稿' },
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
createClientUiRoot(document.getElementById('root')!).render(createElement(App))

;(window as any).metricsProof = {
  ready: () => document.querySelector('.wf-head') && document.body.textContent?.includes('输出 127 tokens'),
  theme(appearance: 'dark' | 'light') { const state = useAppStore.getState(); state.setConfig({ ...state.config!, appearance: { ...state.config!.appearance, appAppearance: appearance } }) },
  split() { useAppStore.setState({ tabs: { [single.id]: split } }) },
  response() { page = { ...page, items: [...page.items, ...responsePage().items] }; changed?.() },
  responseActivities() { page = { ...page, items: [...page.items, ...['response-a', 'response-b'].map((id, index) => ({ id, kind: 'activity' as const,
    contentParts: [{ kind: 'text' as const, text: `Original response process ${index ? 'B' : 'A'}` }],
    metrics: { scope: 'response' as const, status: 'completed' as const, usage: { outputTokens: index + 2 } } }))] }; changed?.() },
  retainResponse() { const original = [...document.querySelectorAll<HTMLElement>('[data-native-record-id="response-b"]')].find(node => node.checkVisibility())!;
    const body = original.querySelector('.log-turn__body')!, text = body.querySelector('p')!.firstChild!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    (this as any).retained = { original, body, text, selected: selection.toString() }; return this.retentionFacts() },
  clipResponse() { page = { ...page, items: page.items.filter(item => item.id !== 'response-a') }; changed?.() },
  retentionFacts() { const saved = (this as any).retained;
    const original = [...document.querySelectorAll<HTMLElement>('[data-native-record-id="response-b"]')].find(node => node.checkVisibility());
    return saved ? { sameRecord: original === saved.original, sameBody: original?.querySelector('.log-turn__body') === saved.body, bodyConnected: saved.body.isConnected,
      sameRange: getSelection()?.anchorNode === saved.text, selection: getSelection()?.toString(), expected: saved.selected,
      expanded: original?.querySelector('[data-observation-step-id]')?.getAttribute('aria-expanded') } : null },
  facts() { return { reads, observations, calls: { ...calls }, runId: useAppStore.getState().sessions[0]?.control?.run?.runId,
    heads: [...document.querySelectorAll<HTMLButtonElement>('.wf-head')].filter(node => node.checkVisibility()).map(node => ({ text: node.textContent, expanded: node.getAttribute('aria-expanded') })),
    drafts: [...document.querySelectorAll<HTMLElement>('.ProseMirror')].filter(node => node.checkVisibility()).map(node => node.textContent),
    regions: [...document.querySelectorAll<HTMLElement>('.agent-surface')].filter(node => node.checkVisibility()).map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }) } }
}
