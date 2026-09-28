import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'
import { EMPTY_AGENT_FOCUS } from '../../../src/renderer/src/lib/agent-focus'
import '../../../src/renderer/src/styles/index.css'
await useAppStore.getState().initialize()
const initial = useAppStore.getState()
const previewConfig = { ...initial.config!, workspaces: [...initial.config!.workspaces.map(workspace => ({ ...workspace, path: workspace.path.startsWith('/') ? workspace.path : `/preview/${workspace.path}` })), { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: '/preview/scratch', hostId: 'local', kind: 'folder' as const }] }
const project = previewConfig.workspaces[0]!
const sessions = initial.sessions.slice(0, 2).map(session => ({ ...session, workspacePath: session.workspacePath.startsWith('/') ? session.workspacePath : `/preview/${session.workspacePath}` }))
const intent = 'When I return to work, I want the same Agents, tabs, splits and draft messages to still be here.\n\nA temporary Runtime outage should tell me what is unavailable and how to recover. It must preserve a healthy Agent and the original work surface.\n\nI should not have to reconstruct the layout or figure out which Session is the original one.'
const titles = ['Keep every Agent where I left it', 'Make Goals easy to understand', 'Read terminal history without interruptions', 'Give results a clear trail of evidence', 'Clarify the next decision before execution', 'Keep the Browser in the original work surface']
const goals: DemandRecord[] = titles.map((title, i) => ({ id: `goal:visual-${i}`, title, description: i === 0 ? intent : `Improve ${title.toLowerCase()} without losing the current workspace or asking the user to fill unnecessary fields.`, status: ['in_progress', 'backlog', 'blocked', 'in_review', 'todo', 'in_progress'][i] as DemandRecord['status'], priority: 'normal', projectId: i === 4 ? null : project.id, projectName: i === 4 ? null : project.name, sessionIds: i === 0 ? sessions.map((session) => session.id) : [], tags: i === 0 ? ['recovery', 'workspace'] : [], createdAt: Date.now() - 86400000, updatedAt: Date.now() - i * 60000, source: 'default-topic' }))
const finished: DemandRecord = { ...goals[0]!, id: 'goal:old-done', title: 'A previous result awaiting verification', status: 'done', sessionIds: [] }
const initialize = async () => () => {}
const alignment = { summary: 'Return to the same work after restart, with the original Agents and layout intact.', criteria: [{ id: 'layout', text: 'The same tabs, groups and splits return without reconstruction.' }, { id: 'session', text: 'The original healthy Agent can resume with the unsent draft intact.' }], openQuestions: [], revision: 1, confirmedAt: null }
const grounding = { alignmentRevision: 1, summary: 'The original layout and Agent identity returned. Both success criteria were checked against the recovery log.', checks: [{ criterionId: 'layout', outcome: 'met' as const, evidence: ['artifacts/recovery/layout-check.log:18'], note: 'Tab and split identities match the saved work surface.' }, { criterionId: 'session', outcome: 'met' as 'met' | 'gap' | 'unknown', evidence: ['artifacts/recovery/session-check.log:42'], note: 'The same Session resumed and the draft text is unchanged.' }], submissionId: 'report:visual-1', acceptedAt: null }
function phase(mode: string): DemandRecord {
  if (mode === 'done-no-alignment') return { ...goals[0]!, status: 'done' }
  if (mode === 'no-alignment-report') return { ...goals[0]!, grounding }
  if (mode === 'delivery-failure') return goals[0]!
  const base = { ...goals[0]!, alignment: { ...alignment, confirmedAt: ['proposal', 'questions', 'receipt-failure', 'done-unconfirmed'].includes(mode) ? null : 1790960000000 } }
  if (['done-unconfirmed', 'done-confirmed'].includes(mode)) return { ...base, status: 'done' }
  if (mode === 'questions') return { ...base, alignment: { ...base.alignment, openQuestions: ['Should the Agent resume automatically, or wait for a click?'] } }
  if (['proposal', 'confirmed', 'receipt-failure'].includes(mode)) return base
  if (mode === 'stale') return { ...base, alignment: { ...base.alignment, revision: 2, criteria: [...alignment.criteria, { id: 'outage', text: 'A temporary Runtime outage preserves the current work surface.' }] }, grounding: { ...grounding, acceptedAt: 1790960000000 } }
  if (mode === 'gap' || mode === 'accepted-gaps') return { ...base, grounding: { ...grounding, checks: [grounding.checks[0]!, { ...grounding.checks[1]!, outcome: 'gap', note: 'The draft is intact. Automatic resume still needs one manual retry.' }], acceptedAt: mode === 'accepted-gaps' ? 1790960000000 : null } }
  if (mode === 'unknown') return { ...base, grounding: { ...grounding, checks: [grounding.checks[0]!, { ...grounding.checks[1]!, outcome: 'unknown', evidence: [], note: 'The Session is preserved; resume could not be observed during the outage.' }] } }
  return { ...base, grounding: { ...grounding, acceptedAt: mode === 'accepted' ? 1790960000000 : null } }
}
const confirm = api.demands.confirmAlignment
const ensureTopic = api.scratch.ensureTopic
const ensureMote = api.scratch.ensureMote
let finishPreparation: (() => Promise<void>) | undefined
let root: ReturnType<typeof createRoot> | undefined

