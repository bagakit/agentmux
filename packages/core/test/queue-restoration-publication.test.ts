import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,rm,rename,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {DurableAgentMuxMessageQueue} from '../src/agent-global-message-queue.js'
import {AgentMuxCreationAuthority} from '../src/agent-creation-authority.js'
import {AgentProviderRegistry} from '../src/agent-provider.js'
import {agentPromptCondition} from '../src/agent-prompt-condition.js'
import {rpcOwnerFixture} from './helpers/public-rpc-owner.js'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})})
const digest=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex')
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'amux-queue-restore-'));roots.push(root)
 const queue=new DurableAgentMuxMessageQueue(join(root,'messages.sqlite'));await queue.readJournal()
 const capture=await queue.storageRecoverySource().capture(join(root,'original-cut'))
 expect(capture.gaps).toEqual([])
 const journal=capture.members.find(m=>m.id==='journal')!,mutex=capture.members.find(m=>m.id==='mutex')!
 const prepared=await queue.prepareRecoveryRestore({sourcePath:journal.file,sourceMutexPath:mutex.file,stagingPath:join(root,'prepared'),operationId:'original-restore',expectedIncarnation:JSON.parse(capture.revision)[0]})
 const member={...journal,file:prepared.file,sha256:await digest(prepared.file),originalSHA256:prepared.sourceSHA256,operationId:prepared.operationId}
 return{root,queue,capture,journal,mutex,prepared,member}
}
it('publishes only the held original journal under the surviving original mutex, including a cold-process retry',async()=>{
 const f=await fixture();await rename(f.queue.path,f.queue.path+'.lost')
 const loader=fileURLToPath(new URL('./helpers/prompt-receipt-source-loader.mjs',import.meta.url)),module=fileURLToPath(new URL('../src/agent-global-message-queue.ts',import.meta.url))
 const script=`const{DurableAgentMuxMessageQueue}=await import(${JSON.stringify(module)});const q=new DurableAgentMuxMessageQueue(process.argv[1]);process.stdout.write(JSON.stringify(await q.restoreRecoveryMember(JSON.parse(process.argv[2]))))`
 const run=()=>promisify(execFile)(process.execPath,['--no-warnings','--experimental-loader',loader,'--input-type=module','-e',script,f.queue.path,JSON.stringify(f.member)])
 expect(JSON.parse((await run()).stdout)).toBe('restored')
 expect(JSON.parse((await run()).stdout)).toBe('same')
 expect(await f.queue.readJournal()).toEqual([{kind:'restored-input-hold',sequence:1,operationId:f.prepared.operationId,throughSequence:0,sourceSHA256:f.prepared.sourceSHA256,sourceMutexSHA256:f.prepared.sourceMutexSHA256}])
 await f.queue.append({operationId:'new-live-operation',messageId:'new-live-mid',createdAt:1,sender:{kind:'agent-session',agentSessionId:'sender'},recipient:{kind:'agent-session',agentSessionId:'recipient'},senderSessionId:'sender',senderRunId:'run-sender',recipientSessionId:'recipient',recipientRunId:'run-recipient',threadId:'thread',correlationId:'new-live-mid',replyTo:null,workspaceId:null,body:'Independent live append'},{deliveryMode:'reference'})
 expect(await digest(f.member.file)).toBe(f.member.sha256)
 expect(JSON.parse((await run()).stdout)).toBe('same');expect((await f.queue.readByMessageId('new-live-mid'))?.envelope.body).toBe('Independent live append')
})
it('rejects a plain unheld backup, wrong operation and original-source mismatch before publication',async()=>{
 const f=await fixture();await rename(f.queue.path,f.queue.path+'.lost')
 for(const member of [{...f.member,file:f.journal.file,sha256:await digest(f.journal.file)},{...f.member,operationId:'another-restore'},{...f.member,originalSHA256:'a'.repeat(64)}])await expect(f.queue.restoreRecoveryMember(member)).rejects.toThrow()
 await expect(readFile(f.queue.path)).rejects.toMatchObject({code:'ENOENT'})
})
it('does not recreate a missing mutex or replace another existing journal',async()=>{
 const f=await fixture();await rename(f.queue.path,f.queue.path+'.lost');await rename(f.queue.path+'.mutex.sqlite',f.queue.path+'.mutex.sqlite.lost')
 await expect(f.queue.restoreRecoveryMember(f.member)).rejects.toMatchObject({code:'ENOENT'})
 await expect(readFile(f.queue.path+'.mutex.sqlite')).rejects.toMatchObject({code:'ENOENT'})
 await rename(f.queue.path+'.mutex.sqlite.lost',f.queue.path+'.mutex.sqlite');await rename(f.queue.path+'.lost',f.queue.path)
 const original=await readFile(f.queue.path);expect(await f.queue.restoreRecoveryMember(f.member)).toBe('conflict');expect(await readFile(f.queue.path)).toEqual(original)
})
it('restored v2 refuses old-reader format while malformed holds keep Inbox metadata readable and input unknown',async()=>{
 const f=await fixture(),db=new DatabaseSync(f.prepared.file)
 expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
 db.exec("DELETE FROM records WHERE json_extract(json,'$.kind')='restored-input-hold';DELETE FROM restoration_holds");db.close()
 const queue=new DurableAgentMuxMessageQueue(f.prepared.file)
 expect(await queue.readJournal()).toEqual([])
 await expect(queue.pendingNotificationRecipients()).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED',detail:'unknown'})
})
it('two signed peers preserve a cut-external old reference without Native replay after Queue-only recovery, while a fresh MID delivers',async()=>{
 const authority=(root:string,runtimeId:string)=>({creationAuthority:new AgentMuxCreationAuthority({stateDirectory:join(root,'authority'),runtimeId})})
 const source=await rpcOwnerFixture(['caller'],undefined,undefined,root=>authority(root,'source-runtime'))
 const target=await rpcOwnerFixture(['recipient'],undefined,undefined,root=>authority(root,'target-runtime'))
 try{
  const before=(await target.store.readMetadata('recipient'))!
  await target.store.compareAndSwapMetadata(before,{...before,nativeHandle:{kind:'provider',providerId:'codex',sessionId:'original-native'}});await target.inner.registry.load('local')
  const providers=Reflect.get(target.client,'providers') as AgentProviderRegistry,provider=providers.get('codex'),native=vi.fn(async()=>({outcome:'admitted' as const,queuedSubmissionId:'original-native-ack'}))
  target.inner.kernel.status=vi.fn(async(id:string)=>({...target.run(id),pid:1234}))
  providers.replace({...provider,readPromptExecutionEvidence:async()=>({state:'idle',sourceId:'native-source',id:'native-idle'}),prepareNativeInput:async(_context,session)=>({plan:{kind:'native-rpc',protocolId:'synthetic-native',sourceId:JSON.stringify([session.providerId,session.nativeSessionId]),threadId:session.nativeSessionId,actorId:'original-writer',operation:'queue-idle'},assertCurrent:async()=>{},dispose:async()=>{},send:native})})
  const notifications=Reflect.get(target.client,'messageNotifications')
  const settled=async()=>{await notifications.observation?.ready;const drains=Reflect.get(notifications,'drains') as Map<string,{pending:Promise<void>}>;while(drains.size)await Promise.all([...drains.values()].map(d=>d.pending))}
  const a=await source.client.agentMessageAuthority(),b=await target.client.agentMessageAuthority()
  await target.client.trustMessageSource({sourceRuntimeId:a.runtimeId,publicKey:a.publicKey,targetRuntimeId:b.runtimeId,targetKeyFingerprint:b.fingerprint},{kind:'user',id:'synthetic-person'})
  const queue=new DurableAgentMuxMessageQueue(target.client.agentMessageQueuePath());await queue.readJournal()
  const capture=await queue.storageRecoverySource().capture(join(target.root,'queue-cut')),journal=capture.members.find(m=>m.id==='journal')!,mutex=capture.members.find(m=>m.id==='mutex')!
  const prepare=(id:string,epoch?:string)=>source.client.prepareFederatedMessage({caller:source.credentials,target:{runtimeId:b.runtimeId,agentSessionId:'recipient',runId:before.run.runId},targetKeyFingerprint:b.fingerprint,operationId:'op-'+id,messageId:id,text:'original-'+id,...(epoch?{recipientInputEpoch:epoch}:{})})
  const old=await prepare('outside-cut')
  await target.client.intakeFederatedMessage(old.packet);await settled();expect(native).toHaveBeenCalledTimes(1)
  const held=await queue.prepareRecoveryRestore({sourcePath:journal.file,sourceMutexPath:mutex.file,stagingPath:join(target.root,'stage'),operationId:'queue-only-cut',expectedIncarnation:JSON.parse(capture.revision)[0]})
  const admitted=await target.store.admitRecoveryInputCut({operationId:'queue-only-cut',sourceSHA256:'e'.repeat(64)})
  expect(admitted.state).toBe('admitted');if(admitted.state!=='admitted')throw new Error('Expected cut')
  await rename(queue.path,queue.path+'.lost')
  await queue.restoreRecoveryMember({...journal,file:held.file,sha256:await digest(held.file),originalSHA256:held.sourceSHA256,operationId:held.operationId})
  await target.inner.registry.load('local');native.mockClear()
  await target.client.intakeFederatedMessage(old.packet);await settled();expect(native).not.toHaveBeenCalled()
  expect((await queue.readByMessageId('outside-cut'))?.envelope).toEqual(old.packet.envelope)
  expect(await queue.prepareNotification({notificationId:'old-native-turn-decision',agentSessionId:'recipient',condition:agentPromptCondition((await target.store.readMetadata('recipient'))!),turnEnd:{nativeTurnId:'actual-turn',hookReceiptId:'actual-hook'},sourceRuns:[before.run.runId]})).toBeNull()
  const fresh=await prepare('new-independent',admitted.inputEpoch)
  await expect(target.client.intakeFederatedMessage({...fresh.packet,envelope:{...fresh.packet.envelope,recipientInputEpoch:'tampered'}})).rejects.toThrow()
  await target.client.intakeFederatedMessage(fresh.packet);await settled();expect(native).toHaveBeenCalledTimes(1)
  expect((await queue.readByMessageId('new-independent'))?.envelope.recipientInputEpoch).toBe(admitted.inputEpoch)
  await expect(target.client.notifyMessages({operationId:'old-manual-outside-cut',messageIds:['outside-cut']})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
  expect(native).toHaveBeenCalledTimes(1)
  expect(target.inner.kernel.input).not.toHaveBeenCalled();expect(target.inner.kernel.stop).not.toHaveBeenCalled()
 }finally{await target.close();await source.close()}
})

it('the actual Unix RPC and source CLI retain the producer epoch and refuse a stale explicit notification',async()=>{
 const h=await rpcOwnerFixture(['caller','recipient'])
 const {AgentMuxControlServer}=await import('../src/public-rpc-server.js'),{connectAgentMuxRpc}=await import('../src/public-rpc-client.js')
 const server=new AgentMuxControlServer({socketPath:join(h.root,'epoch-reference.sock'),coreClients:h.coreClients})
 try{
  const cut=await h.store.admitRecoveryInputCut({operationId:'public-message-cut',sourceSHA256:'f'.repeat(64)});if(cut.state!=='admitted')throw new Error('Expected cut')
  await h.inner.registry.load('local');await server.start()
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path},credentials:h.credentials})
  try{
   const saved=await rpc.call('agent.send',{target:{kind:'agent-session',agentSessionId:'recipient'},operationId:'public-reference',messageId:'public-mid',text:'Original body',recipientInputEpoch:cut.inputEpoch})
   expect(saved.envelope.recipientInputEpoch).toBe(cut.inputEpoch)
   await expect(rpc.call('message.notify',{hostId:'local',operationId:'old-notify',messageIds:['public-mid']})).rejects.toMatchObject({code:'AGENT_PROMPT_INPUT_UNCONFIRMED'})
  }finally{await rpc.dispose()}
  const loader=fileURLToPath(new URL('./helpers/prompt-receipt-source-loader.mjs',import.meta.url)),cli=fileURLToPath(new URL('../src/agentmux.ts',import.meta.url))
  const output=await promisify(execFile)(process.execPath,['--no-warnings','--experimental-loader',loader,cli,'--endpoint','unix://'+server.path,'agent','send','--to-session','recipient','--operation-id','source-cli-reference','--message-id','source-cli-mid','--text','Exact source CLI body','--input-epoch',cut.inputEpoch],{env:{...process.env,AGENTMUX_AGENT_SESSION_ID:'caller',AGENTMUX_AGENT_CAPABILITY:h.capability}})
  expect(JSON.parse(output.stdout)).toMatchObject({ok:true,result:{envelope:{recipientInputEpoch:cut.inputEpoch,body:'Exact source CLI body'}}})
  expect(h.inner.kernel.input).not.toHaveBeenCalled();expect(h.inner.kernel.stop).not.toHaveBeenCalled()
 }finally{await server.stop();await h.close()}
})


