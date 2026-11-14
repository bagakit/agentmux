// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.mock('electron',()=>({app:{getPath:()=>tmpdir()}}))
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'
import { MountedSpaceComposer } from '../src/renderer/src/components/MountedSpaceComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import * as store from '../src/renderer/src/store'
import { mountedMemberInput, mountedMemberRequests, editMountedMemberInput } from '../src/renderer/src/lib/space-member-input'
import { spaceMountKey, type SpaceMountMemberTarget } from '../src/shared/space-mount'

const dom=composerDOM(),cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function fixture(){
 const f=await createSpaceSessionsFixture(cleanup),sid='original-composer'
 f.d.core.providers.register(new AgentProviderRegistry().get('codex'))
 const session=await f.d.put(sid),admitted=await f.admit('D-in-B',f.d.owner.runtimeId,sid,'original-composer-create')
 const main=spaceMountTransport(cleanup,[{id:'original-b-route',carrier:{forwardRpc:f.b.rpc.call.bind(f.b.rpc),subscribeRpc:f.b.rpc.subscribe.bind(f.b.rpc)}}],structuredClone(DEFAULT_CONFIG))
 const target:SpaceMountMemberTarget={hostId:'original-b-route',target:{reference:f.reference,regionId:admitted.address.regionId,runtimeId:f.d.owner.runtimeId,agentSessionId:sid,expectedRun:session.run}}
 vi.spyOn(api.spaceMounts,'member').mockImplementation(main.api.member)
 const surface=await main.api.member(target,()=>{});cleanup.push(()=>surface.dispose())
 const key=spaceMountKey(f.reference),tabId=admitted.address.tabId,zoneId=admitted.address.zoneId
 if(!zoneId)throw Error('Expected the admitted original Zone')
 if(!tabId)throw Error('Expected the admitted original Tab')
 useAppStore.getState().mountSpace({hostId:target.hostId,reference:f.reference,zoneId,workspaceId:'original-b-project'})
 const checkpoint=vi.spyOn(store,'checkpointMountedSpaceInputs').mockResolvedValue()
 const render=()=>dom.render(<MountedSpaceComposer target={target} surface={surface} subscribe={()=>()=>{}} mountKey={key} tabId={tabId} active />)
 const requests=()=>mountedMemberRequests(useAppStore.getState().mountedSpaceInputs,key,target)
 return{...f,main,zoneId,session,target,surface,key,tabId,checkpoint,render,requests}
}
const editor=()=>dom.container.querySelector<HTMLElement & {editor:Editor}>('[role="textbox"]')!
async function text(value:string){await act(async()=>{editor().editor.commands.setContent({type:'doc',content:[{type:'paragraph',content:value?[{type:'text',text:value}]:[]}]})})}
const send=()=>dom.click('[aria-label="Send new message"]')
const check=()=>dom.click('button.small-button')

it('the original rich Composer sends through real Core/Main with native intent ACK, keeps unknown input and allows a separate explicit message',async()=>{
 const f=await fixture(),before=useAppStore.getState().sessions
 let rejectOriginal:(reason:Error)=>void=()=>{}
 const dispatch=vi.spyOn(f.d.core,'submitAgentPrompt').mockImplementationOnce(()=>new Promise((_,reject)=>{rejectOriginal=reject})).mockResolvedValue(undefined)
 const local=vi.spyOn(f.b.core,'submitAgentPrompt').mockRejectedValue(Error('Wrong source'))
 await f.render();await text('First original message 中')
 f.checkpoint.mockImplementation(async()=>{
  expect(Object.values(f.requests())).toContainEqual(expect.objectContaining({target:f.target,submitted:true,request:expect.objectContaining({prompt:'First original message 中',binding:{expectedRun:f.session.run,admissionIntent:{kind:'manual-actor'}}})}))
 })
 await send();await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledOnce())
 const [op]=Object.keys(f.requests()),original=mountedMemberInput(f.requests()[op!],f.target,op!)
 expect(dispatch.mock.calls[0]![0]).toMatchObject({agentSessionId:f.target.target.agentSessionId,expectedRun:f.session.run,operationId:op,prompt:'First original message 中'})
 expect(editor().textContent).toBe('');expect(editor().getAttribute('contenteditable')).toBe('true')
 expect(dom.container.textContent).toContain('Input result is unknown')
 f.checkpoint.mockResolvedValue();await text('A separate explicit message');await send()
 await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledTimes(2))
 expect(dispatch.mock.calls[1]![0].operationId).not.toBe(op)
 await act(async()=>rejectOriginal(Error('Original response disconnected')))
 await vi.waitFor(()=>expect(dom.container.textContent).toContain('Original response disconnected'))
 expect(mountedMemberInput(f.requests()[op!],f.target,op!).request).toEqual(original.request)
 const persisted=useAppStore.persist.getOptions().partialize!(useAppStore.getState())
 const restored=JSON.parse(JSON.stringify(persisted))
 await dom.render(null);useAppStore.setState({mountedSpaceInputs:restored.mountedSpaceInputs})
 await f.render()
 expect(dom.container.textContent).toContain('First original message 中');expect(dispatch).toHaveBeenCalledTimes(2)
 expect(local).not.toHaveBeenCalled();expect(useAppStore.getState().sessions).toBe(before)
 const inspect=vi.spyOn(f.d.core,'inspectAgentInput').mockResolvedValue(null)
 await check();await vi.waitFor(()=>expect(inspect).toHaveBeenCalledOnce())
 expect(inspect.mock.calls[0]![0]).toEqual({key:{kind:'prompt',agentSessionId:f.target.target.agentSessionId,expectedRun:f.session.run,submissionId:op}})
 expect(dispatch).toHaveBeenCalledTimes(2);expect(dom.container.textContent).toContain('outcome remains unconfirmed')
})

