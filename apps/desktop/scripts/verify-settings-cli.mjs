import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { AgentMuxFileAgentSessionStore, connectLocalAgentMux } from '../../../packages/core/dist/index.js'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { activate, click, desktopFixture } from './fixtures/settings-cli/desktop.mjs'
import { preferenceProof, preferenceVocabulary } from './fixtures/settings-cli/preferences.mjs'
import { fontInput, replaceFontText, verifyFontDraft } from './fixtures/settings-cli/font.mjs'
import { verifyRadioKeyboard } from './fixtures/settings-cli/radio.mjs'
import { browserSettingsProof } from './fixtures/settings-cli/browser.mjs'
import { workspaceSettingsProof } from './fixtures/settings-cli/workspaces.mjs'
import { hostsSettingsProof } from './fixtures/settings-cli/hosts.mjs'
import { crashLogDiagnosticsProof } from './fixtures/settings-cli/diagnostics.mjs'
import { executorRefreshProof } from './fixtures/settings-cli/executor-refresh.mjs'

export async function verifySettingsCli({ browser = false, workspaces = false, hosts = false, diagnostics = false, executorRefresh = false, ownerTiming = false } = {}) {
  // Real bundled Desktop/Main IPC + Core + built CLI. Only initial private fixture materialization
  // writes configuration directly; every setting operation after launch goes through the product owner.
  const repositoryRoot = resolve(import.meta.dirname, '../../..'), desktopRoot = join(repositoryRoot, 'apps/desktop')
  const require = createRequire(join(desktopRoot, 'package.json')), exec = promisify(execFile)
  const digest = value => createHash('sha256').update(value).digest('hex')
  const delay = ms => new Promise(done => setTimeout(done, ms))
  const root = await mkdtemp('/tmp/amx-settings-cli-desktop-')
  const evidenceRoot = join(repositoryRoot, '.tmp/settings-cli')
  const evidence = join(evidenceRoot, `run-${Date.now()}-${randomUUID()}`), userData = join(root, 'user-data')
  const privateHome = join(root, 'home'), codexHome = join(privateHome, 'codex'), runtimeDirectory = join(root, 'runtime')
  const workspacePath = join(root, 'workspace'), topicsPath = join(root, 'topics'), configPath = join(userData, 'agentmux.config.json')
  const cli = join(repositoryRoot, 'packages/core/bin/agentmux')
  const children = new Set(), connections = new Set(), deadline = Date.now() + (hosts ? 240_000 : 150_000)
  const workspaceId = 'settings-cli-workspace', tabId = 'settings-cli-tab', groupId = 'settings-cli-group'
  const agentRegionId = 'settings-cli-agent', fileRegionId = 'settings-cli-file'
  const appearanceKey = 'appearance.appAppearance', copyKey = 'copyPathsAsAbsolute'
  const environment = { HOME: privateHome, CODEX_HOME: codexHome, AGENTMUX_DESKTOP_USER_DATA: userData,
    AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(userData, 'private-messages.ndjson') }
  const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH', 'CODEX_HOME'].map(name => [name, process.env[name]]))
  const receipt = { schema: 'agentmux.settings-cli-desktop-proof.v1', passed: false, cli: [], facts: {}, cleanup: {},
    fixture: { userData, privateHome, runtimeDirectory, workspacePath, topicsPath, syntheticPty: true, ownerTimingInstrumented: ownerTiming } }
  let phase = 'prepare', failure, first, second, session, client, ownedRunProcess, originalRun, obstruction, vocabulary, preferences, browserProof, workspaceProof, hostsProof, diagnosticsProof, refreshProof

  async function waitFor(label, read, budget = 20_000) {
    const end = Math.min(deadline, Date.now() + budget)
    while (Date.now() < end) { const value = await read(); if (value) return value; await delay(60) }
    throw new Error(`Settings CLI timed out: ${label}`)
  }
  const launch = desktopFixture({ desktopRoot, root, privateHome, environment, children, connections, waitFor })
  async function identity() {
    const directories = ['apps/desktop/src', 'packages/core/src', 'packages/demand/src', 'packages/layout/src',
      'apps/desktop/out', 'packages/core/dist', 'packages/demand/dist',
      'apps/desktop/scripts/fixtures/settings-cli']
    const files = ['apps/desktop/scripts/verify-settings-cli.mjs', 'apps/desktop/scripts/verify-settings-browser-cli.mjs', 'apps/desktop/scripts/verify-settings-workspace-add-cli.mjs', 'apps/desktop/scripts/verify-settings-hosts-cli.mjs', 'apps/desktop/scripts/verify-crash-log-diagnostics-cli.mjs', 'apps/desktop/scripts/verify-settings-executor-refresh-cli.mjs', 'apps/desktop/scripts/probe-process.mjs',
      'packages/core/bin/agentmux', 'packages/core/package.json', 'apps/desktop/package.json',
      'packages/core/scripts/build.mjs', 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json']
    const dependencies = {}
    for (const name of ['core', 'demand', 'layout']) {
      const path = await realpath(join(desktopRoot, 'node_modules/@agentmux', name))
      assert.equal(path, join(repositoryRoot, 'packages', name), `Desktop must consume its own ${name} build`)
      dependencies[`dependency/@agentmux/${name}`] = path
    }
    const xterm = await realpath(join(desktopRoot, 'node_modules/@xterm/xterm'))
    const typings = join(xterm, 'typings/xterm.d.ts')
    assert.ok((await readFile(typings, 'utf8')).includes('onUserInput:'), 'Native proof requires the committed user-input patch')
    files.push(typings, join(xterm, 'package.json'), require.resolve('@xterm/xterm'), require.resolve('shlex'))
    dependencies['dependency/@xterm/xterm'] = xterm
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
    return { ...Object.fromEntries(entries), ...dependencies }
  }
  async function command(args, expectedCode = 0, input) {
    const startedAt = Date.now()
    let result
    try {
      const execution = exec(process.execPath, [cli, ...args], { timeout: 10_000,
        env: { ...process.env, ...environment, AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined } })
      if (input !== undefined) execution.child.stdin.end(input)
      result = { code: 0, ...await execution }
    }
    catch (error) { result = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
    const payload = JSON.parse(result.code === 0 ? result.stdout : result.stderr)
    receipt.cli.push({ phase, args, ...(input === undefined ? {} : { input }), code: result.code, receipt: payload,
      startedAt, elapsedMs: Date.now() - startedAt })
    assert.equal(result.code, expectedCode, JSON.stringify(payload))
    assert.equal(payload.ok, expectedCode === 0); assert.equal(typeof payload.requestId, 'string')
    return payload
  }
  async function entries(target) {
    const payload = await command(['settings', 'get', ...(target === undefined ? [] : [target])])
    assert.equal(payload.operation, 'settings.get'); assert.equal(payload.result.partial, true)
    const result = payload.result.entries
    assert.ok(result.length > 0); assert.equal(new Set(result.map(entry => entry.key)).size, result.length)
    if (target === undefined) assert.equal(result.length, 14, 'The complete approved scalar slice must remain present')
    return result
  }
  async function ordinaryEntries(target) {
    return (await entries(target)).filter(entry => entry.key !== 'browser.agentAutomation')
  }
  async function settings() {
    const legacy = (await entries()).filter(entry => entry.key === appearanceKey || entry.key === copyKey)
    assert.deepEqual(legacy.map(entry => entry.key).sort(), [appearanceKey, copyKey].sort())
    return Object.fromEntries(legacy.map(entry => [entry.key, entry.value]))
  }
  async function set(key, value) {
    const payload = await command(['settings', 'set', key, String(value)])
    assert.equal(payload.operation, 'settings.set'); assert.equal(payload.result.entry.key, key)
    const kind = payload.result.entry.kind
    assert.equal(payload.result.entry.value, kind === 'boolean' ? String(value) === 'true' : kind === 'number' ? Number(value) : value)
    return payload
  }
  const nodes = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
  const pane = section => `[data-settings-pane="${section}"]:not([hidden])`
  const paneButtons = (section, text) => `${nodes(`${pane(section)} button`)}.filter(e=>e.textContent.trim()===${JSON.stringify(text)})`
  async function section(probe, title, id) {
    await activate(probe.cdp, `${nodes('.settings-sidebar nav button')}.filter(e=>e.textContent.trim()===${JSON.stringify(title)})`)
    await waitFor(`actual ${title} pane`, () => probe.cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(pane(id))}))`))
  }
  async function chooseAppearance(probe, title) {
    await click(probe.cdp, `${pane('appearance')} .settings-appearance-choice:has(input[aria-label=${JSON.stringify(title)}])`)
    await waitFor(`actual ${title} draft`, async () => (await ui(probe)).appearance === title)
  }
  async function ui(probe) {
    return probe.cdp.evaluate(`(() => {
      const appearance=document.querySelector('[data-settings-pane="appearance"] [aria-label="Application appearance"] input[type="radio"]:checked')
      const copy=document.querySelector('[data-settings-pane="copy-paths"] input[type="checkbox"]')
      const browser=document.querySelector('[data-settings-pane="browser"] input[type="checkbox"]')
      const active=document.querySelector('.settings-content__scroll:not([hidden])')
      return { appearance:appearance?.getAttribute('aria-label'), copy:copy?.checked, browser:browser?.checked,
        font:Number(document.querySelector('[data-settings-pane="appearance"] input[aria-label="Terminal font size in pixels"]')?.value),
        alert:active?.querySelector('[role="alert"]')?.textContent ?? '',
        saveDisabled:active?.querySelector('.settings-pane-actions button')?.disabled,
        status:active?.querySelector('.settings-save-feedback')?.textContent,
        theme:document.documentElement.dataset.appearance,
        events:window.__settingsCliProof?.configEvents ?? [], controlRequests:window.__settingsCliProof?.controlRequests ?? [] }
    })()`)
  }
  async function saved(probe) {
    await waitFor('actual successful save', async () => { const state=await ui(probe); return !state.alert && state.saveDisabled === true && state.status?.includes('Changes saved') })
  }
  async function observe(probe) {
    await probe.cdp.evaluate(`(() => {
      window.__settingsCliProof={configEvents:[],controlRequests:[],keys:[]}
      window.agentmux.config.onChange(config=>window.__settingsCliProof.configEvents.push({app:config.appearance.appAppearance,copy:config.copyPathsAsAbsolute,font:config.appearance.terminalFontSize,automation:config.browser.agentAutomation,schemes:config.browser.appLinkSchemes,notifications:config.notifications,rail:config.projectRailDensity,toolbar:config.browser.toolbar}))
      window.agentmux.control.onRequest(request=>window.__settingsCliProof.controlRequests.push(request.operation))
      document.addEventListener('keydown',event=>window.__settingsCliProof.keys.push({key:event.key,trusted:event.isTrusted}))
      return true
    })()`)
  }
  async function observeMainSettings(probe) {
    const mainPath = join(desktopRoot, 'out/main/index.js')
    const lines = (await readFile(mainPath, 'utf8')).split('\n')
    const found = lines.flatMap((line, index) => line.includes('if (request.operation === "settings.get" || request.operation === "settings.set")') ? [index] : [])
    assert.equal(found.length, 1, 'One actual Main settings dispatch for bounded diagnostics')
    const servers = lines.flatMap(line => [...line.matchAll(/const ([A-Za-z_$][\w$]*) = new AgentMuxControlServer\(/g)].map(match => match[1]))
    assert.equal(servers.length, 1, 'One actual compiled public Control server owner')
    const point = await probe.main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: found[0] })
    const pending = command(['settings', 'get', copyKey])
    pending.catch(() => {}) // Always await the original result after removing the owned breakpoint.
    try {
      const paused = await waitFor('Main diagnostics at real settings dispatch', () => probe.main.pauses.shift())
      assert.ok(paused.hitBreakpoints?.includes(point.breakpointId))
      const result = await probe.main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
        expression: `(() => {
          const facts=globalThis.__settingsOwnerDiagnostics={steps:[]};
          const mark=(step,event)=>facts.steps.push({step,event,at:Date.now()});
          const execute=${servers[0]}.control.execute;
          ${servers[0]}.control.execute=async function(request){
            facts.steps.push({step:'control',event:'enter',at:Date.now(),requestId:request.requestId,operation:request.operation,key:request.key});
            try{const result=await execute.call(this,request);facts.steps.push({step:'control',event:'reply',at:Date.now(),requestId:request.requestId});return result}
            catch(error){facts.steps.push({step:'control',event:'error',at:Date.now(),requestId:request.requestId,code:error.code});throw error}
          };
          const update=configOwner.update;let serial=0;
          configOwner.update=function(apply){const id=++serial;facts.steps.push({step:'owner',event:'queued',id,at:Date.now()});
            return update.call(this,current=>{facts.steps.push({step:'owner',event:'apply',id,at:Date.now()});return apply(current)})
              .then(result=>{facts.steps.push({step:'owner',event:'settled',id,at:Date.now()});return result},error=>{facts.steps.push({step:'owner',event:'error',id,at:Date.now(),code:error.code});throw error})};
          for(const [target,name] of [[args.runtime,'reserveExecutorConfigEdit'],[args.runtime,'prepare'],[args.configStore,'save']]){
            const original=target[name];target[name]=async function(...input){mark(name,'begin');try{const result=await original.apply(this,input);mark(name,'end');return result}catch(error){mark(name,'error');throw error}}
          }
          for(const [target,name] of [[args.runtime,'commit'],[args.configStore,'validate']]){
            const original=target[name];target[name]=function(...input){mark(name,'begin');try{const result=original.apply(this,input);mark(name,'end');return result}catch(error){mark(name,'error');throw error}}
          }
          const original=args.window.webContents.send;
          args.window.webContents.send=function(channel,...input){if(channel===CONFIG_CHANGED_CHANNEL)mark('publication','send');return original.call(this,channel,...input)};
          facts.current=()=>({appearance:configOwner.current.appearance,workspaces:configOwner.current.workspaces});
          return true
        })()`, returnByValue: true })
      assert.equal(result.exceptionDetails, undefined); assert.equal(result.result.value, true)
    } finally {
      await probe.main.call('Debugger.removeBreakpoint', { breakpointId: point.breakpointId })
      await probe.main.call('Debugger.resume')
    }
    await pending
  }
  async function surface(probe) {
    return probe.cdp.evaluate(`(() => {
      const raw=localStorage.getItem('agentmux-workbench-v1'); if(!raw)throw new Error('Missing durable workbench')
      const state=JSON.parse(raw).state
      const ids=selector=>Array.from(document.querySelectorAll(selector)).filter(e=>e.getClientRects().length).map(e=>e.dataset.workbenchRegionId ?? e.dataset.workbenchTabId).sort()
      const panel=document.querySelector('.workbench-region-split > [data-panel]')
      return {activeWorkspaceId:state.activeWorkspaceId,mainSurface:state.mainSurface,
        workbench:state.restoredWorkbench,focus:state.agentFocus,draft:state.agentComposerDrafts[${JSON.stringify(session.agentSessionId)}],
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
  async function restoreObstruction() {
    if (!obstruction) return
    await rmdir(obstruction.path); await rename(obstruction.backup, obstruction.path); obstruction = null
  }

  try {
    await mkdir(evidence,{recursive:true})
    receipt.identityBefore=await identity()
    await writeFile(join(evidence,'identity-before.json'),JSON.stringify(receipt.identityBefore,null,2)+'\n')
    receipt.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repositoryRoot})).stdout.trim()
    vocabulary=await preferenceVocabulary(repositoryRoot)
    await Promise.all([mkdir(userData,{recursive:true}),mkdir(workspacePath,{recursive:true}),mkdir(topicsPath,{recursive:true}),mkdir(codexHome,{recursive:true,mode:0o700})])
    const executable=join(workspacePath,'private-cat.sh'), splitFile=join(workspacePath,'split.txt')
    await writeFile(executable,'#!/bin/sh\nprintf "Private settings proof PTY\\n"\nexec /bin/cat\n',{mode:0o700})
    await writeFile(splitFile,'The original file Region stays present.\n')
    const refreshDirectory = join(root, 'refresh-directory')
    if (executorRefresh) await mkdir(refreshDirectory)
    Object.assign(process.env,{AGENTMUX_RUNTIME_DIRECTORY:runtimeDirectory, AGENTMUX_STATE_DIRECTORY: join(runtimeDirectory, 'state'),AGENTMUX_MESSAGE_QUEUE_PATH:environment.AGENTMUX_MESSAGE_QUEUE_PATH,CODEX_HOME:codexHome})
    const store=new AgentMuxFileAgentSessionStore(join(userData,'agent-sessions.json'))
    client=await connectLocalAgentMux({store})
    session=await client.createAgent({createOperationId:randomUUID(),executorId:'probe',providerId:'codex',commandOverride:executable,
      workspacePath,env:{CODEX_HOME:codexHome,HOME:privateHome},injectAgentMuxGuide:false,cols:100,rows:30})
    originalRun=(await client.listRuns()).find(run=>run.runId===session.run.runId)
    assert.equal(originalRun?.state,'running'); assert.ok(originalRun.pid); assert.ok(Number.isFinite(originalRun.acceptedInputBytes))
    receipt.facts.originalRuntime=client.runtimeIdentity()
    ownedRunProcess=await runIdentity(originalRun.pid); assert.ok(ownedRunProcess)
    await client.dispose(); client=null
    await writeFile(configPath,JSON.stringify({version:9,hosts:[{id:'local',kind:'local',label:'Private settings fixture'}],
      executors:{probe:{label:'Private cat',providerId:'codex',command:executable,args:[],env:{CODEX_HOME:codexHome,HOME:privateHome},injectAgentMuxGuide:false},
        ...(executorRefresh ? {review:{label:'Review executor',providerId:'claude',command:refreshDirectory,args:[],env:{},injectAgentMuxGuide:false}} : {})},
      workspaces:[{id:workspaceId,name:'Settings CLI fixture',hostId:'local',path:workspacePath,kind:'folder'},
        {id:'__scratch__',name:'Topics',hostId:'local',path:topicsPath,kind:'folder'}],
      appearance:{terminalTheme:'graphite',appAppearance:'dark'},copyPathsAsAbsolute:false,notifications:{mode:'off'},
      browser:{agentAutomation:false,appLinkSchemes:browser ? { 'proof-alpha':'deny', 'proof-neighbor':'allow', 'proof-\u0000-key':'deny', '':'deny', '  ':'deny', 'literal:':'deny', '--help':'deny', '--input':'deny', ['__proto__']:'deny', constructor:'allow' } : {privatesettings:'deny'},toolbar:Object.fromEntries(vocabulary.toolbarOrder.map(name=>[name,true]))}}))
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
    const seeded=await launch('seed',seed)
    assert.deepEqual(seeded.report.renderedWorkbench.tabIds,[tabId],'Seed must enter the actual first hydrated App')
    assert.deepEqual(seeded.report.renderedWorkbench.regionIds,[agentRegionId,fileRegionId].sort())
    assert.deepEqual(seeded.report.workbench.tabIds,[tabId]); assert.equal(seeded.report.workbench.drafts[session.agentSessionId],'Unsent private draft')
    first=await launch('first')
    await waitFor('original nonempty split surface',()=>first.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="${fileRegionId}"]'))`))
    const originalSurface=await surface(first)
    assert.deepEqual(originalSurface.tabs,[tabId]); assert.deepEqual(originalSurface.regions,[agentRegionId,fileRegionId].sort()); assert.equal(originalSurface.splitPercent,70)
    assert.equal(originalSurface.workbench.layouts[workspaceId].activeGroupId,groupId)
    await observe(first)
    if (ownerTiming) await observeMainSettings(first)
    preferences=preferenceProof({probe:first,vocabulary,entries:ordinaryEntries,set,command,configPath,waitFor,section,saved,ui,phase:value=>{phase=value}})
    receipt.facts.preferences=preferences.facts
    await preferences.initialize()
    phase='ui-to-cli'
    assert.deepEqual(await settings(),{[appearanceKey]:'dark',[copyKey]:false})
    await activate(first.cdp,nodes('.window-status-bar button[aria-label="Settings"]'))
    await section(first,'Appearance','appearance'); await chooseAppearance(first,'Light')
    await activate(first.cdp,paneButtons('appearance','Save appearance')); await saved(first)
    assert.deepEqual(await settings(),{[appearanceKey]:'light',[copyKey]:false})
    phase='cli-to-current-ui'
    const beforePublish=(await ui(first)).events.length
    await set(appearanceKey,'dark')
    await waitFor('external commit reaches clean current UI',async()=>{const state=await ui(first);return state.appearance==='Dark' && state.theme==='dark' && state.saveDisabled===true})
    assert.equal((await ui(first)).events.length,beforePublish+1,'Exactly one publication for one committed change')
    phase='disjoint-dirty-edit'
    await chooseAppearance(first,'Light'); await set(copyKey,'true')
    await waitFor('disjoint commit reaches current UI',async()=> (await ui(first)).events.at(-1)?.copy===true)
    assert.equal((await ui(first)).appearance,'Light'); assert.equal((await ui(first)).saveDisabled,false)
    await section(first,'Copy Paths','copy-paths')
    assert.equal((await ui(first)).copy,true); assert.equal((await ui(first)).saveDisabled,true)
    await section(first,'Appearance','appearance')
    const fontBefore=(await ui(first)).font; assert.ok(Number.isFinite(fontBefore) && fontBefore>0)
    await replaceFontText(first.cdp,fontInput,String(fontBefore+1))
    await waitFor('real font draft changed',async()=> (await ui(first)).font===fontBefore+1)
    await activate(first.cdp,paneButtons('appearance','Save appearance')); await saved(first)
    assert.deepEqual(await settings(),{[appearanceKey]:'light',[copyKey]:true})
    assert.equal(JSON.parse(await readFile(configPath,'utf8')).appearance.terminalFontSize,fontBefore+1)
    phase='same-field-conflict'
    await chooseAppearance(first,'Dark'); await set(appearanceKey,'system')
    await waitFor('external same-field commit observed',async()=> (await ui(first)).events.at(-1)?.app==='system')
    assert.equal((await ui(first)).appearance,'Dark','Dirty draft is retained before stale save')
    await activate(first.cdp,paneButtons('appearance','Save appearance'))
    await waitFor('named same-field conflict',async()=> (await ui(first)).alert.includes(appearanceKey))
    assert.equal((await ui(first)).appearance,'Dark'); assert.equal((await ui(first)).saveDisabled,false)
    assert.deepEqual(await settings(),{[appearanceKey]:'system',[copyKey]:true})
    receipt.facts.conflict=await ui(first)
    // Explicitly closing the editor discards this draft; no hidden expected-baseline reset is used.
    await activate(first.cdp,nodes('.window-status-bar button[aria-label="Settings"]'))
    await activate(first.cdp,nodes('.window-status-bar button[aria-label="Settings"]'))
    await section(first,'Appearance','appearance')
    assert.equal((await ui(first)).appearance,'System')
    await chooseAppearance(first,'Light'); await activate(first.cdp,paneButtons('appearance','Save appearance')); await saved(first)
    await section(first,'Copy Paths','copy-paths'); await set(copyKey,'false')
    await waitFor('clean copy projection updated',async()=> (await ui(first)).copy===false)
    phase='durable-write-failure'
    await click(first.cdp,`${pane('copy-paths')} input[type="checkbox"]`)
    assert.equal((await ui(first)).copy,true); assert.equal((await ui(first)).saveDisabled,false)
    const bytesBeforeFailure=await readFile(configPath), publicationsBeforeFailure=(await ui(first)).events.length
    const previousPath=`${configPath}.prev`, backup=join(root,'saved-private-previous-config')
    assert.equal((await stat(previousPath)).isFile(),true)
    await rename(previousPath,backup); await mkdir(previousPath); obstruction={path:previousPath,backup}
    try {
      await activate(first.cdp,paneButtons('copy-paths','Save'))
      await waitFor('real persistence failure reaches UI',async()=> (await ui(first)).alert.length>0)
      assert.deepEqual(await readFile(configPath),bytesBeforeFailure,'Failed durable write leaves actual committed bytes unchanged')
      const failed=await ui(first)
      assert.equal(failed.copy,true); assert.equal(failed.saveDisabled,false); assert.equal(failed.events.length,publicationsBeforeFailure)
      assert.deepEqual(await settings(),{[appearanceKey]:'light',[copyKey]:false})
      receipt.facts.failedSave={ui:failed,configDigest:digest(bytesBeforeFailure)}
    } finally { await restoreObstruction() }
    await activate(first.cdp,paneButtons('copy-paths','Save')); await saved(first)
    assert.deepEqual(await settings(),{[appearanceKey]:'light',[copyKey]:true})
    phase='invalid-and-nochange'
    const invalidBaseline=await readFile(configPath), eventsBeforeInvalid=(await ui(first)).events.length
    for(const [key,value,code] of [[appearanceKey,'invalid-private-value','INVALID_SETTING_VALUE'],['unsupported-private-key','true','UNSUPPORTED_SETTING']]) {
      const invalid=await command(['settings','set',key,value],1); assert.equal(invalid.error.code,code)
      assert.deepEqual(await readFile(configPath),invalidBaseline)
    }
    await set(appearanceKey,'light')
    assert.equal((await ui(first)).events.length,eventsBeforeInvalid,'Invalid and unchanged writes must not publish')
    assert.deepEqual(await settings(),{[appearanceKey]:'light',[copyKey]:true})
    await preferences.exercise()
    phase='native-font-draft'
    receipt.facts.fontDraft={}
    await verifyFontDraft({probe:first,entries,command,section,saved,waitFor,configPath,facts:receipt.facts.fontDraft})
    phase='native-radio-keyboard'
    receipt.facts.radioKeyboard=await verifyRadioKeyboard({probe:first,section,command,saved,waitFor,evidence})
    const finalPreferences=Object.fromEntries((await ordinaryEntries()).map(entry=>[entry.key,entry.value]))
    assert.deepEqual(finalPreferences,{...preferences.facts.restartValues,'appearance.terminalFontSize':14},'Font editing preserves every unrelated ordinary setting')
    preferences.facts.restartValues=finalPreferences
    if (browser) {
      browserProof=browserSettingsProof({probe:first,desktopRoot,root,command,configPath,waitFor,section,saved,phase:value=>{phase=value}})
      receipt.facts.browser=browserProof.facts
      await browserProof.exercise()
    }
    if (workspaces) {
      workspaceProof=workspaceSettingsProof({probe:first,desktopRoot,root,command,configPath,waitFor,section,surface,originalSurface,workspaceId,
        sessionId:session.agentSessionId,phase:value=>{phase=value}})
      receipt.facts.workspaces=workspaceProof.facts
      await workspaceProof.exercise()
    }
    if (hosts) {
      hostsProof=hostsSettingsProof({probe:first,desktopRoot,root,command,configPath,waitFor,section,evidence,phase:value=>{phase=value}})
      receipt.facts.hosts=hostsProof.facts
      await hostsProof.exercise()
    }
    if (diagnostics) {
      diagnosticsProof=crashLogDiagnosticsProof({probe:first,desktopRoot,userData,command,configPath,section,waitFor,phase:value=>{phase=value}})
      receipt.facts.diagnostics=diagnosticsProof.facts
      await diagnosticsProof.exercise()
    }
    if (executorRefresh) {
      refreshProof=executorRefreshProof({probe:first,desktopRoot,command,configPath,waitFor,section,evidence,phase:value=>{phase=value}})
      receipt.facts.executorRefresh=refreshProof.facts
      await refreshProof.exercise()
    }
    assert.deepEqual((await ui(first)).controlRequests,[],'Settings never use the Renderer Control bridge')
    const trustedKeys=await first.cdp.evaluate('window.__settingsCliProof.keys')
    assert.ok(trustedKeys.length>0); assert.ok(trustedKeys.every(event=>event.trusted===true))
    receipt.facts.trustedKeys=trustedKeys
    await activate(first.cdp,nodes('.window-status-bar button[aria-label="Settings"]'))
    const beforeRestart=await surface(first)
    if (workspaceProof) assert.deepEqual(beforeRestart,workspaceProof.facts.expectedSurface,'Only the explicitly selected project layouts are added to the original exact surface')
    else assert.deepEqual(beforeRestart,originalSurface,'Settings operations preserve the exact original durable and visible surface')
    receipt.facts.beforeRestart=beforeRestart
    phase='actual-desktop-restart'
    await terminate(first); second=await launch('second')
    await waitFor('restored same split',()=>second.cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agentRegionId}"] .composer [role="textbox"]') && document.querySelector('[data-workbench-region-id="${fileRegionId}"]'))`))
    assert.notEqual(first.child.pid,second.child.pid); assert.deepEqual(second.origin,first.origin)
    const restored=await surface(second); assert.deepEqual(restored,beforeRestart,'Exact Tab/group/Region/focus/split/draft restoration')
    assert.deepEqual(await settings(),{[appearanceKey]:'light',[copyKey]:true})
    await activate(second.cdp,nodes('.window-status-bar button[aria-label="Settings"]'))
    await section(second,'Appearance','appearance'); assert.equal((await ui(second)).appearance,'Light')
    await section(second,'Copy Paths','copy-paths'); assert.equal((await ui(second)).copy,true)
    await preferences.verifyRestart(second,browserProof ? {
      automation:browserProof.facts.final.agentAutomation,schemes:browserProof.facts.final.appLinkSchemes
    } : undefined)
    if (browserProof) await browserProof.verifyRestart(second)
    if (workspaceProof) await workspaceProof.verifyRestart(second)
    if (hostsProof) await hostsProof.verifyRestart(second)
    if (diagnosticsProof) await diagnosticsProof.verifyRestart(second)
    if (refreshProof) await refreshProof.verifyRestart(second)
    const snapshot=await second.cdp.evaluate('window.agentmux.sessions.snapshot()')
    const attached=snapshot.sessions.find(value=>value.id===session.agentSessionId)
    assert.equal(attached?.processState,'running'); assert.equal(attached.control.run.runId,session.run.runId)
    receipt.facts.restart={firstPid:first.child.pid,secondPid:second.child.pid,restored,values:await settings(),runId:session.run.runId}
    phase='main-owner-without-view'
    const electronRequire=`process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktopRoot,'package.json'))})('electron')`
    await second.main.evaluate(`(() => { const {BrowserWindow}=${electronRequire}; for(const window of BrowserWindow.getAllWindows())window.destroy(); return true })()`)
    assert.equal(await second.main.evaluate(`${electronRequire}.BrowserWindow.getAllWindows().length`),0)
    assert.deepEqual(await settings(),{[appearanceKey]:'light',[copyKey]:true})
    await set(appearanceKey,'dark'); await set(copyKey,'false')
    assert.deepEqual(await settings(),{[appearanceKey]:'dark',[copyKey]:false})
    const noViewConfig=JSON.parse(await readFile(configPath,'utf8'))
    assert.equal(noViewConfig.appearance.appAppearance,'dark'); assert.equal(noViewConfig.copyPathsAsAbsolute,false)
    const noViewInspect=await command(['inspect','--tab',tabId],1)
    assert.equal(noViewInspect.error.code,'CONTROL_UNAVAILABLE','The unavailable Renderer path must remain unavailable')
    receipt.facts.noView={windows:0,settings:await settings(),rendererControlError:noViewInspect.error.code}
    if (browserProof) await browserProof.verifyNoView()
    if (workspaceProof) await workspaceProof.verifyNoView()
    if (hostsProof) await hostsProof.verifyNoView()
    if (diagnosticsProof) await diagnosticsProof.verifyNoView(second)
    if (refreshProof) await refreshProof.verifyNoView()
    await terminate(second)
    phase='offline-owner'
    const offlineBytes=await readFile(configPath)
    const offline=await command(['settings','set',appearanceKey,'light'],1)
    assert.equal(offline.error.code,'CONTROL_UNAVAILABLE')
    assert.deepEqual(await readFile(configPath),offlineBytes,'Offline CLI never substitutes a local write')
    receipt.facts.offline={code:offline.error.code,configUnchanged:true}
    if (browserProof) await browserProof.verifyOffline()
    if (workspaceProof) await workspaceProof.verifyOffline()
    if (hostsProof) await hostsProof.verifyOffline()
    if (diagnosticsProof) await diagnosticsProof.verifyOffline()
    if (refreshProof) await refreshProof.verifyOffline()
    phase='same-healthy-run'
    client=await connectLocalAgentMux({store})
    const run=(await client.listRuns()).find(value=>value.runId===session.run.runId)
    assert.equal(run?.state,'running'); assert.equal(run.pid,originalRun.pid)
    assert.equal(run.acceptedInputBytes,originalRun.acceptedInputBytes,'Settings and restarting Desktop never write Agent input')
    assert.deepEqual(await runIdentity(run.pid),ownedRunProcess)
    receipt.facts.runtimeAfter=client.runtimeIdentity()
    assert.deepEqual(receipt.facts.runtimeAfter,receipt.facts.originalRuntime,'Settings diagnostics and Desktop restart preserve the exact Runtime identity')
    await client.writeTerminal(session.run,{ownerInstanceId:client.runtimeIdentity().instanceId,operationId:randomUUID(),expectedByte:run.acceptedInputBytes,data:'private-input-after-settings\r'})
    await waitFor('same Run accepts explicit input',async()=> (await client.listRuns()).find(value=>value.runId===session.run.runId)?.acceptedInputBytes>run.acceptedInputBytes)
    receipt.facts.run={runId:session.run.runId,pid:run.pid,birth:ownedRunProcess.born,sameProcess:true,settingsWroteNoInput:true,privateInputAccepted:true}
    receipt.identityAfter=await identity(); assert.deepEqual(receipt.identityAfter,receipt.identityBefore,'Actual source, bundles and CLI input changed during proof')
  } catch(error) {
    failure=error
    const probe=second??first
    if(probe?.cdp) {
      receipt.failureUi=await ui(probe).catch(cause=>({error:cause.message}))
      if(preferences)receipt.failurePreferences=await preferences.capture(probe).catch(cause=>({error:cause.message}))
      try { const screenshot=await probe.cdp.call('Page.captureScreenshot'); await writeFile(join(evidence,'failure.png'),Buffer.from(screenshot.data,'base64')) } catch {}
    }
    if (ownerTiming && first?.main) {
      receipt.failureMainDiagnostics=await first.main.evaluate(`(() => {const facts=globalThis.__settingsOwnerDiagnostics;return facts?{steps:facts.steps,current:facts.current()}:null})()`)
        .catch(cause=>({error:cause.message}))
      receipt.failureCommittedConfig=JSON.parse(await readFile(configPath,'utf8').catch(()=>'null'))
    }
  } finally {
    const cleanupErrors=[]
    const attempt=async action=>{try{await action()}catch(error){cleanupErrors.push(error)}}
    await attempt(async()=>{
      if(!receipt.identityAfter)receipt.identityAfter=await identity()
      if(receipt.identityBefore)assert.deepEqual(receipt.identityAfter,receipt.identityBefore,'Proof inputs changed even during a failed attempt')
    })
    if (diagnosticsProof) await attempt(()=>diagnosticsProof.cleanup())
    await attempt(restoreObstruction)
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
  receipt.passed=!failure
  receipt.phase=phase
  receipt.failure=failure?{name:failure.name,message:failure.message}:null
  await mkdir(evidence,{recursive:true})
  const receiptText=JSON.stringify(receipt,null,2)+'\n', receiptDigest=digest(receiptText)
  await writeFile(join(evidence,'receipt.json'),receiptText)
  await writeFile(join(evidenceRoot,'last-run.json'),JSON.stringify({evidence,passed:receipt.passed,receiptDigest})+'\n')
  console.log(JSON.stringify({passed:receipt.passed,phase,evidence,receiptDigest,cleanup:receipt.cleanup}))
  if(failure){console.error(failure.stack);process.exitCode=1}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifySettingsCli()
