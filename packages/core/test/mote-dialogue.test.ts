import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureEpoch } from './helpers/fixture-values.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { MoteDialogueStore } from '../src/mote-dialogue-store.js'
import { createHostMoteMainReader, createHostMoteDialogue } from '../../../apps/host/src/mote-dialogue.js'
import { createHostContent } from '../../../apps/host/src/content-owner.js'
import { HostMoteQuickPreferences } from '../../../apps/host/src/mote-quick-preferences.js'
import { spatialCatalog } from '../src/spatial-state.js'
import { MOTE_INPUT_GUIDANCE } from '../src/mote-input-source.js'
import { agentPromptSubmissionOutcome } from '../src/mote-dialogue.js'
import type { AgentPromptSubmissionRecord } from '../src/types.js'
import { createAgentInputContextCaptureRecord, type AgentInputContextCaptureReader, type AgentInputContextCaptureRecord } from '../src/agent-input-context-capture.js'
import { createMoteInputFixture, moteInputTestSource } from './helpers/mote-input-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { AgentMuxError } from '../src/errors.js'
import { composeAgentResumePrompt } from '../src/agent-outbound-message.js'
import { defineRun } from '@ctxmux/sdk'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(captures?: AgentInputContextCaptureReader) {
  const f = await createMoteInputFixture(); closes.push(f.close)
  const target = { spaceId: moteInputTestSource.spaceId, zoneId: moteInputTestSource.zoneId,
    expectedResource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: join(f.root, 'scratch') } }
  const content = createHostContent({ configurationPath: join(f.root, 'configuration.json'), spatial: f.spatial })
  const main = createHostMoteMainReader({ configurationPath: join(f.root, 'configuration.json'), spatial: f.spatial, files: content.files! })
  const store = new MoteDialogueStore(join(f.root, 'dialogue.sqlite'))
  const dialogue = createHostMoteDialogue({ main, spatial: f.spatial, store, clientForHost: hostId => {
    if (hostId !== 'local') throw Error('No original remote Host in this fixture'); return f.client
  } })
  const quick = new HostMoteQuickPreferences({ main, files: content.files!, recordMainSource: dialogue.recordMainSource,
    catalog: async () => spatialCatalog((await f.spatial.read())!.graph), executors: async () => [] })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'dialogue.sock'), coreClients: f.coreClients, moteDialogue: dialogue, moteQuickPreferences: quick,
    ...(captures ? {inputContextCaptures:captures} : {}) })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const cli = async (args: string[], input?: unknown, sessionId = 'primary') => {
    const r = await runSourceObjectCli(['--endpoint', 'unix://' + server.path, ...args], objectCliEnvironment(f.root,
      { AGENTMUX_AGENT_SESSION_ID: sessionId, AGENTMUX_AGENT_CAPABILITY: f.capability }), input === undefined ? '' : JSON.stringify(input), 30_000,
      new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
    expect(r.code, r.stdout + r.stderr).toBe(0); return JSON.parse(r.stdout).result
  }
  return { ...f, target, main, store, dialogue, quick, rpc, cli }
}

async function switchMain(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, operationId: string) {
  const saved=await f.rpc.call('space.mote.preferences.read',{kind:'quick',target:f.target})
  if(saved.kind!=='quick'||!saved.defaults||!saved.source?.resource||saved.source.result.status!=='read')throw Error('Nonempty original File baseline')
  const reference=saved.choices.conversations.find(choice=>choice.reference.sessionId===sessionId)!.reference
  const {hostId:_host,sessionId:_id,...location}=reference
  const result=await f.rpc.call('space.mote.preferences.save',{kind:'quick',target:f.target,operationId,
    baseline:{resource:saved.source.resource,document:saved.source.result.document,defaults:saved.defaults},
    values:{...saved.defaults,conversation:reference},destination:{kind:'occurrence',...location}})
  expect(result.status,result.message??'').toBe('saved')
  return result
}

