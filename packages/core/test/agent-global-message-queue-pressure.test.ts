import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput, type AgentMuxMessageJournalRecord } from '../src/agent-global-message-queue.js'
import { AgentMuxControlServer } from '../src/control-host.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { privateRpcCorePort } from './helpers/private-rpc-core.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { messageJournalIo } from './helpers/message-journal-io.js'

const io = vi.hoisted(() => ({ path: '', fault: undefined as undefined | {kind: 'file-sync' | 'dir-sync' | 'rename' | 'chmod', code: string}, triggered: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const consume = (kind: string) => {
    if (io.fault?.kind !== kind) return
    const error = Object.assign(new Error(`Private storage ${io.fault.code}`), {code: io.fault.code})
    io.fault=undefined; io.triggered++; throw error
  }
  return {...fs,
    async chmod(path: Parameters<typeof fs.chmod>[0], mode: Parameters<typeof fs.chmod>[1]) {
      if (String(path) === `${io.path}.mutex.sqlite`) consume('chmod')
      return fs.chmod(path, mode)
    },
    async rename(from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) {
      if (String(to) === io.path) consume('rename')
      return fs.rename(from, to)
    },
    async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args), path=String(args[0])
      return new Proxy(handle, {get(target, key) {
        if (key === 'sync') return async () => {
          if (path === io.path || path.startsWith(`${io.path}.`) && !path.includes('.original-') && path.endsWith('.tmp')) consume('file-sync')
          if (path === dirname(io.path)) consume('dir-sync')
          return target.sync()
        }
        const value=Reflect.get(target,key,target)
        return typeof value === 'function' ? value.bind(target) : value
      }})
    }
  }
})
const roots: string[] = []
const exec = promisify(execFile)
const condition = { expectedRun: { runId: 'run-recipient' }, afterSubmissionId: null }
let probe: Awaited<ReturnType<typeof messageJournalIo>>
beforeAll(async () => { probe = await messageJournalIo() })
afterAll(async () => { await probe.close() })
function input(id = 'one'): AgentMuxMessageAppendInput {
  return { messageId: `message-${id}`, operationId: `operation-${id}`, createdAt: 100,
    sender: { kind: 'human', principal: 'local-cli' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
    senderSessionId: null, senderRunId: null, recipientSessionId: 'recipient', recipientRunId: 'run-recipient',
    body: `exact\nbody 😀 ${id}`, execution: 'immediate', sourceChannel: 'agent-message' }
}
function record(id='one', sequence=1): AgentMuxMessageJournalRecord {
  const {execution, sourceChannel, sourceDevice: _sourceDevice, ...envelope} = input(id)
  return {kind:'message', sequence, envelope:{...envelope, schema:'agentmux.a2a.v1', messageId:`message-${id}`},
    promptCondition:null, execution:execution!, sourceChannel:sourceChannel!}
}
async function queue() {
  const root = await mkdtemp(join(tmpdir(), 'amux-journal-pressure-')); roots.push(root)
  const value = new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson'))
  io.path = value.path; probe.target(join(await realpath(root), 'messages.ndjson')); probe.reset(); return value
}
function fault(kind: 'file-sync' | 'dir-sync' | 'rename' | 'chmod', code='EIO') { io.fault={kind,code} }
afterEach(async () => {
  io.path=''; io.fault=undefined; io.triggered=0; probe.reset()
  await Promise.all(roots.splice(0).map(path => rm(path,{recursive:true,force:true})))
})

describe('journal persistence under isolated resource pressure', () => {
  it.each(['write','sync','read'] as const)('recovers real SQLite %s IO faults without losing an original fact', async kind => {
    const q=await queue(); const first=await q.append(input()); await q.preparePrompt(first.messageId,async()=>condition)
    const original=await q.readJournal(); probe.reset(); probe.fault(kind)
    const error=await q.append(input('two')).catch(error=>error)
    expect(error).toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'}); expect(probe.stats().failures).toBe(1)
    probe.reset(); const reopened=new DurableAgentMuxMessageQueue(q.path)
    expect(await reopened.readJournal()).toEqual(original)
    const added=await reopened.append(input('two')); expect(added.sequence).toBe(3)
    expect((await reopened.listAfter())[0]).toMatchObject({envelope:first.envelope,promptCondition:condition})
  })

  it.each(['file-sync','rename'] as const)('does not publish an interrupted original-format cutover at %s', async kind => {
    const q=await queue(), original=Buffer.from(JSON.stringify(record())+'\n')
    await writeFile(q.path, original); fault(kind)
    const error=await q.append(input('two')).catch(error=>error)
    expect(error).toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
    expect(JSON.parse(error.detail).cause.phase).toBe('before-replace'); expect(io.triggered).toBe(1)
    expect(await readFile(q.path)).toEqual(original)
    expect((await new DurableAgentMuxMessageQueue(q.path).append(input('two'))).sequence).toBe(2)
    const hash=createHash('sha256').update(original).digest('hex')
    expect(await readFile(`${q.path}.original-${hash}`)).toEqual(original)
  })

  it.each(['message','condition','delivery'] as const)('reconfirms the existing %s after a committed but unacknowledged directory', async kind => {
    const q=await queue(); await q.readJournal(); if(kind!=='message') await q.append(input())
    const capture=vi.fn(async()=>{ if(kind==='condition') fault('dir-sync'); return condition })
    const operation=()=>kind==='message'?q.append(input()):kind==='condition'?q.preparePrompt('message-one',capture):q.recordDelivery('message-one','delivered',200)
    if(kind!=='condition') fault('dir-sync'); const error=await operation().catch(error=>error)
    expect(error).toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
    expect(JSON.parse(error.detail).stage).toBe('journal-confirm'); expect(error.controlFailure).toBeUndefined()
    const committed=await q.readJournal(); fault('dir-sync')
    await expect(operation()).rejects.toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
    expect(await q.readJournal()).toEqual(committed); await operation()
    expect(await q.readJournal()).toEqual(committed)
    if(kind==='condition') expect(capture).toHaveBeenCalledOnce()
    if(kind==='delivery') expect((await q.listAfter())[0]?.delivery.state).toBe('delivered')
  })

  it('preserves EACCES cause and frees a failed mutex',async()=>{
    const q=await queue(); await q.append(input()); fault('chmod','EACCES')
    const error=await q.append(input('two')).catch(error=>error)
    expect(error.code).toBe('MESSAGE_QUEUE_UNAVAILABLE'); expect(JSON.parse(error.detail).cause.code).toBe('EACCES')
    expect((await q.append(input('two'))).sequence).toBe(2)
  })

  it.each(['corrupt','utf8','sequence'] as const)('retains original invalid %s history instead of silently truncating or rewriting it', async kind=>{
    const q=await queue(); const original=Buffer.from(JSON.stringify(record())+'\n')
    const bytes=kind==='corrupt'?Buffer.concat([original,Buffer.from('{"kind":')]):kind==='sequence'
      ?Buffer.from(JSON.stringify({...record(),sequence:0})+'\n'):original
    if(kind==='utf8') bytes[bytes.indexOf(Buffer.from('exact'))]=255
    await writeFile(q.path,bytes); await expect(q.append(input('two'))).rejects.toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
    expect(await readFile(q.path)).toEqual(bytes)
  })

  it('rejects a post-cutover file replacement without forgetting SQLite facts or re-importing it',async()=>{
    const q=await queue(); const first=await q.append(input()); const saved=await readFile(q.path)
    const replacement=Buffer.from(JSON.stringify(record('another'))+'\n'); await writeFile(q.path,replacement)
    await expect(new DurableAgentMuxMessageQueue(q.path).append(input('two'))).rejects.toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
    expect(await readFile(q.path)).toEqual(replacement)
    await writeFile(q.path,saved); expect(await q.append(input())).toEqual(first)
  })

  it('keeps cold and warm IO related to the queried recipient rather than all retained bodies',async()=>{
    const samples=[]
    for(const count of [1,100,500]) {
      const q=await queue()
      const records=Array.from({length:count},(_,index)=>{const r=record(`archive-${index}`,index+1);if(r.kind!=='message')throw new Error('fixture');
        return {...r,envelope:{...r.envelope,recipient:{kind:'agent-session',agentSessionId:'archive'},recipientSessionId:'archive',body:'x'.repeat(4096)}}})
      await writeFile(q.path,records.map(r=>JSON.stringify(r)).join('\n')+'\n'); await q.readJournal()
      const operations=[]
      for(const label of ['cold empty inbox','warm empty inbox','append 1-byte body','original operation query']) {
        probe.reset(); const owner=label==='cold empty inbox'?new DurableAgentMuxMessageQueue(q.path):q
        const start=performance.now()
        if(label.includes('inbox')) expect((await owner.check({consumerId:'unrelated',readerRun:{runId:'run-unrelated'},limit:1},async()=>{})).messages).toEqual([])
        else if(label.includes('append')) await owner.append({...input('small'),body:'x'})
        else expect((await owner.readByOperationId('operation-small'))?.envelope.body).toBe('x')
        const cost=probe.stats(); expect(cost.failures).toBe(0)
        expect(cost.readBytes).toBeLessThan(128*1024); expect(cost.writeBytes).toBeLessThan(128*1024)
        if(label.includes('append')) { expect(cost.syncs).toBeGreaterThan(0); expect(cost.dirSyncs).toBeGreaterThan(0) }
        operations.push({label,...cost,elapsedMs:performance.now()-start})
      }
      expect((await q.readJournal()).filter(r=>r.kind==='message')).toHaveLength(count+1)
      samples.push({count,retainedBytes:(await stat(q.path)).size,operations})
    }
    const large=samples[2]!, small=samples[0]!
    for(let index=0;index<large.operations.length;index++) expect(large.operations[index]!.readBytes).toBeLessThan(small.operations[index]!.readBytes*3)
    console.log('__JOURNAL_RELATED_IO__',JSON.stringify(samples))
  })

  it('jumps directly past a large acknowledged history of the same recipient',async()=>{
    const q=await queue(); const facts:AgentMuxMessageJournalRecord[]=Array.from({length:500},(_,index)=>record(String(index),index+1))
    for(let batch=0;batch<5;batch++) {
      const deliveryIds=Array.from({length:100},(_,index)=>`message-${batch*100+index}`)
      facts.push({kind:'consumer-check',sequence:501+batch*2,consumerId:'recipient',readerRun:condition.expectedRun,generation:batch+1,deliveryIds})
      facts.push({kind:'consumer-ack',sequence:502+batch*2,consumerId:'recipient',readerRun:condition.expectedRun,generation:batch+1,deliveryIds})
    }
    await writeFile(q.path,facts.map(r=>JSON.stringify(r)).join('\n')+'\n'); await q.readJournal()
    probe.reset(); expect((await new DurableAgentMuxMessageQueue(q.path).check({consumerId:'recipient',readerRun:condition.expectedRun,limit:1},async()=>{})).messages).toEqual([])
    expect(probe.stats().readBytes).toBeLessThan(64*1024)
    console.log('__JOURNAL_ACKED_IO__',JSON.stringify(probe.stats()))
  })

  it('returns promptly while a real second process owns the original writer mutex',async()=>{
    const q=await queue(); await q.append(input())
    const script=`import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE');process.send('held');setTimeout(()=>{d.exec('COMMIT');d.close();process.exit(0)},1400)`
    const child=spawn(process.execPath,['--input-type=module','-e',script,`${q.path}.mutex.sqlite`],{stdio:['ignore','ignore','pipe','ipc']})
    const exited=new Promise<number|null>(resolve=>child.once('exit',resolve)); let timer:ReturnType<typeof setInterval>|undefined
    try {
      await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject)})
      let beats=0; timer=setInterval(()=>beats++,10); const start=performance.now()
      const error=await q.append(input('two')).catch(error=>error)
      expect(error.code).toBe('MESSAGE_QUEUE_BACKPRESSURE'); expect(performance.now()-start).toBeLessThan(700)
      await new Promise(resolve=>setTimeout(resolve,50)); expect(beats).toBeGreaterThan(1)
      expect(await exited).toBe(0); expect((await q.append(input('two'))).sequence).toBe(2)
    } finally {if(timer)clearInterval(timer);if(child.exitCode===null){child.kill('SIGKILL');await exited}}
  })
  it('converts every original communication fact once and reopens them in independent processes',async()=>{
    const template=await queue()
    const source={...input('source'),sender:{kind:'agent-session' as const,agentSessionId:'owner'},senderSessionId:'owner',senderRunId:'run-owner'}
    await template.append(source); await template.preparePrompt('message-source',async()=>condition)
    await template.recordDeliveryIssue('message-source','Original unknown ACK',150)
    await template.recordDelivery('message-source','delivered',200)
    await template.append({...input('reply'),sender:{kind:'agent-session',agentSessionId:'recipient'},senderSessionId:'recipient',senderRunId:'run-recipient',
      recipient:{kind:'agent-session',agentSessionId:'owner'},recipientSessionId:'owner',recipientRunId:'run-owner',replyTo:'message-source'})
    await template.openDispatch({callerAgentSessionId:'owner',sourceMessageId:'message-source'},async()=>{})
    await template.recordDispatchEvent({callerAgentSessionId:'recipient',sourceMessageId:'message-source',replyMessageId:'message-reply',kind:'worker_done'},async()=>{})
    await template.append(input('historical-unknown'))
    const recipient={consumerId:'recipient',readerRun:condition.expectedRun}
    const owner={consumerId:'owner',readerRun:{runId:'run-owner'}}
    const batch=await template.check({...recipient,limit:2},async()=>{})
    const owned=await template.check({...owner,limit:2},async()=>{});await template.ack({...owner,generation:owned.generation},async()=>{})
    const original=(await template.readJournal()).map(r=>{
      if(r.kind!=='message'||r.envelope.messageId!=='message-historical-unknown')return r
      const {promptCondition:_condition,...unknown}=r;return unknown
    })
    const path=join(dirname(template.path),'original-complete.ndjson'), raw=Buffer.from(original.map(r=>JSON.stringify(r)).join('\n')+'\n')
    await writeFile(path,raw)
    const modulePath=fileURLToPath(new URL('../dist/agent-global-message-queue.js',import.meta.url))
    const script=`import {DurableAgentMuxMessageQueue} from ${JSON.stringify(modulePath)};const q=new DurableAgentMuxMessageQueue(process.env.QUEUE_PATH);
      let captures=0;const unknown=await q.preparePrompt('message-historical-unknown',async()=>{captures++;throw new Error('Must not capture unknown')}).catch(e=>e.code);
      console.log(JSON.stringify({journal:await q.readJournal(),messages:await q.listAfter(),batch:await q.check(${JSON.stringify({...recipient,limit:1})},async()=>{}),
        acknowledged:await q.check(${JSON.stringify({...owner,limit:1})},async()=>{}),dispatch:await q.showDispatch({callerAgentSessionId:'owner',sourceMessageId:'message-source'},async()=>{}),unknown,captures}))`
    const env={...process.env,QUEUE_PATH:path}
    const first=JSON.parse((await exec(process.execPath,['--input-type=module','-e',script],{env})).stdout)
    const second=JSON.parse((await exec(process.execPath,['--input-type=module','-e',script],{env})).stdout)
    expect(first).toEqual(second);expect(first.journal).toEqual(original)
    const expectedBatch = { ...batch, messages: batch.messages.map(message => {
      if (message.envelope.messageId !== 'message-historical-unknown') return message
      const { promptCondition: _condition, ...unknown } = message; return unknown
    }) }
    expect(first.batch).toEqual(expectedBatch);expect(first.acknowledged.messages).toEqual([]);expect(first.acknowledged.generation).toBe(2)
    expect(first.dispatch).toMatchObject({sourceMessageId:'message-source',originAwaits:false,events:[{kind:'worker_done',replyMessageId:'message-reply'}]})
    expect(first.unknown).toBe('AGENT_PROMPT_INPUT_UNCONFIRMED');expect(first.captures).toBe(0)
    expect(first.messages[0]).toMatchObject({envelope:{messageId:'message-source',body:source.body,senderSessionId:'owner',recipientSessionId:'recipient'},promptCondition:condition,delivery:{state:'delivered',at:200}})
    const hash=createHash('sha256').update(raw).digest('hex');expect(await readFile(`${path}.original-${hash}`)).toEqual(raw)
  })

  it.each(['before-commit','after-commit','cutover-commit','cutover-rename'] as const)('reopens original facts after an actual process crash at %s',async phase=>{
    const q=await queue(); const original=record()
    if(phase.startsWith('cutover')) await writeFile(q.path,JSON.stringify(original)+'\n')
    else { await q.append(input()); await q.preparePrompt('message-one',async()=>condition) }
    const modulePath=fileURLToPath(new URL('../dist/agent-global-message-queue.js',import.meta.url))
    const script=`import {DatabaseSync,StatementSync} from 'node:sqlite';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const phase=process.env.PHASE;const pause=()=>{process.send('crash-point');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)};
      if(phase==='before-commit'){const run=StatementSync.prototype.run;StatementSync.prototype.run=function(...args){const value=run.apply(this,args);if(this.sourceSQL.startsWith('INSERT INTO records'))pause();return value}}
      if(phase==='after-commit'||phase==='cutover-commit'){const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const value=exec.call(this,sql);if(sql==='COMMIT')pause();return value}}
      if(phase==='cutover-rename'){const rename=fs.rename;fs.rename=async(from,to)=>{await rename(from,to);if(to===process.env.QUEUE_PATH)pause()};syncBuiltinESMExports()}
      const {DurableAgentMuxMessageQueue}=await import(${JSON.stringify(modulePath)});await new DurableAgentMuxMessageQueue(process.env.QUEUE_PATH).append(JSON.parse(process.env.QUEUE_INPUT));`
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PHASE:phase,QUEUE_PATH:q.path,QUEUE_INPUT:JSON.stringify(input('two'))},stdio:['ignore','ignore','pipe','ipc']})
    let stderr='';child.stderr!.on('data',value=>{stderr+=String(value)})
    const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()))
    try {
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Private crash fixture did not reach its boundary: '+stderr)),5000)
        child.once('message',value=>{clearTimeout(timer);resolve(value)})
        child.once('exit',()=>{clearTimeout(timer);reject(new Error('Private crash fixture exited before boundary: '+stderr))})
      })
      child.kill('SIGKILL');await exited
      const reopened=new DurableAgentMuxMessageQueue(q.path)
      expect((await reopened.readByOperationId('operation-one'))?.envelope).toEqual(original.kind==='message'?original.envelope:undefined)
      const applied=await reopened.readByOperationId('operation-two')
      expect(applied!==null).toBe(phase==='after-commit')
      const added=await reopened.append(input('two'));expect(added.messageId).toBe('message-two')
      expect((await reopened.readJournal()).filter(r=>r.kind==='message')).toHaveLength(2)
      if(!phase.startsWith('cutover')) expect((await reopened.readByOperationId('operation-one'))?.promptCondition).toEqual(condition)
    } finally {if(child.exitCode===null){child.kill('SIGKILL');await exited}}
  })

  it('includes the final old-writer commit before cutting over under the same process exclusion',async()=>{
    const q=await queue(); await writeFile(q.path,JSON.stringify(record())+'\n')
    const durableModule=fileURLToPath(new URL('../dist/durable-write.js',import.meta.url))
    const script=`import {DatabaseSync} from 'node:sqlite';import {readFile} from 'node:fs/promises';import {durableWriteFile} from ${JSON.stringify(durableModule)};
      const d=new DatabaseSync(process.env.QUEUE_PATH+'.mutex.sqlite');d.exec('BEGIN IMMEDIATE');const original=await readFile(process.env.QUEUE_PATH,'utf8');process.send('old-read');
      process.once('message',async()=>{await durableWriteFile(process.env.QUEUE_PATH,original+process.env.OLD_RECORD+'\\n',{mode:0o600,requireDirectorySync:true});d.exec('COMMIT');d.close();process.exit(0)})`
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,QUEUE_PATH:q.path,OLD_RECORD:JSON.stringify(record('old-writer',2))},stdio:['ignore','ignore','pipe','ipc']})
    const exited=new Promise<number|null>(resolve=>child.once('exit',resolve))
    try {
      await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject)})
      await expect(q.append(input('new-writer'))).rejects.toMatchObject({code:'MESSAGE_QUEUE_BACKPRESSURE'})
      child.send('commit');expect(await exited).toBe(0)
      const added=await new DurableAgentMuxMessageQueue(q.path).append(input('new-writer'));expect(added.sequence).toBe(3)
      expect((await q.readJournal()).map(r=>r.kind==='message'?r.envelope.messageId:r.kind)).toEqual(['message-one','message-old-writer','message-new-writer'])
      // The old format parser positively refuses the current bytes; it cannot replay a cached
      // prefix because its original lock scope also owned that read.
      const current=await readFile(q.path);expect(()=>JSON.parse(current.toString('utf8'))).toThrow()
    } finally {if(child.exitCode===null){child.kill('SIGKILL');await exited}}
  })

  it('uses actual SDK admission and keeps one input when a post-input delivery ACK fails', async () => {
    const q = await queue(); const root = dirname(q.path), storePath = join(root, 'sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'recipient', providerId: 'synthetic', executorId: 'synthetic', hostId: 'local', workspacePath: root,
      run: condition.expectedRun, retiredRuns: [], hookBindingId: 'hook', hookToken: 'token', createdAt: 1, updatedAt: 1 })
    const core = await privateRpcCorePort(storePath, q.path)
    const submit = vi.spyOn(core.client as unknown as { submitPromptInternal(input: unknown): Promise<void> }, 'submitPromptInternal')
      .mockImplementation(async () => { fault('dir-sync', 'EIO') })
    const envelope = { ...input(), schema: 'agentmux.a2a.v1' as const, messageId: 'message-one' }
    try {
      probe.fault('write')
      await expect(core.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, condition, execution: 'immediate' })).rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE' })
      expect(submit).not.toHaveBeenCalled(); io.fault = undefined; probe.reset()
      const afterInput = await core.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, condition, execution: 'immediate' }).catch(error => error)
      expect(afterInput.code).toBe('MESSAGE_QUEUE_UNAVAILABLE'); expect(afterInput.controlFailure).toBeUndefined(); expect(submit).toHaveBeenCalledTimes(1)
      io.fault = undefined; probe.reset()
      await core.client.submitAgentMessage({ agentSessionId: 'recipient', envelope, condition, execution: 'immediate' })
      expect(submit).toHaveBeenCalledTimes(1); expect((await q.listAfter())[0]?.delivery.state).toBe('delivered')
    } finally { await core.dispose() }
  })

  it('consumes a real compiled CLI through public RPC and retries its original ID after a storage fault', async () => {
    const q = await queue(); const root = dirname(q.path), storePath = join(root, 'sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'recipient', providerId: 'synthetic', executorId: 'synthetic', hostId: 'local', workspacePath: root,
      run: condition.expectedRun, retiredRuns: [], hookBindingId: 'hook', hookToken: 'token', createdAt: 1, updatedAt: 1 })
    const core = await privateRpcCorePort(storePath, q.path); const sends: unknown[] = []
    // Registry identity is real; no native Provider behavior is invoked by this persisted-facts port.
    const provider = core.client.providers.list()[0]!
    core.client.providers.register({ ...provider, id: 'synthetic', label: 'Private journal target',
      catalog: { ...provider.catalog, id: 'synthetic' } })
    const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: core.clients,
      execute: async request => {
        if (request.operation === 'list.active-agents') return { operation: 'list.active-agents', agents: [{
          agentSessionId: 'recipient', promptCondition: condition, projectId: null, projectName: null,
          workspacePath: root, providerId: 'synthetic', executorId: 'synthetic', processState: 'running',
          status: 'active', updatedAt: 1 }] }
        if (request.operation === 'send') { sends.push(request); return { operation: 'send', agentSessionId: 'recipient' } }
        throw new Error(`Unexpected private operation ${request.operation}`)
      } })
    await server.start()
    const cli = fileURLToPath(new URL('../dist/agentmux.js', import.meta.url))
    const args = [cli, 'agent', 'send', '--to-session', 'recipient', '--text', 'opaque CLI body', '--execution', 'immediate', '--operation-id', 'cli-operation', '--message-id', 'cli-message']
    const env = { ...objectCliEnvironment(root), AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'durable'), AGENTMUX_AGENT_SESSION_STORE: storePath,
      AGENTMUX_MESSAGE_QUEUE_PATH: q.path, AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }
    try {
      probe.fault('write')
      const rejected = await exec(process.execPath, args, { env, timeout: 5000 }).catch(error => error)
      console.log('__JOURNAL_CLI_REJECTED__', rejected.stderr)
      expect(rejected.stderr).toContain('MESSAGE_QUEUE_UNAVAILABLE'); expect(rejected.stderr).toContain('disk I/O error'); expect(sends).toHaveLength(0)
      io.fault = undefined; probe.reset()
      const accepted = JSON.parse((await exec(process.execPath, args, { env, timeout: 5000 })).stdout)
      expect(accepted).toMatchObject({ ok: true, operationId: 'cli-operation', result: { messageId: 'cli-message', delivery: { state: 'delivered' } } })
      expect(sends).toHaveLength(1)
      await exec(process.execPath, args, { env, timeout: 5000 }); expect(sends).toHaveLength(1)
      expect((await q.readJournal()).filter(row => row.kind === 'message')).toHaveLength(1)
    } finally { await server.stop(); await core.dispose() }
  })
})
