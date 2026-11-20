const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const [html, privateRoot, evidence, phase, ownerModule] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const wire = value => JSON.parse(JSON.stringify(value))
app.whenReady().then(async () => {
  let win, goals, server, rpc
  const calls = []
  try {
    const owner = await import(pathToFileURL(ownerModule).href)
    const spatial = new owner.AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial.json'))
    const configurationPath = path.join(privateRoot, 'configuration.json')
    await fs.writeFile(configurationPath, JSON.stringify({version:9,workspaces:[],executors:{},hosts:[{id:'local',kind:'local',label:'Private proof Host'}]}))
    goals = owner.createHostGoals({ configurationPath, spatial, projects: async () => [],
      runtime: () => { throw Error('The exact original Supervisor Runtime is unavailable in this private process proof; its request remains retained.') },
      coreCall: async () => { throw Error('This restart proof never sends Native input') } })
    server = new owner.AgentMuxControlServer({ socketPath:path.join(privateRoot,'rpc.sock'),coreClients:()=>[],goalControl:goals.execute,goalDelegations:goals.goalDelegations,goalChanges:goals.goalChanges })
    await server.start(); rpc = await owner.connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
    ipcMain.handle('planning-restart', async (_event, request) => {
      calls.push(request.kind === 'execute' ? request.input.operation : request.method ?? request.kind)
      if (request.kind === 'list') return goals.demands.list()
      if (request.kind === 'execute') return owner.callPublicGoalControl(request.input,(method,params)=>rpc.call(method,params))
      if (request.kind === 'delegation') return rpc.call(request.method,request.input)
      if (request.kind === 'create') {
        assert.equal(phase,'save','Restoration only reads the original Host; it never reseeds or creates a Goal')
        const g = request.goal
        const { seedStoredDemand } = await import('../../../../../test/fixtures/stored-demand.mjs')
        await seedStoredDemand(goals.demands,{id:g.id,title:g.title,description:g.description,status:g.status,assigneeSessionIds:g.assigneeSessionIds,supervisorSessionId:g.supervisorSessionId,sessionIds:g.sessionIds})
        if(g.alignment) await goals.demands.proposeAlignment(g.id,{summary:g.alignment.summary,criteria:g.alignment.criteria,openQuestions:g.alignment.openQuestions})
        return
      }
      if(request.kind === 'spatial-read')return spatial.read()
      if(request.kind === 'spatial-commit')return spatial.commit(request.input)
      throw Error('Unknown private proof operation')
    })
    const preload = path.join(privateRoot,'planning-preload.cjs')
    await fs.writeFile(preload,`const {contextBridge,ipcRenderer}=require('electron');const call=request=>ipcRenderer.invoke('planning-restart',request);contextBridge.exposeInMainWorld('goalsPlanningRestart',{phase:${JSON.stringify(phase)},list:()=>call({kind:'list'}),execute:input=>call({kind:'execute',input}),delegation:(method,input)=>call({kind:'delegation',method,input}),createGoal:goal=>call({kind:'create',goal})});contextBridge.exposeInMainWorld('goalsRestartSpatial',{read:()=>call({kind:'spatial-read'}),commit:input=>call({kind:'spatial-commit',input})});`)
    win = new BrowserWindow({show:false,width:1280,height:780,webPreferences:{preload,sandbox:false,backgroundThrottling:false}})
    await win.loadFile(html)
    const evaluate=expression=>win.webContents.executeJavaScript(expression)
    const wait=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,40))}throw Error('Missing original restart fact: '+expression)}
    await wait('Boolean(window.goalsVisual)')
    if(phase==='save'){
      await evaluate('goalsVisual.seedWorkflow("finite")')
      const id=await evaluate('goalsVisual.preparePlanningRestart()')
      await evaluate('document.querySelector("[data-goal-plan-request]").click()')
      await wait('document.querySelector("[data-goal-plan-request-feedback]")?.textContent.includes("Supervisor unavailable")')
      const original=await evaluate('goalsVisual.planningRestartFacts()')
      const request=Object.values(original.planningRequests).find(request=>request.goalId===id)
      assert.ok(request?.requestId,'The native user document contains the original planning operation')
      assert.equal(original.goal.patrols[0].operationId,request.requestId)
      assert.equal(original.goal.patrols[0].purpose,'plan');assert.deepEqual(original.goal.patrols[0].attempts,[])
      await win.webContents.session.flushStorageData()
      await fs.writeFile(path.join(evidence,'planning-before-restart.json'),JSON.stringify({pid:process.pid,original,calls},null,2))
    }else{
      assert.equal(phase,'restore')
      const first=JSON.parse(await fs.readFile(path.join(evidence,'planning-before-restart.json'),'utf8'))
      assert.notEqual(first.pid,process.pid)
      const restored=await evaluate('goalsVisual.restoredWorkflow()')
      assert.deepEqual(restored.planningRequests,first.original.planningRequests)
      await wait('document.querySelector("[data-goal-plan-request-feedback]")?.textContent.includes("Supervisor unavailable")')
      const after=await evaluate('goalsVisual.planningRestartFacts()')
      assert.deepEqual(after.goal.patrols,first.original.goal.patrols,'The new Desktop reads the same original persistent Host request')
      for(const field of ['planningRequests','selected','surface','tabs','layouts','drafts'])assert.deepEqual(wire(after[field]),first.original[field],field+' survives the actual process restart')
      assert.ok(after.feedback.includes('planning request'))
      assert.equal(calls.filter(kind=>kind==='demand.discuss'||kind==='create').length,0,'Startup reads never replay the original planning input or reseed the Host')
      assert.equal((await goals.demands.list()).length,1)
      await fs.writeFile(path.join(evidence,'planning-restart.json'),JSON.stringify({passed:true,firstPid:first.pid,pid:process.pid,after,calls,
        boundary:'Two separate private Electron processes, real Chromium profile and real persisted Host Demand owner/public Unix RPC. The original Supervisor Runtime is deliberately unavailable: the same original request returns as missing, with zero input attempts. Real Native delivery and Supervisor plan save are proved by the separate managed CLI and mounted product tests; this does not assert live native recovery.'},null,2))
    }
    win.close();await rpc.dispose();await server.stop();await goals.dispose();app.quit()
  }catch(error){await fs.writeFile(path.join(evidence,'planning-restart-failure.json'),JSON.stringify({message:error.message,stack:error.stack,calls},null,2));console.error(error);app.exit(1)}
})
