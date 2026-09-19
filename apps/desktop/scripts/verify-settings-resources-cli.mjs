import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '../../../packages/core/dist/index.js'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { activate, desktopFixture } from './fixtures/settings-cli/desktop.mjs'
import { preferenceVocabulary } from './fixtures/settings-cli/preferences.mjs'
import { resourceProof } from './fixtures/settings-cli/resources.mjs'

// Real bundled Desktop/Main IPC + Core + built CLI. Only initial private fixture materialization
// writes configuration directly; every setting operation after launch goes through the product owner.
const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
const require = createRequire(join(desktopRoot, 'package.json')), exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const root = await mkdtemp('/tmp/amx-settings-resources-desktop-')
const evidenceRoot = join(repositoryRoot, '.tmp/settings-resources-cli')
const evidence = join(evidenceRoot, `run-${Date.now()}-${randomUUID()}`), userData = join(root, 'user-data')
const privateHome = join(root, 'home'), codexHome = join(privateHome, 'codex'), runtimeDirectory = join(root, 'runtime')
const workspacePath = join(root, 'workspace'), topicsPath = join(root, 'topics'), configPath = join(userData, 'agentmux.config.json')
const cli = join(repositoryRoot, 'packages/core/bin/agentmux')
class PrivateChildren extends Set {
  add(child) {
    const fact={pid:child.pid,startedAt:Date.now(),stderr:`electron-${child.pid}.stderr.log`};receipt.electronProcesses??=[];receipt.electronProcesses.push(fact)
    child.stderr.on('data',bytes=>appendFileSync(join(evidence,fact.stderr),bytes))
    child.once('exit',(code,signal)=>Object.assign(fact,{code,signal,exitedAt:Date.now()}))
    return super.add(child)
  }
}
const children = new PrivateChildren(), connections = new Set(), startedAt=Date.now(), deadline = startedAt + 240_000
const originalFetch=globalThis.fetch
// Bound the maintained launch seam's local debugger HTTP await, including its body read.
globalThis.fetch=async (input,options={}) => {
  const url=new URL(String(input));assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Private debugger fetch stays on loopback')
  const requestedAt=Date.now(),budget=Math.max(1,Math.min(5_000,deadline-requestedAt))
  const fact={url:url.href,requestedAt,timeoutMs:budget};receipt.debuggerHttp??=[];receipt.debuggerHttp.push(fact)
  const signal=options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(budget)]) : AbortSignal.timeout(budget)
  try {const response=await originalFetch(input,{...options,signal});const bytes=await response.text();fact.status=response.status;fact.elapsedMs=Date.now()-requestedAt;const parsed=JSON.parse(bytes);if(Array.isArray(parsed))fact.targets=parsed.map(({id,type,url,title})=>({id,type,url,title}));return {json:async()=>parsed}}
  catch(error){fact.elapsedMs=Date.now()-requestedAt;fact.error={name:error.name,message:error.message,cause:error.cause?{name:error.cause.name,message:error.cause.message,code:error.cause.code}:null};throw error}
}
const workspaceId = 'settings-cli-workspace', tabId = 'settings-cli-tab', groupId = 'settings-cli-group'
const agentRegionId = 'settings-cli-agent', fileRegionId = 'settings-cli-file'
const environment = { HOME: privateHome, CODEX_HOME: codexHome, AGENTMUX_DESKTOP_USER_DATA: userData,
  AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'private-messages.ndjson') }
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'CODEX_HOME'].map(name => [name, process.env[name]]))
const receipt = { schema: 'agentmux.settings-resources-cli-desktop-proof.v1', passed: false, cli: [], facts: {}, cleanup: {},
  fixture: { userData, privateHome, runtimeDirectory, workspacePath, topicsPath, syntheticPty: true } }
let phase = 'prepare', failure, first, second, session, client, ownedRunProcess, originalRun, resources, store, originalSession, originalHistory
let observeWrites=true, inputSerial=0

