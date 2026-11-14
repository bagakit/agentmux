const { app, BrowserWindow } = require('electron')
const { mkdirSync } = require('node:fs')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const out = process.env.PARALLEL_UI_OUT
for (const key of ['home','appData','userData','sessionData']) { mkdirSync(join(out,key),{recursive:true}); app.setPath(key,join(out,key)) }
const receipt = { captureOnly:true, complete:false, captures:[], boundary:'Actual production Editor/Parallel component and BrowserPane in isolated Electron. Explicit fixture DTOs and API ports prove native Renderer consumers, exact callbacks and clearing only. Main/Core execution, storage, restart and transport authority are separate owner receipts.' }
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
  await click('[aria-label="Select Browser private-browser-a"]');await click('[aria-label="Select Browser private-browser-b"]')
  await fill('private-browser-a parameter Account reference','Northwind order')
  await fill('private-browser-b parameter Account reference','Independent order')
  await fill('Northwind account / Collection item 1 Entry label','First entry')
  await fill('Independent account / Collection item 1 Entry label','Second entry')
  for(const theme of ['dark','light'])for(const width of [620,390])await capture(`parallel-${theme}-${width}`,width,theme)
  await click('.browser-task-parallel > .browser-rsi-button--primary')
  await until(`Boolean(document.querySelector('[data-original-parallel-id]'))`,'original unknown ID')
  const original=await evaluate('parallelUI.facts()')
  assert.equal(original.trusted,true);assert.equal(original.invoked.version,1);assert.equal(original.starts,1)
  assert.deepEqual(original.invoked.input.targets.map(t=>[t.browserId,t.profileId]),[['private-browser-a','private-profile-a'],['private-browser-b','private-profile-b']])
  assert.equal(await evaluate(`document.querySelector('[aria-label="private-browser-a parameter Account reference"]').value`),'')
  for(const theme of ['light','dark'])await capture(`parallel-unknown-${theme}-390`,390,theme)
  await evaluate('parallelUI.confirmOriginal()')
  await click('[data-original-parallel-id] .browser-rsi-button--primary')
  await until(`!document.querySelector('[data-original-parallel-id]')`,'original lookup confirmed')
  const looked=await evaluate('parallelUI.facts()')
  assert.ok(looked.calls.some(call=>call.method==='inspect'&&call.options.operationId===original.invoked.input.operationId));assert.equal(looked.starts,1,'Original lookup never dispatches another run')
  const beforePaneCalls=looked.calls.length
  receipt.nativeCallback={trusted:true,originalId:original.invoked.input.operationId,exactTargets:original.invoked.input.targets.map(t=>({id:t.id,browserId:t.browserId,profileId:t.profileId})),valuesCleared:true,lookupSameId:true}
  win.setContentSize(1000,900);await evaluate('parallelUI.pane()');await delay(100)
  await click('[aria-label^="Browser activity:"]');await click('[aria-label="Open browser activity timeline"]')
  await click('.browser-task-parallel > summary')
  await click('[aria-label="Select Browser private-browser-a"]');await click('[aria-label="Select Browser private-browser-b"]')
  await fill('private-browser-a parameter Account reference','Pane first')
  await fill('private-browser-b parameter Account reference','Pane second')
  await click('.browser-task-parallel > .browser-rsi-button--primary')
  await until('parallelUI.facts().starts===2','the actual production BrowserPane forwarded a second distinct explicit start')
  const pane=await evaluate('parallelUI.facts()')
  assert.notEqual(pane.invoked.input.operationId,original.invoked.input.operationId)
  assert.deepEqual(pane.invoked.input.targets.map(target=>target.parameters.value),['Pane first','Pane second'])
  assert.equal(pane.sourceDriving,true);assert.equal(pane.invoked.browserId,'private-library-browser');assert.equal(pane.invoked.assetId,'private-parallel-task');assert.equal(pane.invoked.version,1)
  assert.ok(pane.calls.slice(beforePaneCalls).some(call=>call.method==='list'&&call.browserId==='private-library-browser'))
  assert.ok(pane.calls.slice(beforePaneCalls).some(call=>call.method==='inspect'&&call.browserId==='private-library-browser'))
  receipt.productionPane={sourceDriving:true,nativeStart:true,exactSource:pane.invoked.browserId,assetId:pane.invoked.assetId,version:pane.invoked.version,sourceReadAvailable:true,distinctStart:true,newReadCalls:pane.calls.slice(beforePaneCalls).length}
  receipt.complete=true
}).catch(error=>{receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}).finally(async()=>{await writeFile(join(out,'capture.json'),JSON.stringify(receipt,null,2));win?.destroy();app.quit()})
