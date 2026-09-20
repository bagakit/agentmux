import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
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
function seed(mode = 'many') {
  const entries = mode === 'empty' ? [] : mode === 'one' ? [goals[0]!] : [...goals, finished]
  flushSync(() => useAppStore.setState({ initialize, config: initial.config, loading: false, mainSurface: 'board', sessions, demands: Object.fromEntries(entries.map((goal) => [goal.id, goal])), selectedDemandId: null, activeWorkspaceId: null, layouts: {}, tabs: {}, error: null, toolsOpen: true, projectRailOpen: true, leaderTopicVisible: false }))
}
seed()
createRoot(document.getElementById('root')!).render(<App />)
Object.assign(window, { goalsVisual: { seed, facts: () => ({ selected: useAppStore.getState().selectedDemandId, ids: Object.keys(useAppStore.getState().demands), runs: sessions.map((session) => session.control) }) } })
