import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from '../../../src/renderer/src/App'
import { projectLinksPreview } from './project-links'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'
import { EMPTY_AGENT_FOCUS } from '../../../src/renderer/src/lib/agent-focus'
import { directGoalRequest } from '../../../src/renderer/src/lib/goals-direct-pmo'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { projectWorkspaces } from '../../../src/renderer/src/lib/workspace-projects'
import { applyConfigEdit } from '../../../src/shared/config-edit'
import type { ComposerShortcut, GoalsCommonActionRef } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
await useAppStore.getState().initialize()
const initial = useAppStore.getState()
const previewConfig = { ...initial.config!, workspaces: [...initial.config!.workspaces.map(workspace => ({ ...workspace, path: workspace.path.startsWith('/') ? workspace.path : `/preview/${workspace.path}` })), { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: '/preview/scratch', hostId: 'local', kind: 'folder' as const }] }
const projectWorkspace = previewConfig.workspaces[0]!
const project = projectWorkspaces([projectWorkspace])[0]!
if (project.id === projectWorkspace.id) throw new Error('Maturity fixture must distinguish Project and Workspace identities')
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
const createGoal = api.demands.create, readGoals = api.demands.list, updateGoal = api.demands.update, launchGoalPmo = api.sessions.launchAgent
let directFailure: 'save-unknown' | 'pmo' | null = null
let directCreates: string[] = [], directLaunches: { prompt: string; topicId?: string }[] = []
function seedDirect(mode?: 'save-unknown' | 'pmo') {
  if (directGoalRequest()) throw new Error('Settle the previous actual direct Goal operation before reseeding')
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false }); seed('empty'); directFailure = mode ?? null; directCreates = []; directLaunches = []
  api.demands.create = async input => { directCreates.push(input.id!); const saved = await createGoal(input); if (directFailure === 'save-unknown') throw new Error('目标已交给保存服务，但回执尚未收到。请读取同一个目标确认。'); return saved }
  // Preview native transport mirrors the durable alignment receipt shape; real filesystem and Main proofs stay in owning/native tests.
  api.demands.update = async (id, patch) => { const receipt = await updateGoal(id, patch); if (patch.alignment) receipt.demand.alignment = { ...patch.alignment, revision: (useAppStore.getState().demands[id]?.alignment?.revision ?? 0) + 1, confirmedAt: null }; return receipt }
  api.demands.list = async () => { if (directFailure === 'save-unknown') throw new Error('保存服务暂时无法读取。请求 ID 已保留，请稍后重新读取。'); return readGoals() }
  api.sessions.launchAgent = async input => { directLaunches.push({ prompt: input.prompt ?? '', ...(input.scratchTopicId ? { topicId: input.scratchTopicId } : {}) }); if (directFailure === 'pmo') throw new Error('专属 Agent 的启动回执尚未确认。此目标和原启动区保留，请重试。'); return launchGoalPmo(input) }
}
function directFacts() {
  const state = useAppStore.getState(), id = state.selectedDemandId ?? directGoalRequest()?.id, goal = id ? state.demands[id] : undefined
  const tabId = id ? state.demandPmoTabIds[id] : undefined, tab = tabId ? state.tabs[tabId] : undefined
  return { request: directGoalRequest(), goal, tabId, tabName: tab?.name, appearance: state.config?.appearance.appAppearance, regionId: tab?.layout.activeRegionId, surface: tab?.regions[tab.layout.activeRegionId], topicId: tab?.topicId,
    draft: tab ? state.agentComposerDrafts[tab.layout.activeRegionId] : undefined, creates: [...directCreates], launches: [...directLaunches], floating: readPmoTeamsTopicFloatingState(), pmoTopic: PMO_TEAMS_TOPIC_ID }
}
let finishPreparation: (() => Promise<void>) | undefined
let root: ReturnType<typeof createRoot> | undefined
let configSaveFailure = false
let configSaveHold: Promise<void> | null = null
let releaseConfigSave: (() => void) | undefined
const commonPrompts: ComposerShortcut[] = [
  { id: 'common-review', label: '检查当前改动', keyword: 'common-review', body: '帮我检查当前改动，指出具体风险并建议一个最小验证。', providerId: 'codex' },
  { id: 'common-notes', label: '整理工作笔记', keyword: 'common-notes', body: '读这周的工作笔记，区分已有依据的结论和未知，再建议一次最小检查。' },
  { id: 'common-explain', label: '解释清楚', keyword: 'common-explain', body: '把当前说明改成普通人能理解的短文，并保留必要事实。' },
  { id: 'common-plan', label: '准备下次尝试', keyword: 'common-plan', body: '根据已知结果，给出一个可以动手验证的小尝试，说明该观察什么。' }
]

