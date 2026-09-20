const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.goals-visual-render.v1', passed: false, frames: [], userRunTouched: false, consoleErrors: [] }
let win
const evaluate = (expression) => win.webContents.executeJavaScript(expression)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(expression) { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(25) } throw new Error('Timed out: ' + expression) }
async function paint() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(70) }
const button = (label) => `([...document.querySelectorAll('button')].find(node => node.textContent.trim()===${JSON.stringify(label)} || node.getAttribute('aria-label')===${JSON.stringify(label)}))`
async function click(expression) { const p = await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Missing actual target');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1}); await paint() }
async function size(width) { await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false}); await paint() }
async function capture(name, width) { await paint(); const bytes=(await win.webContents.capturePage()).toPNG(); const file=name+'.png'; await fs.writeFile(path.join(evidence,file),bytes); result.frames.push({name,width,file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}) }
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(evidence,{recursive:true}); win=new BrowserWindow({show:false,width:1280,height:780,webPreferences:{sandbox:false,backgroundThrottling:false}})
    win.webContents.on('console-message',details=>{ if(details.level==='error')result.consoleErrors.push({message:details.message,line:details.lineNumber,source:details.sourceId}) })
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await waitFor('Boolean(window.goalsVisual) && document.querySelectorAll("[data-demand-id]").length===6'); const original=await evaluate('goalsVisual.facts().runs')
    await size(1280); await capture('1280-list',1280)
    await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")'); await waitFor('Boolean(document.querySelector(".goals-detail"))'); await capture('1280-detail',1280)
    await click('document.querySelector(".goals-properties > summary")'); await capture('1280-properties',1280)
    await click('document.querySelector(".goals-properties > summary")'); await click('document.querySelector(".goals-execution > summary")'); await capture('1280-execution',1280)
    await click(button('Back to goals')); await click(button('Board view')); await capture('1280-board',1280)
    const geometry=await evaluate('([...document.querySelectorAll(".goals-board-column")].map(e=>({top:e.getBoundingClientRect().top,left:e.getBoundingClientRect().left})))'); assert.equal(geometry.length,5); assert.equal(new Set(geometry.map(x=>x.top)).size,1,'Real board columns remain on one track')
    await click(button('List view')); await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")'); await size(620); await capture('620-detail',620)
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".goals-index")).display'),'none','Narrow detail has reading priority')
    await click(button('Back to goals')); await capture('620-list',620)
    await click(button('New Goal')); await capture('620-intake',620)
    await evaluate('document.querySelector("[aria-label=\\\"Goal intent\\\"]").focus()'); for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await waitFor('!document.querySelector(".goals-intake")')
    assert.equal(await evaluate('document.activeElement.textContent.trim()'),'New Goal','Escape returns focus to the real entry')
    await size(1280); await evaluate('goalsVisual.seed("empty")'); await capture('1280-empty',1280)
    assert.deepEqual(await evaluate('goalsVisual.facts().runs'),original,'Original preview Run identities remain intact')
    assert.equal(result.frames.length,9); assert.deepEqual(result.consoleErrors,[]); result.passed=true
  } catch(error) { result.failure={name:error.name,message:error.message,stack:error.stack} }
  finally { await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2)); win?.destroy(); app.exit(result.passed?0:1) }
})
