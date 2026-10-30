// @vitest-environment happy-dom
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultAgent, scratchWorkspace } from './fixtures/mote-workface'
afterEach(()=>{vi.restoreAllMocks();bridge.invoke.mockReset()})
const target={spaceId:'original-mote',zoneId:'original-home',expectedResource:{hostId:'resource-owner',workspaceId:scratchWorkspace.id,workspacePath:scratchWorkspace.path}}
it('registered main recovery accepts its original trusted sender and rejects foreign provenance before Runtime',async()=>{
 const f=await owningBridge(),request={trigger:'input' as const,input:{submissionId:'original-input',prompt:'原完整输入',authorHuman:true,sourceChannel:'message-tool' as const},moteMain:{target,expectedRoleRevision:'original-role'}}
 try{const recover=vi.spyOn(f.runtime,'recoverSession').mockResolvedValue({kind:'resumed',session:defaultAgent})
 const handler=bridge.handlers.get('sessions:recover')!
 await expect(handler({sender:{...f.sender}},control,scratchWorkspace.path,'original-recovery',request)).rejects.toThrow('Untrusted manual prompt sender')
 expect(recover).not.toHaveBeenCalled()
 await bridge.api!.sessions.recover(control,scratchWorkspace.path,'original-recovery',request)
 expect(recover).toHaveBeenCalledExactlyOnceWith(control,expect.anything(),scratchWorkspace.path,'original-recovery',request)
 }finally{await f.dispose()}
})
it('actual preload and trusted dialogue IPC read the original resource Host with the complete exact target',async()=>{
 const f=await owningBridge()
 try{const call=vi.spyOn(f.runtime,'callOriginalCore').mockResolvedValue({original:'read'} as any),read={target,limit:25}
 const handler=bridge.handlers.get('moteDialogue:read')!
 await expect(handler({sender:{...f.sender}},read)).rejects.toThrow(/Untrusted/)
 expect(call).not.toHaveBeenCalled()
 await bridge.api!.moteDialogue.read(read)
 expect(call).toHaveBeenCalledExactlyOnceWith('resource-owner','space.mote.dialogue.read',read,{transport:'unix'})
 }finally{await f.dispose()}
})
it('actual schedule resume and inspect bridges retain the resource owner rather than borrowing the execution Host',async()=>{
 const f=await owningBridge()
 try{const call=vi.spyOn(f.runtime,'callOriginalCore').mockResolvedValue({schedule:null,executionScope:'connected-host'} as any)
 const resume={scheduleId:'original-heartbeat',expectedRevision:2,operationId:'original-resume'}
 await bridge.api!.schedule.resume(resume,'resource-owner')
 await bridge.api!.schedule.inspect({operationId:resume.operationId},'resource-owner')
 expect(call.mock.calls).toEqual([['resource-owner','schedule.resume',resume,{transport:'unix'}],['resource-owner','schedule.inspect',{operationId:resume.operationId},{transport:'unix'}]])
 }finally{await f.dispose()}
})
