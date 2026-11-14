import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
const [root, hostBundle, cliBundle, helper] = process.argv.slice(2)
const scratch = join(root, 'scratch'), repo = join(root, 'project')
await mkdir(scratch, { recursive: true }); await mkdir(repo, { recursive: true })
const workspace = { id: '__scratch__', hostId: 'local', path: scratch, name: 'Topics', kind: 'folder' }
const config = enabled => writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], promotion: { enabled } }))
const source = { hostId: 'local', sessionId: 'OriginalSID', displayWorkspaceId: 'project', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const input = { target: { hostId: 'local', agentSessionId: source.sessionId }, source, title: 'Long-term collaborator', operationId: 'PromoteOriginal001' }
const worker = spawn(process.execPath, ['-e', "process.stdin.on('data',()=>{require('fs').writeFileSync('still-working.txt','same cwd');process.stdout.write('done\\n')})"], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
const pid = worker.pid
const agent = id => ({ kind: 'agent', agentSessionId: id, providerId: 'fixture', executorId: 'fixture', hostId: 'local', workspacePath: repo, run: { runId: id + '-run' }, createdAt: Date.now(), updatedAt: Date.now(), capabilityHash: 'fixture-hash' })
await writeFile(join(root, 'agents.json'), JSON.stringify([agent('OriginalSID'), agent('NeighborSID')]))
const graph = { spaces: [{ spaceId: 'project-space', kind: 'folder', name: 'Project', hostId: 'local', directoryPath: repo, projectId: 'project' }],
 zones: [{ zoneId: 'project-zone', workspaceId: 'project', hostId: 'local', kind: 'directory', directoryPath: repo, branch: null }], bindings: [{ spaceId: 'project-space', zoneId: 'project-zone' }],
 tabs: [{ tabId: source.tabId, workspaceId: 'project', zoneId: 'project-zone', name: null, regionIds: [source.regionId, 'neighbor-region'] }],
 regions: [{ tabId: source.tabId, regionId: source.regionId, kind: 'agent', agentSessionId: source.sessionId, runId: 'OriginalSID-run', execution: { hostId: 'local', cwd: repo, runtimeId: 'fixture-runtime' } }, { tabId: source.tabId, regionId: 'neighbor-region', kind: 'agent', agentSessionId: 'NeighborSID', runId: 'NeighborSID-run', execution: { hostId: 'local', cwd: repo, runtimeId: 'fixture-runtime' } }],
 layouts: { project: { root: { type: 'leaf', groupId: source.groupId }, groups: [{ id: source.groupId, activeTabId: source.tabId, tabOrder: [source.tabId], recentTabIds: [source.tabId] }], activeGroupId: source.groupId } },
 tabLayouts: { [source.tabId]: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', regionId: source.regionId }, second: { type: 'leaf', regionId: 'neighbor-region' } }, activeRegionId: source.regionId } },
 resources: { ['region:' + source.regionId]: { workspaceId: 'project', agentPresentation: { sessionId: 'ui-original', agentSessionId: source.sessionId, hostId: 'local' }, originalDraft: 'keep draft' } } }
await writeFile(join(root, 'spatial.json'), JSON.stringify({ schemaVersion: 1, revision: 1, graph }))
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
const env = { ...clean, AGENTMUX_RPC_ENDPOINT: 'unix:' + join(root, 'rpc.sock'), AGENTMUX_WORKSPACE_MOVE_HELPER: helper, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') }
let host
async function start() {
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
const inspect=()=>jsonCall(['agent','promote','inspect'],{target:input.target})
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
 assert.equal((await apply({...input,operationId:'DifferentOperation001'},false)).error.code,'AGENT_PROMOTION_OPERATION_CONFLICT')
 assert.equal((await inspect()).promotion.operationId,input.operationId)
 await stop(); await config(false); await unlink(join(root,'fail-spatial')); await writeFile(join(root,'fail-completion'),''); await start()
 const unrecorded=(await apply()).promotion
 assert.equal(unrecorded.state,'partial');assert.equal(unrecorded.diskDurability,'unconfirmed');assert.equal(unrecorded.stage,'main','completion marker failure retains the original operation')
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
 const visible=(await apply()).promotion;assert.equal(visible.state,'partial');assert.equal(visible.diskDurability,'unconfirmed');assert.equal(visible.stage,'main','visible marker without fsync is not a durable completion')
 assert.equal((await inspect()).promotion.state,'partial','readable marker cannot replace failed durability ACK')
 await stop();await unlink(join(root,'fail-completion-sync'));await start()
 const complete=(await apply()).promotion
 assert.equal(complete.state,'complete','original partial continues while new promotion switch is disabled')
 assert.equal(complete.moteSpaceId,partial.moteSpaceId);assert.equal(complete.topicId,partial.topicId);assert.equal(complete.target.agentSessionId,source.sessionId)
 assert.equal(await readFile(soul,'utf8'),'# Authored during partial\nPreserve my words.\n')
 const after=JSON.parse(await readFile(join(root,'spatial.json'),'utf8'))
 assert.deepEqual(after.graph.tabs.find(t=>t.tabId===source.tabId),graph.tabs[0]);assert.deepEqual(after.graph.regions.filter(r=>r.tabId===source.tabId),graph.regions)
 assert.deepEqual(after.graph.layouts.project,graph.layouts.project);assert.deepEqual(after.graph.tabLayouts[source.tabId],graph.tabLayouts[source.tabId]);assert.deepEqual(after.graph.resources['region:'+source.regionId],graph.resources['region:'+source.regionId])
 assert.equal(after.graph.bindings.some(b=>b.spaceId===complete.moteSpaceId&&b.zoneId==='project-zone'),false,'promotion must not bind the whole original project Zone')
 const newTabs=after.graph.tabs.filter(t=>t.zoneId===complete.zoneId);assert.equal(newTabs.length,1)
 const members=after.graph.regions.filter(r=>newTabs.some(t=>t.tabId===r.tabId));assert.deepEqual(members.map(r=>r.agentSessionId),[source.sessionId],'only the exact original Agent becomes a member')
 assert.equal(members[0].execution.cwd,repo);assert.equal(members[0].runId,'OriginalSID-run')
 const target={spaceId:complete.moteSpaceId,zoneId:complete.zoneId,expectedResource:{hostId:'local',workspaceId:workspace.id,workspacePath:scratch}}
 const prefs=await jsonCall(['space','mote','preferences','read'],{kind:'quick',target})
 assert.equal(prefs.status,'ready');assert.deepEqual(prefs.defaults.conversation,complete.conversation);assert.equal(prefs.defaults.presence.enabled,false,'promotion does not enable standing maintenance')
 assert.ok(prefs.choices.conversations.some(c=>c.reference.sessionId===source.sessionId),'original main conversation is discoverable through real Mote preferences')
 const moteFile=join(complete.directoryPath,'MOTE.md');const authored=(await readFile(moteFile,'utf8')).replace('enabled: false','enabled: true')+'\n# Later authored settings\n';await writeFile(moteFile,authored)
 await stop(); await start()
 assert.equal((await inspect()).promotion.state,'complete','later authored settings do not erase historical completion')
 assert.equal(await readFile(moteFile,'utf8'),authored)
 const priorRevision=JSON.parse(await readFile(join(root,'spatial.json'),'utf8')).revision
 await apply();assert.equal(JSON.parse(await readFile(join(root,'spatial.json'),'utf8')).revision,priorRevision,'complete apply is idempotent')
 assert.equal(worker.pid,pid);assert.equal(worker.exitCode,null)
 const working=new Promise(yes=>worker.stdout.once('data',yes));worker.stdin.write('work\n');await working;assert.equal(await readFile(join(repo,'still-working.txt'),'utf8'),'same cwd')
 assert.equal((await readdir(join(root,'motes'))).length,1,'all continuations keep the same single Mote')
 await writeFile(join(root,'result.json'),JSON.stringify({passed:true,operationId:input.operationId,agentSessionId:source.sessionId,runId:'OriginalSID-run',workerPid:pid,hostRestarts:5,partial,complete,boundary:'Real Core RPC/CLI, files, spatial state, preferences and Host process restart; Provider session inspection is injected and the original cwd worker is real. No real vendor CLI or installed Desktop claim.'},null,2))
 console.log('Agent promotion: original identity, own data, exact membership, disabled admission, partial/restart continuation and healthy cwd process passed.')
} finally { await stop();worker.kill('SIGTERM') }
