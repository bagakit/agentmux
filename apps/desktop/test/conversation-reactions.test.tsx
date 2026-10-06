import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { agentPromptCondition, AgentProviderRegistry, AgentMuxControlServer, AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { promptReactionDefinitions, promptReactionMessage, PROMPT_REACTION_STARTERS, type ConversationReplySource } from '@agentmux/core/prompt-reaction'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationReactionActions } from '@agentmux/client-ui/components/ConversationReactionActions'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { ShortcutSettingsPane } from '../src/renderer/src/components/settings/ShortcutSettingsPane'
import { executeSettingsResourcesControl } from '../src/main/settings-resources-control'
import { reactionPublicClientFixture } from './helpers/reaction-public-client-fixture'
import { rpcControlRequest, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { configOwnerFixture, deferred } from './helpers/config-owner-fixture'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { sendConversationReaction, useConversationReactions } from '../src/renderer/src/lib/conversation-reactions'
import { runCompiledObjectCli, objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import type { AgentSessionHistoryPage } from '@agentmux/core'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const dom = composerDOM()
const reply: ConversationReplySource = { kind: 'native', agentSessionId: 'agent-1', providerId: 'codex', nativeSessionId: 'original-native', recordId: 'reply-original' }
let fixture: Awaited<ReturnType<typeof configOwnerFixture>>
let server: AgentMuxControlServer | undefined
let cliRoot: string | undefined
const definition = PROMPT_REACTION_STARTERS[0]!
function Reply({ enabled = true }: { enabled?: boolean }) {
 const renderActions = useConversationReactions('agent-1', enabled)
 return <ConversationMessage messageId="reply-original" conversationSessionId="agent-1" speaker={{role:'agent', id:'agent-1'}} name="Builder" content="The original answer" messageActions={renderActions(reply)} />
}
beforeEach(async () => {
 fixture = await configOwnerFixture({ composerShortcuts: [...PROMPT_REACTION_STARTERS] })
 useAppStore.setState({config: fixture.owner.current})
 vi.spyOn(api.config,'get').mockImplementation(async () => fixture.owner.current)
 vi.spyOn(api.continuousProgress,'pauseForInput').mockResolvedValue(undefined)
})
afterEach(async () => { await server?.stop(); server = undefined; if(cliRoot) await rm(cliRoot,{recursive:true}); cliRoot = undefined })
const inspect = (keyword: string) => executeSettingsResourcesControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:'meaning',operation:'settings.resource.get',resource:'prompts',keyword}, fixture.owner)
async function mount() {await dom.render(<Reply />)}
async function press() {await dom.click('[aria-label="回复：认可"]')}
function queued(){return useAppStore.getState().agentSteerQueues['agent-1']!}
function waitPermission(){useAppStore.setState({sessions:[{...composerSession(), pendingInteraction:{kind:'permission',requestId:'q',agentSessionId:'agent-1',run:{runId:'run-agent-1'}, source:'hook',title:'Explicit approval',options:[]} } as never]})}
async function external(changes: Record<string, string | null>){return await executeSettingsResourcesControl({schemaVersion:AGENTMUX_CONTROL_SCHEMA_VERSION,requestId:'external',operation:'settings.resource.update',resource:'prompts',id:definition.id,changes},fixture.owner)}

