import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerIpc } from '../../../src/main/ipc'
import { DEFAULT_CONFIG } from '../../../src/main/config-store'
const [html, privateRoot, preload, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime'); process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'state')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
const output: any = { schema: 'agentmux.focus-retired-history-renderer-scene.v1', passed: false, pid: process.pid, controls: [], reads: [], ipc: [], frames: [],
  boundary: 'Actual public Core/FileStore Reader → Main controller/registered production IPC → compiled production preload/API → mounted Timeline/Preview. The scene shell replaces App/PTY paint and isolates host preparation; it does not simulate message bodies, create a Runtime, navigate a Session, or qualify ordinary GUI closing/restart/install.' }
let win: BrowserWindow, client: AgentMuxClient, controller: RuntimeController, dispose: (() => Promise<void>) | undefined
app.whenReady().then(async () => {
  const until = async (expression: string, budget = 12000) => { const deadline = Date.now() + budget; do { const observed = await win.webContents.executeJavaScript(expression); if (observed) return observed; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < deadline); throw new Error(`Condition did not settle: ${expression}`) }
  const click = async (selector: string) => {
    const point = await win.webContents.executeJavaScript(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)throw new Error('Missing click target'); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...point })
  }
  const key = async (key: string, code: string, windowsVirtualKeyCode: number) => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode }) }
  const select = async (id: string) => { await win.webContents.executeJavaScript(`(() => { const select=document.querySelector('[aria-label="Input records Context"]'); if(![...select.options].some(option=>option.value===${JSON.stringify(id)}))throw new Error('Missing actual source option'); select.focus(); select.value=${JSON.stringify(id)}; select.dispatchEvent(new Event('change',{bubbles:true})); return true })()`); output.sourceSelectionInput='Actual compiled native select/change event; subsequent More/Continue/preview/scroll/Escape/window actions use trusted CDP input' }
  const shot = async (name: string) => {
    if(name!=='narrow-timeline')await until(`(()=>{const surface=document.querySelector('.recent-focus__message-preview');if(!surface)return false;const rect=surface.getBoundingClientRect();if(getComputedStyle(surface).visibility!=='visible'||rect.width<=0||rect.height<=0)return false;return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('.recent-focus__message-preview')===surface})()`)
    await win.webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const image = `${name}.png`; await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG()); output.frames.push({ image, width: await win.webContents.executeJavaScript('innerWidth'), state: await win.webContents.executeJavaScript('retiredSourceState()') }) }
  try {
    const store = new AgentMuxFileAgentSessionStore(path.join(privateRoot, 'sessions.json')), now = Date.now()
    for (let index=0;index<35;index++) {
      const id=`archived-${index}`, native=`native-${id}`, locator=path.join(privateRoot, `${id}.jsonl`)
      const records = index===0 ? [{id:'one',body:'Same original retained input',at:now-3600000},{id:'two',body:'Same original retained input'},...Array.from({length:130},(_,n)=>({id:`record-${n}`,body:`Read the retained task ${n}: verify the original changes and preserve the result.`,at:now-3600000}))] : [{id:`other-${index}`,body:`Unfocused source ${index}: original retained input.`,at:now-3600000}]
      await fs.writeFile(locator, records.map(item=>JSON.stringify({sessionId:native,uuid:item.id,type:'user',message:{role:'user',content:item.body},...('at' in item?{timestamp:new Date(item.at!).toISOString()}: {})})).join('\n')+'\n')
      const session: AgentMuxStoredAgentSession = {kind:'agent',agentSessionId:id,providerId:'claude',executorId:'private-claude',hostId:'private-host',workspacePath:privateRoot,run:{runId:`never-controlled-${id}`},retiredRuns:[],hookBindingId:`private-${id}`,hookToken:'private-token',createdAt:1,updatedAt:1,nativeHandle:{kind:'provider',providerId:'claude',sessionId:native,transcriptPath:locator}}
      await store.compareAndSwap(null,session)
      if(index===0) await store.applyTimelineMutation({type:'append',agentSessionId:id,item:{id:'captured',agentSessionId:id,kind:'user_message',source:'user',status:'complete',createdAt:now-3600000,updatedAt:now-3600000,title:'Input',content:'Same original retained input'}})
      const reservation={kind:'stop' as const,reservationId:`retire-${id}`,ownerId:'private-scene',ownerPid:process.pid,agentSessionId:id,expectedRun:session.run,operationId:`retire-op-${id}`,expiresAt:Date.now()+60000,stopOperation:{daemonInstance:'no-runtime',operationKey:`not-a-stop-${id}`,runId:session.run.runId}}
      await store.reserveLifecycle(reservation);await store.commitLifecycle(reservation,null)
    }
    client=new AgentMuxClient({store})
    const kernel=(client as any).kernel
    for(const name of ['connect','start','input','resize','stop','attach','status'])kernel[name]=async(...args:any[])=>{output.controls.push({name,args});throw new Error(`Forbidden Runtime ${name}`)}
    controller=new RuntimeController(store)
    controller.commit({hosts:[{id:'private-host',client,executionHost:{kind:'local',dispose:async()=>{}} as never}],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
    // Only host setup is isolated. All read operations use the real Controller/IPC.
    controller.prepare=async()=>({hosts:[],removedHostIds:[],reservedHostIds:[],hostSignatures:new Map()})
    for(const name of ['sessionHistorySources','sessionHistoryPage','sessionTimeline'] as const){const original=controller[name].bind(controller);(controller as any)[name]=async(...args:any[])=>{output.reads.push({name,args:args.map(value=>typeof value==='object'&&value?.executors?'[config]':value)});return (original as any)(...args)}}
    const config={...structuredClone(DEFAULT_CONFIG),hosts:[],workspaces:[],executors:{'private-claude':{providerId:'claude',label:'Private',command:'claude',args:[],env:{},injectAgentMuxGuide:false}}}
    win=new BrowserWindow({width:1440,height:920,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false,preload}})
    const registerHandle=ipcMain.handle.bind(ipcMain)
    ipcMain.handle=(channel,listener)=>registerHandle(channel,(event,...args)=>{if(['sessions:historySources','sessions:historyPage','sessions:timeline'].includes(channel))output.ipc.push({channel,args});return listener(event,...args)})
    dispose=await registerIpc({window:win,runtime:controller,configStore:{get:async()=>config} as never,progressLoops:{subscribe:()=>()=>{}} as never,scratchTopics:{} as never,workspaceFiles:{dispose:async()=>{}} as never})
    win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)process.stderr.write(`Renderer: ${message}\n`)})
    await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await until('retiredSourceReady && !!document.querySelector("[aria-label=\\"View input records\\"]")')
    await click('[aria-label="View input records"]');await until('retiredSourceState().sources === 30')
    await shot('wide-sources')
    const more=await win.webContents.executeJavaScript(`(()=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent==='Show more input sources');node.id='source-more';return true})()`);assert.equal(more,true)
    await click('#source-more');await until('retiredSourceState().sources === 35')
    assert.equal(output.reads.filter((read:any)=>read.name==='sessionHistoryPage').length,0)
    await select('archived-0');await until('retiredSourceState().inputs.length === 91');await shot('wide-read')
    assert.equal(output.ipc.filter((read:any)=>read.channel==='sessions:historySources').length,1)
    assert.equal(output.reads.filter((read:any)=>read.name==='sessionHistoryPage').length,3)
    await click('[data-input-message-id]');await until('!!document.querySelector("[data-input-preview-id]")')
    const pin=await win.webContents.executeJavaScript(`(()=>{const body=document.querySelector('[data-input-preview-id]');window.retiredPreviewNode=body;const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){if(text.textContent.includes('Read the retained task'))break}if(!text)throw new Error('No real body text');const range=document.createRange();range.selectNodeContents(text);window.getSelection().removeAllRanges();window.getSelection().addRange(range);const list=document.querySelector('.recent-focus__input-list');list.scrollTop=40;const bounds=list.getBoundingClientRect();const first=[...list.querySelectorAll('[data-input-message-id]')].find(node=>node.getBoundingClientRect().top>=bounds.top&&node.getBoundingClientRect().top<bounds.bottom);return {id:body.dataset.inputPreviewId,selection:window.getSelection().toString(),scroll:list.scrollTop,anchor:first.dataset.inputMessageId,offset:first.getBoundingClientRect().top-bounds.top}})()`)
    assert.ok(pin.selection.length>0)
    await win.webContents.executeJavaScript(`(()=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent==='Read earlier records');node.id='source-earlier';return true})()`)
    await click('#source-earlier');await until('document.querySelector("#source-earlier").disabled && retiredSourceState().inputs.some(id=>id.endsWith(":two"))')
    output.preservation=await win.webContents.executeJavaScript(`({sameNode:window.retiredPreviewNode===document.querySelector('[data-input-preview-id]'),selection:window.getSelection().toString(),scroll:document.querySelector('.recent-focus__input-list').scrollTop,viewport:(()=>{const list=document.querySelector('.recent-focus__input-list'),bounds=list.getBoundingClientRect();const first=[...list.querySelectorAll('[data-input-message-id]')].find(node=>node.getBoundingClientRect().top>=bounds.top&&node.getBoundingClientRect().top<bounds.bottom);return {anchor:first.dataset.inputMessageId,offset:first.getBoundingClientRect().top-bounds.top}})(),state:retiredSourceState()})`)
    assert.equal(output.preservation.sameNode,true);assert.equal(output.preservation.selection,pin.selection);assert.equal(output.preservation.viewport.anchor,pin.anchor);assert.ok(Math.abs(output.preservation.viewport.offset-pin.offset)<1,'Same visible record and pixel position; raw scrollTop changes when earlier rows are prepended')
    assert.equal(output.preservation.state.inputs.length,91)
    await shot('wide-preview')
    win.setContentSize(640,720);await until('innerWidth===640');await shot('narrow-preview')
    await click('[aria-label="View input records"]');await until('!!document.querySelector(".recent-focus__input-list")')
    const point=await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.recent-focus__input-list').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-8000})
    await until('document.querySelector(".recent-focus__input-list").scrollTop===0')
    await click('[data-input-message-id="native:claude:native-archived-0:two"]');await until('document.querySelector("[data-input-preview-id]")?.dataset.inputPreviewId.endsWith(":two")')
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".recent-focus__message-preview").textContent.includes("Record time unknown")'),true)
    await shot('narrow-unknown-time')
    await click('.recent-focus__source-details summary');await until('document.querySelector(".recent-focus__source-details").open')
    await shot('narrow-source-details')

    await key('Escape','Escape',27);await until('!document.querySelector("[data-input-preview-id]")')
    const countBefore=output.reads.length;await click('[aria-label="Previous focus window"]');await until('retiredSourceState().markers.length===0')
    assert.ok(output.reads.length>=countBefore);await click('[aria-label="Return to current focus window"]');await until('retiredSourceState().markers.length>0')
    await shot('narrow-timeline')
    assert.equal(output.controls.length,0);assert.equal((await win.webContents.executeJavaScript('retiredSourceState()')).members,0)
    output.passed=true
  }catch(error:any){output.failure={name:error.name,message:error.message,stack:error.stack};if(win&&!win.isDestroyed()){output.atFailure=await win.webContents.executeJavaScript('window.retiredSourceState?.()').catch(()=>null);await shot('failure').catch(()=>{})}}
  finally{if(dispose)await dispose().catch(error=>{output.cleanupError=String(error);output.passed=false});if(controller)await controller.dispose().catch(error=>{output.cleanupError=String(error);output.passed=false});if(win&&!win.isDestroyed())win.destroy();await fs.writeFile(path.join(evidence,'scene.json'),JSON.stringify(output,null,2));app.exit(output.passed?0:1)}
})
