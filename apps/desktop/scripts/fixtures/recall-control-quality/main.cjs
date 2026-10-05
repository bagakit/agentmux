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
  const until = async (label, code) => { const end = Date.now() + 10000; do { if (await read(code)) return; await new Promise(done => setTimeout(done, 40)) } while (Date.now() < end); throw Error('Not ready: ' + label) }
  const paint = () => read('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  const point = selector => read(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); if(!n) throw Error('Missing actual control: '+${JSON.stringify(selector)}); const r=n.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
  const click = async selector => { const p=await point(selector); for(const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1}); await paint() }
  const key = async (key, code, windowsVirtualKeyCode) => { for(const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode}); await paint() }
  const capture = async (name, label) => { await paint(); await new Promise(done=>setTimeout(done,160)); const geometry=await read(`({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,selected:document.querySelector('.recall-view-picker [aria-selected=true]')?.getAttribute('aria-label')})`); assert.ok(geometry.scrollWidth<=geometry.width+1,'No document overflow'); await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG()); report.frames.push({path:name+'.png',label,geometry}) }
  await win.loadFile(html); win.webContents.debugger.attach('1.3')
  await until('original Recall directory', 'window.recallQuality?.ready && document.querySelectorAll(".notebook-page-directory button[data-note-id]").length===6')
  report.before = await read('recallQuality.facts()')
  await capture('recall-tree-dark','Original App, full Recall directory')
  await click('[aria-label="Tree view"]'); await key('ArrowRight','ArrowRight',39)
  assert.equal(await read('document.activeElement?.getAttribute("aria-label")'),'Cards view')
  assert.equal(await read('document.querySelector(".recall-view-picker [aria-selected=true]")?.getAttribute("aria-label")'),'Cards view')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...await point('[aria-label="Graph view"]')})
  await capture('recall-cards-hover-dark','Selected Cards remains distinct from adjacent hovered Graph')
  await click('[aria-label="Graph view"]'); await capture('recall-graph-dark','Original graph preserves partial-reference explanation')
  await click('[aria-label="Switch notebook"]'); await until('notebook menu','document.querySelector("[role=menu]")!==null')
  assert.equal(await read('document.querySelector("[role=menuitemradio][data-state=checked]")?.getAttribute("aria-label")'),'Switch to notebook: Research notebook')
  await capture('recall-menu-dark','Shared floating material and checked notebook selection')
  await key('Escape','Escape',27)
  await until('menu returns focus','document.activeElement?.getAttribute("aria-label")==="Switch notebook"')
  await click('[aria-label="Cards view"]'); await read('recallQuality.theme("light")'); win.setContentSize(640,640)
  await capture('recall-cards-light-640','Light appearance, compact width')
  win.setContentSize(320,640); await capture('recall-cards-light-320','320px original App, cards stay inside their container')
  assert.ok(await read('document.querySelector(".recall-note-card strong").getBoundingClientRect().bottom < innerHeight-30'),'Narrow directory shows a real page title in the first screen')
  await click('[aria-label="Archived pages"]'); await capture('recall-archived-light-320','Archived selection remains distinct in the narrow light directory')
  assert.equal(await read('document.querySelector(".notebook-directory-views [aria-pressed=true]").textContent'),'Archived')
  await click('.notebook-directory-views button:first-child')
  await read('recallQuality.notice()'); await until('system notification','document.querySelector(".global-system-notices__trigger")!==null')
  await click('.global-system-notices__trigger'); await until('notification details','document.querySelector(".global-system-notices__details")?.matches(":popover-open")')
  await capture('recall-notice-light-320','Current notice owner retains failed step, actual capability and recovery action')
  report.after=await read('recallQuality.facts()')
  assert.deepEqual(report.after,report.before,'Visual and keyboard controls preserve original notebook and workfaces')
  report.passed=true
} catch(error) { report.failure={message:error.message,stack:error.stack}; if(win&&!win.isDestroyed()) await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(report,null,2)); if(win&&!win.isDestroyed()) win.destroy(); app.exit(report.passed?0:1) } })
