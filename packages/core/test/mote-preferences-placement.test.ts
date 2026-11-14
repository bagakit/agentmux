import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { createMotePreferencesPlacementFixture } from './helpers/mote-preferences-placement.js'
import { parseMotePreferencesSaveParams } from '../src/mote-preferences.js'
const closes:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks()})
async function fixture(){const f=await createMotePreferencesPlacementFixture();closes.push(f.close);return f}
it('original Host Files and public SDK/CLI save same-Main preferences without a confirmed display and preserve the original role boundary',async()=>{
 const f=await fixture(),before=await f.read();expect(before.choices.destinations).toEqual([])
 const request=await f.input('original-no-placement');expect(parseMotePreferencesSaveParams(request).destination).toBeUndefined()
 const result=await f.cli(request);expect(result.code,result.stderr||result.stdout).toBe(0);expect(result.envelope.result.status).toBe('saved')
 const next=await f.read();expect(next.defaults!.conversation).toEqual(f.defaults.conversation);expect(next.defaults!.conversationRevision).toBe(f.defaults.conversationRevision);expect(next.defaults!.conversationTransition).toEqual(f.marker)
 expect(next.defaults!.presence?.intervalMs).toBe(3600000);expect(next.maintenance?.schedule).toEqual(f.paused);expect(next.maintenance?.status).toBe('paused');expect(f.transitions).toEqual([]);expect(f.changed).toEqual([f.target])
 expect(await readFile(f.motePath,'utf8')).toContain(f.notes);expect(f.writes).toEqual([]);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
 const executor=await f.input('original-executor',{...next.defaults,executorId:'next'});expect((await f.rpc.call('space.mote.preferences.save',executor)).status).toBe('saved')
 expect((await f.read()).defaults!.conversationTransition).toEqual(f.marker)
 await f.witness('public',{request,cli:result,before,after:next,executorRequest:executor,final:await f.read(),transitions:f.transitions,inputWrites:f.writes,stopCalls:f.inner.kernel.stop.mock.calls})
})
it('Core strict DTO and the direct Host writer reject a changed Main without placement, preserving original source and inputs',async()=>{
 const f=await fixture();await f.confirmDisplay();const input=await f.input('unplaced-role-change'),before=await readFile(f.motePath,'utf8')
 input.values={...input.values,conversation:{...input.values.conversation!,sessionId:'member',tabId:'tab-member',regionId:'region-member'}}
 expect(()=>parseMotePreferencesSaveParams(input)).toThrow();await expect(f.rpc.call('space.mote.preferences.save',input)).rejects.toBeDefined()
 await expect(f.quick.save(input,{actor:{kind:'user',id:'original-user'}})).rejects.toThrow('Main')
 expect(await readFile(f.motePath,'utf8')).toBe(before);expect(f.transitions).toEqual([]);expect(f.writes).toEqual([])
})
it('same-Main source conflicts, forged baseline role marker and Agent presence changes remain refused without lifecycle effects',async()=>{
 const f=await fixture(),request=await f.input('stale-source');await writeFile(f.motePath,(await readFile(f.motePath,'utf8'))+'External source edit\n')
 expect((await f.rpc.call('space.mote.preferences.save',request)).status).toBe('refused-before-write')
 const forged=await f.input('forged-marker');forged.baseline.defaults.conversationTransition={...f.marker,operationId:'not-the-original-boundary'}
 const before=await readFile(f.motePath,'utf8');expect((await f.rpc.call('space.mote.preferences.save',forged)).status).toBe('refused-before-write');expect(await readFile(f.motePath,'utf8')).toBe(before)
 const agent=await f.input('agent-presence');expect((await f.quick.save(agent,{actor:{kind:'agent',id:'primary'}})).status).toBe('refused-before-write');expect(f.writes).toEqual([]);expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('still-unbound preferences can be saved without pretending to create or bind a Main',async()=>{
 const f=await fixture();const {serializeMoteQuickMode}=await import('../../../apps/host/src/mote-model.js');await writeFile(f.motePath,serializeMoteQuickMode('',{executorId:'original'}))
 const request=await f.input('unbound-preferences');expect(request.values.conversation).toBeUndefined()
 const saved=await f.rpc.call('space.mote.preferences.save',request);expect(saved.status).toBe('saved');expect((await f.read()).defaults!.conversation).toBeUndefined();expect(f.transitions).toEqual([]);expect(f.writes).toEqual([])
})
it('the direct Host writer independently refuses an unplaced change to a legitimate other Main',async()=>{
 const f=await fixture();await f.confirmDisplay();const input=await f.input('direct-unplaced-main')
 const member=(await f.read()).choices.conversations.find(value=>value.reference.sessionId==='member')
 expect(member).toBeDefined();input.values={...input.values,conversation:member!.reference}
 const before=await readFile(f.motePath,'utf8')
 const result=await f.quick.save(input,{actor:{kind:'user',id:'original-user'}}).catch(error=>({status:'refused-before-write',message:String(error)}))
 expect(result.status).toBe('refused-before-write');expect(await readFile(f.motePath,'utf8')).toBe(before);expect(f.transitions).toEqual([]);expect(f.writes).toEqual([])
})
