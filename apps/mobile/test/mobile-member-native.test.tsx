import { DurableAgentMuxMessageQueue } from '../../../packages/core/src/agent-global-message-queue'
import { AgentMuxCreationAuthority } from '../../../packages/core/src/agent-creation-authority'
import { Blob as NodeBlob } from 'node:buffer'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import { createBrowserPlatform } from '../src/platform/browser'
import { act, createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { connectMobileMember } from '../src/conversation/mobile-member'
import { MobileSkillsPicker } from '../src/conversation/MobileSkillsPicker'
import { MobileAttachments, type MobileAttachmentControls } from '../src/conversation/MobileAttachments'
import { localAttachmentFromBlob } from '../src/platform/native/device'
import { getDeviceWorkface, emptyDeviceWorkface } from '../src/recovery/device-workface'
import { mount, mounted, click, waitForElement } from './conversation-fixture'
const cleanup:Array<()=>unknown|Promise<unknown>>=[]
afterEach(async()=>{for(const view of mounted.splice(0)){await act(async()=>view.root.unmount());view.element.remove()}for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks()})
it.skipIf(process.env.MOBILE_MEMBER_REOPEN==='1')('the actual Native Skills and attachment consumers use the original member owner rather than Source namesakes',async()=>{
 const {FileUploadOwner}=await import('../../host/src/file-upload-owner')
 const f=await createSpaceSessionsFixture(cleanup),sid='native-member-same-sid',provider=new AgentProviderRegistry().get('codex')
 const uploads={b:new FileUploadOwner(join(f.b.root,'uploads')),d:new FileUploadOwner(join(f.d.root,'uploads'))}
 for(const [key,node] of [['b',f.b],['d',f.d]] as const){
  Reflect.set(node.core,'creationAuthority',new AgentMuxCreationAuthority({stateDirectory:join(node.root,'creation-authority'),runtimeId:node.owner.runtimeId}))
  await new DurableAgentMuxMessageQueue(node.core.agentMessageQueuePath()).append({messageId:'same-message',operationId:'same-mail-operation',createdAt:1,sender:{kind:'agent-session',agentSessionId:sid},recipient:{kind:'agent-session',agentSessionId:'peer'},senderSessionId:sid,senderRunId:'original-mail-run',recipientSessionId:'peer',recipientRunId:'peer-run',threadId:'thread',correlationId:'correlation',replyTo:null,workspaceId:null,body:key==='d'?'D ORIGINAL MAIL BODY':'B NAMESAKE MAIL BODY'})
  node.core.providers.register({...provider,catalog:{...provider.catalog,composer:{...provider.catalog.composer,skillRoots:['skills']}}})
  await mkdir(join(node.root,'skills','original'),{recursive:true})
  await writeFile(join(node.root,'skills','original','SKILL.md'),`---\nname: ${key==='d'?'Original D skill':'Source B namesake skill'}\ndescription: Exact original private workspace\n---\nPrivate skill\n`)
  const service=Reflect.get(node.server,'service'),ports=Reflect.get(service,'ports')
  Object.assign(ports,{fileUploads:{upload:(input:never)=>uploads[key].upload(input),inspect:(input:never)=>uploads[key].inspect(input),read:(input:never,max:number)=>uploads[key].read(input,max)}})
 }
 const local=await f.b.put(sid,1,'native-source-B-run',f.b.root),original=await f.d.put(sid,1,'native-original-D-run',f.d.root)
 const admitted=await f.admit('D-in-B',f.d.owner.runtimeId,sid,'native-original-C',undefined,f.d.root)
 await f.b.spatial.settleAgentOpen(admitted.requestId,original,{})
 const source=await connectHostedAgentMux({rpc:f.b.rpc,connectOnDemand:true,agentSessionIds:[sid],forwardRpc:(method,params,context)=>f.b.rpc.call(method,params,{...(context?.signal?{signal:context.signal}:{}),...(context?.runtimeFence?{runtimeFence:context.runtimeFence}:{})}),subscribeRpc:async(method,params,handlers)=>{if(method==='space.member.watch' && params.call.method==='runtime.events')throw Error('Private original member event observation is unavailable');return f.b.rpc.subscribe(method,params,handlers)}})
 cleanup.push(()=>source.dispose());await source.connect()
 const selection={sourceRuntimeId:f.b.owner.runtimeId,target:{reference:f.reference,regionId:admitted.address.regionId,runtimeId:f.d.owner.runtimeId,agentSessionId:sid,expectedRun:original.run,expectedAdmission:{kind:'creation' as const,operationId:admitted.requestId}}}
 const member=await connectMobileMember(source,selection);cleanup.push(()=>member.client.dispose())
 const release=member.client.onEvent!(()=>{});cleanup.push(release)
 await expect(member.client.connect!()).rejects.toThrow('Private original member event observation is unavailable')
 expect(()=>member.client.agentSession!(sid)).toThrow('Session ownership is unverified')
 expect(await member.client.readAgentSession!(sid)).toMatchObject({workspacePath:f.d.root})
 const native=vi.spyOn(f.d.core,'runtimeSubject').mockRejectedValue(Error('These Native tools do not require a Native observation'))
 const originalSkill=vi.spyOn(f.d.core,'readAgentSession'),sourceSkill=vi.spyOn(f.b.core,'readAgentSession')
 const writer=vi.spyOn(uploads.d,'upload'),sourceWriter=vi.spyOn(uploads.b,'upload')
 const skills=await mount(<ClientUiProvider platform={createBrowserPlatform()}><MobileSkillsPicker client={member.client} session={original} scope="original-D" connected visible onSelect={()=>{}} /></ClientUiProvider>)
 await click((await waitForElement<HTMLButtonElement>(skills.element,'button[aria-label="选择 Skill"]')))
 await vi.waitFor(()=>expect(document.body.textContent,'Original Native skill is visible, never a Source namesake').toContain('Original D skill'),{timeout:15000})
 expect(document.body.textContent).not.toContain('Source B namesake skill');expect(originalSkill).toHaveBeenCalled();expect(sourceSkill).not.toHaveBeenCalled()
 await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8egAAAAASUVORK5CYII=','base64')
 const file=await localAttachmentFromBlob(Object.assign(new NodeBlob([bytes],{type:'image/png'}),{name:'original-member.png'}))
 const controls=createRef<MobileAttachmentControls>(),inserted:string[]=[]
 const view=await mount(<MobileAttachments client={member.client} session={original} connected agentSessionId={sid} promptOperationId={null} confirmedPrompt={null} controls={controls} pickFile={async()=>file} insert={async resolve=>{const path=await resolve();if(path)inserted.push(path)}} />)
 await act(async()=>{await controls.current!.choose()})
 const upload=await waitForElement<HTMLButtonElement>(view.element,'button[aria-label^="上传并加入"]');await click(upload)
 await vi.waitFor(()=>expect(inserted,'Original attachment remains usable without member event observation: '+view.element.textContent).toHaveLength(1),{timeout:15000})
 expect(await readFile(inserted[0]!)).toEqual(bytes);expect(inserted[0]!.startsWith(await realpath(f.d.root))).toBe(true)
 expect(writer).toHaveBeenCalledTimes(1);expect(sourceWriter).not.toHaveBeenCalled()
 const saved=getDeviceWorkface().snapshot().record.fileUploads![0]!
 expect(await member.client.forwardRpc!('file.upload.inspect',saved.identity)).toMatchObject({status:'uploaded',path:inserted[0]})
 const wrong={...saved.identity,expectedRun:local.run,operationId:'wrong-current-source-run'}
 await expect(member.client.forwardRpc!('file.upload',{...wrong,dataBase64:bytes.toString('base64')})).rejects.toMatchObject({code:'SPACE_MEMBER_TARGET_MISMATCH'})
 await expect(member.client.forwardRpc!('agent.interaction.respond',{} as never)).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
 const readD=vi.spyOn(f.d.core,'readMessage'),readB=vi.spyOn(f.b.core,'readMessage')
 expect(await member.client.readMessage!({messageId:'same-message'})).toMatchObject({envelope:{body:'D ORIGINAL MAIL BODY'}})
 expect(readD.mock.calls[0]![0]).toMatchObject({participantSessionId:sid,participantRuntimeId:f.d.owner.runtimeId})
 expect(readB).not.toHaveBeenCalled()
 await expect(member.client.readMessage!({messageId:'same-message',participantSessionId:sid,participantRuntimeId:f.b.owner.runtimeId})).rejects.toMatchObject({code:'SPACE_MEMBER_TARGET_MISMATCH'})
 const {expectedRun:_,...durableIdentity}=selection.target
 const durable=await connectMobileMember(source,{...selection,target:{...durableIdentity,kind:'conversation'}});cleanup.push(()=>durable.client.dispose())
 await skills.render(<div />)
 const durableSkills=await mount(<ClientUiProvider platform={createBrowserPlatform()}><MobileSkillsPicker client={durable.client} session={null} agentSessionId={sid} scope="durable-D" connected visible onSelect={()=>{}} /></ClientUiProvider>)
 await click(await waitForElement(durableSkills.element,'button[aria-label="选择 Skill"]'))
 await vi.waitFor(()=>expect(document.body.textContent,'Durable original Skills remain readable without metadata or a Run').toContain('Original D skill'),{timeout:15000})
 expect(await durable.client.forwardRpc!('file.upload.inspect',saved.identity)).toMatchObject({status:'uploaded',path:inserted[0]})
 expect(await durable.client.readMessage!({messageId:'same-message'})).toMatchObject({envelope:{body:'D ORIGINAL MAIL BODY'}})
 expect(writer).toHaveBeenCalledTimes(1);expect(sourceWriter).not.toHaveBeenCalled()
 if(process.env.MOBILE_MEMBER_PROOF){await mkdir(process.env.MOBILE_MEMBER_PROOF,{recursive:true});await writeFile(join(process.env.MOBILE_MEMBER_PROOF,'native-consumer.json'),JSON.stringify({passed:true,originalRuntimeId:f.d.owner.runtimeId,sourceRuntimeId:f.b.owner.runtimeId,originalSkillReads:originalSkill.mock.calls.length,sourceSkillReads:sourceSkill.mock.calls.length,originalUploads:writer.mock.calls.length,sourceUploads:sourceWriter.mock.calls.length,originalMailReads:readD.mock.calls.length,sourceMailReads:readB.mock.calls.length,uploadedSHA256:saved.identity.revision,uploadedBytes:bytes.length,loadedReceipt:saved,terminalHealthProbeCalls:native.mock.calls.length},null,2)+'\n')}
})