function seedCommon(mode = 'empty') {
  seed(mode === 'empty' ? 'empty' : mode === 'project' ? 'recent' : mode === 'long-project' ? 'long-current' : 'many')
  configSaveFailure = false
  const base = useAppStore.getState().config!
  let composerShortcuts = structuredClone(commonPrompts)
  let items: GoalsCommonActionRef[] | undefined
  if (['many', 'long', 'long-project'].includes(mode)) items = [{ kind: 'prompt', id: commonPrompts[0]!.id }, { kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'next' }, ...commonPrompts.slice(1).map(prompt => ({ kind: 'prompt' as const, id: prompt.id }))]
  if (['long', 'long-project'].includes(mode)) composerShortcuts = [{ ...commonPrompts[0]!, body: Array.from({ length: 9 }, (_, index) => `${index + 1}. 阅读当前记录，保留原始事实、仍未确认的问题，以及每个结论的出处。下一次只执行最小验证，不编造已完成结果。`).join('\n') }, ...commonPrompts.slice(1)]
  if (mode === 'unavailable') { composerShortcuts = [{ ...commonPrompts[0]!, providerId: 'unconfigured-provider' }]; items = [{ kind: 'prompt', id: commonPrompts[0]!.id }, { kind: 'builtin', id: 'ideas' }] }
  if (mode === 'explicit-empty') items = []
  flushSync(() => {
    useAppStore.setState({ config: { ...base, composerShortcuts, ...(items ? { goalsCommonActions: { items, collapsed: false } } : {}) }, selectedDemandId: null })
    root?.render(<App key={`common-${mode}`} />)
  })
}
// Private preview owner: the actual Renderer uses the original expected/conflict merge.
// Durable ConfigStore, native launch and initial CLI delivery are verified by the owning tests.
api.config.save = async (next, expected) => {
  if (configSaveHold) await configSaveHold
  if (configSaveFailure) throw new Error('保存服务暂时不可用。正文草稿和原目录已保留。')
  return applyConfigEdit(useAppStore.getState().config!, expected, next)
}

