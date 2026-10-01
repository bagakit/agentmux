const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')
// Closing the owned window is ordinary; final owner disposal completes before app.quit().
app.on('window-all-closed', () => {})
const [html, ownerBundle, privateRoot, evidence, phase, asset, cli, qualifiedScene] = process.argv.slice(2)
for (const key of ['home', 'userData', 'sessionData']) { const value = path.join(privateRoot, key); fs.mkdirSync(value, { recursive: true }); app.setPath(key, value) }
const preparationScope = process.env.AGENTMUX_TOOLKIT_UI_PREPARATION_SCOPE ?? 'full'
assert.ok(['full', 'layout', 'models', 'actions', 'qualification'].includes(preparationScope), 'Known bounded preparation scope')
const qualification = preparationScope === 'qualification', stage = process.env.AGENTMUX_TOOLKIT_UI_GUI_STAGE ?? 'control'
const raw = { phase, preparationScope, frames: [], actions: [], windowEvents: [], errors: [], qualified: false,
  boundary: 'T008 preparation: actual App/CSS/Monaco/product preload and registered Toolkit IPC; real private ConfigOwner/CLI/Core Raw tools. Scope facts only; preview Session transport controlled, no healthy Run/GUI restart or complete Task qualification.' }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win, toolkit, runtime, sampler, metrics, server, detachRuntime, detachIpc