it('actual CLI main dispatch links the exact original work thread and reads without reexecuting input', async () => {
  const f = await fixture(), read = await f.rpc.call('space.mote.dialogue.read', { target: f.target })
  expect(read.main.identity).toEqual({ hostId: 'local', moteId: 'AbCdEfGh1234' })
  expect(read.main.current?.sessionId).toBe('primary'); expect(read.links).toEqual([])
  expect(read.coverage).toBe('linked-sources-only')
  await expect(stat(f.store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.cli(['agent','send','--to-session','member','--text','Original scoped work','--operation-id','dispatch-op',
    '--message-id','original-work','--thread','original-thread','--execution','immediate','--expect-run','run-member'])
  await f.cli(['message','dispatch','open','--source-message','original-work'])
  const count = f.writes.length
  const linked = await f.cli(['space','mote','dialogue','link','--input','-'], { target: f.target, operationId: 'link-original',
    expectedRoleRevision: read.main.roleRevision, source: { kind: 'work', messageHostId: 'local', messageId: 'original-work' } })
  expect(linked.links).toHaveLength(1)
  expect(linked.links[0]).toMatchObject({ kind: 'work', identity: read.main.identity, main: { hostId: 'local', agentSessionId: 'primary' },
    origin: { hostId: 'local', messageId: 'original-work', threadId: 'original-thread', senderSessionId: 'primary', recipientSessionId: 'member' } })
  const page = await f.cli(['space','mote','dialogue','read','--input','-'], { target: f.target, kind: 'work', eventId: linked.links[0].eventId })
  expect(page.links).toEqual(linked.links)
  const original = await f.client.readMessage({ messageId: page.links[0].origin.messageId })
  expect(original?.envelope.body).toBe('Original scoped work')
  expect((await f.client.readDispatch({ sourceMessageId: 'original-work' }))?.dispatch.threadId).toBe('original-thread')
  expect(f.writes).toHaveLength(count); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('actual original Files CAS preserves A and B main sources, while interval edits retain the role generation', async () => {
  const f = await fixture(), before = await f.rpc.call('space.mote.dialogue.read', { target: f.target })
  const saved = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  expect(saved.kind).toBe('quick')
  if (saved.kind !== 'quick' || !saved.defaults || !saved.source?.resource || saved.source.result.status !== 'read') throw Error('Nonempty original MOTE baseline required')
  const next = { hostId: 'local', sessionId: 'member', displayWorkspaceId: '__scratch__', groupId: 'group', tabId: 'tab-member', regionId: 'region-member' }
  const changed = await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'switch-original',
    baseline: { resource: saved.source.resource, document: saved.source.result.document, defaults: saved.defaults },
    values: { ...saved.defaults, conversation: next }, destination: { kind: 'occurrence', displayWorkspaceId: next.displayWorkspaceId, groupId: next.groupId, tabId: next.tabId, regionId: next.regionId } })
  expect(changed.status, changed.message ?? '').toBe('saved')
  const page = await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })
  expect(page.main.current).toEqual(next); expect(page.main.roleRevision).not.toBe(before.main.roleRevision)
  expect(page.links.map(link => link.kind === 'main' ? link.reference.sessionId : '')).toEqual(['member','primary'])
  expect(page.links.every(link => link.kind === 'main' && link.range === 'whole-session')).toBe(true)
  await expect(f.main.assertCurrent(before.main)).rejects.toMatchObject({ code: 'MOTE_MAIN_CHANGED' })
  const baseline = await f.quick.read({ kind:'quick', target: f.target })
  if (!baseline.source?.resource || baseline.source.result.status !== 'read' || !baseline.defaults) throw Error('Original baseline')
  const interval = await f.quick.save({ kind:'quick', target:f.target, operationId:'interval-only', baseline:{resource:baseline.source.resource,document:baseline.source.result.document,defaults:baseline.defaults},
    values:{...baseline.defaults,presence:{enabled:true,intervalMs:3_600_000}}, destination:{kind:'occurrence',displayWorkspaceId:next.displayWorkspaceId,groupId:next.groupId,tabId:next.tabId,regionId:next.regionId} })
  expect(interval.status).toBe('saved'); await expect(f.main.assertCurrent(page.main)).resolves.toBeUndefined()
  expect((await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main'})).links).toEqual(page.links)
  expect(f.writes).toEqual([]); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('same original association operation remains readable after current role changes and refuses a conflicting source', async () => {
  const f=await fixture(), snapshot=await f.main.readCurrentMoteMain(f.target)
  const input={target:f.target,operationId:'original-link',expectedRoleRevision:snapshot.roleRevision!,source:{kind:'main' as const}}
  const linked=await f.rpc.call('space.mote.dialogue.link',input)
  await switchMain(f,'member','change-after-original-link')
  const bytes=await readFile(f.store.path)
  await expect(f.rpc.call('space.mote.dialogue.link',{...input,expectedRoleRevision:'forged-later'})).rejects.toMatchObject({code:'MOTE_DIALOGUE_OPERATION_CONFLICT'})
  expect(await f.rpc.call('space.mote.dialogue.link',input)).toEqual(linked)
  expect(await readFile(f.store.path)).toEqual(bytes)
  expect((await f.rpc.call('space.mote.dialogue.read',{target:f.target,operationId:'original-link'})).links).toEqual(linked.links)
  expect(f.writes).toEqual([])
})

it('bounded original-source pages freeze their journal boundary and reject another Mote or journal cursor', async () => {
  const f=await fixture(), snapshot=await f.main.readCurrentMoteMain(f.target)
  for(let i=0;i<4;i++)await f.rpc.call('space.mote.dialogue.link',{target:f.target,operationId:'page-'+i,expectedRoleRevision:snapshot.roleRevision!,source:{kind:'main'}})
  const page=await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main',limit:2})
  expect(page.links).toHaveLength(2);expect(page.next).not.toBeNull()
  await f.rpc.call('space.mote.dialogue.link',{target:f.target,operationId:'later-page',expectedRoleRevision:snapshot.roleRevision!,source:{kind:'main'}})
  const older=await f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main',limit:2,cursor:page.next!})
  expect(older.links.map(link=>link.sequence)).toEqual([2,1]);expect(older.throughSequence).toBe(page.throughSequence)
  await expect(f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main',cursor:{...page.next!,identity:{hostId:'foreign',moteId:snapshot.identity!.moteId}}})).rejects.toMatchObject({code:'MOTE_DIALOGUE_SOURCE_CHANGED'})
  await expect(f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'main',cursor:{...page.next!,incarnation:'other-journal'}})).rejects.toMatchObject({code:'MOTE_DIALOGUE_SOURCE_CHANGED'})
  await expect(f.rpc.call('space.mote.dialogue.read',{target:f.target,kind:'work',cursor:page.next!})).rejects.toMatchObject({code:'MOTE_DIALOGUE_SOURCE_CHANGED'})
  expect(f.writes).toEqual([])
})

it('wrong role, Host and missing original message refuse only the association and preserve healthy input', async () => {
  const f=await fixture(), snapshot=await f.main.readCurrentMoteMain(f.target)
  await expect(f.rpc.call('space.mote.dialogue.link',{target:f.target,operationId:'wrong-role',expectedRoleRevision:'different-generation',source:{kind:'main'}})).rejects.toMatchObject({code:'MOTE_MAIN_CHANGED'})
  await expect(f.rpc.call('space.mote.dialogue.link',{target:f.target,operationId:'wrong-host',expectedRoleRevision:snapshot.roleRevision!,source:{kind:'work',messageHostId:'foreign-host',messageId:'same-id'}})).rejects.toMatchObject({code:'MOTE_DIALOGUE_SOURCE_UNCONFIRMED'})
  await expect(f.rpc.call('space.mote.dialogue.link',{target:f.target,operationId:'no-message',expectedRoleRevision:snapshot.roleRevision!,source:{kind:'work',messageHostId:'local',messageId:'missing-original'}})).rejects.toMatchObject({code:'MOTE_DIALOGUE_SOURCE_UNCONFIRMED'})
  expect((await f.rpc.call('space.mote.dialogue.read',{target:f.target})).links).toEqual([])
  const input=await f.submit('healthy-after-bad-association')
  expect(input.moteObservationId).toBe(f.observation('healthy-after-bad-association'))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a real main-role CAS preserves an older input and its original confirmed or unavailable observation', async () => {
  const f=await fixture();f.loseNotice()
  await f.submit('unknown-before-switch'); f.idle(); await f.settle()
  await vi.waitFor(async()=>expect((await f.read('unknown-before-switch')).inspection?.observation.sourceStatus).not.toBe('pending'),{timeout:15_000})
  const captured=(await f.read('unknown-before-switch')).inspection!
  if(captured.observation.sourceStatus==='confirmed') {
    await vi.waitFor(async()=>expect((await f.read('unknown-before-switch')).inspection?.notices.input?.state).toBe('unconfirmed'),{timeout:15_000})
    expect(captured.observation.binding?.primary.agentSessionId).toBe('primary')
  } else {
    expect(captured.observation.sourceStatus).toBe('unavailable');expect(captured.observation.binding).toBeNull();expect(captured.observation.issue).toBeTruthy()
  }
  const original=(await f.read('unknown-before-switch')).inspection!,count=f.writes.length
  expect(original.observation.input).toBe('admitted')
  await switchMain(f,'member','switch-with-unknown')
  await f.settle()
  const current=(await f.read('unknown-before-switch')).inspection!
  expect(current.observation.binding).toEqual(original.observation.binding)
  expect(current.notices.input).toEqual(original.notices.input)
  expect(f.writes).toHaveLength(count)
  expect((await f.rpc.call('space.mote.dialogue.read',{target:f.target})).main.current?.sessionId).toBe('member')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the original indexed source journal survives two different reader processes without copying conversation bodies', async () => {
  const f=await fixture(), snapshot=await f.main.readCurrentMoteMain(f.target)
  const linked=await f.rpc.call('space.mote.dialogue.link',{target:f.target,operationId:'persistent-source',expectedRoleRevision:snapshot.roleRevision!,source:{kind:'main'}})
  expect(linked.links.length).toBeGreaterThan(0)
  const loader=new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs',import.meta.url).href
  const entry=new URL('../src/mote-dialogue-store.ts',import.meta.url).href
  const registration=`import {register} from 'node:module';register(${JSON.stringify(loader)});`
  const script=`import {MoteDialogueStore} from ${JSON.stringify(entry)};const [path,identity,query]=process.argv.slice(1);console.log(JSON.stringify({pid:process.pid,page:await new MoteDialogueStore(path).read(JSON.parse(identity),JSON.parse(query))}));`
  const pids:number[]=[]
  const originalBytes=await readFile(f.store.path)
  for(let i=0;i<2;i++){
    const result=await new Promise<{pid:number;page:{links:unknown[]}}>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(registration),'--input-type=module','--eval',script,
        f.store.path,JSON.stringify(snapshot.identity),JSON.stringify({target:f.target})],{env:objectCliEnvironment(f.root),stdio:['ignore','pipe','pipe']})
      let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value)
      child.once('error',reject);child.once('close',code=>{if(code!==0)return reject(Error(stderr));try{resolve(JSON.parse(stdout))}catch(error){reject(error)}})
    })
    expect(result.pid).not.toBe(process.pid);pids.push(result.pid);expect(result.page.links).toEqual(linked.links)
  }
  expect(new Set(pids).size).toBe(2);expect(await readFile(f.store.path)).toEqual(originalBytes)
  expect(f.writes).toEqual([]);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a source journal observation failure keeps the exact current main and healthy original input available', async () => {
  const f=await fixture(), snapshot=await f.main.readCurrentMoteMain(f.target)
  await f.rpc.call('space.mote.dialogue.link',{target:f.target,operationId:'source-before-fault',expectedRoleRevision:snapshot.roleRevision!,source:{kind:'main'}})
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(f.store.path)
  db.prepare('UPDATE links SET json=?').run('{original damaged source bytes');db.close()
  const page=await f.rpc.call('space.mote.dialogue.read',{target:f.target})
  expect(page.sourceStatus).toBe('unconfirmed');expect(page.sourceIssue).toBeTruthy()
  expect(page.main.current).toEqual(snapshot.current);expect(page.main.status).toBe('ready')
  expect((await f.submit('healthy-with-source-gap')).moteObservationId).toBe(f.observation('healthy-with-source-gap'))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

