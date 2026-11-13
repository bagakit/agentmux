const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), os = require('node:os')
const [html, profile, evidence, nativeModule, workspacePath] = process.argv.slice(2)
const paths = { home: process.env.HOME, appData: path.join(profile, 'app-data'), userData: path.join(profile, 'user-data'), sessionData: path.join(profile, 'session-data') }
for (const [name,directory] of Object.entries(paths)) app.setPath(name,directory)
const report = { schema:'agentmux.workspace-file-sources-process.v1', passed:false, pid:process.pid, reads:[], opens:[], releases:[], console:[], frames:[], checks:{}, observations:[] }
const workspace = { id:'source-private', name:'Private PDF source', hostId:'local', path:workspacePath, kind:'folder' }
const config = { version:9, hosts:[{id:'local',kind:'local',label:'Private'}], workspaces:[workspace], executors:{}, appearance:{terminalTheme:'graphite'} }
let win, files, sources
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms))
const evaluate = code=>win.webContents.executeJavaScript(code,true)
async function wait(code) { for(const until=Date.now()+30000;Date.now()<until;) { const value=await evaluate(code);if(value)return value;await sleep(50) };throw Error('Missing actual PDF consumer fact: '+code) }
const bytes = ()=>report.reads.reduce((sum,read)=>sum+(read.bytes??0),0)
async function frame(name) { const file=name+'.png';await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());report.frames.push(file) }
function observe(phase) {
  const cpus=os.cpus(), times=cpus.reduce((sum,cpu)=>{for(const [key,value] of Object.entries(cpu.times))sum[key]=(sum[key]??0)+value;return sum},{})
  report.observations.push({phase,at:performance.now(),wallTime:Date.now(),loadAverage:os.loadavg(),logicalCpus:cpus.length,cpuTimes:times,
    freeMemoryBytes:os.freemem(),totalMemoryBytes:os.totalmem(),mainCpuUsage:process.cpuUsage(),
    appMetrics:app.getAppMetrics().map(({pid,type,cpu,memory})=>({pid,type,cpu,memory}))})
}
async function openFile(phase) {
  return evaluate(`(() => { const trace=globalThis.__agentmuxPdfPerformance ??= {events:[],readers:0};
    const at=performance.now();trace.events.push({name:'file-open',at,phase:${JSON.stringify(phase)}});fileSourceProbe.render(true);return at })()`)
}

