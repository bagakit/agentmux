const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, temporary, evidence, mode] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user')); app.setPath('sessionData', path.join(temporary, 'session'))
const result = { passed: false, mode, frames: [], scenarios: [], userRunTouched: false }; let win
const call = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')')
const pause = ms => new Promise(r => setTimeout(r, ms))
async function wait(fn) { for(let i=0;i<200;i++){ if(await call(fn)) return; await pause(40) }; assert.fail('Actual source surface absent') }
async function paint(){ await call(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await pause(160) }
async function frame(name){ const bytes=(await win.webContents.capturePage()).toPNG(); await fs.writeFile(path.join(evidence,name+'.png'),bytes); result.frames.push(name+'.png') }
async function viewport(width,height){ await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}); await paint() }
async function pending(){
 for(const [width,height,theme] of [[1100,760,'dark'],[720,640,'light']]){
  await viewport(width,height); await call(theme => uiSourceCraft.pending(true,theme),theme)
  await wait(() => document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-interaction')); await paint()
  const facts=await call(() => { const pane=document.querySelector('[data-workbench-region-id="result-input-owner"]'),body=pane.querySelector('.agent-body'),source=body.querySelector('.agent-interaction-source'),terminal=body.querySelector('.agent-terminal-stage');return {body:body.clientHeight,source:source.clientHeight,scroll:source.scrollHeight,terminal:terminal.clientHeight,overflow:getComputedStyle(source).overflowY,control:uiSourceCraft.facts().sessions[0].control} })
  assert.equal(facts.overflow,'auto','Actual request wrapper scrolls'); assert.ok(facts.source<=Math.min(320,facts.body*.55)+2,'Long request stays within its own grid track');assert.ok(facts.scroll>facts.source,'Original long request scrolls internally');assert.ok(facts.terminal>0,'Original terminal retains visible height')
  await call(() => {const e=document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-interaction-source');e.scrollTop=e.scrollHeight}); await paint()
  assert.equal(await call(()=>{const e=document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-interaction-source');return e.scrollTop+e.clientHeight>=e.scrollHeight-2}),true,'Last original decision remains reachable')
  result.scenarios.push({kind:'long-pending',width,height,theme,facts});await frame('pending-'+width+'-'+theme)
  await call(theme=>uiSourceCraft.pending(false,theme),theme);await paint()
  const short=await call(()=>{const e=document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-interaction-source');return {height:e.clientHeight,scroll:e.scrollHeight}})
  assert.ok(short.height<=Math.min(320,facts.body*.55)+2);result.scenarios.push({kind:'short-pending',short});await frame('short-'+width+'-'+theme)
 }
}
async function sources(){
 for(const [width,height,theme] of [[900,680,'dark'],[360,640,'light']]){
  await viewport(width,height);await call(theme=>uiSourceCraft.sources(theme),theme);await paint()
  const facts=await call(()=>{const file=document.querySelector('.conversation-resource-file'),protocol=document.querySelector('.conversation-protocol');return {display:getComputedStyle(file).display,radius:protocol?getComputedStyle(protocol).borderRadius:null,expectedRadius:getComputedStyle(document.documentElement).getPropertyValue('--radius-sm').trim(),client:file.clientWidth,scroll:file.scrollWidth}})
  assert.equal(facts.display,'grid','Desktop imports the real shared file stylesheet');assert.equal(facts.radius,facts.expectedRadius,'Shared protocol consumes the existing small radius');assert.equal(facts.client,facts.scroll,'Original file row fits narrow reading surface')
  await call(()=>document.querySelector('.conversation-resource-file__download').click());await paint()
  assert.equal(await call(()=>document.querySelector('.conversation-resource-file__metadata')?.textContent.includes('14 bytes')),true,'Original file response completes without an identity error');assert.ok(result.downloads.length>0,'Original download reaches the browser without writing user files');assert.equal(await call(()=>uiSourceCraft.reads.length>0),true,'Original download reaches original resource reader')
  assert.equal(await call(()=>{const q=uiSourceCraft.reads.at(-1);return q.recordId==='original-file-record'&&q.expectedReference==='original-recorded-file'&&q.representation==='file'}),true,'Original resource identity and representation remain exact')
  await call(()=>{document.querySelector('.conversation-resource-file__reference').open=true;document.querySelector('[data-channel-quote]').open=true});await paint()
  result.scenarios.push({kind:'sources',width,height,theme,facts});await frame('sources-'+width+'-'+theme)
 }
}
app.whenReady().then(async()=>{try{await fs.mkdir(evidence,{recursive:true});win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{sandbox:false,backgroundThrottling:false}});result.downloads=[];win.webContents.session.on('will-download',(event,item)=>{result.downloads.push({name:item.getFilename(),url:item.getURL()});event.preventDefault()});await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await wait(()=>!!window.uiSourceCraft);if(mode==='pending')await pending();else await sources();result.passed=true}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win)await frame('failure')}finally{await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}})
