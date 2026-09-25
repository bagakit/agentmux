const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, root, evidence, proof = 'complete'] = process.argv.slice(2)
app.setPath('userData', path.join(root, 'user-data')); app.setPath('sessionData', path.join(root, 'session-data'))
let win
const report = { passed: false, scenarios: [], frames: [], userRunTouched: false }
const evaluate = source => win.webContents.executeJavaScript(source)
const surface = `(document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface') ?? document.querySelector('.agent-surface'))`
const track = `${surface}.querySelector('.terminal-service-window')`
const trigger = `${track}?.querySelector('.service-disclosure__trigger')`
const panel = `${track}?.querySelector('[popover]')`
const textarea = `${surface}.querySelector('.xterm-helper-textarea')`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(expression, limit = 5000) {
  const end = Date.now() + limit
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(30) }
  assert.fail('Actual Renderer fact absent: ' + expression)
}
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await delay(75) }
async function click(expression) {
  const point = await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Actual control missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type,...point,button:'left',clickCount:1 })
}
async function key(key, text) {
  for (const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type,key,code:key==='Escape'?'Escape':'Key'+key.toUpperCase(),windowsVirtualKeyCode:key==='Escape'?27:key.toUpperCase().charCodeAt(0),...(type==='keyDown'&&text?{text,unmodifiedText:text}:{}) })
}
async function typed(text) {
  await evaluate(`${textarea}.focus()`)
  const before = await evaluate('terminalNotice.facts().writes.length')
  for (const letter of text) await key(letter,letter)
  await paint()
  const writes = await evaluate('terminalNotice.facts().writes.slice('+before+')')
  assert.ok(writes.length > 0,'Actual trusted Terminal keyboard reaches sessions.write')
  assert.equal(writes.map(i=>i.data).join(''),text,'Original Terminal input bytes remain exact')
  assert.ok(writes[0].control.agentSessionId,'Input retains an actual Agent target')
  const events = await evaluate('terminalNotice.facts().inputs.filter(i=>i.type==="keydown"&&i.terminal)')
  assert.ok(events.length > 0); assert.equal(events.at(-1).trusted,true)
}
async function facts() {
  return evaluate(`(()=>{const s=${surface},t=${track},r=s.querySelector('.terminal-view__xterm').getBoundingClientRect();return{
    terminal:terminalNotice.terminal(),height:r.height,width:r.width,trackHeight:t?.getBoundingClientRect().height??0,
    focusedTerminal:document.activeElement===${textarea},unread:t?.dataset.unread??null,nativeOpen:${panel}?.matches(':popover-open')??false,
    count:t?.querySelectorAll('.service-window').length??0,identity:terminalNotice.facts(),caption:t?.querySelector('.service-disclosure__summary')?.textContent??null}})()`)
}
async function frame(width,name) {
  const file = `${width}-${name}.png`, png=(await win.webContents.capturePage()).toPNG()
  assert.ok(png.length>0);await fs.writeFile(path.join(evidence,file),png);report.frames.push({width,name,file})
}
async function open() { await click(trigger);await wait(`${panel}.matches(':popover-open')`);await wait('terminalNotice.facts().nativeOverlays===1') }
async function folded() { await wait(`!${panel}.matches(':popover-open') && terminalNotice.facts().nativeOverlays===0`) }
function retained(before,after) {
  assert.equal(after.terminal.id,before.terminal.id,'Disclosure retains the original actual xterm')
  assert.equal(after.height,before.height,'Closing details keeps Terminal geometry stable')
  assert.equal(after.terminal.rows,before.terminal.rows,'Closing details keeps actual xterm rows')
  for(const field of ['sessions','tab','layout','drafts']) assert.deepEqual(after.identity[field],before.identity[field],'Original '+field+' stays unchanged')
}
async function scene(width,mode,readonly=false) {
  report.stage={width,mode,readonly}
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:readonly?width:2*width+1,height:740,deviceScaleFactor:1,mobile:false})
  await evaluate(`terminalNotice.seed(${JSON.stringify(mode)},${readonly})`)
  await wait(`Boolean(${textarea})`)
  await wait(`!${surface}.querySelector('.terminal-view__xterm--hydrating')`,mode==='reveal'?9000:5000)
  if(mode==='history') { await evaluate('terminalNotice.historyFailure()');await wait(`${track}?.textContent.includes('Retained history read unconfirmed')`) }
  await wait(`Boolean(${trigger})`)
  await paint()
  if(mode==='attachment') {
    await open();await click(`Array.from(${panel}.querySelectorAll('button')).find(b=>b.textContent==='Refresh observation')`)
    await wait(`${track}.textContent.includes('Private observation failure')`);await key('Escape');await folded()
  }
  await click(`${surface}.querySelector('.terminal-view__xterm')`);await evaluate(`${textarea}.focus()`);const before=await facts()
  assert.ok(before.height>400,'Compact notice leaves a real Terminal reading/input area')
  assert.ok(before.terminal.rows>15,'Actual xterm still has a nonempty usable grid')
  assert.ok(before.trackHeight<=30,'Six passive facts share one compact track')
  assert.equal(before.nativeOpen,false,'Passive notices never automatically open their details')
  const expected={continuation:'Restoring terminal state',geometry:'Confirming replay geometry',viewport:'Synchronizing terminal size',session:'Checking terminal capabilities',attachment:'Private observation failure',reveal:'Restoring this terminal',gap:'Earlier scrollback is unavailable',history:'Retained history read unconfirmed',all:'Restoring terminal state'}[mode]
  assert.ok(await evaluate(`${track}.textContent.includes(${JSON.stringify(expected)})`),'Production TerminalView wires the actual '+mode+' fact')
  if(!readonly&&mode!=='reveal') await typed('a')
  if(mode==='all'||mode==='continuation'||readonly) await frame(width,(readonly?'readonly-':'')+mode+'-compact')
  await open();await paint()
  const originalText=await evaluate(`${panel}.innerText`)
  assert.ok(originalText.length>80,'Original diagnostic and recovery text remain nonempty')
  assert.ok(await evaluate(`${panel}.getBoundingClientRect().height<=innerHeight*.71`),'Details have a bounded actual viewport')
  const bounds = await evaluate(`(()=>{const p=${panel}.getBoundingClientRect(),s=${surface}.getBoundingClientRect(),t=${surface}.querySelector('.terminal-view__xterm').getBoundingClientRect(),c=${surface}.querySelector('.composer')?.getBoundingClientRect();return {panel:{left:p.left,right:p.right,bottom:p.bottom},owner:{left:s.left,right:s.right},terminalBottom:t.bottom,composerTop:c?.top??null}})()`)
  assert.ok(bounds.panel.left>=bounds.owner.left && bounds.panel.right<=bounds.owner.right,'Details stay inside their original Region')
  assert.ok(bounds.panel.bottom<=bounds.terminalBottom-28,'Details keep the original Terminal input line visible')
  if(bounds.composerTop!==null) assert.ok(bounds.panel.bottom<=bounds.composerTop,'Details keep the entire unsent Composer draft visible')
  if(mode==='all'||mode==='continuation'||readonly) await frame(width,(readonly?'readonly-':'')+mode+'-details')
  await click(`${panel}.querySelector('.service-disclosure__close')`);await folded();await paint()
  const after=await facts();retained(before,after)
  assert.equal(after.caption,null,'Collapse acknowledges the problem without deleting its facts')
  assert.ok(after.count>0,'The original failure/unknown facts remain available after collapse')
  assert.equal(after.focusedTerminal,true,'Collapse returns to the original Terminal caret')
  if(!readonly&&mode!=='reveal') await typed('b')
  await open();assert.ok(await evaluate(`${panel}.innerText.length>80`),'Review reopens full original facts')
  await key('Escape');await folded()
  if(mode==='reveal') {
    await evaluate('terminalNotice.releaseReveal()');await wait(`!${track}`);await typed('r')
  }
  if(readonly) {
    const writes=await evaluate('terminalNotice.facts().writes.length');await evaluate(`${textarea}.focus()`);await key('z','z');await paint()
    assert.equal(await evaluate('terminalNotice.facts().writes.length'),writes,'Read-only remains read-only while disclosure is escapable')
  }
  report.scenarios.push({width,mode,readonly,before,after,completeText:originalText})
}
async function identity() {
  await evaluate("terminalNotice.seed('session')");await wait(`Boolean(${trigger})`);await wait(`!${surface}.querySelector('.terminal-view__xterm--hydrating')`);await paint()
  await click(`${track}.querySelector('.service-disclosure__close')`);await paint()
  await evaluate('terminalNotice.observed(true)');await paint();assert.equal((await facts()).caption,null,'Observation metadata alone cannot reopen a collapsed notice')
  await evaluate('terminalNotice.visible(false)');await paint();await evaluate('terminalNotice.visible(true)');await paint()
  assert.equal((await facts()).caption,null,'Hidden/remounted work surface retains its receipt')
  await evaluate('terminalNotice.newCause()');await paint();assert.ok((await facts()).caption,'A real new cause remains discoverable')
  await open();await evaluate('terminalNotice.newRun()');await paint();await folded()
  assert.ok((await facts()).caption,'Closing an old Run popover cannot acknowledge an unseen new Run')
  await click(`${track}.querySelector('.service-disclosure__close')`);await evaluate('terminalNotice.newRun()');await paint()
  assert.ok((await facts()).caption,'A new Run is isolated from the old acknowledgement')
  await evaluate("terminalNotice.seed('session')");await wait(`Boolean(${trigger})`);await paint()
  await click(`${track}.querySelector('.service-disclosure__close')`)
  await evaluate('terminalNotice.observed(false)');await paint();assert.equal(await evaluate(`Boolean(${track})`),false,'All facts resolved allocates no empty notice track')
  await evaluate('terminalNotice.observed(true)');await paint();assert.ok((await facts()).caption,'Resolved then recurring notice is discoverable again')
  await open();await evaluate('terminalNotice.visible(false)');await wait('terminalNotice.facts().nativeOverlays===0')
  await evaluate('terminalNotice.visible(true)');await paint();assert.equal((await facts()).nativeOpen,false,'Hidden Tab releases the native disclosure')
  report.identity={passed:true}
}
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(evidence,{recursive:true});win=new BrowserWindow({show:false,width:1281,height:740,webPreferences:{backgroundThrottling:false,sandbox:false}})
    await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await wait('Boolean(window.terminalNotice)')
    for(const width of proof==='complete'?[640,320]:[320]) {
      for(const mode of proof==='gap'?['gap']:proof==='identity'?['session']:proof!=='complete'?['all']:['continuation','geometry','viewport','session','attachment','reveal','gap','history','all']) await scene(width,mode)
    }
    if(proof==='complete') await scene(320,'continuation',true); if(proof==='complete'||proof==='identity') await identity()
    assert.ok(report.scenarios.length>0);report.passed=true
  } catch(error) {report.failure={name:error.name,message:error.message,stack:error.stack,stage:report.stage}}
  finally {await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.passed?0:1)}
})