describe('Saved Prompt → explicit lookup → exact reply card → original user queue', () => {
 it('edits the existing Settings definition durably and the built public CLI queries only its keyword namespace', async () => {
  await dom.render(<ShortcutSettingsPane config={fixture.owner.current} active onSave={async (prompts, expected) => {await fixture.owner.edit({...fixture.owner.current,composerShortcuts:expected},{...fixture.owner.current,composerShortcuts:prompts})}} />)
  await dom.click('[aria-label="Quick reply icon message-circle"]')
  await dom.click('[data-settings-save-bar] button')
  await vi.waitFor(async () => expect((await fixture.disk()).composerShortcuts![0]!.reactionIcon).toBe('message-circle'))
  cliRoot = await mkdtemp(join(tmpdir(),'reaction-cli-'))
  server = new AgentMuxControlServer({socketPath:join(cliRoot,'control.sock'),coreClients:()=>[],execute:async request => {
   if(!('resource' in request)) throw new Error('Unexpected operation')
   return await executeSettingsResourcesControl(request, fixture.owner)
  }})
  await server.start()
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI',resolve('packages/core/bin/amux'))
  const found = await runCompiledObjectCli(['settings','prompts','inspect','--keyword','ok'],objectCliEnvironment(cliRoot))
  expect(found.code,found.stderr).toBe(0)
  expect(JSON.parse(found.stdout).result.item).toEqual({id:definition.id,value: expect.objectContaining({keyword:'ok',body:definition.body,reactionIcon:'message-circle'})})
  const literal = await runCompiledObjectCli(['settings','prompts','inspect','ok'],objectCliEnvironment(cliRoot))
  expect(literal.code).not.toBe(0)
  expect(literal.stderr).toContain('SETTING_RESOURCE_NOT_FOUND')
  await external({reactionIcon:null})
  expect((await fixture.disk()).composerShortcuts![0]).not.toHaveProperty('reactionIcon')
  const meaning=await inspect('ok');expect(meaning.operation).toBe('settings.resource.get');if(meaning.operation!=='settings.resource.get')throw new Error('Expected lookup');expect(meaning.item.value.body).toBe(definition.body)
 })
 it('uses the original queue and public Core admission to persist the selected body and note as one human message',async()=>{
  const publicFlow=await reactionPublicClientFixture('agent-1','run-agent-1')
  const unlisten=publicFlow.client.onEvent(event=>useAppStore.getState().applyEvent({type:'core',hostId:'local',event}))
  try {
   const target=composerSession('agent-1','traex')
   useAppStore.setState({sessions:[{...target,pendingInteraction:{kind:'permission',id:'original-permission',agentSessionId:'agent-1',evidence:{run:{runId:'run-agent-1'},source:'native-hook',observedAt:_newTailFixtureEpoch(0, 0, 1)},title:'Explicit approval',options:[]}}]})
   vi.spyOn(api.sessions,'refresh').mockImplementation(async()=>({...target,promptSubmissionPredecessor:agentPromptCondition(publicFlow.client.agentSession('agent-1')).afterSubmissionId}))
   vi.spyOn(api.sessions,'inspectInput').mockImplementation(async (_control, key) => publicFlow.client.inspectAgentInput({key}))
   const submitted=vi.spyOn(api.sessions,'submitPrompt').mockImplementation(async(control,prompt,operationId,condition,_choice,human,agentMuxNote,sourceChannel)=>{
    if(!('admissionIntent' in condition)||_choice?.execution!=='immediate') throw new Error('Expected the original immediate manual reaction binding')
    expect(condition).toEqual({expectedRun:control.run,admissionIntent:{kind:'manual-actor'}});expect(_choice).toEqual({execution:'immediate'})
    return await publicFlow.client.submitAgentPrompt({agentSessionId:control.agentSessionId,prompt,operationId,expectedRun:condition.expectedRun,admissionIntent:condition.admissionIntent,execution:_choice.execution,authorHuman:human!,...(agentMuxNote===undefined?{}:{agentMuxNote}),...(sourceChannel===undefined?{}:{sourceChannel})})
   })
   await mount();await press();await useAppStore.getState().flushAgentSteerQueue('agent-1')
   const original=structuredClone(queued()[0]!)
   expect(original).toMatchObject({directInputBinding:{expectedRun:target.control.run,admissionIntent:{kind:'manual-actor'}},directInputControl:target.control})
   expect(submitted).not.toHaveBeenCalled()
   useAppStore.setState({sessions:[target]})
   await useAppStore.getState().flushAgentSteerQueue('agent-1')
   expect(submitted).toHaveBeenCalledTimes(1)
   expect(submitted.mock.calls[0]!.slice(0,4)).toEqual([target.control,original.text,original.operationId,original.directInputBinding])
   await publicFlow.settle()
   const receipt=await publicFlow.client.inspectAgentInput({key:{kind:'prompt',agentSessionId:'agent-1',expectedRun:{runId:'run-agent-1'},submissionId:submitted.mock.calls[0]![2]}})
   expect(receipt,JSON.stringify(receipt)).toMatchObject({status:'terminal-confirmed'})
   const all=(await publicFlow.store.loadTimeline('agent-1')).items;expect(all).toHaveLength(2)
   const items=all.filter(item=>item.kind==='user_message')
   expect(items).toHaveLength(1)
   expect(items[0]).toMatchObject({kind:'user_message',authorHuman:true,content:definition.body,sourceChannel:'reaction'})
   expect(all.find(item=>item.kind==='system_message')!.content).toContain('User quick reply snapshot:')
   expect(all.find(item=>item.kind==='system_message')!.content).toContain('<amux:reaction ok />')
   const reloaded=new (await import('@agentmux/core')).AgentMuxFileAgentSessionStore(publicFlow.store.path)
   expect((await reloaded.loadTimeline('agent-1')).items).toEqual(all)
   expect(publicFlow.writes.join('')).toContain(definition.body)
   expect(publicFlow.writes.join('')).toContain('reply-original')
   expect(useAppStore.getState().agentSteerQueues['agent-1']).toMatchObject([{archived:true,inputReceipt:{status:'terminal-confirmed'}}])
   expect(dom.draft()).toBe('Keep my draft')
  } finally {unlisten();await publicFlow.close()}
 })
 it('keeps an unconfirmed submission in the original Outbox and retries only its original explicit operation',async()=>{
  const flow=await reactionPublicClientFixture('agent-1','run-agent-1')
  vi.spyOn(api.sessions,'inspectInput').mockImplementation(async (_control,key)=>flow.client.inspectAgentInput({key}))
  vi.spyOn(api.sessions,'rejoinInputWaiting').mockImplementation(async (_control,ref)=>flow.client.rejoinAgentInputWaiting({ref}))
  try {
   useAppStore.setState({sessions:[composerSession('agent-1','traex')]})
   vi.spyOn(api.sessions,'refresh').mockImplementation(async()=>({...composerSession('agent-1','traex'),promptSubmissionPredecessor:agentPromptCondition(flow.client.agentSession('agent-1')).afterSubmissionId}))
   let first=true
   const submit=vi.spyOn(api.sessions,'submitPrompt').mockImplementation(async(control,prompt,operationId,condition,_choice,human,agentMuxNote,sourceChannel)=>{
    if(!('admissionIntent' in condition)||_choice?.execution!=='immediate') throw new Error('Expected the original immediate manual reaction binding')
    expect(condition).toEqual({expectedRun:control.run,admissionIntent:{kind:'manual-actor'}});expect(_choice).toEqual({execution:'immediate'})
    const receipt = await flow.client.submitAgentPrompt({agentSessionId:control.agentSessionId,prompt,operationId,expectedRun:condition.expectedRun,admissionIntent:condition.admissionIntent,execution:_choice.execution,authorHuman:human!,...(agentMuxNote===undefined?{}:{agentMuxNote}),...(sourceChannel===undefined?{}:{sourceChannel})})
    if(first){first=false;throw new Error('Response lost after acceptance')}
    return receipt
   })
   await mount();await press();await useAppStore.getState().flushAgentSteerQueue('agent-1')
   expect(submit).toHaveBeenCalledTimes(1)
   const pending=structuredClone(queued()[0]!)
   await flow.settle()
   const receipt=await flow.client.inspectAgentInput({key:{kind:'prompt',agentSessionId:'agent-1',expectedRun:{runId:'run-agent-1'},submissionId:submit.mock.calls[0]![2]}})
   expect(receipt,JSON.stringify(receipt)).toMatchObject({status:'terminal-confirmed'})
   const writesAfter=flow.writes.length;expect(writesAfter).toBeGreaterThan(0)
   await useAppStore.getState().flushAgentSteerQueue('agent-1')
   expect(submit).toHaveBeenCalledTimes(1);expect(queued()[0]!.operationId).toBe(pending.operationId)
   await useAppStore.getState().sendQueuedAgentSteer('agent-1',pending.operationId)
   expect(submit).toHaveBeenCalledTimes(1)
   expect(submit.mock.calls.map(call=>call[2])).toEqual([pending.operationId])
   expect(queued()[0]).toMatchObject({operationId:pending.operationId,archived:true,inputReceipt:{status:'terminal-confirmed'}})
   expect(flow.writes).toHaveLength(writesAfter)
   expect((await flow.store.loadTimeline('agent-1')).items.filter(item=>item.kind==='user_message')).toHaveLength(1)
  } finally {await flow.close()}
 })
 it.each(['admitted','terminal-confirmed'] as const)('allows an explicit reaction after confirmed archived %s history while preserving that original record and the current draft',async status=>{
  waitPermission();await mount();await press()
  const original=structuredClone(queued()[0]!)
  const key={kind:'prompt' as const,agentSessionId:'agent-1',expectedRun:{runId:'run-agent-1'},submissionId:original.operationId},ref={key,waitGeneration:1}
  const historical={...original,archived:true as const,inputIntakeStarted:true as const,inputReceipt:{key,ref,persistence:'confirmed' as const,
   status,observation:'closed' as const,admission:{agentSessionId:'agent-1',run:{runId:'run-agent-1'}},
   control:{ref,state:'dispatch-authorized' as const,at:1,gateId:'original-gate'}}}
  await act(async()=>useAppStore.setState({agentSteerQueues:{'agent-1':[historical]}}))
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="回复：认可"]')!.disabled).toBe(false)
  await press()
  expect(queued()).toHaveLength(2)
  expect(queued()[0]).toEqual(historical)
  expect(queued()[1]).toMatchObject({text:original.text,reaction:original.reaction,promptCondition:null})
  expect(queued()[1]!.operationId).not.toBe(original.operationId)
  expect(dom.draft()).toBe('Keep my draft')
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="回复：认可"]')!.disabled).toBe(true)
 })
 it('keeps an archived unknown reaction pending instead of turning archive into a new replay identity',async()=>{
  waitPermission();await mount();await press()
  const original={...structuredClone(queued()[0]!),archived:true as const,promptCondition:{expectedRun:{runId:'run-agent-1'},afterSubmissionId:null},error:'original ACK unknown'}
  await act(async()=>useAppStore.setState({agentSteerQueues:{'agent-1':[original]}}))
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="回复：认可"]')!.disabled).toBe(true)
  await expect(sendConversationReaction('agent-1',definition,reply,()=>{})).rejects.toThrow('already in the Outbox')
  expect(queued()).toEqual([original])
  expect(dom.draft()).toBe('Keep my draft')
 })
 it('keeps public lookup selectors exclusive and verifies the returned keyword against the requested target',()=>{
  const request=rpcControlRequest('settings.prompts.inspect',{keyword:'ok'})
  expect(request).toMatchObject({operation:'settings.resource.get',resource:'prompts',keyword:'ok'})
  expect(()=>rpcControlRequest('settings.prompts.inspect',{id:'same',keyword:'ok'})).toThrow()
  expect(()=>rpcControlRequest('settings.executors.inspect',{keyword:'ok'})).toThrow()
  expect(()=>parseRpcControlResult('settings.prompts.inspect',{resource:'prompts',item:{id:'any-id',value:{keyword:'other'}}},{keyword:'ok'})).toThrow()
 })
 it('accepts SVG feedback as ordinary manual input with an exact original native reference and leaves the draft intact', async () => {
  waitPermission()
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue(undefined)
  await mount(); expect(dom.container.querySelectorAll('.conversation-reactions svg')).toHaveLength(3)
  await press(); expect(queued()).toHaveLength(1)
  expect(queued()[0]).toMatchObject({text:definition.body,origin:'manual',reaction:{code:'ok',replySource:reply},promptCondition:null,runId:'run-agent-1'})
  expect(queued()[0]!.agentMuxNote).toContain('"nativeSessionId":"original-native"')
  expect(queued()[0]!.agentMuxNote).toContain('not permission approval')
  expect(dom.draft()).toBe('Keep my draft')
  expect(submit).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[role="status"] .conversation-reactions__sr')).not.toBeNull()
  expect(dom.container.querySelector('[role="status"] .conversation-reactions__sr')!.textContent).toBe('已加入发件箱')
 })
 it('freezes a pending reaction at the click Run and never retargets it when the interaction clears after Run replacement',async()=>{
  waitPermission();await mount();await press()
  const original=structuredClone(queued()[0]!),target=composerSession()
  expect(original).toMatchObject({directInputBinding:{expectedRun:target.control.run,admissionIntent:{kind:'manual-actor'}},directInputControl:target.control,reaction:{code:'ok',replySource:reply}})
  const submit=vi.spyOn(api.sessions,'submitPrompt'),inspect=vi.spyOn(api.sessions,'inspectInput')
  await act(async()=>useAppStore.setState({sessions:[{...target,control:{...target.control,run:{runId:'replacement-after-click'}}}]}))
  await useAppStore.getState().flushAgentSteerQueue('agent-1')
  expect(submit).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled()
  expect(queued()).toEqual([original]);expect(dom.draft()).toBe('Keep my draft')
 })
 it('freezes queued meaning across Settings edits and remounts instead of silently accepting the same outstanding reply again',async()=>{
  waitPermission();await mount();await press();const original=structuredClone(queued()[0]);await external({body:'new meaning'})
  useAppStore.setState({config:fixture.owner.current});await dom.render(<Reply />);await press()
  expect(queued()).toEqual([original]);expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="回复：认可"]')!.disabled).toBe(true)
  await expect(sendConversationReaction('agent-1',promptReactionDefinitions(fixture.owner.current.composerShortcuts!)[0]!,reply,()=>{})).rejects.toThrow('already in the Outbox')
  expect(queued()[0]!.text).toBe(definition.body)
 })
 it('refuses a stale definition, removed binding or changed provider without changing healthy draft or queue',async()=>{
  waitPermission();await mount();await external({reactionIcon:null});await press()
  expect(useAppStore.getState().agentSteerQueues).toEqual({});expect(dom.draft()).toBe('Keep my draft')
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('changed in Settings')
 })
 it('keeps reply identity across property reordering without conflating another original native session',async()=>{
  waitPermission();await mount();await press();const entry=queued()[0]!
  const reordered:ConversationReplySource={recordId:'reply-original',nativeSessionId:'original-native',providerId:'codex',agentSessionId:'agent-1',kind:'native'}
  useAppStore.setState({agentSteerQueues:{'agent-1':[{...entry,reaction:{code:'ok',replySource:reordered}}]}})
  await expect(sendConversationReaction('agent-1',definition,reply,()=>{})).rejects.toThrow('already in the Outbox')
  expect(await sendConversationReaction('agent-1',definition,{...reply,nativeSessionId:'other-original-native'},()=>{})).toBe(true)
  expect(queued()).toHaveLength(2)
  expect(queued().map(item=>item.reaction?.replySource)).toEqual([reordered,{...reply,nativeSessionId:'other-original-native'}])
 })
 it('rejects a stale body without guessing new meaning and reports original queue failure locally',async()=>{
  waitPermission();await mount();await external({body:'Different saved meaning'});await press()
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('changed in Settings')
  await external({body:definition.body});useAppStore.setState({config:fixture.owner.current});await press()
  const entry=queued()[0]!
  await act(async()=>useAppStore.setState({agentSteerQueues:{'agent-1':[{...entry,status:'failed',error:'Delivery is unconfirmed'}]}}))
  expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('Outbox before retrying')
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="回复：认可"]')!.disabled).toBe(true)
  expect(queued()[0]!.operationId).toBe(entry.operationId)
 })
 it('does no config I/O or queue work from hidden or unconfigured reply cards',async()=>{
  await dom.render(<Reply enabled={false} />)
  expect(dom.container.querySelector('.conversation-reactions')).toBeNull()
  expect(api.config.get).not.toHaveBeenCalled()
  useAppStore.setState({config:{...fixture.owner.current,composerShortcuts:[]}})
  await dom.render(<Reply />)
  expect(dom.container.querySelector('.conversation-reactions')).toBeNull()
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
 })
 it('keeps the original running target as a queued reaction when connection observation is unavailable',async()=>{
  waitPermission();const original=useAppStore.getState().sessions[0]!;if(original.kind!=='agent')throw new Error('Expected Agent')
  useAppStore.setState({sessions:[{...original,status:{state:'disconnected',source:'agentmux',observedAt:1}}]})
  const submit=vi.spyOn(api.sessions,'submitPrompt').mockResolvedValue(),recover=vi.spyOn(api.sessions,'recover').mockRejectedValue(new Error('Unexpected recovery'))
  await mount();await press();expect(queued()).toHaveLength(1);expect(queued()[0]!.runId).toBe(original.control.run.runId)
  expect(queued()[0]!.reaction?.replySource).toEqual(reply);expect(submit).not.toHaveBeenCalled();expect(recover).not.toHaveBeenCalled();expect(dom.draft()).toBe('Keep my draft')
 })
 it('keeps the original target while an asynchronous authoritative lookup races a Run replacement',async()=>{
  const pause=deferred<typeof fixture.owner.current>();vi.mocked(api.config.get).mockReturnValueOnce(pause.promise)
  await mount();await press();useAppStore.setState({sessions:[{...composerSession(),control:{...composerSession().control,run:{runId:'replacement'}}}]})
  await act(async()=>pause.resolve(fixture.owner.current))
  expect(useAppStore.getState().agentSteerQueues).toEqual({});expect(dom.container.querySelector('[role="alert"]')!.textContent).toContain('Agent changed')
 })
 it('preserves literal body and schema validation while invalid icons/codes cannot become executable SVG',async()=>{
  const before=await fixture.bytes()
  const rejectedIcon=await external({reactionIcon:'<svg onload="run()"/>'}).then(()=>null,error=>error)
  expect(rejectedIcon).toBeInstanceOf(Error)
  await expect(external({keyword:'ok"/>',reactionIcon:'check'})).rejects.toBeDefined()
  expect(await fixture.bytes()).toBe(before)
  expect(promptReactionDefinitions([{...definition, providerId:'claude'}],'codex')).toEqual([])
 })
 it('keeps the same frozen user meaning through two production Provider input plans',()=>{
  const frozen=promptReactionMessage(definition,reply), wire=composeAgentPrompt(frozen.prompt,frozen.agentMuxNote).text
  const providers=new AgentProviderRegistry(), claude=providers.get('claude').planPromptInput(wire), traex=providers.get('traex').planPromptInput(wire)
  expect(claude.kind).toBe('render-then-submit');if(claude.kind!=='render-then-submit')throw new Error('Expected Claude phases')
  expect(claude.renderedText).toBe(wire);expect(claude.payload).toContain(wire);expect(claude.submit).toBe('\r')
  expect(traex.kind).toBe('single-phase');if(traex.kind!=='single-phase')throw new Error('Expected TraeX plan')
  expect(traex.data).toBe(wire+'\r');expect(frozen.agentMuxNote).toContain('<amux:reaction ok />');expect(wire).toContain('&lt;amux:reaction ok /&gt;');expect(wire).toContain(definition.body)
 })
 it('preserves the original body and Range while unrelated output and a local queued reaction update',async()=>{
  waitPermission();await mount()
  const body=dom.container.querySelector('.log-turn__text')!,walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT)
  const text=walker.nextNode()!;expect(text.textContent).toContain('The original answer')
  const selection=getSelection()!,range=document.createRange();range.selectNodeContents(text);selection.removeAllRanges();selection.addRange(range)
  dom.container.scrollTop=99
  const other={...composerSession('other'),latestOutputBytes:10};await act(async()=>useAppStore.setState({sessions:[...useAppStore.getState().sessions,other]}))
  expect(api.config.get).not.toHaveBeenCalled();expect(selection.toString()).toBe('The original answer');expect(text.isConnected).toBe(true)
  await press();expect(text.isConnected).toBe(true);expect(selection.toString()).toBe('The original answer');expect(dom.container.scrollTop).toBe(99)
  expect(api.config.get).toHaveBeenCalledTimes(1);expect(queued()).toHaveLength(1)
 })
 it('preserves original assistant reply actions across progress and resource bodies in source order',async()=>{
  const page:AgentSessionHistoryPage={agentSessionId:'agent-1',source:{providerId:'codex',nativeSessionId:'original-native'},items:[
   {id:'u',kind:'user-message',contentParts:[{kind:'text',text:'User input'}]},
   {id:'s',kind:'system-message',contentParts:[{kind:'text',text:'System context'}]},
   {id:'p',kind:'assistant-message',messagePhase:'progress',contentParts:[{kind:'text',text:'Thinking aloud'}]},
   {id:'r',kind:'assistant-message',contentParts:[{kind:'resource',resourceType:'text',reference:'original-text-resource',content:{kind:'text',encoding:'json-utf8',byteLength:100,sha256:'a'.repeat(64)}}]},
   {id:'t',kind:'activity',contentParts:[{kind:'text',text:'Machine activity'}]},
   {id:'a',kind:'assistant-message',contentParts:[{kind:'text',text:'Final answer'}]}
  ],nextCursor:null}
  const sources:ConversationReplySource[]=[]
  await dom.render(<ConversationView page={page} sessionId="agent-1" renderMessageActions={source=>{sources.push(source);return <span data-real-reply-actions />}} />)
  expect(sources).toEqual(['p','r','a'].map(recordId=>({...reply,recordId})))
  expect(dom.container.querySelectorAll('[data-real-reply-actions]')).toHaveLength(3)
  expect(dom.container.querySelector('[data-native-record-id="p"] [data-real-reply-actions]')).not.toBeNull()
  expect(dom.container.querySelector('[data-native-record-id="r"] [data-real-reply-actions]')).not.toBeNull()
  for(const id of ['u','s','t']) expect(dom.container.querySelector(`[data-native-record-id="${id}"] [data-real-reply-actions]`)).toBeNull()
 })
 it('reveals the saved meaning in the host overlay for hover and keyboard without queue or config work',async()=>{
  await mount()
  const button=dom.container.querySelector<HTMLButtonElement>('[aria-label="回复：认可"]')!
  expect(document.querySelector('.conversation-reactions__hint')).toBeNull()
  await dom.hover('.conversation-reactions__choice')
  const hint=document.getElementById(button.getAttribute('aria-describedby')!)!
  expect(hint?.getAttribute('role')).toBe('tooltip');expect(hint.textContent).toContain(definition.body)
  expect(dom.container.contains(hint)).toBe(false)
  await act(async()=>button.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  expect(document.querySelector('.conversation-reactions__hint')).toBeNull()
  await act(async()=>button.focus())
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toContain(definition.body)
  await act(async()=>button.blur())
  expect(document.querySelector('.conversation-reactions__hint')).toBeNull()
  expect(api.config.get).not.toHaveBeenCalled();expect(queued()??[]).toEqual([]);expect(dom.draft()).toBe('Keep my draft')
 })
})