raw.runPortStops = []
app.whenReady().then(async () => {
  try {
    assert.equal(phase, 'toolkit')
    const { ConfigOwner, ConfigStore, ToolkitOwner, registerToolkitIpc, RuntimeController, ProcessResourceSampler, createResourceMetricsPort, AgentMuxMemoryAgentSessionStore, AgentMuxControlServer, sessionSnapshotPayload } = await import(pathToFileURL(ownerBundle).href)
    const store = new ConfigStore(path.join(app.getPath('userData'), 'config.json'))
    let current = await store.get(), seeded = false
    const work = path.join(privateRoot, 'work'); fs.mkdirSync(work, { recursive: true })
    const saveHold = { next: false, entered: false, release: null }
    const owner = new ConfigOwner({ read: () => current, prepare: (before, next) => toolkit.prepareConfig(before, next),
      save: async next => { if(saveHold.next) {saveHold.next=false;saveHold.entered=true;await new Promise(resolve=>{saveHold.release=resolve})}return store.save(next) },
      publish: next => { current = next; toolkit.configurationChanged(); if(win&&!win.isDestroyed())win.webContents.send('proof:toolkit:config:changed', next) } })
    sampler = new ProcessResourceSampler()
    runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), undefined, sampler)
    win = new BrowserWindow({ width: 1480, height: 900, show: false, webPreferences: { preload: process.env.AGENTMUX_PERFORMANCE_PRODUCT_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true } })
    if (qualification) win.setAlwaysOnTop(true, 'floating')
    for (const event of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur', 'ready-to-show']) win.on(event, () => raw.windowEvents.push({ event, at: Date.now(), visible: win.isVisible(), minimized: win.isMinimized() }))
    toolkit = new ToolkitOwner({ config: owner, receiptPath: path.join(app.getPath('userData'), 'toolkit-receipts.json'),
      openRunPort: async () => {
        const port = await runtime.toolkitRunPort()
        return { ...port, stop: async ref => {
          assert.ok(raw.runPortStops.length < 128, 'The private stop observation stays bounded')
          const fact = { method: 'stop', runId: ref.runId, at: Date.now(), accepted: null }
          raw.runPortStops.push(fact)
          try { const value = await port.stop(ref); fact.accepted = true; fact.returnedAt = Date.now(); return value }
          catch (error) { fact.accepted = false; fact.returnedAt = Date.now(); fact.error = String(error); fact.code = error.code; throw error }
        } }
      }, enabled: () => current.toolkit?.performance?.enabled !== false,
      launch: () => ({ runner: process.execPath, cli, script: asset, cwd: work, env: { ELECTRON_RUN_AS_NODE: '1' } }) })
    detachIpc = registerToolkitIpc(toolkit, (channel, handler) => ipcMain.handle(channel, handler))
    detachRuntime = runtime.attach(win.webContents)
    sampler.setObservationSources({ observeRuntime: () => runtime.resourceUsageObservation(),
      processOwners: () => ({ rendererPids: [win.webContents.getOSProcessId()].filter(pid => pid > 0), browserPids: [] }),
      mainOwners: () => ({ ...runtime.resourceOwnerCounts(), fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }) })
    metrics = createResourceMetricsPort({ sampler, currentWindow: () => win.isDestroyed() ? null : { windowId: win.id, webContentsId: win.webContents.id, generation: runtime.rendererGeneration(win.webContents) } })
    server = new AgentMuxControlServer({ execute: async () => { throw Error('This preparation accepts only the registered Toolkit port.') }, metrics, toolkit })
    raw.sessionCalls = { attachments: [], writes: [] }
    if(qualification) {
      // Product preload and the actual RuntimeController own every Session/Run operation.
      ipcMain.handle('sessions:snapshot',async()=>sessionSnapshotPayload(await runtime.snapshot(owner.current),undefined,app.getPath('home')))
      ipcMain.handle('sessions:attach',async(event,control,afterByte=0)=>{const result=await runtime.attachSession(event.sender.id,control,afterByte,owner.current);raw.sessionCalls.attachments.push({control,attachmentId:result.attachmentId,session:result.session,at:Date.now()});return result})
      ipcMain.handle('sessions:refreshAttachment',(event,control,attachmentId,afterByte)=>runtime.refreshSessionAttachment(event.sender.id,control,attachmentId,afterByte,owner.current))
      ipcMain.handle('sessions:replay',(event,attachmentId,afterByte)=>runtime.readSessionReplay(event.sender.id,attachmentId,afterByte))
      ipcMain.handle('sessions:refresh',(_event,control)=>runtime.refresh(control,owner.current))
      ipcMain.handle('sessions:detach',(event,attachmentId)=>runtime.detachSession(event.sender.id,attachmentId))
      ipcMain.handle('sessions:resize',(event,attachmentId,cols,rows)=>runtime.resizeSessionAttachment(event.sender.id,attachmentId,cols,rows))
      ipcMain.handle('sessions:write',async(_event,control,data,source)=>{await runtime.write(control,data,source);raw.sessionCalls.writes.push({control,data,source,at:Date.now()})})
    }
    ipcMain.handle('proof:toolkit:seed', async (_event, preview) => {
      assert.equal(seeded, false, 'Single first-hydrate input')
      if(!qualification||stage==='control') await owner.update(() => ({ ...preview, appearance: { ...preview.appearance, appAppearance: 'dark' },
        workspaces: [{ id: 'toolkit-work', hostId: 'local', name: 'Toolkit private work', path: work, kind: 'folder' }, ...current.workspaces.filter(item => item.id !== 'toolkit-work')],
        toolkit: { performance: { enabled: true, statusBar: 'icon' }, tools: [] } }))
      runtime.commit(await runtime.prepare({ ...owner.current, hosts: owner.current.hosts.filter(host => host.kind === 'local') }))
      await server.start()
      const definitions = [
        ['summary', 'Workspace summary', 'terminal', 'label', "console.log('Workspace summary\\n\\nEverything is ready for your next step.\\nLast check: local script completed.');"],
        ['identity', 'Identity check', 'key-round', 'icon', "console.log('Local identity check completed.');"]
      ]
      if(!qualification||stage==='control') for (const [id, name, icon, statusBar, script] of definitions) await toolkit.execute({ operation: 'toolkit.add', toolId: id, value: { name, icon, enabled: true, statusBar, workspacePath: work, script, args: [], actions: id === 'summary' ? [{id:'refresh',label:'Refresh identity',script:"console.log('Identity refreshed\\nAction completed from the captured result.');",args:['captured argument']}] : [] } }, new AbortController().signal)
      seeded = true; return { seeded, work, qualification, stage, healthy:qualification?JSON.parse(fs.readFileSync(path.join(privateRoot,'healthy-run.json'),'utf8')):null }
    })
    ipcMain.handle('proof:toolkit:config:get', () => owner.current)
    ipcMain.handle('proof:toolkit:config:save', (_event, next, expected) => owner.edit(expected, next))
    ipcMain.handle('proof:toolkit:flush', () => win.webContents.session.flushStorageData())
    ipcMain.handle('proof:toolkit:hold-save',()=>{assert.equal(saveHold.release,null);saveHold.next=true;saveHold.entered=false})
    ipcMain.handle('proof:toolkit:save-held',()=>saveHold.entered)
    ipcMain.handle('proof:toolkit:release-save',()=>{assert.ok(saveHold.release);const release=saveHold.release;saveHold.release=null;release()})
    ipcMain.handle('proof:toolkit:facts', async () => {
      const tools = owner.current.toolkit.tools
      const values = await Promise.all(tools.map(tool => toolkit.execute({ operation: 'toolkit.get', toolId: tool.id }, new AbortController().signal)))
      return { tools, snapshots: values.map(value => value.snapshot) }
    })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) raw.errors.push({ level, message }) })
    await win.loadFile(html); win.showInactive()
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => { const deadline = Date.now() + 8000; while (!await read(expression)) { assert.ok(Date.now() < deadline, 'Real scene checkpoint: ' + expression); await pause(20) } }
    const click = async selector => {
      const request={type:'trusted-click',selector,at:Date.now()};raw.actions.push(request)
      const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n?.isConnected||!n.checkVisibility())throw Error('Missing visible control');n.scrollIntoView({block:'nearest',inline:'nearest'});const b=n.getBoundingClientRect();if(b.width<=0||b.height<=0)throw Error('Empty control');const x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);if(x<0||y<0||x>=innerWidth||y>=innerHeight)throw Error('Control is outside the actual native viewport');return{x,y}})()`)
      request.point=point
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(80)
    }
    const scene = () => read(`(()=>({hidden:document.hidden,visibilityState:document.visibilityState,theme:document.documentElement.style.colorScheme,view:document.querySelector('.toolkit-workbench')?.getAttribute('data-view'),title:document.querySelector('.settings-content__header h2')?.textContent,editor:document.querySelector('[data-tool-editor]')?.getAttribute('data-tool-editor'),libraryVisible:document.querySelector('.toolkit-library')?.checkVisibility({visibilityProperty:true}),libraryItems:document.querySelectorAll('.toolkit-library [data-tool-id]').length,settingsExpanded:document.querySelector('.surface-navigation [aria-label="Settings"]')?.getAttribute('aria-expanded'),directories:Array.from(document.querySelectorAll('.toolkit-library__directory')).filter(n=>n.checkVisibility({visibilityProperty:true})).map(n=>{const code=n.closest('code'),rect=n.getBoundingClientRect(),bounds=code.getBoundingClientRect();return{text:n.textContent,title:code.title,right:rect.right,width:rect.width,codeRight:bounds.right}})}))()`)
    const frame = async (file, expectedScene) => {
      await read('document.fonts.ready')
      const paint = { file, startedAt: Date.now(), completed: false }
      ;(raw.paintCheckpoints ??= []).push(paint)
      try {
        await Promise.race([read(`(async()=>{const status=()=>({hidden:document.hidden,visibilityState:document.visibilityState,at:Date.now(),animations:Array.from(document.getAnimations()).filter(a=>Number.isFinite(a.effect?.getTiming().iterations)).map(a=>({playState:a.playState,currentTime:a.currentTime,endTime:a.effect?.getComputedTiming().endTime,target:a.effect?.target?.className??null}))});const fact=window.toolkitPaint={stage:'animations',before:status()};await Promise.all(Array.from(document.getAnimations()).filter(a=>Number.isFinite(a.effect?.getTiming().iterations)).map(a=>a.finished.catch(()=>{})));fact.stage='frame-1';fact.afterAnimations=status();await new Promise(resolve=>requestAnimationFrame(resolve));fact.stage='frame-2';fact.afterFirstFrame=status();await new Promise(resolve=>requestAnimationFrame(resolve));fact.stage='complete';fact.after=status()})()`),pause(8000).then(()=>{throw Error('Actual finite transitions and Renderer paint did not settle')})])
        paint.completed = true
      } catch (error) {
        paint.failure = { name: error.name, message: error.message }; throw error
      } finally {
        paint.returnedAt = Date.now(); paint.native = { visible: win.isVisible(), minimized: win.isMinimized() }
        try { paint.renderer = await read('({checkpoint:window.toolkitPaint,hidden:document.hidden,visibilityState:document.visibilityState,at:Date.now()})') }
        catch (cause) { paint.observationError = String(cause) }
      }
      const before = await scene()
      if(qualification) {
        assert.ok(expectedScene&&Object.keys(expectedScene).length>0,'A full qualification image has an explicit actual scene')
        for(const [key,value] of Object.entries(expectedScene))assert.deepEqual(before[key],value,'Actual full App image scene: '+key)
      } else assert.equal(before.theme,file.includes('-light-')?'light':'dark','Actual theme for this complete App image')
      if (!qualification && !file.includes('-result.') && !file.includes('-not-run.')) {
        assert.equal(before.view,file.includes('-library.')?'library':'editor','Actual tool view for this complete App image')
        assert.equal(before.settingsExpanded,'true','Actual Settings entry remains expanded')
        if (file.includes('-library.')) assert.equal(before.libraryVisible,true,'Actual library is visible')
        else assert.equal(before.editor,'summary','Actual saved editor target')
      }
      if(before.libraryVisible) {
        if(!qualification||expectedScene.libraryItems!==1)assert.ok(before.directories.length>0,'Nonempty actual fixed-directory presentation')
        else assert.equal(before.libraryItems,1,'The empty library keeps its nonempty official built-in card')
        for(const directory of before.directories) {
          assert.equal(directory.text,directory.title.replace(/\/$/u,'').split('/').pop(),'Visible leaf matches the full captured directory title')
          assert.ok(directory.width>0&&directory.right<=directory.codeRight+0.5,'Directory leaf is within its real cropped metadata row')
        }
      }
      const image = await win.webContents.capturePage(),bytes = image.toPNG()
      const after = await scene()
      assert.deepEqual(after,before,'Same real Renderer scene around the compositor capture')
      fs.writeFileSync(path.join(evidence, file), bytes)
      raw.frames.push({ file, before, after, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bounds: win.getContentBounds() })
    }
    await until('window.toolkitScene?.ready===true')
    if (qualification) {
      raw.windowCondition = { kind: 'owned-floating-showInactive', at: Date.now(), windowId: win.id, pid: process.pid, alwaysOnTop: win.isAlwaysOnTop(), visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(), backgroundThrottling: win.webContents.getBackgroundThrottling(), page: await read('({hidden:document.hidden,visibilityState:document.visibilityState,at:Date.now()})') }
      assert.equal(raw.windowCondition.alwaysOnTop, true); assert.equal(raw.windowCondition.visible, true); assert.equal(raw.windowCondition.minimized, false)
      assert.equal(raw.windowCondition.backgroundThrottling, true); assert.equal(raw.windowCondition.page.hidden, false); assert.equal(raw.windowCondition.page.visibilityState, 'visible', 'The owned floating window provides an actual visible interaction control')
      raw.boundary = 'T008: owned private floating BrowserWindow with showInactive; actual visible page, no app/window activation or user App/Run/Runtime operation. Actual App/registered Toolkit owners, private Core and ordinary GUI restart. This controlled condition is not user foreground/FPS or T004 hidden qualification.'
    }
    raw.before = await read('window.toolkitScene.surface()')
    if(qualification) {
      assert.equal(typeof qualifiedScene, 'string', 'The capture supplies its bound qualification scene')
      await require(qualifiedScene)({win,raw,owner,store,toolkit,read,until,click,frame,pause,work,privateRoot,evidence,cli,stage,saveHold})
    } else {
    if (preparationScope === 'actions') {
      await click('.surface-navigation [aria-label="Settings"]'); await click('[data-settings-target="toolkit"]')
      await until('document.querySelector(".toolkit-library")?.checkVisibility()'); await frame('1480-dark-library.png')
      await click('[data-tool-id="summary"]'); await until('document.querySelector(".toolkit-editor .monaco-editor")?.checkVisibility()')
      await click('.toolkit-editor__result-actions > summary'); await click('[data-toolkit-edit-action="refresh"]')
      await until('window.toolkitScene.models().then(models=>models.length===1&&models[0].path==="/summary/actions/refresh.mjs")')
      await frame('1480-dark-action-editor.png')
      win.setContentSize(320,800); await frame('320-dark-action-editor.png')
      await read('window.toolkitScene.theme("light")'); await frame('320-light-action-editor.png')
      await click('.surface-navigation [aria-label="Settings"]')
      win.setContentSize(1480,900)
      await until('document.querySelector("button[data-toolkit-id=summary]")?.checkVisibility()')
      await click('[data-toolkit-id="summary"]'); await until('document.querySelector(".toolkit-result__empty")?.checkVisibility()')
      assert.equal(await read('document.querySelectorAll("[data-toolkit-action]").length'),0,'No actions without a confirmed result')
      await click('.toolkit-result__actions button:first-child')
      await until('document.querySelector(".performance-status")?.textContent.includes("Finished")&&document.querySelector("[data-toolkit-output]")?.textContent.includes("Everything is ready")')
      const beforeAction=await read('window.toolkitScene.facts()')
      raw.actionBefore=beforeAction
      const source=beforeAction.snapshots.find(snapshot=>snapshot.toolId==='summary').latestConfirmed
      assert.ok(source?.executionId,'Nonempty actual Core Raw result for the action')
      assert.equal(source.action??null,null,'Main script positive control')
      await frame('1480-light-confirmed-result.png')
      await click('[data-toolkit-action="refresh"]')
      await until('document.querySelector(".performance-status")?.textContent.includes("Finished")&&document.querySelector("[data-toolkit-output]")?.textContent.includes("Identity refreshed")')
      const afterAction=await read('window.toolkitScene.facts()')
      raw.actionAfter=afterAction
      const result=afterAction.snapshots.find(snapshot=>snapshot.toolId==='summary').latestConfirmed
      assert.equal(result.action.id,'refresh','Actual registered Main action identity')
      assert.equal(result.action.sourceExecutionId,source.executionId,'Actual captured source result')
      assert.equal(result.action.expectedAdmissionExecutionId,null,'Actual captured idle admission')
      assert.equal(result.definition.revision,source.definition.revision,'Same captured saved configuration')
      assert.equal(result.target.workspacePath,source.target.workspacePath,'Same captured fixed directory')
      assert.notEqual(result.executionId,source.executionId,'Action has its own real execution')
      assert.ok(result.run?.runId,'Action uses the actual Core Raw Run')
      raw.actionResult={source,result}
      await frame('1480-light-action-result.png')
      await click('.toolkit-result__actions button:nth-last-child(2)')
      await until('document.querySelector(".toolkit-result__script")?.checkVisibility()')
      assert.equal(await read('document.querySelector(".toolkit-result__script").value'),source.definition.actions[0].script,'UI reads the actual captured action source')
      await frame('1480-light-action-script-result.png')
      await click('.toolkit-result .small-button:first-child')
      await read('window.toolkitScene.theme("dark")'); win.setContentSize(320,800)
      await until('document.querySelector("[data-toolkit-output]")?.textContent.includes("Identity refreshed")')
      await frame('320-dark-action-result.png')
      await click('[data-toolkit-close]')
      win.setContentSize(1480,900)
    }
    if (preparationScope !== 'models' && preparationScope !== 'actions') {
    await click('.surface-navigation [aria-label="Settings"]'); await click('[data-settings-target="toolkit"]')
    await until('document.querySelector(".toolkit-library")?.checkVisibility()')
    await frame('1480-dark-library.png')
    await click('[data-tool-id="summary"]')
    await until('document.querySelector(".toolkit-editor .monaco-editor")?.checkVisibility()')
    await frame('1480-dark-editor.png')
    await read('window.toolkitScene.theme("light")'); await frame('1480-light-editor.png')
    if (preparationScope === 'full') {
      await click('.surface-navigation [aria-label="Settings"]')
      await click('[data-toolkit-id="summary"]'); await until('document.querySelector(".toolkit-result__empty")?.checkVisibility()')
      await frame('1480-light-not-run.png')
      const resultRun = '.toolkit-result__actions button:first-child'
      await click(resultRun); await until('document.querySelector(".performance-status")?.textContent.includes("Finished")')
      assert.ok((await read('document.querySelector("[data-toolkit-output]")?.textContent')).includes('Everything is ready'), 'Actual private script output')
      await frame('1480-light-confirmed-result.png')
      await click('[data-toolkit-close]')
    }
    await read('window.toolkitScene.theme("dark")')
    win.setContentSize(320, 800); await pause(120)
    if (preparationScope === 'full') {
      await click('.performance-trigger[aria-label="More tools"]'); await until('document.querySelector(".toolkit-overflow__item")?.checkVisibility()')
      await click('.toolkit-overflow__item'); await until('document.querySelector(".toolkit-result__actions")?.checkVisibility()')
      await click('.toolkit-result__actions button:last-child'); await until('document.querySelector(".toolkit-editor .monaco-editor")?.checkVisibility()')
    }
    await frame('320-dark-editor.png')
    await click('.toolkit-editor .toolkit-editor__back'); await frame('320-dark-library.png')
    await click('[data-tool-id="summary"]'); await until('document.querySelector(".toolkit-editor .monaco-editor")?.checkVisibility()')
    await read('window.toolkitScene.theme("light")'); await frame('320-light-editor.png')
    await click('.surface-navigation [aria-label="Settings"]')
    }
    raw.geometry = []
    if (preparationScope !== 'models' && preparationScope !== 'actions') {
    for (const width of [1480,640,320]) for (const mode of ['icon','label','disabled']) {
      win.setContentSize(width,800)
      await owner.edit(owner.current,{...owner.current,toolkit:{...owner.current.toolkit,performance:{enabled:mode!=='disabled',statusBar:mode==='label'?'label':'icon'}}})
      for (const definition of owner.current.toolkit.tools) await toolkit.execute({operation:'toolkit.update',toolId:definition.id,changes:{enabled:mode!=='disabled',statusBar:mode==='label'?'label':'icon'},expected:{enabled:definition.enabled,statusBar:definition.statusBar}},new AbortController().signal)
      await until(`(()=>{const c=window.toolkitScene.display();return c?.performance.enabled===${mode!=='disabled'}&&c.performance.statusBar===${JSON.stringify(mode==='label'?'label':'icon')}&&c.tools.length===2&&c.tools.every(t=>t.enabled===${mode!=='disabled'}&&t.statusBar===${JSON.stringify(mode==='label'?'label':'icon')})})()`)
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const geometry = await read(`(()=>{
        const rect=n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})
        const visible=n=>n.isConnected&&n.checkVisibility({visibilityProperty:true})
        const settings=Array.from(document.querySelectorAll('button[aria-label="Settings"]')).filter(visible),nav=document.querySelector('.surface-navigation'),group=document.querySelector('.window-status-bar__toolkits'),bar=document.querySelector('.toolkit-statusbar')
        return{viewport:innerWidth,settings:settings.map(n=>({rect:rect(n),left:!!n.closest('.surface-navigation'),right:!!n.closest('.window-status-bar__toolkits')})),nav:rect(nav),group:rect(group),direction:getComputedStyle(bar).flexDirection,tools:Array.from(bar.querySelectorAll('button.performance-trigger')).filter(visible).map(n=>({id:n.dataset.toolkitId??null,name:n.getAttribute('aria-label'),label:n.querySelector(':scope > span')?.textContent??null,rect:rect(n)}))}
      })()`)
      raw.geometry.push({width,mode,...geometry})
      assert.equal(geometry.viewport,width,'Actual native width')
      assert.equal(geometry.settings.length,1,'One visible Settings entry')
      assert.equal(geometry.settings[0].left,true,'Settings belongs to actual left navigation')
      assert.equal(geometry.settings[0].right,false,'Settings is absent from the Toolkit utilities')
      assert.equal(geometry.direction,'row-reverse','User Toolkit entries grow from the right')
      assert.ok(geometry.settings[0].rect.x>=geometry.nav.x&&geometry.settings[0].rect.x+geometry.settings[0].rect.width<=geometry.nav.x+geometry.nav.width+0.5,'Actual left containment')
      assert.ok(geometry.nav.x+geometry.nav.width<=geometry.group.x+0.5,'Function and Toolkit groups do not overlap')
      if(mode==='disabled') assert.equal(geometry.tools.length,0,'Disabled Toolkit controls are absent')
      else {
        assert.ok(geometry.tools.length>0,'Nonempty actual Toolkit controls')
        const performance=geometry.tools.find(tool=>tool.id==='performance')
        assert.ok(performance,'Performance right anchor is present')
        for(const tool of geometry.tools) {
          assert.ok(tool.rect.width>0&&tool.rect.height>0&&tool.rect.x>=geometry.group.x-0.5&&tool.rect.x+tool.rect.width<=width+0.5,'Actual button is within its right group and viewport')
          if(tool.id!=='performance') assert.ok(tool.rect.x+tool.rect.width<=performance.rect.x+0.5,'Performance remains the right tool anchor')
          if(mode==='label'&&tool.id) assert.ok(tool.label?.trim(),'Label mode retains nonempty readable text')
        }
      }
    }
    assert.equal(raw.geometry.length,9,'All nine width and configured-mode scenes actually visited')
    for (const width of [1480,640,320]) {
      const entries=raw.geometry.filter(scene=>scene.width===width)
      const anchor=entries[0].settings[0].rect
      for(const scene of entries) assert.deepEqual(scene.settings[0].rect,anchor,'Toolkit display changes do not move the Settings anchor')
    }
    }
    if (preparationScope === 'models' || preparationScope === 'actions') {
      const originalConfig=owner.current,seed=originalConfig.toolkit.tools[0]
      assert.ok(originalConfig.hosts.length<=8,'The private baseline leaves room for the bounded Host control')
      const costActions=Array.from({length:16},(_,index)=>({id:`cost-action-${index}`,label:`Action ${index+1}`,script:`console.log(${index})`,args:[]}))
      const costSeed=preparationScope==='actions'?{...seed,actions:costActions}:seed
      await owner.edit(owner.current,{...owner.current,hosts:[...owner.current.hosts,...Array.from({length:8-originalConfig.hosts.length},(_,index)=>({id:`cost-host-${index}`,kind:'ssh',label:`Cost Host ${index}`,hostname:`cost-${index}.invalid`}))],toolkit:{...owner.current.toolkit,tools:[costSeed,originalConfig.toolkit.tools[1],...Array.from({length:126},(_,index)=>({...costSeed,id:`cost-tool-${index}`,name:`Cost Tool ${index}`}))]}})
      await until('window.toolkitScene.display()?.tools.length===128')
      await click('.surface-navigation [aria-label="Settings"]'); await click('[data-settings-target="toolkit"]'); await click('[data-tool-id="summary"]')
      await until('document.querySelector(".toolkit-editor .monaco-editor")?.checkVisibility()')
      raw.modelCost = {before:await read('window.toolkitScene.models()')}
      assert.deepEqual(raw.modelCost.before.map(({scheme,authority,path})=>({scheme,authority,path})),[{scheme:'toolkit',authority:'',path:'/summary.mjs'}],'One actual selected Monaco model for 128 saved tools')
      assert.equal(raw.modelCost.before[0].disposed,false,'Nonempty live model positive control')
      await read('window.toolkitScene.unrelated()')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      raw.modelCost.inputs=await read('window.toolkitScene.inputCounts()')
      assert.equal(raw.modelCost.inputs.unrelated,128,'Actual unrelated Session input is nonempty')
      assert.equal(raw.modelCost.inputs.hosts,8,'Actual Host input is nonempty')
      raw.modelCost.after=await read('window.toolkitScene.models()')
      assert.deepEqual(raw.modelCost.after,raw.modelCost.before,'Unrelated Session/Host inputs do not create editor models')
      if(preparationScope==='actions') {
        if (!await read('document.querySelector(".toolkit-editor__result-actions").open')) await click('.toolkit-editor__result-actions > summary')
        raw.modelCost.actions=[]
        for(const action of costActions) {
          await click(`[data-toolkit-edit-action="${action.id}"]`)
          await until(`window.toolkitScene.models().then(models=>models.length===1&&models[0].path===${JSON.stringify(`/summary/actions/${action.id}.mjs`)})`)
          const models=await read('window.toolkitScene.models()')
          assert.equal(models.length,1,'Only the selected actual action model is alive')
          assert.equal(models[0].disposed,false,'Actual action model is live')
          raw.modelCost.actions.push({id:action.id,models})
        }
        assert.equal(raw.modelCost.actions.length,16,'All sixteen configured actions actually switched')
        await click('.toolkit-editor__action-heading > button')
        await until('window.toolkitScene.models().then(models=>models.length===1&&models[0].path==="/summary.mjs")')
        raw.modelCost.mainRestored=await read('window.toolkitScene.models()')
        assert.deepEqual(raw.modelCost.mainRestored,raw.modelCost.before,'Return to one main script model')
      }
      await click('.surface-navigation [aria-label="Settings"]')
      await until('document.querySelector(".surface-navigation [aria-label=Settings]")?.getAttribute("aria-expanded")==="false"')
      raw.modelCost.closed=await read('window.toolkitScene.models()')
      assert.deepEqual(raw.modelCost.closed,[],'Closing the actual Settings releases its only model')
      await read('window.toolkitScene.restoreInputs()')
      await owner.edit(owner.current,originalConfig)
      await until('window.toolkitScene.display()?.tools.length===2')
    }
    }
    raw.after = await read('window.toolkitScene.surface()')
    assert.deepEqual(raw.after, raw.before, 'Nonempty original preview workbench and draft remain exact')
    raw.facts = await read('window.toolkitScene.facts()')
    assert.ok(raw.facts.tools.length > 0, 'The actual retained tool set is nonempty')
    assert.deepEqual(raw.facts.snapshots.map(value => value.toolId).sort(), raw.facts.tools.map(value => value.id).sort(), 'Every retained tool has its exact snapshot')
    assert.equal(raw.facts.snapshots.reduce((sum, value) => sum + value.consumerCount, 0), 0, 'Closing only releases all owned readers')
    raw.qualified = true
  } catch (error) { raw.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally {
    // Preserve actual failure and partial native facts before ordinary window close.
    if(qualification&&win&&!win.isDestroyed()){try{raw.toolkitCalls=await win.webContents.executeJavaScript('window.toolkitScene?.toolkitCalls');raw.operationErrors=await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".toolkit-result [role=alert]")).map(n=>n.textContent)')}catch(error){raw.finalReadError=String(error)}}
    fs.writeFileSync(path.join(evidence,phase+'-render.json'),JSON.stringify(raw,null,2)+'\n')
    try {
      if(qualification&&win&&!win.isDestroyed()) {
        await win.webContents.session.flushStorageData()
        const closed=new Promise(resolve=>win.once('closed',resolve));win.close();await closed
        raw.ordinaryGuiClose=true
      }
      detachIpc?.(); await toolkit?.dispose()
      if (toolkit && raw.facts) {
        const snapshots = await Promise.all(raw.facts.tools.map(tool => toolkit.execute({ operation: 'toolkit.get', toolId: tool.id }, new AbortController().signal)))
        const performance = await toolkit.execute({ operation: 'toolkit.get', toolId: 'performance' }, new AbortController().signal)
        raw.afterDisposalLeases = performance.snapshot.consumerCount + snapshots.reduce((sum, value) => sum + value.snapshot.consumerCount, 0)
        assert.equal(raw.afterDisposalLeases, 0, 'Actual disposed owners have no readers')
      }
      await server?.stop(); metrics?.dispose(); detachRuntime?.(); await runtime?.dispose(); sampler?.dispose()
    }
    catch (error) { raw.cleanupError = String(error); raw.qualified = false; process.exitCode = 1 }
    fs.writeFileSync(path.join(evidence, phase + '-render.json'), JSON.stringify(raw, null, 2) + '\n')
    if(win&&!win.isDestroyed())win.destroy(); app.quit()
  }
})
