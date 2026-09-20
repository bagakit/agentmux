import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import type { DemandRecord } from '../../../src/renderer/src/lib/global-demand-board'
import '../../../src/renderer/src/styles/index.css'
await useAppStore.getState().initialize()
const initial = useAppStore.getState()
const project = initial.config!.workspaces[0]!
const sessions = initial.sessions.slice(0, 2)
const intent = 'When I return to work, I want the same Agents, tabs, splits and draft messages to still be here.\n\nA temporary Runtime outage should tell me what is unavailable and how to recover. It must preserve a healthy Agent and the original work surface.\n\nI should not have to reconstruct the layout or figure out which Session is the original one.'
const titles = ['Keep every Agent where I left it', 'Make Goals easy to understand', 'Read terminal history without interruptions', 'Give results a clear trail of evidence', 'Clarify the next decision before execution', 'Keep the Browser in the original work surface']
const goals: DemandRecord[] = titles.map((title, i) => ({ id: `goal:visual-${i}`, title, description: i === 0 ? intent : `Improve ${title.toLowerCase()} without losing the current workspace or asking the user to fill unnecessary fields.`, status: ['in_progress', 'backlog', 'blocked', 'in_review', 'todo', 'in_progress'][i] as DemandRecord['status'], priority: 'normal', projectId: i === 4 ? null : project.id, projectName: i === 4 ? null : project.name, sessionIds: i === 0 ? sessions.map((session) => session.id) : [], tags: i === 0 ? ['recovery', 'workspace'] : [], createdAt: Date.now() - 86400000, updatedAt: Date.now() - i * 60000, source: 'default-topic' }))
const finished: DemandRecord = { ...goals[0]!, id: 'goal:old-done', title: 'A previous result awaiting verification', status: 'done', sessionIds: [] }
const initialize = async () => () => {}
const alignment = { summary: 'Return to the same work after restart, with the original Agents and layout intact.', criteria: [{ id: 'layout', text: 'The same tabs, groups and splits return without reconstruction.' }, { id: 'session', text: 'The original healthy Agent can resume with the unsent draft intact.' }], openQuestions: [], revision: 1, confirmedAt: null }
const grounding = { alignmentRevision: 1, summary: 'The original layout and Agent identity returned. Both success criteria were checked against the recovery log.', checks: [{ criterionId: 'layout', outcome: 'met' as const, evidence: ['artifacts/recovery/layout-check.log:18'], note: 'Tab and split identities match the saved work surface.' }, { criterionId: 'session', outcome: 'met' as 'met' | 'gap' | 'unknown', evidence: ['artifacts/recovery/session-check.log:42'], note: 'The same Session resumed and the draft text is unchanged.' }], submissionId: 'report:visual-1', acceptedAt: null }
function phase(mode: string): DemandRecord {
  const base = { ...goals[0]!, alignment: { ...alignment, confirmedAt: ['proposal', 'questions', 'receipt-failure'].includes(mode) ? null : 1790960000000 } }
  if (mode === 'questions') return { ...base, alignment: { ...base.alignment, openQuestions: ['Should the Agent resume automatically, or wait for a click?'] } }
  if (['proposal', 'confirmed', 'receipt-failure'].includes(mode)) return base
  if (mode === 'stale') return { ...base, alignment: { ...base.alignment, revision: 2, criteria: [...alignment.criteria, { id: 'outage', text: 'A temporary Runtime outage preserves the current work surface.' }] }, grounding: { ...grounding, acceptedAt: 1790960000000 } }
  if (mode === 'gap' || mode === 'accepted-gaps') return { ...base, grounding: { ...grounding, checks: [grounding.checks[0]!, { ...grounding.checks[1]!, outcome: 'gap', note: 'The draft is intact. Automatic resume still needs one manual retry.' }], acceptedAt: mode === 'accepted-gaps' ? 1790960000000 : null } }
  if (mode === 'unknown') return { ...base, grounding: { ...grounding, checks: [grounding.checks[0]!, { ...grounding.checks[1]!, outcome: 'unknown', evidence: [], note: 'The Session is preserved; resume could not be observed during the outage.' }] } }
  return { ...base, grounding: { ...grounding, acceptedAt: mode === 'accepted' ? 1790960000000 : null } }
}
const confirm = api.demands.confirmAlignment

function seed(mode = 'many') {
  const scenario = !['many', 'empty', 'one'].includes(mode)
  const entries = mode === 'empty' ? [] : mode === 'one' ? [goals[0]!] : scenario ? [phase(mode), ...goals.slice(1), finished] : [...goals, finished]
  api.demands.confirmAlignment = mode === 'receipt-failure' ? async () => { throw new Error('The current proposal changed in another window. Reload it before confirming.') } : confirm
  flushSync(() => useAppStore.setState({ initialize, config: initial.config, loading: false, mainSurface: 'board', sessions, demands: Object.fromEntries(entries.map((goal) => [goal.id, goal])), selectedDemandId: scenario ? goals[0]!.id : null, activeWorkspaceId: null, layouts: {}, tabs: {}, error: null, toolsOpen: true, projectRailOpen: true, leaderTopicVisible: false }))
}
seed()
createRoot(document.getElementById('root')!).render(<App />)
Object.assign(window, { goalsVisual: { seed, facts: () => ({ selected: useAppStore.getState().selectedDemandId, ids: Object.keys(useAppStore.getState().demands), runs: sessions.map((session) => session.control) }) } })