function mainPrompt(roleRevision: string, target: Awaited<ReturnType<typeof fixture>>['target'], operationId: string) {
  return {target,expectedRoleRevision:roleRevision,input:{agentSessionId:'primary',operationId,prompt:'Original main input '+operationId,
    expectedRun:{runId:'run-primary'},admissionIntent:{kind:'native-conversation' as const,source:{providerId:'codex',nativeSessionId:'primary-native'}},execution:'immediate' as const}}
}

it('logical main input rejects a stale first send after a completed role switch and retains ordinary member input', async()=>{
  const f=await fixture(),main=await f.main.readCurrentMoteMain(f.target),request=mainPrompt(main.roleRevision!,f.target,'stale-main-draft')
  await switchMain(f,'member','switch-before-first-main-input')
  await expect(f.rpc.call('space.mote.dialogue.input.submit',request)).rejects.toMatchObject({code:'MOTE_MAIN_CHANGED'})
  expect(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:request.input.operationId})).toEqual({route:null,record:null,input:null})
  await switchMain(f,'primary','return-to-primary-with-new-role-generation')
  await expect(f.rpc.call('space.mote.dialogue.input.submit',request)).rejects.toMatchObject({code:'MOTE_MAIN_CHANGED'})
  expect(f.writes).toEqual([])
  expect((await f.submit('ordinary-member-after-main-switch')).moteObservationId).toBe(f.observation('ordinary-member-after-main-switch'))
  expect(f.writes.some(row=>row.key?.agentSessionId==='member')).toBe(true)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('logical main input freezes an unknown original through actual CLI intake, role switch and another journal reader process',async()=>{
  const f=await fixture(),main=await f.main.readCurrentMoteMain(f.target),request=mainPrompt(main.roleRevision!,f.target,'unknown-main-original')
  f.loseNotice()
  const originalSubmit=vi.spyOn(f.client,'submitAgentPrompt')
  const cli=await runSourceObjectCli(['--endpoint','unix://'+join(f.root,'dialogue.sock'),'space','mote','dialogue','input','submit','--input','-'],objectCliEnvironment(f.root),JSON.stringify(request),30_000,new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs',import.meta.url))
  expect(cli.code,cli.stdout+cli.stderr).toBe(0)
  const accepted=JSON.parse(cli.stdout).result as import('../src/mote-dialogue.js').MoteDialogueInputInspection
  expect(accepted.input?.status).toBe('unknown')
  await vi.waitFor(async()=>{const claim=(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:request.input.operationId})).record?.admission;expect(claim?.transport==='native'?claim.native.outcome:null).toBe('unknown')},{timeout:15_000})
  const original=await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:request.input.operationId})
  expect(original.route).toMatchObject({identity:main.identity,roleRevision:main.roleRevision,reference:main.current,key:{kind:'prompt',agentSessionId:'primary',expectedRun:{runId:'run-primary'},submissionId:request.input.operationId}})
  expect(original.input?.status).toBe('unknown');expect(original.record?.admission).toBeTruthy()
  const producer=original.record?.admission?.intent?.message
  expect(producer?.userContent).toBe(request.input.prompt)
  expect(producer?.systemContext).toBe(MOTE_INPUT_GUIDANCE)
  expect(producer?.authorHuman).toBe(true)
  expect(producer?.inputContext).toBeUndefined()
  expect(f.writes).toHaveLength(1)
  const count=f.writes.length
  await switchMain(f,'member','switch-after-unknown-main-intake')
  expect(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:request.input.operationId})).toEqual(original)
  expect(await f.rpc.call('space.mote.dialogue.input.submit',request)).toEqual(original)
  await expect(f.rpc.call('space.mote.dialogue.input.submit',{...request,input:{...request.input,prompt:'Retargeted body'}})).rejects.toMatchObject({code:'AGENT_PROMPT_OPERATION_CONFLICT'})
  const loader=new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs',import.meta.url).href,entry=new URL('../src/agent-global-message-queue.ts',import.meta.url).href
  const registration=`import {register} from 'node:module';register(${JSON.stringify(loader)});`
  const script=`import {DurableAgentMuxMessageQueue} from ${JSON.stringify(entry)};const [path,identity,operationId]=process.argv.slice(1);console.log(JSON.stringify({pid:process.pid,route:await new DurableAgentMuxMessageQueue(path).readMoteMainInputRoute(JSON.parse(identity),operationId)}));`
  const read=await new Promise<{pid:number;route:unknown}>((resolve,reject)=>{const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(registration),'--input-type=module','--eval',script,f.client.agentMessageQueuePath(),JSON.stringify(main.identity),request.input.operationId],{env:objectCliEnvironment(f.root),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.once('error',reject);child.once('close',code=>{if(code!==0)return reject(Error(stderr));try{resolve(JSON.parse(stdout))}catch(error){reject(error)}})})
  expect(read.pid).not.toBe(process.pid);expect(read.route).toEqual(original.route)
  expect(originalSubmit).toHaveBeenCalledTimes(1)
  expect(f.writes).toHaveLength(count);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('logical main input rejects wire authorship and managed prompt impersonation while original agent.send stays available',async()=>{
  const f=await fixture(),main=await f.main.readCurrentMoteMain(f.target),request=mainPrompt(main.roleRevision!,f.target,'actor-conflict')
  await expect(f.rpc.call('space.mote.dialogue.input.submit',{...request,input:{...request.input,authorHuman:true}} as never)).rejects.toBeTruthy()
  const managed=await connectAgentMuxRpc({endpoint:{transport:'unix',path:join(f.root,'dialogue.sock')},credentials:{agentSessionId:'primary',capability:f.capability}})
  closes.push(()=>managed.dispose())
  await expect(managed.call('space.mote.dialogue.input.submit',request)).rejects.toMatchObject({code:'MANAGED_AGENT_PROMPT_FORBIDDEN'})
  await expect(managed.call('agent.input.submit',{...request.input,moteGuidance:true})).rejects.toMatchObject({code:'MANAGED_AGENT_PROMPT_FORBIDDEN'})
  expect(f.writes).toEqual([])
  await f.cli(['agent','send','--to-session','member','--text','Still authorized original Agent message','--operation-id','allowed-agent-message','--message-id','allowed-original-message','--execution','immediate','--expect-run','run-member'])
  const allowed=await f.client.readMessage({messageId:'allowed-original-message'})
  expect(allowed?.envelope).toMatchObject({senderSessionId:'primary',recipientSessionId:'member',operationId:'allowed-agent-message'})
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})


