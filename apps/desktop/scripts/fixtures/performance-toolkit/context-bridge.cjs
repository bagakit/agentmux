const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const directory = process.env.AGENTMUX_TOOLKIT_EVIDENCE
app.setPath('userData', path.join(directory, 'electron-userdata'))
app.disableHardwareAcceleration()
const observations = [], leases = new Set()
let mode = 'delayed', serial = 0
const snapshot = { schema:'agentmux.toolkit.v1',toolId:'performance',executionId:null,run:null,state:'idle',reason:null,
  startedAt:null,observedAt:null,observation:null,manual:false,consumerCount:1,sequence:0,trend:[] }
const port = {
  async execute() { throw new Error('Bridge proof only exercises observation.') },
  async subscribe(_id, push, end, signal) {
    if (mode === 'failure') throw new Error('Actual bridge establishment failed.')
    const id = ++serial
    observations.push({ event:'entered',id });leases.add(id)
    let released = false
    const dispose = () => { if (!released) { released = true;leases.delete(id);observations.push({event:'disposed',id}) } }
    signal.addEventListener('abort', dispose, {once:true})
    await new Promise(resolve => setTimeout(resolve, 80))
    // Intentionally try a late Source callback. Actual IPC must reject it after release.
    push(snapshot)
    observations.push({event:'returned',id})
    return { dispose }
  }
}
let stop=()=>{}
let window,consoleMessages=[],preferences,collected=0,passedCases=0
async function until(fn) {
  for (let n=0;n<200;n++) { try { return fn() } catch (error) { if(n===199)throw error;await new Promise(resolve=>setTimeout(resolve,10)) } }
}
async function run() {
  await app.whenReady();app.dock?.hide()
  const {registerToolkitIpc}=await import(require('node:url').pathToFileURL(process.env.AGENTMUX_TOOLKIT_BRIDGE_MAIN).href)
  stop=registerToolkitIpc(port,(channel,handler)=>ipcMain.handle(channel,handler))
  window = new BrowserWindow({show:false,width:96,height:96,webPreferences:{preload:process.env.AGENTMUX_TOOLKIT_BRIDGE_PRELOAD,
    contextIsolation:true,nodeIntegration:false,sandbox:true}})
  preferences=window.webContents.getLastWebPreferences()
  assert.equal(preferences.contextIsolation,true)
  assert.equal(preferences.nodeIntegration,false)
  assert.equal(preferences.sandbox,true)
  window.webContents.on('console-message',(_event,...args)=>consoleMessages.push(args))
  window.webContents.on('preload-error',(_event,preloadPath,error)=>consoleMessages.push({preloadPath,error:String(error),stack:error.stack}))
  const html=path.join(directory,'bridge.html')
  fs.writeFileSync(html,'<!doctype html><meta charset="utf-8"><title>Private Toolkit bridge proof</title>')
  await window.loadFile(html)
  collected++
  assert.equal(await window.webContents.executeJavaScript('window.isSecureContext'),true,
    'Product file origin must provide a secure context for preload WebCrypto')
  assert.equal(await window.webContents.executeJavaScript('typeof window.agentmux'),'object',
    'Actual sandboxed product preload must publish its public bridge')
  const early=await window.webContents.executeJavaScript(`(() => {
    window.framesSeen=0;window.endSeen=[];
    const lease=window.agentmux.toolkit.observe(()=>window.framesSeen++,reason=>window.endSeen.push(reason));
    const result={disposeType:typeof lease.dispose,thenType:typeof lease.then};
    if(typeof lease.dispose==='function'){lease.dispose();lease.dispose()}
    return result;
  })()`)
  assert.equal(early.disposeType,'function','Real contextBridge must expose immediate proxied dispose')
  assert.equal(early.thenType,'undefined','Renderer must not await its cancellation handle')
  await until(()=>assert.ok(observations.some(e=>e.event==='returned'),'Actual IPC establishment must have been entered'))
  assert.deepEqual([...leases],[],'Establishment close must release its actual Main lease')
  assert.equal(await window.webContents.executeJavaScript('window.framesSeen'),0,'Disposed Renderer receives no late callback')
  assert.equal(observations.filter(e=>e.event==='disposed').length,1,'Duplicate dispose is idempotent')
  passedCases++
  const earlyEvents=observations.splice(0)
  collected++
  mode='delayed'
  await window.webContents.executeJavaScript('(() => {window.lease=window.agentmux.toolkit.observe(()=>window.framesSeen++,reason=>window.endSeen.push(reason));return true})()')
  await until(()=>assert.equal(leases.size,1,'Positive actual bridge consumer must be nonempty'))
  for(let n=0;n<200;n++) { if(await window.webContents.executeJavaScript('window.framesSeen')===1)break;await new Promise(resolve=>setTimeout(resolve,10)) }
  assert.equal(await window.webContents.executeJavaScript('window.framesSeen'),1,'Healthy actual Source callback crosses isolated bridge')
  await window.webContents.executeJavaScript('window.lease.dispose()')
  await until(()=>assert.equal(leases.size,0))
  passedCases++
  collected++
  mode='failure'
  await window.webContents.executeJavaScript('(() => {window.agentmux.toolkit.observe(()=>window.framesSeen++,reason=>window.endSeen.push(reason));return true})()')
  let ends=[]
  for(let n=0;n<200;n++) {ends=await window.webContents.executeJavaScript('window.endSeen');if(ends.length)break;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal(ends.length,1,'Establishment failure must reach typed API onEnd exactly once')
  assert.match(ends[0],/Actual bridge establishment failed\./u,'Source failure must survive the real Electron error envelope')
  assert.equal(await window.webContents.executeJavaScript('window.framesSeen'),1)
  passedCases++
  fs.writeFileSync(path.join(directory,'bridge-result.json'),JSON.stringify({contextIsolation:preferences.contextIsolation,
    nodeIntegration:preferences.nodeIntegration,sandbox:preferences.sandbox,collected,passedCases,
    early,earlyEvents,events:observations,ends,leases:[...leases],consoleMessages},null,2)+'\n')
}
run().then(()=>{stop();window?.destroy();app.quit()}).catch(error=>{
  fs.writeFileSync(path.join(directory,'bridge-failure.json'),JSON.stringify({name:error.name,message:error.message,stack:error.stack,
    collected,passedCases,preferences:preferences&&{contextIsolation:preferences.contextIsolation,
      nodeIntegration:preferences.nodeIntegration,sandbox:preferences.sandbox},events:observations,leases:[...leases],consoleMessages},null,2)+'\n')
  console.error(error);stop();window?.destroy();app.exit(1)
})
