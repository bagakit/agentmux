import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,readFile,writeFile,rm,unlink,lstat,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {DurableAgentMuxMessageQueue} from '../src/agent-global-message-queue.js'
import {rpcOwnerFixture} from './helpers/public-rpc-owner.js'
import {agentPromptCondition} from '../src/agent-prompt-condition.js'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function root(){const path=await mkdtemp(join(tmpdir(),'amux-queue-namespace-'));roots.push(path);return path}
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
const input=(id:string)=>({messageId:id,operationId:'op-'+id,createdAt:1,sender:{kind:'agent-session' as const,agentSessionId:'sender'},recipient:{kind:'agent-session' as const,agentSessionId:'recipient'},senderSessionId:'sender',senderRunId:'sender-run',recipientSessionId:'recipient',recipientRunId:'recipient-run',threadId:id,correlationId:id,replyTo:null,workspaceId:null,body:'Original '+id})
async function oldWriter(mutexPath:string){
 const script="const{DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.stdout.write('ready');process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0)})"
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(AGENTMUX_|CTXMUX_)/u.test(key)))
 const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',script,mutexPath],{env,stdio:['pipe','pipe','pipe']})
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000)
 await Promise.race([once(child.stdout,'data').then(([bytes])=>expect(String(bytes)).toBe('ready')),once(child,'exit').then(()=>{throw new Error('Original isolated writer exited before its lock')})])
 return async()=>{clearTimeout(timer);const exited=once(child,'exit');child.stdin.end('release');const deadline=setTimeout(()=>child.kill('SIGKILL'),10000);try{await exited}finally{clearTimeout(deadline)}}
}
it('an actual second-process original writer survives unlink without a new SDK creating another mutex or sending Native input',async()=>{
 const h=await rpcOwnerFixture(['recipient']),queue=new DurableAgentMuxMessageQueue(h.client.agentMessageQueuePath())
 let release:undefined|(()=>Promise<void>)
 try{
  await queue.readJournal();const original=await readFile(queue.path),session=(await h.store.readMetadata('recipient'))!
  release=await oldWriter(queue.path+'.mutex.sqlite');await unlink(queue.path+'.mutex.sqlite')
  await expect(h.client.submitAgentPrompt({agentSessionId:'recipient',operationId:'new-sdk-input',prompt:'Retained original request',...agentPromptCondition(session),execution:'immediate'})).rejects.toThrow()
  await expect(lstat(queue.path+'.mutex.sqlite')).rejects.toMatchObject({code:'ENOENT'})
  expect(await readFile(queue.path)).toEqual(original);expect(h.inner.kernel.input).not.toHaveBeenCalled();expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  await release();release=undefined
  await expect(new DurableAgentMuxMessageQueue(queue.path).readJournal()).rejects.toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
  await expect(lstat(queue.path+'.mutex.sqlite')).rejects.toMatchObject({code:'ENOENT'})
  expect((await h.store.readMetadata('recipient'))?.run).toEqual(session.run)
 }finally{await release?.();await h.close()}
})
it('a used SQLite main cannot acknowledge an existing unconfirmed mutex from the main incarnation',async()=>{
 const r=await root(),queue=new DurableAgentMuxMessageQueue(join(r,'queue.sqlite'))
 await queue.append(input('original'));const main=await readFile(queue.path)
 const mutex=new DatabaseSync(queue.path+'.mutex.sqlite');mutex.exec('DROP TABLE journal_format');mutex.close()
 const lockBefore=await readFile(queue.path+'.mutex.sqlite')
 await expect(queue.readJournal()).rejects.toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
 expect(await readFile(queue.path)).toEqual(main);expect(await readFile(queue.path+'.mutex.sqlite')).toEqual(lockBefore)
})
it('a retained original archive blocks creating a mutex when the current main is missing',async()=>{
 const r=await root(),path=join(r,'queue.ndjson'),bytes='Original machine-owned archive\n',hash=digest(bytes)
 await writeFile(path+'.original-'+hash,bytes,{mode:0o600})
 await expect(new DurableAgentMuxMessageQueue(path).readJournal()).rejects.toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
 expect(await readdir(r)).toEqual(['queue.ndjson.original-'+hash])
})
it('an unconfirmed empty first-pair mutex never becomes an empty new journal on retry',async()=>{
 const r=await root(),path=join(r,'queue.sqlite'),db=new DatabaseSync(path+'.mutex.sqlite');db.close()
 const before=await readFile(path+'.mutex.sqlite'),queue=new DurableAgentMuxMessageQueue(path)
 for(let attempt=0;attempt<2;attempt++)await expect(queue.readJournal()).rejects.toMatchObject({code:'MESSAGE_QUEUE_BACKPRESSURE',detail:'unknown'})
 expect(await readFile(path+'.mutex.sqlite')).toEqual(before);expect(await readdir(r)).toEqual(['queue.sqlite.mutex.sqlite'])
})
it.each([false,true])('the original complete legacy source cuts over once and retains its archive with existing mutex=%s',async existingMutex=>{
 const r=await root(),seed=new DurableAgentMuxMessageQueue(join(r,'seed.sqlite'));await seed.append(input('legacy-original'))
 const records=await seed.readJournal(),raw=records.map(record=>JSON.stringify(record)).join('\n')+'\n',path=join(r,'legacy.ndjson')
 await writeFile(path,raw,{mode:0o600})
 if(existingMutex){const db=new DatabaseSync(path+'.mutex.sqlite');db.exec('CREATE TABLE legacy_original_lock(value TEXT)');db.close()}
 const inode=existingMutex?(await lstat(path+'.mutex.sqlite')).ino:undefined,queue=new DurableAgentMuxMessageQueue(path)
 await expect(queue.readJournal()).resolves.toEqual(records)
 expect(await readFile(path+'.original-'+digest(raw),'utf8')).toBe(raw)
 if(existingMutex)expect((await lstat(path+'.mutex.sqlite')).ino).toBe(inode)
 const readback=await queue.append(input('legacy-original'));expect(readback.messageId).toBe('legacy-original');expect(await queue.readJournal()).toEqual(records)
})
it('genuinely fresh concurrent owners keep one original mutex and one copy of each original operation',async()=>{
 const r=await root(),path=join(r,'fresh.sqlite'),a=new DurableAgentMuxMessageQueue(path),b=new DurableAgentMuxMessageQueue(path)
 await Promise.all([a.append(input('a')),b.append(input('b'))])
 const inode=(await lstat(path+'.mutex.sqlite')).ino
 await a.append(input('a'));await b.append(input('b'))
 expect((await a.listAfter()).map(message=>message.envelope.messageId)).toEqual(['a','b'])
 expect((await lstat(path+'.mutex.sqlite')).ino).toBe(inode)
})


