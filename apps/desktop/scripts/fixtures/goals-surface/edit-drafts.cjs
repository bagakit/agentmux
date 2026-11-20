const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, privateRoot, evidence, phase, ownerModule] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const wire = value => JSON.parse(JSON.stringify(value)), delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  let win, goals, server, rpc, release
  const calls = [], writes = []; let fault = 'normal'
  try {
    const owner = await import(pathToFileURL(ownerModule).href)
    const user = new owner.WorkbenchUserStateStore(path.join(privateRoot, 'workbench-user-state.json'))
    const spatial = new owner.AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial.json'))
    const configurationPath = path.join(privateRoot, 'configuration.json')
    await fs.writeFile(configurationPath, JSON.stringify({version:9,workspaces:[],executors:{},hosts:[{id:'local',kind:'local',label:'Private proof Host'}]}))
    goals = owner.createHostGoals({configurationPath, spatial, projects:async()=>[], runtime:()=>{throw Error('No user Agent is used')},coreCall:async()=>{throw Error('This proof never sends Native Agent input')}})
    server = new owner.AgentMuxControlServer({socketPath:path.join(privateRoot,'rpc.sock'),coreClients:()=>[],goalControl:goals.execute,goalDelegations:goals.goalDelegations,goalChanges:goals.goalChanges})
    await server.start(); rpc = await owner.connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
    ipcMain.handle('goal-edit', async (_event, request) => {
      calls.push(request.kind === 'execute' ? request.input.operation : request.kind)
      if (request.kind === 'read-user') return user.read()
      if (request.kind === 'import-user') return user.importIfAbsent(request.value)
      if (request.kind === 'write-user') { const receipt=await user.write(request.value); writes.push(receipt); return receipt }
      if (request.kind === 'list') return goals.demands.list()
      if (request.kind === 'execute') {
        if (request.input.operation === 'demand.update') {
          if(fault==='reject')throw Error('The original Goal save is unavailable; the user text is retained')
          if(fault==='hold')await new Promise(resolve=>{release=resolve})
        }
        return owner.callPublicGoalControl(request.input,(method,params)=>rpc.call(method,params))
      }
      if (request.kind === 'delegation') return rpc.call(request.method,request.input)
      if (request.kind === 'spatial-read') return spatial.read()
      if (request.kind === 'spatial-commit') return spatial.commit(request.input)
      if (request.kind === 'create') {
        assert.equal(phase,'save','Restart cannot reseed the Domain or drafts')
        const g=request.goal
        const { seedStoredDemand } = await import('../../../../../test/fixtures/stored-demand.mjs')
        await seedStoredDemand(goals.demands,{id:g.id,title:g.title,description:g.description,status:g.status,assigneeSessionIds:g.assigneeSessionIds,supervisorSessionId:g.supervisorSessionId,sessionIds:g.sessionIds})
        if(g.alignment)await goals.demands.proposeAlignment(g.id,{summary:g.alignment.summary,criteria:g.alignment.criteria,openQuestions:g.alignment.openQuestions})
        return
      }
      throw Error('Unknown private operation: '+request.kind)
    })
    const preload=path.join(privateRoot,'goal-edit-preload.cjs')
    await fs.writeFile(preload,`const {contextBridge,ipcRenderer}=require('electron');const call=request=>ipcRenderer.invoke('goal-edit',request);contextBridge.exposeInMainWorld('goalEditNative',{readWorkbenchState:()=>call({kind:'read-user'}),importWorkbenchState:value=>call({kind:'import-user',value}),writeWorkbenchState:value=>call({kind:'write-user',value}),requestStorageFlush:async()=>{}});contextBridge.exposeInMainWorld('goalsPlanningRestart',{phase:${JSON.stringify(phase)},list:()=>call({kind:'list'}),execute:input=>call({kind:'execute',input}),delegation:(method,input)=>call({kind:'delegation',method,input}),createGoal:goal=>call({kind:'create',goal})});contextBridge.exposeInMainWorld('goalsRestartSpatial',{read:()=>call({kind:'spatial-read'}),commit:input=>call({kind:'spatial-commit',input})});`)
    win=new BrowserWindow({show:false,width:1280,height:780,webPreferences:{preload,sandbox:false,backgroundThrottling:false}})
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    const evaluate=async source=>{try{return await win.webContents.executeJavaScript(source)}catch(error){throw Error(`Private Goal restart evaluation failed: ${source}`,{cause:error})}}
    const wait=async source=>{for(let i=0;i<200;i++){if(await evaluate(source))return;await delay(30)}throw Error('Missing real product fact: '+source)}
    const input=label=>`document.querySelector('[aria-label="${label}"]')`
    const button=label=>`[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)}||node.getAttribute('aria-label')===${JSON.stringify(label)})`
    const click=async source=>{const point=await evaluate(`(()=>{const node=${source};if(!node)throw Error('Missing actual click target');node.scrollIntoView({block:'center'});const b=node.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});await delay(80)}
    const type=async(label,text)=>{await evaluate(`(()=>{const node=${input(label)};node.focus();node.select()})()`);await win.webContents.debugger.sendCommand('Input.insertText',{text});await wait(`${input(label)}?.value===${JSON.stringify(text)}`)}
    const capture=async suffix=>{for(const width of [1280,620]){await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});await evaluate('document.querySelector(".goals-detail").scrollTop=0');await delay(100);await fs.writeFile(path.join(evidence,width+'-'+suffix+'.png'),(await win.webContents.capturePage()).toPNG())}await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1280,height:780,deviceScaleFactor:1,mobile:false})}
    await wait('Boolean(window.goalEditProof&&window.goalsVisual)')
    if(phase==='save'){
      await evaluate('goalsVisual.seedWorkflow("finite")');const id=await evaluate('goalsVisual.preparePlanningRestart()')
      fault='reject';await type('Goal title','Unconfirmed original title')
      await capture('editing-draft')
      await click(button('Edit goal description'));await wait('Boolean(goalEditProof.facts().drafts["'+id+'"]?.title?.issue)')
      await type('Goal description','One explicit Done result')
      const before=calls.filter(kind=>kind==='demand.update').length
      fault='hold';await click(button('Done'));await delay(120)
      assert.equal(calls.filter(kind=>kind==='demand.update').length-before,1,'Actual Chromium blur and click share one save')
      fault='normal';release();await wait('!goalEditProof.facts().drafts["'+id+'"]?.description')
      fault='reject';await click(button('Edit goal description'));await type('Goal description','My unsaved original intent\nwith exact spacing  ')
      await click('document.querySelector(".goals-properties>summary")');await wait('Boolean('+input('Goal tags')+')')
      await type('Goal tags','  raw tag , second ,  ')
      await evaluate('goalEditProof.surface("workbench")');await wait('!document.querySelector(".global-board-surface")')
      await evaluate('goalEditProof.surface("board")');await wait('Boolean('+input('Goal title')+')')
      assert.equal(await evaluate(input('Goal title')+'.value'),'Unconfirmed original title')
      // Observe the original bounded native writer before the explicit exit checkpoint.
      for(let i=0;i<100;i++){const raw=await user.read();if(raw&&JSON.parse(raw).state.goalEditDrafts?.[id]?.tags?.value==='  raw tag , second ,  ')break;await delay(40)}
      const native=JSON.parse(await user.read())
      assert.equal(native.state.goalEditDrafts[id].tags.value,'  raw tag , second ,  ')
      assert.equal(native.state.goalEditDrafts[id].description.value,'My unsaved original intent\nwith exact spacing  ')
      await evaluate('goalEditProof.checkpoint()')
      const original=await evaluate('goalEditProof.facts()')
      await fs.writeFile(path.join(evidence,'before-restart.json'),JSON.stringify({pid:process.pid,original,calls,writes,domain:await goals.demands.get(id)},null,2))
    }else{
      assert.equal(phase,'restore')
      const first=JSON.parse(await fs.readFile(path.join(evidence,'before-restart.json'),'utf8'))
      assert.notEqual(process.pid,first.pid)
      await wait('Boolean('+input('Goal title')+')')
      const restored=wire(await evaluate('goalEditProof.facts()'))
      for(const key of ['drafts','selected','surface','tabs','layouts','composer'])assert.deepEqual(restored[key],first.original[key],'Original '+key+' survives a fresh process without reseed')
      assert.equal(await evaluate(input('Goal title')+'.value'),'Unconfirmed original title')
      assert.equal(await evaluate(input('Goal description')+'.value'),'My unsaved original intent\nwith exact spacing  ')
      await click('document.querySelector(".goals-properties>summary")');await wait('Boolean('+input('Goal tags')+')')
      assert.equal(await evaluate(input('Goal tags')+'.value'),'  raw tag , second ,  ')
      assert.equal(calls.filter(kind=>kind==='demand.update'||kind==='create').length,0,'Startup never saves or seeds restored user drafts')
      assert.deepEqual(await goals.demands.get(restored.selected),first.domain,'Restoring unsaved text does not modify Domain facts')
      await fs.writeFile(path.join(evidence,'restart.json'),JSON.stringify({passed:true,firstPid:first.pid,pid:process.pid,restored,calls,nativeObservation:user.observe(),boundary:'Actual production App, native WorkbenchUserStateStore with ordered durable ACK and public Unix Host Goal RPC; two private Electron processes. Controlled Runtime ports; no user App/Session/Run/input touched and no Native Agent recovery claim.'},null,2))
      await capture('failed-draft')
    }
    win.close();await rpc.dispose();await server.stop();await goals.dispose();app.quit()
  }catch(error){release?.();await fs.writeFile(path.join(evidence,'restart-failure.json'),JSON.stringify({message:error.message,stack:error.stack,calls},null,2));console.error(error);app.exit(1)}
})
