import { fixtureTime as _hygiene_fixtureTime } from "../../lib/fixture-values.mjs"
import '../goals-surface/entry'
import { flushSync } from 'react-dom'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../../../src/shared/scratch-topics'
import { goalCreationDraftKey, type GoalAgentCreationDraft } from '../../../src/renderer/src/lib/goal-agent-selection'
import { workspaceZoneId } from '../../../src/shared/space-addresses'
const state = useAppStore.getState(), config = state.config!, sessions = state.sessions.filter(session => session.kind === 'agent')
if (sessions.length < 2) throw new Error('The original App preview must contain two actual Agent projections.')
const scratch = config.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)!
const mote = await api.scratch.ensureMote(scratch.id, PMO_TEAMS_TOPIC_ID)
const agents = sessions.map((session,index) => ({ ...session, id: `collaboration-view-${index}`, label: index === 0 ? 'Rui · Requirements' : 'Mina · Implementation', control: { ...session.control, agentSessionId: `collaboration-session-${index}` } }))
const first = Object.values(state.demands)[0]!
const goal = { ...first, title: 'Keep the original work ready to continue', description: 'When I return, the same Agents, tabs and draft messages should still be here.\n\nA temporary Runtime outage should explain how to recover and preserve the original work.', sessionIds: agents.map(session=>session.control.agentSessionId), assigneeSessionIds: agents.map(session=>session.control.agentSessionId), supervisorSessionId: null, participations: [{ id:'accurate-source',operationId:'original-source',recordedAt:_hygiene_fixtureTime(24474400000),kind:'create' as const,agentSessionId:agents[0]!.control.agentSessionId,hostId:agents[0]!.hostId,entryPoint:'goal.create',mote:{workspaceId:scratch.id,topicId:mote.id,identityDirectoryPath:mote.physicalDirectoryPath ?? scratch.path}}], alignment: undefined, grounding: undefined }
// Only fixture data and original preview transport are controlled. The complete original App renders the product.
flushSync(()=>useAppStore.setState({ config, sessions: agents, demands: {[goal.id]:goal}, selectedDemandId:goal.id, agentNames:Object.fromEntries(agents.map(session=>[session.id,session.label])), scratchTopicSnapshots:{[scratch.id]:{scope:scratchTopicsScope(scratch),revision:1,topics:[mote],error:null,reading:false}} }))
api.demands.update=async(id,patch,_controlRequestId,expectedUpdatedAt)=>{
 const demand=useAppStore.getState().demands[id]!; if(expectedUpdatedAt!==undefined && expectedUpdatedAt!==demand.updatedAt)throw new Error('Original Goal version changed')
 const next={...demand,...patch,updatedAt:demand.updatedAt+1};return {demand:next as never,diskDurability:'confirmed'}
}
api.continuousProgress.goals=async()=>[]
let disposeAppearance=()=>{}
Object.assign(window,{collaborationProbe:{
 theme(mode:'light'|'dark'){disposeAppearance();disposeAppearance=applyAppAppearance(mode)},
 supervisor(enabled:boolean){flushSync(()=>useAppStore.setState(state=>({demands:{...state.demands,[goal.id]:{...state.demands[goal.id]!,supervisorSessionId:enabled?agents[0]!.control.agentSessionId:null}}})))},
 names(long:boolean){flushSync(()=>useAppStore.setState({agentNames:Object.fromEntries(agents.map((session,index)=>[session.id,long?index===0?'Rui Requirements · Original PMO conversation for preserving every Agent and draft message':'MinaImplementationConversationWithTheOriginalDurableSessionAndUnsentDraftRetained':session.label]))}))},
 changeVersion(){flushSync(()=>useAppStore.setState(state=>({demands:{...state.demands,[goal.id]:{...state.demands[goal.id]!,updatedAt:state.demands[goal.id]!.updatedAt+1}}})))},
 resetDrafts(){flushSync(()=>useAppStore.setState({goalAgentSelectionDrafts:{},goalAgentCreationDrafts:{}}))},
 retainedCreation(){
  const operationId='goal-agent-create-original-observer-unavailable',workspace=config.workspaces.find(workspace=>workspace.id!=='__scratch__'&&workspace.id!=='__notes__')!
  const original:GoalAgentCreationDraft={goalId:goal.id,role:'assignees',operationId,phase:'may-have-dispatched',request:{schemaVersion:5,requestId:operationId,operation:'agent.open',focus:false,content:{kind:'new-agent',executorId:Object.keys(config.executors)[0]!,executionWorkspaceId:workspace.id},destination:{spaceId:goal.projectId!,zoneId:workspaceZoneId(goal.projectId!,workspace.id),newTab:true}}}
  // A retained UI reference with no observed spatial receipt exercises the actual read-only inspector.
  // It does not claim that the preview created a Core Session or sent input.
  flushSync(()=>useAppStore.setState(state=>({goalAgentCreationDrafts:{[goalCreationDraftKey(goal.id,'assignees')]:original},demands:{...state.demands,[goal.id]:{...state.demands[goal.id]!,assigneeSessionIds:[...goal.assigneeSessionIds,'retained-session-with-unavailable-observation'],sessionIds:[...goal.sessionIds,'retained-session-with-unavailable-observation']}}})))
 },
 facts(){const s=useAppStore.getState();return {selected:s.selectedDemandId,goal:s.demands[goal.id],sessions:s.sessions.map(session=>session.control)}}
}})
