import '../goals-surface/entry'
import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { updateThemeSelection } from '@agentmux/client-ui/theme'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
const first = Object.values(useAppStore.getState().demands)[0]!
const decision = { id: 'original-decision', question: 'Which Agent should continue the current work?', decision: 'Continue in the original Agent Session.',
  rationale: 'The original Session contains the confirmed work and the unsent draft. Keep that context available while reviewing the next result.\n\nA delivery receipt confirms communication; it does not establish that the Goal has been accepted.',
  actorId: 'recorded-author', createdAt: fixtureEpoch(1) }
const goal = { ...first, id: 'decision-goal', title: 'Understand why the original work continues', description: 'Read the original decision and its recorded grounds without leaving this Goal.',
  sessionIds: [], decisions: [decision, { ...decision, id: 'unrecorded-reason', question: '', decision: 'Keep the unresolved question visible.', rationale: '', actorId: null, createdAt: fixtureEpoch(1, 1) }],
  activities: [{ id: decision.id, kind: 'note', message: 'The next result still needs review.', actorId: null, createdAt: fixtureEpoch(1, 2) }] }
flushSync(() => useAppStore.setState({ mainSurface: 'board', demands: { [goal.id]: goal }, selectedDemandId: goal.id }))
Object.assign(window, { referenceSurfaceFixture: {
  theme(mode: 'light' | 'dark') { flushSync(() => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: mode } } }))); updateThemeSelection({ appAppearance: mode }) },
  update() { flushSync(() => useAppStore.setState(state => ({ demands: { ...state.demands, [goal.id]: { ...state.demands[goal.id]!,
    activities: [...goal.activities, { ...goal.activities[0]!, id: 'new-activity', createdAt: fixtureEpoch(1, 3) }],
    decisions: goal.decisions.map(item => item.id === decision.id ? { ...item, decision: 'Continue the same original Agent after review.' } : item) } } }))) },
  switchGoal() { flushSync(() => useAppStore.setState({ demands: { another: { ...goal, id: 'another', title: 'Another Goal with an independent decision' } }, selectedDemandId: 'another' })) }
} })