app.whenReady().then(async()=>{try {
  report.isolation=Object.fromEntries(Object.keys(paths).map(name=>[name,app.getPath(name)]));assert.deepEqual(report.isolation,paths)
  assert.equal(process.env.AGENTMUX_AGENT_SESSION_STORE,path.join(paths.userData,'agent-sessions.json'))
  const {WorkspaceFiles,WorkspaceFileSources}=await import(nativeModule)
  files=new WorkspaceFiles(()=>({kind:'local'}));sources=new WorkspaceFileSources(files,()=>workspace)
  ipcMain.on('fixture:boot',event=>{event.returnValue={config}})
  ipcMain.handle('files:openSource',async(event,id,file)=>{assert.equal(id,workspace.id);const startedAt=performance.now();const result=await sources.open(event.sender.id,workspace,file);report.opens.push({...result,startedAt,finishedAt:performance.now()});return result})
  ipcMain.handle('files:readSource',async(event,id,readId,offset,length)=>{const startedAt=performance.now();const result=await sources.read(event.sender.id,id,readId,offset,length);report.reads.push({id,offset,length,status:result.status,bytes:result.bytes?.length,startedAt,finishedAt:performance.now()});return result})
  ipcMain.handle('files:cancelSourceRead',(event,id,readId)=>sources.cancel(event.sender.id,id,readId))
  ipcMain.handle('files:releaseSource',async(event,id)=>{await sources.release(event.sender.id,id);report.releases.push(id)})
  ipcMain.handle('files:readPreview',()=>{throw Error('A PDF must consume original file ranges, not a byte snapshot')})
  win=new BrowserWindow({show:false,width:1040,height:820,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,preload:path.join(__dirname,'preload.cjs')}})
  win.webContents.on('console-message',(_event,_level,message)=>report.console.push(message))
  observe('before-shell')
  const openedAt=performance.now();await win.loadFile(html)
  await wait('typeof fileSourceProbe==="object"')
  report.checks.shellReadyMs=Math.round(performance.now()-openedAt)
  observe('shell-ready')
  const readerOpenedAt=performance.now();report.checks.coldOpenedAt=await openFile('cold')
  await wait('typeof fileSourceProbe==="object"&&fileSourceProbe.state().phase==="ready"')
  const first=await evaluate('fileSourceProbe.state()'),size=(await fs.stat(path.join(workspacePath,'large.pdf'))).size
  assert.equal(first.page,'1');assert.ok(first.canvasPages.includes('1'));assert.ok(first.text.includes('/ 100'))
  report.checks.firstFrameMs=Math.round(performance.now()-readerOpenedAt);report.checks.fileBytes=size;report.checks.firstFrameBytes=bytes()
  assert.ok(size>16*1024*1024);assert.ok(bytes()<size/4,'First page reads a bounded part of the large PDF')
  observe('cold-first-page')
  await frame('first-page')
  const settled=bytes();await sleep(1200);report.checks.idleByteGrowth=bytes()-settled
  assert.equal(report.checks.idleByteGrowth,0,'An idle page does not prefetch the whole PDF')
  report.checks.memoryAtFirstPage=app.getAppMetrics().map(({pid,type,memory})=>({pid,type,memory}))
  const jumpedAt=performance.now();await evaluate('fileSourceProbe.page(100)')
  await wait('fileSourceProbe.state().page==="100"&&fileSourceProbe.state().phase==="ready"&&fileSourceProbe.state().canvasPages.includes("100")')
  report.checks.distantPageMs=Math.round(performance.now()-jumpedAt);report.checks.bytesAfterJump=bytes()
  assert.ok(report.reads.some(read=>read.offset>size*0.8&&read.bytes>0),'Distant page reads its actual original range')
  assert.ok(bytes()<size/3,'Jumping does not drain all intermediate pages')
  observe('distant-page')
  await frame('distant-page')
  const opened=report.opens.find(item=>item.status==='ready');assert.ok(opened)
  observe('before-hide')
  await evaluate('fileSourceProbe.render(false)')
  await wait('!document.querySelector(".pdf-content")')
  for(const until=Date.now()+10000;Date.now()<until&&!report.releases.includes(opened.id);)await sleep(50)
  assert.ok(report.releases.includes(opened.id),'Hiding releases the exact original source')
  const hiddenReads=report.reads.length;await sleep(1000)
  assert.equal(report.reads.length,hiddenReads,'Hidden File performs zero source reads')
  assert.equal((await sources.read(win.webContents.id,opened.id,'after-hide',0,0)).status,'released')
  report.checks.hiddenReadGrowth=report.reads.length-hiddenReads
  observe('hidden')
  const warmOpenedAt=performance.now();report.checks.warmOpenedAt=await openFile('warm');await wait('fileSourceProbe.state().phase==="ready"')
  report.checks.warmFirstFrameMs=Math.round(performance.now()-warmOpenedAt)
  observe('warm-first-page')
  await frame('reopened-first-page')
  report.performance=await evaluate(`({timeOrigin:performance.timeOrigin,events:globalThis.__agentmuxPdfPerformance?.events??[],resources:performance.getEntriesByType('resource').map(({name,startTime,duration,initiatorType,transferSize,decodedBodySize})=>({name,startTime,duration,initiatorType,transferSize,decodedBodySize}))})`)
  const events=report.performance.events
  assert.equal(events.filter(item=>item.name==='reader-effect-start').length,2,'Cold and warm actual reader effects are both instrumented')
  assert.equal(events.filter(item=>item.name==='reader-module-start').length,1,'React lazy reader module stays loaded on reopen')
  for(const reader of [1,2]) { for(const name of ['worker-ready','document-ready','first-page-get-end','page-render-start','current-page-ready'])assert.ok(events.some(item=>item.reader===reader&&item.name===name),'Nonempty real phase '+reader+': '+name) }
  assert.equal(report.opens.filter(item=>item.status==='ready').length,2,'Showing the same File acquires a new source')
  report.checks.reopenedSameFile=true
  report.checks.memoryAfterReopen=app.getAppMetrics().map(({pid,type,memory})=>({pid,type,memory}))
  report.passed=true
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack};try{await frame('failure');report.state=await evaluate('typeof fileSourceProbe==="object"?fileSourceProbe.state():document.body.innerText')}catch{}}
finally{await sources?.dispose();await files?.dispose();await fs.writeFile(path.join(evidence,'process-receipt.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1)}})
