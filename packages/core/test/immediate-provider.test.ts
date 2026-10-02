import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { inspectCodexPromptExecution } from '../src/providers/codex-prompt-execution.js'
import { readCodexPromptExecutionEvidence, verifyCodexPromptExecutionTransport } from '../src/providers/codex-prompt-execution-evidence.js'
async function frame(body: string) {
 const s=new AgentTerminalScreen(120,40),b=Buffer.from(`\x1b[?2026h\x1b[2J${body}\x1b[16;3H\x1b[?2026l`)
 await s.write({startByte:0,endByte:b.length,dataBytes:b});return s
}
const ordinary=("\u001b[13;1H• Working (10s • esc to interrupt)\u001b[16;1H› \u001b[2mAsk Codex to do anything\u001b[22m\u001b[18;1Hprobe default · " + (upstreamFixturePath("private/probe")) + " · 87% context left")
describe('Provider-owned immediate evidence',()=>{
 it('distinguishes placeholder from actual draft after the cursor',async()=>{
  const s=await frame(ordinary);try {
   expect(inspectCodexPromptExecution(s.snapshot())).toBe('interruptible');expect(s.composerText('›')).toBe('')
   const b=Buffer.from('\x1b[16;3HUNAUTHORIZED_DRAFT\x1b[16;3H');await s.write({startByte:s.throughByte,endByte:s.throughByte+b.length,dataBytes:b})
   expect(s.composerText('›')).toBe('');expect(s.snapshot().lines[15]?.text).toContain('UNAUTHORIZED_DRAFT')
   expect(inspectCodexPromptExecution(s.snapshot())).toBe('unavailable')
  }finally{s.dispose()}
 })
 it.each([
  ['native pending',ordinary+'\x1b[14;1H• Messages to be submitted after next tool call\x1b[15;1H  ↳ unauthorized'],
  ['modal',ordinary+'\x1b[17;1H1. Approve request'],['multiline draft',ordinary+'\x1b[17;1Hhidden draft'],
  ['remapped interrupt',ordinary.replace('esc to interrupt','f12 to interrupt')],['clipped preview',ordinary.replace('\x1b[13;1H','\x1b[1;1H')]
 ])('does not guess from %s',async(_name,body)=>{const s=await frame(body);try{expect(inspectCodexPromptExecution(s.snapshot())).toBe('unavailable')}finally{s.dispose()}})
 it('contributes explicit immediate plan and canceled semantic end without changing default',()=>{
  const p=new AgentProviderRegistry().get('codex');expect(p.planPromptInput('owned')).not.toHaveProperty('prepare')
  expect(p.planPromptInput('owned',{execution:'immediate'})).toMatchObject({prepare:{interrupt:'\x1b',endEvent:'Interrupt'}})
  expect(p.normalizeHook({providerId:'codex',agentSessionId:'agent',runId:'run',receiptId:'receipt',eventName:'Interrupt',payload:{session_id:'native',turn_id:'native-turn'}},{})).toMatchObject({semanticState:'unknown',lifecycleEvent:'turn-end',nativeTurnId:'native-turn'})
  expect(new AgentProviderRegistry().get('claude').planPromptInput('owned')).not.toHaveProperty('prepare')
  expect(()=>new AgentProviderRegistry().get('claude').planPromptInput('owned',{execution:'immediate'})).toThrow(/ordinary terminal input remains available/)
 })
 it('binds bounded native evidence and transport to this native Session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'amux-native-evidence-'));try{
   const d=join(root,'sessions','2026','10','07');await mkdir(d,{recursive:true});const path=join(d,'rollout-private-native.jsonl')
   const c={args:[],workspacePath:root,nativeHandle:{kind:'provider' as const,providerId:'codex',sessionId:'native',transcriptPath:path}}
   const head={type:'session_meta',payload:{id:'native',session_id:'native',base_instructions:'x'.repeat(64*1024)}}
   const start={ordinal:1,type:'event_msg',payload:{type:'task_started',turn_id:'native-turn'}},end={ordinal:2,type:'event_msg',payload:{type:'turn_aborted',turn_id:'native-turn',reason:'interrupted'}}
   const write=async(items:unknown[])=>writeFile(path,items.map(v=>JSON.stringify(v)).join('\n')+'\n')
   await write([head,start]);const before=await readCodexPromptExecutionEvidence(c);expect(before).toMatchObject({state:'working',nativeTurnId:'native-turn'})
   expect(await verifyCodexPromptExecutionTransport(c)).toBe(false);await write([head,start,end]);const after=await readCodexPromptExecutionEvidence(c)
   expect(after).toMatchObject({sourceId:before?.sourceId,state:'ended',endReason:'interrupted',nativeTurnId:'native-turn'});expect(after?.id).not.toBe(before?.id)
   expect(await readCodexPromptExecutionEvidence({...c,nativeHandle:{...c.nativeHandle,sessionId:'different'}})).toBe(null)
   expect(await verifyCodexPromptExecutionTransport({...c,args:['--remote','ws://private.invalid']})).toBe(false)
   await mkdir(join(root,'app-server-control'));await writeFile(join(root,'app-server-control','app-server-control.sock'),'existing')
   expect(await verifyCodexPromptExecutionTransport(c)).toBe(false);expect(await verifyCodexPromptExecutionTransport({...c,args:['--no-daemon']})).toBe(false)
   const large={type:'response_item',payload:{text:'z'.repeat(600*1024)}}
   await write([head,start,large]);expect(await readCodexPromptExecutionEvidence(c)).toBe(null)
   const context={ordinal:3,type:'turn_context',payload:{turn_id:'native-turn'}}
   await write([head,start,large,context]);expect(await readCodexPromptExecutionEvidence(c)).toMatchObject({state:'working',nativeTurnId:'native-turn'})
   const item={ordinal:4,type:'event_msg',payload:{type:'item_completed',thread_id:'native',turn_id:'native-turn'}}
   await write([head,start,large,item]);expect(await readCodexPromptExecutionEvidence(c)).toMatchObject({state:'working',nativeTurnId:'native-turn'})
   await write([head,start,large,{...item,payload:{...item.payload,thread_id:'child-thread'}}]);expect(await readCodexPromptExecutionEvidence(c)).toBe(null)
   await write([head,start,large,context,item,{...end,ordinal:5}]);expect(await readCodexPromptExecutionEvidence(c)).toMatchObject({state:'ended',endReason:'interrupted'})
  }finally{await rm(root,{recursive:true,force:true})}
 })
})