async function waitFor(label, read, budget = 20_000) {
  const end = Math.min(deadline, Date.now() + budget)
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60) }
  throw new Error(`Settings CLI timed out: ${label}`)
}
const launch = desktopFixture({ desktopRoot, root, privateHome, environment, children, connections, waitFor })
async function identity() {
  const resolver="import {pathToFileURL} from 'node:url';console.log(JSON.stringify(Object.fromEntries(['@agentmux/core','@agentmux/demand'].map(name=>[name,import.meta.resolve(name,pathToFileURL(process.argv[1]).href)]))))"
  const resolved=JSON.parse((await exec(process.execPath,['--experimental-import-meta-resolve','--input-type=module','-e',resolver,join(desktopRoot,'out/main/index.js')],{timeout:5_000})).stdout)
  const inputs={}
  for(const [name,directory] of [['@agentmux/core','packages/core'],['@agentmux/demand','packages/demand']]) {
    const actual=await realpath(join(desktopRoot,'node_modules',name)),expected=await realpath(join(repositoryRoot,directory))
    assert.equal(actual,expected,'Actual Main external package must match this candidate')
    const manifest=JSON.parse(await readFile(join(actual,'package.json'),'utf8')),entry=manifest.exports['.'].import
    assert.equal(typeof entry,'string');assert.ok(entry.startsWith('./dist/'));inputs[name]=fileURLToPath(resolved[name]);assert.equal(inputs[name],join(actual,entry),'Actual Main ESM import and declared candidate entry agree')
  }
  receipt.mainModuleInputs=inputs
  const directories = ['apps/desktop/src', 'packages/core/src', 'packages/demand/src', 'apps/desktop/out', 'packages/core/dist', 'packages/demand/dist',
    'apps/desktop/scripts/fixtures/settings-cli']
  const files = ['apps/desktop/scripts/verify-settings-resources-cli.mjs', 'apps/desktop/scripts/probe-process.mjs',
    'packages/core/bin/agentmux', 'packages/core/package.json', 'packages/demand/package.json', 'apps/desktop/package.json',
    'packages/core/scripts/build.mjs', 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json']
  for (const directory of directories) {
    const entries = await readdir(join(repositoryRoot, directory), { recursive: true, withFileTypes: true })
    const found = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
    assert.ok(found.length > 0, `Identity input must be nonempty: ${directory}`)
    files.push(...found)
  }
  const entries = await Promise.all(files.sort().map(async path => {
    const absolute = resolve(repositoryRoot, path), bytes = await readFile(absolute)
    return [absolute.startsWith(repositoryRoot + '/') ? absolute.slice(repositoryRoot.length + 1) : absolute, digest(bytes)]
  }))
  entries.push([require('electron'), digest(await readFile(require('electron')))])
  return Object.fromEntries(entries)
}
async function command(args, expectedCode = 0, stdin) {
  const result = await new Promise(resolveResult => {
    const child=execFile(process.execPath,[cli,...args],{timeout:10_000,
      env:{...process.env,...environment,AGENTMUX_ENV:undefined,AGENTMUX_AGENT_SESSION_ID:undefined}},(error,stdout,stderr)=>resolveResult({code:error?.code ?? 0,stdout,stderr}))
    child.stdin.end(stdin)
  })
  const payload=JSON.parse(result.code===0 ? result.stdout : result.stderr)
  receipt.cli.push({phase,args,code:result.code,stdout:result.stdout,stderr:result.stderr,receipt:payload})
  assert.equal(result.code,expectedCode,JSON.stringify(payload));assert.equal(payload.ok,expectedCode===0)
  assert.equal(typeof payload.requestId,'string');assert.ok(payload.requestId.length>0)
  return payload
}
async function resource(kind, action, id, input, expectedCode=0, stdin=false) {
  const args=['settings',kind,action,...(id===undefined ? [] : [id])]
  let body
  if(input!==undefined) {
    body=JSON.stringify(input)
    const path=join(root,`resource-input-${++inputSerial}.json`)
    if(stdin)args.push('--input','-')
    else {await writeFile(path,body);args.push('--input',path)}
  }
  const probe=second??first
  const publications=observeWrites && probe ? await probe.cdp.evaluate('window.__settingsResourcesProof.configEvents.length') : undefined
  const payload=await command(args,expectedCode,stdin ? body : undefined)
  if(expectedCode!==0)return payload
  assert.equal(payload.operation,`settings.resource.${action}`);assert.equal(payload.result.resource,kind)
  if(action==='list'){assert.equal(payload.result.partial,true);assert.ok(Array.isArray(payload.result.items))}
  else if(action==='get' || action==='add' || action==='update')assert.equal(payload.result.item.id,id)
  else {assert.equal(payload.result.id,id);assert.equal(payload.result.removed,true)}
  if(publications!==undefined && (payload.result.changed===true || payload.result.removed===true)) {
    await waitFor('committed resource publishes exactly once',()=>probe.cdp.evaluate(`window.__settingsResourcesProof.configEvents.length===${publications+1}`))
  }
  return payload.result
}
async function observe(probe) {
  await probe.cdp.evaluate(`(() => {
    window.__settingsResourcesProof={configEvents:[],controlRequests:[],inputEvents:[]}
    window.agentmux.config.onChange(config=>window.__settingsResourcesProof.configEvents.push({executors:config.executors,prompts:config.composerShortcuts}))
    window.agentmux.control.onRequest(request=>window.__settingsResourcesProof.controlRequests.push(request.operation))
    for(const type of ['pointerdown','keydown','keypress','beforeinput','input','change'])document.addEventListener(type,event=>{
      if(event.target.closest?.('[data-settings-pane="agents"],[data-settings-pane="prompts"]'))window.__settingsResourcesProof.inputEvents.push({type:event.type,key:event.key,inputType:event.inputType,tag:event.target.tagName,value:event.target.value,trusted:event.isTrusted})
    })
    return true
  })()`)
}
async function historyFact(currentClient, probe) {
  const stored=currentClient.agentSession(session.agentSessionId)
  assert.equal(stored.providerId,'codex');assert.equal(stored.executorId,'probe');assert.deepEqual(stored.run,session.run)
  assert.equal(stored.nativeHandle,undefined,'Private cat does not fabricate a native conversation identity')
  let coreError
  try {await currentClient.sessionHistoryPage(session.agentSessionId,{limit:5});assert.fail('cat cannot claim native History')}
  catch(error){assert.equal(error.code,'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE');coreError={code:error.code,message:error.message}}
  const desktop=await probe.cdp.evaluate(`(async()=>{const snapshot=await window.agentmux.sessions.snapshot();const current=snapshot.sessions.find(s=>s.id===${JSON.stringify(session.agentSessionId)});if(!current)throw new Error('Restored Session missing');try{return {page:await window.agentmux.sessions.historyPage(current.control,{limit:5})}}catch(error){return {error:error.message}}})()`)
  assert.equal(typeof desktop.error,'string');assert.ok(desktop.error.includes(coreError.message),'Actual Desktop History reaches the same Core identity boundary')
  return {readiness:'unknown',core:coreError,desktop,nativeHistoryProven:false,providerId:stored.providerId,executorId:stored.executorId,run:stored.run}
}
const nodes = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
const pane = section => `[data-settings-pane="${section}"]:not([hidden])`
async function section(probe, title, id) {
  await activate(probe.cdp, `${nodes('.settings-sidebar nav button')}.filter(e=>e.textContent.trim()===${JSON.stringify(title)})`)
  await waitFor(`actual ${title} pane`, () => probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(pane(id))}))`))
}
async function surface(probe) {
  return probe.cdp.evaluate(`(() => {
    const raw=localStorage.getItem('agentmux-workbench-v1'); if(!raw)throw new Error('Missing durable workbench')
    const state=JSON.parse(raw).state
    const ids=selector=>Array.from(document.querySelectorAll(selector)).filter(e=>e.getClientRects().length).map(e=>e.dataset.workbenchRegionId ?? e.dataset.workbenchTabId).sort()
    const panel=document.querySelector('.workbench-region-split > [data-panel]')
    return {workbench:state.restoredWorkbench,focus:state.agentFocus,draft:state.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}],
      tabs:ids('[data-workbench-tab-id]'),regions:ids('[data-workbench-region-id]'),activeRegions:ids('.workbench-region--active[data-workbench-region-id]'),
      splitPercent:panel?Number(panel.getAttribute('data-panel-size')):null}
  })()`)
}
async function runIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  let stdout
  try { ({stdout}=await exec('ps',['-p',String(pid),'-o','pgid=,lstart='],{timeout:5_000})) }
  catch(error){if(error.code===1)return null;throw error}
  const match=/^\s*(\d+)\s+(.+)$/.exec(stdout.trim()); assert.ok(match)
  return {pid,group:Number(match[1]),born:match[2]}
}
async function terminate(probe) {
  assert.notEqual((await runIdentity(originalRun.pid)).group, probe.child.pid, 'Private Run is outside the killed Electron group')
  probe.cdp.close(); probe.main.close(); process.kill(-probe.child.pid,'SIGKILL')
  await waitFor('exact private Electron exit',()=>probe.child.signalCode!==null || probe.child.exitCode!==null,5_000)
  assert.equal(probe.child.signalCode,'SIGKILL'); children.delete(probe.child)
}

// Resource operations and actual Renderer observations are below.
try {
  await mkdir(evidence,{recursive:true})
  receipt.identityBefore=await identity()
  await writeFile(join(evidence,'identity-before.json'),JSON.stringify(receipt.identityBefore,null,2)+'\n')
  receipt.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repositoryRoot})).stdout.trim()
  await Promise.all([mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(topicsPath,{recursive:true}),mkdir(codexHome,{recursive:true,mode:0o700})])
  const executable=join(workspacePath,'private-cat.sh'), splitFile=join(workspacePath,'split.txt')
  await writeFile(executable,'#!/bin/sh\nprintf "Private settings proof PTY\\n"\nexec /bin/cat\n',{mode:0o700})
  await writeFile(splitFile,'The original file Region stays present.\n')
  Object.assign(process.env,{AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory,AGENTMUX_MESSAGE_QUEUE_PATH:environment.AGENTMUX_MESSAGE_QUEUE_PATH,CODEX_HOME:codexHome})
  store=new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))
  client=await connectLocalAgentMux({store})
  session=await client.createAgent({createOperationId:randomUUID(),executorId:'probe',providerId:'codex',commandOverride:executable,
    workspacePath,env:{CODEX_HOME:codexHome,HOME:privateHome},injectAgentMuxGuide:false,cols:100,rows:30})
  originalRun=(await client.listRuns()).find(run=>run.runId===session.run.runId)
  assert.equal(originalRun?.state,'running'); assert.ok(originalRun.pid); assert.ok(Number.isFinite(originalRun.acceptedInputBytes))
  ownedRunProcess=await runIdentity(originalRun.pid); assert.ok(ownedRunProcess)
  receipt.facts.seedRun={runId:session.run.runId,agentSessionId:session.agentSessionId,executorId:'probe',providerId:'codex',pid:originalRun.pid,birth:ownedRunProcess.born,input:originalRun.acceptedInputBytes}
  originalSession=client.agentSession(session.agentSessionId)
  assert.equal(originalSession.nativeHandle,undefined)
  await client.dispose(); client=null
  const { toolbarOrder }=await preferenceVocabulary(repositoryRoot)
  await writeFile(configPath,JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private settings fixture'}],
    executors:{probe:{label:'Private cat',providerId:'codex',command:executable,args:[],env:{CODEX_HOME:codexHome,HOME:privateHome},injectAgentMuxGuide:false},
      spare:{label:'Spare executor',providerId:'codex',command:'/bin/cat',args:[],env:{},injectAgentMuxGuide:false}},
    composerShortcuts:[{id:'prompt-a',keyword:'proof-a',label:'Private prompt A',body:'  Initial A\n  '},{id:'prompt-b',keyword:'proof-b',label:'Private prompt B',body:'Initial B'}],
    workspaces:[{id:workspaceId,name:'Settings CLI fixture',hostId:'local',path:workspacePath,kind:'folder'},
      {id:'__scratch__',name:'Topics',hostId:'local',path:topicsPath,kind:'folder'}],
    appearance:{terminalTheme:'graphite',appAppearance:'dark',agentAvatars:{spare:{tint:'#654321',badge:'spark'}}},copyPathsAsAbsolute:false,notifications:{mode:'off'},
    browser:{agentAutomation:false,appLinkSchemes:{privatesettings:'deny'},toolbar:Object.fromEntries(toolbarOrder.map(name=>[name,true]))}}))
  const seed={version:1,state:{activeWorkspaceId:workspaceId,mainSurface:'workbench',
    agentFocus:{execution:{sessionId:session.agentSessionId,history:[{sessionId:session.agentSessionId,focusedAt:1}]},pmo:{sessionId:null}},
    agentComposerDrafts:{[session.agentSessionId]:'Unsent private draft'},restoredWorkbench:{
      tabs:{[tabId]:{id:tabId,workspaceId,titleRegionId:agentRegionId,
        layout:{root:{type:'split',direction:'horizontal',ratio:0.7,first:{type:'leaf',regionId:agentRegionId},second:{type:'leaf',regionId:fileRegionId}},activeRegionId:agentRegionId},
        regions:{[agentRegionId]:{regionId:agentRegionId,kind:'agent',phase:'attached',workspaceId,sessionId:session.agentSessionId},
          [fileRegionId]:{regionId:fileRegionId,kind:'file',workspaceId,path:splitFile}}}},
      layouts:{[workspaceId]:{root:{type:'leaf',groupId},groups:[{id:groupId,tabOrder:[tabId],activeTabId:tabId,recentTabIds:[tabId]}],activeGroupId:groupId},
        __scratch__:{root:{type:'leaf',groupId:'settings-cli-scratch'},groups:[{id:'settings-cli-scratch',tabOrder:[],activeTabId:null,recentTabIds:[]}],activeGroupId:'settings-cli-scratch'}}}}}
  phase='seed-private-workbench'
  receipt.checkpoints=[{phase,at:Date.now()}]
  const seeded=await launch('seed',seed)
  assert.deepEqual(seeded.report.workbench.tabIds,[tabId]); assert.equal(seeded.report.workbench.drafts[session.agentSessionId],'Unsent private draft')
  first=await launch('first')
  await waitFor('original nonempty split surface',()=>first.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="${fileRegionId}"]'))`))
  const originalSurface=await surface(first)
  assert.deepEqual(originalSurface.tabs,[tabId]); assert.deepEqual(originalSurface.regions,[agentRegionId,fileRegionId].sort()); assert.equal(originalSurface.splitPercent,70)
  assert.equal(originalSurface.workbench.layouts[workspaceId].activeGroupId,groupId)
  await observe(first)
  client=await connectLocalAgentMux({store})
  originalHistory=await historyFact(client,first)
  receipt.facts.historyBefore=originalHistory
  await client.dispose();client=null
  await activate(first.cdp,nodes('.window-status-bar button[aria-label="Settings"]'))
  resources=resourceProof({probe:first,desktopRoot,resource,configPath,waitFor,section,phase:value=>{phase=value;receipt.checkpoints.push({phase,at:Date.now()})}})
  receipt.facts.resources=await resources.exercise()
  // Exercise stdin at the actual built CLI/Main boundary as well as owned input files.
  phase='actual-cli-stdin'
  const stdinValue={keyword:'stdin-private',label:'Private stdin',body:'  $HOME\n`literal`  '}
  assert.deepEqual((await resource('prompts','add','stdin-private',stdinValue,0,true)).item.value,stdinValue)
  assert.equal((await resource('prompts','remove','stdin-private',{expected:stdinValue},0,true)).removed,true)
  await waitFor('last Prompt stays empty after stdin cycle',async()=>{const current=await resources.state('prompts');return current.cards===0 && current.empty.includes('No prompts') && current.saveText==='Save prompts' && current.saveDisabled===true})
  assert.deepEqual(await first.cdp.evaluate('window.__settingsResourcesProof.controlRequests'),[],'Resource settings never use the Renderer control bridge')
  const inputs=await first.cdp.evaluate('window.__settingsResourcesProof.inputEvents')
  assert.ok(inputs.length>0);assert.ok(inputs.some(event=>event.type==='input' && event.value?.includes('__proto__')),'Actual native Environment editor received own-key JSON')
  assert.ok(inputs.some(event=>event.type==='input' && event.value?.includes('\n')),'Actual native multiline resource editor received literal text')
  assert.ok(inputs.every(event=>event.trusted===true),'No synthetic DOM input event may substitute for private trusted editing')
  assert.deepEqual(inputs.filter(event=>event.tag==='SELECT' && (event.type==='input' || event.type==='change')).map(({type,value})=>({type,value})),[
    {type:'input',value:'codex'},{type:'change',value:'codex'},
    {type:'input',value:''},{type:'change',value:''}
  ],'Prompt Provider binding and unbinding must emit trusted native input and change')
  receipt.facts.trustedInput={method:'native mouse focus/delete, trusted Select typeahead, and Input.insertText literal text',events:inputs}
  await activate(first.cdp,nodes('.window-status-bar button[aria-label="Settings"]'))
  const beforeRestart=await surface(first)
  assert.deepEqual(beforeRestart,originalSurface,'Resource CRUD leaves the original durable and visible surface intact')
  receipt.facts.beforeRestart=beforeRestart
  phase='actual-resource-desktop-restart'
  await terminate(first);second=await launch('second')
  await waitFor('ordinary restart restores exact original split',()=>second.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="${fileRegionId}"]'))`))
  assert.notEqual(first.child.pid,second.child.pid);assert.deepEqual(second.origin,first.origin)
  const restored=await surface(second);assert.deepEqual(restored,beforeRestart,'Exact Tab/group/Region/focus/70% split/draft restoration')
  await observe(second)
  await activate(second.cdp,nodes('.window-status-bar button[aria-label="Settings"]'))
  await resources.verifyRestart(second)
  const snapshot=await second.cdp.evaluate('window.agentmux.sessions.snapshot()')
  const attached=snapshot.sessions.find(value=>value.id===session.agentSessionId)
  assert.equal(attached?.processState,'running');assert.equal(attached.providerId,'codex');assert.equal(attached.executorId,'probe')
  assert.deepEqual(attached.control.run,session.run)
  client=await connectLocalAgentMux({store})
  const current=client.agentSession(session.agentSessionId)
  assert.deepEqual({id:current.agentSessionId,provider:current.providerId,executor:current.executorId,workspace:current.workspacePath,run:current.run,native:current.nativeHandle},
    {id:originalSession.agentSessionId,provider:originalSession.providerId,executor:originalSession.executorId,workspace:originalSession.workspacePath,run:originalSession.run,native:originalSession.nativeHandle})
  receipt.facts.historyAfter=await historyFact(client,second)
  assert.deepEqual(receipt.facts.historyAfter,originalHistory,'History identity unknown remains explicit through CRUD and actual restart')
  const runBeforeContinuity=(await client.listRuns()).find(run=>run.runId===session.run.runId)
  assert.equal(runBeforeContinuity?.state,'running');assert.equal(current.nativeHandle,undefined)
  // With a confirmed healthy Run and no native handle this public call cannot resume/relaunch.
  const template=(await resource('executors','get','probe')).item.value
  const continuity=await client.ensureAgentContinuity({agentSessionId:session.agentSessionId,expectedRun:session.run,operationId:randomUUID(),commandOverride:template.command,args:template.args,env:template.env})
  assert.equal(continuity.kind,'reattachable');assert.deepEqual(continuity.session.run,session.run);assert.equal(continuity.session.providerId,'codex');assert.equal(continuity.run.pid,originalRun.pid)
  receipt.facts.continuity={kind:continuity.kind,providerId:continuity.session.providerId,runId:continuity.run.runId,pid:continuity.run.pid,evidence:continuity.evidence}
  await client.dispose();client=null
  receipt.facts.restart={firstPid:first.child.pid,secondPid:second.child.pid,restored,runId:session.run.runId,resources:resources.facts.restored}
  phase='resource-main-without-view'
  observeWrites=false
  const electronRequire=`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron')`
  await second.main.evaluate(`(() => {const {BrowserWindow}=${electronRequire};for(const window of BrowserWindow.getAllWindows())window.destroy();return true})()`)
  assert.equal(await second.main.evaluate(`${electronRequire}.BrowserWindow.getAllWindows().length`),0)
  assert.deepEqual((await resource('prompts','list')).items,[])
  const noViewPrompt={keyword:'no-view',label:'No View owner',body:'  Private Main owns this\n  '}
  assert.deepEqual((await resource('prompts','add','no-view',noViewPrompt)).item.value,noViewPrompt)
  assert.deepEqual((await resource('prompts','get','no-view')).item.value,noViewPrompt)
  assert.equal((await resource('prompts','remove','no-view',{expected:noViewPrompt})).removed,true)
  assert.deepEqual(JSON.parse(await readFile(configPath,'utf8')).composerShortcuts,[])
  const noViewInspect=await command(['inspect','--tab',tabId],1)
  assert.equal(noViewInspect.error.code,'CONTROL_UNAVAILABLE')
  receipt.facts.noView={windows:0,resourceOwnerAvailable:true,rendererControlError:noViewInspect.error.code}
  await terminate(second)
  phase='resource-offline-owner'
  const offlineBytes=await readFile(configPath)
  const offline=await resource('prompts','add','offline',noViewPrompt,1)
  assert.equal(offline.error.code,'CONTROL_UNAVAILABLE');assert.deepEqual(await readFile(configPath),offlineBytes)
  receipt.facts.offline={code:offline.error.code,configUnchanged:true}
  phase='same-healthy-resource-run'
  client=await connectLocalAgentMux({store})
  const run=(await client.listRuns()).find(value=>value.runId===session.run.runId)
  assert.equal(run?.state,'running');assert.equal(run.pid,originalRun.pid)
  assert.equal(run.acceptedInputBytes,originalRun.acceptedInputBytes,'Resource CRUD and Desktop restart never write Agent input')
  assert.deepEqual(await runIdentity(run.pid),ownedRunProcess)
  assert.equal(client.agentSession(session.agentSessionId).providerId,'codex');assert.equal(client.agentSession(session.agentSessionId).executorId,'probe')
  await client.writeTerminal(session.run,{ownerInstanceId:client.runtimeIdentity().instanceId,operationId:randomUUID(),expectedByte:run.acceptedInputBytes,data:'private-input-after-resources\r'})
  await waitFor('same private Run accepts later explicit input',async()=>(await client.listRuns()).find(value=>value.runId===session.run.runId)?.acceptedInputBytes>run.acceptedInputBytes)
  receipt.facts.run={runId:session.run.runId,pid:run.pid,birth:ownedRunProcess.born,sameProcess:true,inputBefore:originalRun.acceptedInputBytes,inputAfterSettings:run.acceptedInputBytes,settingsWroteNoInput:true,privateInputAccepted:true}
  receipt.identityAfter=await identity();assert.deepEqual(receipt.identityAfter,receipt.identityBefore,'Source, bundles, CLI and proof driver inputs changed during actual execution')
} catch(error) {
  failure=error
  receipt.failureCause=error.cause?{name:error.cause.name,message:error.cause.message,code:error.cause.code}:null
  receipt.failureStack=error.stack
  receipt.mainPauses=Array.from(connections).flatMap(c=>c.pauses??[]).map(p=>({reason:p.reason,hitBreakpoints:p.hitBreakpoints,frames:p.callFrames.map(f=>({functionName:f.functionName,url:f.url,location:f.location}))}))
  try {receipt.privateCrashLog=await readFile(join(userData,'crash-log.ndjson'),'utf8')}catch(cause){receipt.privateCrashLog={error:cause.code??cause.message}}
  receipt.failurePrivateFiles={}
  for(const name of ['ready-seed.json','seed-report.json','ready-first.json','ready-second.json']) {try{receipt.failurePrivateFiles[name]=JSON.parse(await readFile(join(root,name),'utf8'))}catch(cause){receipt.failurePrivateFiles[name]={error:cause.code??cause.message}}}
  const probe=second??first
  if(probe?.cdp) {
    receipt.failureWorkbench=await surface(probe).catch(cause=>({error:cause.message}))
    receipt.failureDocument=await probe.cdp.evaluate(`({href:location.href,title:document.title,text:document.body.innerText,storage:localStorage.getItem('agentmux-workbench-v1')})`).catch(cause=>({error:cause.message}))
    receipt.failureUi=await probe.cdp.evaluate(`Array.from(document.querySelectorAll('[data-settings-pane]:not([hidden])')).map(p=>({pane:p.dataset.settingsPane,text:p.innerText,inputs:Array.from(p.querySelectorAll('input,textarea,select')).map(e=>({tag:e.tagName,type:e.type,value:e.value,disabled:e.disabled}))}))`).catch(cause=>({error:cause.message}))
    try { const screenshot=await probe.cdp.call('Page.captureScreenshot'); await writeFile(join(evidence,'failure.png'),Buffer.from(screenshot.data,'base64')) } catch {}
  }
} finally {
  globalThis.fetch=originalFetch
  receipt.executionElapsedMs=Date.now()-startedAt
  const cleanupErrors=[]
  const attempt=async action=>{try{await action()}catch(error){cleanupErrors.push(error)}}
  await attempt(async()=>{
    if(!receipt.identityAfter)receipt.identityAfter=await identity()
    if(receipt.identityBefore)assert.deepEqual(receipt.identityAfter,receipt.identityBefore,'Proof inputs changed even during a failed attempt')
  })
  for(const connection of connections) connection.close()
  for(const child of children) await attempt(async()=>{
    if(!child.pid || child.exitCode!==null || child.signalCode!==null)return
    try{process.kill(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
    const cleanupDeadline=Date.now()+5_000
    while(child.exitCode===null && child.signalCode===null && Date.now()<cleanupDeadline)await delay(60)
    assert.ok(child.exitCode!==null || child.signalCode!==null,'Exact private Electron must exit during cleanup')
  })
  await attempt(async()=>{
    if(!client && session)client=await connectLocalAgentMux({store:new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))})
    if(client){try{if(session)await client.stopAgent(session.agentSessionId,session.run)}finally{await client.dispose()}}
  })
  await attempt(async()=>{
    if(!ownedRunProcess)return
    const actual=await runIdentity(ownedRunProcess.pid)
    if(!actual || actual.born!==ownedRunProcess.born)return
    assert.equal(actual.group,ownedRunProcess.group)
    try{process.kill(-actual.group,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
  })
  await attempt(async()=>{
    await stopProbeProcesses(process.pid+1_000_000_000,root)
    assert.deepEqual(await listProbeProcesses(process.pid+1_000_000_000,root),[])
    const remaining=ownedRunProcess && await runIdentity(ownedRunProcess.pid)
    assert.ok(!remaining || remaining.born!==ownedRunProcess.born,'Exact private Run must also be reaped')
    receipt.cleanup.privateProcessesReaped=true
    await rm(root,{recursive:true,force:true}); receipt.cleanup.temporaryRootRemoved=true
  })
  if(cleanupErrors.length){failure??=cleanupErrors[0];receipt.cleanup.errors=cleanupErrors.map(error=>error.message)}
  for(const [name,value] of previousEnvironment){if(value===undefined)delete process.env[name];else process.env[name]=value}
}
receipt.totalElapsedMs=Date.now()-startedAt
receipt.passed=!failure
receipt.phase=phase
receipt.failure=failure?{name:failure.name,message:failure.message}:null
await mkdir(evidence,{recursive:true})
const receiptText=JSON.stringify(receipt,null,2)+'\n', receiptDigest=digest(receiptText)
await writeFile(join(evidence,'receipt.json'),receiptText)
await writeFile(join(evidenceRoot,'last-run.json'),JSON.stringify({evidence,passed:receipt.passed,receiptDigest})+'\n')
console.log(JSON.stringify({passed:receipt.passed,phase,evidence,receiptDigest,cleanup:receipt.cleanup}))
if(failure){console.error(failure.stack);process.exitCode=1}