it('checkpoint failure retains the exact unsent message, while explicit inspect consumes only the original typed Core receipt',async()=>{
 const f=await fixture(),dispatch=vi.spyOn(f.d.core,'submitAgentPrompt').mockResolvedValue(undefined)
 f.checkpoint.mockRejectedValue(Error('Private document write failed'))
 await f.render();await text('Keep literal message  ');await send()
 await vi.waitFor(()=>expect(dom.container.textContent).toContain('Private document write failed'))
 expect(dispatch).not.toHaveBeenCalled();expect(editor().textContent).toContain('Keep literal message')
 const [op]=Object.keys(f.requests()),input=mountedMemberInput(f.requests()[op!],f.target,op!)
 expect(input.submitted).toBe(false)
 expect(dom.container.textContent).toContain('Unsent input');expect(dom.container.textContent).not.toContain('The input is saved.')
 const key={kind:'prompt' as const,agentSessionId:f.target.target.agentSessionId,expectedRun:f.session.run,submissionId:op!},ref={key,waitGeneration:1}
 const receipt:AgentInputSubmissionReceipt={key,ref,persistence:'confirmed',status:'waiting',control:{ref,state:'enabled',at:1,waiting:{phase:'session',reason:'session-resume-needed',wake:'session-restored'}},admission:null,observation:'owned'}
 const inspect=vi.spyOn(f.d.core,'inspectAgentInput').mockResolvedValue(receipt)
 const button=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(x=>x.textContent==='Check original input')!
 await act(async()=>button.click());await vi.waitFor(()=>expect(inspect).toHaveBeenCalledOnce())
 expect(dom.container.textContent).toContain('Input waits for its session')
 expect(mountedMemberInput(f.requests()[op!],f.target,op!)).toMatchObject({submitted:true,response:receipt})
 expect(Array.from(dom.container.querySelectorAll('button')).some(button=>button.textContent==='Send original message')).toBe(false)
 expect(dispatch).not.toHaveBeenCalled()
})

it('a saved original message keeps its exact earlier Run instead of borrowing the currently visible member port',async()=>{
 const f=await fixture(),dispatch=vi.spyOn(f.d.core,'submitAgentPrompt').mockResolvedValue(undefined)
 const old={...f.target,target:{...f.target.target,expectedRun:{runId:'original-earlier-run'}}}
 const original={target:old,request:{operationId:'earlier-unsent',prompt:'Original earlier Run',binding:{expectedRun:old.target.expectedRun,admissionIntent:{kind:'manual-actor' as const}}},submitted:false}
 useAppStore.setState(state=>({mountedSpaceInputs:editMountedMemberInput(state.mountedSpaceInputs,f.key,old,original.request.operationId,()=>original)}))
 await f.render()
 const button=Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(x=>x.textContent==='Send original message')!
 await act(async()=>button.click())
 await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledOnce())
 expect(dispatch.mock.calls[0]![0]).toMatchObject({agentSessionId:old.target.agentSessionId,expectedRun:old.target.expectedRun,operationId:'earlier-unsent',prompt:'Original earlier Run'})
 const member=vi.mocked(api.spaceMounts.member)
 expect(member).toHaveBeenCalledWith(old,expect.any(Function))
 expect(mountedMemberInput(f.requests()['earlier-unsent'],f.target,'earlier-unsent').request).toEqual(original.request)
})

