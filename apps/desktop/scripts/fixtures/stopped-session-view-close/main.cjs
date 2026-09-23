const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto')
const [html, privateRoot, evidence, phase] = process.argv.slice(2)
const storage = path.join(privateRoot, 'user-data')
app.setPath('userData', storage); app.setPath('sessionData', storage)
const result = { schema: 'agentmux.stopped-view-private-render.v1', phase, pid: process.pid, passed: false, frames: [], consoleErrors: [], captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false }
let win, quitting = false
const evaluate = expression => win.webContents.executeJavaScript(expression), delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(expression, budget = 10000) { const end = Date.now() + budget; while (Date.now() < end) { if (await evaluate(expression)) return; await delay(25) }; throw new Error('Timed out: ' + expression) }
async function painted() { await evaluate('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()'); await delay(80) }
async function click(expression) {
 result.action=expression; await painted()
 const point=await evaluate(`(() => { const e=${expression};if(!e||e.disabled)throw Error('Missing enabled actual action');const b=e.getBoundingClientRect();if(!b.width||!b.height)throw Error('Invisible actual action');const x=b.x+b.width/2,y=b.y+b.height/2,hit=document.elementFromPoint(x,y);return{x,y,ownHit:hit===e||e.contains(hit),expectedClass:e.className,hitClass:hit?.className,innerWidth,scale:visualViewport.scale,dpr:devicePixelRatio} })()`)
 ;(result.clicks??=[]).push(point); assert.equal(point.ownHit,true,'Actual CSS hit must reach the requested close action')
 await evaluate(`window.__closePointer=[];window.addEventListener('pointerdown',e=>window.__closePointer.push({x:e.clientX,y:e.clientY,tag:e.target.tagName,class:e.target.className}),{capture:true,once:true})`)
 for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1})
 result.clicks.at(-1).pointer=await evaluate('window.__closePointer')
}
const byText = text => `[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(text)})`
const targetX = `document.querySelector('[data-workbench-tab-id="closed-target"] .workbench-tab__close')`
async function revealTargetClose() {
 const inspect = `(() => { const es=[...document.querySelectorAll('[data-workbench-tab-id="closed-target"] .workbench-tab__close')];return es.map(e=>{const box=e.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2),strip=e.closest('.workbench-tab-strip'),tabs=strip?.querySelector('.pane-tabbar__tabs'),end=strip?.querySelector('.workbench-tab-strip__nav--end');const rect=x=>x?{x:x.getBoundingClientRect().x,y:x.getBoundingClientRect().y,width:x.getBoundingClientRect().width,height:x.getBoundingClientRect().height}:null;return{box:rect(e),ownHit:hit===e||e.contains(hit),hitButton:hit?.closest('button')?.getAttribute('aria-label')??hit?.closest('button')?.title??null,strip:rect(strip),tabs:rect(tabs),scrollLeft:tabs?.scrollLeft,scrollWidth:tabs?.scrollWidth,clientWidth:tabs?.clientWidth,end:end?{disabled:end.disabled,box:rect(end)}:null,slot:e.closest('[data-workspace-id]')?.getAttribute('data-visible')}})})()`
 await painted()
 for (let step=0;step<3;step++) {
  const state=await evaluate(inspect); (result.tabReachability??=[]).push({stage:result.stage,step,state})
  assert.equal(state.length,1,'A unique actual Tab close entry must be observed')
  if (state[0].ownHit) return
  assert.ok(state[0].end&&!state[0].end.disabled,'Existing Tab-strip navigation must expose the clipped close entry')
  const left=state[0].scrollLeft
  await click(`${targetX}.closest('.workbench-tab-strip').querySelector('.workbench-tab-strip__nav--end')`)
  await wait(`${targetX}.closest('.workbench-tab-strip').querySelector('.pane-tabbar__tabs').scrollLeft>${left}`)
  await delay(400)
 }
 throw Error('Original Tab-strip navigation did not expose the real close action')
}
async function frame(width, scene) {
 await evaluate('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)})()'); await delay(100)
 const png = (await win.webContents.capturePage()).toPNG(), name = `${width}-${scene}.png`; assert.ok(png.length > 0); await fs.writeFile(path.join(evidence, name), png)
 result.frames.push({ width, scene, file: name, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), facts: await evaluate('stoppedViewClose.facts()'), dialog: await evaluate('document.querySelector("[role=dialog]")?.textContent??null'), notice: await evaluate('document.querySelector(".error-notice")?.textContent??null') })
}
function retained(facts, expected, restored = false) {
 assert.deepEqual(facts.drafts, expected.expectedDrafts); assert.deepEqual(facts.queue, { [expected.stoppedId]: [restored ? expected.restoredUnknownInput : expected.unknownInput] }); assert.deepEqual(facts.submissions, [])
 assert.ok(facts.tabs[expected.sibling]); assert.equal(facts.sessions.length, 2)
 assert.deepEqual(facts.sessions.map(s=>({id:s.id,control:s.control})),expected.sessions.map(s=>({id:s.id,control:s.control})))
}
app.on('before-quit', event => { if (!quitting) event.preventDefault() })
app.whenReady().then(async () => { try {
 await fs.mkdir(evidence, { recursive: true }); win = new BrowserWindow({ show: false, width: 1281, height: 740, webPreferences: { sandbox: false, backgroundThrottling: false } })
 win.webContents.on('console-message', detail => { if (detail.level === 'error') result.consoleErrors.push(detail.message) })
 await win.loadFile(html); win.webContents.debugger.attach('1.3'); await wait('Boolean(window.stoppedViewClose)')
 result.storage = { userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), actual: win.webContents.session.getStoragePath() }
 assert.deepEqual(result.storage, { userData: storage, sessionData: storage, actual: storage })
 const expected = await evaluate('({...stoppedViewClose, facts:undefined,show:undefined,raw:undefined,prepareQuit:undefined, sessions:stoppedViewClose.facts().sessions})')
 if (phase === 'first') {
  result.exited = await evaluate("stoppedViewClose.show('exited')")
  await revealTargetClose(); await click(targetX); await wait('!stoppedViewClose.facts().tabs[stoppedViewClose.target]')
  const closed = await evaluate('stoppedViewClose.facts()'); assert.equal(closed.records.length, 0); retained(closed, expected); assert.ok(closed.saveWarning.includes('Saving the workbench is unconfirmed')); result.exitedClosed = closed
  for (const width of [640,320]) {
   result.stage={width,step:'prepare'}; await wait('!document.querySelector("[role=dialog]")');
   await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width*2+1, height: 740, deviceScaleFactor: 1, mobile: false })
   await painted(); await evaluate("document.querySelectorAll(':popover-open').forEach(p=>p.hidePopover());stoppedViewClose.show('pending')"); await painted()
   await wait('Boolean('+targetX+')'); result.stage={width,step:'explicit-stop'}; await revealTargetClose(); await click(targetX); await wait(`Boolean(${byText('Stop & Close')})`); await click(byText('Stop & Close'))
   await wait('stoppedViewClose.facts().closing.length===0&&stoppedViewClose.facts().error?.includes("close result is unknown")',8000)
   const unknown = await evaluate('stoppedViewClose.facts()'); assert.equal(unknown.records.length,1); assert.ok(unknown.tabs[expected.target]); retained(unknown, expected)
   assert.equal(await evaluate(`${byText('Keep Session & Close')}.disabled`),false)
   await frame(width,'unknown-close-choice')
   await click(byText('Cancel')); await wait('!document.querySelector("[role=dialog]")')
   await wait('document.querySelector(".error-notice")?.textContent.includes("close result is unknown")'); await frame(width,'unknown-service-window')
   await evaluate("document.querySelectorAll(':popover-open').forEach(p=>p.hidePopover())")
   await revealTargetClose(); await click(targetX); await wait('Boolean(document.querySelector("[role=dialog]"))'); await click(byText('Keep Session & Close'))
   await wait('!stoppedViewClose.facts().tabs[stoppedViewClose.target]'); await wait('!document.querySelector("[role=dialog]")')
   const kept = await evaluate('stoppedViewClose.facts()'); assert.equal(kept.records.length,1); retained(kept,expected); (result.kept??=[]).push({width,facts:kept})
  }
 } else {
  const facts = await evaluate('stoppedViewClose.facts()'); assert.ok(!facts.tabs[expected.target]); assert.deepEqual(Object.keys(facts.tabs),[expected.sibling]); retained(facts,expected,true)
  await wait('stoppedViewClose.facts().attachment.some(c=>c.kind==="agent"&&c.agentSessionId===stoppedViewClose.healthyId&&c.run.runId==="run-claude")')
  result.restored=await evaluate('stoppedViewClose.facts()'); assert.equal(result.restored.records.length,0); assert.deepEqual(result.restored.submissions,[])
 }
 result.closedState = await evaluate('stoppedViewClose.prepareQuit()'); assert.ok(Object.keys(result.closedState.restoredWorkbench.tabs).length>0)
 assert.deepEqual(Object.keys(result.closedState.restoredWorkbench.tabs),[expected.sibling]); assert.deepEqual(result.closedState.agentComposerDrafts,expected.expectedDrafts); assert.deepEqual(result.closedState.agentSteerQueues,{[expected.stoppedId]:[phase==='first'?expected.unknownInput:expected.restoredUnknownInput]})
 result.passed=true
} catch(error) { result.failure={name:error.name,message:error.message,stack:error.stack}; result.failureFacts=await evaluate('stoppedViewClose.facts()').catch(e=>({observationError:e.message})); result.failureDom=await evaluate('({dialogs:[...document.querySelectorAll("[role=dialog]")].map(e=>e.textContent),target:!!document.querySelector("[data-workbench-tab-id=closed-target]")})').catch(e=>({observationError:e.message})); process.exitCode=1 }
finally { await fs.writeFile(path.join(evidence,phase+'-render.json'),JSON.stringify(result,null,2)+'\n'); quitting=true; win?.close(); app.quit() }
})