it('logical main input preserves a legacy unknown producer without adding guidance or another native submission',async()=>{
  const f=await fixture(),main=await f.main.readCurrentMoteMain(f.target),request=mainPrompt(main.roleRevision!,f.target,'legacy-unknown-main')
  f.loseNotice()
  await f.rpc.call('agent.input.submit',request.input)
  await vi.waitFor(async()=>{const original=await f.client.inspectAgentPromptSubmission({kind:'prompt',agentSessionId:'primary',expectedRun:{runId:'run-primary'},submissionId:request.input.operationId});expect(original?.admission?.transport==='native'?original.admission.native.outcome:null).toBe('unknown')},{timeout:15_000})
  const previous=await f.client.inspectAgentInput({key:{kind:'prompt',agentSessionId:'primary',expectedRun:{runId:'run-primary'},submissionId:request.input.operationId}}),count=f.writes.length
  expect(previous?.status).toBe('unknown');expect(previous?.admission?.admission?.intent?.message.systemContext).toBeUndefined()
  await expect(f.rpc.call('space.mote.dialogue.input.submit',request)).rejects.toMatchObject({code:'MOTE_MAIN_INPUT_PREEXISTING'})
  expect(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:request.input.operationId})).toEqual({route:null,record:null,input:null})
  expect(await f.client.inspectAgentInput({key:previous!.key})).toEqual(previous)
  expect(f.writes).toHaveLength(count);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a frozen main route with no original receipt remains unconfirmed and never resubmits through another request',async()=>{
  const f=await fixture(),main=await f.main.readCurrentMoteMain(f.target),request=mainPrompt(main.roleRevision!,f.target,'route-without-input-receipt')
  const original=vi.spyOn(f.client,'submitAgentPrompt').mockRejectedValueOnce(new Error('Original input owner reply unavailable'))
  await expect(f.rpc.call('space.mote.dialogue.input.submit',request)).rejects.toBeTruthy()
  const inspection=await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:request.input.operationId})
  expect(inspection.route?.key.submissionId).toBe(request.input.operationId);expect(inspection.record).toBeNull();expect(inspection.input).toBeNull()
  await switchMain(f,'member','switch-with-frozen-empty-route')
  expect(await f.rpc.call('space.mote.dialogue.input.submit',request)).toEqual(inspection)
  expect(original).toHaveBeenCalledTimes(1);expect(f.writes).toEqual([]);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

