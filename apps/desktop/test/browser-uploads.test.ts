import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { BrowserUploads, BrowserUploadUnconfirmedError, uploadBrowserFiles, type BrowserUploadContext } from '../src/main/browser-uploads'

const removeRace = vi.hoisted(() => ({ before: null as null | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {...actual,rm:async(...args: Parameters<typeof actual.rm>)=>{await removeRace.before?.(String(args[0]));return actual.rm(...args)}}
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { removeRace.before=null;for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(),'agentmux-uploads-'))
  cleanup.push(() => rm(directory,{recursive:true,force:true}))
  const root = join(directory,'workspace');await mkdir(root)
  const workspace: WorkspaceRecord = {id:'workspace',name:'Private workspace',hostId:'local',kind:'folder',path:root}
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const staging = join(directory,'staging')
  const owner = new BrowserUploads(staging,files,() => workspace)
  cleanup.push(() => owner.dispose())
  let navigationId = 'document-1', multiple = true, valid = true, selected: string[] = []
  const send = vi.fn(async (method: string, params?: Record<string,unknown>): Promise<unknown> => {
    if (method === 'DOM.setFileInputFiles') { selected = params!.files as string[]; return {} }
    if (method === 'Runtime.callFunctionOn') {
      if (String(params!.functionDeclaration).includes('Array.from(this.files')) {
        return {result:{value:await Promise.all(selected.map(async path=>({name:path.split('/').at(-1),byteLength:(await readFile(path)).length})))}}
      }
      return valid ? {result:{value:{multiple}}} : {exceptionDetails:{text:'not a file input'}}
    }
    throw new Error('Unexpected CDP method: '+method)
  })
  const context: BrowserUploadContext = {workspaceId:workspace.id,browserId:'browser',operationId:'operation',navigationId,
    currentNavigationId:()=>navigationId,target:{objectId:'exact-object',sendCommand:send}}
  return {owner,files,root,staging,context,send,selected:()=>selected,
    navigate:()=>{navigationId='document-2'},single:()=>{multiple=false},invalidate:()=>{valid=false}}
}

it('snapshots real binary files once, assigns the exact frame object and leaves a later FileList readable', async () => {
  const f=await fixture(), binary=Buffer.from([0,255,128,1,10])
  await writeFile(join(f.root,'bytes.bin'),binary);await writeFile(join(f.root,'second.txt'),'hello')
  const snapshot=vi.spyOn(f.files,'snapshotBytes')
  const receipt=await uploadBrowserFiles(f.owner,f.context,['bytes.bin','second.txt'])
  expect(receipt).toMatchObject({kind:'browser-upload-files',workspaceId:'workspace',browserId:'browser',operationId:'operation',navigationId:'document-1',byteLength:10})
  expect(receipt.files.map(file=>[file.path,file.name,file.byteLength])).toEqual([['bytes.bin','bytes.bin',5],['second.txt','second.txt',5]])
  expect(snapshot).toHaveBeenCalledTimes(2)
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toEqual([['DOM.setFileInputFiles',{objectId:'exact-object',files:f.selected()}]])
  expect(JSON.stringify(receipt)).not.toContain(f.root)
  await writeFile(join(f.root,'bytes.bin'),'changed after the snapshot')
  await expect(readFile(f.selected()[0]!)).resolves.toEqual(binary)
  await f.owner.releaseBrowser('unrelated')
  await expect(readFile(f.selected()[1]!,'utf8')).resolves.toBe('hello')
  await f.owner.releaseBrowser('browser')
  expect(await readdir(f.staging)).toEqual([])
})

it.each(['missing.bin','../outside.bin','escaping.bin'])('does not send missing or escaping Workspace file %s to the input', async path => {
  const f=await fixture();await writeFile(join(f.root,'..','outside.bin'),'outside')
  await symlink(join(f.root,'..','outside.bin'),join(f.root,'escaping.bin'))
  await expect(uploadBrowserFiles(f.owner,f.context,[path])).rejects.toThrow()
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toEqual([])
  expect(await readdir(f.staging)).toEqual([])
})

it('rejects a non-file input, a chooser or a disabled target before reading any Workspace payload', async () => {
  const f=await fixture();f.invalidate();const snapshot=vi.spyOn(f.files,'snapshotBytes')
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toThrow('File chooser dialogs are not supported')
  expect(snapshot).not.toHaveBeenCalled()
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toEqual([])
})

it('accepts a single file and rejects multiple files on a current single-file input', async () => {
  const f=await fixture();f.single();await writeFile(join(f.root,'file.bin'),'one')
  const snapshot=vi.spyOn(f.files,'snapshotBytes')
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin','file.bin'])).rejects.toThrow('only one file')
  expect(snapshot).not.toHaveBeenCalled()
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toEqual([])
  expect((await uploadBrowserFiles(f.owner,f.context,['file.bin'])).files.map(file=>file.name)).toEqual(['file.bin'])
})

it('verifies native FileList values independent of CDP object property order', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'native.bin'), Buffer.from([0, 255, 1, 9]))
  const send = f.send.getMockImplementation()!
  f.send.mockImplementation(async (method, params) => {
    const response = await send(method, params)
    if (method === 'Runtime.callFunctionOn' && String(params!.functionDeclaration).includes('Array.from(this.files'))
      return { result: { value: [{ byteLength: 4, name: 'native.bin' }] } }
    return response
  })
  await expect(uploadBrowserFiles(f.owner, f.context, ['native.bin'])).resolves.toMatchObject({
    files: [{ name: 'native.bin', byteLength: 4 }], byteLength: 4
  })
  await expect(readFile(f.selected()[0]!)).resolves.toEqual(Buffer.from([0, 255, 1, 9]))
})

