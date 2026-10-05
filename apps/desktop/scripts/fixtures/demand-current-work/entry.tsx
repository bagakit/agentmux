import { fixtureTime as _hygiene_fixtureTime } from "../../lib/fixture-values.mjs"
import '../goals-surface/entry'
import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import type { DemandDispatch } from '@agentmux/demand'

const visual = (window as unknown as { goalsProjectLinks: { seed(mode: 'local'): void } }).goalsProjectLinks
visual.seed('local')
const original = useAppStore.getState(), source = original.sessions.find(session => session.id === 'links-pmo')!
if (source.kind !== 'agent') throw new Error('Full App requires the original Agent Region fixture.')
const canonical = 'current-demand-canonical', goal = original.demands['links-goal']!, draft = 'Keep this exact unsent draft in the original Region.'
const dispatch: DemandDispatch = { operationId: 'visual-original-start', agentSessionId: canonical, hostId: source.hostId,
  runId: source.control.run.runId, execution: 'finite', prompt: 'Make the original work recoverable.', stage: 'confirmed',
  preparedAt: _hygiene_fixtureTime(24474400000), submittedAt: _hygiene_fixtureTime(24474400001), receipt: { kind: 'core-prompt', itemId: 'prompt:visual-original-start', createdAt: _hygiene_fixtureTime(24474400002) } }
let disposeAppearance = () => {}
function seed(mode: 'current' | 'long' | 'ambiguous' | 'unknown' | 'history-only') {
  const title = mode === 'long' ? 'Preserve every original Agent, worktree and unsent draft while reconnecting the same work after an observation outage' : 'Keep the original work ready to continue'
  const primary = { ...goal, title, dispatches: mode === 'history-only' ? [] : [dispatch], sessionIds: [canonical] }
  const secondary = { ...goal, id: 'current-second-goal', title: 'Read the original terminal history without losing the current place', dispatches: [{ ...dispatch, operationId: 'visual-second-start', ...(mode === 'unknown' ? { stage: 'unknown' as const, receipt: undefined, issue: 'Original input receipt was not observed.' } : { receipt: { ...dispatch.receipt!, itemId: 'prompt:visual-second-start' } }) }] }
  flushSync(() => useAppStore.setState({ mainSurface: 'workbench', activeWorkspaceId: original.activeWorkspaceId,
    selectedDemandId: null, sessions: original.sessions.map(session => session.id === source.id ? { ...session, control: { ...source.control, agentSessionId: canonical } } : session),
    agentNames: { ...original.agentNames, [source.id]: 'Original Agent' }, agentComposerDrafts: { ...original.agentComposerDrafts, [source.id]: draft },
    timelines: { ...original.timelines, [source.id]: { agentSessionId: canonical, revision: 1, items: [] } },
    demands: { [goal.id]: primary, ...(['ambiguous', 'unknown'].includes(mode) ? { [secondary.id]: secondary } : {}) } }))
}
seed('current')
Object.assign(window, { currentDemandProbe: {
  seed, theme(mode: 'light' | 'dark') { disposeAppearance(); disposeAppearance = applyAppAppearance(mode) },
  facts() { const state = useAppStore.getState(); return { selected: state.selectedDemandId, draft: state.agentComposerDrafts[source.id],
    sourceId: source.id, canonical, control: state.sessions.find(session => session.id === source.id)?.control,
    tabs: state.tabs, layouts: state.layouts, goals: state.demands } }
} })