const browserContext = () => ({kind:'browser' as const,version:1 as const,capturedAt:fixtureEpoch(2),
  browser:{hostId:'local',browserId:'original-browser',navigationId:'original-navigation'},page:{url:'https://original.invalid/page',title:'Original captured page'},
  activity:{operationId:'original-browser-operation',stepSequence:2,phase:'running' as const,observedAt:fixtureEpoch(2) - 1_000}})

it('logical main input preserves the original proof-bound Browser packet through the actual execution owner and a role change',async()=>{
  const captures=new Map<string,AgentInputContextCaptureRecord>(),read=vi.fn(async(reference:{hostId:string;operationId:string})=>({reference,record:captures.get(reference.operationId)??null,diskDurability:'confirmed' as const}))
  const f=await fixture({read}),main=await f.main.readCurrentMoteMain(f.target),base=mainPrompt(main.roleRevision!,f.target,'original-captured-main')
  const capturedContext={reference:{hostId:'local',operationId:base.input.operationId},agentMuxNote:'Original frozen platform note'}
  captures.set(base.input.operationId,createAgentInputContextCaptureRecord({reference:capturedContext.reference,
    binding:{executionHostId:'local',agentSessionId:base.input.agentSessionId,originRun:base.input.expectedRun},prompt:base.input.prompt,
    agentMuxNote:capturedContext.agentMuxNote,inputContext:browserContext()}))
  const request={...base,input:{...base.input,capturedContext}}
  const accepted=await f.rpc.call('space.mote.dialogue.input.submit',request)
  expect(accepted.input).not.toBeNull()
  await vi.waitFor(async()=>expect((await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:base.input.operationId})).record?.admission?.intent?.message.inputContext).toEqual(browserContext()),{timeout:15_000})
  const original=await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:base.input.operationId})
  expect(original.record?.admission?.intent?.message.systemContext).toBe(capturedContext.agentMuxNote)
  expect(original.record?.admission?.intent?.message.userContent).toBe(base.input.prompt)
  const transport=mainPrompt(main.roleRevision!,f.target,'original-generic-captured-input')
  const packet={reference:{hostId:'local',operationId:transport.input.operationId},agentMuxNote:'Original transport capture note'}
  captures.set(transport.input.operationId,createAgentInputContextCaptureRecord({reference:packet.reference,
    binding:{executionHostId:'local',agentSessionId:transport.input.agentSessionId,originRun:transport.input.expectedRun},prompt:transport.input.prompt,
    agentMuxNote:packet.agentMuxNote,inputContext:browserContext()}))
  const forwardedInput={...transport.input,capturedContext:packet,sourceChannel:'message-tool' as const}
  const forwarded=await f.rpc.call('agent.input.submit',forwardedInput)
  expect(forwarded.input).not.toBeNull()
  await vi.waitFor(async()=>expect((await f.client.inspectAgentPromptSubmission(forwarded.key))?.admission?.intent?.message).toMatchObject({
    userContent:transport.input.prompt,systemContext:packet.agentMuxNote,inputContext:browserContext(),inputContextSource:'host-capture',sourceChannel:'message-tool'}),{timeout:15_000})
  const nativeWrites=f.writes.length
  const repeated=await f.rpc.call('agent.input.submit',forwardedInput)
  expect(repeated.record?.admission?.intent?.message).toMatchObject({userContent:transport.input.prompt,systemContext:packet.agentMuxNote,inputContext:browserContext(),inputContextSource:'host-capture'})
  expect(f.writes).toHaveLength(nativeWrites)
  const count=f.writes.length,reads=read.mock.calls.length
  await switchMain(f,'member','switch-after-captured-main')
  expect(await f.rpc.call('space.mote.dialogue.input.submit',request)).toEqual(original)
  expect(read).toHaveBeenCalledTimes(reads);expect(f.writes).toHaveLength(count);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a replaced Browser note or unavailable capture rejects only that exact packet before any main route or native submission',async()=>{
  const captures=new Map<string,AgentInputContextCaptureRecord>(),read=vi.fn(async(reference:{hostId:string;operationId:string})=>({reference,record:captures.get(reference.operationId)??null,diskDurability:'confirmed' as const}))
  const f=await fixture({read}),main=await f.main.readCurrentMoteMain(f.target),base=mainPrompt(main.roleRevision!,f.target,'conflicting-captured-main')
  const reference={hostId:'local',operationId:base.input.operationId}
  captures.set(base.input.operationId,createAgentInputContextCaptureRecord({reference,binding:{executionHostId:'local',agentSessionId:base.input.agentSessionId,originRun:base.input.expectedRun},
    prompt:base.input.prompt,agentMuxNote:'Original note',inputContext:browserContext()}))
  await expect(f.rpc.call('space.mote.dialogue.input.submit',{...base,input:{...base.input,capturedContext:{reference,agentMuxNote:'Replaced note'}}})).rejects.toMatchObject({code:'AGENT_INPUT_CONTEXT_CAPTURE_CONFLICT'})
  await expect(f.rpc.call('space.mote.dialogue.input.submit',{...base,input:{...base.input,capturedContext:{agentMuxNote:'No original reference'}}} as never)).rejects.toBeTruthy()
  await expect(f.rpc.call('space.mote.dialogue.input.submit',{...base,input:{...base.input,agentMuxNote:'Standalone note'}} as never)).rejects.toBeTruthy()
  captures.clear()
  await expect(f.rpc.call('space.mote.dialogue.input.submit',{...base,input:{...base.input,capturedContext:{reference,agentMuxNote:'Original note'}}})).rejects.toMatchObject({code:'AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED'})
  expect(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:base.input.operationId})).toEqual({route:null,record:null,input:null})
  expect(f.writes).toEqual([])
  expect((await f.submit('healthy-after-capture-fault')).moteObservationId).toBe(f.observation('healthy-after-capture-fault'))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

