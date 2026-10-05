const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, temporary, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(temporary, 'user-data')); app.setPath('sessionData', path.join(temporary, 'session-data'))
const report = { passed: false, frames: [], console: [] }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1200, height: 760, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) report.console.push(String(message).slice(0, 1200)) })
  const read = code => { report.lastOperation=code; return win.webContents.executeJavaScript(code) }
  const until = async (label, code) => { const end = Date.now()+12000; do { if(await read(code))return; await new Promise(done=>setTimeout(done,40)) }while(Date.now()<end);throw Error('Not ready: '+label) }
  const paint = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const click = async selector => { const p=await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});await paint() }
  const escape=async()=>{for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await paint()}
  const capture=async(name,label)=>{await paint();await new Promise(done=>setTimeout(done,200));const geometry=await read('({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth})');assert.ok(geometry.documentWidth<=geometry.width+1);await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());report.frames.push({path:name+'.png',label,geometry})}
  await win.loadFile(html);win.webContents.debugger.attach('1.3')
  await until('original initialization','window.recallQuality?.ready')
  await read('recallQuality.launcher()')
  await until('original Launcher',`document.querySelector('.launch-surface') && document.querySelector('[aria-label="Agent prompt"]')`)
  await capture('launcher-dark-wide','Original App Launcher with existing Agent and utility hierarchy')
  await click('[aria-label="Agent prompt"]');await win.webContents.debugger.sendCommand('Input.insertText',{text:'Help me review the interaction details. Keep this draft while I look at the options.'})
  await click('[aria-label="Launch options"]');await until('options panel','document.querySelector(".launch-refine__panel")?.dataset.state==="open"')
  await capture('launcher-options-dark','Options keep the original draft and launcher context visible')
  await escape();await until('options focus returns','document.activeElement?.getAttribute("aria-label")==="Launch options"')
  await click('[aria-label="Collapse Agents"]');await capture('launcher-collapsed-dark','Collapsed Agent keeps the draft summary and clear restore action')
  await click('[aria-label="Expand Agents"]')
  assert.ok(await read(`document.querySelector('[aria-label="Agent prompt"]').textContent.includes('Keep this draft')`),'Agent draft survives collapse and return')
  await read('recallQuality.theme("light")');win.setContentSize(640,640);await capture('launcher-light-640','Original Launcher, light narrow workspace')
  win.setContentSize(320,640);await capture('launcher-light-320','Original Launcher, narrow region with full utilities')
  await click('[aria-label="Launch options"]');await capture('launcher-options-light-320','Bounded launch options remain readable and dismissible')
  await escape()
  win.setContentSize(1200,760);await read('recallQuality.theme("dark");recallQuality.focus()')
  await until('original Focus','document.querySelector(".global-focus-surface") && !document.querySelector(".global-focus-surface").hidden')
  await read(`window.focusContinuity={prompt:document.querySelector('.global-focus-surface [aria-label="Agent prompt"]'),draft:document.querySelector('.global-focus-surface [aria-label="Agent prompt"]').textContent,facts:JSON.stringify(recallQuality.facts()),ratio:document.querySelector('.global-focus-surface').style.getPropertyValue('--focus-workspace-width')}`)
  await capture('focus-dark-wide','Original Focus, current controlled sessions and unmodified ordering')
  win.setContentSize(640,640);await capture('focus-dark-640','Original Focus in narrow workspace')
  await read('recallQuality.theme("light")');win.setContentSize(320,640);await capture('focus-light-320','Original Focus in light narrow workspace')
  report.narrow=await read(`(()=>{const scan=document.querySelector('.global-focus-main').getBoundingClientRect(),work=document.querySelector('.global-focus-surface .global-session-workspace').getBoundingClientRect(),prompt=document.querySelector('.global-focus-surface [aria-label="Agent prompt"]');return {width:innerWidth,scan:{x:scan.x,y:scan.y,width:scan.width,bottom:scan.bottom},work:{x:work.x,y:work.y,width:work.width,height:work.height},sameNode:prompt===focusContinuity.prompt,sameDraft:prompt.textContent===focusContinuity.draft,sameFacts:JSON.stringify(recallQuality.facts())===focusContinuity.facts,separator:getComputedStyle(document.querySelector('.focus-workspace-resize-handle')).display}})()`)
  assert.ok(report.narrow.work.width>=report.narrow.width-2,'Narrow Focus gives the original workface full readable width')
  assert.ok(report.narrow.scan.bottom<=report.narrow.work.y+1,'Narrow Focus scan stays above the original workface')
  assert.ok(report.narrow.work.height>=180,'Original workface keeps a usable scroll viewport')
  assert.ok(report.narrow.sameNode&&report.narrow.sameDraft&&report.narrow.sameFacts,'Responsive Focus preserves the exact original editor, draft and spatial facts')
  assert.equal(report.narrow.separator,'none','Width-only handle is absent from the stacked presentation')
  win.setContentSize(1200,760);await paint()
  report.returned=await read(`(()=>{const prompt=document.querySelector('.global-focus-surface [aria-label="Agent prompt"]');return {sameNode:prompt===focusContinuity.prompt,sameDraft:prompt.textContent===focusContinuity.draft,sameFacts:JSON.stringify(recallQuality.facts())===focusContinuity.facts,sameRatio:document.querySelector('.global-focus-surface').style.getPropertyValue('--focus-workspace-width')===focusContinuity.ratio,separator:getComputedStyle(document.querySelector('.focus-workspace-resize-handle')).display}})()`)
  assert.ok(report.returned.sameNode&&report.returned.sameDraft&&report.returned.sameFacts&&report.returned.sameRatio,'Returning wide restores the original ratio and editor without recreating the workface')
  assert.notEqual(report.returned.separator,'none')
  await capture('focus-light-returned-wide','Returning wide keeps the original workface, draft and split proportion')
  report.passed=true
}catch(error){report.failure={message:error.message,stack:error.stack};if(win&&!win.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(report,null,2));if(win&&!win.isDestroyed())win.destroy();app.exit(report.passed?0:1)} })
