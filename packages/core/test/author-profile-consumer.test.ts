import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { preparePublicUserProfile } from '../../../apps/host/src/public-author-profile.js'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { parseAgentInputMailboxItem } from '../src/agent-input-mailbox-codec.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
async function fixture() {
  const h = await rpcOwnerFixture(['recipient','other'], { AgentMuxClient, AgentMuxFileAgentSessionStore }); cleanup.push(h.close)
  h.inner.connected = false; h.inner.kernel.isConnected = () => false
  const profile = preparePublicUserProfile({ displayName: 'Original person', avatar: 'data:image/png;base64,' + png })!
  const input = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'profile-input', prompt: 'Original human words',
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, authorHuman: true, authorProfile: profile, sourceChannel: 'message-tool' as const }
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: input.expectedRun, submissionId: input.operationId }
  return { ...h, profile, input, key }
}
it('retains the original public human profile while waiting and exposes only exact avatar bytes through public input resources', async () => {
  const h = await fixture(); await h.client.submitAgentPrompt(h.input)
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  const request = { key: h.key, purpose: 'author-avatar' as const, index: 0, revision: h.profile.avatar!.revision, maxBytes: 1024 }
  const resource = await rpc.call('agent.input.resource', request, { principal: { kind: 'user', id: 'original-person' } })
  expect(resource).toMatchObject({ purpose: 'author-avatar', status: 'available', dataBase64: png })
  await h.client.submitAgentPrompt({ ...h.input, authorProfile: preparePublicUserProfile({ displayName: 'Changed profile' }) })
  const timeline = await h.client.sessionTimeline('recipient'), item = timeline.items.find(value => value.content === h.input.prompt)!
  expect(item.authorHuman).toBe(true); expect(item.authorProfile?.name).toBe('Original person')
  expect(JSON.stringify(item.authorProfile)).not.toContain(png)
  expect((await h.client.inspectAgentInput({ key: h.key }))?.status).toBe('waiting')
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect(await rpc.call('agent.input.resource', { ...request, key: { ...h.key, agentSessionId: 'other' } }, { principal: { kind: 'user', id: 'original-person' } })).toMatchObject({ status: 'unavailable' })
})
it('optional malformed display data keeps the original body and human role without publishing an avatar', async () => {
  const h = await fixture(); await h.client.submitAgentPrompt({ ...h.input, authorProfile: { name: 'Bad', avatar: { ...h.profile.avatar!, dataBase64: 'invalid' } } })
  expect((await h.client.inspectAgentInput({ key: h.key }))?.status).toBe('waiting')
  const item = (await h.client.sessionTimeline('recipient')).items.find(value => value.content === h.input.prompt)!
  expect(item.authorHuman).toBe(true); expect(item.content).toBe(h.input.prompt); expect(item.authorProfile?.avatar).toBeUndefined()
})

it('transfers only the original prepared human profile through authenticated Hosted input and exact public resource reads', async()=>{
 const h=await fixture(), path=join(h.root,'profile-hosted.sock'), service=new AgentMuxHostedRuntimeService(h.client,h.store.path,()=>hostedTestOwner(h.client));cleanup.push(()=>service.dispose())
 const server=new AgentMuxControlServer({socketPath:path,coreClients:h.coreClients,hostedRuntime:()=>service});await server.start();cleanup.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path}});cleanup.push(()=>rpc.dispose())
 const hosted=await connectHostedAgentMux({rpc,waitForReady:false});cleanup.push(()=>hosted.dispose())
 await hosted.submitAgentPrompt(h.input)
 expect((await hosted.sessionTimeline('recipient')).items.find(item=>item.content===h.input.prompt)).toMatchObject({authorHuman:true,authorProfile:{name:'Original person'}})
 expect(await hosted.readAgentInputResource({key:h.key,purpose:'author-avatar',index:0,revision:h.profile.avatar!.revision,maxBytes:1024})).toMatchObject({status:'available',dataBase64:png})
 expect(h.inner.kernel.input).not.toHaveBeenCalled()
})

it('keeps a recorded body and original author readable when optional persisted display data is damaged',async()=>{
 const h=await fixture();await h.client.submitAgentPrompt(h.input)
 const mailbox=await h.client.readAgentInputMailbox({agentSessionId:'recipient'}), entry=mailbox.items[0]!
 expect(entry.kind).toBe('item');if(entry.kind!=='item'||entry.item.kind!=='controlled')throw Error('Original controlled input required')
 const original=entry.item, damaged={...original,intent:{...original.intent,source:{...original.intent.source,authorProfile:{name:3,avatar:'invalid'}}}}
 const parsed=parseAgentInputMailboxItem(damaged,'recipient')
 expect(parsed).toMatchObject({kind:'controlled',intent:{source:{prompt:h.input.prompt,authorHuman:true}}})
 expect(parsed.kind==='controlled'&&parsed.intent.source.kind==='prompt' ? parsed.intent.source.authorProfile : undefined).toBeUndefined()
 expect((await h.client.sessionTimeline('recipient')).items.find(item=>item.content===h.input.prompt)?.authorHuman).toBe(true)
})

it('delivers the same persisted human Input after optional original display data is damaged without changing its body or control identity',async()=>{
 const h=await fixture();const saved=await h.client.submitAgentPrompt(h.input);if(!saved)throw Error('Original waiting receipt required')
 const page=await h.client.readAgentInputMailbox({agentSessionId:'recipient'}), entry=page.items[0]!
 if(entry.kind!=='item'||entry.item.kind!=='controlled')throw Error('Original persisted input required')
 // Deliberate storage fault in this exact isolated original row, not a new producer
 // or mutation of user data. All normal journal reads and original dispatch stay real.
 const db=new DatabaseSync(join(h.root,'messages.ndjson'))
 try{expect(db.prepare("UPDATE records SET json=json_set(json,'$.intent.source.authorProfile',json(?)) WHERE sequence=?").run(JSON.stringify({name:3}),entry.item.sequence).changes).toBe(1)}finally{db.close()}
 await h.client.stopAgentInputWaiting({ref:saved.ref,cancelOperationId:'stop-original-wait'})
 h.inner.connected=true;h.inner.kernel.isConnected=()=>true
 vi.spyOn(h.client,'connect').mockResolvedValue()
 vi.spyOn((h.client as any).screenEvidence,'wait').mockResolvedValue(120)
 await h.client.submitAgentPrompt({...h.input,authorProfile:preparePublicUserProfile({displayName:'Replacement must not win'})})
 await h.client.rejoinAgentInputWaiting({ref:saved.ref})
 await vi.waitFor(async()=>expect((await h.client.inspectAgentInput({key:h.key}))?.status).toBe('terminal-confirmed'))
 expect(h.inner.kernel.input).toHaveBeenCalled()
 const calls=(h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls
 expect(calls.map(call=>(call[1] as {data:string}).data).join('')).toContain(h.input.prompt)
 const record=(await h.client.sessionTimeline('recipient')).items.find(item=>item.content===h.input.prompt)!
 expect(record).toMatchObject({authorHuman:true,content:h.input.prompt,inputRef:h.key})
 expect(record.authorProfile?.name).toBeUndefined()
 expect((await h.client.readAgentInputMailbox({agentSessionId:'recipient'})).items).toHaveLength(1)
})