it('a real initializer crash after SQLite publication retains the original pair as unknown without reverse acknowledgement',async()=>{
 const r=await root(),path=join(r,'crash.sqlite'),loader=fileURLToPath(new URL('./helpers/message-journal-crash-loader.mjs',import.meta.url)),module=fileURLToPath(new URL('../src/agent-global-message-queue.ts',import.meta.url))
 const script=`const{DurableAgentMuxMessageQueue}=await import(${JSON.stringify(module)});await new DurableAgentMuxMessageQueue(process.argv[1]).readJournal()`
 const child=spawn(process.execPath,['--no-warnings','--experimental-loader',loader,'--input-type=module','-e',script,path],{env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(AGENTMUX_|CTXMUX_)/u.test(key))),stdio:['ignore','pipe','pipe']})
 const timeout=setTimeout(()=>child.kill('SIGKILL'),10000)
 try{await Promise.race([once(child.stdout,'data').then(([bytes])=>expect(String(bytes)).toBe('published')),once(child,'exit').then(()=>{throw new Error('Initializer exited before publication fault point')})]);const exited=once(child,'exit');child.kill('SIGKILL');await exited}finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
 const main=await readFile(path),mutex=await readFile(path+'.mutex.sqlite'),queue=new DurableAgentMuxMessageQueue(path)
 for(let retry=0;retry<2;retry++)await expect(queue.readJournal()).rejects.toMatchObject({code:'MESSAGE_QUEUE_UNAVAILABLE'})
 expect(await readFile(path)).toEqual(main);expect(await readFile(path+'.mutex.sqlite')).toEqual(mutex)
 const db=new DatabaseSync(path,{readOnly:true});try{expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()?.n).toBe(0)}finally{db.close()}
})
