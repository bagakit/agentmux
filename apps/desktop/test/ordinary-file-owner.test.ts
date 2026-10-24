import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import { FileResourceOwner } from '@agentmux/host/file-resource'
import { OrdinaryWorkspaceFiles } from '@agentmux/host/ordinary-files'
import { MoteConnectionPreferences } from '@agentmux/host/mote-connection-preferences'
import { moteConnectionBaseline } from '@agentmux/core/mote-preferences'
import { SCRATCH_WORKSPACE_ID, directoryIdentity, homeZoneId } from '@agentmux/host/mote-model'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const revision = (content: string) => 'sha256:' + createHash('sha256').update(content).digest('hex')
const local = { id: 'local', kind: 'local' as const, label: 'Local', run: vi.fn(), dispose: async () => {} }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-ordinary-file-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = { id: 'original-workspace', path: root, hostId: 'local', name: 'Original', kind: 'folder' as const }
  await Promise.all(['one','two'].map(name => mkdir(join(root,name))))
  const zone = { zoneId: 'original-zone', workspaceId: workspace.id, kind: 'directory' as const, hostId: workspace.hostId, directoryPath: join(root,'one'), branch: null }
  const catalog = async () => ({ spaces: [], zones: [zone], bindings: [] })
  const files = new WorkspaceFiles(() => local); cleanup.push(() => files.dispose())
  const owner = new FileReadOwner({ catalog, workspace: id => id === workspace.id ? workspace : undefined, files })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'public.sock'), files: owner }); await server.start(); cleanup.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport:'unix', path:server.path } }); cleanup.push(() => client.dispose())
  return { root, workspace, zone, files, owner, client }
}

it('the shared resolver keeps the original full public resource before any native write', async () => {
  const f = await fixture(); await Promise.all(['one','two'].map(name => writeFile(join(f.root,name,'MOTE.md'), 'Original ' + name)))
  const read = await f.client.call('file.read', { zoneId:f.zone.zoneId,path:'MOTE.md',expectedResource:{hostId:'local',workspaceId:f.workspace.id,workspacePath:f.root} })
  if(read.result.status !== 'read' || !read.resource) throw Error('Original resource must be read')
  f.zone.directoryPath=join(f.root,'two')
  const outcome = await f.client.call('file.write', {zoneId:f.zone.zoneId,path:'MOTE.md',expectedResource:read.resource,expectedRevision:revision('Original two'),content:'Wrong target write'}).then(value=>({value}), error=>({error}))
  // Check the actual target first: protocol validation of a wrong returned mapping is too late.
  expect(await readFile(join(f.root,'two','MOTE.md'),'utf8')).toBe('Original two')
  expect(outcome).toMatchObject({error:{code:'FILE_RESOURCE_MISMATCH'}})
  expect(await readFile(join(f.root,'one','MOTE.md'),'utf8')).toBe('Original one')
})

it('the original requested revision keeps a later real disk edit intact', async () => {
  const f = await fixture(), path=join(f.root,'one','MOTE.md')
  await writeFile(path,'Original')
  const read=await f.client.call('file.read',{zoneId:f.zone.zoneId,path:'MOTE.md',expectedResource:{hostId:'local',workspaceId:f.workspace.id,workspacePath:f.root}})
  if(read.result.status!=='read'||!read.resource)throw Error('Original revision must be read')
  await writeFile(path,'External later edit')
  const result=await f.client.call('file.write',{zoneId:f.zone.zoneId,path:'MOTE.md',expectedResource:read.resource,expectedRevision:read.result.document.revision,content:'Stale request bytes'})
  expect(await readFile(path,'utf8')).toBe('External later edit')
  expect(result.result).toEqual({status:'conflict',observedRevision:revision('External later edit')})
})

it('Main ordinary writes and exact deletion retain one physical scope across different original path aliases', async () => {
  const f = await fixture(); await symlink(f.root, join(f.root,'alias'),'dir')
  const created=await f.files.write(f.workspace,{path:'value.txt',content:'Original',expectedRevision:null})
  if(created.status !== 'written' || !created.fileWitness) throw Error('A real native creation witness is required')
  let release!:()=>void, claimed!:()=>void
  const claim=new Promise<void>(resolve=>{claimed=resolve}), held=new Promise<void>(resolve=>{release=resolve})
  // Use one actual Main instance, whose original deletion and ordinary write must coordinate.
  const files=new WorkspaceFiles(()=>local,{beforeLocalDeleteClaim:async()=>{claimed();await held}}); cleanup.push(()=>files.dispose())
  const deleting=files.deleteExact(f.workspace,{path:'value.txt',expectedRevision:created.revision,witness:created.fileWitness,operationId:'original-delete'})
  await claim
  const writing=files.write(f.workspace,{path:'alias/value.txt',content:'Later',expectedRevision:created.revision})
  // This is a controlled observation while the exact delete deliberately holds its original scope.
  const early=await Promise.race([writing.then(()=>true),new Promise<false>(resolve=>setTimeout(()=>resolve(false),150))])
  release()
  const [removed,saved]=await Promise.all([deleting,writing])
  expect(early).toBe(false)
  expect(removed).toEqual({status:'deleted'})
  expect(saved).toMatchObject({status:'conflict',observedRevision:null})
  expect(await readFile(join(f.root,'value.txt'),'utf8').catch(error=>error.code)).toBe('ENOENT')
})