function seed(mode = 'many') {
  const scenario = !['many', 'empty', 'one', 'current', 'recent', 'long-current'].includes(mode)
  const entries = mode === 'empty' ? [] : mode === 'one' ? [goals[0]!] : scenario ? [phase(mode), ...goals.slice(1), finished] : [...goals, finished]
  api.scratch.ensureTopic = mode === 'delivery-failure' ? async () => { throw new Error('The discussion service is unavailable. Your goal and current work are preserved.') } : ensureTopic
  api.demands.confirmAlignment = mode === 'receipt-failure' ? async () => { throw new Error('The current proposal changed in another window. Reload it before confirming.') } : confirm
  const config = mode === 'long-current' ? { ...previewConfig, workspaces: previewConfig.workspaces.map(workspace => workspace.id === projectWorkspace.id ? { ...workspace, name: '持续保留工作区与真实 Agent 状态的长期项目 / workspace-continuity-and-reliable-delivery' } : workspace) } : previewConfig
  flushSync(() => { useAppStore.setState({ initialize, config: mode === 'delivery-failure' ? { ...initial.config!, workspaces: [...initial.config!.workspaces.filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID), { ...projectWorkspace, id: SCRATCH_WORKSPACE_ID, name: 'Scratch', path: '/preview/scratch', kind: 'folder' }] } : config, loading: false, mainSurface: 'board', sessions, demands: Object.fromEntries(entries.map((goal) => [goal.id, goal])), selectedDemandId: scenario ? goals[0]!.id : null, activeWorkspaceId: ['current', 'long-current'].includes(mode) ? projectWorkspace.id : null,
    agentFocus: mode === 'recent' ? { execution: { sessionId: sessions[0]!.id, history: [{ sessionId: sessions[0]!.id, focusedAt: 1790960000000, identity: { name: sessions[0]!.label, kind: sessions[0]!.kind, providerId: sessions[0]!.providerId, hostId: project.hostId, workspacePath: projectWorkspace.path, project: { id: projectWorkspace.id, name: projectWorkspace.name } } }] }, pmo: { sessionId: null } } : EMPTY_AGENT_FOCUS,
    layouts: {}, tabs: {}, error: null, toolsOpen: true, projectRailOpen: true, leaderTopicVisible: false }); root?.render(<App key={mode} />) })
}
seed()
root = createRoot(document.getElementById('root')!); root.render(<App key="many" />)
Object.assign(window, { goalsVisual: { seed,
  seedDirect, directFacts, restoreDirectService: () => { directFailure = null },
  proposeDirectGoal: async () => { const id = useAppStore.getState().selectedDemandId; if (!id) throw new Error('No actual Goal selected'); await useAppStore.getState().updateDemand(id, { title: '让我从一个小项目开始了解 Agent', alignment: { summary: '先找到一个我愿意尝试的小项目，再判断下一步。', criteria: [{ id: 'first-try', text: '完成一次小尝试，并能说清楚想继续探索什么。' }], openQuestions: [] } }) },
  seedMaturity: () => {
    seed('many')
    const variants = [goals[0]!, phase('questions'), phase('proposal'), phase('confirmed'), phase('results'), phase('unknown')]
    const mixed = variants.map((entry, index) => ({ ...entry, id: goals[index]!.id, title: goals[index]!.title, description: goals[index]!.description, sessionIds: index === 0 ? goals[0]!.sessionIds : [] }))
    flushSync(() => { useAppStore.setState({ demands: Object.fromEntries(mixed.map(entry => [entry.id, entry])), selectedDemandId: null }); root?.render(<App key="maturity-mixed" />) })
  },
  seedCommon,
  holdConfigSave: () => { configSaveHold = new Promise(resolve => { releaseConfigSave = resolve }) },
  finishConfigSave: (fail: boolean) => { configSaveFailure = fail; releaseConfigSave?.(); releaseConfigSave = undefined; configSaveHold = null },
  failConfigSave: (fail: boolean) => { configSaveFailure = fail },
  externalPromptBody: (id: string, body: string) => { flushSync(() => useAppStore.setState(state => ({ config: { ...state.config!, composerShortcuts: state.config!.composerShortcuts!.map(prompt => prompt.id === id ? { ...prompt, body } : prompt) } }))) },
  appearance: (appAppearance: 'dark' | 'light') => { flushSync(() => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance } } }))) },
  project: () => useAppStore.getState().config!.workspaces.find(workspace => workspace.id === projectWorkspace.id),
  holdPreparation: () => { api.scratch.ensureMote = (workspace, id) => new Promise(resolve => { finishPreparation = async () => { resolve(await ensureMote(workspace, id)); api.scratch.ensureMote = ensureMote } }) },
  finishPreparation: async () => { await finishPreparation?.(); finishPreparation = undefined },
  facts: () => { const state = useAppStore.getState(), entries = Object.values(state.demands); return { selected: state.selectedDemandId, ids: Object.keys(state.demands), criteria: entries.reduce((count, goal) => count + (goal.alignment?.criteria.length ?? 0), 0), reports: entries.filter(goal => goal.grounding).length, checks: entries.reduce((count, goal) => count + (goal.grounding?.checks.length ?? 0), 0), runs: state.sessions.filter(session => sessions.some(original => original.id === session.id)).map(session => session.control) } } } })

Object.assign(window, { goalsProjectLinks: projectLinksPreview(initial, mode => root?.render(<App key={`project-links-${mode}`} />)) })
