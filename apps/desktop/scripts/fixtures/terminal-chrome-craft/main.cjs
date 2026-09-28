const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, root, evidence, proof] = process.argv.slice(2)
app.setPath('userData', path.join(root, 'user-data')); app.setPath('sessionData', path.join(root, 'session-data'))
let win
const report = { passed: false, frames: [], scenarios: [], userRunTouched: false }
const evaluate = source => win.webContents.executeJavaScript(source)
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(expression) {
  const end = Date.now() + 9000
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(30) }
  assert.fail('Actual Renderer fact absent: ' + expression)
}
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await delay(100) }
async function viewport(width,height) {
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
  await paint()
}
async function pointer(expression,button='left',hover=false) {
  const point=await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Actual control missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+Math.min(6,r.height/2)}})()`)
  for(const type of hover?['mouseMoved']:['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:hover?'none':button,clickCount:1})
  await paint()
}
async function escape() { for(const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await paint() }
async function frame(name,width) {
  const file=name+'.png', png=(await win.webContents.capturePage()).toPNG()
  assert.ok(png.length>0);await fs.writeFile(path.join(evidence,file),png);report.frames.push({name,width,file})
}
async function terminalFacts() {
  return evaluate(`(()=>{const s=${surface},t=s.querySelector('.terminal-view__xterm'),b=t.getBoundingClientRect(),m=s.querySelector('.agent-region-header__more'),c=s.closest('.workbench-region').querySelector(':scope > .workbench-region__close');return{terminal:terminalNotice.terminal(),box:{x:b.x,y:b.y,width:b.width,height:b.height},resizes:terminalNotice.facts().resizes.length,state:terminalNotice.facts(),buttons:[m,c].map(e=>{const r=e.getBoundingClientRect(),a=getComputedStyle(e),p=getComputedStyle(e,'::before');return{box:{x:r.x,y:r.y,width:r.width,height:r.height},background:a.backgroundColor,paintHeight:p.height}})}})()`)
}
function stable(before,after) {
  assert.equal(after.terminal.id,before.terminal.id,'The original actual xterm is retained')
  assert.deepEqual(after.box,before.box,'Notice and hover keep the original Terminal viewport')
  assert.equal(after.terminal.rows,before.terminal.rows);assert.equal(after.terminal.cols,before.terminal.cols)
  assert.equal(after.resizes,before.resizes,'Chrome does not issue a Runtime resize')
  for(const key of ['sessions','tab','layout','drafts']) assert.deepEqual(after.state[key],before.state[key],'Original '+key+' retained')
}
async function terminalScene(width) {
  report.stage={proof:'terminal',width}
  await viewport(width*2+1,740); await evaluate(`terminalChrome.workbench();terminalNotice.seed('healthy')`)
  await wait(`Boolean(${surface}?.querySelector('.xterm-helper-textarea')) && !${surface}.querySelector('.terminal-view__xterm--hydrating')`);await delay(350);await paint()
  const before=await terminalFacts()
  assert.equal(before.buttons.length,2); assert.ok(before.terminal.rows>15)
  for(const selector of [`.agent-region-header__more`,`:scope > .workbench-region__close`]) {
    const target=selector.startsWith(':scope')?`${surface}.closest('.workbench-region').querySelector(${JSON.stringify(selector)})`:`${surface}.querySelector(${JSON.stringify(selector)})`
    await pointer(target,'left',true);const hovered=await terminalFacts();stable(before,hovered)
    assert.deepEqual(hovered.buttons.map(b=>b.box),before.buttons.map(b=>b.box),'Hover retains each control hitbox')
    for(const button of hovered.buttons) {assert.equal(button.background,'rgba(0, 0, 0, 0)','Hover preserves the transparent hitbox');assert.equal(button.paintHeight,'13px','Hover paint remains inside the quiet glyph band')}
  }
  await evaluate('terminalNotice.observed(true)');await wait(`Boolean(${surface}.querySelector('.terminal-service-window'))`);await paint()
  const notified=await terminalFacts();stable(before,notified)
  assert.equal(await evaluate(`getComputedStyle(${surface}.querySelector('.terminal-service-window')).position`),'absolute','Notices stay outside vertical flow')
  await frame('terminal-'+width+'-notice',width)
  const trigger=`${surface}.querySelector('.terminal-service-window .service-disclosure__trigger')`
  await pointer(trigger);await wait(`Boolean(${surface}.querySelector('[popover]:popover-open'))`)
  assert.ok(await evaluate(`${surface}.querySelector('[popover]').innerText.length>80`),'Complete original recovery facts remain available')
  await frame('terminal-'+width+'-details',width);await escape();stable(before,await terminalFacts())
  await evaluate('terminalChrome.alternate()');await wait(`terminalNotice.terminal().visibleLines.some(s=>s.includes('Live full-screen application'))`)
  assert.equal(await evaluate(`Boolean(${surface}.querySelector('.terminal-replay-gap--compact'))`),false,'Full-screen history has no permanent central banner')
  await pointer(`${surface}.querySelector('.terminal-view__xterm')`,'right')
  await wait(`Boolean(document.querySelector('.terminal-context-menu [role="note"]'))`)
  const notes=await evaluate(`[...document.querySelectorAll('.terminal-context-menu [role="note"]')].map(e=>e.textContent)`)
  assert.ok(notes.length>0); assert.ok(notes.some(n=>n.includes('The full-screen buffer has no terminal scrollback')),'The actual buffer boundary is available on demand')
  await frame('terminal-'+width+'-buffer-menu',width);await escape()
  const writes=await evaluate('terminalNotice.facts().writes.length')
  await evaluate(`${surface}.querySelector('.xterm-helper-textarea').focus()`)
  for(const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'q',code:'KeyQ',windowsVirtualKeyCode:81,...(type==='keyDown'?{text:'q'}:{})})
  await wait('terminalNotice.facts().writes.length>'+writes)
  assert.equal(await evaluate('terminalNotice.facts().writes.at(-1).data'),'q','Healthy Terminal still accepts actual trusted input')
  await pointer(`${surface}.querySelector('.agent-region-header__more')`)
  await wait(`Boolean(document.querySelector('.agent-region-menu'))`)
  assert.equal(await evaluate(`[...document.querySelectorAll('.agent-region-menu [role="menuitem"]')].filter(e=>e.textContent==='Conversation history').length`),1,'The original unique history entry remains reachable')
  await escape();report.scenarios.push({width,before,notified,notes,passed:true})
}
async function loadingFacts() {
  return evaluate(`(()=>{const s=document.querySelector('#loading-root .full-page-loading'),stage=s.querySelector('.full-page-loading__stage'),art=s.querySelector('img'),r=s.getBoundingClientRect(),b=stage.getBoundingClientRect(),moving=[...s.querySelectorAll('.full-page-loading__art,.full-page-loading__light,.full-page-loading__activity i')];return{appearance:document.documentElement.dataset.appearance,colorScheme:getComputedStyle(document.documentElement).colorScheme,phase:s.dataset.loadingPhase,busy:s.getAttribute('aria-busy'),role:s.getAttribute('role'),artLoaded:art.complete&&art.naturalWidth>0,artWidth:art.getBoundingClientRect().width,atmosphereWidth:s.querySelector('.full-page-loading__atmosphere').getBoundingClientRect().width,stage:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},surface:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth,clientHeight:stage.clientHeight,scrollHeight:stage.scrollHeight,activity:s.querySelectorAll('.full-page-loading__activity').length,animations:moving.map(e=>({name:getComputedStyle(e).animationName,state:getComputedStyle(e).animationPlayState})),text:s.innerText}})()`)
}
async function recoveryScenes() {
  for(const [width,height,phase,scope,theme,reduced] of [
    [1440,900,'loading','app','dark',false],[1440,900,'recovering','app','light',false],
    [720,420,'parked','region','dark',false],[320,360,'parked','region','light',false],
    [320,230,'failed','region','dark',false],[420,540,'connecting','region','dark',false],
    [720,420,'recovering','region','dark',true]]) {
    report.stage={width,height,phase,theme,reduced};await viewport(width,height)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]})
    await evaluate(`terminalChrome.show(${JSON.stringify(phase)},${JSON.stringify(scope)},${JSON.stringify(theme)})`)
    await wait(`document.querySelector('#loading-root img')?.complete`);await paint()
    const facts=await loadingFacts();assert.equal(facts.appearance,theme);assert.equal(facts.colorScheme,theme,'The actual product theme is applied'); assert.equal(facts.artLoaded,true,'The shared actual brand image is loaded');assert.equal(facts.atmosphereWidth,width,'Atmosphere fills the actual surface');assert.ok(facts.artWidth>=width&&facts.artWidth<=width*1.08,'Animated image covers the surface with a bounded drift')
    assert.ok(facts.text.length>50);assert.ok(facts.stage.top>=0&&facts.stage.bottom<=height+1,'Text stage stays inside the short viewport')
    assert.ok(facts.stage.left>=0&&facts.stage.right<=width+1);assert.equal(facts.scrollWidth,facts.clientWidth,'Long content wraps without horizontal overflow')
    assert.ok(facts.animations.length>=2,'The actual decorative nodes are nonempty')
    if(phase==='parked'||phase==='failed') {
      assert.equal(facts.busy,'false','Parked and failed states are not busy');assert.equal(facts.activity,0,'Parked states have no false busy signal')
      assert.ok(facts.animations.every(a=>a.name==='none'),'Parked and failed scenery stays still')
    } else { assert.equal(facts.busy,'true');assert.equal(facts.activity,1);if(!reduced)assert.ok(facts.animations.some(a=>a.name!=='none'),'Busy phases have actual atmospheric motion') }
    if(reduced) assert.ok(facts.animations.every(a=>a.name==='none'),'Reduced motion renders a complete static surface')
    if(phase==='failed') {
      await evaluate(`document.querySelector('#loading-root button').scrollIntoView({block:'nearest'})`);await paint()
      await pointer(`document.querySelector('#loading-root button')`);assert.equal(await evaluate('window.recoveryClicks'),1,'The original caller action is still clickable in a short surface')
    }
    await frame(`recovery-${width}-${phase}-${theme}${reduced?'-reduced':''}`,width)
    if(!reduced&&phase==='loading') {
      await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))`);await paint()
      const hidden=await loadingFacts();assert.ok(hidden.animations.length>0);assert.ok(hidden.animations.every(a=>a.state==='paused'),'Hidden document pauses every actual animation')
      await evaluate(`delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'))`)
      await evaluate(`document.getElementById('loading-root').inert=true`);await paint()
      const parkedView=await loadingFacts();assert.ok(parkedView.animations.length>0);assert.ok(parkedView.animations.every(a=>a.state==='paused'),'Inert work surfaces pause every actual animation')
      await evaluate(`document.getElementById('loading-root').inert=false`)
    }
    report.scenarios.push({width,height,phase,scope,theme,reduced,facts,passed:true})
  }
  await viewport(1281,740);await evaluate(`terminalChrome.workbench();terminalNotice.seed('healthy')`);await wait(`Boolean(${surface}.querySelector('.xterm'))`)
  const before=await evaluate('terminalNotice.facts()');await evaluate('terminalChrome.park()');await wait(`Boolean(${surface}.querySelector('[data-loading-phase="parked"]'))`);await paint()
  const after=await evaluate('terminalNotice.facts()')
  for(const key of ['tab','layout','drafts']) assert.deepEqual(after[key],before[key],'Real SessionPane retains original '+key+' while parked')
  assert.equal(await evaluate(`${surface}.querySelector('[data-loading-phase="parked"]').getAttribute('aria-busy')`),'false')
  await frame('recovery-actual-session-pane',640);report.parkedCaller={passed:true,before,after}
}
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(evidence,{recursive:true});win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{backgroundThrottling:false,sandbox:false}})
    await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await wait('Boolean(window.terminalChrome)')
    if(proof==='recovery') await recoveryScenes();else for(const width of [640,320])await terminalScene(width)
    assert.ok(report.scenarios.length>0);report.passed=true
  } catch(error) {report.failure={name:error.name,message:error.message,stack:error.stack,stage:report.stage}}
  finally {await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.passed?0:1)}
})