function endedMainRuntime(f: Awaited<ReturnType<typeof fixture>>, options: {prepare?: () => Promise<void>;lostStart?:boolean} = {}) {
  const core=f.client as any,provider=f.client.providers.get('codex'),started:Array<{program:string;args:string[];operationKey:string}>=[]
  const recovered={runId:'recovered-original-main'},current=()=>({...f.run(recovered.runId),program:started[0]?.program??provider.executable,
    args:started[0]?.args??[],lifecycleOperationId:started[0]?.operationKey??null})
  const initialStatus=core.kernel.status
  core.kernel.launchIdentity=({program,args}:{program:string;args:readonly string[]})=>({program,argsDigest:createHash('sha256').update(JSON.stringify(args)).digest('base64url')})
  core.kernel.prepareStart=({program,args,cwd,env}:any)=>defineRun(program,{args,cwd,env,initialSize:{cols:80,rows:24}})
  core.kernel.creationRuntimeIdentity=()=>({runtimeId:'original-main-fixture-runtime',instanceId:'original-main-fixture',protocolVersion:18,buildIdentity:'fixture'})
  core.kernel.status=vi.fn(async(id:string)=>id==='run-primary'?{...f.run(id),state:{type:'exited',code:0,signal:null}}:id===recovered.runId?current():await initialStatus(id))
  core.kernel.list=vi.fn(async()=>started.length?[current()]:[])
  core.kernel.inspectCreation=vi.fn(async(operationKey:string)=>started[0]?.operationKey===operationKey?current():null)
  core.kernel.start=vi.fn(async(spec:any)=>{started.push(spec);if(options.lostStart)throw new AgentMuxError('Original Start ACK unavailable','CTXMUX_START_UNKNOWN',undefined,{disposition:'unknown',confirmedInputBytes:null});return current()})
  core.kernel.startPrepared=vi.fn(async(request:any,operationKey:string)=>await core.kernel.start({...request,operationKey}))
  core.kernel.inspectPreparedStart=vi.fn(async(request:any,operationKey:string,_run:unknown,expected:any)=>{
    const spec=started.find(row=>row.operationKey===operationKey)
    if(!spec)return null
    const{operationKey:_operationKey,...original}=spec
    expect(expected.runtimeId).toBe(core.kernel.creationRuntimeIdentity().runtimeId);expect(request).toEqual(original)
    return current()
  })
  f.client.providers.replace({...provider,prepareManagedLaunch:async(plan:any)=>{await options.prepare?.();return{plan}}})
  core.ensureTerminalHandshakeOrDegrade=async(session:any)=>session
  core.hookServer.isRunning=()=>true
  core.hookServer.createBinding=(_agent:string,_provider:string,bindingId:string)=>({bindingId,endpoint:{url:'http://127.0.0.1:0',token:'token'.padEnd(43,'T')},bindRun:async()=>{},close:async()=>{}})
  vi.spyOn(core.screenEvidence,'wait').mockResolvedValue(1)
  return{core,started,recovered,provider}
}