it('rejects navigation during the pinned file read before assigning any file', async () => {
  const f=await fixture();await writeFile(join(f.root,'file.bin'),'one')
  const actual=f.files.snapshotBytes.bind(f.files)
  vi.spyOn(f.files,'snapshotBytes').mockImplementation(async (...args)=>{const bytes=await actual(...args);f.navigate();return bytes})
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toThrow('document changed')
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toEqual([])
  expect(await readdir(f.staging)).toEqual([])
})

it('a close releases an in-flight upload even before the native document reports navigation', async () => {
  const f=await fixture();await writeFile(join(f.root,'file.bin'),'one')
  const actual=f.files.snapshotBytes.bind(f.files)
  vi.spyOn(f.files,'snapshotBytes').mockImplementation(async (...args)=>{const bytes=await actual(...args);await f.owner.releaseBrowser('browser');return bytes})
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toThrow('released this upload')
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toEqual([])
  expect(await readdir(f.staging)).toEqual([])
})

it('rejects a target whose enabled file-input identity changes while files are being read', async () => {
  const f=await fixture();await writeFile(join(f.root,'file.bin'),'one')
  const actual=f.files.snapshotBytes.bind(f.files)
  vi.spyOn(f.files,'snapshotBytes').mockImplementation(async (...args)=>{const bytes=await actual(...args);f.invalidate();return bytes})
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toThrow('current target is unavailable')
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toEqual([])
  expect(await readdir(f.staging)).toEqual([])
})

it('does not claim completion when the real FileList differs from the selected snapshots', async () => {
  const f=await fixture();await writeFile(join(f.root,'file.bin'),'one')
  const actual=f.send.getMockImplementation()!
  f.send.mockImplementation(async(method,params)=>method==='Runtime.callFunctionOn'&&String(params!.functionDeclaration).includes('Array.from(this.files')?{result:{value:[]}}:actual(method,params))
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toBeInstanceOf(BrowserUploadUnconfirmedError)
  expect(f.selected()).toHaveLength(1)
  await expect(readFile(f.selected()[0]!,'utf8')).resolves.toBe('one')
})

it('an unknown action acknowledgement preserves potentially selected bytes and never retries', async () => {
  const f=await fixture();await writeFile(join(f.root,'file.bin'),'one')
  const actual=f.send.getMockImplementation()!
  f.send.mockImplementation(async(method,params)=>{const result=await actual(method,params);if(method==='DOM.setFileInputFiles')throw new Error('Lost acknowledgement');return result})
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toBeInstanceOf(BrowserUploadUnconfirmedError)
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toHaveLength(1)
  await expect(readFile(f.selected()[0]!,'utf8')).resolves.toBe('one')
})