function seed(mode = 'many') {
  const scenario = !['many', 'empty', 'one', 'current', 'recent', 'long-current'].includes(mode)
  const entries = mode === 'empty' ? [] : mode === 'one' ? [goals[0]!] : scenario ? [phase(mode), ...goals.slice(1), finished] : [...goals, finished]
  api.scratch.ensureTopic = mode === 'delivery-failure' ? async () => { throw new Error('The discussion service is unavailable. Your goal and current work are preserved.') } : ensureTopic
  api.demands.confirmAlignment = mode === 'receipt-failure' ? async () => { throw new Error('The current proposal changed in another window. Reload it before confirming.') } : confirm
  const config = mode === 'long-current' ? { ...previewConfig, workspaces: previewConfig.workspaces.map(workspace => workspace.id === project.id ? { ...workspace, name: '持续保留工作区与真实 Agent 状态的长期项目 / workspace-continuity-and-reliable-delivery' } : workspace) } : previewConfig
  flushSync(() => { useAppStore.setState({ initialize, config: mode === 'delivery-failure' ? { ...initial.config!, workspaces: [...initial.config!.workspaces.filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID), { ...project, id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: '/preview/scratch', kind: 'folder' }] } : config, loading: false, mainSurface: 'board', sessions, demands: Object.fromEntries(entries.map((goal) => [goal.id, goal])), selectedDemandId: scenario ? goals[0]!.id : null, activeWorkspaceId: ['current', 'long-current'].includes(mode) ? project.id : null,
    agentFocus: mode === 'recent' ? { execution: { sessionId: sessions[0]!.id, history: [{ sessionId: sessions[0]!.id, focusedAt: 1790960000000, identity: { name: sessions[0]!.label, kind: sessions[0]!.kind, providerId: sessions[0]!.providerId, hostId: project.hostId, workspacePath: project.path, project: { id: project.id, name: project.name } } }] }, pmo: { sessionId: null } } : EMPTY_AGENT_FOCUS,
    layouts: {}, tabs: {}, error: null, toolsOpen: true, projectRailOpen: true, leaderTopicVisible: false }); root?.render(<App key={mode} />) })
}
seed()
root = createRoot(document.getElementById('root')!); root.render(<App key="many" />)
Object.assign(window, { goalsVisual: { seed,
  appearance: (appAppearance: 'dark' | 'light') => { flushSync(() => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance } } }))) },
  project: () => useAppStore.getState().config!.workspaces.find(workspace => workspace.id === project.id),
  holdPreparation: () => { api.scratch.ensureMote = (workspace, id) => new Promise(resolve => { finishPreparation = async () => { resolve(await ensureMote(workspace, id)); api.scratch.ensureMote = ensureMote } }) },
  finishPreparation: async () => { await finishPreparation?.(); finishPreparation = undefined },
  facts: () => ({ selected: useAppStore.getState().selectedDemandId, ids: Object.keys(useAppStore.getState().demands), runs: useAppStore.getState().sessions.filter(session => sessions.some(original => original.id === session.id)).map(session => session.control) }) } })