it('a late earlier response cannot unlock a later message whose original native checkpoint is still pending',async()=>{
 const f=await fixture();let settleA:()=>void=()=>{},ackB:()=>void=()=>{}
 const dispatch=vi.spyOn(f.d.core,'submitAgentPrompt').mockImplementationOnce(()=>new Promise(resolve=>{settleA=()=>resolve(undefined)})).mockResolvedValue(undefined)
 f.checkpoint.mockResolvedValueOnce().mockImplementationOnce(()=>new Promise(resolve=>{ackB=resolve}))
 await f.render();await text('Original message A');await send();await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledOnce())
 await text('Original message B');await send();await vi.waitFor(()=>expect(f.checkpoint).toHaveBeenCalledTimes(2))
 expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Send new message"]')!.disabled).toBe(true)
 await act(async()=>settleA());await act(async()=>{})
 expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Send new message"]')!.disabled).toBe(true)
 expect(dispatch).toHaveBeenCalledOnce()
 await act(async()=>ackB());await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledTimes(2))
 expect(dispatch.mock.calls[1]![0].prompt).toBe('Original message B')
})

it('changing an authenticated carrier keeps every original semantic-member message and checks only its frozen original carrier',async()=>{
 const f=await fixture(),dispatch=vi.spyOn(f.d.core,'submitAgentPrompt').mockResolvedValue(undefined)
 await f.render();await text('Keep the original carrier message');await send();await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledOnce())
 const [op]=Object.keys(f.requests()),original=mountedMemberInput(f.requests()[op!],f.target,op!),before=JSON.stringify(original.request)
 const replacement={...f.target,hostId:'replacement-b-route'}
 f.main.routes.set(replacement.hostId,{client:f.main.routes.get(f.target.hostId)!.client})
 const surface=await f.main.api.member(replacement,()=>{});cleanup.push(()=>surface.dispose())
 useAppStore.getState().mountSpace({hostId:replacement.hostId,reference:replacement.target.reference,zoneId:f.zoneId,workspaceId:'original-b-project'})
 await dom.render(<MountedSpaceComposer target={replacement} surface={surface} subscribe={()=>()=>{}} mountKey={f.key} tabId={f.tabId} active />)
 expect(dom.container.textContent).toContain('Keep the original carrier message')
 const inspect=vi.spyOn(f.d.core,'inspectAgentInput').mockResolvedValue(null)
 await check();await vi.waitFor(()=>expect(inspect).toHaveBeenCalledOnce())
 expect(vi.mocked(api.spaceMounts.member)).toHaveBeenLastCalledWith(f.target,expect.any(Function))
 f.main.routes.delete(f.target.hostId)
 await check();await vi.waitFor(()=>expect(dom.container.textContent).toContain('original Space Host is not configured'))
 expect(dispatch).toHaveBeenCalledOnce();expect(inspect).toHaveBeenCalledOnce()
 await text('New message through current exact carrier');await send();await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledTimes(2))
 expect(dispatch.mock.calls[1]![0].prompt).toBe('New message through current exact carrier')
 expect(JSON.stringify(mountedMemberInput(f.requests()[op!],f.target,op!).request)).toBe(before)
 expect(dom.container.textContent).toContain('Keep the original carrier message')
})

it('retained same-SID input from a different original Space Runtime is never adopted by the current member view',async()=>{
 const f=await fixture(),dispatch=vi.spyOn(f.d.core,'submitAgentPrompt').mockResolvedValue(undefined)
 await f.render();await text('Only original Runtime B');await send();await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledOnce())
 const values=useAppStore.getState().mountedSpaceInputs as Record<string,{memberInputs?:unknown}>,original=values[f.key]!.memberInputs
 const other={...f.target,target:{...f.target.target,reference:{...f.target.target.reference,runtimeId:'other-original-runtime'}}},key=spaceMountKey(other.target.reference)
 useAppStore.getState().mountSpace({hostId:other.hostId,reference:other.target.reference,zoneId:f.zoneId,workspaceId:'original-b-project'})
 useAppStore.setState(state=>({mountedSpaceInputs:{...(state.mountedSpaceInputs as Record<string,unknown>),[key]:{...(state.mountedSpaceInputs as Record<string,object>)[key],memberInputs:original}}}))
 await dom.render(<MountedSpaceComposer target={other} subscribe={()=>()=>{}} mountKey={key} tabId={f.tabId} active />)
 expect(dom.container.textContent).not.toContain('Only original Runtime B')
 expect(dispatch).toHaveBeenCalledOnce();expect((useAppStore.getState().mountedSpaceInputs as typeof values)[key]!.memberInputs).toBe(original)
})