it('enforces file count and whole-file byte bounds without a partial file upload', async () => {
  const f=await fixture()
  await expect(uploadBrowserFiles(f.owner,f.context,[])).rejects.toThrow('1 to 4')
  await expect(uploadBrowserFiles(f.owner,f.context,Array(5).fill('file.bin'))).rejects.toThrow('1 to 4')
  vi.spyOn(f.files,'snapshotBytes').mockResolvedValue({bytes:Buffer.from('small'),totalBytes:17*1024*1024,revision:'sha256:test',offset:0,returnedBytes:5,nextOffset:5,readCost:{payloadBytes:5}})
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toThrow('complete bounded')
  const large=Buffer.alloc(17*1024*1024)
  vi.spyOn(f.files,'snapshotBytes').mockResolvedValue({bytes:large,totalBytes:large.length,revision:'sha256:test',offset:0,returnedBytes:large.length,nextOffset:null,readCost:{payloadBytes:large.length}})
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toThrow('complete bounded')
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toEqual([])
})

it('the aggregate staging budget is shared by independent Browser documents', async () => {
  const f=await fixture(), bytes=Buffer.alloc(16*1024*1024)
  vi.spyOn(f.files,'snapshotBytes').mockResolvedValue({bytes,totalBytes:bytes.length,revision:'sha256:test',offset:0,returnedBytes:bytes.length,nextOffset:null,readCost:{payloadBytes:bytes.length}})
  for(let index=0;index<8;index++)await uploadBrowserFiles(f.owner,{...f.context,browserId:'browser-'+index},['file.bin'])
  await expect(uploadBrowserFiles(f.owner,{...f.context,browserId:'browser-over-budget'},['file.bin'])).rejects.toThrow('Upload byte budget is full')
  expect(f.send.mock.calls.filter(call=>call[0]==='DOM.setFileInputFiles')).toHaveLength(8)
  await f.owner.releaseBrowser('browser-0')
  expect((await uploadBrowserFiles(f.owner,{...f.context,browserId:'browser-over-budget'},['file.bin'])).byteLength).toBe(bytes.length)
},20_000)

it('dispose cleans only upload snapshots and preserves unrelated files in its private namespace', async () => {
  const f=await fixture();await mkdir(f.staging);await writeFile(join(f.staging,'unrelated.txt'),'retained')
  await writeFile(join(f.root,'file.bin'),'one');await uploadBrowserFiles(f.owner,f.context,['file.bin'])
  await f.owner.dispose()
  expect(await readdir(f.staging)).toEqual(['unrelated.txt'])
  await expect(uploadBrowserFiles(f.owner,f.context,['file.bin'])).rejects.toThrow('owner is closed')
})

it('old-document cleanup cannot consume a new document selection created while its IO is still pending', async () => {
  const f=await fixture();await writeFile(join(f.root,'file.bin'),'one')
  await uploadBrowserFiles(f.owner,f.context,['file.bin'])
  const oldDirectory=dirname(dirname(f.selected()[0]!))
  await uploadBrowserFiles(f.owner,f.context,['file.bin'])
  let unblock!:()=>void,entered!:()=>void
  const held=new Promise<void>(done=>{unblock=done}),started=new Promise<void>(done=>{entered=done})
  removeRace.before=async path=>{if(path===oldDirectory){entered();await held}}
  const release=f.owner.releaseBrowser('browser')
  try {
    await started
    f.navigate()
    const next=await uploadBrowserFiles(f.owner,{...f.context,navigationId:'document-2',operationId:'new-operation'},['file.bin'])
    const newPath=f.selected()[0]!
    unblock();await release
    expect(next).toMatchObject({navigationId:'document-2',operationId:'new-operation'})
    await expect(readFile(newPath,'utf8')).resolves.toBe('one')
    expect(await readdir(f.staging)).toEqual([dirname(dirname(newPath)).split('/').at(-1)])
  } finally {removeRace.before=null;unblock();await release}
})
