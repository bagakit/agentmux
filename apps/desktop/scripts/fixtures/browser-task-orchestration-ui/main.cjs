const { app, BrowserWindow } = require('electron')
const { mkdirSync } = require('node:fs')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const out = process.env.PARALLEL_UI_OUT
for (const key of ['home','appData','userData','sessionData']) { mkdirSync(join(out,key),{recursive:true}); app.setPath(key,join(out,key)) }
const receipt = { captureOnly:true, complete:false, captures:[], boundary:'Actual production Editor/Parallel/Continue component and BrowserPane in isolated Electron. Explicit fixture DTOs and API ports prove native Renderer consumers, exact callbacks and clearing only. Main/Core execution, storage, restart and transport authority are separate owner receipts.' }
let win
const delay = ms => new Promise(done=>setTimeout(done,ms))
app.whenReady().then(async()=>{
  app.setActivationPolicy?.('prohibited')
  win=new BrowserWindow({width:620,height:960,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
  win.webContents.debugger.attach('1.3')
  const evaluate=async expression=>{const r=await win.webContents.debugger.sendCommand('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  const until=async(expression,label)=>{for(let n=0;n<160;n++){const value=await evaluate(expression);if(value)return value;await delay(50)}throw new Error('Actual UI observation missing: '+label)}
  const click=async(selector)=>{
    await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`,selector)
    const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    for(const type of ['mouseMoved','mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})})
    await delay(60)
  }
  const fill=async(label,text)=>{await click(`[aria-label="${label}"]`);await win.webContents.debugger.sendCommand('Input.insertText',{text});await delay(30)}
  const capture=async(name,width,theme)=>{
    win.setContentSize(width,960);await evaluate(`parallelUI.appearance(${JSON.stringify(theme)});scrollTo(0,0);new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`)
    const overflow=await evaluate(`({page:document.documentElement.scrollWidth>innerWidth,controls:[...document.querySelectorAll('input,select,button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left<0)}).map(e=>e.getAttribute('aria-label')||e.textContent)})`)
    assert.equal(overflow.page,false);assert.deepEqual(overflow.controls,[])
    const size=(await win.webContents.debugger.sendCommand('Page.getLayoutMetrics')).cssContentSize
    const bytes=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:Math.ceil(size.height),scale:1}})
    const file=name+'.png';await writeFile(join(out,file),Buffer.from(bytes.data,'base64'));receipt.captures.push({file,width,height:Math.ceil(size.height),theme,overflow})
  }
  await win.loadFile(process.env.PARALLEL_UI_HTML)
  await click('.browser-task-parallel > summary')
  await click('[data-parallel-target="retained-target-b"] .browser-rsi-button--primary')
  await until(`Boolean(document.querySelector('[data-continue-target="retained-target-b"]'))`,'original target review')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Task asset version"]').value`),'3')
  assert.ok(await evaluate(`document.querySelector('[data-continue-target]').textContent.includes('v1')`))
  assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="Continue retained-target-b / Collection item 1 Entry label"]'))`),false)
  await fill('Continue retained-target-b / Collection item 2 Entry label','Original remaining item')
  await fill('Continue retained-target-b / Collection fresh Call token','Synthetic invocation only')
  for(const theme of ['dark','light'])for(const width of [620,390])await capture(`orchestration-review-${theme}-${width}`,width,theme)
  await click('.browser-task-parallel__continue footer .browser-rsi-button--primary')
  await until(`parallelUI.facts().continues===1&&Boolean(document.querySelector('[data-original-continuation-id]'))`,'original unknown continuation')
  const original=await evaluate('parallelUI.facts()'), originalId=original.continued.input.continuationId
  assert.equal(original.continued.operationId,'retained-parallel-operation');assert.equal(original.continued.targetId,'retained-target-b')
  assert.equal(original.continued.input.expectedRevision,'a'.repeat(64))
  assert.deepEqual(original.continued.input.calls.entries.items.map(item=>item.id),['completed-original-item','unfinished-original-item'])
  assert.equal(original.continued.input.calls.entries.items[1].parameters.entry,'Original remaining item')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Continue retained-target-b / Collection item 2 Entry label"]').value`),'')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Continue retained-target-b / Collection fresh Call token"]').value`),'')
  for(const theme of ['dark','light'])await capture(`orchestration-unknown-${theme}-390`,390,theme)
  await click('[data-original-continuation-id] .browser-rsi-button--primary')
  await until(`document.querySelector('[data-original-continuation-id]').textContent.includes('does not prove')`,'null lookup remains unknown')
  await evaluate('parallelUI.confirmContinuation()')
  await click('[data-original-continuation-id] .browser-rsi-button--primary')
  await until(`document.querySelector('[data-original-continuation-id]').textContent.includes('Continue request recorded')`,'same original continuation confirmed')
  const looked=await evaluate('parallelUI.facts()')
  assert.equal(looked.continues,1);assert.ok(looked.calls.some(call=>call.method==='inspect'&&call.options.continuationId===originalId&&call.options.operationId==='retained-parallel-operation'))
  await evaluate('parallelUI.refusal()')
  await click('.browser-task-parallel__choices .browser-rsi-button--quiet')
  await delay(80)
  await click('.browser-task-parallel__continue footer .browser-rsi-button--quiet:nth-child(2)')
  await fill('Continue retained-target-b / Collection item 2 Entry label','Keep this corrected entry')
  await click('.browser-task-parallel__continue footer .browser-rsi-button--primary')
  await until(`document.querySelector('[data-original-continuation-id]').textContent.includes('Continuation was not admitted')`,'known refused input remains')
  assert.equal(await evaluate(`document.querySelector('[aria-label="Continue retained-target-b / Collection item 2 Entry label"]').value`),'Keep this corrected entry')
  for(const theme of ['dark','light'])await capture(`orchestration-refused-${theme}-390`,390,theme)
  await click('.browser-task-parallel__progress > .browser-rsi-button--quiet')
  await until(`document.querySelector('[data-parallel-stop]')?.textContent.includes('Group stop is unconfirmed')`,'unknown group stop')
  for(const theme of ['dark','light'])await capture(`orchestration-stop-${theme}-390`,390,theme)
  const beforePane=await evaluate('parallelUI.facts()')
  assert.equal(beforePane.stopRequests,1);assert.equal(beforePane.continues,2);assert.equal(beforePane.closeRequests,0,'Renderer group Stop must not request Browser close')
  assert.notEqual(beforePane.continued.input.continuationId,originalId)
  receipt.nativeCallback={originalContinuationId:originalId,originalGroup:'retained-parallel-operation',targetId:'retained-target-b',originalVersion:1,editorVersion:3,itemIds:['completed-original-item','unfinished-original-item'],completedItemsNotRepeated:true,valuesCleared:true,lookupSameId:true,nullLookupNotRefusal:true,knownRefusalKeepsInputs:true,explicitNewContinuationId:beforePane.continued.input.continuationId,stopRequests:1,rendererCloseRequests:beforePane.closeRequests}
  const beforePaneCalls=beforePane.calls.length
  win.setContentSize(1000,900);await evaluate('parallelUI.pane()');await delay(100)
  await click('[aria-label^="Browser activity:"]');await click('[aria-label="Open browser activity timeline"]')
  await click('.browser-task-parallel > summary')
  await click('[data-parallel-target="retained-target-b"] .browser-rsi-button--primary')
  await fill('Continue retained-target-b / Collection item 2 Entry label','Pane remaining item')
  await click('.browser-task-parallel__continue footer .browser-rsi-button--primary')
  await until('parallelUI.facts().continues===3','actual production BrowserPane forwards distinct trusted Continue')
  const pane=await evaluate('parallelUI.facts()')
  assert.equal(pane.sourceDriving,true);assert.notEqual(pane.continued.input.continuationId,beforePane.continued.input.continuationId)
  assert.equal(pane.continued.input.calls.entries.items[1].parameters.entry,'Pane remaining item')
  assert.equal(pane.continued.operationId,'retained-parallel-operation');assert.equal(pane.continued.targetId,'retained-target-b')
  assert.ok(pane.calls.slice(beforePaneCalls).some(call=>call.method==='target-inspect'&&call.runId==='original-target-run-b'))
  assert.deepEqual(pane.errors,[])
  receipt.productionPane={sourceDriving:true,nativeContinue:true,distinctContinue:true,originalGroup:pane.continued.operationId,originalTarget:pane.continued.targetId,originalVersion:1,originalRun:'original-target-run-b',newReadCalls:pane.calls.slice(beforePaneCalls).length}
  receipt.complete=true
}).catch(error=>{receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}).finally(async()=>{await writeFile(join(out,'capture.json'),JSON.stringify(receipt,null,2));win?.destroy();app.quit()})
