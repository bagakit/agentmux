const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const { appendFileSync } = require('node:fs')
const [html, output, profile] = process.argv.slice(2)
app.setPath('userData', path.join(output, 'profile'))
let window
const result = { passed: false, profile, userRunTouched: false, scope: 'actual production Workbench/Region/TerminalView with controlled preview API, not native delivery', frames: [], facts: [], console: [] }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const evaluate = expression => window.webContents.executeJavaScript(expression)
const cards = "document.querySelector('.composer-pending:not([hidden])')"
const row = i => `${cards}.querySelector('[data-queue-index="${i}"]')`
async function wait(expression) {
  for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await sleep(25) }
  throw Error('Renderer predicate failed: ' + expression)
}
async function frame(name) {
  const image = await window.webContents.capturePage()
  const file = name + '.png'; await fs.writeFile(path.join(output, file), image.toPNG()); result.frames.push({ name, file })
}
async function facts(name) {
  const value = await evaluate(`(()=>{const surface=${cards},list=surface.querySelector('ol'),rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return {name:${JSON.stringify(name)},surface:rect(surface),list:rect(list),pivot:getComputedStyle(list).getPropertyValue('--queue-pivot-y'),scrollTop:list.scrollTop,cards:[...list.children].map(n=>({id:n.dataset.operationId,rect:rect(n),selected:n.dataset.selected,transform:getComputedStyle(n).transform,opacity:Number(getComputedStyle(n).opacity),cachedY:parseFloat(n.style.getPropertyValue('--queue-offset-y')),actualY:n.offsetTop,cachedHeight:parseFloat(n.style.getPropertyValue('--queue-card-height')),actualHeight:n.offsetHeight,editable:!n.querySelector('.composer-pending__preview')?.disabled,ordinal:n.querySelector('.composer-pending__more').textContent,underline:getComputedStyle(n.querySelector('.composer-pending__preview')??n).textDecorationLine})),draft:document.querySelector('[data-workbench-region-id="result-input-owner"] .composer [role=textbox]')?.textContent,ancestor:[...surface.parentElement.parentElement.children].length}})()`)
  result.facts.push(value); return value
}
async function pointer(i, click = false) {
  const p = await evaluate(`(()=>{const n=${row(i)}.querySelector('.composer-pending__preview'),r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
  if (click) for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 })
}
async function editorActions(i, name) {
  const actions = await evaluate(`(()=>{const n=${row(i)},list=n.parentElement,r=list.getBoundingClientRect();return [...n.querySelectorAll('.composer-queued-editor__actions button, .composer-pending__copy')].map(b=>{const p=b.getBoundingClientRect(),hit=document.elementFromPoint(p.x+p.width/2,p.y+p.height/2);return {label:b.getAttribute('aria-label')??b.textContent,visible:p.top>=r.top&&p.bottom<=r.bottom&&p.left>=r.left&&p.right<=r.right,hit:hit===b||b.contains(hit),disabled:b.disabled}})})()`)
  assert.equal(actions.length,3)
  for(const a of actions){assert.equal(a.visible,true,name+' '+a.label+' is fully visible');assert.equal(a.hit,true,name+' '+a.label+' is directly hittable')}
  result.facts.push({name,editorActions:actions})
}
async function run() {
  await app.whenReady(); await fs.mkdir(output, {recursive:true})
  const stage=name=>appendFileSync(path.join(output,'stages.jsonl'),JSON.stringify({name,time:Date.now()})+'\n')
  stage('app-ready')
  window = new BrowserWindow({width: profile.includes('narrow') ? 760 : 1400,height:800,show:false,webPreferences:{backgroundThrottling:false}})
  window.webContents.on('console-message', details => { if (result.console.length < 40) result.console.push({message:details.message,sourceId:details.sourceId,lineNumber:details.lineNumber}) })
  window.webContents.debugger.attach('1.3')
  stage('window-created')
  await window.loadFile(html)
  stage('file-loaded')
  if(profile.startsWith('coarse')){
    await window.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
    stage('touch-enabled')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'hover',value:'none'},{name:'pointer',value:'coarse'}]})
    stage('media-set')
  }
  await wait("Boolean(window.actualCards && window.resultReadyTerminals?.some(t=>!t.disposed) && document.querySelector('.composer'))")
  assert.equal(await evaluate("CSS.supports('opacity','calc(1 - 2px / 20px)')"),true,'Electron supports bounded CSS distance arithmetic')
  const theme=profile==='wide-dark'?'dark':'light'
  await evaluate(`actualCards.seed(${JSON.stringify(theme)},1)`)
  await wait(`${cards}?.dataset.positioned==='true' && ${cards}.querySelectorAll('li').length===1`);await sleep(180)
  const single=await facts('single');assert.equal(single.cards[0].ordinal,'1/1');assert.equal(single.cards[0].rect.right,single.surface.right,'Single card keeps the shared right edge');await frame('whole-window-single')
  await evaluate(`actualCards.seed(${JSON.stringify(theme)})`)
  await wait(`${cards}?.dataset.positioned==='true' && ${cards}.querySelectorAll('li').length===6`)
  await sleep(220)
  const initial = await facts('initial'); await frame('whole-window-idle')
  assert.equal(initial.cards.length,6)
  for (const [i,c] of initial.cards.entries()) {
    assert.equal(c.ordinal,`${i+1}/6`)
    assert.ok(c.rect.x >= initial.list.x - 1 && c.rect.right <= initial.list.right + 1,'Full projected card within scrollport')
  }
  assert.equal(initial.cards[2].editable,false);assert.equal(initial.cards[1].editable,true);assert.equal(initial.cards[5].editable,true)
  result.environment=await evaluate(`(()=>{const region=document.querySelector('[data-workbench-region-id="result-input-owner"]'),tool=region.querySelector('.composer'),rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return{viewport:{width:innerWidth,height:innerHeight,scale:devicePixelRatio},region:rect(region),tool:rect(tool),hover:matchMedia('(hover:hover)').matches,coarse:matchMedia('(pointer:coarse)').matches,cardBackground:getComputedStyle(${row(0)}).backgroundColor}})()`)
  assert.equal(initial.surface.right,result.environment.tool.right,'Card stack stays aligned with the Message Tool right edge')
  for(const c of initial.cards)assert.ok(Math.abs(c.rect.right-result.environment.tool.right)<1,'Every card keeps the shared right edge')
  if(profile.startsWith('coarse')){
    assert.equal(result.environment.hover,false);assert.equal(result.environment.coarse,true)
    for(const c of initial.cards)assert.equal(c.opacity,1,'Touch crystal does not depend on pointer distance')
    result.passed=true;return
  }
  const before = initial.cards[1].transform
  await pointer(1)
  await sleep(32);const middle=await facts('hover-middle');await frame('hover-middle')
  await sleep(220);const settled=await facts('hover-settled');await frame('whole-window-near')
  assert.equal(settled.cards[1].selected,'true');assert.equal(settled.cards[1].opacity,1)
  assert.equal(settled.cards[1].underline,'underline')
  assert.notEqual(middle.cards[1].transform,before);assert.notEqual(middle.cards[1].transform,settled.cards[1].transform,'Hover has an intermediate matrix')
  await pointer(1,true);await wait(`${row(1)}.dataset.editing==='true'`);await sleep(200);await frame('whole-window-nonfirst-edit')
  const editing=await facts('nonfirst-edit')
  await editorActions(1,'nonfirst-editor-actions')
  for(const c of editing.cards){assert.equal(c.cachedY,c.actualY);assert.equal(c.cachedHeight,c.actualHeight)}
  await evaluate('actualCards.rejectSave()')
  const savePoint=await evaluate(`(()=>{const r=${row(1)}.querySelector('[aria-label="保存待发消息"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for(const type of ['mousePressed','mouseReleased'])await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...savePoint,button:'left',clickCount:1})
  await wait(`${row(1)}.querySelector('[role=alert]')`);await sleep(180)
  const failedEdit=await facts('edit-local-save-error')
  await editorActions(1,'error-editor-actions')
  for(const c of failedEdit.cards){assert.equal(c.cachedY,c.actualY);assert.equal(c.cachedHeight,c.actualHeight)}
  await frame('whole-window-edit-error')
  await evaluate('actualCards.locked()');await wait(`${row(1)}.querySelector('[role=status]')`);await sleep(160)
  const locked=await facts('edit-locked-layout')
  await editorActions(1,'locked-editor-actions')
  for(const c of locked.cards){assert.equal(c.cachedY,c.actualY);assert.equal(c.cachedHeight,c.actualHeight)}
  await frame('whole-window-locked-edit')
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await evaluate(`actualCards.seed(${JSON.stringify(theme)})`);await sleep(220)
  const direct=await evaluate(`(()=>{const n=${row(5)}.querySelector('.composer-pending__preview'),r=n.getBoundingClientRect(),p={x:r.x+r.width/2,y:r.y+r.height/2};return{point:p,id:${row(5)}.dataset.operationId,hit:document.elementFromPoint(p.x,p.y)?.closest('li')?.dataset.operationId}})()`)
  assert.equal(direct.id,direct.hit,'Unselected last card is directly hittable')
  for(const type of ['mousePressed','mouseReleased'])await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...direct.point,button:'left',clickCount:1})
  await wait(`${row(5)}.dataset.editing==='true'`);await sleep(180);await frame('whole-window-last-direct-edit')
  await editorActions(5,'last-editor-actions')
  assert.equal(await evaluate(`${row(5)}.dataset.operationId`),direct.id)
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await evaluate(`actualCards.seed(${JSON.stringify(theme)}); actualCards.footer()`);await sleep(250)
  const footer=await evaluate(`(()=>{const n=document.querySelector('[data-workbench-region-id="result-input-owner"] .xterm'),r=n.querySelector('.xterm-screen').getBoundingClientRect(),t=resultReady.terminal();return{top:r.top+(t.rows-2)*r.height/t.rows,line:t.visibleLines[t.rows-2]}})()`)
  assert.ok(footer.line.includes('warnings'),'Actual mounted terminal bottom status text exists')
  const protectedFooter=await facts('footer-protected');await frame('whole-window-footer')
  assert.ok(protectedFooter.surface.bottom<=footer.top+1,'Actual occupied footer remains unobstructed')
  await evaluate(`actualCards.seed(${JSON.stringify(theme)},100)`);await wait(`${cards}.querySelectorAll('li').length===100`);await sleep(200)
  const scrollBefore=await facts('scroll-before')
  const p=await evaluate(`(()=>{const r=${cards}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:90})
  await sleep(32);const scrollMiddle=await facts('scroll-middle');await frame('scroll-middle')
  await sleep(220);const scrollSettled=await facts('scroll-settled');await frame('whole-window-scroll')
  assert.ok(scrollSettled.scrollTop>scrollBefore.scrollTop)
  const moving=scrollSettled.cards.findIndex((c,i)=>c.transform!==scrollBefore.cards[i].transform && c.selected!=='true')
  assert.ok(moving>=0);assert.notEqual(scrollMiddle.cards[moving].transform,scrollSettled.cards[moving].transform,'Wheel has an intermediate depth matrix')
  for(const target of [1300,99999]){
    await evaluate(`${cards}.querySelector('ol').scrollTop=${target}`);await sleep(220)
    const bounded=await facts('long-queue-'+target)
    for(const c of bounded.cards)assert.ok(Number.isFinite(c.rect.x)&&c.rect.width>0&&c.rect.width<=bounded.list.width+1,'Offscreen projection has no perspective singularity')
    await frame('whole-window-scroll-'+target)
  }
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await sleep(50);const reduced=await facts('reduced-before')
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:90});await sleep(100)
  const reducedAfter=await facts('reduced-after')
  for(const [i,c]of reduced.cards.entries())assert.equal(c.transform,reducedAfter.cards[i].transform,'Reduced motion keeps static depth')
  result.passed=true
}
run().catch(error=>{result.failure={message:error.message,stack:error.stack};process.exitCode=1}).finally(async()=>{
  if(window&&!window.isDestroyed())result.dom=await evaluate("({body:document.body.innerText.slice(0,1000),probe:Boolean(window.actualCards)})").catch(error=>({error:error.message}))
  await fs.writeFile(path.join(output,'actual.json'),JSON.stringify(result,null,2))
  if(window&&!window.isDestroyed())window.destroy();app.exit(result.passed?0:1)
})
