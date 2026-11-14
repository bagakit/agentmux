import { afterEach, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { AgentMuxControlServer, parseFileReadResult, parseFileWriteResult } from '@agentmux/core'
import { OrdinaryWorkspaceFiles } from '../../host/src/ordinary-files.js'
import { FileReadOwner } from '../../host/src/file-read-owner.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { reduceDocumentRead, type FileWorkbenchState } from '../src/renderer/src/lib/file-workbench-state.js'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
const cleanup: Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action()})
const helper=resolve('apps/host/resources/bin/agentmux-workspace-move')
async function fixture(){
 const root=await mkdtemp('/tmp/amx-rid-');cleanup.push(()=>rm(root,{recursive:true,force:true}))
 const workspace={id:'original-workspace',hostId:'local',path:root,name:'Original',kind:'folder' as const}
 await mkdir(join(root,'one'));await writeFile(join(root,'one','value.txt'),'Original body')
 return {root,workspace,files:new OrdinaryWorkspaceFiles({helperPath:helper})}
}
function body(value:Awaited<ReturnType<OrdinaryWorkspaceFiles['read']>>){if(value.status!=='read')throw Error(JSON.stringify(value));return value.document}
async function inode(path:string){return String((await stat(path,{bigint:true})).ino)}
it('actual ordinary and budgeted reads retain the body FD entry and ordered original ancestors without changing byte costs',async()=>{
 const f=await fixture(),path=join(f.root,'one/value.txt'), expected=await inode(path), parent=await inode(join(f.root,'one')),root=await inode(f.root)
 for(const budget of [undefined,{maxFileBytes:4096}]){
  const document=body(await f.files.read(f.workspace,'one/value.txt',budget))
  expect(document.content).toBe('Original body');expect(document.readIdentity?.entry.inode).toBe(expected)
  expect(document.readIdentity?.ancestorWitnesses.map(w=>w.inode)).toEqual([parent,root])
 }
 const range=await f.files.readByteRange(f.workspace,'one/value.txt',{offset:2,maxBytes:3,maxFileBytes:4096})
 expect(Buffer.from(range.bytes).toString()).toBe('igi');expect(range.readCost.payloadBytes).toBe(13)
 expect(range.readIdentity?.entry.inode).toBe(expected)
 const observation=await f.files.statPath(f.workspace,'one/value.txt');if(observation.entry.kind==='absent')throw Error('Original entry absent')
 expect(await f.files.readByteRange(f.workspace,'one/value.txt',{offset:0,maxBytes:3,expectedWitness:observation.entry.witness})).toMatchObject({readIdentity:{entry:{inode:expected}}})
 await expect(f.files.readByteRange(f.workspace,'one/value.txt',{offset:0,maxBytes:3,expectedWitness:{...observation.entry.witness,inode:'0'}})).rejects.toMatchObject({code:'WORKSPACE_FILE_GENERATION_MISMATCH'})
})
it('unbudgeted ordinary body reads remain available beyond the existing 16MiB byte budget',async()=>{
 const f=await fixture(),content='x'.repeat(16*1024*1024+1);await writeFile(join(f.root,'large.txt'),content)
 const document=body(await f.files.read(f.workspace,'large.txt'));expect(document.content.length).toBe(content.length);expect(document.readIdentity?.entry.inode).toBe(await inode(join(f.root,'large.txt')))
 expect(await f.files.read(f.workspace,'large.txt',{maxFileBytes:16*1024*1024})).toMatchObject({status:'error',code:'WORKSPACE_FILE_BYTE_LIMIT'})
})
it('a same-byte pathname replacement after opening never attaches the later inode to the original FD body',async()=>{
 const f=await fixture(),path=join(f.root,'one/value.txt'),original=await inode(path)
 const files=new OrdinaryWorkspaceFiles({helperPath:helper,beforeRead:async()=>{await writeFile(path+'.new','Original body');await rename(path+'.new',path)}})
 const document=body(await files.read(f.workspace,'one/value.txt'));expect(document.content).toBe('Original body')
 expect(await inode(path)).not.toBe(original)
 if(document.readIdentity)expect(document.readIdentity.entry.inode).toBe(original)
})
it('an ancestor changed during the body read withholds only provenance and preserves the original readable bytes',async()=>{
 const f=await fixture();await mkdir(join(f.root,'two'))
 const files=new OrdinaryWorkspaceFiles({helperPath:helper,beforeRead:async()=>{await rename(join(f.root,'one'),join(f.root,'two','one'))}})
 const document=body(await files.read(f.workspace,'one/value.txt'));expect(document.content).toBe('Original body');expect(document.readIdentity).toBeUndefined()
})
it('external explicit-link reads and over-budget ancestry preserve body access without fabricated workspace provenance',async()=>{
 const f=await fixture(),outside=await mkdtemp('/tmp/amx-rid-out-');cleanup.push(()=>rm(outside,{recursive:true,force:true}))
 await writeFile(join(outside,'external.txt'),'External body');await symlink(join(outside,'external.txt'),join(f.root,'external.txt'))
 const external=body(await f.files.read(f.workspace,'external.txt'));expect(external.content).toBe('External body');expect(external.readIdentity).toBeUndefined()
 let path=f.root;for(let i=0;i<256;i++){path=join(path,'d');await mkdir(path)}
 await writeFile(join(path,'deep.txt'),'Deep body')
 const document=body(await f.files.read(f.workspace,('d/').repeat(256)+'deep.txt'));expect(document.content).toBe('Deep body');expect(document.readIdentity).toBeUndefined()
})
it('actual Desktop reader, public compiled file.read and the existing document reducer consume the same FD provenance',async()=>{
 const f=await fixture(),zone={zoneId:'original-zone',workspaceId:f.workspace.id,kind:'directory' as const,hostId:'local',directoryPath:join(f.root,'one'),branch:null}
 const local={id:'local',kind:'local' as const,label:'Local',dispose:async()=>{},run:async()=>{throw Error('No shell allowed')}}
 const files=new WorkspaceFiles(()=>local);cleanup.push(()=>files.dispose())
 const owner=new FileReadOwner({workspace:id=>id===f.workspace.id?f.workspace:undefined,catalog:async()=>({spaces:[],zones:[zone],bindings:[]}),files})
 const server=new AgentMuxControlServer({socketPath:join(f.root,'public.sock'),files:owner});await server.start();cleanup.push(()=>server.stop())
 const read=await files.read(f.workspace,'one/value.txt');const document=body(read);expect(document.readIdentity?.entry.inode).toBe(await inode(join(f.root,'one/value.txt')))
 const key=documentKey(f.workspace.id,'one/value.txt'),state={documents:{[key]:{path:'one/value.txt',content:'Earlier',revision:'sha256:'+'0'.repeat(64)}},documentIssues:{},dirtyDocuments:{},documentGenerations:{},documentObservationGenerations:{},savingDocuments:{},tabs:{}} as unknown as FileWorkbenchState
 expect(reduceDocumentRead(state,f.workspace.id,'one/value.txt',read).documents[key]?.readIdentity).toEqual(document.readIdentity)
 const result=await runCompiledObjectCli(['--endpoint','unix:'+server.path,'file','read','--zone',zone.zoneId,'--path','value.txt','--host','local','--workspace',f.workspace.id,'--workspace-path',f.root],objectCliEnvironment(f.root))
 expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout).result.result.document.readIdentity).toEqual(document.readIdentity)
})
it('fresh package Node imports in either original Files order preserve the strict identity codec and do not widen write receipts',async()=>{
 for(const first of ['public-rpc-files','public-rpc-file-path']){
  const script=`await import(${JSON.stringify(pathToFileURL(resolve('packages/core/dist/'+first+'.js')).href)}); const {parseFileReadIdentity}=await import(${JSON.stringify(pathToFileURL(resolve('packages/core/dist/public-rpc-files.js')).href)}); if(typeof parseFileReadIdentity!=='function')throw Error('Missing original codec'); console.log('original codec loaded')`
  expect((await promisify(execFile)(process.execPath,['--input-type=module','-e',script])).stdout.trim()).toBe('original codec loaded')
 }
 const f=await fixture(),document=body(await f.files.read(f.workspace,'one/value.txt'))
 const saved=await f.files.write(f.workspace,{path:'one/value.txt',content:document.content,expectedRevision:document.revision})
 expect(saved.status).toBe('written');expect(saved).not.toHaveProperty('readIdentity')
 const resource={hostId:'local',workspaceId:f.workspace.id,workspacePath:f.root,zoneId:'z',zonePath:f.root,path:'one/value.txt'}
 expect(()=>parseFileWriteResult({resource,result:{status:'written',revision:document.revision,readIdentity:document.readIdentity}},{zoneId:'z',path:'one/value.txt',expectedResource:resource,content:document.content,expectedRevision:document.revision})).toThrow()
 for(const identity of [{...document.readIdentity,ancestorWitnesses:[]},{...document.readIdentity,extra:true}])expect(()=>parseFileReadResult({resource,result:{status:'read',document:{...document,readIdentity:identity}}},{zoneId:'z',path:'one/value.txt',expectedResource:resource})).toThrow()
 const created=await f.files.write(f.workspace,{path:'new.note.md',content:'Original note witness',expectedRevision:null});if(created.status!=='written'||!created.fileWitness)throw Error('Original exclusive five-field witness missing')
 expect(Object.keys(created.fileWitness).sort()).toEqual(['ctimeNs','device','inode','mtimeNs','size'])
 const reread=body(await f.files.read(f.workspace,'one/value.txt'));expect(reread.revision).toBe(document.revision);expect(reread.readIdentity?.entry.inode).not.toBe(document.readIdentity?.entry.inode)
})
it('oversized, duplicate or incomplete helper metadata cannot revoke successful original bytes or grant an identity',async()=>{
 const f=await fixture(),valid=body(await f.files.read(f.workspace,'one/value.txt')).readIdentity!
 for(const frames of ['AGENTMUX_WORKSPACE_READ_IDENTITY:'+JSON.stringify({...valid,entry:{...valid.entry,birthtimeNs:null}})+'\n','AGENTMUX_WORKSPACE_READ_IDENTITY:'+JSON.stringify({...valid,ancestorWitnesses:Array(257).fill(valid.entry)})+'\n',('AGENTMUX_WORKSPACE_READ_IDENTITY:'+JSON.stringify(valid)+'\n').repeat(2),'AGENTMUX_WORKSPACE_READ_IDENTITY:'+('x'.repeat(70*1024))+'\n','AGENTMUX_WORKSPACE_READ_IDENTITY:'+JSON.stringify(valid),'AGENTMUX_WORKSPACE_READ_IDENTITY:'+JSON.stringify(valid)+'\nAGENTMUX_WORKSPACE_READ_IDENTITY:'+JSON.stringify(valid)]){
  const fake=join(f.root,'private-helper');await writeFile(fake,'#!'+process.execPath+'\nprocess.stderr.write("AGENTMUX_WORKSPACE_READY\\n");process.stdin.resume();process.stdin.on("end",()=>{process.stderr.write('+JSON.stringify(frames)+');process.stdout.write("Original body")})\n');await chmod(fake,0o755)
  const files=new OrdinaryWorkspaceFiles({helperPath:fake}),document=body(await files.read(f.workspace,'one/value.txt'))
  expect(document.content).toBe('Original body');expect(document.readIdentity).toBeUndefined()
 }
})
