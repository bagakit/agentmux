import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openDemandStore } from '../../../../packages/demand/src/index.ts'
import { AgentMuxSpatialStateStore, assertAgentInputEpoch } from '../../src/index.ts'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../src/spatial-layout.ts'
import { createHostGoalDiscussions } from '../../../../apps/host/src/goal-discussions.ts'
import { contributeGoalDiscussionBinding } from '../../../../apps/host/src/goal-discussion-bindings.ts'
import { goalFiniteInputPort } from '../../../../apps/host/src/goal-finite-runtime.ts'
import { GoalDispatchInputOwner } from '../../../../apps/host/src/goal-dispatch-input.ts'
const root=process.env.AGENTMUX_GOAL_CUT_ROOT;assert.ok(root)
await mkdir(root,{recursive:true})
const demands=openDemandStore({root:join(root,'goals')}),spatial=new AgentMuxSpatialStateStore(join(root,'graph.json'))
const { demand: goal } = await demands.create({title:'Original Goal',description:'Original task'},{operationId:'goal-create',creationOrigin:{requesterAsSupervisor:false,inputEpoch:'E1',inputRuntimeId:'original-runtime'}})
await spatial.commit({expectedRevision:0,graph:{spaces:[{spaceId:'space',kind:'mote',topicId:'topic',hostId:'local',name:'Original',directoryPath:root,projectId:null}],zones:[{zoneId:'zone',kind:'home',hostId:'local',workspaceId:'workspace',directoryPath:root,branch:null}],bindings:[{spaceId:'space',zoneId:'zone'}],tabs:[{tabId:'tab',zoneId:'zone',workspaceId:'workspace',name:'Original',regionIds:['region']}],regions:[{tabId:'tab',regionId:'region',kind:'agent',agentSessionId:'sid',runId:'run',execution:{hostId:'local',cwd:root}}],layouts:{workspace:createWorkspaceLayout('group',['tab'])},tabLayouts:{tab:createWorkbenchViewLayout('region')},resources:{}}})
await contributeGoalDiscussionBinding({spatial,goalId:goal.id,binding:{schema:'agentmux.goal-discussion-binding.v1',tabId:'tab',regionId:'region',recipient:{kind:'agent',hostId:'local',agentSessionId:'sid'}}})
let epoch='E1',namespaceReads=0,accepted=0;const claims=new Map(),seen=[]
const session=()=>({kind:'agent',hostId:'local',agentSessionId:'sid',providerId:'proof',executorId:'proof',workspacePath:root,run:{runId:'run'},retiredRuns:[],inputEpoch:epoch,createdAt:1,updatedAt:1})
const runtime={readInputEpoch:async host=>{assert.equal(host,'local');namespaceReads++;return epoch},observeGoalAgent:async()=>({session:session()}),agentCreation:async()=>session(),inspectGoalAttention:async input=>claims.get(input.operationId)??null,
 submitPrompt:async(control,prompt,operationId,condition,_automation,_choice,_human,note)=>{seen.push({operationId,...condition});assertAgentInputEpoch({inputEpoch:epoch},condition);accepted++;claims.set(operationId,{run:control.run,admission:{acknowledged:true,intent:{message:{userContent:prompt}}}})}}
const owner=createHostGoalDiscussions({configurationPath:'/not-read',demands,spatial,runtime,call:async()=>assert.fail('no new Source creation or message route'),confirmParticipation:async()=>{}})
const request={schemaVersion:1,operation:'demand.discuss',requestId:'first-input',demandId:goal.id,mode:'grill'}
await assert.doesNotReject(()=>owner.execute(request,{principal:{kind:'user',id:'person'}}),'fresh discussion first request remains usable')
const frozen=(await demands.get(goal.id)).discussionInputs[0]
assert.equal(frozen.inputEpoch,'E1','original discussion input cut is retained')
assert.equal(namespaceReads,1);assert.equal(accepted,1)
epoch='E2';claims.clear()
await assert.rejects(()=>owner.execute(request,{principal:{kind:'user',id:'person'}}),error=>error.code==='AGENT_PROMPT_INPUT_UNCONFIRMED','old discussion request must reach its old input authority without renewal')
assert.equal(seen.at(-1).inputEpoch,'E1','old original consumer retains E1 after cut')
assert.equal(namespaceReads,1,'retained discussion never reads a new input grant');assert.equal(accepted,1)
await owner.execute({...request,requestId:'new-independent-input'},{principal:{kind:'user',id:'person'}})
assert.equal(accepted,2,'fresh independent discussion remains usable');assert.equal(namespaceReads,2)
const reopened=openDemandStore({root:join(root,'goals')});assert.deepEqual((await reopened.get(goal.id)).discussionInputs[0],frozen,'original disk record survives independent owner reopen')
await demands.prepareDispatch(goal.id,{operationId:'finite',agentSessionId:'sid',hostId:'local',runId:'run',execution:'finite',prompt:'Original task',inputEpoch:'E2'})
const dispatch=new GoalDispatchInputOwner(demands,{sessionTimeline:async()=>({agentSessionId:'sid',items:[]})})
await assert.rejects(()=>dispatch.submit({goalId:goal.id,operationId:'finite',inputEpoch:'E1'},{kind:'agent',hostId:'local',agentSessionId:'sid',run:{runId:'run'}},'finite','Original task',async()=>{}),error=>error.code==='CONTROL_REQUEST_CONFLICT','different original Goal input cut must refuse before submission')
let finite
const reference={kind:'space-member',source:{runtimeId:'source',spaceId:'space',regionId:'region',admission:{kind:'creation',operationId:'cid'}},execution:{runtimeId:'original-runtime',agentSessionId:'sid'}}
const port=goalFiniteInputPort({readAgentInputEpoch:async()=>'E2',submitAgentPrompt:async input=>{assertAgentInputEpoch({inputEpoch:'E2'},input);finite=input;const key={kind:'prompt',agentSessionId:'sid',expectedRun:{runId:'run'},submissionId:input.operationId};return{key,ref:{key,waitGeneration:'generation'}}},dispose:async()=>{}},reference,'run')
assert.equal((await port.readCurrent()).inputEpoch,'E2','qualified finite birth reads original namespace')
await assert.doesNotReject(()=>port.submit({target:reference,operationId:'qualified',runId:'run',execution:'finite',prompt:'Original task',inputEpoch:'E2'}),'fresh qualified source input remains usable')
assert.equal(finite.inputEpoch,'E2','qualified actual submit carries frozen epoch')
await assert.rejects(()=>demands.prepareDispatch(goal.id,{operationId:'finite',agentSessionId:'sid',hostId:'local',runId:'run',execution:'finite',prompt:'Original task',inputEpoch:'E1'}),'original dispatch cannot replace its cut')
console.log('GOAL_INPUT_CUT_PASS: actual Demand/Spatial/PMO/finite consumers; old request unchanged, fresh request available, independent disk reopen; controlled input leaf, zero Native')