it('the shared preferences owner rechecks the original actor immediately before the real File effect', async () => {
  const f=await fixture(), directory=join(f.root,'one'), spaceId=directoryIdentity('local',directory), zoneId=homeZoneId(spaceId)
  const workspace={...f.workspace,id:SCRATCH_WORKSPACE_ID};f.zone.workspaceId=workspace.id;f.zone.zoneId=zoneId
  const catalog=async()=>({spaces:[{spaceId,kind:'mote' as const,name:'Original',hostId:'local',directoryPath:directory,projectId:null,topicId:'original'}],zones:[{...f.zone,kind:'home' as const}],bindings:[{spaceId,zoneId}]})
  await writeFile(join(directory,'MOTE.md'),'---\nversion: 1\n---\nOriginal body\n')
  const publicFiles=new FileResourceOwner({catalog,workspace:async id=>id===workspace.id?workspace:undefined,files:f.files})
  const owner=new MoteConnectionPreferences({files:publicFiles,catalog,connections:async()=>({connections:[]})})
  const target={spaceId,zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:f.root}}
  const before=await owner.read({kind:'connection',target}), baseline=moteConnectionBaseline(before)
  if(!baseline)throw Error('The original baseline must be read')
  const create = vi.spyOn(publicFiles, 'create')
  const current=vi.fn(async()=>{throw Error('Original actor revoked before effect')})
  const saved=await owner.save({kind:'connection',target,baseline,operationId:'original-save',values:{connection:null}}, {actor:{kind:'user',id:'original-person'},assertCurrent:current})
  // Same-value existing files return unchanged without an effect, so force an exclusive creation.
  expect(saved.status).toBe('unchanged');expect(current).not.toHaveBeenCalled()
  await rm(join(directory,'MOTE.md'))
  const absent=moteConnectionBaseline(await owner.read({kind:'connection',target}))!
  const refused=await owner.save({kind:'connection',target,baseline:absent,operationId:'original-create',values:{connection:null}}, {actor:{kind:'user',id:'original-person'},assertCurrent:current})
  expect(refused).toMatchObject({status:'refused-before-write',source:null})
  expect(current).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled()
  expect(await readFile(join(directory,'MOTE.md'),'utf8').catch(error=>error.code)).toBe('ENOENT')
  expect(await owner.read({kind:'connection',target})).toMatchObject({status:'ready'})
  const actor={kind:'user' as const,id:'same-original-person'}
  expect(await owner.save({kind:'connection',target,baseline:absent,operationId:'confirmed-create',values:{connection:null}}, {actor,assertCurrent:async()=>{}})).toMatchObject({status:'saved'})
  expect(create.mock.calls[0]?.[1]).toEqual({actor})
})

it('the shared ordinary leaf keeps real name discovery, bounded bytes and exclusive competing bytes', async()=>{
 const f=await fixture(), files=new OrdinaryWorkspaceFiles({localWriteFault:'occupy'})
 await writeFile(join(f.root,'one','plain.txt'),'Original text')
 expect(await files.listFiles(f.workspace,'one',1)).toMatchObject({status:'listed',files:['plain.txt']})
 const read=await files.read(f.workspace,'one/plain.txt',{maxFileBytes:1024})
 expect(read).toMatchObject({status:'read',document:{content:'Original text',revision:revision('Original text')}})
 const created=await files.write(f.workspace,{path:'one/competing.txt',content:'Our bytes',expectedRevision:null})
 expect(await readFile(join(f.root,'one','competing.txt'),'utf8')).toBe('competing bytes')
 expect(created).toMatchObject({status:'conflict'})
})

it('the actual Renderer resource bridge stays browser-safe while retaining exact file mapping', async () => {
  const {build}=createRequire(resolve('apps/host/package.json'))('esbuild') as typeof import('esbuild')
  const output=await build({entryPoints:['apps/desktop/src/renderer/src/lib/zone-file-resource.ts'],bundle:true,platform:'browser',format:'esm',write:false,metafile:true,logLevel:'silent',plugins:[{
    name:'original-host-pure-entries',setup(builder){builder.onResolve({filter:/^@agentmux\/host\//},args=>({path:resolve('apps/host/src',args.path.slice('@agentmux/host/'.length)+'.ts')}))}
  }]})
  expect(output.outputFiles).toHaveLength(1)
  expect(Object.keys(output.metafile!.inputs).some(path=>path.endsWith('/file-resource-model.ts'))).toBe(true)
  expect(Object.keys(output.metafile!.inputs).some(path=>path.endsWith('/file-resource.ts')||path.includes('ordinary-files'))).toBe(false)
  const bridge=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles![0]!.text).toString('base64'))
  expect(bridge.zoneFileResource({id:'workspace',hostId:'local',path:'/original'}, {zoneId:'zone',workspaceId:'workspace',kind:'directory',hostId:'local',directoryPath:'/original/topic',branch:null}, 'MOTE.md')).toEqual({directoryPath:'/original/topic',relativeDirectory:'topic',path:'topic/MOTE.md'})
})
