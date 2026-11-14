// @vitest-environment happy-dom
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultAgent, scratchWorkspace } from './fixtures/mote-workface'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
afterEach(()=>{vi.restoreAllMocks();bridge.invoke.mockReset()})
const target={spaceId:'original-mote',zoneId:'original-home',expectedResource:{hostId:'resource-owner',workspaceId:scratchWorkspace.id,workspacePath:scratchWorkspace.path}}
it('registered main recovery accepts its original trusted sender and rejects foreign provenance before Runtime',async()=>{
 const f=await owningBridge(),request={trigger:'input' as const,input:{submissionId:'original-input',prompt:'原完整输入',authorHuman:true,sourceChannel:'message-tool' as const},moteMain:{target,expectedRoleRevision:'original-role'}}
 try{const recover=vi.spyOn(f.runtime,'recoverSession').mockResolvedValue({kind:'resumed',session:defaultAgent})
 const handler=bridge.handlers.get('sessions:recover')!
 await expect(async () => handler({sender:{...f.sender}},control,scratchWorkspace.path,'original-recovery',request)).rejects.toThrow('Untrusted application main document sender')
 expect(recover).not.toHaveBeenCalled()
 await bridge.api!.sessions.recover(control,scratchWorkspace.path,'original-recovery',request)
 expect(recover).toHaveBeenCalledExactlyOnceWith(control,expect.anything(),scratchWorkspace.path,'original-recovery',request)
 }finally{await f.dispose()}
})
it('actual preload and trusted dialogue IPC read the original resource Host with the complete exact target',async()=>{
 const f=await owningBridge()
 try{const call=vi.spyOn(f.runtime,'callOriginalCore').mockResolvedValue({original:'read'} as any),read={target,limit:25}
 const handler=bridge.handlers.get('moteDialogue:read')!
 await expect(async () => handler({sender:{...f.sender}},read)).rejects.toThrow(/Untrusted/)
 expect(call).not.toHaveBeenCalled()
 await bridge.api!.moteDialogue.read(read)
 expect(call).toHaveBeenCalledExactlyOnceWith('resource-owner','space.mote.dialogue.read',read,{transport:'unix'})
 }finally{await f.dispose()}
})
it('actual preload and Files IPC deliver the original Mote directory to the existing public owner', async () => {
  const f = await owningBridge()
  try {
    const input = { ...target, path: '.', mode: 'directory' as const }
    const directory = 'original-topic'
    const resource = { ...input.expectedResource, zoneId: input.zoneId, zonePath: scratchWorkspace.path + '/' + directory, path: directory, logicalDirectory: directory }
    const result = { resource, result: { status: 'directory-listed' as const, complete: true, partialReason: null,
      entries: [{ name: 'idea.md', path: directory + '/idea.md', isDirectory: false, isSymlink: false }] } }
    const list = vi.spyOn(FileReadOwner.prototype, 'list').mockResolvedValueOnce(result)
    const handler = bridge.handlers.get('files:listPublic')!
    await expect(async () => handler({ sender: f.sender, senderFrame: null }, input)).rejects.toThrow(/Untrusted/)
    expect(list).not.toHaveBeenCalled()
    await expect(bridge.api!.files.listPublic(input)).resolves.toEqual(result)
    expect(list).toHaveBeenCalledExactlyOnceWith(input)
  } finally { await f.dispose() }
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
