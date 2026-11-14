import { EventEmitter } from 'node:events'
import { expect,it,vi } from 'vitest'
import { registerNodePublishingIpc } from '../src/main/node-publishing-ipc'
import { observeRead } from '../../../packages/core/src/observation-read'
class Sender extends EventEmitter { id=21;isDestroyed(){return false} }
it('actual registered bridge forwards only fixed Node methods and original roots, cancels exactly its sender reader',async()=>{
 const handlers=new Map<string,(...args:any[])=>any>(),sender=new Sender();let observed!:AbortSignal
 const call=vi.fn(async(_method,_params,{signal})=>{observed=signal;return await observeRead(new Promise<never>(()=>{}),signal)})
 const owner=registerNodePublishingIpc({handle:(name,listener)=>handlers.set(name,listener),call,owner:vi.fn()})
 const root={runtimeId:'original-runtime',rootId:'original-root',policyRevision:'revision'}
 const pending=handlers.get('nodePublishing:call')!({sender},'token','node.files.read',{hostId:'peer',expectedRuntimeId:'original-runtime',root,path:'note.txt',maxBytes:512})
 expect(call.mock.calls[0]?.slice(0,2)).toEqual(['node.files.read',{hostId:'peer',expectedRuntimeId:'original-runtime',root,path:'note.txt',maxBytes:512}])
 handlers.get('nodePublishing:cancel')!({sender:{id:999}},'token');expect(observed.aborted).toBe(false)
 handlers.get('nodePublishing:cancel')!({sender},'token');expect(observed.aborted).toBe(true);expect(await pending).toMatchObject({ok:false})
 const denied=await handlers.get('nodePublishing:call')!({sender},'bad','runtime.invoke',{operation:'shell'})
 expect(denied).toMatchObject({ok:false});expect(call).toHaveBeenCalledTimes(1)
 const selfGrant=await handlers.get('nodePublishing:call')!({sender},'bad-owner','settings.node.resources',{owner:true,hostId:'peer'})
 expect(selfGrant).toMatchObject({ok:false});expect(call).toHaveBeenCalledTimes(1);owner.dispose()
})