it('a captured main recovery is admitted once before a role switch and keeps the original native launch carrier and packet',async()=>{
  const captures=new Map<string,AgentInputContextCaptureRecord>(),f=await fixture({read:async(reference)=>({reference,record:captures.get(reference.operationId)??null,diskDurability:'confirmed'})})
  const main=await f.main.readCurrentMoteMain(f.target),base=mainPrompt(main.roleRevision!,f.target,'captured-ended-original-main')
  const capturedContext={reference:{hostId:'local',operationId:base.input.operationId},agentMuxNote:'Original ended Browser packet note'}
  captures.set(base.input.operationId,createAgentInputContextCaptureRecord({reference:capturedContext.reference,binding:{executionHostId:'local',agentSessionId:base.input.agentSessionId,originRun:base.input.expectedRun},
    prompt:base.input.prompt,agentMuxNote:capturedContext.agentMuxNote,inputContext:browserContext()}))
  let release!:()=>void,preparing!:()=>void
  const startedPrepare=new Promise<void>(resolve=>{preparing=resolve}),hold=new Promise<void>(resolve=>{release=resolve})
  const runtime=endedMainRuntime(f,{prepare:async()=>{preparing();await hold}}),ensure=vi.spyOn(f.client,'ensureAgentContinuity')
  const request={...base,input:{...base.input,admissionIntent:{kind:'manual-actor' as const},capturedContext,sourceChannel:'message-tool' as const},recovery:{operationId:'original-main-input-recovery'}}
  const sending=f.rpc.call('space.mote.dialogue.input.submit',request)
  await startedPrepare
  await switchMain(f,'member','role-switch-after-recovery-admission')
  release()
  const accepted=await sending
  expect(accepted.route).toMatchObject({reference:main.current,key:{expectedRun:base.input.expectedRun},recoveryOperationId:request.recovery.operationId})
  expect(accepted.recovery?.kind,JSON.stringify({reason:accepted.recovery?.reason,error:accepted.recovery?.error,errorCode:accepted.recovery?.errorCode})).toBe('resumed')
  expect(accepted.recovery).toMatchObject({agentSessionId:'primary',previousRun:base.input.expectedRun,newRun:runtime.recovered})
  expect(accepted.input).toBeNull()
  expect(agentPromptSubmissionOutcome(accepted.record)).toBe('launch-carried')
  expect(accepted.record?.launch).toMatchObject({state:'launch-carried',delivery:'launch',key:{agentSessionId:'primary',expectedRun:runtime.recovered,submissionId:base.input.operationId},
    input:{prompt:base.input.prompt,agentMuxNote:capturedContext.agentMuxNote,inputContextCapture:capturedContext.reference,sourceChannel:'message-tool'},
    message:{userContent:base.input.prompt,sourceChannel:'message-tool',systemContext:composeAgentResumePrompt(base.input.prompt,capturedContext.agentMuxNote,browserContext()).systemContext,inputContext:browserContext(),inputContextSource:'host-capture',
      inputContextCaptureProof:{binding:{originRun:base.input.expectedRun}}},receipt:{kind:'runtime-launch',run:runtime.recovered}})
  const args=runtime.provider.buildResumeLaunch({workspacePath:f.root,nativeHandle:{kind:'provider',providerId:'codex',sessionId:'primary-native'},args:[],env:{},
    prompt:composeAgentResumePrompt(base.input.prompt,capturedContext.agentMuxNote,browserContext()).text}).args
  expect(runtime.started[0]?.args).toEqual(args)
  expect(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:base.input.operationId})).toEqual(accepted)
  expect(await f.rpc.call('space.mote.dialogue.input.submit',request)).toEqual(accepted)
  expect(ensure).toHaveBeenCalledTimes(1);expect(runtime.started).toHaveLength(1);expect(f.writes).toEqual([]);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a stale captured recovery and an unknown original Start never become a later main input or another launch',async()=>{
  const f=await fixture(),main=await f.main.readCurrentMoteMain(f.target),runtime=endedMainRuntime(f,{lostStart:true}),ensure=vi.spyOn(f.client,'ensureAgentContinuity')
  const stale={...mainPrompt(main.roleRevision!,f.target,'stale-ended-main'),recovery:{operationId:'stale-main-recovery'}}
  const directed={...stale,input:{...stale.input,admissionIntent:{kind:'native-conversation' as const,source:{providerId:'codex',nativeSessionId:'foreign-native-target'}}}}
  for(const admissionIntent of [directed.input.admissionIntent,{...directed.input.admissionIntent,expectedTurnId:'foreign-turn'},{kind:'session-conversation' as const}])
    await expect(f.rpc.call('space.mote.dialogue.input.submit',{...directed,input:{...directed.input,admissionIntent}})).rejects.toMatchObject({code:'MOTE_MAIN_RECOVERY_INTENT_MISMATCH'})
  const{admissionIntent:_nativeTarget,...conditioned}=directed.input
  await expect(f.rpc.call('space.mote.dialogue.input.submit',{...directed,input:{...conditioned,afterSubmissionId:'original-condition'}})).rejects.toMatchObject({code:'MOTE_MAIN_RECOVERY_INTENT_MISMATCH'})
  expect(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:directed.input.operationId})).toEqual({route:null,record:null,input:null})
  const manualStale={...stale,input:{...stale.input,admissionIntent:{kind:'manual-actor' as const}}}
  await switchMain(f,'member','switch-before-recovery-admission')
  await expect(f.rpc.call('space.mote.dialogue.input.submit',manualStale)).rejects.toMatchObject({code:'MOTE_MAIN_CHANGED'})
  expect(ensure).not.toHaveBeenCalled();expect(runtime.started).toEqual([])
  await switchMain(f,'primary','return-before-new-recovery')
  const current=await f.main.readCurrentMoteMain(f.target),originalPrompt=mainPrompt(current.roleRevision!,f.target,'unknown-main-start')
  const request={...originalPrompt,input:{...originalPrompt.input,admissionIntent:{kind:'manual-actor' as const}},recovery:{operationId:'unknown-original-main-recovery'}}
  const original=await f.rpc.call('space.mote.dialogue.input.submit',request)
  expect(original.recovery?.launchInput?.state).toBe('unknown');expect(original.record).toBeNull();expect(original.input).toBeNull()
  await switchMain(f,'member','switch-after-unknown-main-start')
  expect(await f.rpc.call('space.mote.dialogue.input.submit',request)).toEqual(original)
  expect(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:request.input.operationId})).toEqual(original)
  expect(ensure).toHaveBeenCalledTimes(1);expect(runtime.started).toHaveLength(1);expect(f.writes).toEqual([]);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  const reconciled=await f.rpc.call('space.mote.dialogue.input.submit',{...request,recovery:{...request.recovery,reconcile:true}})
  expect(reconciled.route).toEqual(original.route)
  expect(reconciled.recovery).toMatchObject({kind:'resumed',operationId:request.recovery.operationId,newRun:runtime.recovered})
  expect(reconciled.record?.launch).toMatchObject({state:'launch-carried',key:{agentSessionId:'primary',expectedRun:runtime.recovered,submissionId:request.input.operationId}})
  expect(ensure).toHaveBeenCalledTimes(2);expect(runtime.core.kernel.inspectPreparedStart).toHaveBeenCalledOnce();expect(runtime.started).toHaveLength(1);expect(f.writes).toEqual([])
})

