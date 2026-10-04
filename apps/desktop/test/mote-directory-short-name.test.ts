import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ScratchTopics } from '../src/main/scratch-topics'
import { FileReadOwner } from '../src/main/file-read-owner'
import { spatialSources } from '../src/shared/space-addresses'
import { zoneFileResource } from '../src/shared/zone-file-resource'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { inspectDirectoryIdentity, moteDirectoryName, retainDirectoryIdentity } from '../src/main/scratch-directory-identity.mjs'
import { scratchIdentityContext } from '../src/main/scratch-topic-directories'
import { observeClientRpcSnapshot } from '../src/main/rpc-client-observations'
import { directoryIdentity, homeZoneId, originalTopicAddress } from '../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, scratchTopicIdFromWorkspacePath, workspaceOwnsSessionPath } from '../src/shared/scratch-topics'
import { topicIdForSession, workspaceForSession } from '../src/renderer/src/lib/workbench-tabs'
import { moteConversationIdentity } from '../src/renderer/src/lib/mote-conversation-identity'
import { buildTopicBoardRows } from '../src/renderer/src/lib/project-board'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { topicsWithAgents } from '../src/renderer/src/lib/surface-tool-dock'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { controlledNativeImage } from './fixtures/mote-identity-image'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'mote-short-'))); roots.push(parent)
  const path = join(parent, '.agentmux/scratch'); await mkdir(path, { recursive: true })
  const workspace: WorkspaceRecord = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder', path }
  return { parent, workspace, owner: new ScratchTopics(controlledNativeImage), config: { workspaces: [workspace] } as AppConfig }
}
it.each([PMO_TEAMS_TOPIC_ID, 'launcher:custom-full', 'session:existing-full', 'view:existing-full'])('new canonical uses hash of the exact complete persistent ID, cold-discovers and prepares original cwd: %s', async id => {
  const h = await fixture(), mote = await h.owner.ensureMote(h.workspace, id)
  const expected = createHash('sha256').update(id).digest('hex').slice(0,16)
  expect(basename(mote.physicalDirectoryPath!)).toBe(expected)
  expect(mote.identityDirectoryPath).toBe(mote.physicalDirectoryPath)
  const raw = await readFile(join(mote.physicalDirectoryPath!, '.agentmux/directory-identity.json'), 'utf8')
  expect(JSON.parse(raw)).toEqual({ version: 3, topicId: id, identityRoot: 'motes', identityDirectoryName: expected,
    identityPathHash: createHash('sha256').update(mote.identityDirectoryPath!).digest('hex') })
  expect(raw).not.toContain(h.parent)
  const cold = new ScratchTopics(controlledNativeImage), found = (await cold.list(h.workspace)).find(topic => topic.id === id)!
  expect(found).toMatchObject({ id, physicalDirectoryPath: mote.physicalDirectoryPath, identityDirectoryPath: mote.identityDirectoryPath })
  expect((await cold.prepareAgent(h.workspace, id, { sessionId: 'different-run', providerId: 'codex' })).absolutePath).toBe(mote.physicalDirectoryPath)
  const fileOwner = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
  expect(await fileOwner.read(h.workspace, mote.directoryPath + '/SOUL.md')).toMatchObject({ status: 'read' })
})
it('same full ID metadata-only birth can finish existing original object; damaged or foreign destinations are never adopted', async () => {
  const h = await fixture(), id = 'launcher:partial', path = join(h.parent, '.agentmux/motes', moteDirectoryName(id))
  await mkdir(path, { recursive: true }); await retainDirectoryIdentity(path, await scratchIdentityContext(h.workspace.path, id, path))
  const inode = (await stat(path)).ino
  const done = await h.owner.ensureMote(h.workspace, id)
  expect(done.soul).toBeDefined(); expect((await stat(path)).ino).toBe(inode)
  const targetId = 'launcher:collision', target = join(h.parent, '.agentmux/motes', moteDirectoryName(targetId))
  await mkdir(target); await writeFile(join(target, 'keep.txt'), 'foreign original bytes')
  await expect(h.owner.ensureMote(h.workspace, targetId)).rejects.toThrow('confirmed')
  expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('foreign original bytes')
  await expect(readFile(join(target, 'SOUL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('full-ID collision and digest mismatch preserve the occupied target and do not write SOUL or new identity', async () => {
  const h = await fixture(), id = 'launcher:ours', target = join(h.parent, '.agentmux/motes', moteDirectoryName(id))
  await mkdir(join(target, '.agentmux'), { recursive: true })
  const record = JSON.stringify({ version:3, topicId:'launcher:foreign', identityRoot:'motes', identityDirectoryName:moteDirectoryName(id), identityPathHash:createHash('sha256').update(target).digest('hex') })
  await writeFile(join(target, '.agentmux/directory-identity.json'), record)
  await expect(h.owner.ensureMote(h.workspace, id)).rejects.toThrow('unconfirmed')
  expect(await readFile(join(target, '.agentmux/directory-identity.json'), 'utf8')).toBe(record)
  await expect(readFile(join(target, 'SOUL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each(['scratch', 'motes', 'topics'] as const)('old no-record %s origin keeps exact identity when metadata is explicitly normalized without moving it', async role => {
  const h = await fixture(), id = 'view:old-' + role
  const seed = await h.owner.ensure(h.workspace, id, undefined, false)
  const original = join(h.parent, '.agentmux', role, scratchTopicDirectoryName(id))
  await mkdir(join(h.parent, '.agentmux', role), { recursive:true })
  if (seed.physicalDirectoryPath !== original) await rename(seed.physicalDirectoryPath!, original)
  await writeFile(join(original, 'SOUL.md'), '# Existing original personality\n')
  const inode = (await stat(original)).ino, before = (await h.owner.read(h.workspace,id))!
  await h.owner.normalizeDirectoryIdentities(h.workspace)
  const after = (await new ScratchTopics(controlledNativeImage).read(h.workspace,id))!
  expect(after.identityDirectoryPath).toBe(original); expect(after.physicalDirectoryPath).toBe(original)
  expect((await stat(original)).ino).toBe(inode); expect(after.soul).toEqual(before.soul)
  const record = JSON.parse(await readFile(join(original,'.agentmux/directory-identity.json'),'utf8'))
  expect(record).toMatchObject({ version:3, topicId:id, identityRoot:role })
})
it('configured and verified-real namespace roots retain the actual old no-record identity instead of taking the first root', async () => {
  const h = await fixture(), link = join(h.parent,'configured'); await symlink(join(h.parent,'.agentmux'),link)
  const workspace = {...h.workspace,path:join(link,'scratch')}, id='view:old-real'
  const seed=await h.owner.ensure(workspace,id,undefined,false); await writeFile(join(seed.physicalDirectoryPath!,'SOUL.md'),'# Original\n')
  const original=await realpath(seed.physicalDirectoryPath!)
  await h.owner.normalizeDirectoryIdentities(workspace)
  expect((await h.owner.read(workspace,id))?.identityDirectoryPath).toBe(original)
  expect(original).not.toBe(seed.physicalDirectoryPath)
})
it('one damaged hash directory remains a read-only list/public service issue alongside healthy exact Mote entries', async () => {
  const h=await fixture(), healthy=await h.owner.ensureMote(h.workspace,'launcher:healthy')
  const broken=join(h.parent,'.agentmux/motes','0123456789abcdef'); await mkdir(broken); await writeFile(join(broken,'keep'),'unclaimed bytes')
  const writes=vi.spyOn(h.owner,'normalizeDirectoryIdentities'), list=await h.owner.list(h.workspace)
  expect(list.map(t=>t.id)).toEqual([healthy.id]); expect(list.issues?.[0]).toContain('0123456789abcdef')
  const publicFacts=await observeClientRpcSnapshot(h.config,h.owner,{include:['motes']})
  expect(publicFacts.motes).toHaveLength(1); expect(publicFacts.unavailable?.[0]?.message).toContain('0123456789abcdef')
  expect(writes).not.toHaveBeenCalled(); expect(await readFile(join(broken,'keep'),'utf8')).toBe('unclaimed bytes')
})
it('wrong-root v3 retains SOUL/kind but never mints a physical identity', async () => {
  const h=await fixture(), id='view:wrong-root', seed=await h.owner.ensure(h.workspace,id,undefined,false)
  await writeFile(join(seed.physicalDirectoryPath!,'SOUL.md'),'# Original\n'); await h.owner.normalizeDirectoryIdentities(h.workspace)
  const path=join(seed.physicalDirectoryPath!,'.agentmux/directory-identity.json'), record=JSON.parse(await readFile(path,'utf8'))
  await writeFile(path,JSON.stringify({...record,identityRoot:'motes'}))
  const result=(await h.owner.read(h.workspace,id))!
  expect(result.soul).toBeDefined(); expect(result.readError).toContain('unconfirmed')
  expect(originalTopicAddress(h.workspace,result,{})).toBeNull()
})
it('the same owner transports old middle cwd aliases to original session, author, board and tools; foreign or ambiguous addresses do not associate', async () => {
  const h=await fixture(), id='launcher:alias-owner', seed=await h.owner.ensure(h.workspace,id,undefined,false)
  const original=join(h.workspace.path,scratchTopicDirectoryName(id)), middle=join(h.parent,'.agentmux/motes',scratchTopicDirectoryName(id)), physical=join(h.parent,'.agentmux/motes',moteDirectoryName(id))
  await rename(seed.physicalDirectoryPath!,original); await writeFile(join(original,'SOUL.md'),'# Original\n'); await h.owner.normalizeDirectoryIdentities(h.workspace)
  await mkdir(join(h.parent,'.agentmux/motes'),{recursive:true}); await rename(original,physical)
  await symlink('./'+moteDirectoryName(id),middle); await symlink('../motes/'+scratchTopicDirectoryName(id),original)
  const topic=(await h.owner.read(h.workspace,id))!, topics=[topic]
  expect(topic.confirmedDirectoryPaths).toEqual(expect.arrayContaining([original,middle,physical]))
  const key=directoryIdentity('local',original)
  for(const cwd of [original,middle,physical]) {
    const session={id:'actual',kind:'agent',hostId:'local',workspacePath:cwd,status:{state:'running',source:'run-process',observedAt:1},processState:'running',providerId:'codex',createdAt:1,updatedAt:1} as SessionSnapshot
    expect(scratchTopicIdFromWorkspacePath(h.workspace.path,cwd,topics)).toBe(id)
    expect(workspaceOwnsSessionPath(h.workspace,session,topics)).toBe(true)
    expect(topicIdForSession(h.config,session,topics)).toBe(id); expect(workspaceForSession(h.config,session,topics)).toBe(h.workspace)
    expect(moteConversationIdentity({workspaceId:h.workspace.id,topicId:id,objectKey:key,name:'Original',icon:null,hostId:'local',identityDirectoryPath:original,physicalDirectoryPath:physical,confirmedDirectoryPaths:topic.confirmedDirectoryPaths},session)?.topicId).toBe(id)
    expect(buildTopicBoardRows(topics,h.workspace,[session])[0]?.sessions).toHaveLength(1)
    expect(topicsWithAgents(topics,[session],h.workspace)[0]?.agents).toHaveLength(1)
  }
  expect(scratchTopicIdFromWorkspacePath(h.workspace.path,middle,[topic,{...topic,id:'launcher:foreign'}])).toBeNull()
  expect(scratchTopicIdFromWorkspacePath(h.workspace.path,join(h.parent,'foreign',scratchTopicDirectoryName(id)),topics)).toBeNull()
  expect(homeZoneId(key)).toBe(homeZoneId(directoryIdentity('local',topic.identityDirectoryPath!)))
})

it('current cwd read uses only the same original object and rejects foreign/ambiguous addresses without list discovery', async () => {
  const h=await fixture(),topic=await h.owner.ensureMote(h.workspace,'launcher:cwd-only')
  const list=vi.spyOn(h.owner,'list').mockRejectedValue(new Error('Must not scan library'))
  expect((await h.owner.readForDirectory(h.workspace,topic.physicalDirectoryPath!))?.id).toBe(topic.id)
  expect(await h.owner.readForDirectory(h.workspace,join(h.parent,'foreign',basename(topic.physicalDirectoryPath!)))).toBeNull()
  expect(list).not.toHaveBeenCalled()
})

it('cold healthy Mote is discoverable and usable while an unrelated root is damaged, with global public warning and no writes',async()=>{
  const h=await fixture(),healthy=await h.owner.ensureMote(h.workspace,'launcher:healthy-root')
  await writeFile(join(h.parent,'.agentmux/topics'),'Unrelated damaged root bytes')
  const cold=new ScratchTopics(controlledNativeImage),before=await readFile(join(healthy.physicalDirectoryPath!,'.agentmux/directory-identity.json'),'utf8')
  const list=await cold.list(h.workspace)
  expect(list.find(topic=>topic.id===healthy.id)).toMatchObject({id:healthy.id,identityDirectoryPath:healthy.identityDirectoryPath})
  expect(list.find(topic=>topic.id===healthy.id)?.readError).toBeUndefined();expect(list.issues?.join(' ')).toMatch(/topics root is unconfirmed/)
  expect((await cold.read(h.workspace,healthy.id))?.identityDirectoryPath).toBe(healthy.identityDirectoryPath)
  const publicSnapshot=await observeClientRpcSnapshot(h.config,cold,{include:['motes']})
  expect(publicSnapshot.motes?.map(topic=>topic.id)).toContain(healthy.id);expect(publicSnapshot.unavailable?.[0]?.message).toMatch(/topics root is unconfirmed/)
  expect(await readFile(join(healthy.physicalDirectoryPath!,'.agentmux/directory-identity.json'),'utf8')).toBe(before)
  expect(await readFile(join(h.parent,'.agentmux/topics'),'utf8')).toBe('Unrelated damaged root bytes')
  await expect(cold.ensureMote(h.workspace,'launcher:unconfirmed-new')).rejects.toThrow(/root is unconfirmed/)
})

it('actual old Topic-origin unknown identity preserves the original bound avatar key and refuses only an unconfirmed edit target',async()=>{
  const h=await fixture(),id='view:old-avatar',seed=await h.owner.ensure(h.workspace,id,undefined,false)
  const original=join(h.parent,'.agentmux/topics',scratchTopicDirectoryName(id));await mkdir(join(h.parent,'.agentmux/topics'),{recursive:true});await rename(seed.physicalDirectoryPath!,original)
  await writeFile(join(original,'SOUL.md'),'# Original personality\n');await h.owner.normalizeDirectoryIdentities(h.workspace)
  const metadata=join(original,'.agentmux/directory-identity.json'),record=JSON.parse(await readFile(metadata,'utf8'));record.identityPathHash='0'.repeat(64);await writeFile(metadata,JSON.stringify(record))
  const cold=(await new ScratchTopics(controlledNativeImage).read(h.workspace,id))!
  expect(cold.soul).toBeDefined();expect(cold.physicalDirectoryPath).toBe(original);expect(cold.readError).toBeTruthy();expect(cold.identityDirectoryPath).toBeUndefined()
  expect(topicSpaceIconTarget(h.workspace,cold)).toBeNull()
  const originalKey=directoryIdentity('local',original),binding={[homeZoneId(originalKey)]:{spaceId:originalKey,workspaceId:h.workspace.id,topicId:id,contentKind:'mote' as const}}
  expect(topicSpaceIconTarget(h.workspace,cold,binding)?.key).toBe(originalKey)
  expect(topicSpaceIconTarget(h.workspace,cold,binding)?.avatarTarget).toEqual({workspaceId:h.workspace.id,topicId:id,objectKey:originalKey})
  expect((await h.owner.list(h.workspace)).find(topic=>topic.id===id)?.soul).toBeDefined()
})

it('original public File owner reads exact canonical SOUL through confirmed logical key; foreign, missing alias and ambiguous addresses remain refused',async()=>{
  const h=await fixture(),topic=await h.owner.ensureMote(h.workspace,'launcher:public-file'),facts=spatialSources(h.config,[topic]),zone=facts.zones.find(z=>z.zoneId===homeZoneId(directoryIdentity('local',topic.identityDirectoryPath!)))!
  const files=new WorkspaceFiles(()=>({id:'local',kind:'local'}) as never),owner=new FileReadOwner({files,catalog:async()=>({...facts,tabs:[],regions:[],locations:[]}),workspace:id=>id===h.workspace.id?h.workspace:undefined,topicForDirectory:(workspace,path)=>h.owner.readForDirectory(workspace,path)})
  const params={zoneId:zone.zoneId,spaceId:directoryIdentity('local',topic.identityDirectoryPath!),path:'SOUL.md',expectedResource:{hostId:'local',workspaceId:h.workspace.id,workspacePath:h.workspace.path}}
  expect(await owner.read(params)).toMatchObject({resource:{zonePath:topic.physicalDirectoryPath,path:topic.directoryPath+'/SOUL.md'},result:{status:'read',document:{content:topic.soul!.content}}})
  expect(zoneFileResource(h.workspace,zone,'SOUL.md',[topic]).path).toBe(topic.directoryPath+'/SOUL.md')
  expect(()=>zoneFileResource(h.workspace,{...zone,zoneId:'foreign-zone'},'SOUL.md',[topic])).toThrow('outside')
  expect(()=>zoneFileResource(h.workspace,{...zone,directoryPath:join(h.parent,'foreign')},'SOUL.md',[topic])).toThrow('outside')
  expect(()=>zoneFileResource(h.workspace,zone,'SOUL.md',[topic,{...topic,id:'launcher:foreign'}])).toThrow('outside')
  expect(()=>zoneFileResource(h.workspace,zone,'../outside',[topic])).toThrow('relative path')
  expect(()=>zoneFileResource({...h.workspace,id:'ordinary'}, {...zone,workspaceId:'ordinary'},'SOUL.md',[topic])).toThrow('outside')
  const original=await h.owner.ensure(h.workspace,'view:old-file',undefined,false),oldPath=join(h.workspace.path,original.directoryPath);await writeFile(join(original.physicalDirectoryPath!,'SOUL.md'),'# Original old file\n');await h.owner.normalizeDirectoryIdentities(h.workspace)
  const physical=join(h.parent,'.agentmux/motes',scratchTopicDirectoryName(original.id));await rename(original.physicalDirectoryPath!,physical);await symlink('../motes/'+scratchTopicDirectoryName(original.id),oldPath)
  const confirmed=(await h.owner.read(h.workspace,original.id))!;await rm(oldPath)
  expect((await h.owner.read(h.workspace,original.id))?.identityDirectoryPath).toBe(confirmed.identityDirectoryPath)
  expect(await h.owner.readForDirectory(h.workspace,oldPath)).toBeNull()
})

it('metadata-only fact keeps actual public Note reading usable when unrelated SOUL and Topic bodies cannot be read, through fresh Source CLI',async()=>{
  const h=await fixture(),topic=await h.owner.ensureMote(h.workspace,'launcher:note-cwd'),facts=spatialSources(h.config,[topic]),zone=facts.zones.find(z=>z.zoneId===homeZoneId(directoryIdentity('local',topic.identityDirectoryPath!)))!
  await writeFile(join(topic.physicalDirectoryPath!,'note.md'),'# Original requested Note\n')
  for(const file of ['SOUL.md','topic.md']){await rm(join(topic.physicalDirectoryPath!,file));await mkdir(join(topic.physicalDirectoryPath!,file))}
  const read=vi.spyOn(h.owner,'read'),files=new WorkspaceFiles(()=>({id:'local',kind:'local'}) as never)
  const owner=new FileReadOwner({files,catalog:async()=>({...facts,tabs:[],regions:[],locations:[]}),workspace:id=>id===h.workspace.id?h.workspace:undefined,topicForDirectory:(workspace,path)=>h.owner.readForDirectory(workspace,path)})
  expect((await h.owner.readForDirectory(h.workspace,topic.physicalDirectoryPath!))?.id).toBe(topic.id);expect(read).not.toHaveBeenCalled()
  const input={zoneId:zone.zoneId,path:'note.md',expectedResource:{hostId:'local',workspaceId:h.workspace.id,workspacePath:h.workspace.path}}
  expect(await owner.read(input)).toMatchObject({result:{status:'read',document:{content:'# Original requested Note\n'}}});expect(read).not.toHaveBeenCalled()
  const cli=join(h.parent,'agentmux.mjs'),require=createRequire(resolve(import.meta.dirname,'../../../packages/core/package.json')),{build}=await import(/* @vite-ignore */require.resolve('esbuild'))
  await symlink(resolve(import.meta.dirname,'../../../packages/core/node_modules'),join(h.parent,'node_modules'))
  const built=await build({metafile:true,entryPoints:[resolve(import.meta.dirname,'../../../packages/core/src/agentmux.ts')],outfile:cli,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent',alias:{'@agentmux/demand/goals':resolve(import.meta.dirname,'../../../packages/demand/src/goals.ts'),'@agentmux/demand':resolve(import.meta.dirname,'../../../packages/demand/src/index.ts')}})
  if(process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF){const repository=resolve(import.meta.dirname,'../../..'),rows=await Promise.all(Object.keys(built.metafile.inputs).filter(file=>!file.includes('node_modules/')).map(async file=>({consumer:'actual-source-cli-bundle',file:relative(repository,resolve(file)),sha256:createHash('sha256').update(await readFile(resolve(file))).digest('hex')})));await appendFile(process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF,rows.map(row=>JSON.stringify(row)).join('\n')+'\n')}
  const server=new AgentMuxControlServer({socketPath:join(h.parent,'control.sock'),coreClients:()=>[],files:owner});await server.start()
  try{const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((accept,reject)=>{const child=spawn(process.execPath,[cli,'file','read','--zone',zone.zoneId,'--path','note.md','--host','local','--workspace',h.workspace.id,'--workspace-path',h.workspace.path],{env:objectCliEnvironment(h.parent)});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>accept({code,stdout,stderr}))});expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout).result).toMatchObject({result:{status:'read',document:{content:'# Original requested Note\n'}}})}finally{await server.stop()}
},20000)

it('pending durability warning retains confirmed old identity and live directory, so original Note read remains available without clearing its warning',async()=>{
  const h=await fixture(),id='view:pending-file',seed=await h.owner.ensure(h.workspace,id,undefined,false),physical=join(h.parent,'.agentmux/motes',seed.directoryPath)
  await mkdir(join(h.parent,'.agentmux/motes'),{recursive:true});await rename(seed.physicalDirectoryPath!,physical);await writeFile(join(physical,'SOUL.md'),'# Original pending Mote\n');await writeFile(join(physical,'note.md'),'# Original live Note\n')
  await expect(h.owner.normalizeDirectoryIdentities(h.workspace,{afterReplace:()=>{throw Object.assign(new Error('Injected pending metadata flush unknown'),{code:'EIO'})}})).rejects.toThrow('unconfirmed')
  const snapshot=(await h.owner.read(h.workspace,id))!,facts=spatialSources(h.config,[snapshot]),zone=facts.zones.find(z=>z.zoneId===homeZoneId(directoryIdentity('local',snapshot.identityDirectoryPath!)))!
  expect(snapshot.identityDirectoryPath).toBe(physical);expect(snapshot.readError).toBeTruthy();expect(snapshot.confirmedDirectoryPaths).toContain(physical)
  const files=new WorkspaceFiles(()=>({id:'local',kind:'local'}) as never),owner=new FileReadOwner({files,catalog:async()=>({...facts,tabs:[],regions:[],locations:[]}),workspace:id=>id===h.workspace.id?h.workspace:undefined,topicForDirectory:(workspace,path)=>h.owner.readForDirectory(workspace,path)})
  expect(await owner.read({zoneId:zone.zoneId,path:'note.md',expectedResource:{hostId:'local',workspaceId:h.workspace.id,workspacePath:h.workspace.path}})).toMatchObject({result:{status:'read',document:{content:'# Original live Note\n'}}})
  expect((await h.owner.readForDirectory(h.workspace,physical))?.readError).toBeTruthy()
  expect((await h.owner.read(h.workspace,id))?.readError).toBeTruthy();expect((await observeClientRpcSnapshot(h.config,h.owner,{include:['motes']})).unavailable?.length).toBeGreaterThan(0)
})
