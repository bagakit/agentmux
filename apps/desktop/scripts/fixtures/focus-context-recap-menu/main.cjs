const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot,'user-data')); app.setPath('sessionData', path.join(privateRoot,'session-data'))
const result = { schema: 'agentmux.focus-context-recap-menu-actual.v1', passed: false, pid: process.pid, frames: [], rendererConsole: [], boundary: 'Original compiled Global/Store/projection/Row/ContextMenu/clipboard/reportError and CSS. Typed preview transport only; unrelated PTY and unused editor paint isolated. No Runtime, real Run/PID retention, Native writer, OS input, restart or installation.' }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1200, height: 820, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0,2000)) })
  const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch(error) { result.failedEvaluation=code; throw error } }
  const until = async (label,predicate) => { const end=Date.now()+10000; do { if(await predicate())return; await new Promise(done=>setTimeout(done,30)) } while(Date.now()<end); throw new Error('Scene did not settle: '+label) }
  const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const row = id => `.global-focus-main .focus-context[data-session-id="${id}"]`
  const rect = selector => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing actual control '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
  const mouse = async (selector,button='left') => { const r=await rect(selector);assert.equal(r.hit,true,'Center hit '+selector);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:r.x,y:r.y,button,clickCount:1});return r }
  const key = async (value,modifiers=0) => { for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:value,code:value,modifiers}) }
  const menuSettled = () => until('actual menu visible and stable', () => read(`(()=>{const menu=document.querySelector('.focus-context-menu');return !!menu&&menu.querySelectorAll('[role=menuitem]').length===2&&Number(getComputedStyle(menu).opacity)>=.999&&!menu.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`))
  const menuItems = () => read(`[...document.querySelectorAll('.focus-context-menu [role=menuitem]')].map(e=>e.textContent.trim())`)
  const shot = async (file,label) => { await settle(); await until('stable original menu paint', () => read(`!document.querySelector('.focus-context-menu')||(()=>{const e=document.querySelector('.focus-context-menu');return Number(getComputedStyle(e).opacity)>=.999&&!e.getAnimations({subtree:true}).some(a=>a.playState==='running')})()`)); await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG()); result.frames.push({file,label,viewport:await read('innerWidth')}) }
  const geometry = () => read(`(()=>{const rows=[...document.querySelectorAll('.focus-context')];const measure=e=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e);return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),display:style.display,text:e.textContent,aria:e.getAttribute('aria-label'),title:e.getAttribute('title')}};return{rows:rows.map(e=>({id:e.dataset.sessionId,compact:e.classList.contains('focus-context--compact'),bounds:measure(e),recap:e.querySelector('.focus-context__recap')?measure(e.querySelector('.focus-context__recap')):null,activity:e.querySelector('.focus-context__activity')?measure(e.querySelector('.focus-context__activity')):null,detail:e.querySelector('.focus-context__detail')?measure(e.querySelector('.focus-context__detail')):null})),minColumn:measure(document.querySelector('[data-min-column]')),compact:measure(document.querySelector('[data-compact-column] .focus-context')),viewport:innerWidth}})()`)
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  await until('real card population', () => read('window.recapProof?.ready&&document.querySelectorAll(".global-focus-main .focus-context").length===6'))
  await read('window.recapProof.remember()'); result.before = await read('window.recapProof.facts()')
  result.geometry=[]
  for(const width of [1200,360]) {
    win.setContentSize(width,820); await settle(); const g=await geometry(); result.geometry.push(g)
    assert.equal(g.compact.height,28);assert.equal(g.minColumn.width,160)
    const recap=g.rows.find(e=>e.id==='recap-a'&&e.recap);assert.ok(recap);assert.ok(recap.recap.text.includes('已经修复'));assert.ok(recap.activity.text.startsWith('Read '));assert.ok(recap.activity.text.endsWith('chinese-target.tsx'))
    const next=g.rows.find(e=>e.id==='next-prompt');assert.ok(next);assert.ok(next.activity.text.includes('Prompt · 接下来检查加载'));assert.ok(next.bounds.aria.includes('Last assistant message (timeline)'))
    const critical=g.rows.filter(e=>e.id==='permission'||e.id==='failed');assert.equal(critical.length,2);assert.ok(critical.every(e=>!e.recap&&e.detail.text.length>0))
    const empty=g.rows.find(e=>e.id==='recap-b');assert.ok(empty);assert.equal(empty.detail.text,'No activity details observed')
    await shot('cards-'+width+'.png','original cards + minimum160 + compact28')
  }
  await mouse(row('recap-b'),'right'); await menuSettled(); assert.deepEqual(await menuItems(),['Message this Agent','Copy Session Address'])
  result.pointerMenu={bounds:await rect('.focus-context-menu'),sessionId:await read('document.querySelector(".focus-context-menu").dataset.agentSessionId')};assert.equal(result.pointerMenu.sessionId,'recap-b')
  await shot('pointer-menu-360.png','same-name second SID exact original Session menu')
  await mouse('.focus-context-menu [role=menuitem]:last-child');await until('menu selected',()=>read('!document.querySelector(".focus-context-menu")'))
  await settle()
  result.afterPointer=await read('window.recapProof.facts()');assert.equal(result.afterPointer.clipboard[0],await read('window.recapProof.expectedSecondAddress'))
  await read(`document.querySelector(${JSON.stringify(row('recap-b'))}).focus()`); await key('F10',8); await menuSettled()
  result.keyboardMenu={sessionId:await read('document.querySelector(".focus-context-menu").dataset.agentSessionId'),items:await menuItems()};assert.equal(result.keyboardMenu.sessionId,'recap-b')
  await shot('keyboard-menu-360.png','Shift+F10 uses original menu and exact SID')
  await key('Escape');await until('Escape restores exact trigger',()=>read(`!document.querySelector('.focus-context-menu')&&document.activeElement===document.querySelector(${JSON.stringify(row('recap-b'))})`))
  await settle()
  result.escape={exactTrigger:true}
  await key('F10',8);await menuSettled();await mouse('[aria-label="Later explicit input"]');await until('later input wins',()=>read(`!document.querySelector('.focus-context-menu')&&document.activeElement===document.querySelector('[aria-label="Later explicit input"]')`));result.laterFocus={preserved:true}
  await read('window.recapProof.denyClipboard(true)');await mouse(row('recap-b'),'right');await menuSettled();await mouse('.focus-context-menu [role=menuitem]:last-child')
  await until('original clipboard failure outlet',()=>read('document.querySelector(".error-notice")?.textContent.includes("Clipboard denied: private presentation probe")'))
  result.clipboardFailure=await read('window.recapProof.facts()');await shot('clipboard-failure-360.png','actual original error outlet + draft retention')
  const before=await read('window.recapProof.facts()');await read('window.recapProof.churn()');await settle();const after=await read('window.recapProof.facts()');assert.deepEqual(after.reads,before.reads);assert.deepEqual(after.controls,before.controls);result.cost={updates:200,before,after}
  result.after=after;for(const key of ['sameNodes','originalFocus','originalDrafts','originalControls'])assert.equal(after[key],true,key)
  assert.deepEqual(after.controls,{stop:0,resume:0,launchAgent:0,write:0,interrupt:0});assert.equal(after.draft,result.before.draft)
  result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win&&!win.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(result,null,2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}})
