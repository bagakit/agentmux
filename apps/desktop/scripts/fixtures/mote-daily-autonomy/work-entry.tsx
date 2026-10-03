import '../mote-companion-workflows/persona-entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import type { Demand } from '@agentmux/demand'
import type { ContinuousProgressLoop } from '@agentmux/core'
import type { SessionSnapshot } from '../../../src/shared/contracts'
let records: Demand[] = [], loops: Record<string, ContinuousProgressLoop[]> = {}, readUnknown = false
const alignment = { revision: 1, confirmedAt: 1, summary: 'Compare a small experiment before expanding the project.', criteria: [{ id: 'result', text: 'One inspectable comparison with evidence.' }], openQuestions: [] }
api.demands.list = async () => { if (readUnknown) throw new Error('Original Goal storage is temporarily unavailable.'); return records }
api.continuousProgress.goals = async id => loops[id] ?? []
Object.assign(window, { moteWorkScenario: (kind: 'empty' | 'work' | 'multiple' | 'partial' | 'unknown') => {
 readUnknown = kind === 'unknown'
 const state = useAppStore.getState(), workspace = state.config!.workspaces[0]!, root = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
 const spaceId = directoryIdentity(workspace.hostId, workspace.path + '/' + root), zoneId = homeZoneId(spaceId)
 const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: 'work-discussion', kind: 'agent', hostId: workspace.hostId, providerId: 'fixture', executorId: 'fixture',
  workspacePath: workspace.path + '/' + root, label: 'Original project discussion', createdAt: 1, updatedAt: 2, agentSessionUpdatedAt: 2, processState: 'running', latestOutputBytes: 0,
  status: { state: 'waiting', source: 'native-hook', observedAt: 2 }, capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: workspace.hostId, agentSessionId: 'work-discussion', run: { runId: 'private-renderer-reference' } } }
 const tab = { ...createWorkbenchTab('work-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'work-region', sessionId: session.id }), topicId: PMO_TEAMS_TOPIC_ID, space: { spaceId, zoneId } }
 const goal = (id: string, title: string): Demand => ({ id, title, description: alignment.summary, status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
  executorId: null, tags: [], plannedStartAt: null, targetAt: null, parentDemandId: null, phaseIndex: null, sessionIds: [session.id], activities: [{ id: 'activity', kind: 'work', message: 'The first comparison is saved. Check the remaining case next.', createdAt: 20, actorId: session.id }], decisions: [], createdAt: 10, updatedAt: 20, alignment })
 records = kind === 'empty' ? [] : [goal('compare', 'Compare one small experiment')]
 if (kind === 'multiple') records.push(goal('review', 'Review the remaining design choice'))
 if (kind === 'partial') records[0]!.grounding = { alignmentRevision: 1, submissionId: 'partial-report', acceptedAt: null, summary: 'The first result is saved; one check is still unknown.', checks: [{ criterionId: 'result', outcome: 'unknown', evidence: [root + '/comparison.md'], note: 'The second case has not been verified.' }] }
 loops = { compare: [{ loopId: 'original-continuation', hostId: workspace.hostId, agentSessionId: session.id, providerId: session.providerId, workspacePath: session.workspacePath,
  revision: 1, creationOperationId: 'original-start', taskSource: { kind: 'goal', goalId: 'compare', alignmentRevision: 1 }, intervalMs: 1800000, prompt: 'Continue the confirmed goal.', nextCheckAt: Date.now() + 1800000, status: kind === 'unknown' ? 'paused' : 'active',
  lastDecision: kind === 'unknown' ? 'Observation is unconfirmed. Original Agent and input are retained.' : 'The first comparison is saved; waiting for the next check.' }] }
 useAppStore.setState({ sessions: kind === 'empty' ? [] : [session], tabs: { ...state.tabs, [tab.id]: tab }, demands: Object.fromEntries(records.map(record => [record.id, { ...record, source: 'session' as const }])),
  layouts: { ...state.layouts, [workspace.id]: { ...state.layouts[workspace.id]!, groups: state.layouts[workspace.id]!.groups.map(group => ({ ...group, tabOrder: [...new Set([...group.tabOrder, tab.id])] })) } } })
} })
