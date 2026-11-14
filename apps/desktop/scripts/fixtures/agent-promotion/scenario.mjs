import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, unlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
const [root, hostBundle, cliBundle, helper] = process.argv.slice(2)
const scratch = join(root, 'scratch'), repo = join(root, 'project')
await mkdir(scratch, { recursive: true }); await mkdir(repo, { recursive: true })
const workspace = { id: '__scratch__', hostId: 'local', path: scratch, name: 'Topics', kind: 'folder' }
const config = enabled => writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], promotion: { enabled } }))
const source = { hostId: 'local', sessionId: 'OriginalSID', displayWorkspaceId: 'project', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const input = { target: { hostId: 'local', agentSessionId: source.sessionId }, source, title: 'Long-term collaborator', operationId: 'PromoteOriginal001', destination: { kind: 'new-club' } }
const worker = spawn(process.execPath, ['-e', "process.stdin.on('data',()=>{require('fs').writeFileSync('still-working.txt','same cwd');process.stdout.write('done\\n')})"], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
const pid = worker.pid
const agent = id => ({ kind: 'agent', agentSessionId: id, providerId: 'fixture', executorId: 'fixture', hostId: 'local', workspacePath: repo, run: { runId: id + '-run' }, createdAt: Date.now(), updatedAt: Date.now(), capabilityHash: 'fixture-hash' })
await writeFile(join(root, 'agents.json'), JSON.stringify([agent('OriginalSID'), agent('NeighborSID'),agent('ThirdSID'),agent('LegacySID')]))
const graph = { spaces: [{ spaceId: 'project-space', kind: 'folder', name: 'Project', hostId: 'local', directoryPath: repo, projectId: 'project' }],
 zones: [{ zoneId: 'project-zone', workspaceId: 'project', hostId: 'local', kind: 'directory', directoryPath: repo, branch: null }], bindings: [{ spaceId: 'project-space', zoneId: 'project-zone' }],
 tabs: [{ tabId: source.tabId, workspaceId: 'project', zoneId: 'project-zone', name: null, regionIds: [source.regionId, 'neighbor-region'] }],
 regions: [{ tabId: source.tabId, regionId: source.regionId, kind: 'agent', agentSessionId: source.sessionId, runId: 'OriginalSID-run', execution: { hostId: 'local', cwd: repo, runtimeId: 'fixture-runtime' } }, { tabId: source.tabId, regionId: 'neighbor-region', kind: 'agent', agentSessionId: 'NeighborSID', runId: 'NeighborSID-run', execution: { hostId: 'local', cwd: repo, runtimeId: 'fixture-runtime' } }],
 layouts: { project: { root: { type: 'leaf', groupId: source.groupId }, groups: [{ id: source.groupId, activeTabId: source.tabId, tabOrder: [source.tabId], recentTabIds: [source.tabId] }], activeGroupId: source.groupId } },
 tabLayouts: { [source.tabId]: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', regionId: source.regionId }, second: { type: 'leaf', regionId: 'neighbor-region' } }, activeRegionId: source.regionId } },
 resources: { ['region:' + source.regionId]: { workspaceId: 'project', agentPresentation: { sessionId: 'ui-original', agentSessionId: source.sessionId, hostId: 'local' }, originalDraft: 'keep draft' } } }
for(const id of ['ThirdSID','LegacySID']) {
 graph.tabs.push({tabId:id+'-tab',workspaceId:'project',zoneId:'project-zone',name:id,regionIds:[id+'-region']})
 graph.regions.push({tabId:id+'-tab',regionId:id+'-region',kind:'agent',agentSessionId:id,runId:id+'-run',execution:{hostId:'local',cwd:repo,runtimeId:'fixture-runtime'}})
 graph.layouts.project.groups[0].tabOrder.push(id+'-tab')
 graph.tabLayouts[id+'-tab']={root:{type:'leaf',regionId:id+'-region'},activeRegionId:id+'-region'}
}
await writeFile(join(root, 'spatial.json'), JSON.stringify({ schemaVersion: 1, revision: 1, graph }))
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
const env = { ...clean, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(root, 'rpc.sock'), AGENTMUX_WORKSPACE_MOVE_HELPER: helper, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
let host, hostStarts=0
async function start() {
 hostStarts++
 host = spawn(process.execPath, [hostBundle, root], { env, stdio: ['ignore','pipe','pipe'] }); let out = '', err = ''
 host.stderr.on('data', b => { err += b })
 await new Promise((yes,no) => { const timer=setTimeout(()=>no(Error('Host ready missing: '+err)),20000);host.once('exit',code=>{clearTimeout(timer);no(Error('Host startup exit '+code+': '+err+' STDOUT '+out))});host.stdout.on('data',b=>{out+=b;if(out.includes('READY\n')){clearTimeout(timer);yes()}}) })
}
async function stop() { if(!host || host.exitCode!==null)return;const ended=new Promise(yes=>host.once('exit',yes));host.kill('SIGTERM');await ended }
async function cli(args, success=true) {
 const child=spawn(process.execPath,[cliBundle,...args],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b)
 const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes)})
 if(success){assert.equal(code,0,err);return JSON.parse(out).result}assert.notEqual(code,0);return JSON.parse(err)
}
async function jsonCall(command,value,success=true){ const file=join(root,'input.json');await writeFile(file,JSON.stringify(value));return cli([...command,'--input',file],success) }
const apply=(value=input,success=true)=>jsonCall(['agent','promote','apply'],value,success)
const inspect=(value={target:input.target,operationId:input.operationId})=>jsonCall(['agent','promote','inspect'],value)
const discover=(target=input.target,cursor)=>inspect({target,...(cursor?{cursor}:{})})
try {
 await config(false); await start()
 assert.equal((await apply(input,false)).error.code,'PROMOTION_DISABLED','disabled blocks a NEW Agent promotion')
 assert.equal((await inspect()).promotion,null,'disabled admission did not create a durable operation')
 const topicId='launcher:PolicyTopic001'
 await cli(['topic','create','--topic',topicId,'--title','Policy topic'])
 assert.equal((await cli(['topic','promote','apply','--topic',topicId,'--operation-id','CdEfGhJk3456'],false)).error.code,'PROMOTION_DISABLED','disabled blocks a NEW Topic promotion')
 await config(true)
 const wrong={...input,source:{...source,regionId:'neighbor-region'}}
 assert.equal((await apply(wrong,false)).error.code,'AGENT_PROMOTION_SOURCE_UNCONFIRMED','wrong original occurrence must not create content')
 await writeFile(join(root,'fail-personality'),'')
 const unsynced=(await apply()).promotion;assert.equal(unsynced.state,'partial');assert.equal(unsynced.stage,'files','no durable completion without personality sync owner')
 await unlink(join(root,'fail-personality'))
 await writeFile(join(root,'fail-spatial'),'')
 const partial=(await apply()).promotion
 assert.equal(partial.state,'partial');assert.equal(partial.stage,'spatial');assert.equal(partial.operationId,input.operationId)
 assert.notEqual(partial.directoryPath,repo);assert.ok(partial.directoryPath.startsWith(join(root,'motes')+'/'),'Mote has its own data directory')
 const soul=join(partial.directoryPath,'SOUL.md');await writeFile(soul,'# Authored during partial\nPreserve my words.\n')
 assert.equal((await apply({...input,title:'Changed frozen intent'},false)).error.code,'AGENT_PROMOTION_OPERATION_CONFLICT')
 const found=(await discover()).discovery;assert.deepEqual(found.pending.map(p=>p.operationId),[input.operationId]);assert.equal(found.nextCursor,null)
 assert.equal((await inspect({target:input.target,operationId:'UnknownOperation'})).promotion,null,'exact missing operation never adopts a historical record')
 assert.equal((await inspect()).promotion.operationId,input.operationId)
 await stop(); await config(false); await unlink(join(root,'fail-spatial')); await writeFile(join(root,'fail-completion'),''); await start()
 const unrecorded=(await apply()).promotion
 assert.equal(unrecorded.state,'partial');assert.equal(unrecorded.diskDurability,'unconfirmed');assert.equal(unrecorded.stage,'spatial','completion marker failure retains the original operation')
 assert.equal((await inspect()).promotion.state,'partial','readback does not fabricate completion without a durable record')
 await stop()
 const interrupted=JSON.parse(await readFile(join(root,'spatial.json'),'utf8'))
 interrupted.graph.regions.find(r=>r.regionId===unrecorded.conversation.regionId).execution.runtimeId='wrong-runtime'
 await writeFile(join(root,'spatial.json'),JSON.stringify(interrupted));await start()
 const changed=(await apply()).promotion
 assert.equal(changed.state,'partial');assert.equal(changed.stage,'spatial','same SID cannot replace exact original Runtime occurrence')
 await stop()
 interrupted.graph.regions.find(r=>r.regionId===unrecorded.conversation.regionId).execution.runtimeId='fixture-runtime'
 await writeFile(join(root,'spatial.json'),JSON.stringify(interrupted));await unlink(join(root,'fail-completion'));await writeFile(join(root,'fail-completion-sync'),'');await start()
 const visible=(await apply()).promotion;assert.equal(visible.state,'partial');assert.equal(visible.diskDurability,'unconfirmed');assert.equal(visible.stage,'spatial','visible marker without fsync is not a durable completion')
 assert.equal((await inspect()).promotion.state,'partial','readable marker cannot replace failed durability ACK')
 await stop();await unlink(join(root,'fail-completion-sync'));await start()
 const complete=(await apply()).promotion
 assert.equal(complete.state,'complete','original partial continues while new promotion switch is disabled')
 assert.equal(complete.moteSpaceId,partial.moteSpaceId);assert.equal(complete.topicId,partial.topicId);assert.equal(complete.target.agentSessionId,source.sessionId)
 assert.equal(await readFile(soul,'utf8'),'# Authored during partial\nPreserve my words.\n')
 const after=JSON.parse(await readFile(join(root,'spatial.json'),'utf8'))
 assert.deepEqual(after.graph.tabs.find(t=>t.tabId===source.tabId),graph.tabs[0]);assert.deepEqual(after.graph.regions.filter(r=>r.tabId===source.tabId),graph.regions.filter(r=>r.tabId===source.tabId))
 assert.deepEqual(after.graph.layouts.project,graph.layouts.project);assert.deepEqual(after.graph.tabLayouts[source.tabId],graph.tabLayouts[source.tabId]);assert.deepEqual(after.graph.resources['region:'+source.regionId],graph.resources['region:'+source.regionId])
 assert.equal(after.graph.bindings.some(b=>b.spaceId===complete.moteSpaceId&&b.zoneId==='project-zone'),false,'promotion must not bind the whole original project Zone')
 const newTabs=after.graph.tabs.filter(t=>t.zoneId===complete.zoneId);assert.equal(newTabs.length,1)
 const members=after.graph.regions.filter(r=>newTabs.some(t=>t.tabId===r.tabId));assert.deepEqual(members.map(r=>r.agentSessionId),[source.sessionId],'only the exact original Agent becomes a member')
 assert.equal(members[0].execution.cwd,repo);assert.equal(members[0].runId,'OriginalSID-run')
 const target={spaceId:complete.moteSpaceId,zoneId:complete.zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:scratch}}
 const prefs=await jsonCall(['space','mote','preferences','read'],{kind:'quick',target})
 assert.equal(prefs.status,'ready');assert.equal(prefs.defaults.conversation,undefined,'new Club membership does not appoint a Main')
 assert.ok(prefs.choices.conversations.some(c=>c.reference.sessionId===source.sessionId),'the same Agent is an available Club conversation')
 const moteFile=join(complete.directoryPath,'MOTE.md')
 await assert.rejects(()=>readFile(moteFile),{code:'ENOENT'},'new promotion never writes Main defaults')
 const authored='---\nversion: 1\ndefaults: {}\n---\n# Later authored settings\n';await writeFile(moteFile,authored)
 await stop(); await start()
 assert.equal((await inspect()).promotion.state,'complete','later authored settings do not erase historical completion')
 assert.equal(await readFile(moteFile,'utf8'),authored)
 const membership=(await discover()).discovery
 assert.equal(membership.pending.length,0);assert.equal(membership.memberships.length,1);assert.equal(membership.memberships[0].main,false)
 assert.equal(membership.memberships[0].directoryPath,complete.directoryPath)
 const priorRevision=JSON.parse(await readFile(join(root,'spatial.json'),'utf8')).revision
 await apply();assert.equal(JSON.parse(await readFile(join(root,'spatial.json'),'utf8')).revision,priorRevision,'complete apply is idempotent')
 // Existing Club: real Topic promotion owns its original files, category, home, and authored Main.
 await config(true)
 const promoted=(await cli(['topic','promote','apply','--topic',topicId,'--operation-id','CdEfGhJk3456'])).promotion
 assert.equal(promoted.state,'complete');const originalClub=promoted.topic
 const club={spaceId:promoted.moteSpaceId,zoneId:originalClub.zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:scratch}}
 const snapshot=await discover({hostId:'local',agentSessionId:'NeighborSID'})
 assert.ok(snapshot.discovery.clubs.some(c=>c.target.spaceId===club.spaceId&&c.directoryPath===originalClub.directoryPath))
 const joinSource={...source,sessionId:'NeighborSID',regionId:'neighbor-region'}
 const joinInput={target:{hostId:'local',agentSessionId:'NeighborSID'},source:joinSource,title:'Join existing Club',operationId:'JoinExisting001',destination:{kind:'existing-club',target:club}}
 const originalFiles={};for(const name of ['topic.md','AGENTS.md','SOUL.md'])originalFiles[name]=await readFile(join(originalClub.directoryPath,name),'utf8')
 const mainInput={target:{hostId:'local',agentSessionId:'ThirdSID'},source:{...source,sessionId:'ThirdSID',tabId:'ThirdSID-tab',regionId:'ThirdSID-region'},title:'Existing Main',operationId:'EstablishMainMember',destination:{kind:'existing-club',target:club}}
 const mainMember=(await apply(mainInput)).promotion;assert.equal(mainMember.state,'complete')
 const originalPrefs=await jsonCall(['space','mote','preferences','read'],{kind:'quick',target:club})
 const savedMain=await jsonCall(['space','mote','preferences','save'],{kind:'quick',target:club,baseline:{resource:originalPrefs.source.resource,document:originalPrefs.source.result.status==='read'?originalPrefs.source.result.document:null,defaults:originalPrefs.defaults},values:{conversation:mainMember.conversation},destination:{kind:'occurrence',displayWorkspaceId:mainMember.conversation.displayWorkspaceId,groupId:mainMember.conversation.groupId,tabId:mainMember.conversation.tabId,regionId:mainMember.conversation.regionId},operationId:'SelectOriginalMain'})
 assert.equal(savedMain.status,'saved','the existing Main is authored by its original preferences owner')
 const beforeJoin=await readFile(join(originalClub.directoryPath,'MOTE.md'),'utf8')
 await writeFile(join(root,'fail-personality'),'')
 const joined=(await apply(joinInput)).promotion
 assert.equal(joined.state,'complete');assert.equal(joined.moteSpaceId,club.spaceId);assert.equal(joined.topicId,topicId)
 await unlink(join(root,'fail-personality'))
 for(const [name,content] of Object.entries(originalFiles))assert.equal(await readFile(join(originalClub.directoryPath,name),'utf8'),content,'joining preserves existing '+name)
 assert.equal(await readFile(join(originalClub.directoryPath,'MOTE.md'),'utf8'),beforeJoin,'joining never writes existing Main settings')
 assert.equal((await inspect({target:joinInput.target,operationId:joinInput.operationId})).promotion.state,'complete')
 const joinedDiscovery=(await discover(joinInput.target)).discovery
 assert.equal(joinedDiscovery.pending.length,0);assert.deepEqual(joinedDiscovery.memberships.map(m=>m.target.spaceId),[club.spaceId]);assert.equal(joinedDiscovery.memberships[0].main,false)
 // An unavailable Club leaves exact known choices usable.
 await mkdir(join(root,'agent-promotions'),{recursive:true});await writeFile(join(root,'agent-promotions',createHash('sha256').update(JSON.stringify(['local','UnrelatedSID'])).digest('hex')+'.json'),'invalid')
 assert.equal((await discover(joinInput.target)).discovery.issue,null,'the exact Agent discovery never loads unrelated Agent records')
 const withIssue=JSON.parse(await readFile(join(root,'spatial.json'),'utf8'))
 withIssue.graph.spaces.push({spaceId:'unknown-club',kind:'mote',name:'Unavailable Club',hostId:'local',topicId:'unknown',directoryPath:join(root,'unknown'),projectId:null})
 await stop();await writeFile(join(root,'spatial.json'),JSON.stringify(withIssue));await start()
 const known=(await discover(joinInput.target)).discovery
 assert.ok(known.issue);assert.ok(known.clubs.some(c=>c.target.spaceId===club.spaceId));assert.ok(!known.clubs.some(c=>c.target.spaceId==='unknown-club'))
 assert.equal((await inspect({target:joinInput.target,operationId:joinInput.operationId})).promotion.state,'complete','historical completion never re-evaluates later graph observations')
 // Seed the exact previously persisted first-format object, retaining its original address and Main promise.
 const legacyInput={target:{hostId:'local',agentSessionId:'LegacySID'},source:{...source,sessionId:'LegacySID',tabId:'LegacySID-tab',regionId:'LegacySID-region'},title:'Retained original promise',operationId:'LegacyOriginal001',destination:{kind:'new-club'}}
 await writeFile(join(root,'fail-spatial'),'')
 const legacyPartial=(await apply(legacyInput)).promotion;assert.equal(legacyPartial.state,'partial')
 await stop();await unlink(join(root,'fail-spatial'))
 const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
 const targetKey=digest([legacyInput.target.hostId,legacyInput.target.agentSessionId]),legacyOrigin=join(root,'agent-promotions',targetKey+'.json')
 const newPath=join(root,'agent-promotions',targetKey,digest(legacyInput.operationId)+'.json')
 const historical=JSON.parse(await readFile(newPath,'utf8'));historical.version=1;delete historical.destination
 const originalBytes=JSON.stringify(historical)+'\n';await writeFile(legacyOrigin,originalBytes);await unlink(newPath)
 await config(false);await start()
 assert.equal((await discover(legacyInput.target)).discovery.pending[0].operationId,legacyInput.operationId)
 const legacyComplete=(await apply(legacyInput)).promotion;assert.equal(legacyComplete.state,'complete','an admitted original operation continues while new admission is disabled')
 const legacyTarget={spaceId:legacyComplete.moteSpaceId,zoneId:legacyComplete.zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:scratch}}
 const legacyPrefs=await jsonCall(['space','mote','preferences','read'],{kind:'quick',target:legacyTarget})
 assert.deepEqual(legacyPrefs.defaults.conversation,legacyComplete.conversation,'only the admitted first-format operation keeps its original Main promise')
 assert.equal(legacyPrefs.defaults.presence.enabled,false)
 const originalMarker=await readFile(legacyOrigin+'.complete','utf8');assert.equal(originalMarker,legacyInput.operationId+'\n')
 const legacyMote=join(legacyComplete.directoryPath,'MOTE.md');const laterMain=(await readFile(legacyMote,'utf8')).replace('enabled: false','enabled: true');await writeFile(legacyMote,laterMain)
 await stop();await start()
 assert.equal((await inspect({target:legacyInput.target,operationId:legacyInput.operationId})).promotion.state,'complete')
 assert.equal(await readFile(legacyOrigin,'utf8'),originalBytes,'the original operation is never rewritten or migrated')
 assert.equal(await readFile(legacyOrigin+'.complete','utf8'),originalMarker)
 assert.equal(await readFile(legacyMote,'utf8'),laterMain,'completed history never replays Main authoring')
 // Many retained operations are discovered in scoped pages; unrelated Agent records are not opened.
 const operationDir=join(root,'agent-promotions',targetKey);await mkdir(operationDir,{recursive:true})
 const pendingIds=[]
 for(let index=0;index<35;index++) {
  const operationId='RetainedPending'+String(index).padStart(3,'0');pendingIds.push(operationId)
  const pending={...historical,version:2,operationId,destination:{kind:'existing-club',target:club},topicId,moteSpaceId:club.spaceId,zoneId:club.zoneId,directoryPath:originalClub.directoryPath,conversation:{...historical.conversation,tabId:'pending-tab-'+index,regionId:'pending-region-'+index}}
  await writeFile(join(operationDir,digest(operationId)+'.json'),JSON.stringify(pending)+'\n')
 }
 const allPending=[];let cursor,pendingPages=0
 do {pendingPages++;const page=(await discover(legacyInput.target,cursor)).discovery;assert.ok(page.pending.length<=32);allPending.push(...page.pending.map(p=>p.operationId));cursor=page.nextCursor}while(cursor)
 assert.deepEqual(allPending.sort(),pendingIds.sort(),'no pending operation is hidden behind a partial page')
 const wrongCursor=(await discover(legacyInput.target)).discovery.nextCursor
 assert.equal((await jsonCall(['agent','promote','inspect'],{target:joinInput.target,cursor:wrongCursor},false)).error.code,'INVALID_CONTROL_REQUEST','cursor cannot select another Agent operation scope')
 assert.equal((await inspect({target:legacyInput.target,operationId:'UnknownRetained'})).promotion,null)
 await rename(operationDir,operationDir+'.retained');await writeFile(operationDir,'unavailable directory')
 const unavailableScan=(await discover(legacyInput.target)).discovery
 assert.ok(unavailableScan.issue);assert.ok(unavailableScan.nextCursor,'a failed operation directory read cannot claim the pending set is complete')
 assert.ok(unavailableScan.clubs.some(c=>c.target.spaceId===club.spaceId),'unavailable history does not hide a known Club')
 await unlink(operationDir);await rename(operationDir+'.retained',operationDir)
 assert.equal(await readFile(legacyOrigin,'utf8'),originalBytes)
 assert.equal(worker.pid,pid);assert.equal(worker.exitCode,null)
 const working=new Promise(yes=>worker.stdout.once('data',yes));worker.stdin.write('work\n');await working;assert.equal(await readFile(join(repo,'still-working.txt'),'utf8'),'same cwd')
 assert.equal((await readdir(join(root,'motes'))).length,3,'two explicit new Clubs plus one promoted existing Club; joining creates no directory')
 await writeFile(join(root,'result.json'),JSON.stringify({passed:true,operationId:input.operationId,agentSessionId:source.sessionId,runId:'OriginalSID-run',workerPid:pid,hostRestarts:hostStarts-1,partial,complete,joined,legacyComplete,pendingPages,retainedPending:pendingIds.length,boundary:'Real Core RPC/CLI, files, spatial state, preferences and Host process restart; Provider session inspection is injected and the original cwd worker is real. No real vendor CLI or installed Desktop claim.'},null,2))
 console.log('Agent promotion: original identity, own data, exact membership, disabled admission, partial/restart continuation and healthy cwd process passed.')
} finally { await stop();worker.kill('SIGTERM') }
