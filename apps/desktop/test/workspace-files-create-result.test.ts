import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { WorkspaceFiles } from '../src/main/workspace-files'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
describe('Files exclusive creation', () => {
  it('refuses a name occupied after its last CAS check', async () => {
    const root = await mkdtemp(join(tmpdir(),'amx-note-create-counter-')); roots.push(root)
    const workspace: WorkspaceRecord = { id:'resource', name:'Resource', hostId:'local', path:root, kind:'folder' }
    const files = new WorkspaceFiles(id => ({ id,kind:'local',label:'Local',run:vi.fn(),exposeLoopbackPort:async port=>port,dispose:async()=>{} }), {localWriteFault:'occupy'})
    const result = await files.write(workspace,{path:'note.note.json',content:'our note',expectedRevision:null})
    const bytes = await readFile(join(root,'note.note.json'),'utf8')
    console.log(JSON.stringify({case:'atomic-name-collision',result,bytes}))
    expect(result.status).toBe('conflict'); expect(bytes).toBe('competing bytes')
  })
})

describe('Files creation verdicts', () => {
  it('retains published bytes when the write receipt fails', async () => {
    const root = await mkdtemp(join(tmpdir(),'amx-note-receipt-')); roots.push(root)
    const workspace: WorkspaceRecord = {id:'r',name:'R',hostId:'local',path:root,kind:'folder'}
    const files = new WorkspaceFiles(id=>({id,kind:'local',label:'Local',run:vi.fn(),exposeLoopbackPort:async port=>port,dispose:async()=>{}}),{localWriteFault:'receipt'})
    const result=await files.write(workspace,{path:'same.note.json',content:'published',expectedRevision:null})
    expect(result).toEqual({status:'unknown',code:'INJECTED_WRITE_RECEIPT',message:'Write was published but its receipt failed'})
    expect(await readFile(join(root,'same.note.json'),'utf8')).toBe('published')
  })
  it.each(['EACCES','ENOSPC'])('keeps %s as a known write-before-publication error', async code=>{
    const root=await mkdtemp(join(tmpdir(),'amx-note-error-')); roots.push(root)
    const workspace:WorkspaceRecord={id:'r',name:'R',hostId:'local',path:root,kind:'folder'}
    const files=new WorkspaceFiles(id=>({id,kind:'local',label:'Local',run:vi.fn(),exposeLoopbackPort:async port=>port,dispose:async()=>{}}),{beforeWrite:async()=>{throw Object.assign(new Error('before write'),{code})}})
    expect(await files.write(workspace,{path:'never.note.json',content:'draft',expectedRevision:null})).toEqual({status:'error',code,message:'before write'})
    await expect(readFile(join(root,'never.note.json'))).rejects.toMatchObject({code:'ENOENT'})
  })
})