it('never publishes while the surviving original mutex has an active lawful writer',async()=>{
 const f=await fixture();await rename(f.queue.path,f.queue.path+'.lost')
 const writer=new DatabaseSync(f.queue.path+'.mutex.sqlite');writer.exec('BEGIN IMMEDIATE')
 try{await expect(f.queue.restoreRecoveryMember(f.member)).rejects.toMatchObject({errcode:5});await expect(readFile(f.queue.path)).rejects.toMatchObject({code:'ENOENT'})}finally{writer.exec('ROLLBACK');writer.close()}
 expect(await f.queue.restoreRecoveryMember(f.member)).toBe('restored')
})

it('the source family prepares only a selected missing journal from the exact qualified same-generation pair',async()=>{
 const f=await fixture(),source=f.queue.storageRecoverySource()
 const archiveBody='Original archived journal bytes',archiveHash=createHash('sha256').update(archiveBody).digest('hex'),archiveTarget=f.queue.path+'.original-'+archiveHash
 await writeFile(archiveTarget,archiveBody,{mode:0o600})
 const archives=await source.capture(join(f.root,'archive-cut')),archive=archives.members.find(m=>m.id==='original-'+archiveHash)!
 await rm(archiveTarget)
 const archiveMember={...archive,sha256:archiveHash,originalSHA256:archiveHash,operationId:'family-restore'}
 await rename(f.queue.path,f.queue.path+'.lost')
 const original=async(id:string)=>{const member=f.capture.members.find(m=>m.id===id);if(!member)return null;const sha256=await digest(member.file);return{...member,sha256,originalSHA256:sha256,operationId:'family-restore'}}
 const journal=(await original('journal'))!
 expect(await source.prepareRestore([journal],join(f.root,'no-context'))).toMatchObject({state:'unavailable'})
 const prepared=await source.prepareRestore([journal,archiveMember],join(f.root,'family-prepared'),{original,inputCutSourceSHA256:'f'.repeat(64)})
 expect(prepared.state).toBe('prepared');if(prepared.state!=='prepared')throw new Error('Expected family candidate')
 expect(prepared.members).toHaveLength(2);expect(prepared.members[0]).toMatchObject({id:'journal',target:f.queue.path,operationId:'family-restore',originalSHA256:journal.sha256})
 expect(await source.restoreMissing!(prepared.members[0]!)).toBe('restored')
 expect(await source.restoreMissing!(prepared.members[1]!)).toBe('restored');expect(await readFile(archiveTarget,'utf8')).toBe(archiveBody)
 const db=new DatabaseSync(f.queue.path,{readOnly:true});try{expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2)}finally{db.close()}
})