it('logical main exact-condition input returns its original record without fabricating a controlled waiting receipt',async()=>{
  const f=await fixture(),main=await f.main.readCurrentMoteMain(f.target)
  f.idle()
  const input={agentSessionId:'primary',operationId:'original-exact-main',prompt:'Original conditional main input',expectedRun:{runId:'run-primary'},afterSubmissionId:null,
    execution:'default' as const,sourceChannel:'message-tool' as const}
  const result=await f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:main.roleRevision!,input})
  expect(result.input).toBeNull();expect(agentPromptSubmissionOutcome(result.record)).toBe('terminal-confirmed')
  expect(result.record?.admission?.intent).toMatchObject({message:{userContent:input.prompt,sourceChannel:input.sourceChannel},execution:'default'})
  const write=(f.client as any).kernel.input,writes=write.mock.calls.length
  expect(writes).toBeGreaterThan(0)
  expect(await f.rpc.call('space.mote.dialogue.input.submit',{target:f.target,expectedRoleRevision:main.roleRevision!,input})).toEqual(result)
  expect(write).toHaveBeenCalledTimes(writes)
  await f.submit('original-native-record')
  const native=await f.client.inspectAgentPromptSubmission(f.key('original-native-record'))
  expect(agentPromptSubmissionOutcome(native)).toBe('admitted')
  const unknown=structuredClone(native!),notApplied=structuredClone(native!)
  if(unknown.admission?.transport!=='native'||notApplied.admission?.transport!=='native')throw Error('Actual native admission fixture did not execute')
  unknown.admission.acknowledged=false;unknown.admission.native.outcome='unknown'
  notApplied.admission.acknowledged=false;notApplied.admission.notApplied=true;notApplied.admission.native.outcome='not-applied'
  expect(agentPromptSubmissionOutcome(unknown)).toBe('unknown');expect(agentPromptSubmissionOutcome(notApplied)).toBe('not-applied')
  expect(await f.rpc.call('space.mote.dialogue.input.inspect',{target:f.target,operationId:input.operationId})).toEqual(result)
  expect(f.writes).toHaveLength(1);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the shared original-record outcome requires the complete terminal input and keeps payload-only or malformed phases unknown',()=>{
  const run={runId:'original-pty-run'},plan={kind:'render-then-submit' as const,payload:'original',renderedText:'original',submit:'\r'}
  const record:AgentPromptSubmissionRecord={agentSessionId:'original-pty-session',run,
    admission:{submissionId:'original-operation',operationId:'original-payload',startByte:10,endByte:19,acknowledged:true,
      intent:{run,ownerInstanceId:'original-owner',prompt:'original',plan}},
    terminalPromptSubmission:{run,submissionId:'original-operation',promptDigest:'original-digest',outputCursorBytes:0,
      payload:{operationId:'original-payload',inputByteRange:{startByte:10,endByte:18},acknowledged:true},
      submit:{operationId:'original-submit',inputByteRange:{startByte:18,endByte:19},acknowledged:false}}}
  expect(agentPromptSubmissionOutcome(record)).toBe('unknown')
  record.terminalPromptSubmission!.submit.acknowledged=true
  expect(agentPromptSubmissionOutcome(record)).toBe('terminal-confirmed')
  const wrong=structuredClone(record);wrong.terminalPromptSubmission!.payload.inputByteRange.endByte=17
  expect(agentPromptSubmissionOutcome(wrong)).toBe('unknown')
  const refused=structuredClone(record);refused.admission!.acknowledged=false;refused.admission!.notApplied=true
  refused.terminalPromptSubmission!.payload.acknowledged=false;refused.terminalPromptSubmission!.submit.acknowledged=false
  expect(agentPromptSubmissionOutcome(refused)).toBe('not-applied')
  expect(agentPromptSubmissionOutcome(null)).toBe('unknown')
})