it('an original pre-epoch remote route retains its exact digest and remains usable through real public RPC',async()=>{
 const source=await rpcOwnerFixture(['source']),target=await rpcOwnerFixture(['recipient'])
 const {AgentMuxControlServer}=await import('../src/public-rpc-server.js'),{connectAgentMuxRpc}=await import('../src/public-rpc-client.js')
 const targetServer=new AgentMuxControlServer({socketPath:join(target.root,'target.sock'),coreClients:target.coreClients})
 let sourceServer:InstanceType<typeof AgentMuxControlServer>|undefined
 try{
  const providers=Reflect.get(target.client,'providers') as AgentProviderRegistry
  vi.spyOn(providers.get('codex'),'planPromptInput').mockImplementation(text=>({kind:'single-phase',data:text+'\r'}))
  await targetServer.start();const targetRpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:targetServer.path}})
  try{
   const proxy=Object.create(target.client);Object.assign(proxy,{runtimeOwnerIdentity:()=>({runtimeId:'legacy-runtime',availability:'connected'}),forwardRpc:(method:any,params:any)=>targetRpc.call(method,params)})
   sourceServer=new AgentMuxControlServer({socketPath:join(source.root,'source.sock'),coreClients:()=>[...source.coreClients(),{hostId:'remote',client:proxy}]})
   const operationId='legacy-route-operation',messageId='legacy-route-mid',text='Original route body',principal={kind:'user',id:`local-user:${process.getuid?.()??'current'}`}
   const intentDigest=createHash('sha256').update(JSON.stringify({text,execution:'immediate',sourceChannel:'api',sender:null,principal,threadId:messageId,correlationId:messageId,replyTo:null,admissionIntent:null,application:null})).digest('hex')
   const queue=new DurableAgentMuxMessageQueue(source.client.agentMessageQueuePath()),address={kind:'agent-session' as const,agentSessionId:'recipient',hostId:'remote'}
   await queue.claimMessageRoute({operationId,messageId,hostId:'remote',runtimeId:'legacy-runtime',agentSessionId:'recipient',expectedRun:{runId:'run-recipient'},target:address,intentDigest})
   await sourceServer.start();const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:sourceServer.path}})
   try{await expect(rpc.call('agent.send',{target:address,operationId,messageId,text,execution:'immediate'})).resolves.toMatchObject({envelope:{messageId,body:text,recipientSessionId:'recipient'}})}finally{await rpc.dispose()}
   expect((await queue.readMessageRoute(operationId,messageId))?.intentDigest).toBe(intentDigest)
   expect(target.inner.kernel.input).toHaveBeenCalledTimes(1)
  }finally{await targetRpc.dispose()}
 }finally{await sourceServer?.stop();await targetServer.stop();await target.close();await source.close()}
})
